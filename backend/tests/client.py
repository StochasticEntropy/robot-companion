"""Headless real-process protocol driver with bounded waits and owned cleanup."""

import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import quote

from robot_companion_backend.protocol import FramedStream
from robot_companion_backend.workspace import file_uri_path
import processes


def client_uri(path):
    """A file URI as VS Code writes it: on Windows a lower-case drive with `%3A`
    (`file:///c%3A/Users/My%20Tests/a.robot`), not Path.as_uri()'s `file:///C:/Users/...`."""
    text = Path(path).as_posix()
    if processes.WINDOWS:
        return "file:///" + text[0].lower() + "%3A" + quote(text[2:])
    return "file://" + quote(text)


def uri_file(uri):
    """The file a URI names, resolved (drive-letter case, 8.3 names) for comparison."""
    return Path(file_uri_path(uri)).resolve()


class Client:
    def __init__(self, service="lsp", cwd=None, argv=None, env=None):
        env = os.environ.copy() if env is None else dict(env)
        if cwd and env.get("PYTHONPATH"):  # keep a relative source path valid in another cwd
            env["PYTHONPATH"] = os.pathsep.join(map(os.path.abspath, filter(None, env["PYTHONPATH"].split(os.pathsep))))
        # `argv` replaces the module launch, e.g. to start the service with a dependency hidden
        # or through the installed console script; `env` replaces the inherited environment.
        launch = [sys.executable, "-m", "robot_companion_backend", service]
        if processes.WINDOWS and service == "dap" and argv is None:
            # Retain thread stacks when an owned Windows cleanup stalls; successful
            # conformance completes before the diagnostic timer fires.
            launch = [sys.executable, "-c", "import faulthandler, runpy, sys; "
                      "faulthandler.dump_traceback_later(25, repeat=True); "
                      "sys.argv = ['robot_companion_backend', 'dap']; "
                      "runpy.run_module('robot_companion_backend', run_name='__main__')"]
        self.process = subprocess.Popen(argv or launch,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, cwd=cwd)
        self.stream = FramedStream(self.process.stdout, self.process.stdin)
        self.messages = queue.Queue()
        self.transcript = []
        self.stderr = bytearray()
        self.counter = 0
        self.notifications = []
        self.owned_processes = {}
        self.forced_cleanup = False
        self.closed = False
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._errors, daemon=True)
        # Resolve a Windows console-script/venv launcher while its interpreter is live.
        # A late first backend_pid read can follow an already exited launcher and fail
        # QueryFullProcessImageNameW; retain the PID and creation identity for teardown.
        try:
            self._backend_pid = processes.interpreter_pid(self.process.pid,
                                                          lambda: self.process.poll() is not None)
            self.backend_identity = self.process_identity(self._backend_pid)
            if self.backend_identity is None or self.backend_identity["start"] is None:
                raise AssertionError(f"Could not capture backend process identity: {self._backend_pid}")
        except BaseException:
            self.process.kill()
            self.process.wait(timeout=5)
            for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
                pipe.close()
            raise
        self.owned_processes[self._backend_pid] = self.backend_identity
        self.reader.start()
        self.error_reader.start()

    def _read(self):
        try:
            while (message := self.stream.read()) is not None:
                self._remember_owned(message)
                self.messages.put(message)
        except Exception as exc:
            self.messages.put(exc)
        finally:
            self.messages.put(EOFError("Backend stdout closed"))

    def _errors(self):
        while data := self.process.stderr.read(4096):
            self.stderr.extend(data)

    def send(self, method, params=None, request_id=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if request_id is not None:
            message["id"] = request_id
        self.transcript.append({"sent": message})
        self.stream.write(message)

    def request(self, method, params=None):
        self.counter += 1
        self.send(method, params, self.counter)
        deadline = time.monotonic() + 10
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Backend request timed out: {method}")
            message = self.messages.get(timeout=remaining)
            if isinstance(message, Exception):
                raise message
            self.transcript.append({"received": message})
            if message.get("id") == self.counter:
                if "error" in message:
                    raise AssertionError(message)
                return message["result"]
            self.notifications.append(message)

    @staticmethod
    def process_identity(pid):
        return processes.identity(pid)

    @property
    def backend_pid(self):
        """The backend's own interpreter process (below a Windows venv launcher)."""
        return self._backend_pid

    def _remember_owned(self, message):
        body = message.get("body", {})
        candidates = []
        if message.get("event") == "process":
            candidates.append(body.get("systemProcessId"))
        elif message.get("event") == "robotCompanion/pythonSession":
            candidates.extend([body.get("adapter", {}).get("processId"),
                               body.get("owner", {}).get("debuggeeProcessId")])
        for pid in candidates:
            if type(pid) is int and pid > 1:
                identity = self.process_identity(pid)
                if identity is None or identity["start"] is None:
                    raise AssertionError(f"Could not capture owned process identity: {pid}")
                self.owned_processes[pid] = identity

    def _snapshot_children(self):
        self.owned_processes.update(processes.descendants(self.process.pid))

    def _force_owned_cleanup(self):
        table = processes.snapshot()
        for pid, identity in list(self.owned_processes.items()):
            current = table.get(pid)
            if current is None or current["start"] != identity["start"]:
                continue  # Never act on a reused PID.
            if processes.WINDOWS and current["state"] == "Z":
                continue  # Exited; only a handle keeps the Windows process object.
            self.forced_cleanup = True
            processes.kill(pid, identity)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self._snapshot_children()
        if not self.process.stdin.closed:
            try:
                self.process.stdin.close()  # EOF lets the backend run its owned cleanup.
            except (BrokenPipeError, OSError):
                pass
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self._snapshot_children()
            self._force_owned_cleanup()
            self.forced_cleanup = True
            self.process.kill()
            self.process.wait(timeout=5)
        # A crashed parent can no longer reap/stop its children. Clean only
        # captured identities, and report the fallback so it cannot hide a leak.
        self._force_owned_cleanup()
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()
        self.transcript.append({"cleanup": {"forced": self.forced_cleanup,
                                            "backendPid": self._backend_pid,
                                            "backendIdentity": self.backend_identity,
                                            "ownedProcesses": self.owned_processes,
                                            "ownedProcessIds": list(self.owned_processes)}})


class DapClient(Client):
    """DAP framing: seq/request_seq correlation; responses are returned, not raised."""

    def __init__(self, env=None):
        super().__init__("dap", env=env)
        self.events = []
        self.responses = {}

    def raw(self, message):
        self.transcript.append({"sent": message})
        self.stream.write(message)

    def start_request(self, command, arguments=None):
        self.counter += 1
        message = {"seq": self.counter, "type": "request", "command": command}
        if arguments is not None:
            message["arguments"] = arguments
        self.raw(message)
        return self.counter

    def request(self, command, arguments=None, timeout=40):
        return self.response(self.start_request(command, arguments), timeout)

    def event(self, name, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for index, message in enumerate(self.events):
                if message.get("event") == name:
                    return self.events.pop(index).get("body", {})
            message = self.next_message(deadline)
            if message.get("type") == "response":
                self.responses[message["request_seq"]] = message
            else:
                self.events.append(message)

    def next_message(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Backend DAP message timed out")
        message = self.messages.get(timeout=remaining)
        if isinstance(message, Exception):
            raise message
        self.transcript.append({"received": message})
        return message

    def response(self, request_seq, timeout=40):
        if request_seq in self.responses:
            return self.responses.pop(request_seq)
        deadline = time.monotonic() + timeout
        while True:
            message = self.next_message(deadline)
            if message.get("type") == "response" and message.get("request_seq") == request_seq:
                return message
            if message.get("type") == "response":
                self.responses[message["request_seq"]] = message
            else:
                self.events.append(message)

    def drain(self, timeout=10):
        """Collect every remaining message until the backend closes stdout."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.events.append(self.next_message(deadline))
            except EOFError:
                return self.events


class SocketDapClient(DapClient):
    """Second real DAP session over the parent-owned loopback handoff socket."""

    def __init__(self, endpoint):
        self.connection = socket.create_connection((endpoint["host"], endpoint["port"]), timeout=10)
        self.connection.settimeout(None)
        self.reader_file = self.connection.makefile("rb")
        self.writer_file = self.connection.makefile("wb")
        self.stream = FramedStream(self.reader_file, self.writer_file)
        self.messages = queue.Queue()
        self.transcript = []
        self.stderr = bytearray()
        self.counter = 0
        self.events = []
        self.responses = {}
        self.owned_processes = {}
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def close(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()
        self.reader.join(timeout=5)
        self.reader_file.close()
        self.writer_file.close()

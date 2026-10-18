"""Headless real-process protocol driver with bounded waits and owned cleanup."""

import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time

from robot_companion_backend.protocol import FramedStream


class Client:
    def __init__(self, service="lsp", cwd=None):
        env = os.environ.copy()
        if cwd and env.get("PYTHONPATH"):  # keep a relative source path valid in another cwd
            env["PYTHONPATH"] = os.pathsep.join(map(os.path.abspath, filter(None, env["PYTHONPATH"].split(os.pathsep))))
        self.process = subprocess.Popen([sys.executable, "-m", "robot_companion_backend", service],
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
        try:
            from pathlib import Path
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return {"parent": int(fields[1]), "group": int(fields[2]), "start": fields[19]}
        except (OSError, ValueError, IndexError):
            return None

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
                if identity is not None:
                    self.owned_processes[pid] = identity

    def _snapshot_children(self):
        from pathlib import Path
        identities = {}
        for entry in Path("/proc").glob("[0-9]*"):
            pid = int(entry.name)
            if identity := self.process_identity(pid):
                identities[pid] = identity
        parents = {self.process.pid}
        while found := {pid for pid, identity in identities.items()
                        if identity["parent"] in parents and pid not in parents}:
            for pid in found:
                self.owned_processes[pid] = identities[pid]
            parents.update(found)

    def _force_owned_cleanup(self):
        for pid, identity in list(self.owned_processes.items()):
            current = self.process_identity(pid)
            if current is None or current["start"] != identity["start"]:
                continue  # Never act on a reused PID.
            self.forced_cleanup = True
            try:
                if current["group"] == pid:
                    os.killpg(pid, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

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
                                            "ownedProcessIds": list(self.owned_processes)}})


class DapClient(Client):
    """DAP framing: seq/request_seq correlation; responses are returned, not raised."""

    def __init__(self):
        super().__init__("dap")
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

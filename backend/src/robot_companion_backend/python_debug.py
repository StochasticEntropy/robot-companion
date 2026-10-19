"""Version-1 Python child-session handoff, using an owned debugpy stdio adapter.

The second DAP connection controls Python frames in the existing Robot worker.
No debugpy private launcher protocol or unowned listen() adapter is used.
Live conformance is required before this experimental contract is advertised.
"""

import importlib.metadata
import os
import queue
import socket
import subprocess
import sys
import threading
import uuid

from .process_tree import ProcessTree
from .protocol import FramedStream, ProtocolError

HANDOFF_VERSION = 1
DEBUGPY_VERSION = "1.8.22"
STOP_TIMEOUT = 5


def require_debugpy():
    try:
        version = importlib.metadata.version("debugpy")
    except importlib.metadata.PackageNotFoundError:
        version = None
    if version != DEBUGPY_VERSION:
        raise ValueError(f"debugpy {DEBUGPY_VERSION} is required for Python handoff; found {version or 'not installed'}")
    return version


class PythonSession:
    """Own one debugpy adapter process, TCP client connection and reader threads."""

    def __init__(self, owner, cwd):
        require_debugpy()
        self.owner = owner
        self.session_id = uuid.uuid4().hex
        self.connected = False
        self.stopping = threading.Event()
        self.lost = threading.Event()
        self.stop_lock = threading.Lock()
        self.stopped = False
        self.messages = queue.Queue(maxsize=256)
        self.client = None
        self.handles = []
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.server.settimeout(0.5)
        self.endpoint = self.server.getsockname()
        try:
            self.tree = ProcessTree([sys.executable, "-m", "debugpy.adapter"],
                                    lambda problems: owner.cleanup_failed("Python adapter", problems), cwd=cwd,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            self.server.close()
            raise
        self.process = self.tree.process
        self.stream = FramedStream(self.process.stdout, self.process.stdin)
        self.threads = [threading.Thread(target=self._adapter_messages, daemon=True),
                        threading.Thread(target=self._errors, daemon=True),
                        threading.Thread(target=self._client, daemon=True)]

    def start(self):
        for thread in self.threads:
            thread.start()

    def descriptor(self, worker_pid):
        return {"version": HANDOFF_VERSION, "phase": "start", "sessionId": self.session_id,
                "adapter": {"id": "debugpy", "version": DEBUGPY_VERSION,
                            "processId": self.process.pid},
                "owner": {"processId": os.getpid(), "debuggeeProcessId": worker_pid},
                "connect": {"host": self.endpoint[0], "port": self.endpoint[1]},
                "configuration": {"request": "attach", "listen": {"host": "127.0.0.1", "port": 0},
                                  "subProcess": False, "justMyCode": False},
                "lifecycle": "parent-owned; parent termination or child connection loss closes both sessions"}

    def _lost(self, detail):
        if not self.stopping.is_set() and not self.lost.is_set():
            self.lost.set()
            self.owner.python_session_lost(self, detail)

    def _adapter_messages(self):
        try:
            while not self.stopping.is_set() and (message := self.stream.read()) is not None:
                if message.get("event") == "debugpyWaitingForServer":
                    address = message.get("body", {})
                    if address.get("host") != "127.0.0.1" or type(address.get("port")) is not int \
                            or not 0 < address["port"] <= 65535:
                        raise ProtocolError("debugpy supplied an invalid local debuggee endpoint")
                    self.owner.connect_python(self, address)
                while not self.stopping.is_set():
                    try:
                        self.messages.put(message, timeout=0.5)
                        break
                    except queue.Full:
                        continue
        except (OSError, ProtocolError, ValueError) as exc:
            self._lost(str(exc))
        finally:
            self._lost("Python adapter closed its DAP stream")

    def _errors(self):
        try:
            while data := self.process.stderr.read1(65536):
                self.owner.event("output", {"category": "stderr", "output": data.decode("utf-8", "replace")})
        except (OSError, ValueError):
            pass

    def _client_requests(self, stream):
        try:
            while not self.stopping.is_set() and (request := stream.read()) is not None:
                if request.get("type") == "request" and request.get("command") == "launch":
                    raise ProtocolError("Python child session attaches only to its owned Robot worker")
                if request.get("type") == "request" and request.get("command") == "attach":
                    options = request.get("arguments", {})
                    if not isinstance(options, dict) or options.get("listen") != {"host": "127.0.0.1", "port": 0} \
                            or options.get("subProcess") is not False \
                            or any(key in options for key in ("connect", "processId")):
                        raise ProtocolError("Use the versioned handoff's local attach configuration unchanged")
                self.stream.write(request)
        except (OSError, ProtocolError, ValueError) as exc:
            self._lost(str(exc))
        finally:
            self._lost("Python DAP client disconnected")

    def _client(self):
        try:
            while not self.stopping.is_set():
                try:
                    self.client, _ = self.server.accept()
                    break
                except socket.timeout:
                    continue
            if self.client is None:
                return
            if self.stopping.is_set():
                self.client.close()
                return
            self.server.close()  # A session has one owner/client; no reconnection.
            reader, writer = self.client.makefile("rb"), self.client.makefile("wb")
            self.handles.extend([reader, writer])
            stream = FramedStream(reader, writer)
            incoming = threading.Thread(target=self._client_requests, args=(stream,), daemon=True)
            self.threads.append(incoming)
            incoming.start()
            while not self.stopping.is_set():
                try:
                    message = self.messages.get(timeout=0.5)
                except queue.Empty:
                    continue
                stream.write(message)
        except (OSError, ProtocolError, ValueError) as exc:
            self._lost(str(exc))

    def stop(self):
        with self.stop_lock:
            if self.stopped:
                return
            try:
                self._stop()
            finally:
                self.stopped = True

    def _stop(self):
        self.stopping.set()
        try:
            if self.client is not None:
                try:
                    self.client.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.client.close()
            self.server.close()
            self.tree.stop(STOP_TIMEOUT)
        finally:
            self._release()

    def _release(self):
        # Attach mode never launches another debuggee; the worker is parent-owned.
        for thread in list(self.threads):
            if thread is not threading.current_thread() and thread.ident is not None:
                thread.join(timeout=STOP_TIMEOUT)
        for handle in [*self.handles, self.process.stdin, self.process.stdout, self.process.stderr]:
            # A lost peer makes a buffered writer's final flush fail; cleanup
            # must still close every remaining handle and report termination.
            try:
                handle.close()
            except OSError:
                pass
        self.tree.close()

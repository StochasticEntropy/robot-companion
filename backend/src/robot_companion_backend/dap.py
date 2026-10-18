"""Stdio DAP with an owned Robot worker and experimental paused-thread commands."""

import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading

from .protocol import FramedStream, ProtocolError
from .python_debug import HANDOFF_VERSION, PythonSession

# Only implemented requests are advertised; absent capabilities are unsupported.
CAPABILITIES = {"supportsConfigurationDoneRequest": True, "supportsTerminateRequest": True}
PENDING_BREAKPOINT = "Awaiting RF worker verification at configurationDone"
READY_TIMEOUT = 30
STOP_TIMEOUT = 5


class RequestError(Exception):
    pass


class Worker:
    """Robot worker child in its own process group with private framed control/event pipes."""

    def __init__(self, adapter, targets, cwd, robot_args, python_debug=False):
        self.adapter = adapter
        self.ready = False
        self.paused = False
        self.pending = {}
        self.request_counter = 0
        self.pending_lock = threading.Lock()
        self.stop_lock = threading.Lock()
        self.stopped = False
        control_read, control_write = os.pipe()
        event_read, event_write = os.pipe()
        argv = [sys.executable, "-m", "robot_companion_backend.worker",
                "--control-fd", str(control_read), "--event-fd", str(event_write),
                *(["--python-debug"] if python_debug else []), "--", *robot_args, *targets]
        env = os.environ.copy()
        if env.get("PYTHONPATH"):
            # The worker runs in the launch cwd; keep importing this adapter's backend source.
            env["PYTHONPATH"] = os.pathsep.join(os.path.abspath(entry) if entry else entry
                                                for entry in env["PYTHONPATH"].split(os.pathsep))
        try:
            self.process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, pass_fds=(control_read, event_write),
                                            start_new_session=True)
        except Exception:
            os.close(control_write)
            os.close(event_read)
            raise
        finally:
            os.close(control_read)
            os.close(event_write)
        self.control = FramedStream(None, os.fdopen(control_write, "wb"))
        self.events = os.fdopen(event_read, "rb")
        self.replies = queue.Queue()
        self.readers = [threading.Thread(target=self._output, args=(self.process.stdout, "stdout"), daemon=True),
                        threading.Thread(target=self._output, args=(self.process.stderr, "stderr"), daemon=True),
                        threading.Thread(target=self._events, daemon=True)]
        for reader in self.readers:
            reader.start()
        self.watcher = threading.Thread(target=self._watch, daemon=True)
        self.watcher.start()

    def _output(self, pipe, category):
        while data := pipe.read1(65536):
            self.adapter.event("output", {"category": category, "output": data.decode("utf-8", "replace")})

    def _events(self):
        stream = FramedStream(self.events, None)
        try:
            while (message := stream.read()) is not None:
                if "requestId" in message:
                    with self.pending_lock:
                        reply = self.pending.get(message["requestId"])
                    if message.get("resumed"):
                        self.paused = False
                    if reply is not None:
                        reply.put(message)
                elif message.get("event") in ("ready", "prerequisite"):
                    self.replies.put(message)
                else:
                    if message.get("event") == "robotCompanion/pythonConnected":
                        self.adapter.python_connected(message.get("body", {}))
                    if message.get("event") == "stopped":
                        self.paused = True
                    elif message.get("event") == "continued":
                        self.paused = False
                    self.adapter.event(message["event"], message.get("body"))
        except (ProtocolError, OSError) as exc:
            self.replies.put({"event": "protocolError", "message": str(exc)})
        self.replies.put(None)
        with self.pending_lock:
            for reply in self.pending.values():
                reply.put({"error": "Robot worker event pipe closed"})

    def _watch(self):
        code = self.process.wait()
        for reader in self.readers:
            reader.join(timeout=STOP_TIMEOUT)
        self._kill_group()
        if self.ready:
            self.adapter.worker_finished(code)

    def wait_ready(self):
        try:
            message = self.replies.get(timeout=READY_TIMEOUT)
        except queue.Empty:
            message = {"event": "prerequisite", "message": "Robot worker did not report readiness"}
        if message and message.get("event") == "ready":
            self.ready = True
            return message
        if message is not None:
            try:  # A reported prerequisite failure exits by itself; keep its real exit code.
                self.process.wait(timeout=STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                pass
        self.stop()
        detail = (message or {}).get("message", "Robot worker exited before readiness")
        raise RequestError(f"{detail} (worker exit code {self.process.returncode})")

    def send(self, message):
        try:
            self.control.write(message)
        except (BrokenPipeError, OSError, ValueError):
            raise RequestError("Robot worker is not running") from None

    def request(self, command, arguments):
        if not self.paused or self.process.poll() is not None:
            raise RequestError("Robot worker is not paused")
        with self.pending_lock:
            self.request_counter += 1
            request_id = self.request_counter
            reply = self.pending[request_id] = queue.Queue()
        try:
            self.send({"command": command, "arguments": arguments, "requestId": request_id})
            try:
                message = reply.get(timeout=READY_TIMEOUT)
            except queue.Empty:
                # A timed-out evaluation may still be executing: do not leave a
                # desynchronized worker available for more commands.
                self.stop()
                raise RequestError("Robot command timed out; worker terminated") from None
            if message.get("error"):
                raise RequestError(message["error"])
            return message.get("body")
        finally:
            with self.pending_lock:
                self.pending.pop(request_id, None)

    def _kill_group(self, sig=signal.SIGKILL):
        try:
            os.killpg(self.process.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def stop(self):
        with self.stop_lock:
            if self.stopped:
                return
            self._stop()
            self.stopped = True

    def _stop(self):
        if self.process.poll() is None:
            self._kill_group(signal.SIGTERM)
            try:
                self.process.wait(timeout=STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                self._kill_group()
                self.process.wait(timeout=STOP_TIMEOUT)
        self._kill_group()
        self.watcher.join(timeout=STOP_TIMEOUT * 2)
        for handle in (self.control.writer, self.events):
            try:
                handle.close()
            except OSError:
                pass


class DebugAdapter:
    def __init__(self, stream):
        self.stream = stream
        self.seq = 0
        self.seq_lock = threading.Lock()
        self.initialized = False
        self.worker = None
        self.configured = False
        self.terminated = False
        self.breakpoints = {}
        self.next_breakpoint = 0
        self.python = None
        self.python_ended = False
        self.python_started = False
        self.cleanup_thread = None

    def send(self, message):
        with self.seq_lock:
            self.seq += 1
            self.stream.write({"seq": self.seq, **message})

    def event(self, name, body=None):
        message = {"type": "event", "event": name}
        if body is not None:
            message["body"] = body
        self.send(message)

    def worker_finished(self, code):
        self.stop_python()
        self.event("exited", {"exitCode": code})
        self.terminate_event()

    def terminate_event(self):
        with self.seq_lock:
            if self.terminated:
                return
            self.terminated = True
        self.event("terminated")

    def stop_python(self):
        if self.python is not None:
            self.python.stop()
            if self.python_started and not self.python_ended:
                self.python_ended = True
                self.event("robotCompanion/pythonSession", {"version": HANDOFF_VERSION, "phase": "end",
                                                           "sessionId": self.python.session_id})

    def python_session_lost(self, session, detail):
        if self.python is not session:
            return
        self.event("output", {"category": "important", "output": f"Python session ended: {detail}\n"})
        # Leave the reader before centralized cleanup joins it. Use the same
        # bounded TERM -> KILL/reap path even if library code ignores SIGTERM.
        self.cleanup_thread = threading.Thread(target=self.stop_worker, daemon=True)
        self.cleanup_thread.start()

    def connect_python(self, session, address):
        if self.python is not session or self.worker is None:
            raise ProtocolError("Python handoff has no owning Robot worker")
        try:
            self.worker.send({"command": "connectPython", "version": HANDOFF_VERSION,
                              "sessionId": session.session_id, **address})
        except RequestError as exc:
            raise ProtocolError(str(exc)) from exc

    def python_connected(self, body):
        if self.python is not None and body.get("sessionId") == self.python.session_id:
            self.python.connected = True

    def stop_worker(self):
        if self.worker is not None:
            self.worker.stop()
        else:
            self.terminate_event()
        self.stop_python()

    def launch(self, arguments):
        if self.worker is not None:
            raise RequestError("Only one launch is supported per debug session")
        cwd = Path(arguments.get("cwd") or os.getcwd())
        targets = arguments.get("target")
        targets = [targets] if isinstance(targets, str) else targets
        if not targets or not all(isinstance(t, str) and t for t in targets):
            raise RequestError("launch requires 'target': a Robot suite path or list of paths")
        missing = [t for t in targets if not (cwd / t).exists()]
        if not cwd.is_dir() or missing:
            raise RequestError(f"Launch paths not found: {missing or [str(cwd)]}")
        robot_args = arguments.get("args", [])
        if not isinstance(robot_args, list) or not all(isinstance(a, str) for a in robot_args):
            raise RequestError("launch 'args' must be a list of strings")
        if any("\0" in argument for argument in [*targets, *robot_args, str(cwd)]):
            raise RequestError("Launch arguments must not contain NUL bytes")
        python_options = arguments.get("pythonDebug")
        if python_options is not None:
            if not isinstance(python_options, dict) or python_options != {"handoffVersion": HANDOFF_VERSION} \
                    or type(python_options.get("handoffVersion")) is not int:
                raise RequestError("pythonDebug requires exactly {handoffVersion: 1}")
            try:
                self.python = PythonSession(self, cwd)
                self.python.start()
            except ValueError as exc:
                raise RequestError(str(exc)) from exc
        try:
            self.worker = Worker(self, targets, cwd, robot_args, self.python is not None)
        except Exception:
            self.stop_python()
            self.python = None
            raise
        try:
            ready = self.worker.wait_ready()
            if self.python is not None and (self.python.lost.is_set() or self.python.process.poll() is not None):
                self.worker.stop()
                raise RequestError("Python adapter ended before the handoff was ready")
        except RequestError:
            self.worker = None
            self.stop_python()
            self.python = None
            raise
        self.event("process", {"name": "Robot Framework " + ready.get("robot", ""),
                               "systemProcessId": self.worker.process.pid, "startMethod": "launch",
                               "isLocalProcess": True})
        if self.python is not None:
            self.python_started = True
            self.event("robotCompanion/pythonSession", self.python.descriptor(self.worker.process.pid))
        return None

    def set_breakpoints(self, arguments):
        source = arguments.get("source", {})
        if not isinstance(source, dict):
            raise RequestError("setBreakpoints requires source.path")
        path = source.get("path")
        if not isinstance(path, str) or not path:
            raise RequestError("setBreakpoints requires source.path")
        if self.configured:
            raise RequestError("Changing breakpoints after configurationDone is not supported at this checkpoint")
        requested = arguments.get("breakpoints", [])
        if not isinstance(requested, list):
            raise RequestError("breakpoints must be a list")
        if any(isinstance(b, dict) and any(k in b for k in ("condition", "hitCondition", "logMessage"))
               for b in requested):
            raise RequestError("Conditional, hit-count and log breakpoints are unsupported")
        lines = [b.get("line") for b in requested if isinstance(b, dict)]
        if len(lines) != len(requested) or not all(isinstance(n, int) and n >= 1 for n in lines):
            raise RequestError("Breakpoint lines must be positive integers")
        path = str(Path(path).resolve())
        result = []
        for line in lines:
            self.next_breakpoint += 1
            result.append({"id": self.next_breakpoint, "verified": False, "line": line,
                           "source": {"path": path}, "message": PENDING_BREAKPOINT})
        self.breakpoints[path] = [{"id": bp["id"], "line": bp["line"]} for bp in result]
        return {"breakpoints": result}

    def dispatch(self, command, arguments):
        if command == "initialize":
            if self.initialized:
                raise RequestError("Already initialized")
            if arguments.get("linesStartAt1", True) is not True or arguments.get("columnsStartAt1", True) is not True \
                    or arguments.get("pathFormat", "path") != "path":
                raise RequestError("Only 1-based lines/columns and file-system paths are supported")
            self.initialized = True
            return dict(CAPABILITIES)
        if not self.initialized:
            raise RequestError("Debug adapter not initialized")
        if command == "launch":
            return self.launch(arguments)
        if command == "setBreakpoints":
            return self.set_breakpoints(arguments)
        if command == "configurationDone":
            if self.worker is None or self.configured:
                raise RequestError("configurationDone requires one prior successful launch")
            if self.python is not None and not self.python.connected:
                raise RequestError("Configure the Python child attach session before Robot configurationDone")
            self.worker.send({"command": "configurationDone", "breakpoints": self.breakpoints})
            self.configured = True
            return None
        if command in ("stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn"):
            if self.worker is None:
                raise RequestError("Robot worker is not paused")
            return self.worker.request(command, arguments)
        if command == "threads":
            running = self.worker is not None and self.worker.process.poll() is None
            return {"threads": [{"id": 1, "name": "Robot Framework"}] if running else []}
        if command in ("terminate", "disconnect"):
            self.stop_worker()
            return None
        raise RequestError(f"Unsupported request: {command}")

    def respond(self, request, success, body=None, message=None):
        reply = {"type": "response", "request_seq": request.get("seq") if isinstance(request.get("seq"), int) else 0,
                 "command": request.get("command") if isinstance(request.get("command"), str) else "unknown",
                 "success": success}
        if message is not None:
            reply["message"] = message
            reply["body"] = {"error": {"id": 1, "format": message, "showUser": True}}
        elif body is not None:
            reply["body"] = body
        self.send(reply)

    def run(self):
        try:
            while True:
                try:
                    message = self.stream.read()
                except ProtocolError as exc:
                    self.event("output", {"category": "important", "output": f"DAP protocol error: {exc}\n"})
                    return 1
                if message is None:
                    return 1
                command, arguments = message.get("command"), message.get("arguments", {})
                if message.get("type") != "request" or not isinstance(message.get("seq"), int) \
                        or not isinstance(command, str) or not isinstance(arguments, dict):
                    self.respond(message, False, message="Invalid DAP request")
                    continue
                try:
                    body = self.dispatch(command, arguments)
                except (RequestError, OSError) as exc:
                    self.respond(message, False, message=str(exc))
                    continue
                except Exception as exc:
                    print(f"Debug request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                    self.respond(message, False, message="Internal backend error; see stderr")
                    continue
                self.respond(message, True, body)
                if command == "launch":
                    self.event("initialized")
                if command == "disconnect":
                    return 0
        finally:
            self.stop_worker()
            if self.cleanup_thread is not None:
                self.cleanup_thread.join(timeout=STOP_TIMEOUT * 3)


def serve(reader, writer):
    return DebugAdapter(FramedStream(reader, writer)).run()

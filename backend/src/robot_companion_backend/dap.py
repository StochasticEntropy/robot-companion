"""Stdio DAP with an owned Robot worker and experimental paused-thread commands."""

import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading

from .control import ControlListener
from .process_tree import ProcessTree, abnormal_exit
from .protocol import FramedStream, ProtocolError
from .python_debug import HANDOFF_VERSION, PythonSession

# Only implemented requests are advertised; absent capabilities are unsupported.
CAPABILITIES = {"supportsConfigurationDoneRequest": True, "supportsTerminateRequest": True,
                "supportsConditionalBreakpoints": True, "supportsLogPoints": True}
PENDING_BREAKPOINT = "Awaiting RF worker verification at configurationDone"
PENDING_SAFE_POINT = "Applies when the running Robot test reaches its next keyword (safe point)"
ENDED_BREAKPOINT = "The Robot run has ended"
PAUSE_REQUESTED = ("Pause requested: Robot stops before its next keyword. Library code that is running now "
                   "is not interrupted.\n")
# Breakpoint replacements sent while Robot runs and not yet applied at a safe point.
MAX_UNAPPLIED_CHANGES = 64
PAUSED_COMMANDS = ("stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn", "stepOut")
READY_TIMEOUT = 30
STOP_TIMEOUT = 5
REPORTED_REFUSALS = 10
CLEANUP_FAILED_EXIT = 5  # `dap` exit status when an owned process tree could not be cleaned up


class RequestError(Exception):
    pass


class Worker:
    """Robot worker child in its own process tree, with an authenticated private control channel."""

    def __init__(self, adapter, targets, cwd, robot_args, python_debug=False):
        self.adapter = adapter
        self.ready = False
        self.paused = False
        self.pause_pending = False
        self.unapplied = 0
        self.pending = {}
        self.request_counter = 0
        self.pending_lock = threading.Lock()
        self.stop_lock = threading.Lock()
        self.stopping = False
        self.stopped = False
        self.connection = self.control = self.events = self.event_reader = None
        self.refusals = 0
        listener = ControlListener()
        argv = [sys.executable, "-m", "robot_companion_backend.worker", "--control-port", str(listener.port),
                *(["--python-debug"] if python_debug else []), "--", *robot_args, *targets]
        env = os.environ.copy()
        if env.get("PYTHONPATH"):
            # The worker runs in the launch cwd; keep importing this adapter's backend source.
            env["PYTHONPATH"] = os.pathsep.join(os.path.abspath(entry) if entry else entry
                                                for entry in env["PYTHONPATH"].split(os.pathsep))
        try:
            self.tree = ProcessTree(argv, lambda problems: adapter.cleanup_failed("Robot worker", problems),
                                    cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE)
        except BaseException:
            listener.close()
            raise
        self.process = self.tree.process
        self.readers = [threading.Thread(target=self._output, args=(self.process.stdout, "stdout"), daemon=True),
                        threading.Thread(target=self._output, args=(self.process.stderr, "stderr"), daemon=True)]
        for reader in self.readers:
            reader.start()
        try:
            # The secret goes only through the child's private stdin pipe; it then reads EOF.
            self.process.stdin.write(listener.secret_line())
            self.process.stdin.flush()
        except OSError:
            pass  # The worker already exited; accept below reports its exit code.
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.connection = listener.accept(READY_TIMEOUT, lambda: self.tree.poll() is None, self._refused)
        except BaseException:
            self.stopping = True
            self._release()
            raise
        if self.connection is None:
            self.stopping = True
            self._release()
            raise RequestError("Robot worker did not open its control channel "
                               f"(worker exit code {self.process.returncode})")
        try:
            self.control = FramedStream(None, self.connection.makefile("wb"))
            self.events = self.connection.makefile("rb")
            self.replies = queue.Queue()
            self.event_reader = threading.Thread(target=self._events, daemon=True)
            self.event_reader.start()
            self.watcher = threading.Thread(target=self._watch, daemon=True)
            self.watcher.start()
        except BaseException:
            self.stopping = True
            self.tree.stop()
            self._release()
            raise

    def _refused(self, detail):
        self.refusals += 1
        if self.refusals <= REPORTED_REFUSALS:
            output = f"Refused an unauthenticated Robot worker control connection: {detail}\n"
        elif self.refusals == REPORTED_REFUSALS + 1:
            output = "Refused more unauthenticated Robot worker control connections; no longer reporting each\n"
        else:
            return
        self.adapter.event("output", {"category": "important", "output": output})

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
                        self.paused = self.pause_pending = False
                    if reply is not None:
                        reply.put(message)
                elif "applied" in message:
                    self.unapplied = max(0, self.unapplied - 1)
                    if not self.stopping:
                        self.adapter.breakpoints_applied(message["applied"])
                elif message.get("event") in ("ready", "prerequisite"):
                    self.replies.put(message)
                else:
                    if message.get("event") == "robotCompanion/pythonConnected":
                        self.adapter.python_connected(message.get("body", {}))
                    if message.get("event") == "stopped":
                        self.paused = True
                        self.pause_pending = False
                    elif message.get("event") == "continued":
                        # A pause sent before this resume was answered by the stop or ignored while paused.
                        self.paused = self.pause_pending = False
                    self.adapter.event(message["event"], message.get("body"))
        except (ProtocolError, OSError) as exc:
            if self.ready and not self.stopping:
                self.adapter.event("output", {"category": "important",
                                              "output": f"Robot worker control channel failed: {exc}\n"})
            self.replies.put({"event": "protocolError", "message": str(exc)})
        self.replies.put(None)
        with self.pending_lock:
            for reply in self.pending.values():
                reply.put({"error": "Robot worker control channel closed"})

    def _watch(self):
        code = self.tree.wait()  # also kills descendants that outlived the worker
        for reader in [*self.readers, self.event_reader]:
            reader.join(timeout=STOP_TIMEOUT)
        if self.ready and not self.stopping and (detail := abnormal_exit(code)):
            self.adapter.event("output", {"category": "important", "output": f"Robot worker crashed: {detail}\n"})
        if self.ready:
            self.adapter.worker_finished(code)

    def wait_ready(self):
        try:
            message = self.replies.get(timeout=READY_TIMEOUT)
        except queue.Empty:
            message = {"event": "prerequisite", "message": "Robot worker did not report readiness"}
        if message and message.get("event") == "ready":
            pid = message.get("processId")
            if type(pid) is not int or pid <= 1:
                self.stop()
                raise RequestError("Robot worker reported an invalid interpreter identity")
            self.interpreter_pid = pid
            self.ready = True
            return message
        if message is not None:
            try:  # A reported prerequisite failure exits by itself; keep its real exit code.
                self.tree.wait(STOP_TIMEOUT)
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

    def running(self):
        return self.ready and not self.stopping and self.tree.poll() is None

    def request(self, command, arguments, **fields):
        if not self.paused or self.tree.poll() is not None:
            raise RequestError("Robot worker is not paused")
        with self.pending_lock:
            self.request_counter += 1
            request_id = self.request_counter
            reply = self.pending[request_id] = queue.Queue()
        try:
            self.send({"command": command, "arguments": arguments, "requestId": request_id, **fields})
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

    def stop(self):
        with self.stop_lock:
            if self.stopped:
                return
            self.stopping = True
            self.tree.stop()
            self.watcher.join(timeout=STOP_TIMEOUT * 2)
            self._release()
            self.stopped = True

    def _release(self):
        if self.connection is None:  # Never authenticated: no watcher owns the tree yet.
            self.tree.stop()
            for reader in self.readers:
                reader.join(timeout=STOP_TIMEOUT)
        else:
            # Shut down first: it ends a blocked event read, whose buffer lock close() needs.
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            reader = self.event_reader
            if reader is not None and reader.ident is not None:
                reader.join(timeout=STOP_TIMEOUT)
            handles = [self.control and self.control.writer]
            if reader is None or not reader.is_alive():
                handles.append(self.events)
            for handle in filter(None, handles):
                try:
                    handle.close()
                except OSError:
                    pass
            self.connection.close()
        self.tree.close()
        for reader, pipe in zip(self.readers, (self.process.stdout, self.process.stderr)):
            if not reader.is_alive():
                pipe.close()


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
        self.generation = 0
        self.generations = {}  # source path -> generation of its latest replacement
        self.python = None
        self.python_ended = False
        self.python_started = False
        self.cleanup_thread = None
        self.cleanup_failures = []
        self.client_gone = False

    def cleanup_failed(self, owner, problems):
        """Report failed child cleanup on DAP output and stderr; `run` then exits non-zero."""
        for problem in problems:
            self.cleanup_failures.append(f"{owner}: {problem}")
            print(f"Debug cleanup failed: {owner}: {problem}", file=sys.stderr, flush=True)
            self.event("output", {"category": "important", "output": f"{owner} cleanup failed: {problem}\n"})

    def send(self, message):
        with self.seq_lock:
            self.seq += 1
            if self.client_gone:
                return
            try:
                self.stream.write({"seq": self.seq, **message})
            except (OSError, ValueError) as exc:
                if isinstance(exc, ProtocolError):
                    raise
                # The client closed its input; cleanup still runs and the exit status reports it.
                self.client_gone = True

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
            if self.python is not None and (self.python.lost.is_set() or self.python.tree.poll() is not None):
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
            self.event("robotCompanion/pythonSession", self.python.descriptor(self.worker.interpreter_pid))
        return None

    def set_breakpoints(self, arguments):
        source = arguments.get("source", {})
        if not isinstance(source, dict):
            raise RequestError("setBreakpoints requires source.path")
        path = source.get("path")
        if not isinstance(path, str) or not path:
            raise RequestError("setBreakpoints requires source.path")
        requested = arguments.get("breakpoints", [])
        if not isinstance(requested, list):
            raise RequestError("breakpoints must be a list")
        if any(isinstance(b, dict) and "hitCondition" in b for b in requested):
            raise RequestError("Hit-count breakpoints (hitCondition) are unsupported")
        lines = [b.get("line") for b in requested if isinstance(b, dict)]
        if len(lines) != len(requested) or not all(isinstance(n, int) and n >= 1 for n in lines):
            raise RequestError("Breakpoint lines must be positive integers")
        for key in ("condition", "logMessage"):
            if any(key in b and not isinstance(b[key], str) for b in requested):
                raise RequestError(f"Breakpoint {key} must be a string")
        path = str(Path(path).resolve())
        if self.configured and not self.worker.running():
            return {"breakpoints": [{"verified": False, "line": b["line"], "source": {"path": path},
                                     "message": ENDED_BREAKPOINT} for b in requested]}
        if self.configured and not self.worker.paused and self.worker.unapplied >= MAX_UNAPPLIED_CHANGES:
            raise RequestError("Too many breakpoint changes are waiting for the next Robot keyword; "
                               "try again when the run reaches it")
        # A complete replacement for this source. Unchanged entries keep their IDs; new
        # ones get new IDs, never reused in this session.
        previous, stored = list(self.breakpoints.get(path, [])), []
        for requested_breakpoint in requested:
            entry = {"line": requested_breakpoint["line"],
                     **{k: requested_breakpoint[k] for k in ("condition", "logMessage") if k in requested_breakpoint}}
            kept = next((old for old in previous if {k: v for k, v in old.items() if k != "id"} == entry), None)
            if kept is not None:
                previous.remove(kept)
                entry["id"] = kept["id"]
            else:
                self.next_breakpoint += 1
                entry["id"] = self.next_breakpoint
            # Expressions are checked with RF in the worker and evaluated on its Robot thread.
            stored.append(entry)
        self.breakpoints[path] = stored
        if not self.configured:
            return {"breakpoints": [{"id": b["id"], "verified": False, "line": b["line"], "source": {"path": path},
                                     "message": PENDING_BREAKPOINT} for b in stored]}
        self.generation += 1
        self.generations[path] = self.generation
        change = {"source": path, "breakpoints": stored, "generation": self.generation}
        if self.worker.paused:
            # Applied by the paused Robot thread before this reply, so before any later Continue.
            return self.worker.request("setBreakpoints", {}, **change)
        self.worker.unapplied += 1
        self.worker.send({"command": "setBreakpoints", **change})
        return {"breakpoints": [{"id": b["id"], "verified": False, "line": b["line"], "source": {"path": path},
                                 "message": PENDING_SAFE_POINT} for b in stored]}

    def breakpoints_applied(self, applied):
        """A replacement applied while running; only the source's latest one is reported."""
        if self.generations.get(applied.get("source")) != applied.get("generation"):
            return
        for body in applied.get("breakpoints", []):
            self.event("breakpoint", {"reason": "changed", "breakpoint": body})

    def pause(self, arguments):
        if self.worker is None or not self.configured:
            raise RequestError("Pause requires a started Robot run (after configurationDone)")
        if arguments.get("threadId", 1) != 1:
            raise RequestError("Unknown Robot thread")
        if not self.worker.running():
            raise RequestError("Robot worker is not running")
        if self.worker.paused:
            raise RequestError("Robot worker is already paused")
        if not self.worker.pause_pending:
            self.worker.send({"command": "pause"})
            self.worker.pause_pending = True
            self.event("output", {"category": "console", "output": PAUSE_REQUESTED})
        # The worker stops at its next keyword start; blocking library code is not interrupted.
        return None

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
        if command == "pause":
            return self.pause(arguments)
        if command in PAUSED_COMMANDS:
            if self.worker is None:
                raise RequestError("Robot worker is not paused")
            return self.worker.request(command, arguments)
        if command == "threads":
            running = self.worker is not None and self.worker.tree.poll() is None
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
            code = self._serve()
        finally:
            self.stop_worker()
            if self.cleanup_thread is not None:
                self.cleanup_thread.join(timeout=STOP_TIMEOUT * 3)
        return CLEANUP_FAILED_EXIT if self.cleanup_failures else code

    def _serve(self):
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


def serve(reader, writer):
    return DebugAdapter(FramedStream(reader, writer)).run()

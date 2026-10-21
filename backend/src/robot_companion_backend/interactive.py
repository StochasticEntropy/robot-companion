"""Stdio interactive Robot sessions (REPL and notebook cells) with an owned Robot worker.

Protocol `robotCompanion/interactive` version 1 uses DAP framing and message shapes
(`seq`, `type` request/response/event, `request_seq`), with its own commands:

- `initialize` -> {protocol, version, capabilities}
- `start` {args?: [robot argument strings]} starts a session in this service's working
  directory and answers with the worker's interpreter, versions, process ID, working directory
  and the applied/ignored Robot options. One session runs at a time.
- `execute` {id, code} runs one cell; answered when the cell ends with
  {id, status: PASS|FAIL|SKIP|INTERRUPTED, message, values, sessionEnded?}.
- `interrupt` {id?} interrupts the running cell. A cell still running INTERRUPT_GRACE seconds
  later (a keyword blocked in native code) ends its worker: the answer then has
  sessionEnded: true and the session's variables are gone.
- `variables` lists the session's variables; `restart` replaces the worker with a new one with
  the same arguments; `stop` ends the session; `shutdown` (or end of input) ends the service.

Events: `output` {id, category: stdout|stderr|log, output, level?, html?} attributed to the
cell that was running, `process` {systemProcessId} for each worker process tree, and
`sessionEnded` {sessionId, exitCode, reason}.

This service is independent of the `dap` service: a paused debug session keeps its own
console, which runs one keyword on the paused Robot thread.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading

from . import CONTRACT_VERSION
from .control import ControlListener
from .process_tree import ProcessTree, abnormal_exit
from .protocol import FramedStream, ProtocolError

PROTOCOL = "robotCompanion/interactive"
PROTOCOL_VERSION = 1
CAPABILITIES = {"interrupt": True, "restart": True, "variables": True, "definitions": True}
READY_TIMEOUT = 30
STOP_TIMEOUT = 3  # a stopping worker runs its suite end (library listeners) before it is ended
INTERRUPT_GRACE = 5
CLEANUP_FAILED_EXIT = 5


class RequestError(Exception):
    pass


class SessionWorker:
    """One session's Robot worker in its own process tree, with its session directory."""

    def __init__(self, service, session_id, robot_args):
        self.service = service
        self.session_id = session_id
        self.lock = threading.Lock()
        self.pending = {}  # requestId -> (DAP request, kind)
        self.counter = 0
        self.running = None  # (cell id, DAP request) of the running cell
        self.ready = threading.Event()
        self.info = None
        self.failure = None
        self.ending = None  # reason given when the service ends this worker
        self.connection = None
        self.directory = tempfile.mkdtemp(prefix="robot-companion-session-")
        listener = ControlListener()
        argv = [sys.executable, "-m", "robot_companion_backend.interactive_worker",
                "--control-port", str(listener.port), "--session-dir", self.directory, "--", *robot_args]
        env = os.environ.copy()
        if env.get("PYTHONPATH"):  # keep importing this service's backend source from the worker
            env["PYTHONPATH"] = os.pathsep.join(os.path.abspath(entry) if entry else entry
                                                for entry in env["PYTHONPATH"].split(os.pathsep))
        try:
            self.tree = ProcessTree(argv, lambda problems: service.cleanup_failed("Robot session", problems),
                                    env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except BaseException:
            listener.close()
            shutil.rmtree(self.directory, ignore_errors=True)
            raise
        self.process = self.tree.process
        self.readers = [threading.Thread(target=self._pipe, args=(self.process.stdout, "stdout"), daemon=True),
                        threading.Thread(target=self._pipe, args=(self.process.stderr, "stderr"), daemon=True)]
        for reader in self.readers:
            reader.start()
        try:
            self.process.stdin.write(listener.secret_line())
            self.process.stdin.flush()
        except OSError:
            pass  # exited already; reported below
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.connection = listener.accept(READY_TIMEOUT, lambda: self.tree.poll() is None)
        except BaseException:
            self._release()
            raise
        if self.connection is None:
            self._release()
            raise RequestError(f"Robot session worker did not open its control channel (exit code {self.tree.poll()})")
        self.control = FramedStream(None, self.connection.makefile("wb"))
        self.events = self.connection.makefile("rb")
        self.event_reader = threading.Thread(target=self._events, daemon=True)
        self.event_reader.start()
        self.watcher = threading.Thread(target=self._watch, daemon=True)
        self.watcher.start()

    def _pipe(self, pipe, category):
        # Output written to the worker's file descriptors (native code, child processes).
        while data := pipe.read1(65536):
            running = self.running
            self.service.event("output", {"id": running[0] if running else None, "category": category,
                                          "output": data.decode("utf-8", "replace")})

    def _events(self):
        stream = FramedStream(self.events, None)
        try:
            while (message := stream.read()) is not None:
                if message.get("event") == "ready":
                    self.info = {key: message.get(key) for key in
                                 ("python", "robot", "executable", "processId", "cwd", "applied", "ignored", "warnings")}
                    self.ready.set()
                elif message.get("event") == "prerequisite":
                    self.failure = message.get("message")
                    self.ready.set()
                elif message.get("event") == "output":
                    self.service.event("output", message.get("body") or {})
                elif message.get("event") == "result":
                    self._answer(message)
        except (ProtocolError, OSError):
            pass
        self.ready.set()

    def _answer(self, message):
        with self.lock:
            request, kind = self.pending.pop(message.get("requestId"), (None, None))
            if kind == "execute":
                self.running = None
        if request is None:
            return
        if kind == "execute" and self.ending:
            # The service is ending this worker (Interrupt expired, restart, stop): that is the outcome.
            self.service.respond(request, True, {"id": request["arguments"].get("id"), "status": "INTERRUPTED",
                                                 "message": self.ending, "values": [], "sessionEnded": True})
        elif message.get("error"):
            self.service.respond(request, False, message=message["error"])
        else:
            self.service.respond(request, True, message.get("body"))

    def _watch(self):
        code = self.tree.wait()  # also ends descendants that outlived the worker
        for reader in [*self.readers, self.event_reader]:
            reader.join(timeout=STOP_TIMEOUT)
        detail = abnormal_exit(code)
        reason = self.ending or (f"The Robot session worker ended unexpectedly ({detail or f'exit code {code}'})"
                                 if self.info else self.failure or f"Robot session worker exited (exit code {code})")
        with self.lock:
            pending, self.pending, self.running = list(self.pending.values()), {}, None
        for request, kind in pending:
            if kind == "execute":
                self.service.respond(request, True, {"id": request["arguments"].get("id"), "status": "INTERRUPTED"
                                     if self.ending else "FAIL", "message": reason, "values": [], "sessionEnded": True})
            else:
                self.service.respond(request, False, message=reason)
        self._release()
        self.service.worker_ended(self, code, reason)

    def wait_ready(self):
        if not self.ready.wait(READY_TIMEOUT) or self.info is None:
            detail = self.failure or "The Robot session worker did not report readiness"
            self.stop(detail)
            raise RequestError(detail)
        pid = self.info.get("processId")
        if type(pid) is not int or pid <= 1:
            self.stop("Robot session worker reported an invalid interpreter identity")
            raise RequestError("Robot session worker reported an invalid interpreter identity")
        # The authenticated worker reports its interpreter PID. On Windows the
        # tree root is the venv launcher; retain that root for owned cleanup.
        self.service.event("process", {"name": "Robot Companion session", "systemProcessId": pid,
                                       "sessionId": self.session_id})
        return {"sessionId": self.session_id, **self.info, "sessionDirectory": self.directory}

    def send(self, request, kind, message):
        with self.lock:
            if self.tree.poll() is not None or self.ending:
                raise RequestError("The Robot session is not running")
            if kind == "execute" and self.running:
                raise RequestError("A cell is already running in this Robot session")
            if kind != "execute" and self.running:
                raise RequestError("The Robot session is running a cell")
            self.counter += 1
            self.pending[self.counter] = (request, kind)
            if kind == "execute":
                self.running = (message.get("id"), request)
        try:
            self.control.write({**message, "requestId": self.counter})
        except (OSError, ValueError):
            with self.lock:
                self.pending.pop(self.counter, None)
                self.running = None
            raise RequestError("The Robot session is not running") from None

    def interrupt(self, cell):
        running = self.running
        if not running or (cell is not None and cell != running[0]):
            return False
        try:
            self.control.write({"command": "interrupt", "id": running[0]})
        except (OSError, ValueError):
            return False
        timer = threading.Timer(INTERRUPT_GRACE, self._interrupt_expired, args=(running,))
        timer.daemon = True
        timer.start()
        return True

    def _interrupt_expired(self, running):
        if self.running is running:
            self.stop(f"The cell did not stop within {INTERRUPT_GRACE} s of Interrupt; the Robot session was "
                      "ended and its variables are gone")

    def stop(self, reason, graceful=False):
        """End the worker; its pending requests are answered with `reason`."""
        with self.lock:
            if self.ending is None:
                self.ending = reason
        if graceful and self.connection is not None and self.tree.poll() is None:
            try:
                self.control.write({"command": "stop"})
                self.tree.wait(STOP_TIMEOUT)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        self.tree.stop()
        watcher = getattr(self, "watcher", None)
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=STOP_TIMEOUT * 3)

    def _release(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except OSError:
                pass
        else:
            self.tree.stop()
            for reader in self.readers:
                reader.join(timeout=STOP_TIMEOUT)
        self.tree.close()
        shutil.rmtree(self.directory, ignore_errors=True)


class InteractiveService:
    def __init__(self, stream):
        self.stream = stream
        self.seq = 0
        self.seq_lock = threading.Lock()
        self.initialized = False
        self.worker = None
        self.sessions = 0
        self.robot_args = []
        self.cleanup_failures = []
        self.client_gone = False

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
                self.client_gone = True

    def event(self, name, body=None):
        self.send({"type": "event", "event": name, **({"body": body} if body is not None else {})})

    def respond(self, request, success, body=None, message=None):
        reply = {"type": "response", "request_seq": request.get("seq") if isinstance(request.get("seq"), int) else 0,
                 "command": request.get("command") if isinstance(request.get("command"), str) else "unknown",
                 "success": success}
        if message is not None:
            reply["message"] = message
        elif body is not None:
            reply["body"] = body
        self.send(reply)

    def cleanup_failed(self, owner, problems):
        for problem in problems:
            self.cleanup_failures.append(f"{owner}: {problem}")
            print(f"Session cleanup failed: {owner}: {problem}", file=sys.stderr, flush=True)

    def worker_ended(self, worker, code, reason):
        if self.worker is worker:
            self.worker = None
        self.event("sessionEnded", {"sessionId": worker.session_id, "exitCode": code, "reason": reason})

    def start(self, arguments):
        if self.worker is not None and self.worker.ending:
            self.worker.stop(self.worker.ending)  # finish ending it before the next session starts
        if self.worker is not None:
            raise RequestError("A Robot session is already running; restart or stop it first")
        robot_args = arguments.get("args", self.robot_args)
        if not isinstance(robot_args, list) or not all(isinstance(a, str) and "\0" not in a for a in robot_args):
            raise RequestError("start 'args' must be a list of strings without NUL characters")
        self.robot_args = robot_args
        self.sessions += 1
        worker = SessionWorker(self, self.sessions, robot_args)
        self.worker = worker
        try:
            return worker.wait_ready()
        except RequestError:
            if self.worker is worker:
                self.worker = None
            raise

    def stop_worker(self, reason, graceful=True):
        worker = self.worker
        if worker is not None:
            worker.stop(reason, graceful=graceful)
            if self.worker is worker:
                self.worker = None

    def dispatch(self, request, command, arguments):
        """The response body, or None when the response is sent later."""
        if command == "initialize":
            if self.initialized:
                raise RequestError("Already initialized")
            self.initialized = True
            return {"protocol": PROTOCOL, "version": PROTOCOL_VERSION, "contractVersion": CONTRACT_VERSION,
                    "capabilities": dict(CAPABILITIES)}
        if not self.initialized:
            raise RequestError("Interactive service not initialized")
        if command == "start":
            return self.start(arguments)
        if command == "restart":
            self.stop_worker("The Robot session was restarted")
            return self.start({})
        if command == "stop":
            self.stop_worker("The Robot session was stopped")
            return {}
        if command == "interrupt":
            cell = arguments.get("id")
            return {"interrupted": bool(self.worker and self.worker.interrupt(cell if isinstance(cell, str) else None))}
        if command in ("execute", "variables"):
            if self.worker is None or self.worker.ending:
                raise RequestError("No Robot session is running; start one first")
            if command == "execute":
                if not isinstance(arguments.get("id"), str) or not isinstance(arguments.get("code"), str):
                    raise RequestError("execute requires string 'id' and 'code'")
                self.worker.send(request, "execute", {"command": "execute", "id": arguments["id"],
                                                      "code": arguments["code"]})
            else:
                self.worker.send(request, "variables", {"command": "variables"})
            return None
        raise RequestError(f"Unsupported request: {command}")

    def run(self):
        try:
            code = self._serve()
        finally:
            self.stop_worker("The interactive service ended", graceful=False)
        return CLEANUP_FAILED_EXIT if self.cleanup_failures else code

    def _serve(self):
        while True:
            try:
                message = self.stream.read()
            except ProtocolError as exc:
                print(f"Interactive protocol error: {exc}", file=sys.stderr, flush=True)
                return 1
            if message is None:
                return 0
            command, arguments = message.get("command"), message.get("arguments", {})
            if message.get("type") != "request" or not isinstance(message.get("seq"), int) \
                    or not isinstance(command, str) or not isinstance(arguments, dict):
                self.respond(message, False, message="Invalid request")
                continue
            if command == "shutdown":
                self.stop_worker("The interactive service ended")
                self.respond(message, True, {})
                return 0
            try:
                body = self.dispatch(message, command, arguments)
            except (RequestError, OSError) as exc:
                self.respond(message, False, message=str(exc))
                continue
            except Exception as exc:
                print(f"Interactive request failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                self.respond(message, False, message="Internal backend error; see stderr")
                continue
            if body is not None:
                self.respond(message, True, body)


def serve(reader, writer):
    return InteractiveService(FramedStream(reader, writer)).run()

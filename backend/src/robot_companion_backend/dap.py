"""Stdio DAP with an owned Robot worker and experimental paused-thread commands."""

import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time

from .control import ControlListener
from .process_tree import ProcessTree, abnormal_exit
from .protocol import FramedStream, ProtocolError
from .python_debug import HANDOFF_VERSION, PythonSession

# Only implemented requests are advertised; absent capabilities are unsupported. Robot attach
# has no DAP capability: it is available only through a prepared session (prepared.py).
CAPABILITIES = {"supportsConfigurationDoneRequest": True, "supportsTerminateRequest": True,
                "supportsConditionalBreakpoints": True, "supportsLogPoints": True,
                "supportsRestartRequest": True, "supportsCancelRequest": True}
PENDING_BREAKPOINT = "Awaiting RF worker verification at configurationDone"
READY_TIMEOUT = 30
STOP_TIMEOUT = 5
POLL_INTERVAL = 0.05
REPORTED_REFUSALS = 10
CLEANUP_FAILED_EXIT = 5  # `dap` exit status when an owned process tree could not be cleaned up
# Requests that start or replace a Robot run. They run one at a time on an operation thread,
# so that the protocol reader can still answer cancel and disconnect while they wait.
LIFECYCLE = ("launch", "attach", "restart")
PAUSED_REQUESTS = ("stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn")
CANCELLED = "cancelled"  # the DAP message of a cancelled request's failed response
NO_DETACH = "Owned native sessions cannot detach; disconnect ends the owned run"
EXTERNAL_KEYS = ("processId", "host", "port", "connect", "address", "secret")
EXTERNAL_ATTACH = ("Attaching to an arbitrary process or network endpoint (processId, host, port, connect, "
                   "secret) is unsupported; prepare an owned session with `robot-companion-backend dap-prepare` "
                   "and attach to it")
PLAIN_ATTACH = ("Robot attach requires a prepared session: run `robot-companion-backend dap-prepare` and connect "
                "with `dap-connect`; this adapter starts its own run with launch")
RESTART_CHANGED = ("restart cannot change the target, cwd, Robot arguments or Python debugging; "
                   "stop the session and start a new one")
STALE_HANDLE = "Stale Robot handle from an earlier run of this session"
OUTPUT_DIR = "outputdir"  # Robot's long option name, normalized as Robot normalizes it
OUTPUT_DIR_PREFIX = "outputd"  # its shortest unambiguous abbreviation
STOP_GRACE = 2  # seconds a worker gets to end its run itself once asked to stop


class RequestError(Exception):
    pass


class Cancelled(RequestError):
    def __init__(self):
        super().__init__(CANCELLED)


class Operation:
    """One in-flight lifecycle request; the protocol reader may cancel it."""

    def __init__(self, request):
        self.request = request
        self.seq = request["seq"]
        self.command = request["command"]
        self.cancelled = threading.Event()
        self.thread = None

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled()


def launch_inputs(arguments):
    """Validated run inputs of a launch request (also a prepared session's and a restart's)."""
    cwd = Path(arguments.get("cwd") or os.getcwd())
    targets = arguments.get("target")
    targets = [targets] if isinstance(targets, str) else targets
    if not targets or not isinstance(targets, list) or not all(isinstance(t, str) and t for t in targets):
        raise RequestError("launch requires 'target': a Robot suite path or list of paths")
    robot_args = arguments.get("args", [])
    if not isinstance(robot_args, list) or not all(isinstance(a, str) for a in robot_args):
        raise RequestError("launch 'args' must be a list of strings")
    if any("\0" in argument for argument in [*targets, *robot_args, str(cwd)]):
        raise RequestError("Launch arguments must not contain NUL bytes")
    missing = [t for t in targets if not (cwd / t).exists()]
    if not cwd.is_dir() or missing:
        raise RequestError(f"Launch paths not found: {missing or [str(cwd)]}")
    python_options = arguments.get("pythonDebug")
    if python_options is not None:
        if not isinstance(python_options, dict) or python_options != {"handoffVersion": HANDOFF_VERSION} \
                or type(python_options.get("handoffVersion")) is not int:
            raise RequestError("pythonDebug requires exactly {handoffVersion: 1}")
    return {"targets": targets, "cwd": cwd, "args": robot_args, "python": python_options is not None}


def output_dir_option(argument):
    """Whether `argument` is Robot's output folder option, and its attached value (else None).

    Read as Robot reads it: a long option ignores case and hyphens and may be shortened to an
    unambiguous prefix (`--outputd`; `--output` is another option), with an optional `=value`;
    the short form `-d` takes its value attached (`-dresults`) or as the next argument."""
    if argument.startswith("--"):
        name, equals, value = argument[2:].partition("=")
        name = name.lower().replace("-", "")
        if len(name) >= len(OUTPUT_DIR_PREFIX) and OUTPUT_DIR.startswith(name):
            return True, value if equals else None
        return False, None
    if argument.startswith("-d"):
        return True, argument[2:] or None
    return False, None


def split_output_dir(robot_args):
    """Robot arguments without their output folder options, and the folder the last one names."""
    kept, folder, skip = [], None, False
    for argument in robot_args:
        if skip:
            folder, skip = argument, False
            continue
        is_output_dir, value = output_dir_option(argument)
        if not is_output_dir:
            kept.append(argument)
        elif value is None:
            skip = True
        else:
            folder = value
    return kept, folder


def without_output_dir(robot_args):
    """Robot arguments without their output folder options: a restart may write a new folder."""
    return split_output_dir(robot_args)[0]


def output_folder(inputs):
    """The folder a run writes output.xml to: its last output folder option, relative to its cwd."""
    folder = split_output_dir(inputs["args"])[1]
    return os.path.abspath(inputs["cwd"] / (folder or "."))


def same_run(first, second):
    return (first["targets"], str(first["cwd"]), without_output_dir(first["args"]), first["python"]) == \
        (second["targets"], str(second["cwd"]), without_output_dir(second["args"]), second["python"])


class Worker:
    """Robot worker child in its own process tree, with an authenticated private control channel.

    Each worker is one generation of its adapter's run. A retired worker (replaced by a
    restart or abandoned by a failed start) never reaches the client: its late output,
    stops and exit cannot end or alter the session.
    """

    retired = False

    def __init__(self, adapter, targets, cwd, robot_args, python_debug=False, cancelled=None, generation=1):
        self.adapter = adapter
        self.generation = generation
        self.cancelled = cancelled or threading.Event()
        self.retired = False
        self.finished = False  # its natural end is being reported; a restart can no longer replace it
        self.ready = False
        self.interpreter_pid = None
        self.paused = False
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
            self.connection = listener.accept(READY_TIMEOUT, lambda: self.tree.poll() is None
                                              and not self.cancelled.is_set(), self._refused)
        except BaseException:
            self.stopping = True
            self._release()
            raise
        if self.connection is None:
            self.stopping = True
            self._release()
            if self.cancelled.is_set():
                raise Cancelled()
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

    def emit(self, name, body=None):
        if not self.retired:
            self.adapter.event(name, body)

    def _refused(self, detail):
        self.refusals += 1
        if self.refusals <= REPORTED_REFUSALS:
            output = f"Refused an unauthenticated Robot worker control connection: {detail}\n"
        elif self.refusals == REPORTED_REFUSALS + 1:
            output = "Refused more unauthenticated Robot worker control connections; no longer reporting each\n"
        else:
            return
        self.emit("output", {"category": "important", "output": output})

    def _output(self, pipe, category):
        while data := pipe.read1(65536):
            self.emit("output", {"category": category, "output": data.decode("utf-8", "replace")})

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
                    if message.get("event") == "robotCompanion/pythonConnected" and not self.retired:
                        self.adapter.python_connected(message.get("body", {}))
                    if message.get("event") == "stopped":
                        self.paused = True
                    elif message.get("event") == "continued":
                        self.paused = False
                    self.emit(message["event"], message.get("body"))
        except (ProtocolError, OSError) as exc:
            if self.ready and not self.stopping:
                self.emit("output", {"category": "important", "output": f"Robot worker control channel failed: {exc}\n"})
            self.replies.put({"event": "protocolError", "message": str(exc)})
        self.replies.put(None)
        with self.pending_lock:
            for reply in self.pending.values():
                reply.put({"error": "Robot worker control channel closed"})

    def _watch(self):
        code = self.tree.wait()  # also kills descendants that outlived the worker
        for reader in [*self.readers, self.event_reader]:
            reader.join(timeout=STOP_TIMEOUT)
        if self.ready and not self.stopping and not self.retired and (detail := abnormal_exit(code)):
            self.emit("output", {"category": "important", "output": f"Robot worker crashed: {detail}\n"})
        if self.ready and not self.retired:
            self.adapter.worker_finished(self, code)

    def wait_ready(self):
        deadline = time.monotonic() + READY_TIMEOUT
        message = None
        while True:
            if self.cancelled.is_set():
                self.stop()
                raise Cancelled()
            try:
                message = self.replies.get(timeout=min(0.2, max(0, deadline - time.monotonic())))
                break
            except queue.Empty:
                if time.monotonic() >= deadline:
                    message = {"event": "prerequisite", "message": "Robot worker did not report readiness"}
                    break
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

    def request(self, command, arguments):
        if not self.paused or self.tree.poll() is not None:
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

    def request_stop(self):
        """Ask the run to stop: EOF on the control channel ends a Robot-paused worker at once and a
        running one at its next keyword boundary (listener.py), which Robot records as stopped by the
        user. A paused worker ignores SIGTERM until the paused keyword returns."""
        self.stopping = True
        if self.connection is not None:
            try:
                self.connection.shutdown(socket.SHUT_WR)  # Its events can still be read.
            except OSError:
                pass

    def stop(self):
        with self.stop_lock:
            if self.stopped:
                return
            self.request_stop()
            if self.connection is not None:
                try:  # Give the run its own end first, so it is recorded the same way in every state.
                    self.tree.wait(STOP_GRACE)
                except subprocess.TimeoutExpired:
                    pass
            self.tree.stop()
            if self.watcher is not threading.current_thread():
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
    """One DAP client session. `prepared` marks a prepared session's owner (prepared.py):
    its run is started before a client connects, and it accepts that run's attach only."""

    def __init__(self, stream, prepared=False):
        self.stream = stream
        self.prepared = prepared
        self.seq = 0
        self.seq_lock = threading.Lock()
        # Guards the run state below; never held while waiting for a process or socket.
        self.lock = threading.RLock()
        self.initialized = False
        self.worker = None
        self.python = None
        self.inputs = None
        self.output_folders = []  # each run's output folder; a restart never writes into an earlier one
        self.generation = 0
        self.configured = False
        self.auto_configured = False
        self.restart_pending = False
        self.attached = False
        self.terminated = False
        self.terminate_deferred = False
        self.terminate_pending = False
        self.breakpoints = {}
        self.next_breakpoint = 0
        # Robot frame/variable handles are numbered across generations: a restarted worker
        # starts above every handle its predecessors returned, so an old one never aliases.
        self.handle_base = 1
        self.max_handle = 0
        self.operation = None
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
            if self.client_gone or self.stream is None:
                return  # A prepared run has no client before it is attached.
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

    def worker_finished(self, worker, code):
        with self.lock:  # Decided together with restart(): either it replaces the run or the run ends.
            if worker is not self.worker:
                return
            worker.finished = True
        self.stop_python()
        self.event("exited", {"exitCode": code})
        self.terminate_event()

    def terminate_event(self):
        with self.seq_lock:
            if self.terminated:
                return
            if self.terminate_deferred:
                self.terminate_pending = True  # sent after the disconnect response
                return
            self.terminated = True
        self.event("terminated")

    def finish_deferred_termination(self):
        with self.seq_lock:
            self.terminate_deferred = False
            pending, self.terminate_pending = self.terminate_pending, False
        if pending:
            self.terminate_event()

    def stop_python(self):
        with self.lock:
            python = self.python
        self.end_python(python)

    def end_python(self, python):
        if python is None:
            return
        python.stop()
        if python.announced and not python.ended:
            python.ended = True
            self.event("robotCompanion/pythonSession", {"version": HANDOFF_VERSION, "phase": "end",
                                                       "sessionId": python.session_id})

    def python_session_lost(self, session, detail):
        if self.python is not session:
            return
        self.event("output", {"category": "important", "output": f"Python session ended: {detail}\n"})
        # Leave the reader before centralized cleanup joins it. Use the same
        # bounded TERM -> KILL/reap path even if library code ignores SIGTERM.
        self.cleanup_thread = threading.Thread(target=self.stop_worker, daemon=True)
        self.cleanup_thread.start()

    def connect_python(self, session, address):
        worker = self.worker
        if self.python is not session or worker is None:
            raise ProtocolError("Python handoff has no owning Robot worker")
        try:
            worker.send({"command": "connectPython", "version": HANDOFF_VERSION,
                         "sessionId": session.session_id, **address})
        except RequestError as exc:
            raise ProtocolError(str(exc)) from exc

    def python_connected(self, body):
        if self.python is not None and body.get("sessionId") == self.python.session_id:
            if type(body.get("version")) is not int or body["version"] != HANDOFF_VERSION \
                    or type(body.get("debuggeeProcessId")) is not int \
                    or self.worker is None or body["debuggeeProcessId"] != self.worker.interpreter_pid:
                detail = "Python connection identity does not match the authenticated Robot worker"
                self.python_session_lost(self.python, detail)
                raise ProtocolError(detail)
            self.python.connected = True

    def stop_worker(self):
        with self.lock:
            worker = self.worker
        # The stop is asked before the Python child ends: a Python-paused keyword then resumes into
        # it, so the run is recorded as stopped by the user, as when Robot is paused.
        if worker is not None:
            worker.request_stop()
        else:
            self.terminate_event()
        self.stop_python()
        if worker is not None:
            worker.stop()

    def end_session(self):
        """A lifecycle failure: stop every owned process and end the session once."""
        self.stop_worker()
        self.terminate_event()

    def start_generation(self, inputs, operation=None):
        """Start one Robot worker (and its Python adapter) for `inputs`; on any failure,
        including cancellation, every process it started is stopped before raising."""
        cancelled = operation.cancelled if operation is not None else None
        python = worker = None
        try:
            if inputs["python"]:
                try:
                    python = PythonSession(self, inputs["cwd"])
                except ValueError as exc:
                    raise RequestError(str(exc)) from exc
                with self.lock:
                    self.python = python
                python.start()
            if operation is not None:
                operation.check()
            with self.lock:
                self.generation += 1
                generation = self.generation
            worker = Worker(self, inputs["targets"], inputs["cwd"], inputs["args"], python is not None,
                            cancelled, generation)
            with self.lock:
                self.worker = worker
            ready = worker.wait_ready()
            if python is not None and (python.lost.is_set() or python.tree.poll() is not None):
                raise RequestError("Python adapter ended before the handoff was ready")
            if operation is not None:
                operation.check()
            return ready
        except BaseException:
            with self.lock:
                if worker is not None:
                    worker.retired = True
                if self.worker is worker:
                    self.worker = None
                if self.python is python:
                    self.python = None
            if worker is not None:
                worker.stop()
            self.end_python(python)
            raise

    def announce(self, ready, method):
        worker = self.worker
        self.event("process", {"name": "Robot Framework " + ready.get("robot", ""),
                               "systemProcessId": worker.process.pid, "startMethod": method,
                               "isLocalProcess": True})
        if self.python is not None:
            self.python.announced = True
            self.event("robotCompanion/pythonSession", self.python.descriptor(worker.interpreter_pid))

    def launch(self, arguments, operation=None):
        if self.prepared:
            raise RequestError("This prepared session accepts only its own attach request, not launch")
        if self.worker is not None or self.inputs is not None:
            raise RequestError("Only one launch is supported per debug session")
        inputs = launch_inputs(arguments)
        ready = self.start_generation(inputs, operation)
        self.use_inputs(inputs)
        self.ready_message = ready
        self.announce(ready, "launch")
        return None

    def prepare(self, inputs):
        """Start a prepared session's run before any client: it waits before Robot executes."""
        self.ready_message = self.start_generation(inputs)
        self.use_inputs(inputs)

    def attach(self, arguments, operation=None):
        if any(key in arguments for key in EXTERNAL_KEYS):
            raise RequestError(EXTERNAL_ATTACH)
        if not self.prepared:
            raise RequestError(PLAIN_ATTACH)
        if self.attached:
            raise RequestError("This prepared session is already attached")
        worker = self.worker
        if worker is None or worker.tree.poll() is not None:
            self.end_session()  # Nothing is left to attach to; the owned run ends here.
            raise RequestError("The prepared Robot worker is no longer running")
        self.attached = True
        try:
            self.announce(self.ready_message, "attach")
        except BaseException:
            self.end_session()
            raise
        return None

    def restart_inputs(self, arguments):
        inner = arguments.get("arguments")
        if inner is None:
            return dict(self.inputs)
        if not isinstance(inner, dict):
            raise RequestError("restart 'arguments' must be an object")
        if any(key in inner for key in EXTERNAL_KEYS):
            raise RequestError(EXTERNAL_ATTACH)
        if self.prepared and not any(key in inner for key in ("target", "cwd", "args", "pythonDebug")):
            return dict(self.inputs)  # The client echoed its attach configuration.
        candidate = launch_inputs(inner)
        if not same_run(candidate, self.inputs):
            raise RequestError(RESTART_CHANGED)
        return candidate

    def use_inputs(self, inputs):
        self.inputs = inputs
        self.output_folders.append(output_folder(inputs))

    def restartable(self):
        """The current worker, if a restart may still replace it; call with self.lock held."""
        old = self.worker
        with self.seq_lock:  # terminate_event() writes the flag under this lock
            terminated = self.terminated
        if old is None or not self.configured or terminated or old.finished or old.tree.poll() is not None:
            raise RequestError("restart requires a configured Robot run")
        return old

    def restart_output(self, inputs):
        """`inputs` with an output folder no earlier run of this session wrote to. A restart that
        names none (an empty request, a prepared session's echo) gets a new folder below the first
        run's, so the previous output.xml is kept; the new folder or None is returned too."""
        used = {os.path.normcase(folder) for folder in self.output_folders}
        if os.path.normcase(output_folder(inputs)) not in used:
            return inputs, None
        root, attempt = self.output_folders[0], 1
        while True:
            folder = os.path.join(root, f"restart-{len(self.output_folders)}" + (f"-{attempt}" if attempt > 1 else ""))
            try:
                os.makedirs(root, exist_ok=True)
                os.mkdir(folder)
                return {**inputs, "args": [*inputs["args"], "--outputdir", folder]}, folder
            except FileExistsError:
                attempt += 1
            except OSError as exc:
                raise RequestError(f"Cannot create the restarted run's output folder: {exc.strerror or exc}") from None

    def restart(self, arguments, operation):
        with self.lock:
            self.restartable()
        inputs = self.restart_inputs(arguments)  # Refused before the current run changes.
        with self.lock:
            # Checked again as the run is retired: worker_finished() decides under this lock too, so
            # a run that ends naturally meanwhile is either replaced here or ends, never both.
            old = self.restartable()
            inputs, folder = self.restart_output(inputs)
            old_python = self.python
            old.retired = True
            self.worker = self.python = None
            self.configured = self.auto_configured = self.restart_pending = False
        try:
            was_paused = old.paused
            old.request_stop()  # Before the Python child ends, as in stop_worker().
            self.end_python(old_python)
            old.stop()
            with self.lock:
                self.handle_base = self.max_handle + 1
            if was_paused:
                self.event("continued", {"threadId": 1, "allThreadsContinued": True})
            # The client stops tracking the retired run's processes and Python child.
            self.event("robotCompanion/generation", {"version": 1, "retired": old.generation})
            operation.check()
            ready = self.start_generation(inputs, operation)
            self.use_inputs(inputs)
            self.ready_message = ready
            self.announce(ready, "launch" if not self.prepared else "attach")
            if folder is not None:
                self.event("output", {"category": "console", "output": f"Restarted run writes its results to {folder}\n"})
            self.wait_python_configured(operation)
            # Robot runs once the restart is answered (release_restarted_run), so the
            # client sees the response before the new run's first stop.
            self.restart_pending = True
        except BaseException:
            self.end_session()
            raise
        return None

    def release_restarted_run(self):
        with self.lock:
            if not self.restart_pending:
                return
            self.restart_pending = False
            try:
                self.configure()
                self.auto_configured = True
            except RequestError:
                failed = True
            else:
                failed = False
        if failed:
            self.end_session()

    def wait_python_configured(self, operation):
        """The restarted run's Python child must attach and configure before Robot runs."""
        python = self.python
        if python is None:
            return
        deadline = time.monotonic() + READY_TIMEOUT
        while not (python.connected and python.configured):
            operation.check()
            if python.lost.is_set() or python.tree.poll() is not None:
                raise RequestError("The Python child session ended before the restarted run was configured")
            if time.monotonic() >= deadline:
                raise RequestError(f"The Python child session was not configured within {READY_TIMEOUT} s of restart")
            time.sleep(POLL_INTERVAL)

    def configure(self):
        self.worker.send({"command": "configurationDone", "breakpoints": self.breakpoints,
                          "handleBase": self.handle_base})
        self.configured = True

    def cancel(self, arguments):
        request_id = arguments.get("requestId")
        if request_id is not None and type(request_id) is not int:
            raise RequestError("cancel 'requestId' must be an integer")
        operation = self.operation
        # Unknown, finished and progress-only cancellations are harmless no-ops.
        if operation is not None and request_id == operation.seq:
            operation.cancelled.set()
        return None

    def cancel_operation(self):
        operation = self.operation
        if operation is None:
            return
        operation.cancelled.set()
        if operation.thread is not None and operation.thread is not threading.current_thread():
            operation.thread.join(timeout=STOP_TIMEOUT * 3)

    def track_handles(self, body):
        if not isinstance(body, dict):
            return
        found = [body.get("variablesReference")]
        for key, field in (("stackFrames", "id"), ("scopes", "variablesReference"),
                           ("variables", "variablesReference")):
            found.extend(item.get(field) for item in body.get(key) or [] if isinstance(item, dict))
        with self.lock:
            self.max_handle = max([self.max_handle, *(value for value in found if type(value) is int)])

    def set_breakpoints(self, arguments):
        source = arguments.get("source", {})
        if not isinstance(source, dict):
            raise RequestError("setBreakpoints requires source.path")
        path = source.get("path")
        if not isinstance(path, str) or not path:
            raise RequestError("setBreakpoints requires source.path")
        if self.configured or self.auto_configured:
            raise RequestError("Changing breakpoints after configurationDone is not supported at this checkpoint")
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
        result, stored = [], []
        for requested_breakpoint in requested:
            self.next_breakpoint += 1
            # Expressions are checked with RF in the worker and evaluated on its Robot thread.
            stored.append({"id": self.next_breakpoint, "line": requested_breakpoint["line"],
                           **{k: requested_breakpoint[k] for k in ("condition", "logMessage")
                              if k in requested_breakpoint}})
            result.append({"id": self.next_breakpoint, "verified": False, "line": requested_breakpoint["line"],
                           "source": {"path": path}, "message": PENDING_BREAKPOINT})
        self.breakpoints[path] = stored
        return {"breakpoints": result}

    def dispatch(self, command, arguments, operation=None):
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
            return self.launch(arguments, operation)
        if command == "attach":
            return self.attach(arguments, operation)
        if command == "restart":
            return self.restart(arguments, operation)
        if command == "cancel":
            return self.cancel(arguments)
        if command == "setBreakpoints":
            return self.set_breakpoints(arguments)
        if command == "configurationDone":
            with self.lock:
                if self.auto_configured or self.restart_pending:
                    return None  # A restart configures this run itself; nothing runs twice.
            if self.worker is None or self.configured or (self.prepared and not self.attached):
                raise RequestError("configurationDone requires one prior successful launch")
            if self.python is not None and not self.python.connected:
                raise RequestError("Configure the Python child attach session before Robot configurationDone")
            self.configure()
            return None
        if command in PAUSED_REQUESTS:
            worker = self.worker
            for key in ("frameId", "variablesReference"):
                if type(arguments.get(key)) is int and 0 < arguments[key] < self.handle_base:
                    raise RequestError(STALE_HANDLE)
            if worker is None:
                raise RequestError("Robot worker is not paused")
            body = worker.request(command, arguments)
            self.track_handles(body)
            return body
        if command == "threads":
            running = self.worker is not None and self.worker.tree.poll() is None
            return {"threads": [{"id": 1, "name": "Robot Framework"}] if running else []}
        if command == "terminate":
            self.cancel_operation()
            self.stop_worker()
            return None
        if command == "disconnect":
            with self.seq_lock:
                self.terminate_deferred = True
            self.cancel_operation()
            self.stop_worker()
            if arguments.get("terminateDebuggee") is False:
                raise RequestError(NO_DETACH)
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

    def answer(self, request, command, arguments, operation=None):
        """Dispatch one request and send its single response; True if it succeeded."""
        try:
            body = self.dispatch(command, arguments, operation)
        except (RequestError, OSError) as exc:
            self.respond(request, False, message=str(exc))
            return False
        except Exception as exc:
            print(f"Debug request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            self.respond(request, False, message="Internal backend error; see stderr")
            return False
        self.respond(request, True, body)
        return True

    def _operate(self, operation, arguments):
        try:
            if self.answer(operation.request, operation.command, arguments, operation):
                if operation.command in ("launch", "attach"):
                    self.event("initialized")
                elif operation.command == "restart":
                    self.release_restarted_run()
        finally:
            with self.lock:
                if self.operation is operation:
                    self.operation = None

    def run(self):
        try:
            code = self._serve()
        finally:
            self.cancel_operation()
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
            if command in LIFECYCLE and self.initialized:
                with self.lock:
                    busy = self.operation
                    if busy is None:
                        self.operation = operation = Operation(message)
                if busy is not None:
                    self.respond(message, False, message=f"Robot debug session is busy: {busy.command} in progress")
                    continue
                operation.thread = threading.Thread(target=self._operate, args=(operation, arguments), daemon=True)
                operation.thread.start()
                continue
            self.answer(message, command, arguments)
            if command == "disconnect":
                self.finish_deferred_termination()
                return 0


def serve(reader, writer):
    return DebugAdapter(FramedStream(reader, writer)).run()

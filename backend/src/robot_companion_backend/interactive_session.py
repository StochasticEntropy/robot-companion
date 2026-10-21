"""The Robot side of one interactive session: cells run as real RF body steps.

The worker (interactive_worker.py) runs one generated Robot test whose only step is this
library's `Run Robot Companion Session` keyword. That keyword serves cells on the Robot
execution thread until the session stops, so every cell runs in a live RF execution context:
the test's variable scope, the imported libraries and resources and the RF logger. Variables
assigned in one cell stay set for the next.

A cell is either steps (keyword calls with assignments, VAR, IF, FOR, TRY, ...) or
definitions (`*** Keywords ***`, `*** Variables ***`, `*** Settings ***` sections). Steps are
parsed with RF's parser as the body of a test and run with RF's own runners. Definitions are
written to a session-owned resource file and imported with BuiltIn's Import Resource; a
keyword defined again replaces the earlier session definition of that name.

Interrupt raises `Interrupted` on the Robot thread with PyThreadState_SetAsyncExc, the call RF
itself uses for keyword timeouts on Windows. It is an RF failure that `Run Keyword And Ignore
Error`, `TRY`/`EXCEPT` and retry keywords do not catch; a cell whose code swallows it anyway is
still reported as interrupted and its remaining steps do not run. A keyword blocked in native
code does not see it: the owning service then ends the worker (see interactive.py).

The RF internals used here (running-model `run(result, context)`, `EXECUTION_CONTEXTS`, the
namespace keyword store) are identical in RF 7.3.2 and RF 7.5; both rows run
test_interactive_live.
"""

import ctypes
import io
import os
from pathlib import Path
import queue
import re
import signal
import sys
import threading

from robot.api import get_model
from robot.api.deco import keyword
from robot.errors import ExecutionFailed, ExecutionPassed
from robot.libraries.BuiltIn import BuiltIn
from robot.running import TestSuite
from robot.running.context import EXECUTION_CONTEXTS
from robot.utils import normalize

# Displayed values and reported errors stay far below the 8 MiB frame limit.
VALUE_LIMIT = 4096
OUTPUT_CHUNK = 65536
TRUNCATED = "... [truncated]"
SESSION_KEYWORD = "Run Robot Companion Session"
CELL_TEST = "Robot Companion Cell"
SECTION = re.compile(r"^\*+\s*(settings?|variables?|keywords?|comments?|test cases?|tasks?)\b", re.I | re.M)
TEST_SECTION = re.compile(r"^\*+\s*(test cases?|tasks?)\b", re.I | re.M)

# The session the worker serves; set by the worker before RF imports this library.
ACTIVE = None


class Interrupted(ExecutionFailed):
    """Raised on the Robot thread by Interrupt. `exit` and `syntax` make it an error that
    RF's TRY/EXCEPT, Run Keyword And Ignore Error and retry keywords never catch."""

    def __init__(self, message="Interrupted"):
        super().__init__(message, exit=True, syntax=True)


class CellError(Exception):
    pass


def bounded(text, limit=VALUE_LIMIT):
    return text if len(text) <= limit else text[:limit] + TRUNCATED


def display(value):
    try:
        return bounded(repr(value))
    except Exception:
        return "<unrepresentable value>"


class CellStream(io.TextIOBase):
    """sys.stdout/sys.stderr (and sys.__stdout__/__stderr__, which Log To Console writes to)
    of the worker: text is sent to the service tagged with the running cell. The original
    file descriptor stays available to code that writes to it directly."""

    def __init__(self, session, category, original):
        super().__init__()
        self.session = session
        self.category = category
        self.original = original

    @property
    def encoding(self):
        return "utf-8"

    @property
    def errors(self):
        return "replace"

    def writable(self):
        return True

    def isatty(self):
        return False

    def fileno(self):
        return self.original.fileno()

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        self.session.output(self.category, text)
        return len(text)

    def flush(self):
        pass


class Session:
    def __init__(self, control, events, session_dir):
        self.control = control
        self.events = events
        self.session_dir = Path(session_dir)
        self.inbox = queue.Queue()
        self.lock = threading.Lock()
        self.running = None  # id of the cell running on the Robot thread
        self.interrupted = False
        self.thread_id = None
        self.definitions = []  # resource paths of definition cells, oldest first
        self.counter = 0
        self.languages = None
        self.applied = {}
        self.ignored = []
        self.initial = set()
        self.serving = False
        self.ready = None
        self.warnings = []  # RF errors and warnings logged before the session served
        self.reader = threading.Thread(target=self._read, daemon=True)

    # Messages to the service.
    def emit(self, message):
        self.events.write(message)

    def output(self, category, text, **extra):
        cell = self.running
        for start in range(0, len(text), OUTPUT_CHUNK) if text else ():
            self.emit({"event": "output", "body": {"id": cell, "category": category,
                                                   "output": text[start:start + OUTPUT_CHUNK], **extra}})

    def notice(self, level, text):
        """An RF error or warning logged before the session serves is part of the start answer.
        Later ones are a keyword's own log messages (forwarded already) or fail its cell."""
        if not self.serving:
            self.warnings.append(f"[ {level} ] {bounded(text)}")

    def redirect_output(self):
        sys.stdout = sys.__stdout__ = CellStream(self, "stdout", sys.__stdout__)
        sys.stderr = sys.__stderr__ = CellStream(self, "stderr", sys.__stderr__)

    # Control messages from the service: Interrupt is handled on this reader thread,
    # everything else on the Robot thread.
    def start_reader(self):
        self.reader.start()

    def _read(self):
        try:
            while (message := self.control.read()) is not None:
                if message.get("command") == "interrupt":
                    self.interrupt(message.get("id"))
                else:
                    self.inbox.put(message)
        except (OSError, ValueError):
            pass
        # The service is gone: end a running cell and the session.
        self.interrupt(None)
        self.inbox.put(None)

    def interrupt(self, cell):
        with self.lock:
            if self.running is None or (cell is not None and cell != self.running):
                return False
            self.interrupted = True
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(self.thread_id), ctypes.py_object(Interrupted))
            return True

    def _leave(self):
        """End the running cell; a pending Interrupt can no longer be raised after this."""
        while True:
            try:
                with self.lock:
                    self.running = None
                    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(self.thread_id), None)
                return
            except Interrupted:
                self.interrupted = True

    # The Robot thread.
    def serve(self):
        if self.serving:
            raise RuntimeError(f"'{SESSION_KEYWORD}' is already serving this session")
        self.serving = True
        context = EXECUTION_CONTEXTS.current
        self.thread_id = threading.get_ident()
        if hasattr(signal, "SIGTERM") and threading.current_thread() is threading.main_thread():
            # The service ends a worker with SIGTERM only after a graceful stop or Interrupt failed;
            # RF's own handler would turn it into a keyword failure and keep the session serving.
            signal.signal(signal.SIGTERM, lambda signum, frame: os._exit(128 + signum))
        self.initial = set(BuiltIn().get_variables())
        self.emit({"event": "ready", **self.ready, "warnings": self.warnings, "processId": os.getpid(),
                   "cwd": os.getcwd()})
        while True:
            message = self.inbox.get()
            if message is None or message.get("command") == "stop":
                return
            if message.get("command") == "execute":
                self.emit({"event": "result", "requestId": message.get("requestId"),
                           "body": self.execute(context, message)})
            elif message.get("command") == "variables":
                self.emit({"event": "result", "requestId": message.get("requestId"),
                           "body": {"variables": self.variables()}})
            else:
                self.emit({"event": "result", "requestId": message.get("requestId"),
                           "error": f"Unknown session command: {message.get('command')}"})

    def parse(self, code):
        """(steps, definitions text): one of them is empty."""
        if not isinstance(code, str):
            raise CellError("A cell must be text")
        # `${CURDIR}` is the directory of a Robot file; a cell has none. It means the session's
        # working directory (`${EXECDIR}`), the workspace folder.
        code = code.replace("${CURDIR}", "${EXECDIR}")
        if SECTION.search(code):
            if TEST_SECTION.search(code):
                raise CellError("A session cell cannot define tests or tasks; write their steps as the cell")
            return [], code
        lines = "".join(("    " + line if line.strip() else "") + "\n" for line in code.splitlines())
        model = get_model(io.StringIO(f"*** Test Cases ***\n{CELL_TEST}\n{lines}"), lang=self.languages)
        suite = TestSuite.from_model(model)
        return (list(suite.tests[0].body) if suite.tests else []), ""

    def define(self, text):
        self.counter += 1
        path = self.session_dir / f"cell-{self.counter}.resource"
        path.write_text(text, encoding="utf-8")
        # Import Resource replaces variables in its argument: a POSIX-style path has no escapes.
        BuiltIn().import_resource(path.as_posix())
        store = getattr(getattr(EXECUTION_CONTEXTS.current.namespace, "_kw_store", None), "resources", None)
        if store is None or path.as_posix() not in store:
            raise CellError("This Robot Framework version does not expose imported session resources")
        resource = store[path.as_posix()]
        names = {normalize(kw.name, ignore="_") for kw in resource.keywords}
        for earlier in self.definitions:
            previous = store[earlier]
            kept = [kw for kw in previous.keywords if normalize(kw.name, ignore="_") not in names]
            if len(kept) != len(previous.keywords):
                previous.keywords = kept
        self.definitions.append(path.as_posix())
        variables = [variable.name for variable in resource.variables]
        return [{"label": "Defined", "value": ", ".join(kw.name for kw in resource.keywords) or "no keywords",
                 "type": "keywords"}] + ([{"label": "Set", "value": ", ".join(variables), "type": "variables"}]
                                         if variables else [])

    def values(self, item, value):
        """What a top-level step shows: a returned value or the variables it set."""
        builtin = BuiltIn()
        if type(item).__name__ == "Var":
            names = [item.name]
        else:
            names = [name.rstrip("= ").strip() for name in getattr(item, "assign", ()) or ()]
            if not names:
                return [] if value is None or type(item).__name__ != "Keyword" else \
                    [{"label": None, "value": display(value), "type": type(value).__name__}]
        shown = []
        for name in names:
            if not re.fullmatch(r"[$@&]\{[^{}\[\]]+\}", name):
                continue  # item assignment such as ${d}[key]=
            try:
                current = builtin.get_variable_value(name)
            except Exception:
                continue
            shown.append({"label": name, "value": display(current), "type": type(current).__name__})
        return shown

    def execute(self, context, message):
        cell, code = message.get("id"), message.get("code")
        result = {"id": cell, "status": "PASS", "message": "", "values": []}
        try:
            steps, definitions = self.parse(code)
        except Exception as exc:
            return {**result, "status": "FAIL", "message": bounded(str(exc) or type(exc).__name__)}
        parent = context.steps[-1][1]  # this keyword's result: cells add their steps below it
        depth = len(context.steps)
        with self.lock:
            self.running = cell
            self.interrupted = False
        try:
            try:
                if definitions:
                    result["values"] = self.define(definitions)
                for item in steps:
                    value = item.run(parent, context)
                    if self.interrupted:  # code that caught the interrupt still ends the cell
                        raise Interrupted()
                    result["values"].extend(self.values(item, value))
            finally:
                self._leave()
        except Interrupted:
            self.interrupted = True
        except ExecutionPassed as passed:
            result["message"] = bounded(passed.message or "")
        except ExecutionFailed as failure:
            result.update(status="SKIP" if failure.skip else "FAIL", message=bounded(failure.message))
        except CellError as exc:
            result.update(status="FAIL", message=bounded(str(exc)))
        except Exception as exc:  # RF data errors outside a step, such as an invalid resource
            result.update(status="FAIL", message=bounded(getattr(exc, "message", None) or str(exc)
                                                         or type(exc).__name__))
        finally:
            # A failed cell does not fail later cells; nothing is kept for an output file.
            del context.steps[depth:]
            if context.test is not None:
                context.test.status, context.test.message = "PASS", ""
            parent.body.clear()
        if self.interrupted:
            result.update(status="INTERRUPTED", message="Interrupted", values=[])
        return result

    def variables(self):
        variables = BuiltIn().get_variables()
        return [{"name": name, "value": display(value), "type": type(value).__name__,
                 "origin": "session" if name in self.initial else "cells"}
                for name, value in sorted(variables.items(), key=lambda item: item[0].lower())]


class SessionLibrary:
    """Library of the generated session test; serves ACTIVE on the Robot thread."""

    ROBOT_LIBRARY_SCOPE = "GLOBAL"
    ROBOT_AUTO_KEYWORDS = False

    @keyword(SESSION_KEYWORD)
    def run_robot_companion_session(self):
        if ACTIVE is None:
            raise RuntimeError(f"'{SESSION_KEYWORD}' runs only in a Robot Companion session worker")
        ACTIVE.serve()

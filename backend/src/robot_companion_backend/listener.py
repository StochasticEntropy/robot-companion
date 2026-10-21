"""Experimental RF listener: commands execute on the paused Robot thread.

The listener API v3 calls, `evaluate_expression`, `_decorate_variables`, the variable
scopes and `BuiltIn.run_keyword` it uses behave identically in RF 7.3.2 and RF 7.5
(checked against both releases' sources); both rows run the same live DAP suites.

Imported only inside the owned worker after the RF prerequisite check. No Python
expression evaluator and no secondary Robot execution are used for the console.
Breakpoint conditions and logpoint interpolations use RF's own IF/WHILE condition
evaluation in the current Robot variable context on this thread. A hit count is checked
before the condition, so a condition is evaluated only on matching hits.

Failure filters stop on Robot Framework results, never on Python exceptions: a keyword
whose `end_keyword` status is FAIL (also when TRY/EXCEPT or `Run Keyword And Ignore
Error` handles it, and again for each enclosing keyword it fails), and a test or task
whose final status after teardown is FAIL. RF has already decided the result, so these
stops only allow read-only inspection.

At an ordinary pause the current frame's scope accepts `setVariable` for an existing
`${scalar}` whose value is a str, int, finite float, bool or None. The new value is one
strict JSON scalar, decoded once (no Robot substitution, no evaluation) and written with
RF's `set_local` into the currently active RF variable scope, so it shadows the variable
until that scope ends and never changes suite or global values. Variables set by Robot
Framework itself or on the command line are read-only.
"""

import io
import json
import math
from pathlib import Path

from robot.api import get_model
from robot.api.parsing import ModelVisitor
from robot.libraries.BuiltIn import BuiltIn
from robot.running.context import EXECUTION_CONTEXTS
from robot.utils import normalize
from robot.variables import evaluate_expression
from robot.variables.evaluation import _decorate_variables
from robot.variables.search import contains_variable, search_variable


# Rendered logpoint messages and reported errors are bounded to stay far below the
# 8 MiB event frame limit.
LOG_LIMIT = 65536
ERROR_LIMIT = 4096
TRUNCATED = "... [truncated]"
FAILURE_LABELS = {"robot-failed-keyword": "failed keyword", "robot-failed-test": "failed test/task"}
READ_ONLY_FAILURE = ("Robot Framework has already recorded this failure, so this stop is read-only: "
                     "keywords cannot run here. Continue, or set a breakpoint before the failing call.")
EDITABLE_SCOPE = "Robot visible variables (edit current scope)"
FAILURE_SCOPE = "Robot visible variables after failure (read-only)"
EXPIRED_EDIT = "Execution has continued. Pause again and select the variable to edit it."
VALUE_FORMAT = ('Use one JSON value: a quoted string such as "text", a number, true, false or null. '
                "The value was not changed.")
VALUE_BYTES = 65536
INTEGER_LIMIT = 9007199254740991  # exact in JavaScript clients
EDITABLE_TYPES = (str, int, float, bool, type(None))
MISSING = object()
# Robot Framework's automatic variables (normalized), the same in RF 7.3.2 and 7.5. Any other
# name already in RF's global store when the run starts (set by RF or the command line) is
# also read-only, so an automatic variable unknown to this list is never editable.
AUTOMATIC = frozenset(normalize(name, ignore="_") for name in (
    "CURDIR", "TEMPDIR", "EXECDIR", "/", ":", "\\n", "SPACE", "EMPTY", "True", "False", "None", "null",
    "OPTIONS", "OUTPUT_DIR", "OUTPUT_FILE", "REPORT_FILE", "LOG_FILE", "DEBUG_FILE", "LOG_LEVEL",
    "PREV_TEST_NAME", "PREV_TEST_STATUS", "PREV_TEST_MESSAGE", "SUITE_NAME", "SUITE_SOURCE",
    "SUITE_DOCUMENTATION", "SUITE_METADATA", "SUITE_STATUS", "SUITE_MESSAGE", "TEST_NAME",
    "TEST_DOCUMENTATION", "TEST_TAGS", "TEST_METADATA", "TEST_STATUS", "TEST_MESSAGE", "KEYWORD_STATUS",
    "KEYWORD_MESSAGE"))


class DebugError(Exception):
    pass


def bounded(text, limit):
    return text if len(text) <= limit else text[:limit] + TRUNCATED


def error_text(exc):
    return bounded(" ".join(str(exc).split()) or type(exc).__name__, ERROR_LIMIT)


class Calls(ModelVisitor):
    def __init__(self):
        self.calls = []

    def visit_KeywordCall(self, node):
        self.calls.append(node)


class AnyName:
    """Variable store stand-in for a syntax-only check: every `$name` is known."""

    def __contains__(self, name):
        return True


def check_expression(expression, kind):
    """Reject an empty or syntactically invalid RF expression before the run.

    `${name}`, `@{name}`, `&{name}` and `%{NAME}` items are replaced with their values
    at evaluation time, so an expression containing them is checked only when evaluated.
    """
    if not expression.strip():
        raise DebugError(f"{kind} is empty")
    if contains_variable(expression, "$@&%"):
        return
    try:
        compile(_decorate_variables(expression.strip(), AnyName()), "<breakpoint>", "eval")
    except Exception as exc:  # SyntaxError, TokenError, ValueError; RecursionError for deep nesting
        raise DebugError(f"{kind} is not a valid RF expression: {error_text(exc)}") from None


def parse_log_message(message):
    """Split a logpoint message into literal text, `{expression}` and RF variable parts.

    `{{` and `}}` are literal braces. An expression ends at its matching brace.
    """
    if not message:
        raise DebugError("Log message is empty")
    parts, text, index = [], [], 0
    while index < len(message):
        char = message[index]
        if message.startswith(("{{", "}}"), index):
            text.append(char)
            index += 2
        elif char in "$@&%" and message.startswith("{", index + 1) and not message.startswith("{{", index + 1):
            match = search_variable(message[index:], identifiers="$@&%", ignore_errors=True)
            if match.start != 0:
                raise DebugError(f"Log message has an unclosed variable at offset {index}")
            parts.extend([("text", "".join(text)), ("variable", match.match)])
            text, index = [], index + match.end
        elif char == "{":
            depth, end = 0, index
            while end < len(message):
                depth += {"{": 1, "}": -1}.get(message[end], 0)
                if depth == 0:
                    break
                end += 1
            if end == len(message):
                raise DebugError(f"Log message has an unclosed '{{' at offset {index}; write '{{{{' for a brace")
            expression = message[index + 1:end]
            check_expression(expression, "Log message expression")
            parts.extend([("text", "".join(text)), ("expression", expression)])
            text, index = [], end + 1
        elif char == "}":
            raise DebugError(f"Log message has an unmatched '}}' at offset {index}; write '}}}}' for a brace")
        else:
            text.append(char)
            index += 1
    parts.append(("text", "".join(text)))
    return [part for part in parts if part != ("text", "")]


def scalar_base(name):
    """The base of a plain `${name}` reference, or None for any other form.

    Lists, dicts, environment variables, items (`${x}[0]`), extended (`${x.y}`), nested,
    inline Python (`${{...}}`) and typed (`${x: int}`) names are not plain scalars.
    """
    if not isinstance(name, str) or not name.startswith("${") or not name.endswith("}"):
        return None
    base = name[2:-1]
    if not base.strip() or any(c in base for c in "${}[].:=@&%") or base != base.strip():
        return None
    return base


def json_scalar(text):
    """One strict JSON scalar as an RF value, or DebugError; nothing is substituted or evaluated."""
    if not isinstance(text, str):
        raise DebugError(f"Cannot change this value. {VALUE_FORMAT}")
    if len(text.encode("utf-8", "surrogatepass")) > VALUE_BYTES:
        raise DebugError(f"Cannot change this value: it must be at most {VALUE_BYTES} bytes. {VALUE_FORMAT}")

    def refuse(constant):
        raise ValueError(constant)

    try:
        value = json.loads(text, parse_constant=refuse)
    except (ValueError, RecursionError):
        raise DebugError(f"Cannot change this value. {VALUE_FORMAT}") from None
    if isinstance(value, (list, dict)):
        raise DebugError(f"Cannot change this value: lists and dictionaries are not supported. {VALUE_FORMAT}")
    if isinstance(value, float) and not math.isfinite(value):
        raise DebugError(f"Cannot change this value: numbers must be finite. {VALUE_FORMAT}")
    if type(value) is int and abs(value) > INTEGER_LIMIT:
        raise DebugError(f"Cannot change this value: whole numbers must be between -{INTEGER_LIMIT} and "
                         f"{INTEGER_LIMIT}. {VALUE_FORMAT}")
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise DebugError(f"Cannot change this value: it contains an unpaired surrogate. {VALUE_FORMAT}") from None
    return value


def hit_met(bp):
    """The adapter's parsed `hitCondition` against this breakpoint's encounters in this run."""
    if "hit" not in bp:
        return True
    operator, count = bp["hit"]
    if operator == "%":
        return bp["count"] % count == 0
    return bp["count"] >= count if operator == ">=" else bp["count"] == count


class RobotListener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self, commands, events, breakpoints, failure_filters=(), filter_revision=0):
        self.commands = commands
        self.events = events
        self.breakpoints = breakpoints
        self.failure_filters = set(failure_filters)
        self.filter_revision = filter_revision
        self.failure = None  # the failure stop being inspected, if any
        self.closed = False
        self.scopes = {}  # variablesReference -> the live RF scope it shows, for this pause only
        self.automatic = None  # normalized names in RF's global store when the run started
        self.editing = False
        self.stack = []
        self.calls = []
        self.frames = {}
        self.values = {}
        self.next_handle = 0
        self.step = None
        self.evaluating = False
        self.verify_breakpoints()

    def emit(self, event, body):
        self.events.write({"event": event, "body": body})

    def verify_breakpoints(self):
        for path, requested in self.breakpoints.items():
            lines = set()
            detail = "No executable Robot keyword call at this line"
            try:
                visitor = Calls()
                visitor.visit(get_model(path))
                lines = {call.lineno for call in visitor.calls if not call.errors}
            except (OSError, ValueError) as exc:
                detail = str(exc)
            for bp in requested:
                message = None if bp["line"] in lines else detail
                try:
                    if message is None and "condition" in bp:
                        check_expression(bp["condition"], "Breakpoint condition")
                    if message is None and "logMessage" in bp:
                        bp["parts"] = parse_log_message(bp["logMessage"])
                except DebugError as exc:
                    message = str(exc)
                bp["verified"] = message is None
                body = {"id": bp["id"], "verified": bp["verified"], "line": bp["line"], "source": {"path": path}}
                if message is not None:
                    body["message"] = message
                self.emit("breakpoint", {"reason": "changed", "breakpoint": body})

    def frame(self, data, result):
        source = getattr(data, "source", None) or getattr(result, "source", None)
        return {"name": str(getattr(result, "name", None) or getattr(data, "name", "Robot")),
                "source": {"path": str(Path(source).resolve())} if source else None,
                "line": getattr(data, "lineno", None) or 1, "column": 1}

    def apply(self, message):
        """Apply a queued failure filter change, in revision order; report what now applies."""
        self.failure_filters = set(message["filters"])
        self.filter_revision = message["revision"]
        names = ", ".join(FAILURE_LABELS[f] for f in FAILURE_LABELS if f in self.failure_filters) or "none"
        self.emit("robotCompanion/failureFilters", {"revision": self.filter_revision,
                                                    "filters": sorted(self.failure_filters)})
        self.emit("output", {"category": "console",
                             "output": f"Robot failure stops now ({names}), revision {self.filter_revision}\n"})

    def drain(self):
        """Apply filter changes queued while running, before this callback decides on a stop."""
        for message in self.commands.pending():
            if message is None:
                self.closed = True
            elif message.get("command") == "failureFilters":
                self.apply(message)
            else:
                self.reply(message, error="Robot worker is not paused")

    def start_suite(self, data, result):
        if self.automatic is None:
            store = getattr(EXECUTION_CONTEXTS.current.variables, "_global", None)
            # Without RF's global store no value is editable (fail closed).
            self.automatic = frozenset() if store is None else frozenset(
                normalize(name[2:-1], ignore="_") for name in store.as_dict())
            self.editing = store is not None

    def start_test(self, data, result):
        self.drain()
        self.stack.append(self.frame(data, result))

    def end_test(self, data, result):
        self.drain()
        if "robot-failed-test" in self.failure_filters and result.status == "FAIL":
            kind = "task" if getattr(result.parent, "rpa", False) else "test"
            self.pause("exception", [], self.failure_details(
                f"failed {kind} (final outcome)",
                f"Robot {kind} '{result.name}' failed (final outcome, after teardown)", result))
        self.stack.pop()

    def failure_details(self, phase, summary, result):
        frame = self.stack[-1]
        where = f" at {Path(frame['source']['path']).name}:{frame['line']}" if frame["source"] else ""
        return {"phase": phase, "description": f"Robot failure: {phase}",
                "text": bounded(f"{summary}{where}: {result.message}", ERROR_LIMIT)}

    def start_keyword(self, data, result):
        if self.evaluating:
            return
        self.drain()
        frame = self.frame(data, result)
        self.stack.append(frame)
        path = (frame["source"] or {}).get("path")
        self.calls.append(data)
        # BuiltIn's `Run Keyword` family runs its inner keyword with the caller's step as
        # parent and the same line: only that caller evaluates conditions, logs and stops.
        # A recursive call is a body step of its user keyword and still counts. RF also
        # reports keywords of a branch it does not run (NOT RUN); they never hit.
        nested = len(self.calls) > 1 and getattr(data, "parent", None) is self.calls[-2]
        hits = []
        for bp in ([] if nested or getattr(result, "not_run", False) else self.breakpoints.get(path, [])):
            if not bp.get("verified") or bp["line"] != frame["line"]:
                continue
            # Every eligible encounter counts, before the hit count and then the condition decide.
            bp["count"] = bp.get("count", 0) + 1
            if not hit_met(bp) or not self.condition_met(bp, frame):
                continue
            if "parts" in bp:
                self.emit("output", {"category": "console", "source": frame["source"], "line": frame["line"],
                                     "output": bounded(self.render(bp["parts"]), LOG_LIMIT) + "\n"})
            else:
                hits.append(bp["id"])
        stepping = self.step and (self.step[0] == "stepIn" or len(self.stack) <= self.step[1])
        if hits or stepping:
            self.pause("breakpoint" if hits else "step", hits)

    def evaluate(self, expression, variable=False):
        """RF IF/WHILE condition semantics in the current Robot variable context.

        Runs on the Robot execution thread with recursive debug stops suppressed.
        """
        variables = EXECUTION_CONTEXTS.current.variables.current
        self.evaluating = True
        try:
            if variable:
                return variables.replace_scalar(expression)
            return evaluate_expression(expression, variables, resolve_variables=True)
        finally:
            self.evaluating = False

    def condition_met(self, bp, frame):
        if "condition" not in bp:
            return True
        try:
            return bool(self.evaluate(bp["condition"]))
        except Exception as exc:
            # Deterministic disposition: report and treat the hit as not met (never stop).
            self.emit("output", {"category": "important", "source": frame["source"], "line": frame["line"],
                                 "output": f"Breakpoint {bp['id']} condition error at "
                                           f"{Path(frame['source']['path']).name}:{frame['line']}: "
                                           f"{error_text(exc)}; not stopping\n"})
            return False

    def render(self, parts):
        rendered = []
        for kind, value in parts:
            if kind == "text":
                rendered.append(value)
                continue
            try:
                rendered.append(str(self.evaluate(value, variable=kind == "variable")))
            except Exception as exc:
                rendered.append(f"<error: {error_text(exc)}>")
        return "".join(rendered)

    def end_keyword(self, data, result):
        if self.evaluating:
            return
        self.drain()
        # Every failed keyword stops, including the inner keyword of a `Run Keyword` wrapper:
        # its failure may be handled by the wrapper, which then passes.
        if "robot-failed-keyword" in self.failure_filters and result.status == "FAIL":
            self.pause("exception", [], self.failure_details(
                "failed keyword", f"Robot keyword '{result.name}' failed", result))
        self.stack.pop()
        self.calls.pop()

    def handle(self, collection, value):
        self.next_handle += 1
        collection[self.next_handle] = value
        return self.next_handle

    def invalidate(self):
        self.frames.clear()
        self.values.clear()
        self.scopes.clear()

    def pause(self, reason, hits, failure=None):
        self.invalidate()
        self.step = None
        self.failure = failure
        frames = []
        for index in reversed(range(len(self.stack))):
            frame = {**self.stack[index], "id": self.handle(self.frames, index)}
            if frame["source"] is None:
                del frame["source"]
            frames.append(frame)
        stopped = {"reason": reason, "threadId": 1, "allThreadsStopped": True, "hitBreakpointIds": hits}
        if failure:
            if failure["phase"].endswith("(final outcome)"):
                frames[0]["name"] += " (final outcome: FAIL)"
            stopped.update(description=failure["description"], text=failure["text"])
        self.emit("stopped", stopped)
        try:
            while True:
                request = None if self.closed else self.commands.get()
                if request is None:
                    raise SystemExit(4)
                command = request.get("command")
                if command == "failureFilters":
                    self.apply(request)
                    continue
                try:
                    arguments = request.get("arguments", {})
                    if command in ("continue", "next", "stepIn"):
                        if arguments.get("threadId", 1) != 1:
                            raise DebugError("Unknown Robot thread")
                        self.step = None if command == "continue" else (command, len(self.stack))
                        self.invalidate()
                        self.reply(request, {"allThreadsContinued": True} if command == "continue" else {})
                        self.emit("continued", {"threadId": 1, "allThreadsContinued": True})
                        return
                    self.reply(request, self.dispatch(command, arguments, frames))
                except (DebugError, ValueError, TypeError, KeyError) as exc:
                    self.reply(request, error=str(exc))
        finally:
            self.failure = None

    def reply(self, request, body=None, error=None):
        self.events.write({"requestId": request.get("requestId"), "body": body, "error": error,
                           "resumed": error is None and request.get("command") in ("continue", "next", "stepIn")})

    def current_frame(self, frame_id):
        if frame_id not in self.frames:
            raise DebugError("Stale or unknown Robot frame handle")
        if self.frames[frame_id] != len(self.stack) - 1:
            raise DebugError("Only the current Robot frame exposes live scopes and console evaluation")

    def reference(self, value):
        if isinstance(value, (dict, list, tuple)) or hasattr(value, "__dict__"):
            return self.handle(self.values, value)
        return 0

    def display(self, value):
        try:
            return repr(value)[:4096]
        except Exception:
            return "<unrepresentable value>"

    def variable(self, name, value, editable=False):
        row = {"name": str(name), "value": self.display(value), "type": type(value).__name__,
               "variablesReference": self.reference(value)}
        if not editable or self.read_only(str(name), value):
            row["presentationHint"] = {"attributes": ["readOnly"]}
        return row

    def read_only(self, name, value):
        """Why this current-scope row cannot change, or None if it can."""
        base = scalar_base(name)
        if base is None:
            return "only ${scalar} variables can change"
        if not self.editing:
            return "value editing is unavailable in this Robot Framework run"
        normalized = normalize(base, ignore="_")
        if normalized in AUTOMATIC or normalized in self.automatic:
            return "set by Robot Framework or on the command line"
        if type(value) not in EDITABLE_TYPES or (type(value) is float and not math.isfinite(value)):
            return f"{type(value).__name__} values cannot change; only text, numbers, true, false and null"
        return None

    def set_variable(self, args):
        """Write one strict JSON scalar into the current RF scope as a local value, atomically."""
        reference = args.get("variablesReference")
        if reference not in self.values:
            raise DebugError(EXPIRED_EDIT)
        if self.failure:
            raise DebugError(f"This Robot value is read-only (failure stop). {READ_ONLY_FAILURE}")
        if reference not in self.scopes:
            raise DebugError("This Robot value is read-only (members of a value cannot change).")
        name = args.get("name")
        base = scalar_base(name)
        if base is None:
            raise DebugError("This Robot value is read-only (only ${scalar} variables can change).")
        variables = EXECUTION_CONTEXTS.current.variables
        if self.scopes[reference] is not variables.current:
            raise DebugError(EXPIRED_EDIT)
        rows = [row for row in self.values[reference]
                if scalar_base(row) is not None and normalize(scalar_base(row), ignore="_") == normalize(base, ignore="_")]
        current = variables.current.get(rows[0], MISSING) if len(rows) == 1 else MISSING
        if current is MISSING:
            raise DebugError(f"Cannot change {name}: it is not a variable of the current Robot scope; "
                             "new variables cannot be created here.")
        if reason := self.read_only(rows[0], current):
            raise DebugError(f"This Robot value is read-only ({reason}).")
        value = json_scalar(args.get("value"))
        variables.set_local(rows[0], value)
        self.values[reference] = dict(BuiltIn().get_variables())
        return {"value": self.display(value), "type": type(value).__name__, "variablesReference": 0}

    def dispatch(self, command, args, frames):
        if command == "stackTrace":
            if args.get("threadId", 1) != 1:
                raise DebugError("Unknown Robot thread")
            start, count = args.get("startFrame", 0), args.get("levels", 0)
            if not isinstance(start, int) or not isinstance(count, int) or min(start, count) < 0:
                raise DebugError("Stack paging must use nonnegative integers")
            return {"stackFrames": frames[start:start + count if count else None], "totalFrames": len(frames)}
        if command == "scopes":
            self.current_frame(args.get("frameId"))
            reference = self.handle(self.values, dict(BuiltIn().get_variables()))
            if not self.failure:
                self.scopes[reference] = EXECUTION_CONTEXTS.current.variables.current
            name = FAILURE_SCOPE if self.failure else EDITABLE_SCOPE
            return {"scopes": [{"name": name, "variablesReference": reference, "expensive": False}]}
        if command == "variables":
            reference = args.get("variablesReference")
            if reference not in self.values:
                raise DebugError("Stale or unknown Robot variable handle")
            value = self.values[reference]
            indexed = isinstance(value, (list, tuple))
            items = list(enumerate(value)) if indexed else list((value if isinstance(value, dict) else vars(value)).items())
            if args.get("filter") in ("named", "indexed") and (args["filter"] == "indexed") != indexed:
                items = []
            start, count = args.get("start", 0), args.get("count", 0)
            if not isinstance(start, int) or not isinstance(count, int) or min(start, count) < 0:
                raise DebugError("Variable paging must use nonnegative integers")
            editable = reference in self.scopes
            return {"variables": [self.variable(k, v, editable)
                                  for k, v in items[start:start + count if count else None]]}
        if command == "setVariable":
            return self.set_variable(args)
        if command == "evaluate":
            self.current_frame(args.get("frameId"))
            if args.get("context", "repl") != "repl":
                raise DebugError("Robot evaluation supports only the repl context")
            if self.failure:
                raise DebugError(READ_ONLY_FAILURE)
            expression = args.get("expression")
            if not isinstance(expression, str) or not expression.strip() or '\n' in expression or '\r' in expression:
                raise DebugError("Enter one Robot keyword call on a single line")
            visitor = Calls()
            visitor.visit(get_model(io.StringIO("*** Test Cases ***\nConsole\n    " + expression + "\n")))
            if len(visitor.calls) != 1 or visitor.calls[0].errors or visitor.calls[0].assign:
                raise DebugError("Enter one Robot keyword call without an assignment")
            call = visitor.calls[0]
            self.evaluating = True
            try:
                value = BuiltIn().run_keyword(call.keyword, *call.args)
            except Exception as exc:
                raise DebugError(str(exc)) from exc
            finally:
                self.evaluating = False
            return {"result": self.display(value), "type": type(value).__name__,
                    "variablesReference": self.reference(value)}
        raise DebugError(f"Unsupported paused Robot command: {command}")

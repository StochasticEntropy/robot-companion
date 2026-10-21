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
"""

import io
from pathlib import Path

from robot.api import get_model
from robot.api.parsing import ModelVisitor
from robot.libraries.BuiltIn import BuiltIn
from robot.running.context import EXECUTION_CONTEXTS
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

    def variable(self, name, value):
        return {"name": str(name), "value": self.display(value), "type": type(value).__name__,
                "variablesReference": self.reference(value)}

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
            name = "Robot visible variables after failure (read-only)" if self.failure else "Robot visible variables"
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
            return {"variables": [self.variable(k, v) for k, v in items[start:start + count if count else None]]}
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

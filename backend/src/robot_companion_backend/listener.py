"""Experimental RF 7.5 listener: commands execute on the paused Robot thread.

Imported only inside the owned worker after the RF prerequisite check. No Python
expression evaluator and no secondary Robot execution are used for the console.
"""

import io
from pathlib import Path

from robot.api import get_model
from robot.api.parsing import ModelVisitor
from robot.libraries.BuiltIn import BuiltIn


class DebugError(Exception):
    pass


class Calls(ModelVisitor):
    def __init__(self):
        self.calls = []

    def visit_KeywordCall(self, node):
        self.calls.append(node)


class RobotListener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self, control, events, breakpoints):
        self.control = control
        self.events = events
        self.breakpoints = breakpoints
        self.stack = []
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
                verified = bp["line"] in lines
                bp["verified"] = verified
                body = {**bp, "source": {"path": path}}
                if not verified:
                    body["message"] = detail
                self.emit("breakpoint", {"reason": "changed", "breakpoint": body})

    def frame(self, data, result):
        source = getattr(data, "source", None) or getattr(result, "source", None)
        return {"name": str(getattr(result, "name", None) or getattr(data, "name", "Robot")),
                "source": {"path": str(Path(source).resolve())} if source else None,
                "line": getattr(data, "lineno", None) or 1, "column": 1}

    def start_test(self, data, result):
        self.stack.append(self.frame(data, result))

    def end_test(self, data, result):
        self.stack.pop()

    def start_keyword(self, data, result):
        if self.evaluating:
            return
        frame = self.frame(data, result)
        self.stack.append(frame)
        path = (frame["source"] or {}).get("path")
        hits = [bp["id"] for bp in self.breakpoints.get(path, [])
                if bp.get("verified") and bp["line"] == frame["line"]]
        stepping = self.step and (self.step[0] == "stepIn" or len(self.stack) <= self.step[1])
        if hits or stepping:
            self.pause("breakpoint" if hits else "step", hits)

    def end_keyword(self, data, result):
        if not self.evaluating:
            self.stack.pop()

    def handle(self, collection, value):
        self.next_handle += 1
        collection[self.next_handle] = value
        return self.next_handle

    def invalidate(self):
        self.frames.clear()
        self.values.clear()

    def pause(self, reason, hits):
        self.invalidate()
        self.step = None
        frames = []
        for index in reversed(range(len(self.stack))):
            frame = {**self.stack[index], "id": self.handle(self.frames, index)}
            if frame["source"] is None:
                del frame["source"]
            frames.append(frame)
        self.emit("stopped", {"reason": reason, "threadId": 1, "allThreadsStopped": True,
                              "hitBreakpointIds": hits})
        while True:
            request = self.control.read()
            if request is None:
                raise SystemExit(4)
            command = request.get("command")
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
            return {"scopes": [{"name": "Robot visible variables", "variablesReference": reference,
                                "expensive": False}]}
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

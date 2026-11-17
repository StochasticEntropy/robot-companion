"""Exercise the listener with real Robot output and paused steps on any supported host."""

import io
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from robot import run

from robot_companion_backend.listener import RobotListener


class DebugConsoleTests(unittest.TestCase):
    def test_nested_breakpoint_step_and_keyword_logs_have_exact_sources(self):
        events = []
        replies = iter([
            {"requestId": 1, "command": "stackTrace", "arguments": {"threadId": 1}},
            {"requestId": 2, "command": "scopes", "arguments": {"frameId": 2}},
            {"requestId": 3, "command": "evaluate", "arguments": {"frameId": 2, "expression": "No Operation"}},
            {"requestId": 4, "command": "next", "arguments": {"threadId": 1}},
            {"requestId": 5, "command": "stackTrace", "arguments": {"threadId": 1}},
            {"requestId": 6, "command": "continue", "arguments": {"threadId": 1}},
        ])
        control = SimpleNamespace(pending=lambda: (), get=lambda: next(replies))
        with TemporaryDirectory() as scratch:
            source = Path(scratch).resolve() / "workflow.robot"
            source.write_text("*** Test Cases ***\nExample test\n    Example Flow\n*** Keywords ***\n"
                              "Example Flow\n    Log    from Robot\n    No Operation\n", encoding="utf-8")
            listener = RobotListener(control, SimpleNamespace(write=events.append),
                                     {str(source): [{"id": 17, "line": 6}]})
            self.assertEqual(run(str(source), listener=listener, stdout=io.StringIO(), stderr=io.StringIO(),
                                 outputdir=scratch, log=None, report=None), 0)
            stops = [entry["body"] for entry in events if entry.get("event") == "stopped"]
            self.assertEqual([(stop["reason"], stop["description"]) for stop in stops],
                             [("breakpoint", "Breakpoint · Log"), ("step", "Step · No Operation")])
            outputs = [entry["body"] for entry in events if entry.get("event") == "output"]
            self.assertEqual([(value["output"], value["source"], value["line"]) for value in outputs],
                             [("Breakpoint · Example test › Log (workflow.robot:6)\n",
                               {"path": str(source), "name": "workflow.robot"}, 6),
                              ("[INFO] from Robot\n", {"path": str(source), "name": "workflow.robot"}, 6),
                              ("Step · Example test › No Operation (workflow.robot:7)\n",
                               {"path": str(source), "name": "workflow.robot"}, 7)])
            answers = {entry["requestId"]: entry for entry in events if "requestId" in entry}
            self.assertEqual([(frame["name"], frame["line"]) for frame in answers[1]["body"]["stackFrames"]],
                             [("Log", 6), ("Example Flow", 3), ("Example test", 2)])
            self.assertEqual(answers[2]["body"], {"scopes": []})
            self.assertEqual(answers[3]["error"], "Select the current Robot frame to evaluate a keyword.")
            self.assertEqual(answers[5]["body"]["stackFrames"][0]["line"], 7)

    def test_log_mirroring_is_bounded_and_leaves_console_messages_alone(self):
        events = []
        listener = RobotListener(None, SimpleNamespace(write=events.append), {})
        for level, console in [("DEBUG", False), ("WARN", False), ("ERROR", False), ("INFO", True)]:
            listener.log_message(SimpleNamespace(level=level, console=console, message="not mirrored"))
        listener.log_message(SimpleNamespace(level="INFO", message="x" * 10000))
        listener.console_log_remaining = 8
        for _ in range(2):
            listener.log_message(SimpleNamespace(level="INFO", message="one more"))
        self.assertEqual(len(events), 2)
        self.assertTrue(events[0]["body"]["output"].endswith("... [truncated]\n"))
        self.assertEqual(events[1]["body"]["output"],
                         "Robot INFO output limit reached. See the Robot log for the rest.\n")

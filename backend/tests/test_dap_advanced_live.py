"""Required real RF conformance for advanced breakpoint controls: hit counts. Missing RF fails."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import DapClient
from robot_companion_backend.dap import HIT_SYNTAX
from test_dap_lifecycle import children, processes_in

# Line 7 runs six times in the first test; the resource's lines run in both tests.
HIT = """*** Settings ***
Resource    counted.resource

*** Test Cases ***
Count Six
    FOR    ${i}    IN RANGE    1    7
        Counted Step    ${i}
    END

Count Two More
    FOR    ${i}    IN RANGE    7    9
        Counted Step    ${i}
    END
    Countdown    ${3}
"""
COUNTED = """*** Keywords ***
Counted Step
    [Arguments]    ${n}
    Log    step-${n}
    IF    ${n} % 2 == 0    Log    even-${n}
    Run Keyword    Log    wrapped-${n}

Countdown
    [Arguments]    ${n}
    Log    countdown-${n}
    IF    ${n} > 0    Countdown    ${n - 1}
"""
TESTS = [("Count Six", "PASS"), ("Count Two More", "PASS")]


class HitCountLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-hit-")).resolve()
        for name, text in (("hit.robot", HIT), ("counted.resource", COUNTED)):
            (self.workspace / name).write_text(text, encoding="utf-8")
        self.client = DapClient()

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2),
                encoding="utf-8")
            for filename in ("output.xml", "log.html", "report.html"):
                source = self.workspace / filename
                if source.exists():
                    shutil.copyfile(source, target / (self.id() + "." + filename))
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process leaked")
        finally:
            shutil.rmtree(self.workspace)

    def ok(self, command, arguments=None):
        response = self.client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def path(self, name):
        return str(self.workspace / name)

    def launch(self, breakpoints, refused=()):
        """Initialize, launch hit.robot, set {file: [SourceBreakpoint]} and configure.

        `refused` holds (file, SourceBreakpoints, message) requests sent after the valid ones;
        each must fail and leave that file's breakpoints unchanged.
        Returns {(file, index): verified breakpoint event body}.
        """
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                               "columnsStartAt1": True, "pathFormat": "path"})
        self.ok("launch", {"target": "hit.robot", "cwd": str(self.workspace)})
        self.worker_pid = self.client.event("process")["systemProcessId"]
        self.client.event("initialized")
        pending = {}
        for name, requested in breakpoints.items():
            result = self.ok("setBreakpoints", {"source": {"path": self.path(name)}, "breakpoints": requested})
            self.assertFalse(any(bp["verified"] for bp in result["breakpoints"]))
            for index, bp in enumerate(result["breakpoints"]):
                pending[bp["id"]] = (name, index)
        for name, requested, message in refused:
            response = self.client.request("setBreakpoints", {"source": {"path": self.path(name)},
                                                              "breakpoints": requested})
            self.assertEqual((response["success"], response["message"]), (False, message), requested)
        self.ok("configurationDone")
        verified = {}
        for _ in pending:
            body = self.client.event("breakpoint")["breakpoint"]
            verified[pending[body["id"]]] = body
        self.assertTrue(all(bp["verified"] for bp in verified.values()), verified)
        return verified

    def received(self, event):
        return [m["received"].get("body", {}) for m in self.client.transcript
                if "received" in m and m["received"].get("event") == event]

    def console(self):
        return [o["output"] for o in self.received("output") if o.get("category") == "console"]

    def important(self):
        return [o["output"] for o in self.received("output") if o.get("category") == "important"]

    def variable(self, name):
        frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
        scope = self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]
        variables = {v["name"]: v for v in self.ok("variables", {
            "variablesReference": scope["variablesReference"]})["variables"]}
        return frame, variables[name]["value"]

    def finish(self, console_after=None):
        """Check the completed run; `console_after` is the step after which three console calls ran (paused before the next step logs)."""
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)
        self.assertEqual(children(self.client.backend_pid), [])
        root = ET.parse(self.workspace / "output.xml").getroot()
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in root.iter("test")], TESTS)
        # Hit counts only decide stops and logpoints: the Robot run itself is unchanged.
        steps = [n for step in range(1, 9) for n in [step, *([100] * 3 if step == console_after else [])]]
        messages = [m.text for m in root.iter("msg")]
        for prefix, values in (("step-", steps), ("even-", [n for n in steps if n % 2 == 0]),
                               ("wrapped-", steps), ("countdown-", [3, 2, 1, 0])):
            self.assertEqual([m for m in messages if m.startswith(prefix)], [f"{prefix}{n}" for n in values])
        return root

    def test_hit_counts_select_documented_encounters_before_conditions(self):
        verified = self.launch({"hit.robot": [
            {"line": 7, "hitCondition": "2", "logMessage": "bare {$i}"},
            {"line": 7, "hitCondition": "==2", "logMessage": "eq {$i}"},
            {"line": 7, "hitCondition": ">=2", "logMessage": "ge {$i}"},
            {"line": 7, "hitCondition": "%2", "logMessage": "mod {$i}"},
            {"line": 7, "hitCondition": " \t>= 5 \t", "logMessage": "spaced {$i}"},
            # Condition-false encounters still count: %2 matches 2, 4, 6 and the condition keeps 4, 6.
            {"line": 7, "hitCondition": "%2", "condition": "$i > 2", "logMessage": "both {$i}"},
            # The condition is never evaluated on a non-matching hit: 1 / (2 - 2) is not reached.
            {"line": 7, "hitCondition": ">=3", "condition": "1 / ($i - 2) > 0", "logMessage": "guarded {$i}"},
            # A condition error on hit 4 does not rewind the count: hit 6 still matches %2.
            {"line": 7, "hitCondition": "%2", "condition": "1 / ($i - 4) > 0", "logMessage": "after {$i}"},
            {"line": 7, "hitCondition": ">=2147483647", "logMessage": "never {$i}"},
            {"line": 7, "hitCondition": "%3"},
            {"line": 7, "hitCondition": "==6"}]})
        mod3, eq6 = verified[("hit.robot", 9)]["id"], verified[("hit.robot", 10)]["id"]
        stopped = self.client.event("stopped")
        self.assertEqual((stopped["reason"], stopped["hitBreakpointIds"]), ("breakpoint", [mod3]))
        frame, value = self.variable("${i}")
        self.assertEqual((frame["name"], frame["line"], frame["source"]["path"], value),
                         ("Counted Step", 7, self.path("hit.robot"), "3"))
        self.ok("continue", {"threadId": 1})
        # Two breakpoints matching the same encounter give one stop naming both.
        stopped = self.client.event("stopped")
        self.assertEqual(stopped["hitBreakpointIds"], [mod3, eq6])
        self.assertEqual(self.variable("${i}")[1], "6")
        self.ok("continue", {"threadId": 1})
        self.finish()
        self.assertEqual(len(self.received("stopped")), 2)
        logged = self.console()
        for prefix, values in (("bare", [2]), ("eq", [2]), ("ge", [2, 3, 4, 5, 6]), ("mod", [2, 4, 6]),
                               ("spaced", [5, 6]), ("both", [4, 6]), ("guarded", [3, 4, 5, 6]), ("after", [6]),
                               ("never", [])):
            self.assertEqual([line for line in logged if line.startswith(prefix + " ")],
                             [f"{prefix} {value}\n" for value in values], prefix)
        errors = self.important()
        after = verified[("hit.robot", 7)]["id"]
        self.assertEqual(errors, [f"Breakpoint {after} condition error at hit.robot:7: Evaluating expression "
                                  "'1 / ($i - 4) > 0' failed: ZeroDivisionError: division by zero; not stopping\n"])

    def test_counts_span_tests_and_skip_not_run_wrapper_and_evaluation_calls(self):
        verified = self.launch({"counted.resource": [
            # One run counts across tests: hits 6, 7 and 8 come from both tests.
            {"line": 4, "hitCondition": ">=6", "logMessage": "span {$n}"},
            # Only executed calls count: n=2 and n=4 run Log, odd n report it NOT RUN.
            {"line": 5, "hitCondition": "2", "logMessage": "even {$n}"},
            # Run Keyword's inner Log on the same line is not a second hit.
            {"line": 6, "hitCondition": "==2", "logMessage": "wrapped {$n}"},
            # Recursive calls are real hits: calls from n=3, 2, 1; n=0 reports its call NOT RUN.
            {"line": 11, "hitCondition": ">=2", "logMessage": "down {$n}"},
            {"line": 4, "hitCondition": "==3"}]})
        stop = verified[("counted.resource", 4)]["id"]
        stopped = self.client.event("stopped")
        self.assertEqual(stopped["hitBreakpointIds"], [stop])
        frame, value = self.variable("${n}")
        self.assertEqual((frame["name"], frame["line"], value), ("Log", 4, "3"))
        # Console keyword calls run on the paused thread and never count as hits.
        for _ in range(3):
            console = self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                                           "expression": "Counted Step    ${100}"})
            self.assertEqual(console["result"], "None")
        self.ok("continue", {"threadId": 1})
        self.finish(console_after=2)
        self.assertEqual(len(self.received("stopped")), 1)
        self.assertEqual(self.console(), ["wrapped 2\n", "even 4\n", "span 6\n", "span 7\n", "span 8\n",
                                          "down 2\n", "down 1\n"])
        self.assertEqual(self.important(), [])

    def test_refused_hit_counts_keep_previous_breakpoints_of_that_file(self):
        message = (f"Invalid hit count (hitCondition) at line 7. Use {HIT_SYNTAX}. "
                   "Breakpoints of this file were not changed.")
        refused = [("hit.robot", [{"line": 7}, {"line": 7, "hitCondition": value}], message)
                   for value in ("0", "-1", "+2", "02", "2.0", "1e2", ">2", "<=2", "٢", "2\n", "", " ",
                                 "2147483648", 2, None)]
        # A fresh worker starts counting at zero: ==2 stops on the second encounter.
        verified = self.launch({"hit.robot": [{"line": 7, "hitCondition": "==2"}]}, refused)
        self.assertEqual(list(verified), [("hit.robot", 0)])
        stopped = self.client.event("stopped")
        self.assertEqual(stopped["hitBreakpointIds"], [verified[("hit.robot", 0)]["id"]])
        self.assertEqual(self.variable("${i}")[1], "2")
        self.ok("continue", {"threadId": 1})
        self.finish()
        self.assertEqual(len(self.received("stopped")), 1)

    def test_terminate_while_paused_on_hit_count_reaps_worker(self):
        self.launch({"counted.resource": [{"line": 4, "hitCondition": "%4"}]})
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        self.assertEqual(self.variable("${n}")[1], "4")
        self.assertEqual(children(self.client.backend_pid), [self.worker_pid])
        self.ok("terminate")
        self.client.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(children(self.client.backend_pid), [])


if __name__ == "__main__":
    unittest.main()

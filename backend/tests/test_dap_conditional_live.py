"""Required real RF conditional breakpoint and logpoint conformance. Missing RF fails."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import DapClient
from test_dap_lifecycle import children, processes_in

LOOP = """*** Settings ***
Resource    imported.resource

*** Test Cases ***
Conditional Loop
    FOR    ${iteration}    IN RANGE    3
        Loop Body    ${iteration}
    END
    Log    loop-finished
    VAR    @{items}    a    b
    Run Keyword    Log    wrapped-${items}[0]
"""
IMPORTED = """*** Keywords ***
Loop Body
    [Arguments]    ${value}
    Log    body-${value}
    IF    ${value} == 2    Countdown    ${2}

Countdown
    [Arguments]    ${n}
    IF    ${n} > 0    Countdown    ${n - 1}
"""
# Same keyword name and same call lines as the run's files, never imported or run.
UNIMPORTED = """*** Keywords ***
Loop Body
    [Arguments]    ${value}
    Log    unimported-${value}
    Log    second
    Log    third
    Log    never
"""


class ConditionalBreakpointLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot.version import VERSION
        if VERSION != "7.5":
            raise AssertionError(f"Required live runtime is RF 7.5; found {VERSION}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-cond-")).resolve()
        (self.workspace / "other").mkdir()
        for name, text in (("loop.robot", LOOP), ("imported.resource", IMPORTED),
                           ("unimported.resource", UNIMPORTED), ("other/loop.robot", LOOP)):
            (self.workspace / name).write_text(text)
        self.client = DapClient()

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2))
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
        """Initialize, launch loop.robot, set {file: [SourceBreakpoint]} and configure.

        `refused` holds (loop.robot SourceBreakpoints, message) requests that must fail.
        Returns {(file, line, index): verified breakpoint event body}.
        """
        capabilities = self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                               "columnsStartAt1": True, "pathFormat": "path"})
        self.assertIs(capabilities.get("supportsConditionalBreakpoints"), True)
        self.assertIs(capabilities.get("supportsLogPoints"), True)
        for unsupported in ("supportsHitConditionalBreakpoints", "supportsFunctionBreakpoints",
                            "supportsDataBreakpoints", "exceptionBreakpointFilters",
                            "supportsBreakpointLocationsRequest"):
            self.assertNotIn(unsupported, capabilities)
        self.ok("launch", {"target": "loop.robot", "cwd": str(self.workspace)})
        self.worker_pid = self.client.event("process")["systemProcessId"]
        self.client.event("initialized")
        for requested, message in refused:
            response = self.client.request("setBreakpoints", {"source": {"path": self.path("loop.robot")},
                                                              "breakpoints": requested})
            self.assertEqual((response["success"], response["message"]), (False, message))
        pending = {}
        for name, requested in breakpoints.items():
            result = self.ok("setBreakpoints", {"source": {"path": self.path(name)}, "breakpoints": requested})
            self.assertFalse(any(bp["verified"] for bp in result["breakpoints"]))
            for index, bp in enumerate(result["breakpoints"]):
                pending[bp["id"]] = (name, bp["line"], index)
        self.ok("configurationDone")
        verified = {}
        for _ in pending:
            body = self.client.event("breakpoint")["breakpoint"]
            self.assertEqual(set(body) - {"message"}, {"id", "verified", "line", "source"})
            verified[pending[body["id"]]] = body
        return verified

    def received(self, event):
        return [m["received"].get("body", {}) for m in self.client.transcript
                if "received" in m and m["received"].get("event") == event]

    def finish(self):
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)
        self.assertEqual(children(self.client.process.pid), [])
        root = ET.parse(self.workspace / "output.xml").getroot()
        tests = root.findall(".//test")
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in tests],
                         [("Conditional Loop", "PASS")])
        return root

    def test_condition_stops_only_on_matching_iteration_in_run_source(self):
        condition = "$iteration == 2"
        verified = self.launch({
            "loop.robot": [{"line": 7, "condition": condition}, {"line": 6, "condition": condition}],
            # Same file name/line and same keyword, but not the run's source or not imported.
            "other/loop.robot": [{"line": 7, "condition": condition}],
            "unimported.resource": [{"line": 4, "condition": "True"}, {"line": 7, "condition": condition}],
            # Evaluated in the resource keyword's own variable scope; false for 0, 1 and 2.
            "imported.resource": [{"line": 4, "condition": "${value} == 99"}]})
        self.assertEqual({key: (bp["verified"], bp.get("message")) for key, bp in verified.items()}, {
            ("loop.robot", 7, 0): (True, None),
            ("loop.robot", 6, 1): (False, "No executable Robot keyword call at this line"),
            ("other/loop.robot", 7, 0): (True, None),
            ("unimported.resource", 4, 0): (True, None),
            ("unimported.resource", 7, 1): (True, None),
            ("imported.resource", 4, 0): (True, None)})
        target = verified[("loop.robot", 7, 0)]
        stopped = self.client.event("stopped")
        self.assertEqual((stopped["reason"], stopped["hitBreakpointIds"]), ("breakpoint", [target["id"]]))
        self.assertEqual(children(self.client.process.pid), [self.worker_pid])
        frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
        self.assertEqual((frame["name"], frame["line"], frame["source"]["path"]),
                         ("Loop Body", 7, self.path("loop.robot")))
        scope = self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]
        variables = {v["name"]: v for v in self.ok("variables", {
            "variablesReference": scope["variablesReference"]})["variables"]}
        self.assertEqual((variables["${iteration}"]["value"], variables["${iteration}"]["type"]), ("2", "int"))
        console = self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                                          "expression": "Catenate    SEPARATOR=-    live    ${iteration}"})
        self.assertEqual(console["result"], "'live-2'")
        self.assertFalse([o for o in self.received("output") if o.get("category") in ("console", "important")])
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertEqual(len(self.received("stopped")), 1)
        self.assertFalse([o for o in self.received("output") if o.get("category") == "important"])
        messages = [m.text for m in root.iter("msg")]
        self.assertEqual([m for m in messages if m.startswith(("body-", "unimported-", "loop-"))],
                         ["body-0", "body-1", "body-2", "loop-finished"])

    def test_logpoints_interpolate_live_values_without_stopping(self):
        verified = self.launch({
            "loop.robot": [{"line": 7, "logMessage": "iteration={$iteration}"},
                           # Run Keyword's inner Log reports the same line: one message, not two.
                           {"line": 11, "logMessage": "wrapped {len($items)} @{items} ${items}[1]"}],
            "imported.resource": [{"line": 4, "condition": "$value >= 1", "logMessage":
                                   "{{literal}} value=${value} next={$value + 1} type={type($value).__name__}"
                                   " bad={$missing} ${{x}}"}],
            "unimported.resource": [{"line": 4, "logMessage": "never {$value}"}]})
        self.assertTrue(all(bp["verified"] for bp in verified.values()), verified)
        root = self.finish()
        self.assertEqual(self.received("stopped"), [])
        logged = [o for o in self.received("output") if o.get("category") == "console"]
        missing = "<error: Evaluating expression '$missing' failed: Variable '$missing' not found.>"
        expected = [("loop.robot", 7, "iteration=0\n"), ("loop.robot", 7, "iteration=1\n"),
                    ("imported.resource", 4, f"{{literal}} value=1 next=2 type=int bad={missing} ${{x}}\n"),
                    ("loop.robot", 7, "iteration=2\n"),
                    ("imported.resource", 4, f"{{literal}} value=2 next=3 type=int bad={missing} ${{x}}\n"),
                    ("loop.robot", 11, "wrapped 2 ['a', 'b'] b\n")]
        self.assertEqual([(Path(o["source"]["path"]).relative_to(self.workspace).as_posix(), o["line"], o["output"])
                          for o in logged], expected)
        # Logpoints only observe: the Robot run itself is unchanged.
        messages = [m.text for m in root.iter("msg")]
        self.assertEqual([m for m in messages if m.startswith(("body-", "loop-", "iteration", "wrapped"))],
                         ["body-0", "body-1", "body-2", "loop-finished", "wrapped-a"])

    def test_recursive_keyword_line_counts_every_call(self):
        # The recursive call is on the same line as its caller's call: each call is its own hit.
        verified = self.launch({"imported.resource": [{"line": 9, "logMessage": "countdown n={$n}"},
                                                      {"line": 9, "condition": "$n == 1"}]})
        self.assertTrue(all(bp["verified"] for bp in verified.values()), verified)
        stopped = self.client.event("stopped")
        self.assertEqual(stopped["hitBreakpointIds"], [verified[("imported.resource", 9, 1)]["id"]])
        frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
        self.assertEqual([(f["name"], f["line"]) for f in frames[:3]],
                         [("Countdown", 9), ("Countdown", 9), ("Countdown", 5)])
        self.ok("continue", {"threadId": 1})
        self.finish()
        self.assertEqual(len(self.received("stopped")), 1)
        self.assertEqual([o["output"] for o in self.received("output") if o.get("category") == "console"],
                         ["countdown n=2\n", "countdown n=1\n"])

    def test_invalid_inputs_have_deterministic_dispositions(self):
        refused = (
            ([{"line": 7}, {"line": 7, "hitCondition": "2"}], "Hit-count breakpoints (hitCondition) are unsupported"),
            ([{"line": 7, "condition": 2}], "Breakpoint condition must be a string"),
            ([{"line": 7, "condition": None}], "Breakpoint condition must be a string"),
            ([{"line": 7, "logMessage": ["x"]}], "Breakpoint logMessage must be a string"))
        verified = self.launch({
            "loop.robot": [{"line": 7, "condition": ""}, {"line": 7, "condition": "  "},
                           {"line": 7, "condition": "$iteration =="}, {"line": 7, "condition": "foo("},
                           {"line": 7, "logMessage": ""}, {"line": 7, "logMessage": "open {$iteration"},
                           {"line": 7, "logMessage": "stray } brace"}, {"line": 7, "logMessage": "empty {}"},
                           {"line": 7, "logMessage": "bad {$iteration +}"},
                           {"line": 9, "condition": "$missing == 1"},
                           # Hostile sizes: deep nesting is refused, a huge value is bounded.
                           {"line": 7, "condition": "1+" * 100000 + "1"},
                           {"line": 9, "logMessage": "huge {'x' * 100000}"},
                           {"line": 11, "condition": "$items == ['a', 'b']"}],
            "imported.resource": [{"line": 4, "condition": "1 / $value > 0"}]}, refused)
        syntax = "Breakpoint condition is not a valid RF expression: "
        dispositions = {key[2]: (bp["verified"], bp.get("message", "")) for key, bp in verified.items()
                        if key[0] == "loop.robot"}
        self.assertEqual(dispositions[0], (False, "Breakpoint condition is empty"))
        self.assertEqual(dispositions[1], (False, "Breakpoint condition is empty"))
        self.assertTrue(dispositions[2][1].startswith(syntax + "invalid syntax"), dispositions[2])
        self.assertTrue(dispositions[3][1].startswith(syntax), dispositions[3])
        self.assertEqual(dispositions[4], (False, "Log message is empty"))
        self.assertEqual(dispositions[5],
                         (False, "Log message has an unclosed '{' at offset 5; write '{{' for a brace"))
        self.assertEqual(dispositions[6],
                         (False, "Log message has an unmatched '}' at offset 6; write '}}' for a brace"))
        self.assertEqual(dispositions[7], (False, "Log message expression is empty"))
        self.assertTrue(dispositions[8][1].startswith("Log message expression is not a valid RF expression"))
        self.assertFalse(any(state for state, _ in list(dispositions.values())[:9]))
        self.assertEqual(dispositions[9], (True, ""))
        self.assertTrue(dispositions[10][1].startswith(syntax), dispositions[10])
        self.assertLess(len(dispositions[10][1]), 4200)
        self.assertEqual((dispositions[11], dispositions[12]), ((True, ""), (True, "")))
        # Runtime errors never count as true: value 0 errors, values 1 and 2 are true and stop.
        divide = verified[("imported.resource", 4, 0)]
        self.assertTrue(divide["verified"])
        for value in (1, 2):
            stopped = self.client.event("stopped")
            self.assertEqual(stopped["reason"], "breakpoint")
            self.assertEqual(stopped["hitBreakpointIds"], [divide["id"]])
            frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
            scope = self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]
            variables = {v["name"]: v["value"] for v in self.ok("variables", {
                "variablesReference": scope["variablesReference"]})["variables"]}
            self.assertEqual(variables["${value}"], str(value))
            self.ok("continue", {"threadId": 1})
        # A plain conditional stop on a Run Keyword line stops once, at the outer call.
        wrapped = verified[("loop.robot", 11, 12)]
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [wrapped["id"]])
        frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
        self.assertEqual((frame["name"], frame["line"]), ("Run Keyword", 11))
        self.ok("continue", {"threadId": 1})
        self.finish()
        self.assertEqual(len(self.received("stopped")), 3)
        huge = [o["output"] for o in self.received("output") if o.get("category") == "console"]
        self.assertEqual(huge, ["huge " + "x" * 65531 + "... [truncated]\n"])
        errors = [o for o in self.received("output") if o.get("category") == "important"]
        self.assertEqual([(Path(o["source"]["path"]).name, o["line"]) for o in errors],
                         [("imported.resource", 4), ("loop.robot", 9)])
        self.assertEqual(errors[0]["output"],
                         f"Breakpoint {divide['id']} condition error at imported.resource:4: Evaluating expression "
                         f"'1 / $value > 0' failed: ZeroDivisionError: division by zero; not stopping\n")
        self.assertEqual(errors[1]["output"],
                         f"Breakpoint {verified[('loop.robot', 9, 9)]['id']} condition error at loop.robot:9: "
                         f"Evaluating expression '$missing == 1' failed: Variable '$missing' not found.; "
                         f"not stopping\n")

    def test_terminate_while_paused_on_condition_reaps_worker(self):
        self.launch({"loop.robot": [{"line": 7, "condition": "$iteration == 1"}]})
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        self.ok("terminate")
        self.client.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(children(self.client.process.pid), [])


if __name__ == "__main__":
    unittest.main()

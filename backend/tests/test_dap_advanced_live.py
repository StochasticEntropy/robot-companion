"""Required real RF conformance for advanced debugging: hit counts and Robot failure filters. Missing RF fails."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import DapClient
from robot_companion_backend.dap import FAILURE_FILTERS, HIT_SYNTAX
from robot_companion_backend.listener import READ_ONLY_FAILURE
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
# Handled, propagated, teardown and continuing failures next to results that never stop.
FAILURES = """*** Test Cases ***
Handled Failures Pass
    TRY
        Fail    handled-boom
    EXCEPT    handled-boom
        Log    caught
    END
    Run Keyword And Ignore Error    Fail    ignored-boom
    Log    after-handled

Propagated Failure
    Outer Keyword

Teardown Failure
    Log    body-ok
    [Teardown]    Fail    teardown-boom

Skipped Test
    Skip    skip-me

Control Flow Passes
    FOR    ${i}    IN RANGE    3
        IF    ${i} == 1    CONTINUE
        IF    ${i} == 2    BREAK
    END
    ${value}=    Return Early
    Log    warn-only    level=WARN
    IF    False    Fail    not-run-boom

*** Keywords ***
Outer Keyword
    Inner Keyword

Inner Keyword
    VAR    ${local}    inner-local
    Fail    propagated-boom

Return Early
    RETURN    done
"""
FAILURE_TESTS = [("Handled Failures Pass", "PASS"), ("Propagated Failure", "FAIL"), ("Teardown Failure", "FAIL"),
                 ("Skipped Test", "SKIP"), ("Control Flow Passes", "PASS")]
# (name, line, phase, message) of every failure stop, in order, with both filters selected.
KEYWORD_STOPS = [("Fail", 4, "handled-boom"), ("Fail", 8, "ignored-boom"), ("Fail", 36, "propagated-boom"),
                 ("Inner Keyword", 32, "propagated-boom"), ("Outer Keyword", 12, "propagated-boom"),
                 ("Fail", 16, "teardown-boom")]
TEST_STOPS = [("Propagated Failure", 11, "propagated-boom"), ("Teardown Failure", 14, "Teardown failed:\nteardown-boom")]
# Blocks in a library keyword until the test creates ${GO}: no listener callback runs meanwhile.
HANDSHAKE = """*** Settings ***
Library    OperatingSystem

*** Test Cases ***
Change While Running
    Log    before-wait
    Wait Until Created    ${GO}    timeout=60s
    Run Keyword And Ignore Error    Fail    after-enable
    Run Keyword And Ignore Error    Fail    after-disable
    Log    done
"""


class AdvancedLiveCase(unittest.TestCase):
    """Real adapter, worker and RF run of FILES' TARGET in a fresh workspace."""
    FILES = {}
    TARGET = None

    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-adv-")).resolve()
        for name, text in self.FILES.items():
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

    def launch(self, breakpoints, refused=(), filters=None, args=()):
        """Initialize, launch TARGET, set {file: [SourceBreakpoint]}, optional failure filters, configure.

        `refused` holds (file, SourceBreakpoints, message) requests sent after the valid ones;
        each must fail and leave that file's breakpoints unchanged.
        Returns {(file, index): verified breakpoint event body}.
        """
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                               "columnsStartAt1": True, "pathFormat": "path"})
        self.ok("launch", {"target": self.TARGET, "cwd": str(self.workspace), "args": list(args)})
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
        if filters is not None:
            self.ok("setExceptionBreakpoints", {"filters": filters})
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

    def end_run(self, exit_code):
        self.assertEqual(self.client.event("exited")["exitCode"], exit_code)
        self.client.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)
        self.assertEqual(children(self.client.backend_pid), [])
        return ET.parse(self.workspace / "output.xml").getroot()


class HitCountLiveTests(AdvancedLiveCase):
    FILES = {"hit.robot": HIT, "counted.resource": COUNTED}
    TARGET = "hit.robot"

    def finish(self, console_after=None):
        """Check the completed run; three console calls ran after step `console_after`
        (paused before the next step logs)."""
        root = self.end_run(0)
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


class FailureFilterLiveTests(AdvancedLiveCase):
    FILES = {"failures.robot": FAILURES, "handshake.robot": HANDSHAKE,
             "tasks.robot": "*** Tasks ***\nFailing Task\n    Fail    task-boom\n"}
    TARGET = "failures.robot"

    def stops(self, expected):
        """Continue through `expected` failure stops, checking each, and return their events."""
        events = []
        for name, line, phase, message in expected:
            stopped = self.client.event("stopped")
            events.append(stopped)
            frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
            top = frames[0]
            kind = "keyword" if phase == "keyword" else "test"
            label = f"{name} (final outcome: FAIL)" if kind == "test" else name
            self.assertEqual((stopped["reason"], stopped["hitBreakpointIds"], top["name"], top["line"],
                              top["source"]["path"]), ("exception", [], label, line, self.path(self.TARGET)))
            if kind == "keyword":
                self.assertEqual(stopped["description"], "Robot failure: failed keyword")
                self.assertEqual(stopped["text"],
                                 f"Robot keyword '{name}' failed at {self.TARGET}:{line}: {message}")
            else:
                self.assertEqual(len(frames), 1)
                self.assertEqual(stopped["description"], "Robot failure: failed test (final outcome)")
                self.assertEqual(stopped["text"], f"Robot test '{name}' failed (final outcome, after teardown) "
                                                  f"at {self.TARGET}:{line}: {message}")
            self.assertNotIn("exception", stopped["text"].lower())
            # Read-only inspection: variables are readable, the console refuses to run keywords.
            scope = self.ok("scopes", {"frameId": top["id"]})["scopes"][0]
            self.assertEqual(scope["name"], "Robot visible variables after failure (read-only)")
            variables = self.ok("variables", {"variablesReference": scope["variablesReference"]})["variables"]
            self.assertIn("${TEST_NAME}", [v["name"] for v in variables])
            console = self.client.request("evaluate", {"frameId": top["id"], "context": "repl",
                                                       "expression": "Log    must-not-run"})
            self.assertEqual((console["success"], console["message"]), (False, READ_ONLY_FAILURE))
            self.ok("continue", {"threadId": 1})
        return events

    def finish(self):
        root = self.end_run(2)
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in root.iter("test")],
                         FAILURE_TESTS)
        messages = [m.text for m in root.iter("msg")]
        self.assertNotIn("must-not-run", messages)
        self.assertIn("after-handled", messages)
        return root

    def test_filters_are_robot_results_and_off_until_selected(self):
        self.assertEqual([(f["filter"], f["label"], f["default"]) for f in FAILURE_FILTERS], [
            ("robot-failed-keyword", "Robot: failed keyword (includes handled failures)", False),
            ("robot-failed-test", "Robot: failed test/task (final outcome)", False)])
        for entry in FAILURE_FILTERS:
            self.assertIn("Not Python exceptions", entry["description"])
        self.launch({}, filters=[])
        self.finish()
        self.assertEqual(self.received("stopped"), [])

    def test_failed_keyword_stops_on_handled_propagated_and_teardown_failures(self):
        self.launch({}, filters=["robot-failed-keyword"])
        stops = self.stops([(name, line, "keyword", message) for name, line, message in KEYWORD_STOPS])
        self.finish()
        self.assertEqual(len(self.received("stopped")), len(stops))
        self.assertEqual(self.important(), [])

    def test_failed_test_stops_once_per_final_failed_outcome(self):
        self.launch({}, filters=["robot-failed-test"])
        stops = self.stops([(name, line, "test", message) for name, line, message in TEST_STOPS])
        self.finish()
        self.assertEqual(len(self.received("stopped")), len(stops))

    def test_both_filters_keep_keyword_and_final_outcome_phases_distinct(self):
        self.launch({}, filters=["robot-failed-test", "robot-failed-keyword", "robot-failed-test"])
        keyword = [(name, line, "keyword", message) for name, line, message in KEYWORD_STOPS]
        test = [(name, line, "test", message) for name, line, message in TEST_STOPS]
        self.stops([*keyword[:5], test[0], keyword[5], test[1]])
        self.finish()
        self.assertEqual(len(self.received("stopped")), 8)

    def test_invalid_filter_requests_keep_the_previous_selection(self):
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                               "columnsStartAt1": True, "pathFormat": "path"})
        self.ok("launch", {"target": self.TARGET, "cwd": str(self.workspace)})
        self.client.event("initialized")
        self.ok("setExceptionBreakpoints", {"filters": ["robot-failed-test"]})
        unchanged = " The previous selection is unchanged."
        for arguments, message in (
                ({}, "setExceptionBreakpoints requires 'filters': a list of Robot failure filter IDs"),
                ({"filters": "robot-failed-keyword"},
                 "setExceptionBreakpoints requires 'filters': a list of Robot failure filter IDs"),
                ({"filters": ["robot-failed-keyword", 1]},
                 "setExceptionBreakpoints requires 'filters': a list of Robot failure filter IDs"),
                ({"filters": ["robot-failed-keyword", "uncaught"]},
                 "Unknown Robot failure filter 'uncaught'. Supported: robot-failed-keyword, robot-failed-test."
                 + unchanged),
                ({"filters": ["raised"]},
                 "Unknown Robot failure filter 'raised'. Supported: robot-failed-keyword, robot-failed-test."
                 + unchanged),
                ({"filters": ["x" * 100000]},
                 f"Unknown Robot failure filter {'x' * 80!r}. Supported: robot-failed-keyword, robot-failed-test."
                 + unchanged),
                ({"filters": [], "filterOptions": [{"filterId": "robot-failed-keyword", "condition": "True"}]},
                 "Robot failure filters do not support filterOptions." + unchanged),
                ({"filters": ["robot-failed-keyword"], "exceptionOptions": [{"breakMode": "always"}]},
                 "Robot failure filters do not support exceptionOptions." + unchanged)):
            response = self.client.request("setExceptionBreakpoints", arguments)
            self.assertEqual((response["success"], response["message"]), (False, message))
        self.ok("configurationDone")
        self.stops([(name, line, "test", message) for name, line, message in TEST_STOPS])
        self.finish()

    def test_runtime_changes_apply_in_revision_order_at_robot_events(self):
        go = self.workspace / "go"
        self.TARGET = "handshake.robot"
        verified = self.launch({"handshake.robot": [{"line": 7}]}, filters=[], args=["--variable", f"GO:{go}"])
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("handshake.robot", 0)]["id"]])
        self.ok("continue", {"threadId": 1})
        # Running, blocked in Wait Until Created: the change is queued, not yet applied.
        self.ok("setExceptionBreakpoints", {"filters": ["robot-failed-keyword"]})
        self.assertEqual(self.console()[-1], "Robot failure stop change (revision 2) is pending; "
                                             "it applies at the next Robot keyword or test start or end\n")
        self.assertEqual(self.received("robotCompanion/failureFilters"), [])
        go.write_text("go", encoding="utf-8")
        applied = self.client.event("robotCompanion/failureFilters")
        self.assertEqual(applied, {"revision": 2, "filters": ["robot-failed-keyword"]})
        stopped = self.client.event("stopped")
        self.assertEqual((stopped["reason"], stopped["text"]),
                         ("exception", "Robot keyword 'Fail' failed at handshake.robot:8: after-enable"))
        # While paused a change applies before the next command: Continue no longer stops.
        self.ok("setExceptionBreakpoints", {"filters": []})
        self.assertEqual(self.client.event("robotCompanion/failureFilters"), {"revision": 3, "filters": []})
        self.ok("continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        ended = self.client.request("setExceptionBreakpoints", {"filters": ["robot-failed-test"]})
        self.assertEqual((ended["success"], ended["message"]),
                         (False, "The debug session has ended; failure filters can no longer change"))
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)
        self.assertEqual(len(self.received("stopped")), 2)
        order = [m["received"].get("event") for m in self.client.transcript
                 if "received" in m and m["received"].get("event") in ("robotCompanion/failureFilters", "stopped")]
        self.assertEqual(order, ["stopped", "robotCompanion/failureFilters", "stopped",
                                 "robotCompanion/failureFilters"])
        self.assertEqual([o for o in self.console() if o.startswith("Robot failure stops now")],
                         ["Robot failure stops now (failed keyword), revision 2\n",
                          "Robot failure stops now (none), revision 3\n"])
        root = ET.parse(self.workspace / "output.xml").getroot()
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in root.iter("test")],
                         [("Change While Running", "PASS")])

    def test_failed_task_is_named_as_a_task(self):
        self.TARGET = "tasks.robot"
        self.launch({}, filters=["robot-failed-test"])
        stopped = self.client.event("stopped")
        self.assertEqual((stopped["description"], stopped["text"]), (
            "Robot failure: failed task (final outcome)",
            "Robot task 'Failing Task' failed (final outcome, after teardown) at tasks.robot:2: task-boom"))
        self.ok("continue", {"threadId": 1})
        self.end_run(1)

    def test_terminate_and_disconnect_at_failure_stops_reap_worker(self):
        for command in ("terminate", "disconnect"):
            with self.subTest(command=command):
                if command == "disconnect":
                    self.client.close()
                    self.client = DapClient()
                self.launch({}, filters=["robot-failed-keyword"])
                self.assertEqual(self.client.event("stopped")["reason"], "exception")
                self.assertEqual(children(self.client.backend_pid), [self.worker_pid])
                self.ok(command, {"terminateDebuggee": True} if command == "disconnect" else None)
                if command == "terminate":
                    self.client.event("terminated")
                    self.ok("disconnect")
                self.assertEqual(self.client.process.wait(timeout=10), 0)
                self.client.drain()
                self.assertEqual(processes_in(self.workspace), [])
                self.assertEqual(children(self.client.backend_pid), [])
                self.assertFalse(self.client.forced_cleanup)


if __name__ == "__main__":
    unittest.main()

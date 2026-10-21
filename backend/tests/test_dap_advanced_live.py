"""Required real RF conformance for advanced debugging: hit counts, Robot failure filters and value edits.

Missing RF fails."""

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
from robot_companion_backend.listener import EXPIRED_EDIT, READ_ONLY_FAILURE, SHARED_REASON, SHARED_SCOPE, VALUE_FORMAT
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
# Same-named ${counter} in suite, test and keyword scopes; edits must reach the next real assertion.
EDIT = """*** Settings ***
Library    DebugValues.py

*** Variables ***
${counter}    suite
${message}    before

*** Test Cases ***
Edit And Check
    VAR    ${counter}    test
    ${number}=    Set Variable    ${1}
    VAR    @{items}    a    b
    Log    ${message}
    Should Be Equal    ${message}    after
    Check Inner    ${counter}
    Should Be Equal    ${counter}    edited-test
    ${object}=    Make Object
    Log    ${object}
    Should Be Equal    ${number}    ${-5}

Suite Value Unchanged
    Should Be Equal    ${message}    before
    Should Be Equal    ${counter}    suite
    Fail    edit-failure

*** Keywords ***
Check Inner
    [Arguments]    ${value}
    VAR    ${counter}    keyword-local
    Log    ${counter}
    Should Be Equal    ${counter}    edited-inner
    Should Be Equal    ${value}    edited-test
"""
DEBUG_VALUES = """class Holder:
    def __init__(self):
        self.counter = 7


def make_object():
    return Holder()
"""
# Stepping out of suite A reaches suite B's setup call, whose active scope is B's own suite store.
SUITE_A = """*** Test Cases ***
A Only
    Log    a-last
"""
SUITE_B = """*** Settings ***
Suite Setup       Log    b-setup
Suite Teardown    Log    b-teardown

*** Variables ***
${VALUE}          before

*** Test Cases ***
B One
    Should Be Equal    ${VALUE}    before
B Two
    Should Be Equal    ${VALUE}    before
    Log    last
"""
FIXTURE_INIT = """*** Settings ***
Suite Setup       Log    init-setup
Suite Teardown    Init Teardown

*** Keywords ***
Init Teardown
    Log    init-teardown
"""
FIXTURE_SUITE = """*** Settings ***
Suite Setup       Log    b-setup
Suite Teardown    Run Keywords    Log    b-teardown-1    AND    Log    b-teardown-2
Test Setup        Log    test-setup
Test Teardown     NONE

*** Test Cases ***
B One
    Log    one
B Two
    [Setup]    Log    own-setup
    Log    two
"""
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
            (self.workspace / name).parent.mkdir(parents=True, exist_ok=True)
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

    def launch(self, breakpoints, refused=(), filters=None, args=(), unverified=()):
        """Initialize, launch TARGET, set {file: [SourceBreakpoint]}, optional failure filters, configure.

        `refused` holds (file, SourceBreakpoints, message) requests sent after the valid ones;
        each must fail and leave that file's breakpoints unchanged. Only the (file, index)
        breakpoints in `unverified` may be reported unverified.
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
        self.assertEqual({key for key, bp in verified.items() if not bp["verified"]}, set(unverified), verified)
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

    def test_empty_hit_count_is_no_hit_condition(self):
        # VS Code sends "" for a Hit Count input left empty: every encounter stops or logs.
        verified = self.launch({"hit.robot": [{"line": 7, "hitCondition": ""},
                                              {"line": 7, "hitCondition": "", "logMessage": "empty {$i}"}]})
        for expected in range(1, 7):
            self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("hit.robot", 0)]["id"]])
            self.assertEqual(self.variable("${i}")[1], str(expected))
            self.ok("continue", {"threadId": 1})
        self.finish()
        self.assertEqual(len(self.received("stopped")), 6)
        self.assertEqual([o for o in self.console() if o.startswith("empty")], [f"empty {n}\n" for n in range(1, 7)])

    def test_refused_hit_counts_keep_previous_breakpoints_of_that_file(self):
        message = (f"Invalid hit count (hitCondition) at line 7. Use {HIT_SYNTAX}. "
                   "Breakpoints of this file were not changed.")
        refused = [("hit.robot", [{"line": 7}, {"line": 7, "hitCondition": value}], message)
                   for value in ("0", "-1", "+2", "02", "2.0", "1e2", ">2", "<=2", "٢", "2\n", " ", "\t",
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


class ValueEditLiveTests(AdvancedLiveCase):
    FILES = {"edit.robot": EDIT, "DebugValues.py": DEBUG_VALUES}
    TARGET = "edit.robot"
    ARGS = ["--variable", "CLI_VALUE:cli"]

    def scope(self, frame_index=0):
        frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
        scope = self.ok("scopes", {"frameId": frames[frame_index]["id"]})["scopes"][0]
        return frames, scope

    def rows(self, reference):
        return {v["name"]: v for v in self.ok("variables", {"variablesReference": reference})["variables"]}

    def set_value(self, reference, name, value):
        return self.client.request("setVariable", {"variablesReference": reference, "name": name, "value": value})

    def values(self, reference):
        """Rows without their child handles, which every read allocates afresh."""
        return {name: {k: v for k, v in row.items() if k != "variablesReference"}
                for name, row in self.rows(reference).items()}

    def refused(self, reference, name, value, message):
        before = self.values(reference)
        response = self.set_value(reference, name, value)
        self.assertEqual((response["success"], response["message"]), (False, message), (name, value))
        self.assertEqual(self.values(reference), before, (name, value))

    def test_edits_reach_the_running_test_in_the_current_scope_only(self):
        verified = self.launch({"edit.robot": [{"line": 13}, {"line": 30}, {"line": 18}]}, args=self.ARGS)
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("edit.robot", 0)]["id"]])
        frames, scope = self.scope()
        self.assertEqual(scope["name"], "Robot visible variables (edit current scope)")
        reference = scope["variablesReference"]
        rows = self.rows(reference)
        # Every row RF or the command line set, and every non-scalar row, is read-only on this RF row.
        editable = {name for name, row in rows.items() if "presentationHint" not in row}
        self.assertEqual(editable, {"${counter}", "${message}", "${number}"})
        self.assertEqual(rows["${counter}"]["value"], "'test'")
        format_error = f"Cannot change this value. {VALUE_FORMAT}"
        for value, message in (
                ("after", format_error), ("'after'", format_error), ("", format_error), ("  ", format_error),
                ('"a" "b"', format_error), ('"a"x', format_error), ("NaN", format_error),
                ("Infinity", format_error), ("-Infinity", format_error), ("0x10", format_error),
                ('"a\u0001b"', format_error), ("${message}", format_error), (123, format_error),
                (None, format_error),
                ('"' + "x" * 65535 + '"', f"Cannot change this value: it must be at most 65536 bytes. {VALUE_FORMAT}"),
                ("[1]", f"Cannot change this value: lists and dictionaries are not supported. {VALUE_FORMAT}"),
                ('{"a": 1}', f"Cannot change this value: lists and dictionaries are not supported. {VALUE_FORMAT}"),
                ("1e400", f"Cannot change this value: numbers must be finite. {VALUE_FORMAT}"),
                ("9007199254740992", "Cannot change this value: whole numbers must be between -9007199254740991 "
                                     f"and 9007199254740991. {VALUE_FORMAT}"),
                ('"\\ud800"',
                 f"Cannot change this value: it contains an unpaired surrogate. {VALUE_FORMAT}")):
            self.refused(reference, "${message}", value, message)
        for name, message in (
                ("${missing}", "Cannot change ${missing}: it is not a variable of the current Robot scope; "
                               "new variables cannot be created here."),
                ("@{items}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("&{SUITE_METADATA}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("%{HOME}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("${message}[0]", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("${message.upper}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("${{1 + 1}}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("${message: int}", "This Robot value is read-only (only ${scalar} variables can change)."),
                ("${TEST_NAME}", "This Robot value is read-only (set by Robot Framework or on the command line)."),
                ("${test name}", "This Robot value is read-only (set by Robot Framework or on the command line)."),
                ("${SPACE}", "This Robot value is read-only (set by Robot Framework or on the command line)."),
                ("${CLI_VALUE}", "This Robot value is read-only (set by Robot Framework or on the command line)."),
                (None, "This Robot value is read-only (only ${scalar} variables can change).")):
            self.refused(reference, name, '"x"', message)
        # Accepted boundaries; the reply and a fresh read show RF's value and type.
        for value, display, kind in (('""', "''", "str"), ('"${message}"', "'${message}'", "str"),
                                     ('"Gr\\u00fc\u00dfe \\"q\\" \u2603"', "'Grüße \"q\" ☃'", "str"),
                                     ("9007199254740991", "9007199254740991", "int"),
                                     ("-9007199254740991", "-9007199254740991", "int"), (" 1.5 ", "1.5", "float"),
                                     ("true", "True", "bool"), ("false", "False", "bool"), ("null", "None", "NoneType"),
                                     ('"' + "y" * 65534 + '"', repr("y" * 65534)[:4096], "str")):
            body = self.ok("setVariable", {"variablesReference": reference, "name": "${number}", "value": value})
            self.assertEqual(body, {"value": display, "type": kind, "variablesReference": 0})
            self.assertEqual((self.rows(reference)["${number}"]["value"], self.rows(reference)["${number}"]["type"]),
                             (display, kind))
        # The canonical name also matches: RF compares names without case, spaces or underscores.
        self.ok("setVariable", {"variablesReference": reference, "name": "${Mess_age}", "value": '"after"'})
        self.ok("setVariable", {"variablesReference": reference, "name": "${counter}", "value": '"edited-test"'})
        rows = self.rows(reference)
        self.assertEqual((rows["${message}"]["value"], rows["${counter}"]["value"]), ("'after'", "'edited-test'"))
        # Console keywords see the edited value in the same pause.
        console = self.ok("evaluate", {"frameId": frames[0]["id"], "context": "repl",
                                       "expression": "Catenate    ${message}    ${counter}"})
        self.assertEqual(console["result"], "'after edited-test'")
        self.ok("continue", {"threadId": 1})
        # Paused before the keyword's own Log: the keyword scope shadows the test value.
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("edit.robot", 1)]["id"]])
        stale = self.set_value(reference, "${message}", '"late"')
        self.assertEqual((stale["success"], stale["message"]), (False, EXPIRED_EDIT))
        frames, scope = self.scope()
        self.assertEqual([f["name"] for f in frames], ["Log", "Check Inner", "Edit And Check"])
        outer = self.client.request("scopes", {"frameId": frames[1]["id"]})
        self.assertEqual((outer["success"], outer["message"]),
                         (False, "Only the current Robot frame exposes live scopes and console evaluation"))
        inner = scope["variablesReference"]
        rows = self.rows(inner)
        self.assertEqual((rows["${counter}"]["value"], rows["${value}"]["value"]), ("'keyword-local'", "'edited-test'"))
        self.ok("setVariable", {"variablesReference": inner, "name": "${counter}", "value": '"edited-inner"'})
        self.ok("continue", {"threadId": 1})
        # Back in the test the keyword's edit has unwound and the test's edit remains.
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("edit.robot", 2)]["id"]])
        frames, scope = self.scope()
        reference = scope["variablesReference"]
        rows = self.rows(reference)
        self.assertEqual(rows["${counter}"]["value"], "'edited-test'")
        holder = rows["${object}"]
        self.assertEqual((holder["type"], holder["presentationHint"]), ("Holder", {"attributes": ["readOnly"]}))
        self.refused(reference, "${object}", '"x"', "This Robot value is read-only (Holder values cannot change; "
                                                    "only text, numbers, true, false and null).")
        members = self.rows(holder["variablesReference"])
        self.assertEqual(members["counter"]["presentationHint"], {"attributes": ["readOnly"]})
        self.refused(holder["variablesReference"], "counter", "8",
                     "This Robot value is read-only (members of a value cannot change).")
        self.ok("setVariable", {"variablesReference": reference, "name": "${number}", "value": "-5"})
        self.ok("continue", {"threadId": 1})
        root = self.end_run(1)
        self.assertEqual([(t.get("name"), t.find("status").get("status"), t.find("status").text)
                          for t in root.iter("test")],
                         [("Edit And Check", "PASS", None), ("Suite Value Unchanged", "FAIL", "edit-failure")])
        self.assertEqual(len(self.received("stopped")), 3)
        # The suite file is unchanged by edits.
        self.assertEqual((self.workspace / "edit.robot").read_text(encoding="utf-8"), EDIT)

    def test_failure_stops_and_resumed_runs_refuse_edits(self):
        self.launch({"edit.robot": [{"line": 13}]}, filters=["robot-failed-keyword"], args=self.ARGS)
        self.client.event("stopped")
        reference = self.scope()[1]["variablesReference"]
        self.ok("setVariable", {"variablesReference": reference, "name": "${message}", "value": '"after"'})
        # Resume first: the old pause's handle can never change a value again.
        self.ok("continue", {"threadId": 1})
        late = self.set_value(reference, "${message}", '"late"')
        self.assertFalse(late["success"])
        self.assertEqual(late["message"], EXPIRED_EDIT)
        # The unedited inner assertion fails; that failure stop is read-only.
        stopped = self.client.event("stopped")
        self.assertEqual((stopped["reason"], stopped["description"]), ("exception", "Robot failure: failed keyword"))
        frames, scope = self.scope()
        self.assertEqual(scope["name"], "Robot visible variables after failure (read-only)")
        rows = self.rows(scope["variablesReference"])
        self.assertTrue(all(row["presentationHint"] == {"attributes": ["readOnly"]} for row in rows.values()))
        self.refused(scope["variablesReference"], "${counter}", '"x"',
                     f"This Robot value is read-only (failure stop). {READ_ONLY_FAILURE}")
        self.ok("terminate")
        self.client.event("terminated")
        self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(processes_in(self.workspace), [])
        self.assertEqual(children(self.client.backend_pid), [])

    def test_stop_after_accepted_and_rejected_edits_reaps_worker(self):
        for command in ("terminate", "disconnect"):
            with self.subTest(command=command):
                if command == "disconnect":
                    self.client.close()
                    self.client = DapClient()
                self.launch({"edit.robot": [{"line": 13}]}, args=self.ARGS)
                self.client.event("stopped")
                reference = self.scope()[1]["variablesReference"]
                self.ok("setVariable", {"variablesReference": reference, "name": "${message}", "value": '"after"'})
                self.assertFalse(self.set_value(reference, "${message}", "after")["success"])
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


class SuiteScopeEditLiveTests(AdvancedLiveCase):
    """A suite setup or teardown pause is read-only: an edit there would reach later tests."""
    FILES = {"suites/a.robot": SUITE_A, "suites/b.robot": SUITE_B}
    TARGET = "suites"

    def shared_pause(self, line):
        frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
        self.assertEqual((frames[0]["name"], frames[0]["line"], frames[0]["source"]["path"]),
                         ("Log", line, self.path("suites/b.robot")))
        scope = self.ok("scopes", {"frameId": frames[0]["id"]})["scopes"][0]
        self.assertEqual(scope["name"], SHARED_SCOPE)
        rows = {v["name"]: v for v in self.ok("variables", {"variablesReference": scope["variablesReference"]})["variables"]}
        self.assertTrue(all(row.get("presentationHint") == {"attributes": ["readOnly"]} for row in rows.values()))
        self.assertEqual(rows["${VALUE}"]["value"], "'before'")
        for value in ('"edited"', "1", "null"):
            refused = self.client.request("setVariable", {"variablesReference": scope["variablesReference"],
                                                          "name": "${VALUE}", "value": value})
            self.assertEqual((refused["success"], refused["message"]),
                             (False, f"This Robot value is read-only ({SHARED_REASON})."))
        rows = {v["name"]: v for v in self.ok("variables", {"variablesReference": scope["variablesReference"]})["variables"]}
        self.assertEqual(rows["${VALUE}"]["value"], "'before'")

    def test_suite_setup_and_teardown_pauses_refuse_edits_and_later_tests_keep_values(self):
        verified = self.launch({"suites/a.robot": [{"line": 3}], "suites/b.robot": [{"line": 13}]})
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("suites/a.robot", 0)]["id"]])
        # Step from suite A's last call: the next call is suite B's setup.
        self.ok("next", {"threadId": 1})
        self.assertEqual(self.client.event("stopped")["reason"], "step")
        self.shared_pause(2)
        self.ok("continue", {"threadId": 1})
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [verified[("suites/b.robot", 0)]["id"]])
        # A test-scope pause stays editable; its edit ends with the test.
        frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
        scope = self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]
        self.assertEqual(scope["name"], "Robot visible variables (edit current scope)")
        self.ok("setVariable", {"variablesReference": scope["variablesReference"], "name": "${VALUE}", "value": '"test-only"'})
        self.ok("next", {"threadId": 1})
        self.assertEqual(self.client.event("stopped")["reason"], "step")
        self.shared_pause(3)
        self.ok("continue", {"threadId": 1})
        root = self.end_run(0)
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in root.iter("test")],
                         [("A Only", "PASS"), ("B One", "PASS"), ("B Two", "PASS")])


class FixtureLineBreakpointLiveTests(AdvancedLiveCase):
    """A breakpoint on a setup or teardown line stops at that call; NONE runs nothing."""
    FILES = {"suites/__init__.robot": FIXTURE_INIT, "suites/b.robot": FIXTURE_SUITE}
    TARGET = "suites"

    def test_setup_and_teardown_lines_stop_at_their_calls(self):
        verified = self.launch({"suites/__init__.robot": [{"line": 2}, {"line": 3}, {"line": 7}],
                                "suites/b.robot": [{"line": 2}, {"line": 3}, {"line": 4}, {"line": 5}, {"line": 11}]},
                               unverified=[("suites/b.robot", 3)])
        self.assertEqual(verified[("suites/b.robot", 3)]["message"], "No executable Robot keyword call at this line")
        # RF runs the Run Keywords teardown's inner calls on the same line: one stop only.
        for name, index, keyword, line in (("__init__.robot", 0, "Log", 2), ("b.robot", 0, "Log", 2),
                                           ("b.robot", 2, "Log", 4), ("b.robot", 4, "Log", 11),
                                           ("b.robot", 1, "Run Keywords", 3), ("__init__.robot", 1, "Init Teardown", 3),
                                           ("__init__.robot", 2, "Log", 7)):
            stopped = self.client.event("stopped")
            self.assertEqual(stopped["hitBreakpointIds"], [verified[("suites/" + name, index)]["id"]])
            frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
            self.assertEqual((frame["name"], frame["source"]["path"], frame["line"]),
                             (keyword, self.path("suites/" + name), line))
            if (name, line) == ("b.robot", 2):  # a suite setup stop is read-only, as when stepping there
                self.assertEqual(self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]["name"], SHARED_SCOPE)
            self.ok("continue", {"threadId": 1})
        root = self.end_run(0)
        self.assertEqual(len(self.received("stopped")), 7)
        self.assertEqual([(t.get("name"), t.find("status").get("status")) for t in root.iter("test")],
                         [("B One", "PASS"), ("B Two", "PASS")])


if __name__ == "__main__":
    unittest.main()

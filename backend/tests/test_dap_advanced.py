"""Advanced DAP request validation without a Robot run: hit-count grammar, failure filters, atomic refusal."""

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from client import DapClient
from robot_companion_backend.dap import FAILURE_FILTERS, HIT_LIMIT, HIT_SYNTAX, parse_hit_condition

VALID = {"1": ("==", 1), "2": ("==", 2), "==2": ("==", 2), ">=2": (">=", 2), "%2": ("%", 2),
         " 2": ("==", 2), "2\t": ("==", 2), " \t== \t2 \t": ("==", 2), ">= 5": (">=", 5), "% 3": ("%", 3),
         "\t%1\t": ("%", 1), str(HIT_LIMIT): ("==", HIT_LIMIT), ">=" + str(HIT_LIMIT): (">=", HIT_LIMIT)}
# Zero, signs, leading zeroes, decimals/exponents, other operators, expressions, non-ASCII
# digits or spaces, line breaks, empty text, overflow and non-strings are all refused.
INVALID = ["0", "00", "-1", "+2", "02", "2.0", "1.5", "1e2", "0x2", ">2", "<2", "<=2", "!=2", "=2", "= =2",
           "==", "%", ">=", "", " ", "\t", "2 2", ">= 2 3", "2%", "%%2", "== >=2", "abc", "$i", "${2}", "{2}",
           "٢", "２", "2 ", " 2", "2\n", "\n2", "2\r", "\r\n2", "2\0", " 2",
           str(HIT_LIMIT + 1), "9999999999", "1" * 11, "1" * 100000, 2, 2.0, None, True, ["2"], {"n": 2}]


class HitConditionGrammarTests(unittest.TestCase):
    def test_valid_counts_parse_to_operator_and_threshold(self):
        for text, expected in VALID.items():
            with self.subTest(text=text):
                self.assertEqual(parse_hit_condition(text), expected)

    def test_everything_else_is_refused_without_evaluation(self):
        for value in INVALID:
            with self.subTest(value=value if not isinstance(value, str) or len(value) < 20 else len(value)):
                with self.assertRaises(ValueError):
                    parse_hit_condition(value)

    def test_syntax_help_names_exact_grammar_and_range(self):
        self.assertEqual(HIT_SYNTAX, "N, ==N, >=N or %N, where N is a whole number from 1 to 2147483647")


class AdapterRequestCase(unittest.TestCase):
    """Requests to the real adapter process, initialized but before any launch."""

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-adv-")).resolve()
        (self.workspace / "loop.robot").write_text("*** Test Cases ***\nT\n    Log    x\n", encoding="utf-8")
        self.client = DapClient()
        reply = self.client.request("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                                   "columnsStartAt1": True, "pathFormat": "path"})
        self.assertTrue(reply["success"], reply)
        self.capabilities = reply["body"]

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2),
                encoding="utf-8")
        shutil.rmtree(self.workspace)

    def set_breakpoints(self, breakpoints):
        return self.client.request("setBreakpoints", {"source": {"path": str(self.workspace / "loop.robot")},
                                                      "breakpoints": breakpoints})



class HitConditionRequestTests(AdapterRequestCase):
    def test_valid_hit_counts_are_pending_like_other_breakpoints(self):
        reply = self.set_breakpoints([{"line": 3, "hitCondition": "2"}, {"line": 3, "hitCondition": " >= 3 "},
                                      {"line": 3, "hitCondition": "%2", "condition": "True"}])
        self.assertTrue(reply["success"], reply)
        self.assertEqual([(bp["line"], bp["verified"]) for bp in reply["body"]["breakpoints"]],
                         [(3, False), (3, False), (3, False)])

    def test_one_invalid_hit_count_refuses_the_whole_request(self):
        for value in INVALID:
            reply = self.set_breakpoints([{"line": 3}, {"line": 3, "hitCondition": value}])
            self.assertFalse(reply["success"], value)
            self.assertEqual(reply["message"], f"Invalid hit count (hitCondition) at line 3. Use {HIT_SYNTAX}. "
                                               "Breakpoints of this file were not changed.")
            self.assertEqual(reply["body"]["error"]["format"], reply["message"])
        # Refusals allocate no breakpoint IDs: the next valid request starts at the first ID.
        self.assertEqual([bp["id"] for bp in self.set_breakpoints([{"line": 3}])["body"]["breakpoints"]], [1])
        self.assertTrue(self.client.request("disconnect", {"terminateDebuggee": True})["success"])
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)


class FailureFilterRequestTests(AdapterRequestCase):
    """setExceptionBreakpoints before launch: whole-request validation, no run needed."""

    def test_filters_are_advertised_and_validate_before_launch(self):
        self.assertEqual(self.capabilities["exceptionBreakpointFilters"], FAILURE_FILTERS)
        self.assertTrue(self.capabilities["supportsHitConditionalBreakpoints"])
        self.assertTrue(self.capabilities["supportsSetVariable"])
        for absent in ("supportsExceptionOptions", "supportsExceptionFilterOptions", "supportsExceptionInfoRequest"):
            self.assertNotIn(absent, self.capabilities)
        for arguments in ({"filters": []}, {"filters": ["robot-failed-keyword"]},
                          {"filters": ["robot-failed-test", "robot-failed-keyword", "robot-failed-test"]},
                          {"filters": [], "filterOptions": [], "exceptionOptions": []}):
            reply = self.client.request("setExceptionBreakpoints", arguments)
            self.assertTrue(reply["success"], reply)
            self.assertNotIn("body", reply)
        for arguments in ({}, {"filters": None}, {"filters": {"robot-failed-test": True}}, {"filters": [None]},
                          {"filters": ["Robot-Failed-Test"]}, {"filters": ["robot-failed-test "]},
                          {"filters": ["python-uncaught"]}, {"filters": [], "filterOptions": [{}]},
                          {"filters": [], "exceptionOptions": [{"breakMode": "never"}]},
                          {"filters": [], "filterOptions": "x"}):
            reply = self.client.request("setExceptionBreakpoints", arguments)
            self.assertFalse(reply["success"], arguments)


if __name__ == "__main__":
    unittest.main()

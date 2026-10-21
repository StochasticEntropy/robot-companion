"""Required real RF conformance for interactive sessions (REPL and notebook cells).

Every case drives the `interactive` service and its owned Robot worker as real processes on
the current runtime row: actual RF keywords, variables across cells, errors, interrupts,
restart, output attribution and owned-process cleanup.
"""

import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from client import InteractiveClient
import processes
from robot_companion_backend.interactive import INTERRUPT_GRACE
from test_process_tree import alive, wait_gone

LIBRARY = """import pathlib, subprocess, sys, time


def shout(text):
    print("printed " + text)
    return text.upper()


def native_sleep(seconds):
    time.sleep(float(seconds))  # one native call: an interrupt waits until it returns


def swallow_interrupts(seconds):
    end = time.monotonic() + float(seconds)
    while time.monotonic() < end:
        try:
            time.sleep(0.05)
        except Exception:
            pass


def start_grandchild(marker):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    pathlib.Path(marker).write_text(str(child.pid))
"""
VARIABLES = """ORIGIN = "variable file"
"""


class InteractiveLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-interactive-")).resolve()
        (self.workspace / "libs").mkdir()
        (self.workspace / "libs" / "SessionLibrary.py").write_text(LIBRARY, encoding="utf-8")
        (self.workspace / "values.py").write_text(VARIABLES, encoding="utf-8")
        self.client = InteractiveClient(cwd=self.workspace)
        self.addCleanup(self.close)
        response = self.client.request("initialize", {"clientID": "test"})
        self.assertTrue(response["success"], response)
        self.assertEqual(response["body"]["protocol"], "robotCompanion/interactive")
        self.assertEqual(response["body"]["version"], 1)
        self.cells = 0

    def close(self):
        self.client.close()
        self.assertFalse(self.client.forced_cleanup, "The interactive service needed forced cleanup")
        self.assertFalse(processes.alive(self.client.owned_processes), "Owned processes outlived the service")
        self.assertEqual(processes.processes_in(self.workspace), [], "A process still runs in the workspace")
        shutil.rmtree(self.workspace, ignore_errors=True)

    def start(self, args=None):
        response = self.client.request("start", {"args": args or []})
        self.assertTrue(response["success"], response)
        return response["body"]

    def execute(self, code, cell=None, timeout=40):
        self.cells += 1
        cell = cell or f"cell-{self.cells}"
        response = self.client.request("execute", {"id": cell, "code": code}, timeout=timeout)
        self.assertTrue(response["success"], response)
        self.assertEqual(response["body"]["id"], cell)
        return response["body"]

    def test_cells_run_robot_keywords_in_the_session_context(self):
        info = self.start(["--variable", "GREETING:hello", "--pythonpath", "libs", "--variablefile", "values.py",
                           "--include", "smoke", "--outputdir", "results"])
        # The selected environment: the interpreter that runs the service runs the worker.
        self.assertEqual(Path(info["executable"]), Path(sys.executable))
        self.assertEqual(info["python"], sys.version.split()[0])
        from robot.version import VERSION
        self.assertEqual(info["robot"], VERSION)
        self.assertEqual(Path(info["cwd"]), self.workspace)
        self.assertEqual(info["applied"], {"variable": ["GREETING:hello"], "variablefile": ["values.py"],
                                           "pythonpath": ["libs"]})
        self.assertEqual(info["ignored"], ["include", "outputdir"])
        self.assertIn(info["processId"], self.client.owned_processes)
        self.assertTrue(Path(info["sessionDirectory"]).is_dir())

        assigned = self.execute("${count}=    Set Variable    ${41}")
        self.assertEqual(assigned["status"], "PASS")
        self.assertEqual(assigned["values"], [{"label": "${count}", "value": "41", "type": "int"}])
        result = self.execute("Import Library    SessionLibrary.py\n${loud}=    Shout    ${GREETING}\n"
                              "${next}=    Evaluate    $count + 1\nVAR    ${source}    ${ORIGIN}", "words")
        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual([value["label"] for value in result["values"]], ["${loud}", "${next}", "${source}"])
        self.assertEqual(result["values"][0]["value"], "'HELLO'")
        self.assertEqual(result["values"][1]["value"], "42")
        self.assertEqual(result["values"][2]["value"], "'variable file'")
        echoed = self.execute("Shout    again")
        self.assertEqual(echoed["values"], [{"label": None, "value": "'AGAIN'", "type": "str"}])
        loop = self.execute("FOR    ${i}    IN RANGE    2\n    Log    loop ${i}\nEND\n"
                            "IF    ${next} == 42\n    Log    forty-two\nEND\nLog    ${CURDIR}", "loop")
        self.assertEqual(loop["status"], "PASS", loop)
        self.assertEqual(self.client.outputs("loop")["log"], f"loop 0loop 1forty-two{self.workspace}")

        variables = self.client.request("variables")["body"]["variables"]
        mine = {item["name"]: item for item in variables if item["origin"] == "cells"}
        self.assertEqual(set(mine), {"${count}", "${loud}", "${next}", "${source}", "${i}"})
        self.assertEqual(mine["${next}"]["value"], "42")
        self.assertEqual(next(item for item in variables if item["name"] == "${GREETING}")["origin"], "session")
        # No output, log or report file and no --outputdir: only Python's own import cache is added.
        self.assertEqual(sorted(path.name for path in self.workspace.iterdir() if path.name != "__pycache__"),
                         ["libs", "values.py"])

    def test_output_is_attributed_to_the_cell_that_produced_it(self):
        self.start(["--pythonpath", "libs"])
        self.execute("Import Library    SessionLibrary.py")
        first = self.execute("Log    first message\nLog To Console    first console\n"
                             "Log To Console    first error    stream=STDERR\nShout    first print", "first")
        second = self.execute("Log    second message    WARN\nLog    hidden debug    DEBUG", "second")
        self.assertEqual([first["status"], second["status"]], ["PASS", "PASS"])
        self.assertEqual(self.client.outputs("first"), {"log": "first messageprinted first print",
                                                       "stdout": "first console\n", "stderr": "first error\n"})
        self.assertEqual(self.client.outputs("second"), {"log": "second message"})
        levels = [message["body"].get("level") for message in self.client.events
                  if message.get("event") == "output" and message["body"].get("id") == "second"]
        self.assertEqual(levels, ["WARN"])
        busy = self.client.start_request("execute", {"id": "busy", "code": "Sleep    1s"})
        refused = self.client.request("execute", {"id": "other", "code": "Log    no"})
        self.assertFalse(refused["success"])
        self.assertEqual(refused["message"], "A cell is already running in this Robot session")
        self.assertEqual(self.client.response(busy)["body"]["status"], "PASS")

    def test_errors_fail_only_their_cell(self):
        self.start()
        missing = self.execute("No Such Keyword    x")
        self.assertEqual(missing["status"], "FAIL")
        self.assertEqual(missing["message"], "No keyword with name 'No Such Keyword' found.")
        stopped = self.execute("Log    before\nShould Be Equal    1    2\nLog    never", "stopped")
        self.assertEqual((stopped["status"], stopped["message"]), ("FAIL", "1 != 2"))
        self.assertEqual(self.client.outputs("stopped")["log"].count("never"), 0)
        syntax = self.execute("IF    $True\n    Log    open")
        self.assertEqual(syntax["status"], "FAIL")
        self.assertIn("IF must have closing END", syntax["message"])
        tests = self.execute("*** Test Cases ***\nT\n    Log    x")
        self.assertEqual(tests["status"], "FAIL")
        self.assertIn("cannot define tests", tests["message"])
        skipped = self.execute("Skip    not today")
        self.assertEqual((skipped["status"], skipped["message"]), ("SKIP", "not today"))
        ignored = self.execute("${status}    ${message}=    Run Keyword And Ignore Error    Fail    boom")
        self.assertEqual(ignored["status"], "PASS")
        self.assertEqual(ignored["values"][0]["value"], "'FAIL'")
        self.assertEqual(self.execute("Log    still running")["status"], "PASS")

    def test_definition_cells_define_and_replace_keywords(self):
        self.start()
        defined = self.execute("*** Variables ***\n${FACTOR}    ${2}\n\n*** Keywords ***\nScale\n"
                               "    [Arguments]    ${value}\n    RETURN    ${{$value * $FACTOR}}")
        self.assertEqual(defined["status"], "PASS", defined)
        self.assertEqual(defined["values"], [{"label": "Defined", "value": "Scale", "type": "keywords"},
                                             {"label": "Set", "value": "${FACTOR}", "type": "variables"}])
        self.assertEqual(self.execute("Scale    ${21}")["values"][0]["value"], "42")
        self.execute("*** Keywords ***\nScale\n    [Arguments]    ${value}\n    RETURN    ${{$value * 3}}")
        self.assertEqual(self.execute("Scale    ${21}")["values"][0]["value"], "63")

    def test_interrupt_stops_a_running_keyword_and_keeps_the_session(self):
        self.start(["--pythonpath", "libs"])
        self.execute("${kept}=    Set Variable    still here\nImport Library    SessionLibrary.py")
        for code in ("Sleep    30s", "Run Keyword And Ignore Error    Sleep    30s",
                     "TRY\n    Sleep    30s\nEXCEPT\n    Log    caught\nEND\nLog    after try"):
            with self.subTest(code=code):
                self.cells += 1
                cell = f"cell-{self.cells}"
                request = self.client.start_request("execute", {"id": cell, "code": code})
                time.sleep(1)
                started = time.monotonic()
                self.assertTrue(self.client.request("interrupt", {"id": cell})["body"]["interrupted"])
                result = self.client.response(request)["body"]
                self.assertLess(time.monotonic() - started, 3)
                self.assertEqual((result["status"], result["message"]), ("INTERRUPTED", "Interrupted"))
                self.assertNotIn("caught", self.client.outputs(cell).get("log", ""))
                self.assertNotIn("after try", self.client.outputs(cell).get("log", ""))
        # Library code that swallows the interrupt still ends its cell, without the later steps.
        request = self.client.start_request("execute", {"id": "swallow", "code":
                                                        "Swallow Interrupts    2\nLog    after swallow"})
        time.sleep(0.5)
        self.client.request("interrupt", {"id": "swallow"})
        self.assertEqual(self.client.response(request)["body"]["status"], "INTERRUPTED")
        self.assertNotIn("after swallow", self.client.outputs("swallow").get("log", ""))
        self.assertFalse(self.client.request("interrupt", {})["body"]["interrupted"], "Nothing is running")
        kept = self.execute("Log    ${kept}", "kept")
        self.assertEqual(kept["status"], "PASS")
        self.assertEqual(self.client.outputs("kept")["log"], "still here")

    def test_interrupt_of_a_native_call_ends_the_session_and_its_processes(self):
        first = self.start(["--pythonpath", "libs"])
        self.execute("Import Library    SessionLibrary.py\n${lost}=    Set Variable    gone soon\n"
                     f"Start Grandchild    {(self.workspace / 'grandchild.pid').as_posix()}")
        grandchild = int((self.workspace / "grandchild.pid").read_text())
        self.assertTrue(alive(grandchild))
        request = self.client.start_request("execute", {"id": "native", "code": "Native Sleep    120"})
        time.sleep(1)
        started = time.monotonic()
        self.client.request("interrupt", {"id": "native"})
        result = self.client.response(request, timeout=INTERRUPT_GRACE + 20)["body"]
        self.assertGreaterEqual(time.monotonic() - started, INTERRUPT_GRACE - 0.5)
        self.assertEqual(result["status"], "INTERRUPTED")
        self.assertTrue(result["sessionEnded"])
        self.assertIn(f"did not stop within {INTERRUPT_GRACE} s", result["message"])
        ended = self.client.event("sessionEnded")
        self.assertEqual(ended["sessionId"], first["sessionId"])
        self.assertTrue(wait_gone(first["processId"]))
        self.assertTrue(wait_gone(grandchild))
        self.assertFalse(Path(first["sessionDirectory"]).exists())
        refused = self.client.request("execute", {"id": "late", "code": "Log    x"})
        self.assertEqual(refused["message"], "No Robot session is running; start one first")
        second = self.start()
        self.assertNotEqual(second["processId"], first["processId"])
        self.assertEqual(self.execute("Log    ${lost}")["message"], "Variable '${lost}' not found.")

    def test_restart_and_stop_replace_and_end_the_worker(self):
        first = self.start(["--variable", "MODE:one"])
        self.execute("${temporary}=    Set Variable    1")
        restarted = self.client.request("restart")["body"]
        self.assertEqual(restarted["sessionId"], first["sessionId"] + 1)
        self.assertEqual(restarted["applied"], {"variable": ["MODE:one"]}, "Restart keeps the session's arguments")
        self.assertTrue(wait_gone(first["processId"]))
        self.assertFalse(Path(first["sessionDirectory"]).exists())
        ended = self.client.event("sessionEnded")
        self.assertEqual((ended["sessionId"], ended["exitCode"], ended["reason"]),
                         (first["sessionId"], 0, "The Robot session was restarted"))
        self.assertEqual(self.execute("Log    ${temporary}")["status"], "FAIL")
        self.assertEqual(self.execute("Log    ${MODE}")["status"], "PASS")
        running = self.client.start_request("execute", {"id": "cut", "code": "Sleep    30s"})
        time.sleep(0.5)
        self.assertTrue(self.client.request("stop")["success"])
        cut = self.client.response(running)["body"]
        self.assertEqual((cut["status"], cut["message"], cut["sessionEnded"]),
                         ("INTERRUPTED", "The Robot session was stopped", True))
        self.assertTrue(wait_gone(restarted["processId"]))
        self.assertFalse(self.client.request("execute", {"id": "none", "code": "Log    x"})["success"])

    def test_invalid_robot_arguments_are_reported(self):
        response = self.client.request("start", {"args": ["--nosuchoption"]})
        self.assertFalse(response["success"])
        self.assertEqual(response["message"], "Invalid Robot arguments: option --nosuchoption not recognized")
        self.assertEqual(processes.descendants(self.client.backend_pid), {}, "A refused start left a process")
        # As in a Robot run, a variable file that cannot be imported is an error, not a refusal.
        info = self.start(["--variablefile", "missing.py"])
        self.assertEqual(len(info["warnings"]), 1)
        self.assertTrue(info["warnings"][0].startswith("[ ERROR ] Variable file 'missing.py' does not exist"),
                        info["warnings"])
        self.assertEqual(self.start_failed_cleanly(), None)

    def start_failed_cleanly(self):
        response = self.client.request("start", {})
        self.assertEqual(response["message"], "A Robot session is already running; restart or stop it first")

    def test_end_of_input_ends_a_busy_session(self):
        info = self.start(["--pythonpath", "libs"])
        self.execute(f"Import Library    SessionLibrary.py\n"
                     f"Start Grandchild    {(self.workspace / 'grandchild.pid').as_posix()}")
        grandchild = int((self.workspace / "grandchild.pid").read_text())
        self.client.start_request("execute", {"id": "busy", "code": "Sleep    60s"})
        time.sleep(0.5)
        self.client.process.stdin.close()
        self.assertEqual(self.client.process.wait(timeout=20), 0)
        self.assertTrue(wait_gone(info["processId"]))
        self.assertTrue(wait_gone(grandchild))
        self.assertFalse(Path(info["sessionDirectory"]).exists())

    def test_a_killed_service_leaves_no_session_worker(self):
        info = self.start()
        if processes.WINDOWS:
            subprocess.run(["taskkill", "/F", "/PID", str(self.client.backend_pid)], check=True, capture_output=True)
        else:
            os.kill(self.client.backend_pid, signal.SIGKILL)
        self.client.process.wait(timeout=10)
        # POSIX: the idle worker sees its control channel close; Windows: the job is closed.
        self.assertTrue(wait_gone(info["processId"], timeout=15))
        # Only the service could remove the session directory.
        shutil.rmtree(info["sessionDirectory"], ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

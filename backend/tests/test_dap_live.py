"""Required real RF DAP conformance. Missing RF fails; no mocked or skipped pass."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET

from client import DapClient
from test_dap_lifecycle import children, processes_in

FIXTURES = Path(__file__).parent / "fixtures"


class RobotDapLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-live-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.client = DapClient()
        self.worker_pid = None

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

    def event(self, name):
        deadline = time.monotonic() + 30
        while True:
            for index, message in enumerate(self.client.events):
                if message.get("event") == name:
                    return self.client.events.pop(index).get("body", {})
            self.client.events.append(self.client.next_message(deadline))

    def launch_to_pause(self):
        capabilities = self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                               "columnsStartAt1": True, "pathFormat": "path"})
        self.assertNotIn("supportsEvaluateForHovers", capabilities)
        self.ok("launch", {"target": "audit.robot", "cwd": str(self.workspace)})
        self.worker_pid = self.event("process")["systemProcessId"]
        self.event("initialized")
        pending = self.ok("setBreakpoints", {"source": {"path": str(self.workspace / "audit.robot")},
                                               "breakpoints": [{"line": 12}, {"line": 6}]})["breakpoints"]
        self.assertFalse(any(bp["verified"] for bp in pending))
        self.ok("configurationDone")
        verified = [self.event("breakpoint")["breakpoint"] for _ in pending]
        self.assertEqual([(bp["line"], bp["verified"]) for bp in verified], [(12, True), (6, False)])
        stopped = self.event("stopped")
        self.assertEqual((stopped["reason"], stopped["threadId"]), ("breakpoint", 1))
        self.assertEqual(stopped["hitBreakpointIds"], [pending[0]["id"]])
        self.assertEqual(children(self.client.process.pid), [self.worker_pid])
        self.assert_worker_interpreter()
        self.assertEqual(self.ok("threads")["threads"], [{"id": 1, "name": "Robot Framework"}])
        return self.top_frame(12, "audit.robot")

    def assert_worker_interpreter(self):
        """The paused Robot worker runs under the backend's own interpreter (`sys.executable`
        of the installed backend), never another Python on PATH; recorded for the release."""
        argv0 = Path(f"/proc/{self.worker_pid}/cmdline").read_bytes().split(b"\0")[0].decode()
        record = {"test": self.id(), "workerPid": self.worker_pid, "workerArgv0": argv0,
                  "workerExecutable": os.path.realpath(f"/proc/{self.worker_pid}/exe"),
                  "backendExecutable": sys.executable, "backendRealExecutable": os.path.realpath(sys.executable),
                  "python": sys.version.split()[0], "prefix": sys.prefix}
        self.assertEqual((record["workerArgv0"], record["workerExecutable"]),
                         (record["backendExecutable"], record["backendRealExecutable"]))
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory) / "worker-interpreter"
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps(record, indent=2))

    def top_frame(self, line, filename):
        stack = self.ok("stackTrace", {"threadId": 1})
        self.assertGreaterEqual(stack["totalFrames"], 2)
        frame = stack["stackFrames"][0]
        self.assertEqual((frame["line"], frame["column"], Path(frame["source"]["path"]).name), (line, 1, filename))
        paged = self.ok("stackTrace", {"threadId": 1, "startFrame": 0, "levels": 1})
        self.assertEqual(paged["stackFrames"], [frame])
        return frame

    def variables(self, frame):
        scopes = self.ok("scopes", {"frameId": frame["id"]})["scopes"]
        reference = scopes[0]["variablesReference"]
        return reference, {v["name"]: v for v in self.ok("variables", {"variablesReference": reference})["variables"]}

    def finish(self):
        self.assertEqual(self.event("exited")["exitCode"], 0)
        self.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertFalse(self.client.stderr, self.client.stderr)
        self.assertEqual(children(self.client.process.pid), [])
        root = ET.parse(self.workspace / "output.xml").getroot()
        self.assertEqual(root.find("./suite/test/status").get("status"), "PASS")
        return root

    def test_pause_live_console_step_and_stale_handles(self):
        frame = self.launch_to_pause()
        reference, variables = self.variables(frame)
        self.assertEqual(variables["${SUITE_VALUE}"]["value"], "'from-suite'")
        evaluation = self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                                             "expression": "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console"})
        self.assertEqual(evaluation["result"], "'from-suite-console'")
        self.assertNotIn("${CONSOLE_MARKER}", variables)
        self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                             "expression": r"Set Test Variable    \${CONSOLE_MARKER}    console-only-Ada"})
        self.assertEqual(children(self.client.process.pid), [self.worker_pid], "Console spawned a second Robot run")
        for args in ({"frameId": frame["id"], "expression": "Log    x", "context": "hover"},
                     {"frameId": frame["id"], "expression": "Log    x\nLog    y", "context": "repl"}):
            self.assertFalse(self.client.request("evaluate", args)["success"])
        self.ok("next", {"threadId": 1})
        self.assertEqual(self.event("stopped")["reason"], "step")
        later = self.top_frame(13, "audit.robot")
        self.assertNotEqual(later["id"], frame["id"])
        self.assertFalse(self.client.request("scopes", {"frameId": frame["id"]})["success"])
        self.assertFalse(self.client.request("variables", {"variablesReference": reference})["success"])
        _, current = self.variables(later)
        self.assertEqual(current["${CONSOLE_MARKER}"]["value"], "'console-only-Ada'")
        record = current["${record}"]
        fields = {v["name"]: v for v in self.ok("variables", {"variablesReference": record["variablesReference"]})["variables"]}
        self.assertEqual(fields["name"]["value"], "'Ada'")
        self.assertEqual(fields["count"]["value"], "3")
        result = self.ok("evaluate", {"frameId": later["id"], "context": "repl",
                                         "expression": "Resource Step    ${record.name}"})
        self.assertEqual(result["result"], "None")
        self.ok("stepIn", {"threadId": 1})
        self.assertEqual(self.event("stopped")["reason"], "step")
        self.top_frame(5, "shared.resource")
        self.ok("next", {"threadId": 1})
        self.assertEqual(self.event("stopped")["reason"], "step")
        self.top_frame(14, "audit.robot")
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertIn("Ada", [message.text for message in root.iter("msg")])

    def stop_paused(self, command):
        frame = self.launch_to_pause()
        reference, _ = self.variables(frame)
        self.ok(command, {"terminateDebuggee": True})
        self.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        if command != "disconnect":
            self.assertFalse(self.client.request("scopes", {"frameId": frame["id"]})["success"])
            self.assertFalse(self.client.request("variables", {"variablesReference": reference})["success"])
            self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()

    def test_terminate_paused_worker(self):
        self.stop_paused("terminate")

    def test_disconnect_paused_worker(self):
        self.stop_paused("disconnect")

    def test_client_eof_reaps_paused_worker(self):
        self.launch_to_pause()
        self.client.process.stdin.close()
        self.assertEqual(self.client.process.wait(timeout=10), 1)
        self.client.drain()
        self.assertEqual(processes_in(self.workspace), [])


if __name__ == "__main__":
    unittest.main()

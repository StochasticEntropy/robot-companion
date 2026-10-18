"""Required two-session RF/debugpy conformance. No mocks or prerequisite skips."""

import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import DapClient, SocketDapClient
from test_dap_lifecycle import children, processes_in

FIXTURES = Path(__file__).parent / "fixtures"


class MixedPythonLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot.version import VERSION
        if VERSION != "7.5" or importlib.metadata.version("debugpy") != "1.8.17":
            raise AssertionError("Mixed conformance requires RF 7.5 and debugpy 1.8.17")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent mixed conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-mixed-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.client = DapClient()
        self.python = None
        self.handoff = None

    def tearDown(self):
        self.client.close()  # Parent must own cleanup, including the child DAP connection.
        if self.python is not None:
            self.python.reader.join(timeout=5)
            closed_by_parent = not self.python.reader.is_alive()
            self.python.close()
        else:
            closed_by_parent = True
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "robot": self.client.transcript, "python": self.python.transcript if self.python else [],
                "stderr": self.client.stderr.decode(errors="replace"), "handoff": self.handoff}, indent=2))
            source = self.workspace / "output.xml"
            if source.exists():
                shutil.copyfile(source, target / (self.id() + ".output.xml"))
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertTrue(closed_by_parent, "Child session survived parent cleanup")
            self.assertEqual(processes_in(self.workspace), [], "Owned mixed-session process leaked")
            if self.handoff:
                self.assertFalse(Path(f"/proc/{self.handoff['adapter']['processId']}").exists())
                with self.assertRaises(OSError):
                    with socket.create_connection((self.handoff["connect"]["host"], self.handoff["connect"]["port"]),
                                                  timeout=1):
                        pass
        finally:
            shutil.rmtree(self.workspace)

    def ok(self, client, command, args=None):
        reply = client.request(command, args)
        self.assertTrue(reply["success"], reply)
        return reply.get("body", {})

    def launch(self):
        caps = self.ok(self.client, "initialize", {"adapterID": "robot-companion-native", "pathFormat": "path"})
        self.assertNotIn("robotCompanionPythonHandoff", caps, "Unproven optional capability advertised")
        self.ok(self.client, "launch", {"cwd": str(self.workspace), "target": "audit.robot",
                                         "pythonDebug": {"handoffVersion": 1}})
        self.handoff = self.client.event("robotCompanion/pythonSession")
        self.assertEqual((self.handoff["version"], self.handoff["phase"]), (1, "start"))
        self.assertTrue(self.handoff["sessionId"])
        self.assertEqual(self.handoff["owner"]["processId"], self.client.process.pid)
        self.assertEqual(self.handoff["adapter"]["version"], "1.8.17")
        self.assertEqual(self.handoff["connect"]["host"], "127.0.0.1")
        self.assertEqual(set(children(self.client.process.pid)), {
            self.handoff["owner"]["debuggeeProcessId"], self.handoff["adapter"]["processId"]})
        self.client.event("initialized")
        self.assertFalse(self.client.request("configurationDone")["success"], "Robot ran before Python attach")
        self.python = SocketDapClient(self.handoff["connect"])
        self.ok(self.python, "initialize", {"adapterID": "debugpy", "linesStartAt1": True,
                                            "columnsStartAt1": True, "pathFormat": "path"})
        configuration = dict(self.handoff["configuration"])
        self.assertEqual(configuration.pop("request"), "attach")
        attach = self.python.start_request("attach", configuration)
        self.python.event("initialized")
        self.ok(self.python, "setBreakpoints", {"source": {"path": str(self.workspace / "AuditLibrary.py")},
                                                "breakpoints": [{"line": 18}]})
        self.ok(self.python, "configurationDone")
        self.assertTrue(self.python.response(attach)["success"])
        connected = self.client.event("robotCompanion/pythonConnected")
        self.assertEqual(connected["sessionId"], self.handoff["sessionId"])
        self.assertEqual(connected["debuggeeProcessId"], self.handoff["owner"]["debuggeeProcessId"])
        self.ok(self.client, "setBreakpoints", {"source": {"path": str(self.workspace / "audit.robot")},
                                                "breakpoints": [{"line": 12}, {"line": 13}]})
        self.ok(self.client, "configurationDone")
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        frame = self.robot_frame(12)
        result = self.ok(self.client, "evaluate", {"frameId": frame["id"], "context": "repl",
                     "expression": "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console"})
        self.assertEqual(result["result"], "'from-suite-console'")
        return frame

    def robot_frame(self, line):
        frame = self.ok(self.client, "stackTrace", {"threadId": 1})["stackFrames"][0]
        self.assertEqual((frame["line"], Path(frame["source"]["path"]).name), (line, "audit.robot"))
        return frame

    def stop_in_python(self):
        robot_frame = self.launch()
        self.ok(self.client, "continue", {"threadId": 1})
        stopped = self.python.event("stopped")
        self.assertEqual(stopped["reason"], "breakpoint")
        thread_id = stopped["threadId"]
        frames = self.ok(self.python, "stackTrace", {"threadId": thread_id})["stackFrames"]
        frame = next(f for f in frames if Path(f.get("source", {}).get("path", "")).name == "AuditLibrary.py")
        self.assertEqual(frame["line"], 18)
        self.assertFalse(self.client.request("scopes", {"frameId": robot_frame["id"]})["success"])
        return thread_id, frame

    def test_python_step_count_and_return_to_live_robot_context(self):
        thread_id, _ = self.stop_in_python()
        self.ok(self.python, "next", {"threadId": thread_id})
        self.python.event("stopped")
        frame = self.ok(self.python, "stackTrace", {"threadId": thread_id})["stackFrames"][0]
        self.assertEqual((Path(frame["source"]["path"]).name, frame["line"]), ("AuditLibrary.py", 19))
        scopes = self.ok(self.python, "scopes", {"frameId": frame["id"]})["scopes"]
        variables = []
        for scope in scopes:
            variables.extend(self.ok(self.python, "variables", {"variablesReference": scope["variablesReference"]})["variables"])
        self.assertIn(("count", "3"), [(v["name"], v["value"]) for v in variables])
        self.assertEqual(self.ok(self.python, "evaluate", {"frameId": frame["id"], "expression": "count",
                                                             "context": "repl"})["result"], "3")
        self.ok(self.python, "continue", {"threadId": thread_id})
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        # Explicit session/frame selection: use the Robot connection and a newly
        # obtained Robot frame, never route the Python frame to the Robot console.
        robot = self.robot_frame(13)
        result = self.ok(self.client, "evaluate", {"frameId": robot["id"], "context": "repl",
                                                     "expression": "Resource Step    ${record.name}"})
        self.assertEqual(result["result"], "None")
        self.ok(self.client, "evaluate", {"frameId": robot["id"], "context": "repl",
                       "expression": r"Set Test Variable    \${MIXED_MARKER}    console-only-${record.name}"})
        scope = self.ok(self.client, "scopes", {"frameId": robot["id"]})["scopes"][0]
        visible = self.ok(self.client, "variables", {"variablesReference": scope["variablesReference"]})["variables"]
        self.assertIn(("${MIXED_MARKER}", "'console-only-Ada'"), [(v["name"], v["value"]) for v in visible])
        self.ok(self.client, "continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        ended = self.client.event("robotCompanion/pythonSession")
        self.assertEqual((ended["phase"], ended["sessionId"]), ("end", self.handoff["sessionId"]))
        self.assertFalse(self.client.request("scopes", {"frameId": robot["id"]})["success"])
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        root = ET.parse(self.workspace / "output.xml").getroot()
        self.assertEqual(root.find("./suite/test/status").get("status"), "PASS")
        self.assertIn("Ada", [message.text for message in root.iter("msg")])

    def stop_mixed(self, command):
        self.stop_in_python()
        self.ok(self.client, command, {"terminateDebuggee": True})
        self.client.event("terminated")
        if command != "disconnect":
            self.assertFalse(self.client.request("stackTrace", {"threadId": 1})["success"])
            self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    def test_parent_terminate_while_python_paused(self):
        self.stop_mixed("terminate")

    def test_parent_disconnect_while_python_paused(self):
        self.stop_mixed("disconnect")

    def test_parent_eof_while_python_paused(self):
        self.stop_in_python()
        self.client.process.stdin.close()
        self.assertEqual(self.client.process.wait(timeout=15), 1)

    def test_child_loss_escalates_when_worker_ignores_term(self):
        library = self.workspace / "AuditLibrary.py"
        with library.open("a") as stream:
            stream.write("\nimport signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n")
        self.test_child_connection_loss_terminates_owned_robot()

    def test_child_connection_loss_terminates_owned_robot(self):
        self.stop_in_python()
        self.python.close()
        self.client.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()

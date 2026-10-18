"""Real-subprocess DAP lifecycle checks; live Robot pause/evaluate/debugpy are separate suites."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from client import DapClient
from robot_companion_backend.dap import CAPABILITIES, PENDING_BREAKPOINT
from robot_companion_backend.protocol import FramedStream

FIXTURES = Path(__file__).parent / "fixtures"


def require_process_observation():
    if not Path("/proc/self/stat").is_file() or not Path("/proc/self/cwd").is_symlink():
        raise RuntimeError("Cleanup conformance requires observable Linux /proc process state")


def children(pid):
    """Direct child processes of pid, including unreaped zombies."""
    require_process_observation()
    found = []
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text().rsplit(")", 1)[1].split()
        except OSError:
            continue
        if int(fields[1]) == pid:
            found.append(int(stat.parent.name))
    return found


def processes_in(directory):
    """Every process, at any depth or after reparenting, whose cwd is directory."""
    require_process_observation()
    found = []
    for link in Path("/proc").glob("[0-9]*/cwd"):
        try:
            if Path(os.readlink(link)) == directory:
                found.append(int(link.parent.name))
        except OSError:
            continue
    return found


class DapLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.client = DapClient()

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2))
        shutil.rmtree(self.workspace)

    def initialize(self):
        reply = self.client.request("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                                   "columnsStartAt1": True, "pathFormat": "path"})
        self.assertTrue(reply["success"], reply)
        return reply

    def disconnect_and_exit(self):
        reply = self.client.request("disconnect", {"terminateDebuggee": True})
        self.assertTrue(reply["success"], reply)
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse(self.client.stderr, self.client.stderr)

    def test_initialize_advertises_only_implemented_capabilities(self):
        early = self.client.request("threads")
        self.assertFalse(early["success"])
        self.assertIn("not initialized", early["message"])
        reply = self.initialize()
        self.assertEqual(reply["command"], "initialize")
        self.assertEqual({k for k, v in reply["body"].items() if v}, set(CAPABILITIES))
        for unsupported in ("supportsEvaluateForHovers", "supportsStepBack", "supportsSetVariable",
                            "supportsFunctionBreakpoints", "supportsConditionalBreakpoints"):
            self.assertNotIn(unsupported, reply["body"])
        self.assertFalse(self.client.request("initialize", {})["success"])
        unsupported = self.client.request("evaluate", {"expression": "Log    x", "context": "repl"})
        self.assertFalse(unsupported["success"])
        self.assertEqual(unsupported["message"], "Robot worker is not paused")
        self.assertEqual(self.client.request("threads")["body"], {"threads": []})
        for args in ({"source": []}, {"source": {"path": "audit.robot"}, "breakpoints": {}},
                     {"source": {"path": "audit.robot"}, "breakpoints": [{"line": 12, "condition": "x"}]}):
            self.assertFalse(self.client.request("setBreakpoints", args)["success"])
        for command in ("stackTrace", "scopes", "variables", "continue", "next", "stepIn"):
            self.assertFalse(self.client.request(command, {"threadId": 1})["success"])
        sequence = [m["received"]["seq"] for m in self.client.transcript if "received" in m]
        self.assertEqual(sequence, sorted(set(sequence)))
        self.disconnect_and_exit()

    @unittest.skipIf(importlib.util.find_spec("robot") is not None,
                     "Robot Framework is present; the live DAP suite owns the successful-launch lifecycle")
    def test_launch_without_robot_reports_prerequisite_and_reaps_worker(self):
        self.initialize()
        breakpoints = self.client.request("setBreakpoints", {
            "source": {"path": str(self.workspace / "audit.robot")}, "breakpoints": [{"line": 12}]})
        self.assertTrue(breakpoints["success"])
        self.assertEqual(breakpoints["body"]["breakpoints"], [{
            "id": 1, "verified": False, "line": 12, "source": {"path": str(self.workspace / "audit.robot")},
            "message": PENDING_BREAKPOINT}])
        missing = self.client.request("launch", {"target": "missing.robot", "cwd": str(self.workspace)})
        self.assertFalse(missing["success"])
        self.assertIn("not found", missing["message"])
        launch = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace)})
        self.assertFalse(launch["success"], launch)
        self.assertIn("Robot Framework 7.5 is required", launch["message"])
        self.assertIn("No module named 'robot'", launch["message"])
        self.assertIn("worker exit code 3", launch["message"])
        self.assertEqual(launch["body"]["error"]["format"], launch["message"])
        self.assertEqual(children(self.client.process.pid), [])
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse([e for e in self.client.events if e.get("event") in ("process", "initialized", "exited")])
        self.assertEqual(self.client.request("threads")["body"], {"threads": []})
        self.assertFalse(self.client.request("configurationDone")["success"])
        self.assertTrue(self.client.request("terminate")["success"])
        self.disconnect_and_exit()
        self.assertEqual([e["event"] for e in self.client.events if e.get("type") == "event"].count("terminated"), 1)

    def test_failed_process_creation_closes_private_pipes(self):
        self.initialize()
        directory = Path(f"/proc/{self.client.process.pid}/fd")
        before = len(list(directory.iterdir()))
        # NUL validation and Linux's real Popen single-argument size failure.
        # No worker is created; private parent FDs must be closed.
        for argument in ("\0", "x" * 300000):
            failed = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace),
                                                    "args": [argument]})
            self.assertFalse(failed["success"], failed)
            self.assertEqual(len(list(directory.iterdir())), before)
            self.assertEqual(children(self.client.process.pid), [])
        self.disconnect_and_exit()

    def test_python_handoff_version_and_prerequisite(self):
        self.initialize()
        for option in ({"handoffVersion": 2}, {"handoffVersion": True}, {}, True, {"handoffVersion": 1, "extra": True}):
            reply = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace),
                                                    "pythonDebug": option})
            self.assertFalse(reply["success"], reply)
            self.assertIn("handoffVersion", reply["message"])
        if importlib.util.find_spec("debugpy") is None:
            directory = Path(f"/proc/{self.client.process.pid}/fd")
            before = len(list(directory.iterdir()))
            failed = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace),
                                                    "pythonDebug": {"handoffVersion": 1}})
            self.assertFalse(failed["success"], failed)
            self.assertIn("debugpy 1.8.17 is required", failed["message"])
            self.assertEqual(len(list(directory.iterdir())), before)
            self.assertEqual(children(self.client.process.pid), [])
            self.assertFalse([e for e in self.client.events if e.get("event") == "robotCompanion/pythonSession"])
        self.disconnect_and_exit()

    def test_malformed_requests_and_frames(self):
        self.initialize()
        for message, request_seq in (({"seq": 7, "type": "request"}, 7),
                                     ({"seq": 8, "type": "request", "command": "threads", "arguments": []}, 8),
                                     ({"type": "request", "command": "threads"}, 0),
                                     ({"seq": 9, "type": "event", "event": "threads"}, 9)):
            with self.subTest(message=message):
                self.client.raw(message)
                reply = self.client.response(request_seq)
                self.assertFalse(reply["success"])
                self.assertEqual(reply["message"], "Invalid DAP request")
        self.assertTrue(self.client.request("threads")["success"])
        self.client.process.stdin.write(b"Content-Length: 1\r\n\r\n{")
        self.client.process.stdin.flush()
        self.assertEqual(self.client.process.wait(timeout=10), 1)
        events = self.client.drain()
        self.assertTrue(any(e.get("event") == "output" and e["body"]["category"] == "important"
                            and "DAP protocol error" in e["body"]["output"] for e in events))
        self.assertFalse(self.client.stderr)

    def test_bad_frame_real_subprocess(self):
        result = subprocess.run([sys.executable, "-m", "robot_companion_backend", "dap"],
                                input=b"Content-Length: " + b"9" * 5000 + b"\r\n\r\n",
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(result.stderr)
        event = FramedStream(io.BytesIO(result.stdout), None).read()
        self.assertEqual((event["type"], event["event"], event["body"]["category"]), ("event", "output", "important"))


if __name__ == "__main__":
    unittest.main()

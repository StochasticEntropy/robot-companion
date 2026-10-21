"""Required real RF/debugpy conformance and isolated worker-identity checks."""

import importlib.metadata
import io
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from client import DapClient, SocketDapClient
import processes
from test_dap_lifecycle import children, processes_in
from robot_companion_backend.dap import DebugAdapter, RequestError, Worker
from robot_companion_backend.protocol import FramedStream, ProtocolError
from robot_companion_backend.python_debug import PythonSession, SessionSocket

FIXTURES = Path(__file__).parent / "fixtures"


class SessionSocketTests(unittest.TestCase):
    def test_stop_interrupts_partial_frame_without_peer_disconnect(self):
        local, peer = socket.socketpair()
        self.addCleanup(peer.close)
        self.addCleanup(local.close)
        local.setblocking(False)
        stopping = threading.Event()
        entered, errors = threading.Event(), []
        class ObservedSocket(SessionSocket):
            def readinto(self, buffer):
                count = super().readinto(buffer)
                if count:
                    entered.set()
                return count
        reader = io.BufferedReader(ObservedSocket(local, stopping))
        self.addCleanup(reader.close)
        peer.sendall(b"Content-Length: 10\r\n\r\nx")
        def read():
            try:
                FramedStream(reader, None).read()
            except ProtocolError as exc:
                errors.append(str(exc))
        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(timeout=1))
        stopping.set()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive(), "partial-frame read survived stop with peer still connected")
        self.assertEqual(errors, ["Incomplete message body"])

    def test_nonblocking_writer_preserves_complete_framing(self):
        local, peer = socket.socketpair()
        self.addCleanup(peer.close)
        self.addCleanup(local.close)
        local.setblocking(False)
        writer = SessionSocket(local, threading.Event())
        self.addCleanup(writer.close)
        message = {"type": "event", "event": "output", "body": {"output": "Grüße 😀"}}
        FramedStream(None, writer).write(message)
        with peer.makefile("rb") as reader:
            self.assertEqual(FramedStream(reader, None).read(), message)

    def test_stopped_writer_refuses_more_data(self):
        local, peer = socket.socketpair()
        self.addCleanup(peer.close)
        self.addCleanup(local.close)
        local.setblocking(False)
        stopping = threading.Event()
        stopping.set()
        with SessionSocket(local, stopping) as writer, self.assertRaises(OSError):
            writer.write(b"data")


class MixedPythonLiveTests(unittest.TestCase):
    """Both live DAP connections and their owned processes; no mocks or prerequisite skips."""

    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if (reason := unsupported_reason()) or importlib.metadata.version("debugpy") != "1.8.22":
            raise AssertionError(f"Mixed conformance requires a supported row and debugpy 1.8.22: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent mixed conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-mixed-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.client = DapClient()
        self.python = None
        self.handoff = None
        self.tree = {}

    def tearDown(self):
        self.tree.update(processes.descendants(self.client.backend_pid))
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
                "stderr": self.client.stderr.decode(errors="replace"), "handoff": self.handoff}, indent=2), encoding="utf-8")
            source = self.workspace / "output.xml"
            if source.exists():
                shutil.copyfile(source, target / (self.id() + ".output.xml"))
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertTrue(closed_by_parent, "Child session survived parent cleanup")
            self.assertEqual(processes_in(self.workspace), [], "Owned mixed-session process leaked")
            if self.handoff:
                # The debugpy adapter, the Robot worker and their Python processes are gone.
                self.assertIn(self.handoff["adapter"]["processId"], self.tree)
                deadline = time.monotonic() + 10
                while (left := processes.alive(self.tree)) and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(left, {}, "Owned mixed-session process leaked")
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
        self.tree.update(processes.descendants(self.client.backend_pid))
        self.assertEqual((self.handoff["version"], self.handoff["phase"]), (1, "start"))
        self.assertTrue(self.handoff["sessionId"])
        self.assertEqual(self.handoff["owner"]["processId"], self.client.backend_pid)
        self.assertEqual(self.handoff["adapter"]["version"], "1.8.22")
        self.assertEqual(self.handoff["connect"]["host"], "127.0.0.1")
        worker_root = self.client.event("process")["systemProcessId"]
        self.assertEqual(set(children(self.client.backend_pid)), {
            worker_root, self.handoff["adapter"]["processId"]})
        # The owned tree starts at the launcher on Windows; the advertised debuggee
        # is the actual interpreter, independently observed through that launcher.
        debuggee = processes.interpreter_pid(worker_root)
        self.assertEqual(self.handoff["owner"]["debuggeeProcessId"], debuggee)
        self.assertIn(debuggee, self.tree)
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
        # Every owned process (on Windows also the interpreters below venv launchers).
        self.tree.update(processes.descendants(self.client.backend_pid))
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
        with library.open("a", encoding="utf-8") as stream:
            stream.write("\nimport signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n")
        self.test_child_connection_loss_terminates_owned_robot()

    def test_child_connection_loss_terminates_owned_robot(self):
        self.stop_in_python()
        self.python.close()
        self.client.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)


class WorkerIdentityTests(unittest.TestCase):
    """Contract checks with distinct launcher/interpreter PIDs, on every platform."""

    def worker(self, pid):
        worker = Worker.__new__(Worker)
        worker.ready = False
        worker.interpreter_pid = None
        worker.process = mock.Mock(pid=1111, returncode=0)
        worker.tree = mock.Mock()
        worker.replies = queue.Queue()
        worker.replies.put({"event": "ready", "processId": pid})
        worker.stop = mock.Mock()
        return worker

    def test_authenticated_readiness_records_interpreter_not_launcher(self):
        worker = self.worker(2222)
        worker.wait_ready()
        self.assertEqual(worker.interpreter_pid, 2222)
        self.assertNotEqual(worker.interpreter_pid, worker.process.pid)
        self.assertTrue(worker.ready)
        worker.stop.assert_not_called()

    def test_invalid_readiness_identity_fails_and_stops_owned_tree(self):
        for pid in (None, True, "2222", 0, -1):
            with self.subTest(pid=pid):
                worker = self.worker(pid)
                with self.assertRaisesRegex(RequestError, "invalid interpreter identity"):
                    worker.wait_ready()
                self.assertFalse(worker.ready)
                self.assertIsNone(worker.interpreter_pid)
                worker.stop.assert_called_once_with()

    def test_handoff_advertises_authenticated_interpreter_and_keeps_tree_root(self):
        worker = self.worker(2222)
        session = PythonSession.__new__(PythonSession)
        session.session_id, session.endpoint = "identity-test", ("127.0.0.1", 12345)
        session.process = mock.Mock(pid=3333)
        session.start, session.tree, session.lost = mock.Mock(), mock.Mock(), threading.Event()
        session.tree.poll.return_value = None
        adapter = DebugAdapter(mock.Mock())
        adapter.event = mock.Mock()
        with mock.patch("robot_companion_backend.dap.Worker", return_value=worker), \
                mock.patch("robot_companion_backend.dap.PythonSession", return_value=session):
            adapter.launch({"cwd": str(FIXTURES), "target": "audit.robot",
                            "pythonDebug": {"handoffVersion": 1}})
        events = {call.args[0]: call.args[1] for call in adapter.event.call_args_list}
        self.assertEqual(events["process"]["systemProcessId"], 1111)
        self.assertEqual(events["robotCompanion/pythonSession"]["owner"]["debuggeeProcessId"], 2222)
        self.assertIs(adapter.worker, worker)

    def test_connected_identity_must_match_authenticated_readiness(self):
        adapter = DebugAdapter(mock.Mock())
        adapter.worker = self.worker(2222)
        adapter.worker.wait_ready()
        adapter.python = mock.Mock(session_id="identity-test", connected=False)
        adapter.python_session_lost = mock.Mock()
        invalid = ((1, 1111), (1, True), (1, "2222"), (1, None), (True, 2222), (2, 2222))
        for version, pid in invalid:
            with self.subTest(version=version, pid=pid), \
                    self.assertRaisesRegex(ProtocolError, "identity does not match"):
                adapter.python_connected({"version": version, "sessionId": "identity-test", "debuggeeProcessId": pid})
            self.assertFalse(adapter.python.connected)
        self.assertEqual(adapter.python_session_lost.call_count, len(invalid))
        adapter.python_connected({"version": 1, "sessionId": "identity-test", "debuggeeProcessId": 2222})
        self.assertTrue(adapter.python.connected)


if __name__ == "__main__":
    unittest.main()

"""Real-subprocess DAP lifecycle checks; live Robot pause/evaluate/debugpy are separate suites."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from client import Client, DapClient
import processes
from robot_companion_backend.dap import CAPABILITIES, EXTERNAL_ATTACH, NO_DETACH, PENDING_BREAKPOINT, PLAIN_ATTACH
from robot_companion_backend.protocol import FramedStream

FIXTURES = Path(__file__).parent / "fixtures"


def children(pid):
    """Direct child processes of pid, including unreaped zombies (Linux /proc, Windows snapshot)."""
    return processes.children(pid)


def processes_in(directory):
    """Processes whose working directory is directory (see processes.processes_in)."""
    return processes.processes_in(directory)


class ClientIdentityTests(unittest.TestCase):
    """Harness identity capture must happen before a Windows launcher can exit."""

    def test_windows_tcp_observation_distinguishes_listener_and_time_wait(self):
        address = struct.unpack("<I", socket.inet_aton("127.0.0.1"))[0]
        data = struct.pack("<I", 2)
        data += struct.pack("<5I", 2, address, socket.htons(12345), 0, 0)
        data += struct.pack("<5I", 11, address, socket.htons(12346), 0, 0)
        self.assertEqual(processes._windows_tcp_listeners(data), {("127.0.0.1", 12345)})
        for invalid in (b"", struct.pack("<I", 1), data[:-1]):
            with self.subTest(length=len(invalid)), self.assertRaisesRegex(RuntimeError, "Truncated"):
                processes._windows_tcp_listeners(invalid)

    def test_os_listener_observation_rejects_an_open_listener(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen()
            port = server.getsockname()[1]
            self.assertIn(("127.0.0.1", port), processes.tcp_listeners())
            with self.assertRaisesRegex(AssertionError, "remains in the OS TCP table"):
                processes.assert_no_listener(self, "127.0.0.1", port, timeout=0)
        processes.assert_no_listener(self, "127.0.0.1", port)

    def fake_process(self):
        process = mock.Mock(pid=1001, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
        process.poll.return_value = None
        return process

    def test_backend_interpreter_and_creation_identity_are_cached_while_live(self):
        process = self.fake_process()
        identity = {"start": 123456789, "parent": 1001, "state": "R", "group": None, "image": "python.exe"}
        def resolve(pid, exited):
            self.assertEqual(pid, process.pid)
            self.assertFalse(exited())
            return 1002  # actual interpreter below the venv launcher
        with mock.patch("client.subprocess.Popen", return_value=process), \
                mock.patch("client.threading.Thread"), \
                mock.patch.object(processes, "interpreter_pid", side_effect=resolve) as resolver, \
                mock.patch.object(processes, "identity", return_value=identity) as observe:
            client = Client()
            resolver.assert_called_once()
            observe.assert_called_once_with(1002)
            process.poll.return_value = 0
            resolver.side_effect = AssertionError("Exited process must not be queried")
            observe.side_effect = AssertionError("Exited process must not be queried")
            self.assertEqual(client.backend_pid, 1002)
            self.assertEqual(client.backend_identity["start"], 123456789)
            self.assertEqual(client.backend_identity, identity)

    def test_missing_creation_identity_fails_and_cleans_up(self):
        for identity in (None, {"start": None}):
            with self.subTest(identity=identity):
                process = self.fake_process()
                with mock.patch("client.subprocess.Popen", return_value=process), \
                        mock.patch("client.threading.Thread"), \
                        mock.patch.object(processes, "interpreter_pid", return_value=1002), \
                        mock.patch.object(processes, "identity", return_value=identity):
                    with self.assertRaisesRegex(AssertionError, "Could not capture backend process identity"):
                        Client()
                process.kill.assert_called_once()
                process.wait.assert_called_once_with(timeout=5)
                self.assertTrue(all(pipe.closed for pipe in (process.stdin, process.stdout, process.stderr)))

    def test_owned_process_identity_must_not_silently_disappear(self):
        client = Client.__new__(Client)
        client.owned_processes = {}
        for identity in (None, {"start": None}):
            with self.subTest(identity=identity), mock.patch.object(processes, "identity", return_value=identity):
                with self.assertRaisesRegex(AssertionError, "Could not capture owned process identity: 1002"):
                    client._remember_owned({"event": "process", "body": {"systemProcessId": 1002}})
        self.assertEqual(client.owned_processes, {})

    def test_exited_windows_launcher_fails_before_querying_its_image(self):
        with mock.patch.object(processes, "WINDOWS", True), \
                mock.patch.object(sys, "_base_executable", "/base/python", create=True), \
                mock.patch.object(processes, "image_path") as image:
            with self.assertRaisesRegex(AssertionError, "capture it while live"):
                processes.interpreter_pid(1001, exited=lambda: True)
            image.assert_not_called()


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
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2),
                encoding="utf-8")
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
        self.assertTrue(reply["body"]["supportsConditionalBreakpoints"] and reply["body"]["supportsLogPoints"])
        self.assertTrue(reply["body"]["supportsHitConditionalBreakpoints"] and reply["body"]["supportsSetVariable"])
        self.assertEqual([(f["filter"], f["default"]) for f in reply["body"]["exceptionBreakpointFilters"]],
                         [("robot-failed-keyword", False), ("robot-failed-test", False)])
        for unsupported in ("supportsEvaluateForHovers", "supportsStepBack", "supportsFunctionBreakpoints",
                            "supportsDataBreakpoints", "supportsExceptionOptions", "supportsExceptionFilterOptions",
                            "supportsExceptionInfoRequest", "supportsSetExpression", "supportsInvalidatedEvent"):
            self.assertNotIn(unsupported, reply["body"])
        self.assertFalse(self.client.request("initialize", {})["success"])
        unsupported = self.client.request("evaluate", {"expression": "Log    x", "context": "repl"})
        self.assertFalse(unsupported["success"])
        self.assertEqual(unsupported["message"], "Robot worker is not paused")
        self.assertEqual(self.client.request("threads")["body"], {"threads": []})
        for args in ({"source": []}, {"source": {"path": "audit.robot"}, "breakpoints": {}},
                     {"source": {"path": "audit.robot"}, "breakpoints": [{"line": 12, "hitCondition": "0"}]},
                     {"source": {"path": "audit.robot"}, "breakpoints": [{"line": 12, "condition": 1}]},
                     {"source": {"path": "audit.robot"}, "breakpoints": [{"line": 12, "logMessage": None}]}):
            self.assertFalse(self.client.request("setBreakpoints", args)["success"])
        for command in ("stackTrace", "scopes", "variables", "continue", "next", "stepIn"):
            self.assertFalse(self.client.request(command, {"threadId": 1})["success"])
        sequence = [m["received"]["seq"] for m in self.client.transcript if "received" in m]
        self.assertEqual(sequence, sorted(set(sequence)))
        self.disconnect_and_exit()

    def test_unsupported_lifecycle_paths_fail_deterministically(self):
        before = self.client.request("restart")
        self.assertEqual((before["success"], before["message"]), (False, "Debug adapter not initialized"))
        capabilities = self.initialize()["body"]
        self.assertTrue(capabilities["supportsRestartRequest"] and capabilities["supportsCancelRequest"])
        for unsupported in ("supportTerminateDebuggee", "supportSuspendDebuggee", "supportsAttachRequest"):
            self.assertNotIn(unsupported, capabilities)
        refusals = [("attach", {}, PLAIN_ATTACH), ("attach", {"name": "x", "preparedSession": "/tmp/s.json"}, PLAIN_ATTACH)]
        refusals += [("attach", {key: value}, EXTERNAL_ATTACH) for key, value in
                     (("processId", 4242), ("host", "127.0.0.1"), ("port", 5678), ("connect", {"port": 1}),
                      ("secret", "ab" * 32))]
        refusals += [("restart", {}, "restart requires a configured Robot run"),
                     ("restart", {"arguments": {"target": "audit.robot"}}, "restart requires a configured Robot run"),
                     ("cancel", {"requestId": "7"}, "cancel 'requestId' must be an integer")]
        for command, arguments, message in refusals:
            with self.subTest(command=command, arguments=arguments):
                reply = self.client.request(command, arguments)
                self.assertEqual((reply["success"], reply["message"]), (False, message))
        for arguments in ({"requestId": 12345}, {"progressId": "p"}, {}):
            self.assertTrue(self.client.request("cancel", arguments)["success"])
        self.assertEqual(children(self.client.backend_pid), [])
        self.assertEqual(self.client.request("threads")["body"], {"threads": []})
        detach = self.client.request("disconnect", {"terminateDebuggee": False})
        self.assertEqual((detach["success"], detach["message"]), (False, NO_DETACH))
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        received = [m["received"] for m in self.client.transcript if "received" in m]
        self.assertEqual(received[received.index(detach) + 1:][0].get("event"), "terminated")
        self.assertEqual(processes_in(self.workspace), [])

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
        self.assertIn("Unsupported runtime in ", launch["message"])
        self.assertIn("Supported: Python 3.11 + Robot Framework 7.3.2, Python 3.13 + Robot Framework 7.5.",
                      launch["message"])
        self.assertIn("No module named 'robot'", launch["message"])
        self.assertIn("worker exit code 3", launch["message"])
        self.assertEqual(launch["body"]["error"]["format"], launch["message"])
        self.assertEqual(children(self.client.backend_pid), [])
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse([e for e in self.client.events if e.get("event") in ("process", "initialized", "exited")])
        self.assertEqual(self.client.request("threads")["body"], {"threads": []})
        self.assertFalse(self.client.request("configurationDone")["success"])
        self.assertTrue(self.client.request("terminate")["success"])
        self.disconnect_and_exit()
        self.assertEqual([e["event"] for e in self.client.events if e.get("type") == "event"].count("terminated"), 1)

    def test_failed_process_creation_closes_private_pipes(self):
        self.initialize()
        backend = self.client.backend_pid
        before = processes.handle_count(backend)
        # NUL validation and the OS's real process-creation failure for one oversized argument
        # (Linux: one argument over 128 KiB; Windows: a command line over 32,767 characters).
        # No worker is created; private parent FDs/handles must be closed.
        for argument in ("\0", "x" * 300000):
            arguments = {"target": "audit.robot", "cwd": str(self.workspace), "args": [argument]}
            if processes.WINDOWS:
                # First use initializes Windows process primitives (+29 handles in
                # run 39313217693, then flat across all 20 failures). Measure the
                # repeated-attempt leak slope after that one-time initialization.
                warmup = self.client.request("launch", arguments)
                self.assertFalse(warmup["success"], warmup)
                self.assertEqual(children(backend), [])
                before = processes.handle_count(backend)
            observed = [before]
            for _ in range(processes.HANDLE_REPEATS):
                failed = self.client.request("launch", arguments)
                self.assertFalse(failed["success"], failed)
                observed.append(processes.handle_count(backend))
            if directory := os.environ.get("RCB_TRANSCRIPTS"):
                target = Path(directory) / "handle-attempts"
                target.mkdir(parents=True, exist_ok=True)
                (target / ("invalid-argument.json" if argument == "\0" else "oversized.json")).write_text(
                    json.dumps(observed), encoding="utf-8")
            processes.assert_no_handle_leak(self, backend, before)
            self.assertEqual(children(backend), [])
        self.disconnect_and_exit()

    def test_python_handoff_version_and_prerequisite(self):
        self.initialize()
        for option in ({"handoffVersion": 2}, {"handoffVersion": True}, {}, True, {"handoffVersion": 1, "extra": True}):
            reply = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace),
                                                    "pythonDebug": option})
            self.assertFalse(reply["success"], reply)
            self.assertIn("handoffVersion", reply["message"])
        if importlib.util.find_spec("debugpy") is None:
            backend = self.client.backend_pid
            before = processes.handle_count(backend)
            for _ in range(processes.HANDLE_REPEATS):
                failed = self.client.request("launch", {"target": "audit.robot", "cwd": str(self.workspace),
                                                        "pythonDebug": {"handoffVersion": 1}})
                self.assertFalse(failed["success"], failed)
                self.assertIn("debugpy 1.8.22 is required", failed["message"])
            processes.assert_no_handle_leak(self, backend, before)
            self.assertEqual(children(backend), [])
            self.assertFalse([e for e in self.client.events if e.get("event") == "robotCompanion/pythonSession"])
        self.disconnect_and_exit()

    def test_client_close_uses_parent_eof_cleanup(self):
        self.initialize()
        self.client.close()
        self.assertEqual(self.client.process.returncode, 1)  # EOF, not SIGTERM (-15).
        self.assertFalse(self.client.forced_cleanup)

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

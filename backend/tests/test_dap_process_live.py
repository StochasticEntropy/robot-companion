"""Required real RF conformance for the worker control channel and process-tree cleanup."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import tempfile
import time
import unittest

from client import DapClient
import processes
from robot_companion_backend import control
from test_dap_lifecycle import children, processes_in
from test_process_tree import alive, wait_gone

TREE_SUITE = """*** Settings ***
Library    TreeLibrary.py

*** Test Cases ***
Tree
    Prepare Tree    ${CURDIR}${/}grandchild.pid    ${IGNORE_TERM}
    Log    tree-started
    Log    tree-finished
"""
TREE_LIBRARY = """import pathlib, signal, subprocess, sys


def prepare_tree(marker, ignore_term):
    guard = "signal.signal(signal.SIGTERM, signal.SIG_IGN); " if ignore_term == "yes" else ""
    if ignore_term == "yes":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)  # the worker itself, too
    child = subprocess.Popen([sys.executable, "-c", "import signal, time; " + guard + "time.sleep(120)"])
    pathlib.Path(marker).write_text(str(child.pid))
"""
# Test-only startup hook: hold the worker before it connects, so a foreign client
# can reach the adapter's control listener first.
DELAY_HOOK = """import json, os, pathlib, sys, time
# Every Python process with this hook records its environment variable names (never values).
pathlib.Path(__file__).with_name(f"env-{os.getpid()}.json").write_text(json.dumps(sorted(os.environ)))
if "robot_companion_backend.worker" in getattr(sys, "orig_argv", ()):
    time.sleep(2)
"""
EXIT_HOOK = """import os, sys
if "robot_companion_backend.worker" in getattr(sys, "orig_argv", ()):
    os._exit(7)
"""
BREAK_LINE = 7


class DapProcessLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-dap-tree-")).resolve()
        (self.workspace / "tree.robot").write_text(TREE_SUITE, encoding="utf-8")
        (self.workspace / "TreeLibrary.py").write_text(TREE_LIBRARY, encoding="utf-8")
        self.hooks = None
        self.client = None

    def start_client(self, hook=None):
        env = None
        if hook:
            self.hooks = Path(tempfile.mkdtemp(prefix="rcb-hook-")).resolve()
            (self.hooks / "sitecustomize.py").write_text(hook, encoding="utf-8")
            env = os.environ.copy()
            env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(self.hooks), env.get("PYTHONPATH")]))
        self.client = DapClient(env=env)

    def tearDown(self):
        if self.client is not None:
            self.client.close()
            if directory := os.environ.get("RCB_TRANSCRIPTS"):
                target = Path(directory)
                target.mkdir(parents=True, exist_ok=True)
                (target / (self.id() + ".json")).write_text(json.dumps({
                    "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")},
                    indent=2), encoding="utf-8")
        try:
            if self.client is not None:
                self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process tree leaked")
        finally:
            shutil.rmtree(self.workspace)
            if self.hooks is not None:
                shutil.rmtree(self.hooks)

    def ok(self, command, arguments=None):
        response = self.client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def initialize(self):
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                               "columnsStartAt1": True, "pathFormat": "path"})

    def launch_arguments(self, ignore_term="no"):
        return {"target": "tree.robot", "cwd": str(self.workspace), "args": ["--variable", f"IGNORE_TERM:{ignore_term}"]}

    def configure(self, breakpoint_line=BREAK_LINE):
        self.worker_pid = self.client.event("process")["systemProcessId"]
        self.client.event("initialized")
        lines = [] if breakpoint_line is None else [{"line": breakpoint_line}]
        self.ok("setBreakpoints", {"source": {"path": str(self.workspace / "tree.robot")}, "breakpoints": lines})
        self.ok("configurationDone")

    def pause_with_grandchild(self, ignore_term="no"):
        self.initialize()
        self.ok("launch", self.launch_arguments(ignore_term))
        self.configure()
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        grandchild = int((self.workspace / "grandchild.pid").read_text(encoding="utf-8"))
        self.assertTrue(alive(grandchild))
        self.assertEqual(children(self.client.backend_pid), [self.worker_pid])
        # The whole owned tree, including each child Python process (on Windows also the base
        # interpreters below venv launchers), must be gone after cleanup; see assert_tree_gone.
        self.tree = processes.descendants(self.client.backend_pid)
        self.assertIn(grandchild, self.tree)
        return grandchild

    def assert_tree_gone(self, timeout=10):
        deadline = time.monotonic() + timeout
        while (left := processes.alive(self.tree)) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(left, {}, "Owned processes outlived the cleanup")

    def outputs(self, category="important"):
        return [e["body"]["output"] for e in self.client.events
                if e.get("event") == "output" and e["body"]["category"] == category]

    def disconnect(self):
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=15), 0)
        self.client.drain()
        self.assertEqual(children(self.client.backend_pid), [])
        self.assertFalse([o for o in self.outputs() if "cleanup failed" in o])
        self.assertFalse(self.client.stderr, self.client.stderr)

    def worker_process(self, deadline):
        while time.monotonic() < deadline:
            for pid in children(self.client.backend_pid):
                try:
                    argv = processes.argv(pid)
                except OSError:
                    continue
                if "robot_companion_backend.worker" in argv:
                    return pid, argv
            time.sleep(0.01)
        raise TimeoutError("Robot worker process did not start")

    def foreign_attempt(self, port, payload, answer_challenge):
        with socket.create_connection((control.HOST, port), timeout=10) as connection:
            connection.sendall(payload)
            replied = b""
            if answer_challenge:
                replied = control.receive_exactly(connection, control.NONCE_BYTES + control.MAC_BYTES)
                connection.sendall(os.urandom(control.MAC_BYTES))
            try:
                closed = connection.recv(1) == b""
            except ConnectionResetError:
                closed = True
            return replied, closed

    def test_foreign_control_connection_is_refused(self):
        self.start_client(DELAY_HOOK)
        self.initialize()
        launch = self.client.start_request("launch", self.launch_arguments())
        worker, argv = self.worker_process(time.monotonic() + 10)
        port = int(argv[argv.index("--control-port") + 1])
        # No secret in argv or environment: it is written only to the worker's stdin.
        self.assertEqual(argv[1:], ["-m", "robot_companion_backend.worker", "--control-port", str(port), "--",
                                    "--variable", "IGNORE_TERM:no", "tree.robot"])
        # The worker's environment has the backend's variable names, no more (hook records).
        worker_interpreter = processes.interpreter_pid(worker)
        def names(pid):
            record = self.hooks / f"env-{pid}.json"
            deadline = time.monotonic() + 10
            while not record.is_file() and time.monotonic() < deadline:
                time.sleep(0.05)
            return set(json.loads(record.read_text(encoding="utf-8")))
        self.assertEqual(names(worker_interpreter), names(self.client.backend_pid))
        self.assertEqual(self.foreign_attempt(port, b"Content-Length: 2\r\n\r\n{}" + b"x" * 64, False), (b"", True))
        replied, closed = self.foreign_attempt(port, control.HELLO + os.urandom(control.NONCE_BYTES), True)
        self.assertEqual((len(replied), closed), (control.NONCE_BYTES + control.MAC_BYTES, True))
        response = self.client.response(launch)
        self.assertTrue(response["success"], response)
        refused = [o for o in self.outputs() if o.startswith("Refused an unauthenticated Robot worker control")]
        self.assertEqual(len(refused), 2, self.outputs())
        self.assertIn("not a Robot worker control handshake", refused[0])
        self.assertIn("worker failed control authentication", refused[1])
        with self.assertRaises(ConnectionRefusedError):  # the session's only connection is the worker's
            socket.create_connection((control.HOST, port), timeout=2).close()
        self.configure()
        self.assertEqual(self.client.event("stopped")["reason"], "breakpoint")
        frame = self.ok("stackTrace", {"threadId": 1})["stackFrames"][0]
        evaluation = self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                                          "expression": "Catenate    SEPARATOR=-    channel    ok"})
        self.assertEqual(evaluation["result"], "'channel-ok'")
        grandchild = int((self.workspace / "grandchild.pid").read_text(encoding="utf-8"))
        self.ok("continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        self.assertTrue(wait_gone(grandchild), "Grandchild outlived the finished worker")
        self.disconnect()

    def test_worker_exit_before_control_channel_fails_launch(self):
        self.start_client(EXIT_HOOK)
        self.initialize()
        backend = self.client.backend_pid
        before = processes.handle_count(backend)
        for _ in range(processes.HANDLE_REPEATS):
            launch = self.client.request("launch", self.launch_arguments())
            self.assertFalse(launch["success"], launch)
            self.assertEqual(launch["message"], "Robot worker did not open its control channel (worker exit code 7)")
            self.assertEqual(children(backend), [])
        processes.assert_no_handle_leak(self, backend, before)
        self.assertFalse([e for e in self.client.events if e.get("event") in ("process", "initialized")])
        self.disconnect()

    def test_worker_crash_is_reported_and_tree_killed(self):
        self.start_client()
        grandchild = self.pause_with_grandchild()
        # An outside kill of the worker: SIGKILL, or on Windows TerminateProcess with an NTSTATUS.
        self.assertTrue(processes.kill(self.worker_pid, self.tree[self.worker_pid]))
        if processes.WINDOWS:
            code, report = processes.TERMINATED_BY_TEST, f"exit status 0x{processes.TERMINATED_BY_TEST:08X}"
        else:
            code, report = -signal.SIGKILL, "terminated by SIGKILL"
        self.assertEqual(self.client.event("exited")["exitCode"], code)
        self.client.event("terminated")
        self.assertIn(f"Robot worker crashed: {report}\n", self.outputs())
        self.assertTrue(wait_gone(grandchild), "Grandchild survived the crashed worker")
        self.assert_tree_gone()
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse(self.client.request("stackTrace", {"threadId": 1})["success"])
        self.disconnect()

    def test_terminate_kills_term_ignoring_worker_and_grandchild(self):
        self.start_client()
        grandchild = self.pause_with_grandchild(ignore_term="yes")
        started = time.monotonic()
        self.ok("terminate")
        self.client.event("terminated")
        if processes.WINDOWS:
            # No TERM step on Windows: TerminateJobObject ends the tree at once, whatever the
            # library ignores.
            self.assertLess(time.monotonic() - started, 4, "Windows stop waited for a graceful step")
        else:
            self.assertGreaterEqual(time.monotonic() - started, 4, "SIGTERM was not ignored; escalation not exercised")
        self.assertFalse(alive(self.worker_pid))
        self.assertTrue(wait_gone(grandchild))
        self.assert_tree_gone()
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse([o for o in self.outputs() if o.startswith("Robot worker crashed")])
        self.disconnect()

    def test_disconnect_kills_paused_tree(self):
        self.start_client()
        grandchild = self.pause_with_grandchild()
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=15), 0)
        self.client.drain()
        self.assertTrue(wait_gone(grandchild))
        self.assert_tree_gone()
        self.assertEqual(processes_in(self.workspace), [])
        self.assertFalse(self.client.stderr, self.client.stderr)

    def test_grandchild_left_by_a_finished_run_is_killed(self):
        self.start_client()
        self.initialize()
        self.ok("launch", self.launch_arguments())
        self.configure(breakpoint_line=None)
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        grandchild = int((self.workspace / "grandchild.pid").read_text(encoding="utf-8"))
        self.assertTrue(wait_gone(grandchild), "Grandchild outlived the finished worker")
        self.assertFalse([o for o in self.outputs() if o.startswith("Robot worker crashed")])
        self.disconnect()


if __name__ == "__main__":
    unittest.main()

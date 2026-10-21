"""Required real RF/debugpy restart, cancel and disconnect lifecycle conformance (MIS-478).

No mocks or skips: every case drives a real backend `dap` process with real Robot workers
and, for mixed sessions, a real debugpy child over the parent-owned loopback handoff."""

import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
import xml.etree.ElementTree as ET

from client import DapClient, SocketDapClient
import processes
from robot_companion_backend import dap
from robot_companion_backend.dap import CANCELLED, NO_DETACH, RESTART_CHANGED, STALE_HANDLE, DebugAdapter, Operation, \
    RequestError
from test_dap_lifecycle import processes_in

FIXTURES = Path(__file__).parent / "fixtures"
CYCLES = 10
USER_STOP = 253  # Robot's exit code for "Execution stopped by user"
WAIT_SUITE = """*** Test Cases ***
Wait
    Log To Console    before-wait
    Sleep    6s
    Log    after-wait
"""


class RestartLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if (reason := unsupported_reason()) or importlib.metadata.version("debugpy") != "1.8.22":
            raise AssertionError(f"Restart conformance requires a supported row and debugpy 1.8.22: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent restart conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-restart-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        (self.workspace / "wait.robot").write_text(WAIT_SUITE, encoding="utf-8")
        self.client = DapClient()
        self.owned = {}  # every owned process identity seen, across generations
        self.children = []

    def tearDown(self):
        self.client.close()
        for child in self.children:
            child.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "robot": self.client.transcript, "python": [c.transcript for c in self.children],
                "stderr": self.client.stderr.decode(errors="replace")}, indent=2), encoding="utf-8")
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertEqual(self.wait_gone(self.owned), {}, "Owned process survived the session")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process leaked")
        finally:
            shutil.rmtree(self.workspace)

    # -- helpers ---------------------------------------------------------------------------

    def ok(self, client, command, arguments=None):
        response = client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def failed(self, client, command, arguments=None):
        response = client.request(command, arguments)
        self.assertFalse(response["success"], response)
        return response["message"]

    def capture(self):
        found = processes.descendants(self.client.backend_pid)
        self.owned.update(found)
        return found

    def wait_gone(self, identities, timeout=10):
        deadline = time.monotonic() + timeout
        while (left := processes.alive(identities)) and time.monotonic() < deadline:
            time.sleep(0.05)
        return left

    def events_named(self, name):
        return [e for e in self.client.events if e.get("event") == name]

    def initialize(self):
        caps = self.ok(self.client, "initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                                   "columnsStartAt1": True, "pathFormat": "path"})
        self.assertTrue(caps["supportsRestartRequest"] and caps["supportsCancelRequest"])
        return caps

    def launch(self, target="audit.robot", args=(), lines=(12, 13), python=False):
        self.initialize()
        arguments = {"target": target, "cwd": str(self.workspace), "args": list(args)}
        if python:
            arguments["pythonDebug"] = {"handoffVersion": 1}
        self.ok(self.client, "launch", arguments)
        self.client.event("process")
        handoff = self.client.event("robotCompanion/pythonSession") if python else None
        self.client.event("initialized")
        pending = self.ok(self.client, "setBreakpoints", {"source": {"path": str(self.workspace / target)},
                                                          "breakpoints": [{"line": n} for n in lines]})["breakpoints"]
        return pending, handoff

    def attach_child(self, handoff, python_lines=(18,)):
        child = SocketDapClient(handoff["connect"])
        self.children.append(child)
        self.ok(child, "initialize", {"adapterID": "debugpy", "linesStartAt1": True, "columnsStartAt1": True,
                                      "pathFormat": "path"})
        configuration = dict(handoff["configuration"])
        configuration.pop("request")
        attach = child.start_request("attach", configuration)
        child.event("initialized")
        self.ok(child, "setBreakpoints", {"source": {"path": str(self.workspace / "AuditLibrary.py")},
                                          "breakpoints": [{"line": n} for n in python_lines]})
        self.ok(child, "configurationDone")
        self.assertTrue(child.response(attach)["success"])
        return child

    def top_frame(self, line):
        frame = self.ok(self.client, "stackTrace", {"threadId": 1})["stackFrames"][0]
        self.assertEqual(frame["line"], line)
        return frame

    def verified(self, pending):
        updates = {}
        while len(updates) < len(pending):
            body = self.client.event("breakpoint")["breakpoint"]
            updates[body["id"]] = body
        return updates

    def restart(self, arguments=None):
        before = self.capture()
        self.ok(self.client, "restart", arguments)
        retired = self.client.event("robotCompanion/generation")
        self.assertEqual(retired["version"], 1)
        process = self.client.event("process")
        self.assertEqual(self.wait_gone(before), {}, "Retired generation survived restart")
        return retired, process

    def output_line(self, prefix, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for event in self.events_named("output"):
                if event["body"]["output"].startswith(prefix):
                    return event["body"]["output"]
            self.client.events.append(self.client.next_message(deadline))

    def stopped_by_user(self, folder):
        """The run that wrote `folder` ended as Robot records a user stop: its test never finished."""
        text = (folder / "output.xml").read_text(encoding="utf-8")
        self.assertIn("Execution stopped by user.", text, folder)
        self.assertNotIn("</test>", text, folder)

    # -- Robot-only restart -----------------------------------------------------------------

    def test_restart_while_paused_keeps_breakpoints_and_retires_handles(self):
        pending, _ = self.launch()
        self.ok(self.client, "configurationDone")
        self.assertEqual({b["id"]: b["verified"] for b in self.verified(pending).values()},
                         {pending[0]["id"]: True, pending[1]["id"]: True})
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        old_frame = self.top_frame(12)
        old_scope = self.ok(self.client, "scopes", {"frameId": old_frame["id"]})["scopes"][0]
        first_worker = self.capture()
        retired, process = self.restart()
        self.assertEqual(retired["retired"], 1)
        self.assertEqual(self.client.event("continued"), {"threadId": 1, "allThreadsContinued": True})
        self.assertNotIn(process["systemProcessId"], first_worker)
        # The same logical breakpoints are verified again by the new worker and hit again.
        self.assertEqual({b["id"]: b["verified"] for b in self.verified(pending).values()},
                         {pending[0]["id"]: True, pending[1]["id"]: True})
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        new_frame = self.top_frame(12)
        self.assertGreater(new_frame["id"], old_scope["variablesReference"])
        self.assertEqual(self.failed(self.client, "scopes", {"frameId": old_frame["id"]}), STALE_HANDLE)
        self.assertEqual(self.failed(self.client, "variables",
                                     {"variablesReference": old_scope["variablesReference"]}), STALE_HANDLE)
        result = self.ok(self.client, "evaluate", {"frameId": new_frame["id"], "context": "repl",
                                                   "expression": "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console"})
        self.assertEqual(result["result"], "'from-suite-console'")
        self.ok(self.client, "continue", {"threadId": 1})
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[1]["id"]])
        self.ok(self.client, "continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        # The restarted run wrote a new folder; the replaced run's output.xml is kept (MIS-713).
        self.stopped_by_user(self.workspace)
        self.assertEqual(ET.parse(self.workspace / "restart-1" / "output.xml").getroot().find(".//test/status")
                         .get("status"), "PASS")
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        received = [m["received"].get("event") for m in self.client.transcript if "received" in m]
        self.assertEqual(received.count("terminated"), 1)

    def test_restart_while_running_refuses_changed_inputs_and_writes_a_new_output_folder(self):
        first, second = self.workspace / "out-1", self.workspace / "out-2"
        pending, _ = self.launch("wait.robot", ["--outputdir", str(first)], lines=(5,))
        self.ok(self.client, "configurationDone")
        self.verified(pending)
        deadline = time.monotonic() + 30
        while not any("before-wait" in e["body"]["output"] for e in self.events_named("output")):
            self.client.events.append(self.client.next_message(deadline))
        running = self.capture()
        # Changed run inputs are refused before anything changes; the run keeps running.
        for changed in ({"target": "audit.robot", "cwd": str(self.workspace)},
                        {"target": "wait.robot", "cwd": str(self.workspace), "args": ["--dryrun"]},
                        {"target": "wait.robot", "cwd": str(self.workspace), "pythonDebug": {"handoffVersion": 1}}):
            self.assertEqual(self.failed(self.client, "restart", {"arguments": changed}), RESTART_CHANGED)
        self.assertEqual(processes.alive(running), running)
        self.assertEqual(self.ok(self.client, "threads")["threads"], [{"id": 1, "name": "Robot Framework"}])
        # An unchanged echo may name a new output folder; the old run's folder stays untouched.
        self.restart({"arguments": {"target": "wait.robot", "cwd": str(self.workspace),
                                    "args": ["--outputdir", str(second)], "name": "echo"}})
        self.assertEqual(self.events_named("continued"), [])  # It was running, not paused.
        self.verified(pending)
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        self.ok(self.client, "continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        status = ET.parse(second / "output.xml").getroot().find(".//test/status").get("status")
        self.assertEqual(status, "PASS")
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    def test_restart_keeps_every_earlier_output_folder_and_reads_abbreviated_options(self):
        first, second = self.workspace / "out-1", self.workspace / "out-2"
        pending, _ = self.launch(args=["--outputd", str(first)], lines=(12,))
        self.ok(self.client, "configurationDone")
        self.verified(pending)
        self.client.event("stopped")
        # Robot reads --outputd and -d as --outputdir: an echo naming another folder keeps the inputs.
        self.restart({"arguments": {"target": "audit.robot", "cwd": str(self.workspace), "args": ["-d", str(second)]}})
        self.verified(pending)
        self.client.event("stopped")
        self.stopped_by_user(first)
        # A restart naming no new folder writes below the first run's folder, never into an earlier one.
        self.restart()
        derived = first / "restart-2"
        self.assertEqual(self.output_line("Restarted run writes"), f"Restarted run writes its results to {derived}\n")
        self.verified(pending)
        self.client.event("stopped")
        self.ok(self.client, "continue", {"threadId": 1})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.stopped_by_user(second)
        self.assertEqual(ET.parse(derived / "output.xml").getroot().find(".//test/status").get("status"), "PASS")
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    def test_repeated_restarts_leave_no_owned_process_or_handle(self):
        pending, _ = self.launch()
        self.ok(self.client, "configurationDone")
        self.verified(pending)
        self.client.event("stopped")
        backend = self.client.backend_pid
        self.restart()  # Warm module caches once before the baseline.
        self.verified(pending)
        self.client.event("stopped")
        baseline = processes.handle_count(backend)
        samples, previous = [baseline], None
        for cycle in range(CYCLES):
            frame = self.top_frame(12)
            if previous is not None:
                self.assertGreater(frame["id"], previous)
            previous = frame["id"]
            generation = self.capture()
            retired, _ = self.restart()
            self.assertEqual(retired["retired"], cycle + 2)
            self.assertEqual(processes.alive(generation), {})
            self.verified(pending)
            self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
            self.client.events.clear()
            samples.append(processes.handle_count(backend))
        print("restart-handle-samples", samples, flush=True)
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            path = Path(directory) / "handle-counts"
            path.mkdir(parents=True, exist_ok=True)
            (path / (self.id() + ".json")).write_text(json.dumps({"pid": backend, "samples": samples,
                                                                  "windows": processes.WINDOWS}), encoding="utf-8")
        if processes.WINDOWS:  # Thread-pool handles move; one leaked handle per cycle would not.
            self.assertLess(samples[-1] - baseline, CYCLES)
        else:
            self.assertEqual(samples, [baseline] * (CYCLES + 1))
        self.assertEqual(len(processes.descendants(backend)), len(self.capture()))
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    # -- cancellation and disconnect ----------------------------------------------------------

    def test_cancel_launch_and_busy_lifecycle_requests(self):
        self.initialize()
        backend = self.client.backend_pid
        self.assertTrue(self.client.request("cancel", {"requestId": 9999})["success"])  # unknown: no-op
        self.assertTrue(self.client.request("cancel", {"progressId": "x"})["success"])
        self.assertFalse(self.client.request("cancel", {"requestId": "1"})["success"])
        self.assertEqual(self.failed(self.client, "restart"), "restart requires a configured Robot run")
        before = processes.handle_count(backend)
        for _ in range(processes.HANDLE_REPEATS):
            # Both frames are written at once: the reader handles the cancel while the launch
            # still waits for its new worker (spawning an interpreter takes far longer).
            launch = self.client.counter + 1
            self.client.raw({"seq": launch, "type": "request", "command": "launch",
                             "arguments": {"target": "audit.robot", "cwd": str(self.workspace)}})
            self.client.counter += 1
            cancel = self.client.start_request("cancel", {"requestId": launch})
            self.assertTrue(self.client.response(cancel)["success"])
            reply = self.client.response(launch)
            self.assertEqual((reply["success"], reply["message"]), (False, CANCELLED))
            self.assertEqual(processes.children(backend), [])
        processes.assert_no_handle_leak(self, backend, before)
        self.assertEqual(self.events_named("process"), [])
        self.assertEqual(self.events_named("initialized"), [])
        # A cancelled launch leaves the session usable for a real launch.
        self.ok(self.client, "launch", {"target": "audit.robot", "cwd": str(self.workspace)})
        self.client.event("initialized")
        self.ok(self.client, "setBreakpoints", {"source": {"path": str(self.workspace / "audit.robot")},
                                                "breakpoints": [{"line": 12}]})
        self.ok(self.client, "configurationDone")
        self.client.event("stopped")
        self.capture()
        first = self.client.start_request("restart")
        second = self.client.start_request("restart")
        busy = self.client.response(second)
        self.assertEqual((busy["success"], busy["message"]), (False, "Robot debug session is busy: restart in progress"))
        self.assertTrue(self.client.response(first)["success"])
        self.client.event("stopped")
        self.capture()
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    def disconnect_paused(self, arguments):
        pending, _ = self.launch()
        self.ok(self.client, "configurationDone")
        self.client.event("stopped")
        self.capture()
        response = self.client.request("disconnect", arguments)
        self.client.drain()
        events = [m["received"] for m in self.client.transcript if "received" in m]
        position = events.index(response)
        self.assertEqual([e.get("event") for e in events[position + 1:]], ["terminated"])
        self.assertEqual([e.get("event") for e in events].count("terminated"), 1)
        # The paused run ended itself as Robot's user stop, not by a signal after a timeout (MIS-713).
        self.assertEqual([e["body"]["exitCode"] for e in events if e.get("event") == "exited"], [USER_STOP])
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        return response

    def test_disconnect_with_terminate_debuggee_true_or_omitted_ends_the_owned_run(self):
        self.assertTrue(self.disconnect_paused({"terminateDebuggee": True})["success"])

    def test_disconnect_omitted_flag_ends_the_owned_run(self):
        self.assertTrue(self.disconnect_paused({})["success"])

    def test_disconnect_without_terminating_is_refused_and_still_ends_the_owned_run(self):
        response = self.disconnect_paused({"terminateDebuggee": False})
        self.assertEqual((response["success"], response["message"]), (False, NO_DETACH))

    # -- mixed Robot/Python restart ---------------------------------------------------------

    def mixed_paused(self):
        pending, handoff = self.launch(python=True, lines=(12,))
        child = self.attach_child(handoff)
        self.client.event("robotCompanion/pythonConnected")
        self.ok(self.client, "configurationDone")
        self.verified(pending)
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        self.capture()
        return pending, handoff, child

    def restart_mixed(self, old_handoff, old_child):
        restart = self.client.start_request("restart")
        ended = self.client.event("robotCompanion/pythonSession")
        self.assertEqual((ended["phase"], ended["sessionId"]), ("end", old_handoff["sessionId"]))
        self.client.event("robotCompanion/generation")
        old_child.reader.join(timeout=10)
        self.assertFalse(old_child.reader.is_alive(), "Old Python child connection survived restart")
        self.client.event("process")
        handoff = self.client.event("robotCompanion/pythonSession")
        self.assertEqual(handoff["phase"], "start")
        self.assertNotEqual(handoff["sessionId"], old_handoff["sessionId"])
        self.assertNotEqual(handoff["adapter"]["processId"], old_handoff["adapter"]["processId"])
        self.assertNotEqual(handoff["owner"]["debuggeeProcessId"], old_handoff["owner"]["debuggeeProcessId"])
        return restart, handoff

    def test_mixed_restart_replaces_the_python_child_while_robot_or_python_is_paused(self):
        pending, handoff, child = self.mixed_paused()
        # 1. Restart while Robot is paused: the restart waits for the new Python child.
        restart, handoff = self.restart_mixed(handoff, child)
        child = self.attach_child(handoff)
        self.assertTrue(self.client.response(restart)["success"])
        self.assertEqual(self.client.event("robotCompanion/pythonConnected")["sessionId"], handoff["sessionId"])
        self.verified(pending)
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        self.capture()
        # The editor may still send configurationDone for the replacement: nothing runs twice.
        self.ok(self.client, "configurationDone")
        self.ok(self.client, "continue", {"threadId": 1})
        stopped = child.event("stopped")
        frames = self.ok(child, "stackTrace", {"threadId": stopped["threadId"]})["stackFrames"]
        self.assertEqual(frames[0]["line"], 18)
        self.assertEqual(Path(frames[0]["source"]["path"]).name, "AuditLibrary.py")
        # 2. Restart while Python is paused in the library keyword.
        self.capture()
        restart, handoff = self.restart_mixed(handoff, child)
        child = self.attach_child(handoff)
        self.assertTrue(self.client.response(restart)["success"])
        self.verified(pending)
        self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        self.capture()
        self.ok(self.client, "continue", {"threadId": 1})
        stopped = child.event("stopped")
        self.ok(child, "continue", {"threadId": stopped["threadId"]})
        self.assertEqual(self.client.event("exited")["exitCode"], 0)
        self.client.event("terminated")
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)

    def test_runs_replaced_or_stopped_while_robot_or_python_is_paused_are_recorded_alike(self):
        first = self.workspace / "run-1"
        pending, handoff = self.launch(python=True, lines=(12,), args=["--outputdir", str(first)])
        child = self.attach_child(handoff)
        self.client.event("robotCompanion/pythonConnected")
        self.ok(self.client, "configurationDone")
        self.verified(pending)
        self.client.event("stopped")
        for folder in (first, first / "restart-1"):  # replaced while Robot, then while Python is paused
            restart, handoff = self.restart_mixed(handoff, child)
            child = self.attach_child(handoff)
            self.assertTrue(self.client.response(restart)["success"])
            self.verified(pending)
            self.assertEqual(self.client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
            self.capture()
            self.stopped_by_user(folder)
            self.ok(self.client, "continue", {"threadId": 1})
            self.assertEqual(Path(self.ok(child, "stackTrace", {"threadId": child.event("stopped")["threadId"]})
                                  ["stackFrames"][0]["source"]["path"]).name, "AuditLibrary.py")
        # Stopped while Python is paused: the same record and Robot's user-stop exit code.
        self.ok(self.client, "disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.event("exited")["exitCode"], USER_STOP)
        self.client.event("terminated")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.stopped_by_user(first / "restart-2")

    def test_failed_and_cancelled_mixed_restart_end_the_session_once(self):
        pending, handoff, child = self.mixed_paused()
        # The replacement child disconnects before configuring: the restart fails.
        restart, handoff = self.restart_mixed(handoff, child)
        self.capture()
        doomed = SocketDapClient(handoff["connect"])
        self.children.append(doomed)
        self.ok(doomed, "initialize", {"adapterID": "debugpy", "pathFormat": "path"})
        doomed.close()
        reply = self.client.response(restart)
        self.assertFalse(reply["success"])
        self.assertIn("Python child session ended", reply["message"])
        self.client.event("terminated")
        self.assertEqual(self.client.request("restart")["success"], False)
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        events = [m["received"].get("event") for m in self.client.transcript if "received" in m]
        self.assertEqual(events.count("terminated"), 1)

    def test_cancelled_restart_while_waiting_for_the_python_child(self):
        pending, handoff, child = self.mixed_paused()
        restart, handoff = self.restart_mixed(handoff, child)
        self.capture()
        cancel = self.client.start_request("cancel", {"requestId": restart})
        self.assertTrue(self.client.response(cancel)["success"])
        reply = self.client.response(restart)
        self.assertEqual((reply["success"], reply["message"]), (False, CANCELLED))
        self.client.event("terminated")
        self.ok(self.client, "disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)


class FakeTree:
    def __init__(self):
        self.code = None

    def poll(self):
        return self.code


class FakeWorker:
    """A configured, paused run without processes; a restart past its checks would retire it."""

    def __init__(self):
        self.tree, self.finished, self.retired, self.paused, self.generation = FakeTree(), False, False, True, 1

    def request_stop(self):
        pass

    def stop(self, **_):
        pass


class RestartDecisionTests(unittest.TestCase):
    """Deterministic restart decisions, without processes (MIS-713)."""

    def adapter(self):
        adapter = DebugAdapter(None)
        adapter.sent = []
        adapter.event = lambda name, body=None: adapter.sent.append(name)
        adapter.start_generation = lambda *arguments: self.fail("a refused restart started a new run")
        worker = adapter.worker = FakeWorker()
        adapter.configured = True
        adapter.inputs = {"targets": ["audit.robot"], "cwd": Path(tempfile.gettempdir()), "args": [], "python": False}
        adapter.output_folders = [str(adapter.inputs["cwd"])]
        return adapter, worker

    def refused(self, adapter):
        with self.assertRaisesRegex(RequestError, "^restart requires a configured Robot run$"):
            adapter.restart({}, Operation({"seq": 1, "command": "restart"}))

    def test_a_run_ending_naturally_as_a_restart_arrives_is_never_replaced_after_its_end(self):
        adapter, worker = self.adapter()

        def ends_meanwhile(arguments):  # The worker's watcher reports its natural end in this window.
            adapter.worker_finished(worker, 0)
            return dict(adapter.inputs)
        adapter.restart_inputs = ends_meanwhile
        self.refused(adapter)
        self.assertEqual(adapter.sent, ["exited", "terminated"])
        self.assertFalse(worker.retired)

    def test_a_restart_after_the_run_terminated_or_its_worker_exited_is_refused(self):
        for end in ("terminated", "worker exited, not yet reported"):
            with self.subTest(end):
                adapter, worker = self.adapter()
                if end == "terminated":
                    adapter.terminate_event()  # Written under seq_lock, read under the same lock.
                else:
                    worker.tree.code = 0
                self.refused(adapter)
                self.assertFalse(worker.retired)

    def test_abbreviated_output_folder_options_compare_as_outputdir(self):
        def run(*arguments):
            return {"targets": ["a.robot"], "cwd": Path(tempfile.gettempdir()), "args": list(arguments), "python": False}
        target = os.path.join(tempfile.gettempdir(), "out-2")
        original = run("--variable", "X:1", "--outputdir", os.path.join(tempfile.gettempdir(), "out-1"))
        for echo in (["--outputd", target], [f"--outputdi={target}"], ["--OutputDir", target], [f"--output-dir={target}"],
                     ["-d", target], [f"-d{target}"]):
            self.assertTrue(dap.same_run(original, run("--variable", "X:1", *echo)), echo)
            self.assertEqual(dap.output_folder(run("-d", "elsewhere", *echo)), os.path.abspath(target), echo)
        # --output is another option and --outp is ambiguous for Robot: both stay run inputs.
        for other in (["--output", target], ["--outp", target], ["--variable", "X:2"]):
            self.assertFalse(dap.same_run(run("--variable", "X:1"), run("--variable", "X:1", *other)), other)


if __name__ == "__main__":
    unittest.main()

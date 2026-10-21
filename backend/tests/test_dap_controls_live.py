"""Required real RF DAP checks for breakpoint editing, Pause and Step Out.

Every case runs real adapter/worker/RF subprocesses on copied synthetic suites in a
directory whose name has a space and non-ASCII characters. Missing RF fails.
"""

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
import xml.etree.ElementTree as ET

from client import DapClient
from test_dap_lifecycle import children, processes_in
from robot_companion_backend.dap import ENDED_BREAKPOINT, PENDING_SAFE_POINT
from robot_companion_backend.listener import OUTERMOST
from robot_companion_backend.protocol import FramedStream
from robot_companion_backend.worker import ControlPump
from robot_companion_backend.python_debug import SessionReader

FIXTURES = Path(__file__).parent / "controls_fixtures"
PAUSE_BOUND = 5.0  # seconds, from the Pause request to the stopped event (regular-step loop)


def frame_bytes(message):
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    return f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload


class ControlPumpTests(unittest.TestCase):
    """The worker's single control reader, over a real socket pair."""

    def pump(self):
        connection, peer = socket.socketpair()
        stopping = threading.Event()
        pump = ControlPump(FramedStream(SessionReader(connection, stopping), None), stopping).start()
        self.addCleanup(connection.close)
        self.addCleanup(peer.close)
        self.addCleanup(pump.stop)
        return pump, peer

    def test_fragmented_unicode_frames_keep_arrival_order(self):
        pump, peer = self.pump()
        first = {"command": "setBreakpoints", "source": "/tmp/Grüße 😀.robot", "breakpoints": [], "generation": 1}
        second = {"command": "pause"}
        data = frame_bytes(first) + frame_bytes(second)
        for start in range(0, len(data), 7):  # fragments split UTF-8 sequences and headers
            peer.sendall(data[start:start + 7])
            time.sleep(0.001)
        self.assertEqual(pump.messages.get(timeout=5), first)
        self.assertEqual(pump.messages.get(timeout=5), second)
        self.assertEqual(pump.pending(), [])

    def test_pending_is_a_nonblocking_snapshot(self):
        pump, peer = self.pump()
        peer.sendall(frame_bytes({"command": "pause"}))
        deadline = time.monotonic() + 5
        while pump.messages.qsize() < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        started = time.monotonic()
        self.assertEqual(pump.pending(), [{"command": "pause"}])
        self.assertEqual(pump.pending(), [])
        self.assertLess(time.monotonic() - started, 0.5)

    def test_malformed_frame_ends_queue(self):
        pump, peer = self.pump()
        peer.sendall(b"Content-Length: x\r\n\r\n{}")
        self.assertIsNone(pump.messages.get(timeout=5))

    def test_peer_eof_ends_queue(self):
        pump, peer = self.pump()
        peer.sendall(frame_bytes({"command": "pause"}))
        peer.shutdown(socket.SHUT_WR)
        self.assertEqual(pump.messages.get(timeout=5), {"command": "pause"})
        self.assertIsNone(pump.messages.get(timeout=5))

    def test_stop_with_idle_open_peer_is_bounded(self):
        pump, _peer = self.pump()
        started = time.monotonic()
        pump.stop()
        self.assertFalse(pump.thread.is_alive(), "Control pump did not stop with the peer still open")
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNone(pump.messages.get(timeout=1))


class DapControlsLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if reason := unsupported_reason():
            raise AssertionError(f"Required live runtime is a supported row: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent backend conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb controls Ü-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.client = DapClient()
        self.timings = {}

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "timings": self.timings,
                "stderr": self.client.stderr.decode(errors="replace")}, indent=2), encoding="utf-8")
            source = self.workspace / "output.xml"
            if source.exists():
                shutil.copyfile(source, target / (self.id() + ".output.xml"))
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process leaked")
        finally:
            shutil.rmtree(self.workspace)

    # -- helpers ---------------------------------------------------------------

    def path(self, name):
        return str(self.workspace / name)

    def line(self, name, text):
        lines = (self.workspace / name).read_text(encoding="utf-8").splitlines()
        matches = [number for number, content in enumerate(lines, 1) if content.strip() == text]
        self.assertEqual(len(matches), 1, f"{text!r} in {name}")
        return matches[0]

    def ok(self, command, arguments=None):
        response = self.client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def refused(self, command, arguments=None, message=None):
        response = self.client.request(command, arguments)
        self.assertFalse(response["success"], response)
        if message is not None:
            self.assertEqual(response["message"], message)
        return response["message"]

    def event(self, name, timeout=30):
        return self.client.event(name, timeout)

    def no_event(self, name, seconds):
        """Collect messages for `seconds`; fail if `name` arrives."""
        deadline = time.monotonic() + seconds
        while True:
            self.assertFalse([e for e in self.client.events if e.get("event") == name], f"Unexpected {name} event")
            try:
                message = self.client.next_message(deadline)
            except (TimeoutError, queue.Empty):
                return
            if message.get("type") == "response":
                self.client.responses[message["request_seq"]] = message
            else:
                self.client.events.append(message)

    def output(self, text, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            if any(text in e.get("body", {}).get("output", "") for e in self.client.events if e.get("event") == "output"):
                return
            self.client.events.append(self.client.next_message(deadline))

    def launch(self, target, test=None, breakpoints=None):
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                               "columnsStartAt1": True, "pathFormat": "path"})
        self.ok("launch", {"target": target, "cwd": str(self.workspace), "args": ["--test", test] if test else []})
        self.worker_pid = self.event("process")["systemProcessId"]
        self.event("initialized")
        ids = {}
        for source, lines in (breakpoints or {}).items():
            replies = self.ok("setBreakpoints", {"source": {"path": self.path(source)},
                                                 "breakpoints": [{"line": n} for n in lines]})["breakpoints"]
            ids[source] = [bp["id"] for bp in replies]
        self.ok("configurationDone")
        for source, lines in (breakpoints or {}).items():
            for _ in lines:
                self.assertTrue(self.event("breakpoint")["breakpoint"]["verified"])
        return ids

    def stopped(self, reason, hits=None, timeout=30):
        body = self.event("stopped", timeout)
        self.assertEqual((body["reason"], body["threadId"]), (reason, 1), body)
        if hits is not None:
            self.assertEqual(body["hitBreakpointIds"], hits)
        return body

    def top(self, name, line):
        stack = self.ok("stackTrace", {"threadId": 1})
        frame = stack["stackFrames"][0]
        self.assertEqual((Path(frame["source"]["path"]).name, frame["line"]), (name, line), stack)
        return frame, stack["totalFrames"]

    def variables(self, frame):
        reference = self.ok("scopes", {"frameId": frame["id"]})["scopes"][0]["variablesReference"]
        values = {v["name"]: v["value"] for v in self.ok("variables", {"variablesReference": reference})["variables"]}
        return reference, values

    def set_breakpoints(self, source, lines):
        return self.ok("setBreakpoints", {"source": {"path": self.path(source)},
                                          "breakpoints": [{"line": n} for n in lines]})["breakpoints"]

    def pause(self, label):
        started = time.monotonic()
        self.ok("pause", {"threadId": 1})
        body = self.stopped("pause")
        elapsed = time.monotonic() - started
        self.timings.setdefault("pauseSeconds", {})[label] = elapsed
        self.assertLess(elapsed, PAUSE_BOUND, f"Pause took {elapsed:.3f}s")
        return body

    def finish(self, exit_code=0):
        self.assertEqual(self.event("exited")["exitCode"], exit_code)
        self.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(children(self.client.backend_pid), [])
        return ET.parse(self.workspace / "output.xml").getroot()

    def terminate(self):
        self.ok("terminate", {"terminateDebuggee": True})
        self.event("terminated")
        self.assertEqual(processes_in(self.workspace), [])
        self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()
        self.assertEqual(children(self.client.backend_pid), [])

    def statuses(self, root):
        return {test.get("name"): test.find("status").get("status") for test in root.iter("test")}

    def messages(self, root):
        return [message.text for message in root.iter("msg")]

    # -- criterion 1: breakpoint add/remove after configuration ------------------

    def test_paused_add_remove_other_source_and_invalid_batches(self):
        first, second, third = (self.line("edit.robot", f"Log    edit-{n}") for n in ("first", "second", "third"))
        fifth = self.line("edit.robot", "Log    edit-fifth")
        leaf = self.line("controls.resource", "Log    inner-leaf ${value}")
        ids = self.launch("edit.robot", breakpoints={"edit.robot": [first, second], "controls.resource": [leaf]})
        self.stopped("breakpoint", [ids["edit.robot"][0]])
        self.top("edit.robot", first)
        # Paused replacement: the first entry keeps its ID, the added one gets a new ID,
        # and both are verified before the reply (so before the following Continue).
        replaced = self.set_breakpoints("edit.robot", [first, third])
        self.assertEqual([(bp["id"] == ids["edit.robot"][0], bp["line"], bp["verified"]) for bp in replaced],
                         [(True, first, True), (False, third, True)])
        added = replaced[1]["id"]
        self.assertGreater(added, max(ids["edit.robot"] + ids["controls.resource"]))
        self.ok("continue", {"threadId": 1})
        self.stopped("breakpoint", [added])  # not at the removed second line
        frame, _ = self.top("edit.robot", third)
        # Invalid batches fail whole and leave the current set unchanged.
        self.refused("setBreakpoints", {"source": {"path": self.path("controls.resource")}, "breakpoints": [{"line": "x"}]},
                     "Breakpoint lines must be positive integers")
        self.refused("setBreakpoints", {"source": {"path": self.path("controls.resource")},
                                        "breakpoints": [{"line": leaf, "hitCondition": "2"}]},
                     "Hit-count breakpoints (hitCondition) are unsupported")
        self.assertEqual(self.set_breakpoints("edit.robot", []), [])
        self.ok("continue", {"threadId": 1})
        self.stopped("breakpoint", ids["controls.resource"])  # other source untouched
        self.top("controls.resource", leaf)
        mixed = self.set_breakpoints("edit.robot", [fifth, 1])
        self.assertEqual([(bp["line"], bp["verified"]) for bp in mixed], [(fifth, True), (1, False)])
        self.assertEqual(mixed[1]["message"], "No executable Robot keyword call at this line")
        self.assertNotIn(added, [bp["id"] for bp in mixed])  # a removed ID is never reused
        self.ok("continue", {"threadId": 1})
        self.stopped("breakpoint", [mixed[0]["id"]])
        self.top("edit.robot", fifth)
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertEqual(self.statuses(root), {"Edit Breakpoints": "PASS"})
        self.assertIn("edit-second", self.messages(root))

    def test_running_edits_apply_at_safe_point_latest_generation_wins(self):
        after = self.line("blocking.robot", "Log    after-release")
        done = self.line("blocking.robot", "Log    blocking-done")
        self.launch("blocking.robot")
        self.output("controls-blocking-started")
        # Blocking library code is not interrupted: Pause and edits wait for the next keyword.
        self.ok("pause", {"threadId": 1})
        replies = [self.client.start_request("setBreakpoints", {"source": {"path": self.path("blocking.robot")},
                                                                "breakpoints": [{"line": n} for n in lines]})
                   for lines in ([after], [], [done])]
        replies = [self.client.response(seq) for seq in replies]
        self.assertTrue(all(reply["success"] for reply in replies), replies)
        bodies = [reply["body"]["breakpoints"] for reply in replies]
        self.assertEqual([[(bp["verified"], bp["message"]) for bp in body] for body in bodies],
                         [[(False, PENDING_SAFE_POINT)], [], [(False, PENDING_SAFE_POINT)]])
        final = bodies[2][0]["id"]
        self.ok("pause", {"threadId": 1})  # a second Pause before the safe point is the same intent
        self.no_event("stopped", 1.5)
        self.assertEqual(self.ok("threads")["threads"], [{"id": 1, "name": "Robot Framework"}])
        (self.workspace / "release.flag").write_text("go", encoding="utf-8")
        self.stopped("pause", [])  # the earlier [after-release] generation never stops
        self.top("blocking.robot", after)
        changed = [e["body"]["breakpoint"] for e in self.client.events if e.get("event") == "breakpoint"]
        self.assertEqual([(bp["id"], bp["verified"]) for bp in changed], [(final, True)])
        self.ok("continue", {"threadId": 1})
        self.stopped("breakpoint", [final])
        self.top("blocking.robot", done)
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertEqual(self.statuses(root), {"Blocking Call": "PASS"})

    # -- criterion 2: Pause --------------------------------------------------------

    def test_pause_regular_loop_and_running_breakpoint(self):
        tick = self.line("loop.robot", "Tick    ${index}")
        sleep = self.line("loop.robot", "Sleep    0.05s")
        self.launch("loop.robot", "Regular Loop")
        self.output("controls-loop-ready")
        added = self.set_breakpoints("loop.robot", [sleep])
        self.assertEqual([(bp["verified"], bp["message"]) for bp in added], [(False, PENDING_SAFE_POINT)])
        self.assertEqual(self.event("breakpoint")["breakpoint"], {"id": added[0]["id"], "verified": True,
                                                                  "line": sleep, "source": {"path": self.path("loop.robot")}})
        self.stopped("breakpoint", [added[0]["id"]])
        self.top("loop.robot", sleep)
        self.assertEqual(self.set_breakpoints("loop.robot", []), [])
        self.ok("continue", {"threadId": 1})
        self.no_event("stopped", 1)
        self.pause("regular-loop")
        frame, total = self.top_any("loop.robot", (tick, sleep, self.line("loop.robot", "Set Test Variable    ${TICK}    ${index}")))
        _, values = self.variables(frame)
        self.assertIn("${TICK}", values)
        self.terminate()

    def top_any(self, name, lines):
        stack = self.ok("stackTrace", {"threadId": 1})
        frame = stack["stackFrames"][0]
        self.assertEqual(Path(frame["source"]["path"]).name, name)
        self.assertIn(frame["line"], lines)
        return frame, stack["totalFrames"]

    def test_pause_during_blocking_call_then_stop(self):
        self.launch("blocking.robot")
        self.output("controls-blocking-started")
        self.ok("pause", {"threadId": 1})
        self.no_event("stopped", 1.5)  # no false paused state while library code blocks
        self.refused("stackTrace", {"threadId": 1}, "Robot worker is not paused")
        self.terminate()
        self.assertFalse([e for e in self.client.events if e.get("event") == "stopped"])

    def test_client_eof_with_queued_controls(self):
        self.launch("blocking.robot")
        self.output("controls-blocking-started")
        self.ok("pause", {"threadId": 1})
        self.set_breakpoints("blocking.robot", [self.line("blocking.robot", "Log    after-release")])
        self.client.process.stdin.close()
        self.assertEqual(self.client.process.wait(timeout=15), 1)
        self.client.drain()
        self.assertEqual(processes_in(self.workspace), [])

    def test_refusals_before_during_and_after_the_run(self):
        self.ok("initialize", {"adapterID": "robot-companion-native"})
        self.refused("pause", {"threadId": 1}, "Pause requires a started Robot run (after configurationDone)")
        self.ok("launch", {"target": "loop.robot", "cwd": str(self.workspace), "args": ["--test", "Regular Loop"]})
        self.event("initialized")
        self.refused("pause", {"threadId": 1}, "Pause requires a started Robot run (after configurationDone)")
        self.refused("stepOut", {"threadId": 1}, "Robot worker is not paused")
        self.ok("configurationDone")
        self.output("controls-loop-ready")
        self.refused("stepOut", {"threadId": 1}, "Robot worker is not paused")
        self.refused("next", {"threadId": 1}, "Robot worker is not paused")
        self.refused("pause", {"threadId": 7}, "Unknown Robot thread")
        self.pause("refusals")
        self.refused("pause", {"threadId": 1}, "Robot worker is already paused")
        self.refused("stepOut", {"threadId": 7}, "Unknown Robot thread")
        self.ok("terminate", {"terminateDebuggee": True})
        self.event("terminated")
        self.refused("pause", {"threadId": 1}, "Robot worker is not running")
        self.refused("stepOut", {"threadId": 1})
        ended = self.set_breakpoints("loop.robot", [self.line("loop.robot", "Sleep    0.05s")])
        self.assertEqual([(bp["verified"], bp["message"]) for bp in ended], [(False, ENDED_BREAKPOINT)])
        self.ok("disconnect")
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.client.drain()

    # -- criterion 3: Step Out -----------------------------------------------------

    def nested_step_out(self, crlf):
        if crlf:  # Windows line endings in both the suite and the resource
            for name in ("controls.robot", "controls.resource"):
                path = self.workspace / name
                path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        leaf = self.line("controls.resource", "Log    inner-leaf ${value}")
        caller = self.line("controls.resource", "Log    outer-after-inner ${inner}")
        after = self.line("controls.robot", "Log    after-outer ${result}")
        ids = self.launch("controls.robot", "Nested Step Out", {"controls.resource": [leaf]})
        self.stopped("breakpoint", ids["controls.resource"])
        frame, total = self.top("controls.resource", leaf)
        self.assertEqual(total, 4)  # test, Outer, Inner, Log
        reference, values = self.variables(frame)
        self.assertNotIn("${INNER_DONE}", values)
        self.ok("stepOut", {"threadId": 1})
        self.stopped("step")  # directly at the caller: no stop on inner-remainder
        later, total = self.top("controls.resource", caller)
        self.assertEqual(total, 3)
        self.assertNotEqual(later["id"], frame["id"])
        self.refused("scopes", {"frameId": frame["id"]}, "Stale or unknown Robot frame handle")
        self.refused("variables", {"variablesReference": reference}, "Stale or unknown Robot variable handle")
        _, values = self.variables(later)
        self.assertEqual((values["${inner}"], values["${INNER_DONE}"]), ("'inner-start'", "'done-start'"))
        self.ok("stepOut", {"threadId": 1})
        self.stopped("step")
        test_frame, total = self.top("controls.robot", after)
        self.assertEqual(total, 2)
        _, values = self.variables(test_frame)
        self.assertEqual(values["${result}"], "'inner-start-outer'")
        # Outermost: an explicit refusal; still paused with the same, usable handles.
        self.refused("stepOut", {"threadId": 1}, OUTERMOST)
        same, _ = self.top("controls.robot", after)
        self.assertEqual(same["id"], test_frame["id"])
        self.variables(same)
        result = self.ok("evaluate", {"frameId": same["id"], "context": "repl", "expression": "Catenate    console    ${result}"})
        self.assertEqual(result["result"], "'console inner-start-outer'")
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertEqual(self.statuses(root), {"Nested Step Out": "PASS"})
        self.assertIn("inner-remainder start", self.messages(root))

    def test_nested_step_out_to_exact_callers(self):
        self.nested_step_out(crlf=False)

    def test_nested_step_out_crlf_sources(self):
        self.nested_step_out(crlf=True)

    def test_recursive_step_out_selects_the_activation(self):
        leaf = self.line("controls.resource", "Log    recurse-leaf ${depth}")
        after = self.line("controls.robot", "Log    after-recursion")
        ids = self.launch("controls.robot", "Recursive Step Out", {"controls.resource": [leaf]})
        self.stopped("breakpoint", ids["controls.resource"])
        frame, total = self.top("controls.resource", leaf)
        self.assertEqual(self.variables(frame)[1]["${depth}"], "0")
        self.assertEqual(self.set_breakpoints("controls.resource", []), [])  # remove while paused
        for depth, frames in (("1", total - 1), ("'2'", total - 2)):
            self.ok("stepOut", {"threadId": 1})
            self.stopped("step")
            frame, current = self.top("controls.resource", leaf)  # same line, the caller's activation
            self.assertEqual(current, frames)
            self.assertEqual(self.variables(frame)[1]["${depth}"], depth)
        self.ok("stepOut", {"threadId": 1})
        self.stopped("step")
        self.top("controls.robot", after)
        self.ok("continue", {"threadId": 1})
        self.assertEqual(self.statuses(self.finish()), {"Recursive Step Out": "PASS"})

    def test_step_out_through_run_keyword_wrapper(self):
        leaf = self.line("controls.resource", "Log    inner-leaf ${value}")
        after = self.line("controls.robot", "Log    after-wrapped")
        ids = self.launch("controls.robot", "Wrapped Step Out", {"controls.resource": [leaf]})
        self.stopped("breakpoint", ids["controls.resource"])
        frame, total = self.top("controls.resource", leaf)
        names = [f["name"] for f in self.ok("stackTrace", {"threadId": 1})["stackFrames"]]
        self.assertIn("Run Keyword", names)
        self.ok("stepOut", {"threadId": 1})
        self.stopped("step")
        frame, total = self.top("controls.robot", after)
        self.assertEqual(total, 2)
        self.assertEqual(self.variables(frame)[1]["${INNER_DONE}"], "'done-wrapped'")
        self.ok("continue", {"threadId": 1})
        self.assertEqual(self.statuses(self.finish()), {"Wrapped Step Out": "PASS"})

    def test_step_out_after_early_return(self):
        leaf = self.line("controls.resource", "Log    early-leaf")
        after = self.line("controls.robot", "Log    after-early ${value}")
        ids = self.launch("controls.robot", "Early Return Step Out", {"controls.resource": [leaf]})
        self.stopped("breakpoint", ids["controls.resource"])
        self.ok("stepOut", {"threadId": 1})
        self.stopped("step")
        frame, _ = self.top("controls.robot", after)
        self.assertEqual(self.variables(frame)[1]["${value}"], "'early'")
        self.ok("continue", {"threadId": 1})
        root = self.finish()
        self.assertEqual(self.statuses(root), {"Early Return Step Out": "PASS"})
        self.assertNotIn("early-never", self.messages(root))

    def test_step_out_without_a_next_caller_completes(self):
        leaf = self.line("controls.resource", "Log    inner-leaf ${value}")
        ids = self.launch("controls.robot", "Last Step Out", {"controls.resource": [leaf]})
        self.stopped("breakpoint", ids["controls.resource"])
        self.ok("stepOut", {"threadId": 1})
        root = self.finish()  # ordinary completion, no fabricated stop
        self.assertFalse([e for e in self.client.events if e.get("event") == "stopped"])
        self.assertEqual(self.statuses(root), {"Last Step Out": "PASS"})

    # -- criterion 4: repeated cycles with the real console ------------------------

    def test_repeated_pause_edit_console_step_out_cycles(self):
        tick = self.line("loop.robot", "Tick    ${index}")
        assign = self.line("loop.robot", "Set Test Variable    ${TICK}    ${index}")
        sleep = self.line("loop.robot", "Sleep    0.05s")
        self.launch("loop.robot", "Regular Loop")
        self.output("controls-loop-ready")
        seen_ids = set()
        for cycle in range(3):
            self.pause(f"cycle-{cycle}")
            frame, total = self.top_any("loop.robot", (tick, assign, sleep))
            if total == 2:  # paused before a Tick call: enter it first
                self.ok("stepIn", {"threadId": 1})
                self.stopped("step")
                frame, total = self.top("loop.robot", assign)
            self.assertEqual(total, 3)
            self.ok("evaluate", {"frameId": frame["id"], "context": "repl",
                                 "expression": rf"Set Test Variable    \${{CYCLE}}    cycle-{cycle}"})
            self.ok("stepOut", {"threadId": 1})
            self.stopped("step")
            frame, total = self.top("loop.robot", tick)
            self.assertEqual(total, 2)
            _, values = self.variables(frame)
            self.assertEqual(values["${CYCLE}"], f"'cycle-{cycle}'")
            self.refused("stepOut", {"threadId": 1}, OUTERMOST)
            added = self.set_breakpoints("loop.robot", [sleep])
            self.assertTrue(added[0]["verified"])
            self.assertNotIn(added[0]["id"], seen_ids)
            seen_ids.add(added[0]["id"])
            self.ok("continue", {"threadId": 1})
            self.stopped("breakpoint", [added[0]["id"]])
            self.top("loop.robot", sleep)
            self.assertEqual(self.set_breakpoints("loop.robot", []), [])
            self.ok("continue", {"threadId": 1})
        self.assertEqual(children(self.client.backend_pid), [self.worker_pid])
        self.terminate()


if __name__ == "__main__":
    unittest.main()

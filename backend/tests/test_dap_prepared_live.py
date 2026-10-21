"""Required real prepared-session attach conformance (MIS-478): `dap-prepare` owners and
`dap-connect` connectors as real processes, real Robot workers and debugpy children.

No mocks or skips. Each case checks that no owned process survives and that the test's
own fallback cleanup was never needed."""

import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from client import DapClient, SocketDapClient
import processes
from robot_companion_backend import __version__, prepared
from robot_companion_backend.dap import EXTERNAL_ATTACH
from test_dap_lifecycle import processes_in

FIXTURES = Path(__file__).parent / "fixtures"
ATTEMPTS = max(10, processes.HANDLE_REPEATS)


def environment():
    env = os.environ.copy()
    if env.get("PYTHONPATH"):
        env["PYTHONPATH"] = os.pathsep.join(map(os.path.abspath, filter(None, env["PYTHONPATH"].split(os.pathsep))))
    return env


class Owner:
    """A real `dap-prepare` foreground owner; reads its published descriptor path."""

    def __init__(self, workspace, *options, timeout=30, expect_ready=True):
        argv = [sys.executable, "-m", "robot_companion_backend", "dap-prepare", "--workspace", str(workspace),
                "--target", "audit.robot", "--attach-timeout", str(timeout), *options]
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if processes.WINDOWS else 0
        self.process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment(),
                                        creationflags=flags)
        self.lines, self.stderr = queue.Queue(), bytearray()
        self.forced = False
        threading.Thread(target=self._read, daemon=True).start()
        self.error_reader = threading.Thread(target=self._errors, daemon=True)
        self.error_reader.start()
        self.pid = processes.interpreter_pid(self.process.pid, lambda: self.process.poll() is not None)
        self.owned = {}
        self.path = None
        if expect_ready:
            deadline = time.monotonic() + 40
            while self.path is None:
                line = self.lines.get(timeout=max(0.1, deadline - time.monotonic()))
                if line is None:
                    raise AssertionError(f"dap-prepare ended before publishing: {self.stderr.decode(errors='replace')}")
                if line.startswith("preparedSession: "):
                    self.path = Path(line[len("preparedSession: "):].rstrip("\r\n"))
            self.capture()

    def _read(self):
        for line in iter(self.process.stdout.readline, b""):
            self.lines.put(line.decode("utf-8"))
        self.lines.put(None)

    def _errors(self):
        while data := self.process.stderr.read(4096):
            self.stderr.extend(data)

    def capture(self):
        identity = processes.identity(self.pid)
        if identity is not None:
            self.owned[self.pid] = identity
        self.owned.update(processes.descendants(self.pid))
        return self.owned

    def wait(self, timeout=20):
        code = self.process.wait(timeout=timeout)
        self.error_reader.join(timeout=5)
        return code

    def interrupt(self):
        if processes.WINDOWS:
            self.process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            os.kill(self.pid, signal.SIGINT)

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.forced = True
                for pid, identity in processes.alive(self.capture()).items():
                    processes.kill(pid, identity)
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class PreparedLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from robot_companion_backend.runtime import unsupported_reason
        if (reason := unsupported_reason()) or importlib.metadata.version("debugpy") != "1.8.22":
            raise AssertionError(f"Prepared-session conformance requires a supported row and debugpy 1.8.22: {reason}")
        if importlib.util.find_spec("robotcode") is not None:
            raise AssertionError("Independent prepared-session conformance requires RobotCode absent")

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-prepared-ws-")).resolve()
        shutil.copytree(FIXTURES, self.workspace, dirs_exist_ok=True)
        self.private = Path(tempfile.mkdtemp(prefix="rcb-prepared-private-")).resolve()
        if not processes.WINDOWS:
            os.chmod(self.private, 0o700)
        self.owners, self.connectors, self.children = [], [], []

    def tearDown(self):
        for child in self.children:
            child.close()
        for connector in self.connectors:
            connector.close()
        for owner in self.owners:
            owner.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "connectors": [{"protocol": c.transcript, "stderr": c.stderr.decode(errors="replace")}
                               for c in self.connectors],
                "python": [c.transcript for c in self.children],
                "owners": [{"argv": o.process.args, "exit": o.process.returncode,
                            "stderr": o.stderr.decode(errors="replace")} for o in self.owners]},
                indent=2), encoding="utf-8")
        try:
            for connector in self.connectors:
                self.assertFalse(connector.forced_cleanup, "Test fallback cleaned up a connector leak")
            for owner in self.owners:
                self.assertFalse(owner.forced, "Test fallback cleaned up a prepared owner")
                self.assertEqual(self.wait_gone(owner.owned), {}, "Owned prepared-session process leaked")
                self.assertFalse(owner.path and owner.path.exists(), "Descriptor survived its owner")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process leaked")
        finally:
            shutil.rmtree(self.workspace, ignore_errors=True)
            shutil.rmtree(self.private, ignore_errors=True)

    # -- helpers ---------------------------------------------------------------------------

    def owner(self, *options, **keywords):
        owner = Owner(self.workspace, *options, **keywords)
        self.owners.append(owner)
        return owner

    def connect(self, path, workspace=None, backend=None):
        startup = {"version": 1, "preparedSession": str(path), "workspace": str(workspace or self.workspace),
                   "backend": backend or {"id": prepared.BACKEND_ID, "version": __version__}}
        connector = DapClient(service="dap-connect", startup=json.dumps(startup).encode("utf-8") + b"\n")
        self.connectors.append(connector)
        return connector

    def ok(self, client, command, arguments=None):
        response = client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def wait_gone(self, identities, timeout=10):
        deadline = time.monotonic() + timeout
        while (left := processes.alive(identities)) and time.monotonic() < deadline:
            time.sleep(0.05)
        return left

    def initialize(self, client):
        caps = self.ok(client, "initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True,
                                              "columnsStartAt1": True, "pathFormat": "path"})
        self.assertTrue(caps["supportsRestartRequest"] and caps["supportsCancelRequest"])
        return caps

    def attach(self, owner, client):
        self.initialize(client)
        self.ok(client, "attach", {"name": "Attach prepared run"})
        process = client.event("process")
        self.assertEqual(process["startMethod"], "attach")
        self.assertIn(process["systemProcessId"], owner.capture())
        client.event("initialized")
        self.assertFalse(owner.path.exists(), "The claim must consume the descriptor")
        return process

    def refused_attach(self, path, fragment, **keywords):
        connector = self.connect(path, **keywords)
        reply = connector.request("initialize", {"adapterID": "robot-companion-native", "pathFormat": "path"})
        self.assertFalse(reply["success"], reply)
        self.assertIn("Cannot attach to the prepared Robot session", reply["message"])
        self.assertIn(fragment, reply["message"])
        connector.close()
        self.assertEqual(connector.process.returncode, 2)
        return reply["message"]

    def private_copy(self, name, data, mode=0o600):
        path = self.private / name
        prepared.write_private(path, data)
        if not processes.WINDOWS and mode != 0o600:
            os.chmod(path, mode)
        return path

    def paused(self, client, lines=(12,)):
        pending = self.ok(client, "setBreakpoints", {"source": {"path": str(self.workspace / "audit.robot")},
                                                     "breakpoints": [{"line": n} for n in lines]})["breakpoints"]
        self.ok(client, "configurationDone")
        stopped = client.event("stopped")
        self.assertEqual(stopped["hitBreakpointIds"], [pending[0]["id"]])
        return pending

    def finish(self, owner, client):
        self.ok(client, "disconnect")
        self.assertEqual(owner.wait(), 0, owner.stderr.decode(errors="replace"))
        self.assertEqual(client.process.wait(timeout=10), 0)
        self.assertFalse(owner.path.parent.exists(), "The owner's private descriptor folder remains")

    # -- cases -----------------------------------------------------------------------------

    def test_prepare_attach_breakpoint_restart_and_disconnect(self):
        owner = self.owner()
        self.assertEqual(json.loads(prepared.read_private(owner.path))["owner"]["processId"], owner.pid)
        client = self.connect(owner.path)
        self.initialize(client)
        self.assertIn("accepts only its own attach", client.request("launch", {"target": "audit.robot"})["message"])
        self.assertEqual(client.request("attach", {"processId": owner.pid})["message"], EXTERNAL_ATTACH)
        self.assertFalse(owner.path.exists(), "The authenticated connection consumed the descriptor")
        self.ok(client, "attach", {})  # The refused request left the prepared run usable.
        self.assertEqual(client.event("process")["startMethod"], "attach")
        client.event("initialized")
        self.assertIn("already attached", client.request("attach", {})["message"])
        pending = self.paused(client, (12, 13))
        frame = self.ok(client, "stackTrace", {"threadId": 1})["stackFrames"][0]
        self.assertEqual((frame["line"], Path(frame["source"]["path"]).name), (12, "audit.robot"))
        result = self.ok(client, "evaluate", {"frameId": frame["id"], "context": "repl",
                                              "expression": "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console"})
        self.assertEqual(result["result"], "'from-suite-console'")
        first = owner.capture().copy()
        self.ok(client, "restart", {"arguments": {"name": "Attach prepared run", "preparedSession": str(owner.path)}})
        self.assertEqual(client.event("robotCompanion/generation")["retired"], 1)
        self.assertEqual(client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        self.assertEqual(self.wait_gone({p: i for p, i in first.items() if p != owner.pid}), {})
        owner.capture()
        self.finish(owner, client)

    def test_prepared_restart_writes_a_new_output_folder(self):
        owner = self.owner()
        client = self.connect(owner.path)
        self.attach(owner, client)
        pending = self.paused(client)
        self.ok(client, "restart", {"arguments": {"name": "Attach prepared run", "preparedSession": str(owner.path)}})
        client.event("robotCompanion/generation")
        derived = self.workspace / "restart-1"  # below the prepared run's own folder (its cwd)
        output = client.event("output")
        while not output["output"].startswith("Restarted run writes"):
            output = client.event("output")
        self.assertEqual(output["output"], f"Restarted run writes its results to {derived}\n")
        self.assertEqual(client.event("stopped")["hitBreakpointIds"], [pending[0]["id"]])
        owner.capture()
        self.ok(client, "continue", {"threadId": 1})
        self.assertEqual(client.event("exited")["exitCode"], 0)
        first = (self.workspace / "output.xml").read_text(encoding="utf-8")
        self.assertIn("Execution stopped by user.", first)  # The previous output.xml is kept.
        self.assertIn('<stat pass="1" fail="0" skip="0">All Tests</stat>', (derived / "output.xml").read_text(encoding="utf-8"))
        self.finish(owner, client)

    def test_prepared_mixed_python_attach_and_restart(self):
        owner = self.owner("--attach-python")
        client = self.connect(owner.path)
        self.initialize(client)
        self.ok(client, "attach", {})
        client.event("process")
        handoff = client.event("robotCompanion/pythonSession")
        self.assertIn(handoff["adapter"]["processId"], owner.capture())
        client.event("initialized")
        child = self.python_child(handoff)
        client.event("robotCompanion/pythonConnected")
        self.paused(client)
        self.ok(client, "continue", {"threadId": 1})
        stopped = child.event("stopped")
        frames = self.ok(child, "stackTrace", {"threadId": stopped["threadId"]})["stackFrames"]
        self.assertEqual((frames[0]["line"], Path(frames[0]["source"]["path"]).name), (18, "AuditLibrary.py"))
        owner.capture()
        restart = client.start_request("restart")
        self.assertEqual(client.event("robotCompanion/pythonSession")["phase"], "end")
        handoff = client.event("robotCompanion/pythonSession")
        self.assertEqual(handoff["phase"], "start")
        owner.capture()
        child = self.python_child(handoff)
        self.assertTrue(client.response(restart)["success"])
        client.event("stopped")
        owner.capture()
        self.finish(owner, client)

    def python_child(self, handoff):
        child = SocketDapClient(handoff["connect"])
        self.children.append(child)
        self.ok(child, "initialize", {"adapterID": "debugpy", "linesStartAt1": True, "columnsStartAt1": True,
                                      "pathFormat": "path"})
        configuration = dict(handoff["configuration"])
        configuration.pop("request")
        attach = child.start_request("attach", configuration)
        child.event("initialized")
        self.ok(child, "setBreakpoints", {"source": {"path": str(self.workspace / "AuditLibrary.py")},
                                          "breakpoints": [{"line": 18}]})
        self.ok(child, "configurationDone")
        self.assertTrue(child.response(attach)["success"])
        return child

    def test_refused_descriptors_and_failed_authentication_leave_the_prepared_run_untouched(self):
        owner = self.owner()
        original = prepared.read_private(owner.path)
        descriptor = json.loads(original)

        def variant(**fields):
            return json.dumps({**descriptor, **fields}).encode("utf-8")
        cases = [
            (self.private / "missing.json", "No prepared session descriptor"),
            (self.private_copy("empty.json", b""), "empty file"),
            (self.private_copy("bad.json", b"{"), "not JSON"),
            (self.private_copy("version.json", variant(version=2)), "unsupported version 2"),
            (self.private_copy("port.json", variant(connect={"host": "127.0.0.1", "port": True})), "connect.port"),
            (self.private_copy("host.json", variant(connect={"host": "10.1.2.3", "port": 1})), "connect.host"),
            (self.private_copy("secret.json", variant(secret="ab")), "secret must be 64"),
            (self.private_copy("expired.json", variant(expires="2000-01-01T00:00:01.000000Z",
                                                       created="2000-01-01T00:00:00.000000Z")), "expired"),
            (self.private_copy("large.json", b" " * (prepared.DESCRIPTOR_LIMIT + 1)), "larger than"),
        ]
        if not processes.WINDOWS:
            cases.append((self.private_copy("broad.json", original, mode=0o644), "private (0600)"))
            link = self.private / "link.json"
            os.symlink(owner.path, link)
            cases.append((link, "Cannot open the prepared session descriptor safely"))
        for path, fragment in cases:
            with self.subTest(fragment=fragment):
                self.refused_attach(path, fragment)
        self.refused_attach(owner.path, "another workspace folder", workspace=self.private)
        self.refused_attach(owner.path, "the editor expects backend",
                            backend={"id": prepared.BACKEND_ID, "version": "9.9.9"})
        # Wrong secrets reach the owner and fail authentication without touching its run.
        before = processes.handle_count(owner.pid)
        forged = self.private_copy("forged.json", variant(secret="cd" * 32))
        for _ in range(ATTEMPTS):
            self.refused_attach(forged, "failed authentication")
        processes.assert_no_handle_leak(self, owner.pid, before)
        self.assertIsNone(owner.process.poll())
        self.assertTrue(owner.path.exists(), "A refused client must not consume the descriptor")
        client = self.connect(owner.path)
        self.attach(owner, client)
        # Replays fail: the path is consumed and a saved copy finds the listener closed.
        self.refused_attach(owner.path, "No prepared session descriptor")
        self.refused_attach(self.private_copy("replay.json", original), "Cannot attach")
        self.paused(client)
        self.finish(owner, client)
        log = owner.stderr.decode(errors="replace")
        self.assertIn("refused a prepared-session connection", log)
        self.assertNotIn(descriptor["secret"], log)
        for connector in self.connectors:
            self.assertNotIn(descriptor["secret"], connector.stderr.decode(errors="replace"))

    def check(self, path, workspace=None):
        startup = {"version": 1, "preparedSession": str(path), "workspace": str(workspace or self.workspace),
                   "backend": {"id": prepared.BACKEND_ID, "version": __version__}}
        result = subprocess.run([sys.executable, "-m", "robot_companion_backend", "dap-connect", "--check"],
                                input=json.dumps(startup).encode("utf-8") + b"\n", capture_output=True,
                                env=environment(), timeout=30)
        return result.returncode, json.loads(result.stdout.decode("utf-8")), result

    def test_check_validates_without_claiming_the_session(self):
        owner = self.owner()
        secret = json.loads(prepared.read_private(owner.path))["secret"]
        code, reply, result = self.check(owner.path)
        self.assertEqual((code, reply["ok"]), (0, True))
        self.assertNotIn(secret, result.stdout.decode() + result.stderr.decode())
        self.assertTrue(owner.path.exists(), "--check must not consume the descriptor")
        for path, workspace, fragment in ((self.private / "consumed.json", None, "No prepared session descriptor"),
                                          (self.private_copy("invalid.json", b"{}"), None, "unsupported version"),
                                          (owner.path, self.private, "another workspace folder")):
            code, reply, _ = self.check(path, workspace)
            self.assertEqual((code, reply["ok"]), (2, False))
            self.assertIn("Cannot attach to the prepared Robot session", reply["message"])
            self.assertIn(fragment, reply["message"])
        client = self.connect(owner.path)  # The checked session is still attachable.
        self.attach(owner, client)
        self.paused(client)
        self.finish(owner, client)

    def test_two_sessions_consume_only_the_intended_one_and_the_other_expires(self):
        expiring, attached = self.owner(timeout=3), self.owner()
        client = self.connect(attached.path)
        self.attach(attached, client)
        self.paused(client)
        self.assertEqual(expiring.wait(), 2)
        self.assertIn("expired before a client attached", expiring.stderr.decode(errors="replace"))
        self.assertFalse(expiring.path.exists())
        self.assertEqual(self.wait_gone(expiring.owned), {})
        self.assertEqual(self.ok(client, "stackTrace", {"threadId": 1})["stackFrames"][0]["line"], 12)
        self.finish(attached, client)

    def test_failed_preparations_start_nothing_and_leave_no_descriptor(self):
        for _ in range(10):
            owner = Owner(self.workspace, "--target", "missing.robot", expect_ready=False)
            self.owners.append(owner)
            self.assertEqual(owner.wait(), 2)
            self.assertIn("Launch paths not found", owner.stderr.decode(errors="replace"))
        existing = self.private_copy("taken.json", b"{}")
        owner = Owner(self.workspace, "--descriptor", str(existing), expect_ready=False)
        self.owners.append(owner)
        self.assertEqual(owner.wait(), 2)
        self.assertIn("already exists", owner.stderr.decode(errors="replace"))
        self.assertEqual(prepared.read_private(existing), b"{}")
        # Publishing fails after the worker started: the started run is stopped.
        not_directory = self.private / "file"
        not_directory.write_text("x", encoding="utf-8")
        unsafe = [not_directory / "session.json"]
        if not processes.WINDOWS:
            shared = self.private / "shared"
            shared.mkdir(mode=0o755)
            os.chmod(shared, 0o755)
            unsafe.append(shared / "session.json")
        for path in unsafe:
            owner = Owner(self.workspace, "--descriptor", str(path), expect_ready=False)
            self.owners.append(owner)
            self.assertEqual(owner.wait(), 2)
            self.assertIn("cannot publish the descriptor", owner.stderr.decode(errors="replace"))
            self.assertFalse(path.exists())
        for option in (["--attach-timeout", "31"], ["--attach-timeout", "0"], ["--workspace", "relative"]):
            owner = Owner(self.workspace, *option, expect_ready=False)
            self.owners.append(owner)
            self.assertEqual(owner.wait(), 2)

    def test_interrupt_before_and_after_attach_stops_the_owned_run(self):
        waiting = self.owner()
        waiting.interrupt()
        self.assertEqual(waiting.wait(), 130)
        self.assertFalse(waiting.path.exists())
        self.assertEqual(self.wait_gone(waiting.owned), {})
        serving = self.owner("--attach-python")
        client = self.connect(serving.path)
        self.initialize(client)
        self.ok(client, "attach", {})
        handoff = client.event("robotCompanion/pythonSession")
        serving.capture()
        self.python_child(handoff)
        serving.capture()
        serving.interrupt()
        self.assertEqual(serving.wait(), 130)
        self.assertEqual(client.process.wait(timeout=10), 0)
        self.assertEqual(self.wait_gone(serving.owned), {})

    def test_attached_but_unconfigured_session_ends_within_the_budget(self):
        owner = self.owner()
        client = self.connect(owner.path)
        self.attach(owner, client)
        started = time.monotonic()
        client.event("terminated", timeout=prepared.LEASE + 10)
        self.assertLess(time.monotonic() - started, prepared.LEASE + 5)
        output = [e["body"]["output"] for e in client.events if e.get("event") == "output"]
        self.assertTrue(any("was not configured within" in text for text in output), output)
        self.assertEqual(owner.wait(), 1)
        self.assertEqual(client.process.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()

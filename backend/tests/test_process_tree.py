"""Process-tree lifecycle and control-channel checks with real processes and sockets.

Windows code paths cannot run here: their pure logic (Popen flags, Job Object
layout, error mapping, stop control flow with a stand-in job) and a win32 import
emulation are checked on Linux. None of this is Windows-verified.
"""

import contextlib
import ctypes
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from robot_companion_backend import control, process_tree
from robot_companion_backend.dap import CLEANUP_FAILED_EXIT, DebugAdapter
from robot_companion_backend.process_tree import ProcessTree
from robot_companion_backend.protocol import FramedStream
from test_dap_lifecycle import require_process_observation

POSIX_ONLY = {"os": ("killpg", "getpgid", "getpgrp", "setsid", "setpgid", "fork", "forkpty", "getuid", "geteuid"),
              "signal": ("SIGKILL", "SIGHUP", "SIGQUIT", "SIGCHLD", "SIGUSR1", "SIGUSR2", "SIGALRM", "SIGPIPE",
                         "SIGSTOP", "SIGCONT", "SIGTSTP", "alarm", "setitimer", "pthread_kill")}
# Standard-library and pinned RF modules resolve their own platform when imported
# (subprocess needs _winapi on Windows), so they are imported first; then every
# backend runtime module is imported with sys.platform "win32" and the POSIX-only
# names removed. This checks import-time use only, not Windows behaviour.
WIN32_IMPORT = """
import importlib, json, os, pkgutil, signal, sys
import argparse, ctypes, ctypes.wintypes, difflib, hashlib, hmac, importlib.metadata, importlib.util
import queue, secrets, socket, subprocess, threading, uuid
import robot.api, robot.api.parsing, robot.libraries.BuiltIn, robot.running.context, robot.variables
import robot.variables.evaluation, robot.variables.search
posix_only = json.loads(sys.argv[1])
sys.platform = "win32"
removed = []
for module, names in ((os, posix_only["os"]), (signal, posix_only["signal"])):
    for name in names:
        if hasattr(module, name):
            delattr(module, name)
            removed.append(module.__name__ + "." + name)
import robot_companion_backend
modules = sorted(info.name for info in pkgutil.iter_modules(robot_companion_backend.__path__))
for name in modules:
    importlib.import_module("robot_companion_backend." + name)
from robot_companion_backend import process_tree
print(json.dumps({"modules": modules, "removed": removed, "windows": process_tree.WINDOWS,
                  "options": process_tree.popen_options()}))
"""


def alive(pid):
    """True for a live (not zombie) process; Linux /proc only."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


def wait_gone(pid, timeout=10):
    deadline = time.monotonic() + timeout
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not alive(pid)


class WindowsLogicTests(unittest.TestCase):
    """Pure Windows logic on Linux; not Windows-verified."""

    def test_runtime_modules_import_as_win32_without_posix_names(self):
        result = subprocess.run([sys.executable, "-c", WIN32_IMPORT, json.dumps(POSIX_ONLY)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        package = Path(process_tree.__file__).parent
        # `import robot_companion_backend` covers __init__; every other module is listed.
        self.assertEqual(report["modules"], sorted(p.stem for p in package.glob("*.py") if p.stem != "__init__"))
        for name in ("dap", "worker", "python_debug", "process_tree", "control", "listener", "lsp", "discovery"):
            self.assertIn(name, report["modules"])
        self.assertIn("os.killpg", report["removed"])
        self.assertIn("signal.SIGKILL", report["removed"])
        self.assertTrue(report["windows"])
        self.assertEqual(report["options"], {"creationflags": process_tree.CREATE_NEW_PROCESS_GROUP})

    def test_popen_options_per_platform(self):
        self.assertEqual(process_tree.popen_options(windows=True), {"creationflags": 0x00000200})
        self.assertEqual(process_tree.popen_options(windows=False), {"start_new_session": True})
        self.assertFalse(process_tree.WINDOWS)

    def test_job_limit_structure_sets_kill_on_close(self):
        info = process_tree.job_limit_structure()
        self.assertEqual(info.BasicLimitInformation.LimitFlags, 0x00002000)
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows, 112 on 32-bit.
        self.assertEqual(ctypes.sizeof(info), {8: 144, 4: 112}[ctypes.sizeof(ctypes.c_void_p)])
        self.assertEqual(process_tree.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, 9)
        self.assertEqual(process_tree.PROCESS_SET_QUOTA | process_tree.PROCESS_TERMINATE, 0x0101)

    def test_windows_error_mapping(self):
        error = process_tree.windows_error("TerminateJobObject", 5)
        self.assertIsInstance(error, OSError)
        self.assertEqual(str(error), "TerminateJobObject failed (Windows error 5)")

    def test_abnormal_exit_descriptions(self):
        for code in (None, 0, 1, 4, 252, 253, 255):
            self.assertIsNone(process_tree.abnormal_exit(code))
        self.assertEqual(process_tree.abnormal_exit(-9), "terminated by SIGKILL")
        self.assertEqual(process_tree.abnormal_exit(-15), "terminated by SIGTERM")
        self.assertEqual(process_tree.abnormal_exit(-200), "terminated by signal 200")
        self.assertEqual(process_tree.abnormal_exit(0xC0000005), "exit status 0xC0000005")

    def windows_tree(self, job, exits=True):
        tree = ProcessTree.__new__(ProcessTree)
        tree.job = job
        tree.process = mock.Mock(pid=4242)
        tree.process.poll.return_value = None
        if not exits:
            tree.process.wait.side_effect = subprocess.TimeoutExpired("worker", 0)
        return tree

    def test_windows_stop_breaks_then_terminates_job(self):
        job = mock.Mock()
        tree = self.windows_tree(job)
        with mock.patch.object(process_tree.os, "kill") as kill, \
                mock.patch.object(process_tree, "signal", mock.Mock(CTRL_BREAK_EVENT=1)):
            self.assertEqual(tree.stop(timeout=0), [])
        kill.assert_called_once_with(4242, 1)
        job.terminate.assert_called_once_with()  # members that outlived the leader

    def test_windows_failed_break_and_terminate_are_reported(self):
        job = mock.Mock()
        job.terminate.side_effect = process_tree.windows_error("TerminateJobObject", 5)
        tree = self.windows_tree(job, exits=False)
        with mock.patch.object(process_tree.os, "kill", side_effect=OSError("no console")), \
                mock.patch.object(process_tree, "signal", mock.Mock(CTRL_BREAK_EVENT=1)):
            problems = tree.stop(timeout=0)
        self.assertTrue(problems)
        self.assertIn("cannot terminate job of process 4242: TerminateJobObject failed (Windows error 5)", problems)
        self.assertIn("process 4242 did not exit after it was killed", problems)


class PosixTreeTests(unittest.TestCase):
    def setUp(self):
        require_process_observation()
        self.directory = Path(tempfile.mkdtemp(prefix="rcb-tree-"))

    def tearDown(self):
        for path in self.directory.iterdir():
            path.unlink()
        self.directory.rmdir()

    def start(self, ignore_term):
        marker = self.directory / "grandchild.pid"
        guard = "signal.signal(signal.SIGTERM, signal.SIG_IGN); " if ignore_term else ""
        grandchild = f"import signal, time; {guard}time.sleep(120)"
        child = (f"import pathlib, signal, subprocess, sys, time; {guard}"
                 f"p = subprocess.Popen([sys.executable, '-c', {grandchild!r}]); "
                 f"pathlib.Path({str(marker)!r}).write_text(str(p.pid)); time.sleep(120)")
        tree = ProcessTree([sys.executable, "-c", child])
        deadline = time.monotonic() + 10
        while not (marker.is_file() and marker.read_text()) and time.monotonic() < deadline:
            time.sleep(0.02)
        return tree, int(marker.read_text())

    def test_stop_terminates_child_and_grandchild_in_own_group(self):
        tree, grandchild = self.start(ignore_term=False)
        self.assertEqual(os.getpgid(tree.process.pid), tree.process.pid)
        self.assertNotEqual(os.getpgid(tree.process.pid), os.getpgrp())
        self.assertEqual(tree.stop(), [])
        self.assertEqual(tree.process.returncode, -signal.SIGTERM)
        self.assertTrue(wait_gone(grandchild))

    def test_stop_escalates_to_kill_for_term_ignoring_tree(self):
        tree, grandchild = self.start(ignore_term=True)
        started = time.monotonic()
        self.assertEqual(tree.stop(timeout=0.5), [])
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        self.assertEqual(tree.process.returncode, -signal.SIGKILL)
        self.assertTrue(wait_gone(grandchild))

    def test_kill_after_leader_exit_reaches_grandchild(self):
        tree, grandchild = self.start(ignore_term=False)
        os.kill(tree.process.pid, signal.SIGKILL)  # only the leader
        tree.process.wait(timeout=10)
        self.assertTrue(alive(grandchild))
        self.assertEqual(tree.kill(), [])
        self.assertTrue(wait_gone(grandchild))
        self.assertEqual(tree.kill(), [])  # an empty group is not a failure

    def test_failed_group_signal_is_reported(self):
        tree, grandchild = self.start(ignore_term=False)
        try:
            with mock.patch.object(process_tree.os, "killpg", side_effect=PermissionError(1, "Operation not permitted")):
                problems = tree.stop(timeout=0.2)
            self.assertIn(f"cannot signal process group {tree.process.pid}: [Errno 1] Operation not permitted",
                          problems)
            self.assertIn(f"process {tree.process.pid} did not exit after it was killed", problems)
        finally:
            self.assertEqual(tree.stop(), [])
            self.assertTrue(wait_gone(grandchild))

    def test_adapter_reports_cleanup_failure_and_exits_non_zero(self):
        output = io.BytesIO()
        adapter = DebugAdapter(FramedStream(io.BytesIO(b""), output))
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            adapter.cleanup_failed("Robot worker", ["cannot signal process group 7: denied"])
            self.assertEqual(adapter.run(), CLEANUP_FAILED_EXIT)
        self.assertEqual(errors.getvalue(), "Debug cleanup failed: Robot worker: cannot signal process group 7: denied\n")
        event = FramedStream(io.BytesIO(output.getvalue()), None).read()
        self.assertEqual(event["body"], {"category": "important",
                                         "output": "Robot worker cleanup failed: cannot signal process group 7: denied\n"})


PEER = """
import sys
from robot_companion_backend import control
secret = control.parse_secret(sys.stdin.buffer.readline())
connection = control.connect(int(sys.argv[1]), secret)
connection.sendall(b"authenticated")
connection.close()
"""


class ControlChannelTests(unittest.TestCase):
    def foreign(self, port, payload, results, read_reply=False):
        with socket.create_connection((control.HOST, port), timeout=5) as connection:
            connection.sendall(payload)
            if read_reply:
                results.append(len(control.receive_exactly(connection, control.NONCE_BYTES + control.MAC_BYTES)))
                connection.sendall(b"\0" * control.MAC_BYTES)
            try:
                results.append(connection.recv(1))  # b"" once the listener closes it
            except ConnectionResetError:
                results.append(b"")

    def test_only_the_secret_holder_is_accepted(self):
        listener = control.ControlListener()
        results, refused = [], []
        foreigners = [threading.Thread(target=self.foreign, args=(listener.port, payload, results, reply))
                      for payload, reply in ((b"GET / HTTP/1.0\r\n\r\n" + b"x" * 64, False),
                                             (control.HELLO + b"n" * control.NONCE_BYTES, True))]
        for thread in foreigners:
            thread.start()
            thread.join(timeout=0.2)  # connect in order, before the real peer
        peer = subprocess.Popen([sys.executable, "-c", PEER, str(listener.port)], stdin=subprocess.PIPE)
        peer.stdin.write(listener.secret_line())
        peer.stdin.close()
        connection = listener.accept(20, lambda: True, refused.append)
        for thread in foreigners:
            thread.join(timeout=10)
        self.assertIsNotNone(connection)
        with connection:
            self.assertEqual(control.receive_exactly(connection, 13), b"authenticated")
        self.assertEqual(peer.wait(timeout=10), 0)
        self.assertEqual(len(refused), 2, refused)
        self.assertEqual(refused, listener.refused)
        self.assertIn("not a Robot worker control handshake", refused[0])
        self.assertIn("worker failed control authentication", refused[1])
        self.assertEqual(sorted(results, key=str), sorted([b"", 64, b""], key=str))
        with self.assertRaises(ConnectionRefusedError):  # one connection per session
            socket.create_connection((control.HOST, listener.port), timeout=2).close()

    def test_worker_refuses_a_listener_without_the_secret(self):
        impostor = socket.create_server((control.HOST, 0))
        def answer():
            connection, _ = impostor.accept()
            with connection:
                control.receive_exactly(connection, len(control.HELLO) + control.NONCE_BYTES)
                connection.sendall(os.urandom(control.NONCE_BYTES + control.MAC_BYTES))
                connection.recv(1)
        thread = threading.Thread(target=answer)
        thread.start()
        with self.assertRaisesRegex(control.ControlError, "control listener failed authentication"):
            control.connect(impostor.getsockname()[1], os.urandom(control.SECRET_BYTES))
        thread.join(timeout=10)
        impostor.close()

    def test_secret_line_parsing(self):
        listener = control.ControlListener()
        listener.close()
        self.assertEqual(control.parse_secret(listener.secret_line()), listener.secret)
        for line in (b"", b"\n", b"zz" * 32 + b"\n", b"ab" * 31 + b"\n", "é".encode() * 32):
            with self.assertRaisesRegex(control.ControlError, "did not supply a control secret"):
                control.parse_secret(line)

    def test_accept_ends_when_the_child_is_gone(self):
        listener = control.ControlListener()
        started = time.monotonic()
        self.assertIsNone(listener.accept(20, lambda: False))
        self.assertLess(time.monotonic() - started, 1)
        with self.assertRaises(ConnectionRefusedError):
            socket.create_connection((control.HOST, listener.port), timeout=2).close()


if __name__ == "__main__":
    unittest.main()

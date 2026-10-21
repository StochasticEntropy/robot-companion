"""Process-tree lifecycle and control-channel checks with real processes and sockets.

TreeTests run real process trees on the platform they run on: POSIX process groups on
Linux, Job Objects on Windows (observed with a Toolhelp32 process snapshot, see
processes.py). The pure Windows logic (Popen flags, Job Object layout, error mapping,
stop control flow with a stand-in job) and a win32 import emulation also run on Linux.
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
from robot_companion_backend.dap import CLEANUP_FAILED_EXIT, REPORTED_REFUSALS, DebugAdapter, Worker
from robot_companion_backend.process_tree import ProcessTree
from robot_companion_backend.protocol import FramedStream
from robot_companion_backend.python_debug import SessionReader
import processes

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
    """True for a live (not zombie, not exited) process (Linux /proc, Windows snapshot)."""
    info = processes.identity(pid)
    return info is not None and info["state"] != "Z"


def wait_gone(pid, timeout=10):
    deadline = time.monotonic() + timeout
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not alive(pid)


class WindowsLogicTests(unittest.TestCase):
    """Pure Windows logic, on every platform; TreeTests run the real Windows paths on Windows."""

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
        if processes.WINDOWS:  # the names are absent natively; nothing to remove
            self.assertEqual(report["removed"], [])
            self.assertFalse(hasattr(os, "killpg") or hasattr(signal, "SIGKILL"))
        else:
            self.assertIn("os.killpg", report["removed"])
            self.assertIn("signal.SIGKILL", report["removed"])
        self.assertTrue(report["windows"])
        self.assertEqual(report["options"], {"creationflags": process_tree.CREATE_NEW_PROCESS_GROUP
                                                              | process_tree.CREATE_SUSPENDED})

    def test_popen_options_per_platform(self):
        # CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED: resumed only after job assignment.
        self.assertEqual(process_tree.popen_options(windows=True), {"creationflags": 0x00000204})
        self.assertEqual(process_tree.popen_options(windows=False), {"start_new_session": True})
        self.assertEqual(process_tree.WINDOWS, sys.platform == "win32")

    def test_job_limit_structure_sets_kill_on_close(self):
        info = process_tree.job_limit_structure()
        self.assertEqual(info.BasicLimitInformation.LimitFlags, 0x00002000)
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows, 112 on 32-bit.
        self.assertEqual(ctypes.sizeof(info), {8: 144, 4: 112}[ctypes.sizeof(ctypes.c_void_p)])
        self.assertEqual(process_tree.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, 9)
        self.assertEqual(process_tree.PROCESS_SET_QUOTA | process_tree.PROCESS_TERMINATE, 0x0101)
        entry = process_tree.thread_entry_structure()
        self.assertEqual((ctypes.sizeof(entry), entry.dwSize), (28, 28))  # THREADENTRY32

    def kernel32(self, threads, resume_result=1, open_thread=77):
        """Stand-in kernel32 whose Toolhelp snapshot lists (thread ID, owner PID) pairs."""
        kernel32 = mock.Mock()
        kernel32.CreateToolhelp32Snapshot.return_value = 55
        kernel32.OpenThread.return_value = open_thread
        kernel32.ResumeThread.return_value = resume_result
        listing = iter(threads)
        def fill(snapshot, reference):
            try:
                reference._obj.th32ThreadID, reference._obj.th32OwnerProcessID = next(listing)
            except StopIteration:
                return 0
            return 1
        kernel32.Thread32First.side_effect = kernel32.Thread32Next.side_effect = fill
        return kernel32

    def test_resume_process_resumes_only_its_threads(self):
        kernel32 = self.kernel32([(1, 9), (2, 4242), (3, 9)])
        process_tree.resume_process(kernel32, 4242, lambda: 0)
        kernel32.CreateToolhelp32Snapshot.assert_called_once_with(process_tree.TH32CS_SNAPTHREAD, 0)
        kernel32.OpenThread.assert_called_once_with(process_tree.THREAD_SUSPEND_RESUME, False, 2)
        kernel32.ResumeThread.assert_called_once_with(77)
        self.assertEqual(kernel32.CloseHandle.call_args_list, [mock.call(77), mock.call(55)])

    def test_resume_process_error_mapping(self):
        for kernel32, message in (
                (self.kernel32([(2, 4242)], resume_result=process_tree.RESUME_FAILED),
                 "ResumeThread failed (Windows error 5)"),
                (self.kernel32([(2, 4242)], open_thread=None), "OpenThread failed (Windows error 5)"),
                (self.kernel32([(1, 9)]), "no thread of process 4242 to resume")):
            with self.subTest(message=message), self.assertRaises(OSError) as raised:
                process_tree.resume_process(kernel32, 4242, lambda: 5)
            self.assertEqual(str(raised.exception), message)
            self.assertIn(mock.call(55), kernel32.CloseHandle.call_args_list)  # snapshot always closed
        invalid = self.kernel32([])
        invalid.CreateToolhelp32Snapshot.return_value = ctypes.c_void_p(-1).value
        with self.assertRaisesRegex(OSError, "CreateToolhelp32Snapshot failed"):
            process_tree.resume_process(invalid, 4242, lambda: 5)

    def test_windows_error_mapping(self):
        error = process_tree.windows_error("TerminateJobObject", 5)
        self.assertIsInstance(error, OSError)
        self.assertEqual(str(error), "TerminateJobObject failed (Windows error 5)")

    def test_abnormal_exit_descriptions(self):
        for code in (None, 0, 1, 4, 252, 253, 255):
            self.assertIsNone(process_tree.abnormal_exit(code))
        self.assertEqual(process_tree.abnormal_exit(-9),
                         "terminated by signal 9" if processes.WINDOWS else "terminated by SIGKILL")
        self.assertEqual(process_tree.abnormal_exit(-15), "terminated by SIGTERM")
        self.assertEqual(process_tree.abnormal_exit(-200), "terminated by signal 200")
        self.assertEqual(process_tree.abnormal_exit(0xC0000005), "exit status 0xC0000005")

    def windows_tree(self, job, exits=True):
        tree = ProcessTree.__new__(ProcessTree)
        tree.job, tree.report, tree.lock, tree.reaped = job, mock.Mock(), threading.Lock(), False
        tree.process = mock.Mock(pid=4242, returncode=None)
        tree.process.poll.return_value = None
        if not exits:
            tree.process.wait.side_effect = subprocess.TimeoutExpired("worker", 0)
        return tree

    def test_failed_popen_closes_the_job_immediately(self):
        job = mock.Mock()
        with mock.patch.object(process_tree, "WINDOWS", True), \
                mock.patch.object(process_tree, "_WindowsJob", return_value=job), \
                mock.patch.object(process_tree.subprocess, "Popen", side_effect=OSError("failed spawn")):
            with self.assertRaisesRegex(OSError, "failed spawn"):
                ProcessTree(["missing"])
        job.close.assert_called_once_with()

    def test_failed_assignment_closes_pipes_and_process_handle(self):
        job, child = mock.Mock(), mock.Mock(returncode=1)
        job.assign_and_resume.side_effect = OSError("failed assignment")
        with mock.patch.object(process_tree, "WINDOWS", True), \
                mock.patch.object(process_tree, "_WindowsJob", return_value=job), \
                mock.patch.object(process_tree.subprocess, "Popen", return_value=child):
            with self.assertRaisesRegex(OSError, "failed assignment"):
                ProcessTree(["worker"])
        child.kill.assert_called_once_with()
        child.wait.assert_called_once_with()
        job.close.assert_called_once_with()
        child._handle.Close.assert_called_once_with()
        for pipe in (child.stdin, child.stdout, child.stderr):
            pipe.close.assert_called_once_with()

    def test_windows_stop_terminates_job_without_console_signal(self):
        job = mock.Mock()
        tree = self.windows_tree(job)
        with mock.patch.object(process_tree.os, "kill") as kill, \
                mock.patch.object(process_tree.os, "killpg", create=True) as killpg:
            self.assertEqual(tree.stop(timeout=0), [])
        kill.assert_not_called()  # no CTRL_BREAK_EVENT, which can reach the whole console
        killpg.assert_not_called()
        self.assertEqual(job.terminate.call_count, 2)  # the tree, then members that outlived the leader
        self.assertTrue(tree.reaped)
        tree.report.assert_not_called()

    def test_windows_failed_terminate_is_reported(self):
        job = mock.Mock()
        job.terminate.side_effect = process_tree.windows_error("TerminateJobObject", 5)
        tree = self.windows_tree(job, exits=False)
        problems = tree.stop(timeout=0)
        failure = "cannot terminate job of process 4242: TerminateJobObject failed (Windows error 5)"
        self.assertEqual(problems, [failure, failure, "process 4242 did not exit after it was killed"])
        self.assertEqual(tree.report.call_args_list, [mock.call([problem]) for problem in problems])


class TreeTests(unittest.TestCase):
    """Real trees: a child that started a grandchild Python process (on Windows each below a
    venv launcher). POSIX stops the group with SIGTERM, then SIGKILL; Windows terminates the
    Job Object at once (no console signal)."""

    def setUp(self):
        processes.snapshot()  # fail explicitly if processes cannot be observed
        self.directory = Path(tempfile.mkdtemp(prefix="rcb-tree-"))

    def tearDown(self):
        for path in self.directory.iterdir():
            path.unlink()
        self.directory.rmdir()

    def start(self, ignore_term, executable=sys.executable):
        marker = self.directory / "grandchild.pid"
        guard = "signal.signal(signal.SIGTERM, signal.SIG_IGN); " if ignore_term else ""
        grandchild = f"import signal, time; {guard}time.sleep(120)"
        child = (f"import pathlib, signal, subprocess, sys, time; {guard}"
                 f"p = subprocess.Popen([sys.executable, '-c', {grandchild!r}]); "
                 f"pathlib.Path({str(marker)!r}).write_text(str(p.pid)); time.sleep(120)")
        tree = ProcessTree([executable, "-c", child])
        deadline = time.monotonic() + 10
        while not (marker.is_file() and marker.read_text(encoding="utf-8")) and time.monotonic() < deadline:
            time.sleep(0.02)
        grandchild_pid = int(marker.read_text(encoding="utf-8"))
        # Every process of the tree, to prove none survives (Windows: launchers and interpreters).
        self.owned = processes.descendants(os.getpid())
        self.assertIn(tree.process.pid, self.owned)
        self.assertIn(grandchild_pid, self.owned)
        return tree, grandchild_pid

    def assert_tree_gone(self, timeout=10):
        deadline = time.monotonic() + timeout
        while (left := processes.alive(self.owned)) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(left, {}, "Tree processes survived")

    def test_stop_terminates_child_and_grandchild_in_own_group(self):
        tree, grandchild = self.start(ignore_term=False)
        if processes.WINDOWS:
            self.assertIsNotNone(tree.job)  # a kill-on-close Job Object, not a console group
        else:
            self.assertEqual(os.getpgid(tree.process.pid), tree.process.pid)
            self.assertNotEqual(os.getpgid(tree.process.pid), os.getpgrp())
        self.assertEqual(tree.stop(), [])
        expected = process_tree.TERMINATED_EXIT_CODE if processes.WINDOWS else -signal.SIGTERM
        self.assertEqual(tree.process.returncode, expected)
        self.assertTrue(wait_gone(grandchild))
        self.assert_tree_gone()

    def test_stop_escalates_to_kill_for_term_ignoring_tree(self):
        tree, grandchild = self.start(ignore_term=True)
        started = time.monotonic()
        self.assertEqual(tree.stop(timeout=0.5), [])
        if processes.WINDOWS:  # no graceful step: the ignored SIGTERM handler plays no part
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(tree.process.returncode, process_tree.TERMINATED_EXIT_CODE)
        else:
            self.assertGreaterEqual(time.monotonic() - started, 0.5)
            self.assertEqual(tree.process.returncode, -signal.SIGKILL)
        self.assertTrue(wait_gone(grandchild))
        self.assert_tree_gone()

    def test_leftovers_are_killed_before_the_leader_is_reaped(self):
        # On Windows the leader is the base interpreter itself: a venv launcher's own
        # kill-on-close job would end its interpreter with it and hide the leftovers.
        executable = getattr(sys, "_base_executable", sys.executable) if processes.WINDOWS else sys.executable
        tree, grandchild = self.start(ignore_term=False, executable=executable)
        self.assertTrue(processes.kill(tree.process.pid, self.owned[tree.process.pid]))  # only the leader
        if processes.WINDOWS:
            # The leader's exit leaves its descendants running in the job until the reap.
            time.sleep(0.5)
            self.assertTrue(alive(grandchild))
            real_terminate = tree.job.terminate
            with mock.patch.object(tree.job, "terminate", side_effect=real_terminate) as terminate:
                self.assertEqual(tree.wait(timeout=10), processes.TERMINATED_BY_TEST)
                self.assertTrue(wait_gone(grandchild))
                self.assertEqual(tree.stop(), [])
                self.assertEqual(tree.poll(), processes.TERMINATED_BY_TEST)
            self.assertEqual(terminate.call_count, 1)
            self.assert_tree_gone()
            return
        signals = []
        real_killpg = os.killpg
        def record(pgid, number):
            # The exited leader is still an unreaped zombie, keeping its group ID reserved.
            state = Path(f"/proc/{pgid}/stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0]
            signals.append((pgid, number, state))
            real_killpg(pgid, number)
        with mock.patch.object(process_tree.os, "killpg", side_effect=record):
            self.assertEqual(tree.wait(timeout=10), -signal.SIGKILL)
            self.assertTrue(wait_gone(grandchild))
            self.assertEqual(signals, [(tree.process.pid, signal.SIGKILL, "Z")])
            # After the reap no signal is sent again: the PID may now belong to another group.
            self.assertEqual(tree.stop(), [])
            self.assertEqual(tree.poll(), -signal.SIGKILL)
        self.assertEqual(len(signals), 1)

    def test_failed_group_signal_is_reported(self):
        tree, grandchild = self.start(ignore_term=False)
        try:
            if processes.WINDOWS:
                denied = process_tree.windows_error("TerminateJobObject", 5)
                with mock.patch.object(tree.job, "terminate", side_effect=denied):
                    problems = tree.stop(timeout=0.2)
                self.assertIn(f"cannot terminate job of process {tree.process.pid}: {denied}", problems)
            else:
                with mock.patch.object(process_tree.os, "killpg",
                                       side_effect=PermissionError(1, "Operation not permitted")):
                    problems = tree.stop(timeout=0.2)
                self.assertIn(f"cannot signal process group {tree.process.pid}: [Errno 1] Operation not permitted",
                              problems)
            self.assertIn(f"process {tree.process.pid} did not exit after it was killed", problems)
        finally:
            self.assertEqual(tree.stop(), [])
            self.assertTrue(wait_gone(grandchild))
            self.assert_tree_gone()

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

    def test_cleanup_failure_is_reported_after_the_client_is_gone(self):
        class ClosedPipe(io.BytesIO):
            def write(self, data):
                raise BrokenPipeError(32, "Broken pipe")
        adapter = DebugAdapter(FramedStream(io.BytesIO(b""), ClosedPipe()))
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            adapter.cleanup_failed("Python adapter", ["process 9 did not exit after it was killed"])
            self.assertEqual(adapter.run(), CLEANUP_FAILED_EXIT)  # no BrokenPipeError escapes cleanup
        self.assertTrue(adapter.client_gone)
        self.assertEqual(errors.getvalue(), "Debug cleanup failed: Python adapter: process 9 did not exit after it was killed\n")


class SessionReaderTests(unittest.TestCase):
    def test_idle_reader_stops_without_peer_eof(self):
        connection, peer = socket.socketpair()
        stopping, results = threading.Event(), []
        reader = SessionReader(connection, stopping)
        thread = threading.Thread(target=lambda: results.append(FramedStream(reader, None).read()))
        try:
            thread.start()
            time.sleep(0.05)
            stopping.set()  # Keep peer open: stop must not require an EOF/shutdown.
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "Session reader did not cancel")
            self.assertEqual(results, [None])
        finally:
            stopping.set()
            peer.close()
            connection.close()
            thread.join(timeout=2)
            reader.close()

    def test_fragmented_frames_preserve_unicode_and_buffered_messages(self):
        connection, peer = socket.socketpair()
        reader = SessionReader(connection, threading.Event())
        message = {"type": "request", "command": "evaluate", "arguments": {"expression": "Ä😀"}}
        payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
        frame = f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload
        def send():
            for part in (frame[:3], frame[3:20], frame[20:-3], frame[-3:], frame):
                peer.sendall(part)
        thread = threading.Thread(target=send)
        try:
            connection.settimeout(2)
            thread.start()
            stream = FramedStream(reader, None)
            self.assertEqual(stream.read(), message)
            self.assertEqual(stream.read(), message)
        finally:
            peer.close()
            connection.close()
            thread.join(timeout=2)
            reader.close()


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
        self.assertEqual(listener.server.fileno(), -1)  # descriptor is actually closed
        # Windows may retry a refused SYN beyond two seconds. Require explicit
        # ECONNREFUSED within ten seconds; a timeout still fails this assertion.
        with self.assertRaises(ConnectionRefusedError):  # one connection per session
            socket.create_connection((control.HOST, listener.port), timeout=10).close()

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

    def test_handshake_deadline_covers_a_slow_drip(self):
        listener = control.ControlListener()
        stop = threading.Event()
        def drip():
            with socket.create_connection((control.HOST, listener.port), timeout=5) as connection:
                for byte in control.HELLO:
                    if stop.wait(0.3):
                        return
                    try:
                        connection.sendall(bytes([byte]))
                    except OSError:
                        return
        thread = threading.Thread(target=drip)
        thread.start()
        refused, started = [], time.monotonic()
        with mock.patch.object(control, "HANDSHAKE_TIMEOUT", 1):
            self.assertIsNone(listener.accept(20, lambda: not refused, refused.append))
        elapsed = time.monotonic() - started
        stop.set()
        thread.join(timeout=10)
        self.assertEqual(len(refused), 1)
        self.assertIn("timed out", refused[0])
        self.assertLess(elapsed, 2.5)  # one bound for the whole handshake, not per byte

    def test_refused_connection_output_is_capped(self):
        worker = Worker.__new__(Worker)
        worker.adapter, worker.refusals = mock.Mock(), 0
        for number in range(25):
            worker._refused(f"127.0.0.1:{number} (worker failed control authentication)")
        outputs = [c.args[1]["output"] for c in worker.adapter.event.call_args_list]
        self.assertEqual(len(outputs), REPORTED_REFUSALS + 1)
        self.assertTrue(outputs[0].startswith("Refused an unauthenticated Robot worker control connection: 127.0.0.1:0"))
        self.assertEqual(outputs[-1], "Refused more unauthenticated Robot worker control connections; "
                                      "no longer reporting each\n")

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
        self.assertEqual(listener.server.fileno(), -1)
        with self.assertRaises(ConnectionRefusedError):
            socket.create_connection((control.HOST, listener.port), timeout=10).close()


if __name__ == "__main__":
    unittest.main()

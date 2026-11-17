"""Darwin process-group checks for a reaped leader and its remaining children."""

import contextlib
import os
import signal
import subprocess
import sys
import unittest
from unittest import mock

from robot_companion_backend import process_tree
from robot_companion_backend.process_tree import ProcessTree


@unittest.skipUnless(sys.platform == "darwin", "requires Darwin process-group state")
class DarwinGroupTests(unittest.TestCase):
    def test_successful_worker_with_zombie_only_group_has_no_cleanup_error(self):
        report = mock.Mock()
        tree = ProcessTree([sys.executable, "-c", "pass"], report=report)
        self.assertEqual(tree.wait(timeout=10), 0)
        self.assertEqual(tree.stop(), [])
        report.assert_not_called()

    def test_denied_signal_is_reported_if_exited_leader_left_a_live_child(self):
        report = mock.Mock()
        leader = (
            "import subprocess, sys; "
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], "
            "stdout=subprocess.DEVNULL); print(child.pid, flush=True)"
        )
        tree = ProcessTree([sys.executable, "-c", leader], report=report, stdout=subprocess.PIPE)
        with tree.process.stdout as output:
            child = int(output.readline())
        try:
            denied = PermissionError(1, "Operation not permitted")
            with mock.patch.object(process_tree.os, "killpg", side_effect=denied):
                self.assertEqual(tree.wait(timeout=10), 0)
            report.assert_called_once_with([f"cannot signal process group {tree.process.pid}: {denied}"])
        finally:
            # Signal the child directly as the tested tree has reaped its group leader.
            with contextlib.suppress(ProcessLookupError):
                os.kill(child, signal.SIGKILL)

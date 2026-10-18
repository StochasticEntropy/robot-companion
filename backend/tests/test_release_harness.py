"""Mechanical release-tool checks. These do not prove live RF/debugpy behavior."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from release_runner import Runner, processes, safe_environment
from verify_release import ROOT, ReceiptResult, suite_result


class ReleaseHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rcb-release-tool-')
        self.work = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_real_command_exit_log_and_environment(self):
        code = "import os,sys; print('Ä😀', 'PAPERCLIP_API_KEY' in os.environ); sys.exit(7)"
        with Runner(self.work) as runner:
            result = runner.run('exit7', [sys.executable, '-c', code], self.work, safe_environment())
        self.assertEqual(result['exit'], 7)
        self.assertFalse(result['passed'])
        self.assertFalse(result['cleanupNeeded'])
        self.assertEqual((self.work / 'exit7.txt').read_text().strip(), 'Ä😀 False')
        self.assertEqual(json.loads((self.work / 'exit7.json').read_text())['exit'], 7)

    def detached_command(self, wait):
        pid_file = self.work / 'child.pid'
        ready = self.work / 'ready'
        child = ("import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                 f"pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(60)")
        parent = ("import os,pathlib,signal,subprocess,sys,time; "
                  "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                  f"p=subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True); "
                  f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid)); "
                  f"ready=pathlib.Path({str(ready)!r})\n"
                  "deadline=time.monotonic()+5\n"
                  "while not ready.exists() and time.monotonic()<deadline: time.sleep(.01)\n"
                  + ("time.sleep(60)\n" if wait else "sys.exit(0)\n"))
        return [sys.executable, '-c', parent], pid_file

    def test_timeout_kills_and_reaps_detached_term_ignoring_child(self):
        command, pid_file = self.detached_command(wait=True)
        with Runner(self.work, timeout=0.5, grace=0.15) as runner:
            result = runner.run('timeout', command, self.work, safe_environment())
        self.assertTrue(result['timedOut'])
        self.assertEqual(result['exit'], 124)
        self.assertEqual(result['processExit'], -9)
        self.assertTrue(result['cleanupNeeded'])
        self.assertEqual(result['cleanupSurvivors'], [])
        self.assertNotIn(int(pid_file.read_text()), processes())

    def test_successful_parent_with_orphan_is_failed_and_cleaned(self):
        command, pid_file = self.detached_command(wait=False)
        with Runner(self.work, timeout=5, grace=0.15) as runner:
            result = runner.run('orphan', command, self.work, safe_environment())
        self.assertEqual(result['exit'], 0)
        self.assertTrue(result['cleanupNeeded'])
        self.assertFalse(result['passed'], 'A clean exit cannot hide leaked children')
        self.assertEqual(result['cleanupSurvivors'], [])
        self.assertNotIn(int(pid_file.read_text()), processes())

    def test_zero_tests_and_skipped_live_suite_cannot_pass(self):
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=ReceiptResult).run(unittest.TestSuite())
        self.assertFalse(suite_result(result)['passed'])
        class Skipped(unittest.TestCase):
            @unittest.skip('synthetic receipt check, not a backend capability')
            def test_skip(self):
                pass
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=ReceiptResult).run(unittest.defaultTestLoader.loadTestsFromTestCase(Skipped))
        self.assertEqual(suite_result(result, required_live=True)['passedTests'], 0)
        self.assertFalse(suite_result(result, required_live=True)['passed'])
        class ExpectedFailure(unittest.TestCase):
            @unittest.expectedFailure
            def test_expected(self):
                self.fail('synthetic receipt check')
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=ReceiptResult).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(ExpectedFailure))
        self.assertFalse(suite_result(result, required_live=True)['passed'])

    def test_success_counts_use_outcomes_not_subtest_failure_records(self):
        class Outcomes(unittest.TestCase):
            def test_subtests(self):
                for value in (1, 2):
                    with self.subTest(value=value):
                        self.fail('synthetic subtest count check')
            def test_success(self):
                pass
            @unittest.expectedFailure
            def test_unexpected_success(self):
                pass
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=ReceiptResult).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(Outcomes))
        counts = suite_result(result)
        self.assertEqual((counts['run'], counts['failures'], counts['unexpectedSuccesses'], counts['passedTests']),
                         (3, 2, 1, 1))
        self.assertFalse(counts['passed'])

    def test_missing_explicit_wheel_input_cannot_start_release(self):
        # The installed conformance copy deliberately has no Git metadata. This
        # input guard must run before source lookup or any build command.
        evidence = self.work / 'evidence'
        result = subprocess.run([sys.executable, str(SCRIPTS / 'verify_release.py'), '--evidence', str(evidence)],
                                cwd=self.work, env=safe_environment(), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--evidence and --wheels are required', result.stderr)
        self.assertFalse(evidence.exists())

    def test_evidence_may_not_be_written_in_checkout(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / 'verify_release.py'), '--evidence', str(ROOT),
                                 '--wheels', str(self.work / 'absent-wheels')], env=safe_environment(),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('outside the checkout', result.stderr)


if __name__ == '__main__':
    unittest.main()

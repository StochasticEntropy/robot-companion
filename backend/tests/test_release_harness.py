"""Mechanical release-tool checks. These do not prove live RF/debugpy behavior."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import processes
from release_runner import WINDOWS, Runner, safe_environment
from verify_release import ROOT, ReceiptResult, suite_result


class ReleaseHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rcb-release-tool-')
        self.work = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_real_command_exit_log_and_environment(self):
        # This synthetic producer promises UTF-8, independently of the inherited
        # Windows pipe encoding. The runner itself preserves bytes without decoding.
        code = ("import os,sys; sys.stdout.reconfigure(encoding='utf-8'); "
                "print('Ä😀', 'PAPERCLIP_API_KEY' in os.environ); sys.exit(7)")
        env = safe_environment()
        self.assertNotIn('PYTHONUTF8', env)
        self.assertNotIn('PYTHONIOENCODING', env)
        with Runner(self.work) as runner:
            for encoding in ('cp1252', 'utf-8'):
                with self.subTest(inherited_pipe_encoding=encoding):
                    name = 'exit7-' + encoding
                    result = runner.run(name, [sys.executable, '-c', code], self.work,
                                        {**env, 'PYTHONIOENCODING': encoding})
                    self.assertEqual(result['exit'], 7)
                    self.assertFalse(result['passed'])
                    self.assertFalse(result['cleanupNeeded'])
                    self.assertEqual((self.work / (name + '.txt')).read_bytes(),
                                     ('Ä😀 False' + os.linesep).encode('utf-8'))
                    self.assertEqual(json.loads((self.work / (name + '.json')).read_text(encoding='utf-8'))['exit'], 7)

    def test_machine_stdout_is_separate_from_successful_stderr_warning(self):
        command = [sys.executable, '-c', "import sys; print('machine-Ä'); print('benign warning Ä',file=sys.stderr)"]
        with Runner(self.work) as runner:
            result = runner.run('streams', command, self.work,
                                {**safe_environment(), 'PYTHONIOENCODING': 'cp1252'}, separate_stdout=True)
        self.assertTrue(result['passed'])
        # Legacy encodings and native newlines are retained in both files.
        self.assertEqual(Path(result['stdout']).read_bytes(), ('machine-Ä' + os.linesep).encode('cp1252'))
        self.assertEqual(Path(result['log']).read_bytes(), ('benign warning Ä' + os.linesep).encode('cp1252'))

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
        self.assertEqual(result['processExit'], 1 if WINDOWS else -9)  # Windows: TerminateProcess exit code 1
        self.assertTrue(result['cleanupNeeded'])
        self.assertEqual(result['cleanupSurvivors'], [])
        self.assertIsNone(processes.identity(int(pid_file.read_text(encoding="utf-8"))))

    def test_successful_parent_with_orphan_is_failed_and_cleaned(self):
        command, pid_file = self.detached_command(wait=False)
        with Runner(self.work, timeout=5, grace=0.15) as runner:
            result = runner.run('orphan', command, self.work, safe_environment())
        self.assertEqual(result['exit'], 0)
        self.assertTrue(result['cleanupNeeded'])
        self.assertFalse(result['passed'], 'A clean exit cannot hide leaked children')
        self.assertEqual(result['cleanupSurvivors'], [])
        self.assertIsNone(processes.identity(int(pid_file.read_text(encoding="utf-8"))))

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

    def test_in_tree_build_is_reproducible_with_valid_record(self):
        outputs = []
        for name in ('first', 'second'):
            env = {**safe_environment(), 'SOURCE_DATE_EPOCH': '1760000000'}
            result = subprocess.run([sys.executable, str(SCRIPTS / 'build_dists.py'), str(SCRIPTS.parent),
                                     str(self.work / name)], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            outputs.append({p.name: p.read_bytes() for p in (self.work / name).iterdir()})
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(sorted(outputs[0]), ['robot_companion_backend-0.1.0.dev1-py3-none-any.whl',
                                              'robot_companion_backend-0.1.0.dev1.tar.gz'])
        with zipfile.ZipFile(self.work / 'first' / 'robot_companion_backend-0.1.0.dev1-py3-none-any.whl') as wheel:
            info = 'robot_companion_backend-0.1.0.dev1.dist-info/'
            rows = [row.rsplit(',', 2) for row in wheel.read(info + 'RECORD').decode().splitlines()]
            for path, digest, size in rows:
                if path == info + 'RECORD':
                    continue
                data = wheel.read(path)
                expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                self.assertEqual((digest, size), (f'sha256={expected}', str(len(data))))
            self.assertEqual({r[0] for r in rows}, set(wheel.namelist()))
            modules = [n for n in wheel.namelist() if not n.startswith(info)]
            self.assertTrue(modules and all(n.endswith('.py') for n in modules), modules)
            self.assertIn(info + 'licenses/LICENSE', wheel.namelist())
            metadata = wheel.read(info + 'METADATA').decode()
            # Packaging metadata declares exactly the runtime gate's supported rows.
            from robot_companion_backend.runtime import SUPPORTED
            self.assertIn('Requires-Python: >=3.11,!=3.12.*,<3.14\n', metadata)
            pins = re.findall(r'^Requires-Dist: robotframework==(\S+); python_version == "(\d+)\.(\d+)"$',
                              metadata, re.M)
            self.assertEqual(sorted(((int(major), int(minor)), robot) for robot, major, minor in pins),
                             sorted(SUPPORTED))
            self.assertEqual(len(re.findall(r'^Requires-Dist: robotframework(?![-\w])', metadata, re.M)), len(SUPPORTED))
            self.assertIn('Requires-Dist: debugpy==1.8.22\n', metadata)
            self.assertIn('Provides-Extra: format\nRequires-Dist: robotframework-robocop==9.1.0; extra == "format"\n',
                          metadata)
            self.assertIn('License-File: LICENSE\n', metadata)
            self.assertIn('robot-companion-backend = robot_companion_backend.__main__:main',
                          wheel.read(info + 'entry_points.txt').decode())

    def test_evidence_may_not_be_written_in_checkout(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / 'verify_release.py'), '--evidence', str(ROOT),
                                 '--wheels', str(self.work / 'absent-wheels')], env=safe_environment(),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('outside the checkout', result.stderr)


if __name__ == '__main__':
    unittest.main()

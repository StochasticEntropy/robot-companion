"""CI plumbing regressions. These do not claim that Windows product tests passed."""

import contextlib
import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("windows_backend_ci", Path(__file__).with_name("windows-backend.py"))
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)


class FakeChild:
    pid = 111
    _handle = 1234
    returncode = 0

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        return self.returncode

    def kill(self):
        self.returncode = 1


class FakeJob:
    """Synthetic command plumbing only; never used by the real Windows pipeline."""

    def __init__(self, leftovers=False):
        self.leftovers = leftovers
        self.closed = False
        self.resumed = False
        self.terminated = False

    def identity(self, pid):
        return {"pid": pid, "created": 42, "running": not self.closed, "exitCode": 259 if not self.closed else 0}

    def assign_and_resume(self, child):
        self.resumed = True

    def members(self):
        return [222] if self.leftovers and not self.terminated else []

    def terminate(self):
        self.terminated = True

    def close(self):
        self.closed = True


class FakeArchitectureApi:
    """Native-call decision fixture; not evidence of a Windows API execution."""

    def __init__(self, native=0x8664, process=0, success=True):
        self.native, self.process, self.success = native, process, success
        self.calls = 0

    def GetCurrentProcess(self):
        return -1

    def IsWow64Process2(self, handle, process, native):
        self.calls += 1
        ctypes.cast(process, ctypes.POINTER(ctypes.c_ushort)).contents.value = self.process
        ctypes.cast(native, ctypes.POINTER(ctypes.c_ushort)).contents.value = self.native
        return self.success


class CiPlumbingTests(unittest.TestCase):
    def test_architecture_decision_uses_native_result_not_environment_or_platform_hint(self):
        api = FakeArchitectureApi()
        with mock.patch.dict(os.environ, {"PROCESSOR_ARCHITECTURE": "ARM64"}, clear=True), \
                mock.patch.object(CI.platform, "machine", side_effect=AssertionError("not a native proof")):
            proof = CI.windows_architecture(api=api, pointer_bits=64)
        self.assertTrue(proof["nativeX64"])
        self.assertEqual((proof["nativeMachine"], proof["processMachine"], proof["pointerBits"]),
                         ("0x8664", "0x0000", 64))
        self.assertEqual(api.calls, 1)

    def test_architecture_decision_rejects_x86_arm64_and_wrong_pointer_width(self):
        for api, bits in ((FakeArchitectureApi(process=0x014c), 32),
                          (FakeArchitectureApi(native=0xaa64, process=0x8664), 64),
                          (FakeArchitectureApi(), 32)):
            with self.subTest(native=api.native, process=api.process, bits=bits), \
                    mock.patch.dict(os.environ, {"PROCESSOR_ARCHITECTURE": "AMD64"}, clear=True):
                self.assertFalse(CI.windows_architecture(api=api, pointer_bits=bits)["nativeX64"])

    def test_architecture_api_failure_is_not_a_successful_observation(self):
        with self.assertRaisesRegex(OSError, "IsWow64Process2 failed"):
            CI.windows_architecture(api=FakeArchitectureApi(success=False), pointer_bits=64)

    def test_safe_environment_preserves_windows_loader_paths_but_not_credentials(self):
        result = CI.safe_environment({"SystemRoot": "C:\\Windows", "TEMP": "C:\\Temp", "Path": "bin",
            "GITHUB_TOKEN": "do-not-forward", "PAPERCLIP_API_KEY": "do-not-forward",
            "PYTHONPATH": "source", "HTTPS_PROXY": "proxy", "PIP_INDEX_URL": "credential-index"})
        self.assertEqual(result["SystemRoot"], "C:\\Windows")
        self.assertEqual(result["TEMP"], "C:\\Temp")
        self.assertEqual(result["Path"], "bin")
        for key in ("GITHUB_TOKEN", "PAPERCLIP_API_KEY", "PYTHONPATH", "HTTPS_PROXY", "PIP_INDEX_URL"):
            self.assertNotIn(key, result)
        self.assertEqual(result["PYTHONUTF8"], "1")

    def test_case_counts_do_not_turn_skips_or_subtest_failures_into_passes(self):
        class Cases(unittest.TestCase):
            def test_ok(self):
                pass

            def test_subtest(self):
                for value in range(2):
                    with self.subTest(value=value):
                        self.fail("synthetic count check")

            @unittest.skip("synthetic count check")
            def test_skipped(self):
                pass

        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=CI.CaseResult).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
        self.assertEqual(result.testsRun, 3)
        self.assertCountEqual([case["status"] for case in result.cases.values()], ["passed", "failed", "skipped"])
        self.assertEqual(len(result.failures), 2)

    def test_zero_case_suite_is_a_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_transport.py").write_text("# no cases\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(CI.__file__)), "--suite-worker", "transport",
                "--tests", directory, "--receipt", str(root / "counts.json")], capture_output=True, text=True,
                timeout=30, env=CI.safe_environment())
            self.assertEqual(result.returncode, 1, result.stderr)
            counts = json.loads((root / "counts.json").read_text())
            self.assertEqual(counts["run"], 0)
            self.assertFalse(counts["allPassed"])

    def test_skipped_subtest_does_not_become_a_successful_required_case(self):
        class Cases(unittest.TestCase):
            def test_subtest(self):
                with self.subTest(value="skip"):
                    self.skipTest("synthetic skipped subtest")
                with self.subTest(value="pass"):
                    pass

        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=CI.CaseResult).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
        self.assertEqual(result.testsRun, 1)
        self.assertEqual(next(iter(result.cases.values()))["status"], "skipped")

    def test_full_transport_selection_keeps_every_failure_and_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_transport.py").write_text("import unittest\nclass T(unittest.TestCase):\n"
                "    def test_a(self): pass\n    def test_b(self): self.fail('known failure')\n"
                "    @unittest.skip('known skip')\n    def test_c(self): pass\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(CI.__file__)), "--suite-worker", "transport",
                "--tests", directory, "--receipt", str(root / "counts.json")], capture_output=True, text=True,
                timeout=30, env=CI.safe_environment())
            self.assertEqual(result.returncode, 1, result.stderr)
            counts = json.loads((root / "counts.json").read_text())
            self.assertEqual((counts["selected"], counts["run"], counts["passed"], counts["failed"], counts["skipped"]),
                             (3, 3, 1, 1, 1))
            self.assertFalse(counts["allPassed"])

    def test_fixture_failure_retains_named_counts_when_no_test_body_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_transport.py").write_text("import unittest\nclass T(unittest.TestCase):\n"
                "    @classmethod\n    def setUpClass(cls): raise RuntimeError('synthetic fixture failure')\n"
                "    def test_a(self): pass\n    def test_b(self): pass\n", encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(CI.__file__)), "--suite-worker", "transport",
                "--tests", directory, "--receipt", str(root / "counts.json")], capture_output=True, text=True,
                timeout=30, env=CI.safe_environment())
            self.assertEqual(result.returncode, 1, result.stderr)
            counts = json.loads((root / "counts.json").read_text())
            self.assertEqual((counts["selected"], counts["run"], counts["error"], counts["fixtureFailures"]),
                             (2, 0, 1, 1))
            self.assertIn("setUpClass", counts["cases"][0]["id"])
            self.assertFalse(counts["allPassed"])

    def test_isolated_worker_explicit_utf8_mode_overrides_ignored_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_transport.py").write_text("import pathlib,tempfile,unittest\nclass T(unittest.TestCase):\n"
                "    def test_utf8_fixture(self):\n        with tempfile.TemporaryDirectory() as d:\n"
                "            p=pathlib.Path(d)/'Library.py'\n            p.write_text('ü')\n"
                "            self.assertEqual(p.read_bytes(),bytes([0xc3,0xbc]))\n", encoding="utf-8")
            env = CI.safe_environment()
            env["PYTHONUTF8"] = "0"  # -I ignores this; -X utf8 is the explicit CI contract.
            result = subprocess.run([sys.executable, "-I", "-X", "utf8", str(Path(CI.__file__)),
                "--suite-worker", "transport", "--tests", directory, "--receipt", str(root / "counts.json")],
                capture_output=True, text=True, timeout=30, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            counts = json.loads((root / "counts.json").read_text())
            self.assertTrue(counts["allPassed"])
            self.assertEqual(counts["executionContext"]["utf8Mode"], 1)
            self.assertEqual(counts["executionContext"]["isolated"], 1)

    def test_a_leaked_descendant_is_not_hidden_by_successful_ci_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            job = FakeJob(leftovers=True)
            runner = CI.CommandRunner(directory, job_factory=lambda: job)
            with mock.patch.object(CI.subprocess, "Popen", return_value=FakeChild()):
                result = runner.run("leak", ["python", "test.py"], directory, {})
            self.assertEqual(result["exit"], 0)
            self.assertTrue(job.resumed and job.terminated and job.closed)
            self.assertTrue(result["cleanupNeeded"])
            self.assertEqual(result["cleanupSurvivors"], [])
            self.assertIn(222, [identity["pid"] for identity in result["ownedProcesses"]])
            self.assertTrue(result["processObservationComplete"])
            self.assertFalse(result["passed"])

    def test_clean_command_records_root_identity_and_command_array(self):
        with tempfile.TemporaryDirectory() as directory:
            job = FakeJob()
            runner = CI.CommandRunner(directory, job_factory=lambda: job)
            with mock.patch.object(CI.subprocess, "Popen", return_value=FakeChild()) as popen:
                result = runner.run("clean", ["python", "a path/it's a test.py"], directory, {})
            self.assertTrue(result["passed"])
            self.assertEqual(result["ownedProcesses"][0]["pid"], 111)
            self.assertFalse(popen.call_args.kwargs["shell"])
            self.assertEqual(popen.call_args.kwargs["creationflags"], 0x204)
            self.assertEqual(result["command"], ["python", "a path/it's a test.py"])

    @unittest.skipIf(os.name == "nt", "The refusal assertion needs a non-Windows host")
    def test_non_windows_probe_is_explicitly_blocked_not_a_windows_pass(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            code = CI.main(["--source", str(root / "source"), "--evidence", str(root / "evidence")])
            result = json.loads((root / "evidence/result.json").read_text())
        self.assertEqual(code, 2)
        self.assertEqual(result["outcome"], "Blocked")
        self.assertFalse(result["qualification"])
        self.assertFalse(result["cleanup"]["observed"])
        self.assertIn("genuine Windows", result["error"])


if __name__ == "__main__":
    unittest.main()

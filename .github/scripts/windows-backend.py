"""Initial installed-wheel Windows probes; deliberately not MIS-434 qualification.

The product checkout is read-only. Existing test methods run unchanged against an
isolated installed backend, including known Windows failures. CI process ownership
uses its own Windows Job Object, rather than trusting product cleanup as its oracle.
"""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import unittest


ROWS = {"3.13": "7.5", "3.11": "7.3.2"}
TOOLING_CASES = (
    "test_release_harness.ReleaseHarnessTests.test_zero_tests_and_skipped_live_suite_cannot_pass",
    "test_release_harness.ReleaseHarnessTests.test_success_counts_use_outcomes_not_subtest_failure_records",
    "test_release_harness.ReleaseHarnessTests.test_missing_explicit_wheel_input_cannot_start_release",
    "test_release_harness.ReleaseHarnessTests.test_in_tree_build_is_reproducible_with_valid_record",
    "test_release_harness.ReleaseHarnessTests.test_evidence_may_not_be_written_in_checkout",
)
PROBE = """import importlib.metadata as m, importlib.util as u, json, sys
import robot_companion_backend as backend
print(json.dumps({'python': sys.version, 'executable': sys.executable, 'prefix': sys.prefix,
 'backendFile': backend.__file__, 'robotcodePresent': u.find_spec('robotcode') is not None,
 'distributions': {d.metadata['Name'].lower().replace('_', '-'): d.version for d in m.distributions()}}))
"""


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def safe_environment(original=None):
    original = os.environ if original is None else original
    # Windows loader/temp paths are necessary. Never forward task tokens, GitHub
    # credentials, proxies, user-site configuration or an inherited PYTHONPATH.
    keep = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
            "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA"}
    result = {key: value for key, value in original.items() if key.upper() in keep}
    result.update(PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1", PYTHONUTF8="1",
                  PYTHONIOENCODING="utf-8:backslashreplace", PIP_CONFIG_FILE=os.devnull,
                  PIP_DISABLE_PIP_VERSION_CHECK="1", PIP_NO_CACHE_DIR="1")
    return result


class WindowsJob:
    """Independent CI containment, assigned while the command is still suspended."""

    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("Windows Job Object observation requires real Windows")
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ((wintypes.LPVOID, wintypes.LPCWSTR), wintypes.HANDLE),
            "SetInformationJobObject": ((wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD), wintypes.BOOL),
            "AssignProcessToJobObject": ((wintypes.HANDLE, wintypes.HANDLE), wintypes.BOOL),
            "QueryInformationJobObject": ((wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
                                           ctypes.POINTER(wintypes.DWORD)), wintypes.BOOL),
            "TerminateJobObject": ((wintypes.HANDLE, wintypes.UINT), wintypes.BOOL),
            "OpenProcess": ((wintypes.DWORD, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
            "GetProcessTimes": ((wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME),
                                 ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)), wintypes.BOOL),
            "GetExitCodeProcess": ((wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)), wintypes.BOOL),
            "CreateToolhelp32Snapshot": ((wintypes.DWORD, wintypes.DWORD), wintypes.HANDLE),
            "Thread32First": ((wintypes.HANDLE, wintypes.LPVOID), wintypes.BOOL),
            "Thread32Next": ((wintypes.HANDLE, wintypes.LPVOID), wintypes.BOOL),
            "OpenThread": ((wintypes.DWORD, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
            "ResumeThread": ((wintypes.HANDLE,), wintypes.DWORD),
            "CloseHandle": ((wintypes.HANDLE,), wintypes.BOOL),
        }
        for name, (arguments, returned) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = arguments, returned
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

        class Basic(ctypes.Structure):
            _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("minWorkingSet", ctypes.c_size_t),
                        ("maxWorkingSet", ctypes.c_size_t), ("processLimit", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", ctypes.c_uint64 * 6),
                        ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                        ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]

        limits = Extended()
        limits.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def identity(self, pid):
        handle = self.api.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # invalid PID: the process is gone
                return None
            raise ctypes.WinError(error)
        try:
            values = [wintypes.FILETIME() for _ in range(4)]
            if not self.api.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
                raise ctypes.WinError(ctypes.get_last_error())
            code = wintypes.DWORD()
            if not self.api.GetExitCodeProcess(handle, ctypes.byref(code)):
                raise ctypes.WinError(ctypes.get_last_error())
            return {"pid": pid, "created": (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime,
                    "running": code.value == 259, "exitCode": code.value}
        finally:
            self.api.CloseHandle(handle)

    def members(self):
        capacity = 128
        while capacity <= 16384:
            class Pids(ctypes.Structure):
                _fields_ = [("assigned", wintypes.DWORD), ("listed", wintypes.DWORD),
                            ("ids", ctypes.c_size_t * capacity)]
            info = Pids()
            if self.api.QueryInformationJobObject(self.handle, 3, ctypes.byref(info), ctypes.sizeof(info), None):
                return list(info.ids[:info.listed])
            if ctypes.get_last_error() != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(ctypes.get_last_error())
            capacity *= 2
        raise RuntimeError("CI Job Object process snapshot exceeded its explicit bound")

    def assign_and_resume(self, child):
        if not self.api.AssignProcessToJobObject(self.handle, int(child._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

        class Thread(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("tid", wintypes.DWORD),
                        ("owner", wintypes.DWORD), ("priority", wintypes.LONG), ("delta", wintypes.LONG),
                        ("flags", wintypes.DWORD)]

        snapshot = self.api.CreateToolhelp32Snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
        if snapshot == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = Thread()
            entry.size = ctypes.sizeof(entry)
            found = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if entry.owner == child.pid:
                    handle = self.api.OpenThread(0x0002, False, entry.tid)
                    if not handle:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if self.api.ResumeThread(handle) == 0xFFFFFFFF:
                            raise ctypes.WinError(ctypes.get_last_error())
                        return
                    finally:
                        self.api.CloseHandle(handle)
                found = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            raise RuntimeError("Cannot locate the suspended CI command's initial thread")
        finally:
            self.api.CloseHandle(snapshot)

    def terminate(self):
        if not self.api.TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle):
                raise ctypes.WinError(ctypes.get_last_error())
            self.handle = None


class CommandRunner:
    def __init__(self, evidence, job_factory=WindowsJob):
        self.evidence = Path(evidence)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.job_factory = job_factory

    def run(self, name, argv, cwd, env, timeout=180):
        log = self.evidence / (name + ".txt")
        receipt = {"name": name, "command": list(map(str, argv)), "cwd": str(cwd),
                   "timeoutSeconds": timeout, "timedOut": False, "exit": None,
                   "log": str(log), "cleanupNeeded": False, "cleanupSurvivors": [],
                   "cleanupObservation": "independent Windows Job Object plus PID creation-time checks",
                   "ownedProcesses": []}
        child, job, identities = None, None, {}
        try:
            job = self.job_factory()
            with log.open("wb") as output:
                child = subprocess.Popen(receipt["command"], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                         stdout=output, stderr=subprocess.STDOUT, shell=False, creationflags=0x204)
                initial = job.identity(child.pid)
                if initial is None:
                    raise RuntimeError("Cannot observe the newly suspended CI command")
                identities[child.pid] = initial
                job.assign_and_resume(child)
                deadline = time.monotonic() + timeout
                while True:
                    for pid in job.members():
                        identity = job.identity(pid)
                        if identity:
                            identities.setdefault(pid, identity)
                    if child.poll() is not None:
                        receipt["exit"] = child.returncode
                        break
                    if time.monotonic() >= deadline:
                        receipt.update(timedOut=True, exit=124, cleanupNeeded=True)
                        job.terminate()
                        child.wait(timeout=10)
                        break
                    time.sleep(0.025)
                receipt["processExit"] = child.returncode
                leftovers = job.members()
                if leftovers:
                    receipt["cleanupNeeded"] = True
                    receipt["survivorsBeforeCleanup"] = leftovers
                    job.terminate()
        except Exception as exc:
            receipt.update(exit=receipt["exit"] or 127, error=f"{type(exc).__name__}: {exc}")
        finally:
            if job is not None:
                try:
                    job.close()  # kill-on-close, even if assignment/resume or observation failed
                    if child is not None and child.poll() is None:
                        receipt["cleanupNeeded"] = True
                        child.kill()  # only needed when assignment itself failed
                        child.wait(timeout=10)
                    deadline = time.monotonic() + 10
                    survivors = []
                    while True:
                        survivors = []
                        for pid, old in identities.items():
                            current = job.identity(pid)
                            if current and current["created"] == old["created"] and current["running"]:
                                survivors.append(pid)
                        if not survivors or time.monotonic() >= deadline:
                            break
                        time.sleep(0.025)
                    receipt["cleanupSurvivors"] = survivors
                except Exception as exc:
                    receipt["cleanupError"] = f"{type(exc).__name__}: {exc}"
            receipt["ownedProcesses"] = list(identities.values())
            receipt["passed"] = (receipt["exit"] == 0 and not receipt["timedOut"] and
                                 not receipt["cleanupNeeded"] and not receipt["cleanupSurvivors"] and
                                 "error" not in receipt and "cleanupError" not in receipt)
            write_json(self.evidence / (name + ".json"), receipt)
        return receipt


class CaseResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = {}

    def startTest(self, test):
        self.cases[test.id()] = {"id": test.id(), "status": "running", "details": []}
        super().startTest(test)

    def mark(self, test, status, detail=None):
        owner = getattr(test, "test_case", test)
        case = self.cases[owner.id()]
        # unittest can call addSuccess after a skipped subtest. Preserve that
        # disposition; one skipped required case cannot become a green receipt.
        if status != "passed" or case["status"] == "running":
            case["status"] = status
        if detail:
            case["details"].append(detail)

    def addSuccess(self, test):
        self.mark(test, "passed")
        super().addSuccess(test)

    def addFailure(self, test, err):
        self.mark(test, "failed", self._exc_info_to_string(err, test))
        super().addFailure(test, err)

    def addError(self, test, err):
        self.mark(test, "error", self._exc_info_to_string(err, test))
        super().addError(test, err)

    def addSubTest(self, test, subtest, err):
        if err:
            self.mark(test, "failed" if issubclass(err[0], test.failureException) else "error",
                      str(subtest) + "\n" + self._exc_info_to_string(err, test))
        super().addSubTest(test, subtest, err)

    def addSkip(self, test, reason):
        self.mark(test, "skipped", reason)
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.mark(test, "expectedFailure", self._exc_info_to_string(err, test))
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.mark(test, "unexpectedSuccess")
        super().addUnexpectedSuccess(test)


def suite_worker(tests, family, receipt):
    sys.path.insert(0, str(tests))
    loader = unittest.TestLoader()
    if family == "transport":
        suite = loader.discover(str(tests), pattern="test_transport.py")
        selection = "FULL existing test_transport.py; no exclusions or test rewrites"
    elif family == "tooling":
        suite = loader.loadTestsFromNames(TOOLING_CASES)
        selection = list(TOOLING_CASES)
    else:
        raise ValueError("Unknown CI probe family")
    selected = suite.countTestCases()
    result = unittest.TextTestRunner(verbosity=2, resultclass=CaseResult).run(suite)
    cases = list(result.cases.values())
    statuses = ("passed", "failed", "error", "skipped", "expectedFailure", "unexpectedSuccess", "running")
    counts = {status: sum(case["status"] == status for case in cases) for status in statuses}
    passed = selected > 0 and result.testsRun == selected and counts["passed"] == selected and result.wasSuccessful()
    write_json(receipt, {"family": family, "selection": selection, "selected": selected,
                         "run": result.testsRun, **counts, "allPassed": passed, "cases": cases})
    return 0 if passed else 1


class RequiredStepFailed(RuntimeError):
    pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--python-version", choices=tuple(ROWS), default="3.13")
    parser.add_argument("--expected-source-sha")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--suite-worker", choices=("transport", "tooling"), help=argparse.SUPPRESS)
    parser.add_argument("--tests", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--receipt", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.suite_worker:
        if args.tests is None or args.receipt is None:
            parser.error("suite worker requires --tests and --receipt")
        return suite_worker(args.tests.resolve(), args.suite_worker, args.receipt.resolve())
    if args.source is None or args.evidence is None:
        parser.error("--source and --evidence are required")
    source, evidence = args.source.resolve(), args.evidence.resolve()
    if evidence == source or source in evidence.parents:
        parser.error("Evidence must be outside the product checkout")
    evidence.mkdir(parents=True, exist_ok=False)
    result = {"schemaVersion": 1, "kind": "initial-installed-wheel-Windows-probes", "outcome": "Blocked",
              "infrastructureReady": False, "executed": False,
              "qualification": False, "qualificationIssue": "MIS-434 remains a separate native outcome",
              "scope": "build/install/doctor, full transport suite, selected portable release-tooling cases",
              "notRun": ["full 13-suite installed-wheel conformance", "live mixed Robot/Python debug acceptance",
                         "complete Windows URI/CRLF/path matrix", "VS Code UI (separate job)"],
              "platform": {"system": platform.system(), "release": platform.release(), "version": platform.version(),
                           "machine": platform.machine(), "python": sys.version, "executable": sys.executable},
              "requestedPython": args.python_version, "commands": [], "suites": [], "sourceDirectory": str(source),
              "cleanup": {"observed": False, "method": "independent per-command Windows Job Objects"}}
    report = evidence / "result.json"
    write_json(report, result)
    runner, source_sha, work = None, None, None
    env = safe_environment()
    try:
        if os.name != "nt":
            raise ValueError("This runner requires genuine Windows; a Linux/macOS plumbing test is not Windows evidence")
        if platform.machine().lower() not in ("amd64", "x86_64"):
            raise ValueError("The approved binary locks target Windows x64 only")
        actual_python = ".".join(map(str, sys.version_info[:2]))
        if actual_python != args.python_version:
            raise ValueError(f"Requested Python {args.python_version}, actually running {actual_python}")
        if not args.expected_source_sha or not re.fullmatch(r"[0-9a-f]{40}", args.expected_source_sha):
            raise ValueError("--expected-source-sha is required and must be a full lower-case commit SHA")
        runner = CommandRunner(evidence / "commands")

        def command(name, argv, cwd=source, timeout=180, required=True):
            receipt = runner.run(name, argv, cwd, env, timeout)
            result["commands"].append(receipt)
            result["executed"] |= bool(receipt.get("ownedProcesses"))
            write_json(report, result)
            if required and not receipt["passed"]:
                raise RequiredStepFailed(f"{name} failed; see its retained log and cleanup receipt")
            return receipt

        def git(name, *arguments):
            receipt = command(name, ["git", *arguments], timeout=30)
            return Path(receipt["log"]).read_text(encoding="utf-8").strip()

        infrastructure = command("windows-infrastructure", [sys.executable, "-I", "-c",
            "import json,platform,sys; print(json.dumps({'system':platform.system(),"
            "'machine':platform.machine(),'python':sys.version_info[:2]}))"], cwd=evidence)
        infrastructure_probe = json.loads(Path(infrastructure["log"]).read_text(encoding="utf-8"))
        if infrastructure_probe["system"] != "Windows" or infrastructure_probe["machine"].lower() not in ("amd64", "x86_64") \
                or ".".join(map(str, infrastructure_probe["python"])) != args.python_version:
            raise ValueError("The actual contained infrastructure probe disagrees with the requested Windows row")
        result["infrastructureReady"] = True
        result["infrastructureProbe"] = infrastructure_probe
        write_json(report, result)
        source_sha = git("source-head", "rev-parse", "HEAD")
        result.update(sourceSha=source_sha, ciSha=os.environ.get("GITHUB_SHA"),
                      ciScriptSha256=digest(__file__), dirtyBefore=git("source-before", "status", "--porcelain", "--untracked-files=all"))
        if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or result["dirtyBefore"]:
            raise ValueError("Backend source must be an exact clean committed checkout")
        if args.expected_source_sha and source_sha != args.expected_source_sha:
            raise ValueError("Product checkout HEAD differs from --expected-source-sha")
        result["sourceAcceptance"] = "Caller-controlled immutable source; this runner does not grant native acceptance"
        epoch = git("source-epoch", "show", "-s", "--format=%ct", source_sha)
        if not epoch.isdigit():
            raise ValueError("Invalid source epoch")
        env["SOURCE_DATE_EPOCH"] = epoch
        work = Path(tempfile.mkdtemp(prefix="rcb-windows-ci-"))
        result["workDirectory"] = str(work)
        archive = work / "backend.tar"
        command("source-archive", ["git", "archive", "--format=tar", "--output=" + str(archive), source_sha, "backend"])
        result["sourceArchiveSha256"] = digest(archive)
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter="data")
        backend = work / "backend"
        project = tomllib.loads((backend / "pyproject.toml").read_text(encoding="utf-8"))["project"]
        result["requestedRow"] = {"python": args.python_version, "robotframework": ROWS[args.python_version],
                                  "debugpy": "1.8.22", "robocop": "9.1.0"}
        result["sourceMetadata"] = {"requiresPython": project.get("requires-python"),
                                    "dependencies": project.get("dependencies", []),
                                    "formatExtra": project.get("optional-dependencies", {}).get("format", [])}
        lock = Path(__file__).with_name("requirements-windows-py" + args.python_version.replace(".", "") + ".txt")
        result["dependencyLock"] = {"name": lock.name, "sha256": digest(lock)}
        command("download-binary-dependencies", [sys.executable, "-m", "pip", "download", "--isolated",
                "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:",
                "--dest", work / "wheels", "-r", lock], cwd=work, timeout=300)
        result["wheelInputs"] = [{"name": path.name, "sha256": digest(path)} for path in sorted((work / "wheels").glob("*.whl"))]
        venv = work / "venv"
        command("create-venv", [sys.executable, "-m", "venv", venv], cwd=work)
        python = venv / "Scripts/python.exe"
        command("build-backend", [python, backend / "scripts/build_dists.py", backend, work / "dist"], cwd=work)
        wheels = list((work / "dist").glob("*.whl"))
        if len(wheels) != 1:
            raise ValueError("Build did not produce exactly one backend wheel")
        command("install-pinned-dependencies", [python, "-m", "pip", "install", "--isolated", "--no-index",
                "--find-links", work / "wheels", "--require-hashes", "--only-binary=:all:",
                "--report", evidence / "dependency-install.json", "-r", lock], cwd=work)
        command("install-backend", [python, "-m", "pip", "install", "--isolated", "--no-index",
                "--find-links", work / "wheels",
                "--report", evidence / "backend-install.json", str(wheels[0]) + "[format]"], cwd=work)
        # Normal offline pip resolution enforces Requires-Python, markers, ranges
        # and the format extra using only the hash-validated wheelhouse. A source
        # need not spell its compatible requirements in the same form as our lock.
        command("dependency-metadata-check", [python, "-m", "pip", "check"], cwd=work)
        probe = command("installed-probe", [python, "-I", "-c", PROBE], cwd=work)
        installed = json.loads(Path(probe["log"]).read_text(encoding="utf-8"))
        result["installed"] = installed
        versions = installed["distributions"]
        if installed["robotcodePresent"] or any(name == "robotcode" or name.startswith("robotcode-") for name in versions):
            raise ValueError("RobotCode must be absent from the isolated backend environment")
        if not Path(installed["backendFile"]).is_relative_to(venv) or Path(installed["prefix"]) != venv:
            raise ValueError("Backend is not imported from the installed-wheel venv")
        expected = {"robotframework": ROWS[args.python_version], "debugpy": "1.8.22", "robotframework-robocop": "9.1.0"}
        if any(versions.get(name) != version for name, version in expected.items()):
            raise ValueError("Installed versions differ from the requested runtime row")
        doctor = command("doctor", [python, "-I", "-m", "robot_companion_backend", "doctor"], cwd=work)
        result["doctor"] = json.loads(Path(doctor["log"]).read_text(encoding="utf-8"))
        env["RCB_TRANSCRIPTS"] = str(evidence / "protocol")
        for family in ("transport", "tooling"):
            counts_path = evidence / (family + "-counts.json")
            receipt = command(family, [python, "-I", Path(__file__).resolve(), "--suite-worker", family,
                    "--tests", backend / "tests", "--receipt", counts_path], cwd=work, required=False)
            counts = json.loads(counts_path.read_text(encoding="utf-8")) if counts_path.is_file() else {"allPassed": False, "missingReceipt": True}
            result["suites"].append({"family": family, "required": True, "commandPassed": receipt["passed"], **counts})
            write_json(report, result)
        shutil.copytree(work / "dist", evidence / "dist")
        result["builtArtifacts"] = [{"name": path.name, "sha256": digest(path)} for path in sorted((evidence / "dist").iterdir())]
        result["outcome"] = "Pass" if all(suite.get("allPassed") and suite["commandPassed"] for suite in result["suites"]) else "Fail"
    except Exception as exc:
        result.update(error=f"{type(exc).__name__}: {exc}")
        if result["commands"]:
            result["outcome"] = "Fail"
    except (KeyboardInterrupt, SystemExit) as exc:
        result.update(outcome="Fail", error=f"Interrupted: {type(exc).__name__}")
    finally:
        if work is not None and (work / "dist").is_dir():
            try:
                shutil.copytree(work / "dist", evidence / "dist", dirs_exist_ok=True)
                result["builtArtifacts"] = [{"name": path.name, "sha256": digest(path)}
                    for path in sorted((evidence / "dist").iterdir()) if path.is_file()]
            except Exception as exc:
                result.update(outcome="Fail", artifactRetentionError=f"{type(exc).__name__}: {exc}")
        if runner is not None and source_sha:
            for name, arguments in (("source-after", ["status", "--porcelain", "--untracked-files=all"]),
                                    ("source-head-after", ["rev-parse", "HEAD"])):
                try:
                    receipt = runner.run(name, ["git", *arguments], source, env, timeout=30)
                    result["commands"].append(receipt)
                    value = Path(receipt["log"]).read_text(encoding="utf-8").strip()
                    result["dirtyAfter" if name == "source-after" else "sourceShaAfter"] = value
                    if not receipt["passed"] or (value if name == "source-after" else value != source_sha):
                        result["outcome"] = "Fail"
                except Exception as exc:
                    result.update(outcome="Fail", sourceReadbackError=f"{type(exc).__name__}: {exc}")
        observed = bool(result["commands"]) and all("cleanupError" not in row and row.get("ownedProcesses") for row in result["commands"])
        result["cleanup"].update(observed=observed,
            productCleanupQualified=False,
            forcedCommands=[row["name"] for row in result["commands"] if row.get("cleanupNeeded")],
            survivors={row["name"]: row["cleanupSurvivors"] for row in result["commands"] if row.get("cleanupSurvivors")},
            observationErrors=[row["name"] for row in result["commands"] if row.get("cleanupError")])
        write_json(report, result)
    print(json.dumps({"outcome": result["outcome"], "sourceSha": result.get("sourceSha"),
                      "qualification": False, "report": str(report), "error": result.get("error")}))
    return 0 if result["outcome"] == "Pass" else 2 if result["outcome"] == "Blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main())

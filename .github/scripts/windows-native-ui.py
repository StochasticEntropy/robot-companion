"""Run the candidate-declared native UI suite under the existing CI Job Object oracle."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("windows_backend_control", HERE / "windows-backend.py")
backend_control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend_control)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--expected-source-sha", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    source, evidence = args.source.resolve(), args.evidence.resolve()
    if evidence == source or source in evidence.parents:
        raise ValueError("UI evidence must be outside the product checkout")
    evidence.mkdir(parents=True, exist_ok=False)
    receipt = {"version": 1, "kind": "candidate-native-windows-ui", "sourceSha": args.expected_source_sha,
               "requestId": args.request_id, "suite": "native-libraries", "required": True,
               "status": "failed", "executed": False, "commands": [], "requiredEvidence": []}
    scratch = None
    try:
        if os.name != "nt" or sys.version_info[:3] != (3, 11, 9):
            raise ValueError("Native UI qualification requires real Windows x64 and Python3.11.9")
        if not backend_control.windows_architecture()["nativeX64"]:
            raise ValueError("Native UI qualification requires Windows x64")
        receipt["longPaths"] = backend_control.long_paths_enabled()
        if sys.flags.utf8_mode:
            raise ValueError("Ordinary Windows locale is required")
        env = backend_control.safe_environment(full_qualification=True)
        scratch = Path(tempfile.mkdtemp(prefix="companion-native-ui-", dir=os.environ["RUNNER_TEMP"]))
        env["TEMP"] = env["TMP"] = os.environ["RUNNER_TEMP"]
        runner = backend_control.CommandRunner(evidence / "commands")

        def command(name, argv, timeout=180):
            result = runner.run(name, argv, source, env, timeout)
            receipt["commands"].append(result)
            receipt["executed"] |= bool(result.get("ownedProcesses"))
            backend_control.write_json(evidence / "result.json", receipt)
            if not result["passed"]:
                raise ValueError(name + " failed or its Job Object required cleanup")
            return Path(result["log"]).read_text(encoding="utf-8").strip()

        if command("source-head", ["git", "rev-parse", "HEAD"]) != args.expected_source_sha:
            raise ValueError("Selected candidate identity differs")
        if command("source-clean", ["git", "status", "--porcelain", "--untracked-files=all"]):
            raise ValueError("Selected candidate is dirty")
        node = shutil.which("node", path=env["PATH"])
        npm = Path(node).parent / "node_modules/npm/bin/npm-cli.js" if node else None
        if not node or not npm or not npm.is_file():
            raise ValueError("Pinned Node/npm are unavailable")
        # The preceding fixed setup step warms this exact lockfile's npm cache.
        # Test-time installation remains offline and lifecycle scripts stay off.
        command("npm-ci-offline", [node, npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], 300)
        wheels = scratch / "wheels"
        command("hash-locked-wheels", [sys.executable, "-m", "pip", "download", "--isolated",
                "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:",
                "--dest", wheels, "-r", HERE / "requirements-windows-py311.txt"], 300)
        receipt["wheelInputs"] = [{"name": f.name, "sha256": backend_control.digest(f)} for f in sorted(wheels.glob("*.whl"))]
        env["ROBOT_COMPANION_ROBOT_WHEELS"] = str(wheels)
        env["ROBOT_COMPANION_NATIVE_PYTHON"] = sys.executable
        command("native-libraries-ui", [node, HERE / "windows-native-ui.cjs", source, evidence, scratch], 1100)
        if command("source-clean-after", ["git", "status", "--porcelain", "--untracked-files=all"]):
            raise ValueError("Candidate checkout changed during qualification")
        receipt["counts"] = json.loads((evidence / "ui-test-counts.json").read_text())["totals"]
        receipt["status"] = "passed"
    except Exception as error:
        receipt["error"] = type(error).__name__ + ": " + str(error)
    finally:
        if scratch is not None:
            try:
                shutil.rmtree(scratch)
            except Exception as error:
                receipt.update(status="failed", scratchCleanupError=str(error))
        for f in sorted(evidence.rglob("*")):
            if f.is_symlink():
                receipt.update(status="failed", linkedEvidenceFile=str(f.relative_to(evidence)))
                continue
            if f.is_file() and f.name != "result.json":
                if f.suffix not in {".json", ".png", ".txt", ".log"}:
                    receipt.update(status="failed", unexpectedEvidenceFile=str(f.relative_to(evidence)))
                receipt["requiredEvidence"].append({"path": f.relative_to(evidence).as_posix(),
                    "bytes": f.stat().st_size, "sha256": backend_control.digest(f)})
        backend_control.write_json(evidence / "result.json", receipt)
    print(json.dumps({"status": receipt["status"], "executed": receipt["executed"], "counts": receipt.get("counts")}))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())

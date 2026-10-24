"""Verify installed backend bytes against this preview's supplied wheel."""

import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys
import zipfile


def main():
    download = Path(__file__).resolve().parent
    wheel = download / "robot_companion_backend-0.1.0.dev18-py3-none-any.whl"
    manifest = json.loads((download / "SOURCE-MANIFEST.json").read_text(encoding="utf-8"))
    expected = manifest["files"][wheel.name]["sha256"]
    actual = hashlib.sha256(wheel.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("The supplied wheel does not match SOURCE-MANIFEST.json")
    distribution = importlib.metadata.distribution("robot-companion-backend")
    checked = 0
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if not name.startswith("robot_companion_backend/") or name.endswith("/"):
                continue
            installed = Path(distribution.locate_file(name))
            if not installed.is_file() or installed.read_bytes() != archive.read(name):
                raise ValueError(f"Installed backend differs from this preview: {name}")
            checked += 1
    if not checked:
        raise ValueError("The supplied wheel contains no backend files")
    spec = importlib.util.find_spec("robot_companion_backend")
    installed_init = Path(distribution.locate_file("robot_companion_backend/__init__.py")).resolve()
    if spec is None or spec.origin is None or Path(spec.origin).resolve() != installed_init:
        raise ValueError("Another backend on the Python import path shadows this installed wheel")
    print(json.dumps({"match": True, "python": sys.executable,
                      "version": distribution.version, "wheelSha256": actual,
                      "checkedBackendFiles": checked, "package": str(installed_init.parent)}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Backend artifact verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)

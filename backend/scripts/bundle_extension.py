"""Bundle the backend with the VS Code extension: bundled-backend/ in the repository root.

Usage: python bundle_extension.py <offline-wheel-dir> [<outdir>]

Builds the deterministic backend wheel from this source tree (build_dists.py),
copies the pinned debugpy wheel after checking its published SHA-256, and writes
manifest.json. The extension installs only these files, only after the user
confirms, and compares the installed backend files with `installedFiles`: the
SHA-256 over the sorted `path NUL sha256(bytes) LF` lines of the wheel's
robot_companion_backend/ entries, the same digest its environment probe computes
over an installed copy. Nothing is downloaded.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import tomllib
import zipfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
PACKAGE = 'robot_companion_backend/'
# debugpy 1.8.22, pure-Python wheel as published on PyPI (the backend's exact pin).
DEBUGPY = {
    'distribution': 'debugpy', 'version': '1.8.22', 'wheel': 'debugpy-1.8.22-py2.py3-none-any.whl',
    'sha256': 'a9e9d3550e15ca479c59333e90845029190531f0cacfedab3b815a57bd913947',
    'source': 'https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/'
              'debugpy-1.8.22-py2.py3-none-any.whl',
    'purpose': 'Python debugging in the Robot worker; added only when the environment has no debugpy',
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def installed_files(wheel):
    """The digest the extension's probe computes over the installed package files."""
    digest, count = hashlib.sha256(), 0
    with zipfile.ZipFile(wheel) as archive:
        for name in sorted(n for n in archive.namelist() if n.startswith(PACKAGE) and not n.endswith('/')):
            digest.update(name.encode() + b'\0' + hashlib.sha256(archive.read(name)).hexdigest().encode() + b'\n')
            count += 1
    return {'sha256': digest.hexdigest(), 'files': count}


def supported_rows():
    sys.path.insert(0, str(PROJECT / 'src'))
    try:
        from robot_companion_backend.runtime import SUPPORTED
    finally:
        sys.path.pop(0)
    return [{'python': f'{major}.{minor}', 'robotframework': robot} for (major, minor), robot in SUPPORTED]


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    if len(args) not in (1, 2):
        raise SystemExit(__doc__)
    wheels = Path(args[0]).resolve()
    outdir = Path(args[1]).resolve() if len(args) == 2 else PROJECT.parent / 'bundled-backend'
    project = tomllib.loads((PROJECT / 'pyproject.toml').read_text(encoding='utf-8'))['project']
    debugpy = wheels / DEBUGPY['wheel']
    if not debugpy.is_file() or sha256(debugpy) != DEBUGPY['sha256']:
        raise SystemExit(f'{debugpy} is missing or does not match the published SHA-256 {DEBUGPY["sha256"]}')
    # The bundled wheel's bytes must not depend on the caller's environment.
    os.environ['SOURCE_DATE_EPOCH'] = '315532800'
    with tempfile.TemporaryDirectory() as scratch:
        sys.path.insert(0, str(HERE))
        import build_dists
        build_dists.main([str(PROJECT), scratch])
        built = next(Path(scratch).glob('*.whl'))
        outdir.mkdir(parents=True, exist_ok=True)
        for old in outdir.glob('*.whl'):
            old.unlink()
        shutil.copyfile(built, outdir / built.name)
    shutil.copyfile(debugpy, outdir / debugpy.name)
    backend = outdir / built.name
    manifest = {
        'schemaVersion': 1,
        'purpose': 'Robot Companion installs these files into the selected project interpreter only after the user '
                   'confirms; pip runs with --no-index --no-deps, so nothing is downloaded and no other package changes.',
        'backend': {'distribution': project['name'], 'version': project['version'], 'wheel': backend.name,
                    'sha256': sha256(backend), 'bytes': backend.stat().st_size,
                    'requiresPython': project['requires-python'], 'supportedRows': supported_rows(),
                    'installedFiles': installed_files(backend)},
        'dependencies': [{**DEBUGPY, 'bytes': debugpy.stat().st_size}],
    }
    (outdir / 'manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())

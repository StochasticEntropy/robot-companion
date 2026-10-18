"""Minimal PEP 517 frontend: build the backend sdist and wheel without network or build tools.

Usage: python build_dists.py <backend-project-dir> <outdir>. It reads the
project's declared build system, refuses any build requirement (none can be
installed offline) and calls the in-tree hooks in this process.
"""

import importlib
from pathlib import Path
import sys
import tomllib


def main(argv=None):
    project, outdir = (Path(a).resolve() for a in (argv or sys.argv[1:]))
    system = tomllib.loads((project / 'pyproject.toml').read_text(encoding='utf-8'))['build-system']
    if system.get('requires'):
        raise SystemExit('This frontend supports only dependency-free build backends')
    sys.path[:0] = [str(project / path) for path in system.get('backend-path', [])]
    sys.dont_write_bytecode = True  # leave no __pycache__ in the source checkout
    backend = importlib.import_module(system['build-backend'])
    outdir.mkdir(parents=True, exist_ok=True)
    print(backend.build_sdist(str(outdir)))
    print(backend.build_wheel(str(outdir)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

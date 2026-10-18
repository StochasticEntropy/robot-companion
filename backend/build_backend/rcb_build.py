"""Dependency-free in-tree PEP 517 backend for the pure-Python backend package.

The approved offline wheel set has no setuptools/wheel/build, so this module
builds the sdist and py3-none-any wheel from pyproject metadata with only the
standard library. Output is deterministic: sorted entries, fixed permissions
and SOURCE_DATE_EPOCH timestamps (default: 1980-01-01, the zip minimum).
"""

import base64
import gzip
import hashlib
import io
import os
from pathlib import Path
import tarfile
import time
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'robot_companion_backend'
SDIST_FILES = ('pyproject.toml', 'README.md', 'CHANGELOG.md', 'constraints.txt')
SDIST_TREES = ('build_backend', 'src', 'tests', 'scripts')
ZIP_MINIMUM = 315532800  # 1980-01-01T00:00:00Z


def _project():
    return tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))['project']


def _distribution(project):
    return project['name'].replace('-', '_').replace('.', '_')


def _epoch():
    value = os.environ.get('SOURCE_DATE_EPOCH', '')
    return max(int(value), ZIP_MINIMUM) if value.isdigit() else ZIP_MINIMUM


def _files(tree):
    return sorted(p for p in tree.rglob('*') if p.is_file() and '__pycache__' not in p.parts
                  and p.suffix not in ('.pyc', '.pyo'))


def _metadata(project):
    lines = ['Metadata-Version: 2.4', f"Name: {project['name']}", f"Version: {project['version']}",
             f"Summary: {project['description']}", f"License-Expression: {project['license']}",
             f"Requires-Python: {project['requires-python']}"]
    lines += [f'Requires-Dist: {requirement}' for requirement in project.get('dependencies', [])]
    lines += ['Description-Content-Type: text/markdown', '', '']
    return ('\n'.join(lines) + (ROOT / project['readme']).read_text(encoding='utf-8')).encode()


def _dist_info(project):
    entry_points = ['[console_scripts]', *(f'{name} = {target}' for name, target
                                           in sorted(project.get('scripts', {}).items())), '']
    return {'METADATA': _metadata(project),
            'WHEEL': b'Wheel-Version: 1.0\nGenerator: rcb_build\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
            'entry_points.txt': '\n'.join(entry_points).encode()}


def get_requires_for_build_wheel(config_settings=None):
    return []


def get_requires_for_build_sdist(config_settings=None):
    return []


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    project = _project()
    name = f"{_distribution(project)}-{project['version']}.dist-info"
    target = Path(metadata_directory) / name
    target.mkdir(parents=True, exist_ok=True)
    for filename, data in _dist_info(project).items():
        (target / filename).write_bytes(data)
    return name


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    project = _project()
    stem = f"{_distribution(project)}-{project['version']}"
    info = f'{stem}.dist-info'
    entries = [(p.relative_to(ROOT / 'src').as_posix(), p.read_bytes()) for p in _files(ROOT / 'src' / PACKAGE)]
    entries += [(f'{info}/{filename}', data) for filename, data in sorted(_dist_info(project).items())]
    record = [f"{path},sha256={base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()},{len(data)}"
              for path, data in entries] + [f'{info}/RECORD,,', '']
    entries.append((f'{info}/RECORD', '\n'.join(record).encode()))
    filename = f'{stem}-py3-none-any.whl'
    timestamp = time.gmtime(_epoch())[:6]
    with zipfile.ZipFile(Path(wheel_directory) / filename, 'w', zipfile.ZIP_DEFLATED) as wheel:
        for path, data in entries:
            item = zipfile.ZipInfo(path, timestamp)
            item.external_attr = 0o100644 << 16
            item.compress_type = zipfile.ZIP_DEFLATED
            wheel.writestr(item, data)
    return filename


def build_sdist(sdist_directory, config_settings=None):
    project = _project()
    stem = f"{_distribution(project)}-{project['version']}"
    files = [ROOT / name for name in SDIST_FILES]
    for tree in SDIST_TREES:
        files += _files(ROOT / tree)
    epoch = _epoch()
    filename = f'{stem}.tar.gz'
    entries = [('PKG-INFO', _metadata(project))]
    entries += [(p.relative_to(ROOT).as_posix(), p.read_bytes()) for p in sorted(files)]
    with open(Path(sdist_directory) / filename, 'wb') as raw, \
            gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as compressed, \
            tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as bundle:
        for path, data in entries:
            item = tarfile.TarInfo(f'{stem}/{path}')
            item.size, item.mtime, item.mode = len(data), epoch, 0o644
            item.uid = item.gid = 0
            item.uname = item.gname = ''
            bundle.addfile(item, io.BytesIO(data))
    return filename

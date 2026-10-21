"""Retain full backend text evidence losslessly within the CI artifact bound."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile


def pack(root):
    root = Path(root)
    full = root / 'backend/full'
    if not full.is_dir():
        return None
    files = sorted(p for p in full.rglob('*') if p.is_file())
    if any(p.is_symlink() or p.suffix not in {'.json', '.txt', '.log', '.stdout'}
           or p.name == 'source-archive.stdout' for p in files):
        raise ValueError('Only retained backend text evidence may enter the archive')
    archive = root / 'backend/full-evidence.zip'
    inventory = {p.relative_to(full).as_posix(): {
        'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size
    } for p in files}
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, 'full/' + p.relative_to(full).as_posix())
    # Read every byte back before removing the uncompressed copy. Inventories in
    # backend/result.json keep their original paths and refer to this root.
    with zipfile.ZipFile(archive) as z:
        if set(z.namelist()) != {'full/' + n for n in inventory}:
            raise ValueError('Archive inventory changed')
        for name, item in inventory.items():
            data = z.read('full/' + name)
            if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Archive readback differs: ' + name)
    result = {'path': 'backend/full-evidence.zip', 'root': 'full/', 'lossless': True,
              'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'bytes': archive.stat().st_size, 'files': inventory}
    (root / 'backend/full-evidence.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    shutil.rmtree(full)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    print(json.dumps(pack(parser.parse_args().root)))

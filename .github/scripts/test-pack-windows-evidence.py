import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack-windows-evidence.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackingTests(unittest.TestCase):
    def test_large_protocol_evidence_is_lossless_and_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            full = root / 'backend/full/protocol'
            full.mkdir(parents=True)
            content = (b'{"event":"output","body":"ordinary repeated protocol output"}\n' * 500000)
            (full / 'dap.json').write_bytes(content)
            result = module.pack(root)
            self.assertLess(result['bytes'], 1024 * 1024)
            self.assertFalse((root / 'backend/full').exists())
            with zipfile.ZipFile(root / result['path']) as z:
                self.assertEqual(z.read('full/protocol/dap.json'), content)

    def test_binary_or_symlink_is_refused_without_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            full = Path(tmp) / 'backend/full'
            full.mkdir(parents=True)
            (full / 'unexpected.whl').write_bytes(b'not evidence')
            with self.assertRaises(ValueError):
                module.pack(tmp)
            self.assertTrue((full / 'unexpected.whl').exists())

    def test_missing_full_evidence_is_not_invented(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(module.pack(tmp))


if __name__ == '__main__':
    unittest.main()

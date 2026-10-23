"""Portable regression checks for the independent Windows native UI wrapper."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_ui_control", HERE / "windows-native-ui.py")
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class OfflineNpmCacheTests(unittest.TestCase):
    def test_sanitized_environment_uses_the_online_preparation_cache(self):
        with tempfile.TemporaryDirectory(prefix="runner temp ") as root:
            with patch.dict(os.environ, {"NPM_CONFIG_CACHE": "/unrelated-cache"}, clear=True):
                argv = control.offline_npm_command("node", "npm-cli.js", root)
            self.assertEqual(argv[argv.index("--cache") + 1], str(Path(root).resolve() / "companion-native-ui-npm-cache"))
            self.assertIn("--offline", argv)
            self.assertIn("--ignore-scripts", argv)
            self.assertEqual(argv[:3], ["node", "npm-cli.js", "ci"])

    def test_fixed_online_step_explicitly_warms_the_same_cache(self):
        workflow = (HERE.parent / "workflows/windows-tests.yml").read_text()
        self.assertIn('npm ci --cache "$env:RUNNER_TEMP/companion-native-ui-npm-cache" --ignore-scripts', workflow)


if __name__ == "__main__":
    unittest.main()

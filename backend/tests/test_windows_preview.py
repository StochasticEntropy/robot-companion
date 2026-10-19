"""Narrow preview regressions for Windows URI and junction handling.

These exercise Windows path conversion logic on every host. They do not qualify
an actual Windows interpreter, process tree, editor or filesystem.
"""

from pathlib import Path
from types import SimpleNamespace
import stat
import unittest
from unittest.mock import patch

from robot_companion_backend.workspace import file_uri_path, is_link
from test_lsp_live import LanguageTestCase


class WindowsUriConversionTests(unittest.TestCase):
    def test_vscode_drive_encoding_and_unicode(self):
        self.assertEqual(file_uri_path('file:///c%3A/My%20Tests/%C3%A4.robot', windows=True),
                         'c:\\My Tests\\ä.robot')
        self.assertEqual(file_uri_path('file://localhost/C:/My%20Tests/a.robot', windows=True),
                         'C:\\My Tests\\a.robot')

    def test_unc_device_and_driveless_paths_refused(self):
        for uri in ('file:////server/share', 'file://server/share/a.robot',
                    'file:///%5C%5Cserver%5Cshare', 'file:///%5C%5C%3F%5CC%3A%5C',
                    'file:///C:', 'file:///C:relative', 'file:///tmp/a.robot'):
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                file_uri_path(uri, windows=True)

    def test_posix_uri_keeps_local_absolute_path(self):
        self.assertEqual(file_uri_path('file:///tmp/My%20Tests/%C3%A4.robot', windows=False),
                         '/tmp/My Tests/ä.robot')

    def test_junction_and_symlink_reparse_tags_are_links(self):
        for tag in (0xA0000003, 0xA000000C):
            with self.subTest(tag=tag), patch('os.lstat', return_value=SimpleNamespace(
                    st_mode=stat.S_IFDIR, st_reparse_tag=tag)):
                self.assertTrue(is_link('junction'))
        with patch('os.lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR)):
            self.assertFalse(is_link('normal-directory'))


class PreviewUriLiveTests(LanguageTestCase):
    def test_escaped_space_and_crlf_reach_the_same_definition(self):
        spaced = self.root / 'My Tests'
        spaced.mkdir()
        source = spaced / 'spaces.robot'
        body = '*** Test Cases ***\r\nExample\r\n    Local Step\r\n*** Keywords ***\r\nLocal Step\r\n    No Operation\r\n'
        uri = source.as_uri()
        self.assertIn('%20', uri)
        self.open(uri, body)
        result = self.client.request('textDocument/definition', {
            'textDocument': {'uri': uri}, 'position': {'line': 2, 'character': 6}})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['uri'], uri)
        self.assertEqual(result[0]['range']['start'], {'line': 4, 'character': 0})


if __name__ == '__main__':
    unittest.main()

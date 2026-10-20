"""Dependency-free mechanical checks, distinct from live RF conformance."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from robot_companion_backend.protocol import FramedStream, ProtocolError, MAX_CONTENT_BYTES
from robot_companion_backend.workspace import Workspace, codepoint_column, utf16_column, uri_path


class ShortReader(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2))


class TransportTests(unittest.TestCase):
    def frame(self, value):
        target = io.BytesIO()
        FramedStream(None, target).write(value)
        return target.getvalue()

    def test_unicode_byte_length_and_multiple_frames(self):
        values = [{"text": "Ä😀"}, {"id": 2, "result": None}]
        stream = FramedStream(ShortReader(b"".join(self.frame(v) for v in values)), None)
        self.assertEqual([stream.read(), stream.read(), stream.read()], [*values, None])

    def test_bad_frames(self):
        for content in (b"", b"\r\n{}", b"Content-Length: -2\r\n\r\n{}",
                        b"Content-Length: 2\n\n{}", b"Content-Length: 3\r\n\r\n{}",
                        b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
                        b"Content-Length: 1\r\n\r\n{", b"Content-Length: 2\r\n\r\n[]",
                        b"Content-Length: 1\r\n\r\n\xff",
                        b"Content-Length: " + b"9" * 5000 + b"\r\n\r\n",
                        f"Content-Length: {MAX_CONTENT_BYTES + 1}\r\n\r\n".encode(),
                        b"X: " + b"a" * 8192 + b"\r\n\r\n"):
            with self.subTest(content=content[:60]):
                if not content:
                    self.assertIsNone(FramedStream(io.BytesIO(content), None).read())
                else:
                    with self.assertRaises(ProtocolError):
                        FramedStream(io.BytesIO(content), None).read()

    def test_long_zero_padded_length(self):
        raw = b"Content-Length: " + b"0" * 5000 + b"2\r\n\r\n{}"
        self.assertEqual(FramedStream(io.BytesIO(raw), None).read(), {})

    def test_python_definition_column_uses_identifier(self):
        with tempfile.TemporaryDirectory(prefix="rcb-static-") as directory:
            path = Path(directory) / "Library.py"
            path.write_text('from robot.api.deco import keyword as kw\n@kw("Short")\ndef f(): pass\n@kw("Async")\nasync def d(): pass\n@kw("Unicode")\ndef ü(): pass\n')
            symbols = Workspace().python_symbols(path, "Library")
            self.assertEqual([s.column for s in symbols], [4, 10, 4])
            self.assertEqual([s.location()["range"]["end"]["character"] for s in symbols], [5, 11, 5])

    def test_python_definition_lines_follow_python_line_breaks(self):
        with tempfile.TemporaryDirectory(prefix="rcb-static-") as directory:
            path = Path(directory) / "Library.py"
            # A form feed line and U+2028 in a string are no line breaks for Python's line numbers.
            path.write_text('from robot.api.deco import keyword\n\x0c\nNOTE = "a\u2028b"\n@keyword("Late")\n'
                            'def late(): pass\n', encoding="utf-8")
            symbols = Workspace().python_symbols(path, "Library")
            self.assertEqual([(s.line, s.column, s.text) for s in symbols], [(4, 4, "def late(): pass")])

    def test_utf16(self):
        line = "Ä😀 Keyword"
        self.assertEqual(utf16_column(line, 3), 4)
        self.assertEqual(codepoint_column(line, 4), 3)
        for units in (-1, 2, 100):
            with self.assertRaises(ValueError):
                codepoint_column(line, units)

    def test_document_versions_and_close(self):
        workspace = Workspace()
        uri = Path("/tmp/test robot.robot").as_uri()
        workspace.open(uri, "version 4", 4)
        for version in (4, 3):
            with self.assertRaises(ValueError):
                workspace.open(uri, "stale", version)
        self.assertEqual(workspace.text(uri_path(uri)), "version 4")
        workspace.close(uri)
        self.assertFalse(workspace.documents)

    def test_remote_uri_refused(self):
        for uri in ("https://example.org/file.robot", "file://remote/file.robot"):
            with self.assertRaises(ValueError):
                uri_path(uri)

    def invoke(self, service, messages=()):
        result = subprocess.run([sys.executable, "-m", "robot_companion_backend", service],
                                input=b"".join(self.frame(m) for m in messages),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, env=os.environ.copy())
        return result

    def test_doctor_real_subprocess(self):
        result = self.invoke("doctor")
        self.assertIn(result.returncode, (0, 2))
        report = json.loads(result.stdout)
        self.assertEqual(report["contractVersion"], 1)
        self.assertEqual(report["backend"], "0.1.0.dev1")
        self.assertFalse(result.stderr)

    def test_lsp_preinitialize_error_real_subprocess(self):
        result = self.invoke("lsp", [{"jsonrpc": "2.0", "id": 1, "method": "textDocument/definition"},
                                     {"jsonrpc": "2.0", "method": "exit"}])
        reply = FramedStream(io.BytesIO(result.stdout), None).read()
        self.assertEqual(reply["error"], {"code": -32002, "message": "Server not initialized"})
        self.assertEqual(result.returncode, 1)
        self.assertFalse(result.stderr)

    def test_lsp_bad_json_real_subprocess(self):
        for raw in (b"Content-Length: 1\r\n\r\n{",
                    b"Content-Length: " + b"9" * 5000 + b"\r\n\r\n"):
            with self.subTest(size=len(raw)):
                result = subprocess.run([sys.executable, "-m", "robot_companion_backend", "lsp"],
                                        input=raw, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(result.stderr)
                self.assertEqual(FramedStream(io.BytesIO(result.stdout), None).read()["error"]["code"], -32700)


if __name__ == "__main__":
    unittest.main()

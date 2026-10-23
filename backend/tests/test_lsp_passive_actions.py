"""Automatic empty quick fixes cannot starve later navigation; explicit actions remain."""

from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from client import Client
from robot_companion_backend.lsp import LanguageServer
from robot_companion_backend.protocol import FramedStream


class PassiveCodeActionTests(unittest.TestCase):
    def test_empty_automatic_analysis_does_not_starve_following_definition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "safe.robot"
            path.write_text("*** Test Cases ***\nSafe\n    Local Step\n*** Keywords ***\nLocal Step\n    No Operation\n",
                            encoding="utf-8")
            client = Client(argv=[sys.executable, __file__, "slow-actions", directory])
            try:
                client.request("initialize", {"rootUri": root.as_uri(), "capabilities": {"textDocument": {
                    "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["quickfix"]}}}}}})
                params = {"textDocument": {"uri": path.as_uri()}, "range": {
                    "start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 14}},
                    "context": {"triggerKind": 2, "diagnostics": []}}
                client.send("textDocument/codeAction", params, 2)
                started = time.monotonic()
                client.send("textDocument/definition", {"textDocument": {"uri": path.as_uri()},
                                                       "position": {"line": 2, "character": 5}}, 3)
                responses = {}
                while len(responses) < 2:
                    message = client.messages.get(timeout=1)
                    self.assertIsInstance(message, dict)
                    self.assertNotIn("error", message)
                    responses[message["id"]] = message["result"]
                self.assertLess(time.monotonic() - started, 1)
                self.assertEqual(responses[2], [])
                self.assertEqual(responses[3][0]["range"]["start"]["line"], 4)
                self.assertFalse((root / "analysed").exists(), "Empty automatic action must never enter slow analysis")
                client.counter = 3
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=3), 0)
            finally:
                client.close()
            self.assertFalse(client.forced_cleanup)

    def test_closed_stdout_with_stdin_open_exits_without_fatal_shutdown(self):
        process = subprocess.Popen([sys.executable, "-m", "robot_companion_backend", "lsp"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdout.close()
            FramedStream(None, process.stdin).write({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                                    "params": {"capabilities": {}}})
            # Keep stdin open to verify ordinary process exit when its output pipe closes.
            code = process.wait(timeout=4)
            stderr = process.stderr.read()
            self.assertNotEqual(code, 0)
            self.assertGreater(code, 0, stderr.decode(errors="replace"))
            self.assertNotIn(b"Fatal Python error", stderr)
            self.assertNotIn(b"_enter_buffered_busy", stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdin.close()
            process.stderr.close()

    def test_real_backend_keeps_automatic_fixes_and_explicit_source_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "steps.resource").write_text("*** Keywords ***\nMissing Step\n    No Operation\n", encoding="utf-8")
            path = root / "safe.robot"
            text = "*** Test Cases ***\nSafe\n    Missing Step\n    Local Step\n*** Keywords ***\nLocal Step\n    No Operation\n"
            path.write_text(text, encoding="utf-8")
            client = Client()
            try:
                client.request("initialize", {"rootUri": root.as_uri(), "capabilities": {"textDocument": {
                    "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {
                        "valueSet": ["quickfix", "source.addMissingImports"]}}}}}})
                client.send("initialized", {})
                client.send("textDocument/didOpen", {"textDocument": {
                    "uri": path.as_uri(), "version": 1, "languageId": "robotframework", "text": text}})
                diagnostics = client.wait_diagnostics(path.as_uri(), 1)["diagnostics"]
                diagnostic, = diagnostics
                self.assertEqual(diagnostic["code"], "unknown-keyword")
                params = {"textDocument": {"uri": path.as_uri()}, "range": diagnostic["range"]}
                manual = client.request("textDocument/codeAction", {**params, "context": {
                    "triggerKind": 1, "diagnostics": diagnostics}})
                self.assertTrue(manual, "A real missing-import fix must remain available")
                self.assertEqual(client.request("textDocument/codeAction", {**params, "context": {
                    "triggerKind": 2, "diagnostics": diagnostics}}), manual)
                self.assertEqual(client.request("textDocument/codeAction", {**params, "context": {
                    "triggerKind": 2, "diagnostics": []}}), [])
                source = client.request("textDocument/codeAction", {**params, "context": {
                    "triggerKind": 2, "diagnostics": [], "only": ["source.addMissingImports"]}})
                self.assertEqual([action["kind"] for action in source], ["source.addMissingImports"])
                definition = client.request("textDocument/definition", {"textDocument": {"uri": path.as_uri()},
                                                                         "position": {"line": 3, "character": 5}})
                self.assertEqual(definition[0]["range"]["start"]["line"], 5)
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=3), 0)
            finally:
                client.close()
            self.assertFalse(client.forced_cleanup)

    def test_automatic_empty_quickfix_avoids_analysis_but_manual_diagnostics_and_source_remain(self):
        server = LanguageServer(None)
        server.initialized = server.code_actions = server.source_actions = True
        params = {"textDocument": {"uri": "file:///safe.resource"},
                  "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}}
        try:
            with patch("robot_companion_backend.diagnostics.code_actions", return_value=["preserved"]) as actions:
                for only in (None, [], ["quickfix"]):
                    self.assertEqual(server.handle("textDocument/codeAction", {
                        **params, "context": {"triggerKind": 2, "diagnostics": [], "only": only}}), [])
                actions.assert_not_called()
                for context in ({"triggerKind": 1, "diagnostics": []}, {},
                                {"triggerKind": 2, "diagnostics": [{"code": "unknown-keyword"}]},
                                {"triggerKind": 2, "diagnostics": [], "only": ["source.addMissingImports"]},
                                {"triggerKind": 2, "diagnostics": [], "only": [""]}):
                    self.assertEqual(server.handle("textDocument/codeAction", {**params, "context": context}),
                                     ["preserved"])
                self.assertEqual(actions.call_count, 5)
        finally:
            server.diagnostic_worker.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "slow-actions":
        from robot_companion_backend import diagnostics

        def slow_analysis(*args, **kwargs):
            # A controlled substitute for measured importer analysis, never workspace code.
            (Path(sys.argv[2]) / "analysed").touch()
            time.sleep(3)
            return []

        diagnostics.code_actions = slow_analysis
        server = LanguageServer(FramedStream(sys.stdin.buffer, sys.stdout.buffer))
        try:
            sys.exit(server.run())
        finally:
            server.diagnostic_worker.close()
    unittest.main()

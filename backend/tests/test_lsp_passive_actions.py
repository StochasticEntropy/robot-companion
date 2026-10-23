"""Automatic empty quick fixes cannot starve later navigation; explicit actions remain."""

from pathlib import Path
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from client import Client
from robot_companion_backend.lsp import LanguageServer
from robot_companion_backend.protocol import FramedStream
from robot_companion_backend import diagnostics, project
from robot_companion_backend.workspace import Workspace


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


class ExplicitCodeActionFanoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb action fanout-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.resource = self.root / "shared.resource"
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    Log    ${not_defined}\n")
        self.importers = 40
        for index in range(self.importers):
            self.write(f"suite{index}.robot", "*** Settings ***\nResource    shared.resource\nLibrary    Heavy.py\n"
                       "*** Test Cases ***\nT\n    Shared Step\n")
        self.write("Heavy.py", "raise RuntimeError('source inspection must not run this library')\n" + "".join(
            f"def unrelated_{index}(value: str = 'x') -> str:\n    return value\n" for index in range(40)))

    def write(self, name, text):
        (self.root / name).write_text(text, encoding="utf-8")

    @staticmethod
    def selected(line):
        return {"start": {"line": line, "character": 0}, "end": {"line": line, "character": 200}}

    def actions(self, line=2, only=None):
        with self.workspace.source_snapshot():
            return diagnostics.code_actions(self.workspace, self.resource.as_uri(), self.selected(line), only, source=True)

    def test_known_call_with_no_edit_does_not_build_importer_graphs_or_variable_flow(self):
        with patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graphs, \
                patch.object(diagnostics, "variable_findings", side_effect=AssertionError("not a quick-fix rule")):
            self.assertEqual(self.actions(), [])
            self.assertEqual(graphs.call_count, 1, "forty importing suites have no bearing on a known unambiguous call")
        # Source actions still inspect the whole file, but this file offers no import edit.
        with patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graphs:
            self.assertEqual(self.actions(0, ["source.addMissingImports"]), [])
            self.assertEqual(graphs.call_count, 1)

    def test_explicit_selection_outside_fixable_keyword_cells_does_not_scan_importers(self):
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    Missing Step\n")
        with patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graphs:
            self.assertEqual(self.actions(0), [])
            self.assertEqual(graphs.call_count, 1)

    def test_required_importer_scopes_reuse_the_graph_already_built_and_keep_a_real_fix(self):
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    Newly Available Step\n")
        self.write("available.resource", "*** Keywords ***\nNewly Available Step\n    No Operation\n")
        with patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graphs:
            action, = self.actions()
            self.assertEqual(action["title"], "Import resource available.resource")
            self.assertEqual(graphs.call_count, self.importers + 1,
                             "each necessary importer gets one current graph, not a second graph for its scope")
        self.assertEqual(action["diagnostics"][0]["code"], "unknown-keyword")

    def test_importer_libraries_config_and_exact_text_changes_still_suppress_stale_fixes(self):
        for path in self.root.glob("suite*.robot"):
            path.unlink()
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    Supplied Step\n")
        self.write("available.resource", "*** Keywords ***\nSupplied Step\n    No Operation\n")
        self.write("parent.robot", "*** Settings ***\nResource    ${CURDIR}/shared.resource\nLibrary    ${PROVIDER}\n"
                   "*** Test Cases ***\nT\n    Shared Step\n")
        # Explicitly imported dependencies may live outside the workspace scan.
        (self.root / ".providers").mkdir()
        self.write(".providers/ProviderA.py", "def supplied_step():\n    pass\n")
        self.write(".providers/ProviderB.py", "def distinct_step():\n    pass\n")
        def configure(provider):
            self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                "robotArguments": ["--variable", "PROVIDER:" + provider]})
        configure(".providers/ProviderA.py")
        self.assertEqual(self.actions(), [], "the importer already supplies this keyword")
        configure(".providers/ProviderB.py")
        self.assertEqual([action["title"] for action in self.actions()], ["Import resource available.resource"])
        provider = self.root / ".providers/ProviderB.py"
        before = provider.stat()
        self.write(".providers/ProviderB.py", "def supplied_step():\n    pass\n")
        os.utime(provider, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(provider.stat().st_size, before.st_size)
        self.assertEqual(self.actions(), [], "a same-size, same-mtime importer edit is current")
        self.workspace.open(provider.as_uri(), "def distinct_step():\n    pass\n", 1)
        self.assertEqual([action["title"] for action in self.actions()], ["Import resource available.resource"])
        self.workspace.close(provider.as_uri())
        self.assertEqual(self.actions(), [])

    def test_importer_search_order_still_suppresses_ambiguous_qualification(self):
        for path in self.root.glob("suite*.robot"):
            path.unlink()
        self.write("shared.resource", "*** Settings ***\nLibrary    North.py\nLibrary    South.py\n"
                   "*** Keywords ***\nShared Step\n    Ring Bell\n")
        self.write("North.py", "def ring_bell():\n    pass\n")
        self.write("South.py", "def ring_bell():\n    pass\n")
        self.write("parent.robot", "*** Settings ***\nResource    shared.resource\n*** Test Cases ***\nT\n"
                   "    Set Library Search Order    North\n    Shared Step\n")
        self.assertEqual(self.actions(5), [], "the importing suite chooses the library at run time")
        self.write("parent.robot", "*** Settings ***\nResource    shared.resource\n*** Test Cases ***\nT\n    Shared Step\n")
        self.assertEqual([action["title"] for action in self.actions(5)],
                         ["Use North.Ring Bell (North.py)", "Use South.Ring Bell (South.py)"])

    def test_source_action_keeps_all_missing_calls_even_outside_the_selection(self):
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    First Missing\n    Second Missing\n")
        self.write("first.resource", "*** Keywords ***\nFirst Missing\n    No Operation\n")
        self.write("second.resource", "*** Keywords ***\nSecond Missing\n    No Operation\n")
        action, = self.actions(0, ["source.addMissingImports"])
        self.assertEqual(action["title"], "Add all missing imports (2)")
        self.assertEqual([finding["range"]["start"]["line"] for finding in action["diagnostics"]], [2, 3])

    def test_real_diagnostic_backed_resource_actions_keep_definition_available(self):
        self.write("shared.resource", "*** Keywords ***\nShared Step\n    Log    ${not_defined}\n"
                   "    Local Step\nLocal Step\n    No Operation\n")
        client = Client()
        try:
            client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {"textDocument": {
                "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["quickfix"]}}}}}})
            client.send("initialized", {})
            client.send("textDocument/didOpen", {"textDocument": {"uri": self.resource.as_uri(), "version": 1,
                                                               "text": self.resource.read_text(encoding="utf-8")}})
            published = client.wait_diagnostics(self.resource.as_uri(), 1)["diagnostics"]
            diagnostic, = published
            self.assertEqual(diagnostic["code"], "undefined-variable")
            for trigger in (1, 2):  # Explicit context menu and diagnostic-backed automatic lightbulb.
                self.assertEqual(client.request("textDocument/codeAction", {
                    "textDocument": {"uri": self.resource.as_uri()}, "range": diagnostic["range"],
                    "context": {"triggerKind": trigger, "diagnostics": published}}), [])
            definition, = client.request("textDocument/definition", {
                "textDocument": {"uri": self.resource.as_uri()}, "position": {"line": 3, "character": 8}})
            self.assertEqual(definition["range"]["start"]["line"], 4)
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=3), 0)
        finally:
            client.close()
        self.assertFalse(client.forced_cleanup)


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

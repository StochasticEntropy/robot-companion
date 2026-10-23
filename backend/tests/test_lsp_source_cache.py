"""Current source identity, bounded syntax reuse and large import-graph navigation."""

import ast
import collections
import os
from pathlib import Path
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

from robot.api import get_model
from robot_companion_backend import explorer, navigation, project
from robot_companion_backend.lsp import LanguageServer
from robot_companion_backend.source_cache import Sources
from robot_companion_backend.workspace import Workspace


class SourceCacheTests(unittest.TestCase):
    def test_nested_snapshot_reads_once_but_next_request_checks_exact_content(self):
        cache = Sources()
        value = ["first"]
        reader = mock.Mock(side_effect=lambda: value[0])
        with cache.snapshot():
            first = cache.read("file", reader)
            with cache.snapshot():
                self.assertIs(cache.read("file", reader), first)
            self.assertEqual(reader.call_count, 1)
        with cache.snapshot():
            self.assertIs(cache.read("file", reader), first)
        self.assertEqual(reader.call_count, 2)
        value[0] = "other"
        with cache.snapshot():
            self.assertIsNot(cache.read("file", reader), first)
        self.assertFalse(cache.current)

    def test_file_and_source_byte_limits_apply_to_retained_and_request_entries(self):
        cache = Sources(max_files=2, max_source_bytes=6)
        with cache.snapshot():
            for name in "abc":
                cache.read(name, lambda: "xx")
            self.assertEqual(list(cache.entries), ["b", "c"])
            self.assertEqual(list(cache.current), ["b", "c"])
            self.assertEqual((cache.bytes, cache.current_bytes), (4, 4))
            cache.read("large", lambda: "x" * 7)
            self.assertEqual(list(cache.entries), ["b", "c"])
            self.assertEqual(list(cache.current), ["b", "c"])
        self.assertEqual(cache.current_bytes, 0)
        cache.read("wide", lambda: "éé")  # UTF-8 bytes, not character count
        self.assertEqual(cache.bytes, 6)
        self.assertLessEqual(len(cache.entries), 2)

    def test_analysis_memo_is_bounded_request_local_and_cleared_for_overlay_changes(self):
        cache = Sources()
        compute = mock.Mock(return_value="proof")
        self.assertEqual(cache.analyse("key", compute), "proof")
        self.assertEqual(cache.analyse("key", compute), "proof")
        self.assertEqual(compute.call_count, 2)  # No persistent dependency-dependent proof.
        with cache.snapshot():
            cache.analyse("key", compute)
            with cache.snapshot():
                cache.analyse("key", compute)
            self.assertEqual(compute.call_count, 3)
            for key in range(200):
                cache.analyse(key, lambda: "proof")
            self.assertLessEqual(len(cache.request_analyses), 128)
            cache.forget_current("an edited dependency")
            self.assertFalse(cache.request_analyses)
            cache.analyse("key", compute)
        self.assertFalse(cache.request_analyses)
        with cache.snapshot():
            cache.analyse("key", compute)
        self.assertEqual(compute.call_count, 5)

    def test_failure_discards_old_source_and_does_not_hide_recreation(self):
        cache = Sources()
        cache.read("file", lambda: "old")
        with self.assertRaises(FileNotFoundError):
            cache.read("file", mock.Mock(side_effect=FileNotFoundError()))
        self.assertNotIn("file", cache.entries)
        self.assertEqual(cache.bytes, 0)
        self.assertEqual(cache.read("file", lambda: "new").text, "new")


class WorkspaceSyntaxCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.resource = self.root / "shared.resource"
        self.resource.write_text("*** Keywords ***\nProbe Step\n    No Operation\nOther Step\n    No Operation\n", encoding="utf-8")
        self.suite = self.root / "suite.robot"
        self.text = "*** Settings ***\nResource    shared.resource\n*** Test Cases ***\nT\n    Probe Step\n"
        self.suite.write_text(self.text, encoding="utf-8")
        self.workspace.open(self.suite.as_uri(), self.text, 1)

    def definition(self):
        return self.workspace.definition(self.suite.as_uri(), {"line": 4, "character": 8})

    def test_warm_definition_reuses_models_and_reads_each_closed_file_once(self):
        original = Path.read_text
        reads = collections.Counter()
        def read(path, *args, **kwargs):
            reads[path] += 1
            return original(path, *args, **kwargs)
        with mock.patch("robot.api.get_model", wraps=get_model) as parser, mock.patch.object(Path, "read_text", read):
            first = self.definition()
            self.assertEqual(parser.call_count, 2)
            reads.clear()
            self.assertEqual(self.definition(), first)
            self.assertEqual(parser.call_count, 2)
            self.assertEqual(reads, {self.resource: 1})

    def test_same_size_same_mtime_disk_edit_and_unsaved_overlay_close_stay_current(self):
        self.assertEqual(self.definition()[0]["range"]["start"]["line"], 1)
        before = self.resource.stat()
        self.resource.write_text("*** Keywords ***\nOther Step\n    No Operation\nProbe Step\n    No Operation\n", encoding="utf-8")
        os.utime(self.resource, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.resource.stat().st_size, before.st_size)
        self.assertEqual(self.definition()[0]["range"]["start"]["line"], 3)
        self.workspace.open(self.resource.as_uri(), "*** Keywords ***\nProbe Step\n    No Operation\n", 1)
        self.assertEqual(self.definition()[0]["range"]["start"]["line"], 1)
        self.workspace.close(self.resource.as_uri())
        self.assertEqual(self.definition()[0]["range"]["start"]["line"], 3)
        self.resource.unlink()
        self.assertEqual(self.definition(), [])
        self.resource.write_text("*** Keywords ***\nProbe Step\n    No Operation\n", encoding="utf-8")
        self.assertEqual(self.definition()[0]["range"]["start"]["line"], 1)

    def test_overlay_changes_in_nested_snapshot_replace_prior_source(self):
        with self.workspace.source_snapshot():
            first = self.workspace.model(self.suite)
            self.workspace.open(self.suite.as_uri(), self.text.replace("Probe Step", "Other Step"), 2)
            self.assertIsNot(self.workspace.model(self.suite), first)
            self.workspace.close(self.suite.as_uri())
            self.assertEqual(ast.dump(self.workspace.model(self.suite)), ast.dump(first))

    def test_python_syntax_and_selector_readings_reused_but_never_library_execution(self):
        library = self.root / "Library.py"
        library.write_text("raise RuntimeError('must not execute')\ndef probe_step():\n    return 1\n", encoding="utf-8")
        self.workspace.open(self.suite.as_uri(), self.text.replace("Resource    shared.resource", "Library    Library.py"), 2)
        with mock.patch("robot_companion_backend.workspace.ast.parse", wraps=ast.parse) as parser:
            found = self.definition()
            self.assertEqual(found[0]["uri"], library.as_uri())
            count = parser.call_count
            self.assertGreater(count, 0)
            self.assertEqual(self.definition(), found)
            self.assertEqual(parser.call_count, count)
            library.write_text("raise RuntimeError('must not execute')\n\ndef probe_step():\n    return 2\n", encoding="utf-8")
            self.assertEqual(self.definition()[0]["range"]["start"]["line"], 2)
            self.assertGreater(parser.call_count, count)

    def test_python_keyword_documentation_and_rename_share_the_same_syntax(self):
        library = self.root / "Library.py"
        library.write_text('"""Library docs."""\nfrom robot.api.deco import keyword\n'
                           '@keyword("Probe Step")\ndef probe_step():\n    """Keyword docs."""\n', encoding="utf-8")
        with mock.patch("robot_companion_backend.workspace.ast.parse", wraps=ast.parse) as parser:
            self.workspace.library_reading(library)
            before = ast.dump(self.workspace.python_tree(library), include_attributes=True)
            parsed = parser.call_count
            self.assertEqual(explorer.library_documentation(
                self.workspace, SimpleNamespace(path=library, name="Library.py")), "Library docs.")
            symbols = navigation.library_definitions(self.workspace, library)
            self.assertEqual(len(symbols), 1)
            self.assertFalse(isinstance(navigation.name_literal(self.workspace, symbols[0]), str))
            self.assertEqual(parser.call_count, parsed)
            self.assertEqual(ast.dump(self.workspace.python_tree(library), include_attributes=True), before)

    def test_configuration_and_import_graph_are_rebuilt_from_shared_syntax(self):
        other = self.root / "other.resource"
        other.write_text("*** Keywords ***\n\nProbe Step\n    No Operation\n", encoding="utf-8")
        text = self.text.replace("shared.resource", "${RESOURCE}")
        self.workspace.open(self.suite.as_uri(), text, 2)
        def configured(name):
            return project.parse({"version": 1, "cwd": str(self.root), "robotArguments": ["--variable", "RESOURCE:" + name]})
        self.workspace.config = configured("shared.resource")
        self.assertEqual(self.definition()[0]["uri"], self.resource.as_uri())
        model = self.workspace.model(self.suite)
        self.workspace.config = configured("other.resource")
        self.assertEqual(self.definition()[0]["uri"], other.as_uri())
        self.assertIs(self.workspace.model(self.suite), model)

    def test_lsp_features_share_syntax_without_mutating_cached_models(self):
        server = LanguageServer(mock.Mock())
        self.addCleanup(server.diagnostic_worker.close)
        server.workspace, server.initialized = self.workspace, True
        before = ast.dump(self.workspace.model(self.suite), include_attributes=True)
        params = {"textDocument": {"uri": self.suite.as_uri()}, "position": {"line": 4, "character": 8}}
        with mock.patch("robot.api.get_model", wraps=get_model) as parser:
            server.dispatch("textDocument/definition", params)
            parsed = parser.call_count
            for method in ("textDocument/hover", "textDocument/completion", "textDocument/signatureHelp", "textDocument/documentSymbol", "textDocument/semanticTokens/full"):
                server.dispatch(method, params)
            self.assertEqual(parser.call_count, parsed)
        self.assertEqual(ast.dump(self.workspace.model(self.suite), include_attributes=True), before)

    def test_complex_import_fanout_warm_navigation_reuses_every_model(self):
        count = 80
        imports = "".join(f"Resource    r{i}.resource\n" for i in range(count))
        for i in range(count):
            (self.root / f"r{i}.resource").write_text("*** Keywords ***\n" + "".join(
                f"Keyword {i} {j}\n    [Arguments]    ${{value}}=a\n    Log    ${{value}}\n" for j in range(40)), encoding="utf-8")
        text = "*** Settings ***\n" + imports + "*** Test Cases ***\nT\n    Keyword 79 39\n"
        self.workspace.open(self.suite.as_uri(), text, 2)
        params = {"line": count + 3, "character": 8}
        with mock.patch("robot.api.get_model", wraps=get_model) as parser:
            found = self.workspace.definition(self.suite.as_uri(), params)
            self.assertEqual(parser.call_count, count + 1)
            started = time.monotonic()
            self.assertEqual(self.workspace.definition(self.suite.as_uri(), params), found)
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(parser.call_count, count + 1)
            self.assertEqual(found[0]["uri"], (self.root / "r79.resource").as_uri())
            self.assertEqual(found[0]["range"]["start"]["line"], 1 + 3 * 39)

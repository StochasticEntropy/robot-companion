"""Bounded warm navigation work with current source and independent result checks."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from robot.api import get_model
from robot_companion_backend import project
from robot_companion_backend import workspace as workspace_module
from robot_companion_backend.source_cache import Source, Sources
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import API, HELPER, METADATA, WRAPPERS, NAME


class NavigationBackendLatencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native-navigation-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = self.fresh_workspace()

    def fresh_workspace(self):
        workspace = Workspace()
        workspace.roots = [self.root]
        workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        return workspace

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    @staticmethod
    def library_text(index, methods=17):
        return ("from robot.api.deco import keyword\n"
                "raise RuntimeError('Native inspection must not import this library')\n\n"
                f"class Library{index:03}:\n" + "".join(
                    f"    @keyword('Probe {index:03} {method:02}')\n"
                    f"    def probe_{method}(self, value: str, count: int = 1, *, mode: str = 'safe') -> str:\n"
                    f"        \"\"\"Document {index:03} {method:02}.\"\"\"\n"
                    "        return value\n\n" for method in range(methods)))

    @staticmethod
    def fact(symbol):
        args = symbol.args
        return (symbol.name, symbol.namespace, symbol.location(), symbol.doc, symbol.declaration,
                None if args is None else tuple(str(argument) for argument in args),
                None if args is None else dict(args.defaults),
                None if args is None else {name: str(value) for name, value in args.types.items()},
                None if args is None else str(args.return_type))

    def selected(self, workspace, suite, name):
        return [symbol for symbol in workspace.graph(suite).groups[2] if symbol.name == name]

    def assert_matches_fresh(self, suite, name):
        fresh = self.fresh_workspace()
        fresh.config = self.workspace.config
        for path, (version, text) in self.workspace.documents.items():
            fresh.open(path.as_uri(), text, version)
        warm_symbols = self.selected(self.workspace, suite, name)
        self.assertEqual([self.fact(symbol) for symbol in warm_symbols],
                         [self.fact(symbol) for symbol in self.selected(fresh, suite, name)])
        self.assertEqual(self.workspace.sources.depth, 0)
        self.assertFalse(self.workspace.sources.current)
        self.assertFalse(self.workspace.sources.request_analyses)
        self.assertLessEqual(len(self.workspace.sources.entries), 512)
        return warm_symbols

    def test_47_class_libraries_reuse_799_argument_specs_and_keep_namespaces_isolated(self):
        for index in range(47):
            self.write(f"Library{index:03}.py", self.library_text(index))
        text = "*** Settings ***\n" + "".join(
            f"Library    Library{index:03}.Library{index:03}    AS    Alias{index:03}\n" for index in range(47))
        suite = self.write("suite.robot", text)
        with mock.patch.object(workspace_module, "python_arguments", wraps=workspace_module.python_arguments) as arguments:
            first = self.workspace.graph(suite).groups[2]
            self.assertEqual(len(first), 799)
            self.assertEqual(arguments.call_count, 799)
            arguments.reset_mock()
            second = self.workspace.graph(suite).groups[2]
            self.assertEqual(arguments.call_count, 0, "Warm unchanged source must not rebuild RF argument specifications")
            self.assertEqual([self.fact(symbol) for symbol in second], [self.fact(symbol) for symbol in first])
            original = next(symbol for symbol in second if symbol.name == "Probe 023 08")
            self.assertEqual(original.namespace, "Alias023")
            self.assertFalse(original.declaration)
            self.assertNotIn("self", original.args.positional_or_named)
            self.assertEqual(original.args.defaults["count"], 1)
            original.args.defaults["count"] = 999
            original.args.types.clear()
            self.workspace.open(suite.as_uri(), text.replace("AS    Alias023", "AS    Current023"), 1)
            third = self.workspace.graph(suite).groups[2]
            self.assertEqual(arguments.call_count, 0)
            current = next(symbol for symbol in third if symbol.name == "Probe 023 08")
            self.assertEqual(current.namespace, "Current023")
            self.assertEqual(current.args.defaults["count"], 1, "Caller mutation must not poison cached templates")
            self.assertIn("value", current.args.types)
            self.assertIsNot(current.args, original.args)

    def test_cached_python_facts_follow_exact_disk_text_overlays_deletion_and_path_changes(self):
        a, b = self.root / "a", self.root / "b"
        first = self.write("a/Library000.py", self.library_text(0, 1))
        self.write("b/Library000.py", self.library_text(0, 1).replace("Document 000 00", "Document other0"))
        suite = self.write("suite.robot", "*** Settings ***\nLibrary    Library000.Library000    AS    Selected\n")
        def configure(path):
            self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                                                   "robotArguments": ["--pythonpath", str(path)]})
        configure(a)
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00")[0].path, first)
        original = first.read_text(encoding="utf-8")
        before = first.stat()
        changed = original.replace("Document 000 00", "Document changed").replace("count: int = 1", "count: int = 2")
        # Keep the edit's UTF-8 byte count exactly equal, independently of timestamp resolution.
        changed = changed.replace("Document changed", "Document new 00")
        self.assertEqual(len(changed.encode("utf-8")), before.st_size)
        first.write_text(changed, encoding="utf-8")
        os.utime(first, ns=(before.st_atime_ns, before.st_mtime_ns))
        symbol, = self.assert_matches_fresh(suite, "Probe 000 00")
        self.assertEqual(symbol.doc, "Document new 00.")
        self.assertEqual(symbol.args.defaults["count"], 2)
        self.workspace.open(first.as_uri(), "\n" + original.replace("Document 000 00", "Overlay 000 00"), 1)
        symbol, = self.assert_matches_fresh(suite, "Probe 000 00")
        self.assertEqual(symbol.doc, "Overlay 000 00.")
        self.workspace.close(first.as_uri())
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00")[0].doc, "Document new 00.")
        first.unlink()
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00"), [])
        first.write_text(original, encoding="utf-8")
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00")[0].doc, "Document 000 00.")
        configure(b)
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00")[0].path, b / "Library000.py")
        configure(a)
        self.assertEqual(self.assert_matches_fresh(suite, "Probe 000 00")[0].path, first)

    def test_declaration_marker_and_factory_dependencies_are_not_persisted_as_namespace_facts(self):
        for name, text in {"__init__.py": "", "helpers.py": HELPER, "metadata.py": METADATA,
                           "wrappers.py": WRAPPERS, "base.py": "class Parent:\n    pass\n", "api.py": API}.items():
            self.write(f"ExampleProject/{name}", text)
        suite = self.write("suite.robot", "*** Settings ***\nLibrary    ExampleProject.api.Api    AS    Selected\n")
        with mock.patch.object(workspace_module, "python_arguments", wraps=workspace_module.python_arguments) as arguments:
            symbol, = self.assert_matches_fresh(suite, NAME)
            self.assertTrue(symbol.declaration)
            arguments.reset_mock()
            current, = self.selected(self.workspace, suite, NAME)
            self.assertTrue(current.declaration)
            self.assertEqual(arguments.call_count, 0)
        helper = self.root / "ExampleProject/helpers.py"
        self.workspace.open(helper.as_uri(), HELPER.replace("return metadata.keyword", "return unsupported.keyword"), 1)
        self.assertEqual(self.assert_matches_fresh(suite, NAME), [])
        self.workspace.close(helper.as_uri())
        symbol, = self.assert_matches_fresh(suite, NAME)
        self.assertTrue(symbol.declaration)
        self.assertNotIn("self", symbol.args.positional_or_named)

    def test_source_syntax_analysis_is_bounded_exact_text_and_retries_failed_computation(self):
        source = Source("text", 4)
        compute = mock.Mock(return_value=("immutable",))
        self.assertEqual(source.syntax("same", compute), ("immutable",))
        self.assertEqual(source.syntax("same", compute), ("immutable",))
        self.assertEqual(compute.call_count, 1)
        for index in range(150):
            source.syntax(index, lambda: (index,))
        self.assertEqual(len(source.syntax_analyses), 128)
        self.assertNotIn("same", source.syntax_analyses)
        failing = mock.Mock(side_effect=[ValueError("incomplete analysis"), "complete"])
        with self.assertRaisesRegex(ValueError, "incomplete"):
            source.syntax("retry", failing)
        self.assertNotIn("retry", source.syntax_analyses)
        self.assertEqual(source.syntax("retry", failing), "complete")
        self.assertEqual(source.syntax("retry", failing), "complete")
        self.assertEqual(failing.call_count, 2)
        cache = Sources()
        old = cache.read("same-path", lambda: "old")
        old.syntax("fact", lambda: "old fact")
        new = cache.read("same-path", lambda: "new")
        self.assertIsNot(old, new)
        self.assertEqual(new.syntax("fact", lambda: "new fact"), "new fact")
        with self.assertRaisesRegex(RuntimeError, "request stopped"):
            with cache.snapshot():
                cache.read("same-path", lambda: "new")
                cache.analyse("request-proof", lambda: "current")
                self.assertIn("same-path", cache.pinned)
                with cache.snapshot():
                    raise RuntimeError("request stopped")
        self.assertEqual(cache.depth, 0)
        self.assertFalse(cache.current)
        self.assertFalse(cache.request_analyses)
        self.assertFalse(cache.pinned)
        self.assertEqual(cache.current_bytes, 0)

    def test_installed_library_resolution_is_once_per_request_and_rechecks_new_search_roots(self):
        a, b = self.root / "a", self.root / "b"
        first = self.write("a/Tools.py", "def probe():\n    pass\n")
        second = self.write("b/Tools.py", "def other():\n    pass\n")
        with mock.patch.object(self.workspace, "python_library", wraps=self.workspace.python_library) as lookup:
            with self.workspace.source_snapshot():
                self.assertEqual(self.workspace.installed_library("Tools", [a])[0], first)
                self.assertEqual(self.workspace.installed_library("Tools", [a])[0], first)
                self.assertEqual(lookup.call_count, 1)
                self.assertEqual(self.workspace.installed_library("Tools", [b])[0], second)
                self.assertEqual(lookup.call_count, 2)
            first.unlink()
            with self.workspace.source_snapshot():
                self.assertIsNone(self.workspace.installed_library("Tools", [a]))
            self.assertEqual(self.workspace.sources.depth, 0)
            first.write_text("def restored():\n    pass\n", encoding="utf-8")
            with self.workspace.source_snapshot():
                self.assertEqual(self.workspace.installed_library("Tools", [a])[0], first)

    def test_600_resource_scan_retains_hot_syntax_without_cyclic_reparsing_or_stale_edits(self):
        imports = []
        for index in range(600):
            name = f"resources/part-{index:03}.resource"
            self.write(name, f"*** Keywords ***\nProbe {index:03}\n    No Operation\nOther {index:03}\n    No Operation\n")
            imports.append(f"Resource    {name}\n")
        text = "*** Settings ***\n" + "".join(imports) + "*** Test Cases ***\nExample\n    Probe 599\n"
        suite = self.write("suite.robot", text)
        position = {"line": 603, "character": 8}
        path_reads = 0
        original_attribute = workspace_module.Symbol.__getattribute__
        def symbol_attribute(symbol, name):
            nonlocal path_reads
            if name == "path":
                path_reads += 1
            return original_attribute(symbol, name)
        with mock.patch("robot.api.get_model", wraps=get_model) as parser:
            with mock.patch.object(workspace_module.Symbol, "__getattribute__", new=symbol_attribute):
                first = self.workspace.definition(suite.as_uri(), position)
            self.assertLessEqual(path_reads, 600 * 8,
                                 "Each resource import must not scan all earlier resource symbols")
            self.assertEqual(parser.call_count, 601)
            self.assertEqual(len(first), 1)
            parser.reset_mock()
            self.assertEqual(self.workspace.definition(suite.as_uri(), position), first)
            self.assertLessEqual(parser.call_count, 128, "A >512-file scan must not evict every warm syntax entry in turn")
            self.assertEqual(len(self.workspace.sources.entries), 512)
            self.assertFalse(self.workspace.sources.current)
        target = self.root / "resources/part-599.resource"
        before = target.stat()
        target.write_text("*** Keywords ***\nOther 599\n    No Operation\nProbe 599\n    No Operation\n", encoding="utf-8")
        self.assertEqual(target.stat().st_size, before.st_size)
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        changed = self.workspace.definition(suite.as_uri(), position)
        self.assertEqual(changed[0]["range"]["start"]["line"], 3)
        self.assertEqual(changed, self.fresh_workspace().definition(suite.as_uri(), position))
        # A new disjoint working set can replace previously retained, unvisited syntax.
        for index in range(600):
            path = self.write(f"replacement/{index:03}.resource", "*** Keywords ***\nReplacement\n    No Operation\n")
            with self.workspace.source_snapshot():
                self.workspace.model(path)
        self.assertTrue(any(path.parent.name == "replacement" for path in self.workspace.sources.entries))
        self.assertLessEqual(len(self.workspace.sources.entries), 512)
        self.assertEqual(self.workspace.definition(suite.as_uri(), position), changed)


if __name__ == "__main__":
    unittest.main()

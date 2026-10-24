"""Request-local canonical paths avoid missing-candidate work and remain current."""

import collections
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from robot_companion_backend import workspace as workspace_module
from robot_companion_backend.source_cache import Sources
from robot_companion_backend.workspace import Workspace


class NavigationPathResolutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native-paths-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = Workspace()
        self.workspace.roots = [self.root]

    def write(self, name, text="def probe():\n    return None\n"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def module(self, directory, name):
        with self.workspace.source_snapshot():
            return self.workspace.python_module(directory, name)

    def test_missing_suffix_candidates_are_rejected_before_canonicalization(self):
        calls = collections.Counter()
        original = Path.resolve
        def observed(path, *args, **kwargs):
            calls[path] += 1
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", new=observed):
            with self.workspace.source_snapshot():
                self.assertIsNone(self.workspace.python_module(self.root, "Missing"))
                self.assertIsNone(self.workspace.python_module(self.root, "Missing"))
        missing_candidates = [self.root / f"Missing{suffix}" for suffix, _ in workspace_module.MODULE_SUFFIXES]
        self.assertEqual({str(path): calls[path] for path in missing_candidates if calls[path]}, {},
                         "A nonexistent extension candidate must not incur canonical-path resolution")
        self.assertEqual(calls[self.root / "Missing"], 0,
                         "A missing bare package folder must also be rejected before canonicalization")

    def test_found_module_and_graph_share_one_canonicalization_per_request(self):
        library = self.write("Probe.py", "from robot.api.deco import keyword\n"
                             "@keyword('Probe Step')\ndef probe_step():\n    return None\n")
        suite = self.write("suite.robot", "*** Settings ***\nLibrary    Probe\n")
        # Populate RF's own standard-library metadata before counting project path work.
        workspace_module.standard_symbols("BuiltIn")
        calls = collections.Counter()
        original = Path.resolve
        def observed(path, *args, **kwargs):
            calls[path] += 1
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", new=observed):
            for request in range(2):
                before = calls[library]
                with self.workspace.source_snapshot():
                    self.assertEqual(self.workspace.python_module(self.root, "Probe"), ("module", library))
                    graph = self.workspace.graph(suite, arguments=False)
                    self.assertEqual([(symbol.name, symbol.path) for symbol in graph.groups[2]],
                                     [("Probe Step", library)])
                self.assertEqual(calls[library] - before, 1,
                                 f"Request {request}: module classification and graph must share the canonical path")

    def test_missing_module_creation_deletion_and_recreation_are_seen_next_request(self):
        self.assertIsNone(self.module(self.root, "Created"))
        path = self.write("Created.py")
        self.assertEqual(self.module(self.root, "Created"), ("module", path))
        path.unlink()
        self.assertIsNone(self.module(self.root, "Created"))
        path.write_text("def replacement():\n    pass\n", encoding="utf-8")
        self.assertEqual(self.module(self.root, "Created"), ("module", path))

    def test_compiled_source_package_and_namespace_precedence_stays_python_compatible(self):
        suffix = next(suffix for suffix, source in workspace_module.MODULE_SUFFIXES
                      if not source and suffix != ".pyc")
        source = self.write("Choice.py")
        compiled = self.write("Choice" + suffix, "")
        self.assertEqual(self.module(self.root, "Choice"), ("compiled", compiled))
        package = self.write("Choice/__init__.py", "")
        self.assertEqual(self.module(self.root, "Choice"), ("package", package))
        package_compiled = self.write("Choice/__init__" + suffix, "")
        self.assertEqual(self.module(self.root, "Choice"), ("compiled", package_compiled))
        package_compiled.unlink()
        package.unlink()
        compiled.unlink()
        self.assertEqual(self.module(self.root, "Choice"), ("module", source))
        source.unlink()
        self.assertEqual(self.module(self.root, "Choice"), ("namespace", self.root / "Choice"))
        bytecode = self.write("Choice.pyc", "")
        self.assertEqual(self.module(self.root, "Choice"), ("compiled", bytecode))
        source.write_text("def restored():\n    pass\n", encoding="utf-8")
        self.assertEqual(self.module(self.root, "Choice"), ("module", source))

    def test_file_symlink_retargeting_and_unsaved_dangling_target_stay_current(self):
        first = self.write("targets/first.py")
        second = self.write("targets/second.py")
        link = self.root / "Linked.py"
        link.symlink_to(first)
        self.assertEqual(self.module(self.root, "Linked"), ("module", first))
        link.unlink()
        link.symlink_to(second)
        self.assertEqual(self.module(self.root, "Linked"), ("module", second))
        second.unlink()
        self.assertIsNone(self.module(self.root, "Linked"))
        self.workspace.open(second.as_uri(), "def unsaved():\n    pass\n", 1)
        self.assertEqual(self.module(self.root, "Linked"), ("module", second),
                         "The link's different basename must not hide its open unsaved target")
        self.workspace.close(second.as_uri())
        self.assertIsNone(self.module(self.root, "Linked"))

    def test_directory_alias_unsaved_overlays_case_rules_and_retargeting_stay_current(self):
        first = self.root / "real-a"
        second = self.root / "real-b"
        first.mkdir()
        second.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(first, target_is_directory=True)
        target = first / "OnlyOverlay.py"
        self.workspace.open(target.as_uri(), "def first_overlay():\n    pass\n", 1)
        self.assertEqual(self.module(alias, "OnlyOverlay"), ("module", target))
        unsaved_init = first / "UnsavedPackage" / "__init__.py"
        self.workspace.open(unsaved_init.as_uri(), "", 1)
        self.assertFalse(unsaved_init.parent.exists())
        self.assertEqual(self.module(alias, "UnsavedPackage"), ("package", unsaved_init))
        # Ask the real filesystem about casing rather than guessing from the test host label.
        marker = first / "CaseMarker"
        marker.write_text("case", encoding="utf-8")
        case_insensitive = (first / "casemarker").exists()
        cased = self.module(alias, "onlyoverlay")
        self.assertEqual(cased, ("module", target) if case_insensitive else None)
        alias.unlink()
        alias.symlink_to(second, target_is_directory=True)
        self.assertIsNone(self.module(alias, "OnlyOverlay"))
        next_target = second / "OnlyOverlay.py"
        self.workspace.open(next_target.as_uri(), "def second_overlay():\n    pass\n", 1)
        self.assertEqual(self.module(alias, "OnlyOverlay"), ("module", next_target))
        self.workspace.close(next_target.as_uri())
        self.assertIsNone(self.module(alias, "OnlyOverlay"))

    def test_unrelated_overlay_ancestor_and_dangling_aliases_do_not_change_package_identity(self):
        unrelated = self.root / "elsewhere" / "Missing" / "OnlyOverlay.py"
        self.workspace.open(unrelated.as_uri(), "def unrelated():\n    pass\n", 1)
        self.assertIsNone(self.module(self.root, "Missing"),
                          "A matching ancestor basename is only a precheck, never namespace evidence")
        package = self.root / "physical" / "ActualPackage"
        package_alias = self.root / "PackageAlias"
        package_alias.symlink_to(package, target_is_directory=True)
        init = package / "__init__.py"
        self.workspace.open(init.as_uri(), "", 1)
        self.assertFalse(package.exists())
        self.assertEqual(self.module(self.root, "PackageAlias"), ("package", init))
        namespace = self.root / "physical" / "ActualNamespace"
        namespace_alias = self.root / "NamespaceAlias"
        namespace_alias.symlink_to(namespace, target_is_directory=True)
        overlay = namespace / "OnlyOverlay.py"
        self.workspace.open(overlay.as_uri(), "def current():\n    pass\n", 1)
        self.assertFalse(namespace.exists())
        self.assertEqual(self.module(self.root, "NamespaceAlias"), ("namespace", namespace))
        self.workspace.close(init.as_uri())
        self.workspace.close(overlay.as_uri())
        self.assertIsNone(self.module(self.root, "PackageAlias"))
        self.assertIsNone(self.module(self.root, "NamespaceAlias"))

    def test_canonical_memo_is_nested_bounded_request_only_and_cleared_after_exception(self):
        cache = Sources()
        path = self.root / "source.py"
        calls = collections.Counter()
        original = Path.resolve
        def observed(candidate, *args, **kwargs):
            calls[candidate] += 1
            return original(candidate, *args, **kwargs)
        with mock.patch.object(Path, "resolve", new=observed):
            self.assertEqual(cache.resolve_path(path), path)
            self.assertEqual(cache.resolve_path(path), path)
            self.assertEqual(calls[path], 2, "Without a request scope canonical paths must not persist")
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                with cache.snapshot():
                    self.assertEqual(cache.resolve_path(path), path)
                    with cache.snapshot():
                        self.assertEqual(cache.resolve_path(path), path)
                    self.assertEqual(calls[path], 3)
                    self.assertTrue(cache.resolved_paths)
                    cache.forget_current(path)
                    self.assertFalse(cache.resolved_paths)
                    self.assertEqual(cache.resolve_path(path), path)
                    self.assertEqual(calls[path], 4)
                    for index in range(600):
                        cache.resolve_path(self.root / f"absent-{index:03}.py")
                    self.assertLessEqual(len(cache.resolved_paths), 512)
                    raise RuntimeError("interrupted")
            self.assertEqual(cache.depth, 0)
            self.assertFalse(cache.resolved_paths)
            self.assertFalse(cache.current)
            self.assertFalse(cache.request_analyses)
            self.assertEqual(cache.resolve_path(path), path)
            self.assertEqual(calls[path], 5)
        # The same relative spelling in two cwd contexts denotes different files.
        first, second = self.root / "cwd-a", self.root / "cwd-b"
        first.mkdir()
        second.mkdir()
        with cache.snapshot():
            with mock.patch.object(os, "getcwd", return_value=str(first)):
                self.assertEqual(cache.resolve_path(Path("relative.py")), first / "relative.py")
            with mock.patch.object(os, "getcwd", return_value=str(second)):
                self.assertEqual(cache.resolve_path(Path("relative.py")), second / "relative.py")
        self.assertFalse(cache.resolved_paths)

    def test_actual_overlay_open_and_close_clear_current_canonical_and_module_memos(self):
        path = self.root / "Unsaved.py"
        with self.workspace.source_snapshot():
            self.assertIsNone(self.workspace.python_module(self.root, "Unsaved"))
            self.workspace.sources.resolve_path(path)
            self.assertTrue(self.workspace.sources.resolved_paths)
            self.workspace.open(path.as_uri(), "def probe():\n    pass\n", 1)
            self.assertFalse(self.workspace.sources.resolved_paths)
            self.assertEqual(self.workspace.python_module(self.root, "Unsaved"), ("module", path))
            self.assertTrue(self.workspace.sources.resolved_paths)
            self.workspace.close(path.as_uri())
            self.assertFalse(self.workspace.sources.resolved_paths)
            self.assertIsNone(self.workspace.python_module(self.root, "Unsaved"))
            unrelated = self.root / "elsewhere" / "Unsaved.py"
            self.workspace.open(unrelated.as_uri(), "def unrelated():\n    pass\n", 1)
            self.assertIsNone(self.workspace.python_module(self.root, "Unsaved"),
                              "Matching an overlay basename must not select a different directory")
        self.assertFalse(self.workspace.sources.resolved_paths)


if __name__ == "__main__":
    unittest.main()

"""Intrinsic declaration syntax reuse without retaining import or factory proofs."""

import ast
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from robot_companion_backend import project, source_declarations
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import HELPER, METADATA


def api(count=80):
    return ("from ExampleProject.base import Parent\nfrom ExampleProject.helpers import keyword\n\n"
            "class Api(Parent):\n" + "".join(
                f"    @keyword('Typed Step {index}', extra_flag=True)\n"
                f"    def step_{index}(self, value: str, count: int = 1, *, mode: str = 'safe') -> str:\n"
                f"        \"\"\"Describe typed step {index}.\"\"\"\n"
                "        return value\n\n" for index in range(count)))


class DeclarationSyntaxLatencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb declaration latency-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        self.library = self.root / "ExampleProject/api.py"
        self.helper = self.root / "ExampleProject/helpers.py"
        self.metadata = self.root / "ExampleProject/metadata.py"
        self.write("ExampleProject/__init__.py", "")
        self.write("ExampleProject/base.py", "raise RuntimeError('never import source fixtures')\nclass Parent:\n    pass\n")
        self.write("ExampleProject/helpers.py", HELPER)
        self.write("ExampleProject/metadata.py", METADATA)
        self.write("ExampleProject/api.py", api())

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def names(self):
        with self.workspace.source_snapshot():
            return [name for _, name in self.workspace.library_reading(self.library, "Api", True).keywords]

    def test_warm_typed_library_reuses_lexical_scope_analysis_across_requests(self):
        with mock.patch.object(source_declarations, "_lexical_names", wraps=source_declarations._lexical_names) as lexical:
            expected = [f"Typed Step {index}" for index in range(80)]
            self.assertEqual(self.names(), expected)
            cold_count = lexical.call_count
            self.assertGreater(cold_count, 0)
            trees = {path: ast.dump(self.workspace.python_tree(path), include_attributes=True)
                     for path in (self.library, self.helper, self.metadata)}
            for _ in range(4):
                self.assertEqual(self.names(), expected)
            self.assertEqual(lexical.call_count, cold_count,
                             "unchanged source scopes must not be walked again by each navigation request")
            self.assertEqual(trees, {path: ast.dump(self.workspace.python_tree(path), include_attributes=True)
                                     for path in trees})

    def test_same_size_timestamp_edit_and_overlay_close_replace_cached_bindings(self):
        original = api()
        self.assertIn("Typed Step 79", self.names())
        changed = original.replace("Typed Step 79", "Fresh Step 79")
        before = self.library.stat()
        self.library.write_text(changed, encoding="utf-8")
        os.utime(self.library, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.library.stat().st_size, before.st_size)
        self.assertIn("Fresh Step 79", self.names())
        self.assertNotIn("Typed Step 79", self.names())
        self.workspace.open(self.library.as_uri(), original, 1)
        self.assertIn("Typed Step 79", self.names())
        self.assertNotIn("Fresh Step 79", self.names())
        self.workspace.close(self.library.as_uri())
        self.assertIn("Fresh Step 79", self.names())

    def test_helper_overlay_edit_delete_and_recreation_do_not_reuse_factory_proofs(self):
        self.assertEqual(len(self.names()), 80)
        altered = METADATA.replace("@robot_keyword(name, tags, types)", "@robot_keyword(name + ' changed', tags, types)")
        self.workspace.open(self.metadata.as_uri(), altered, 1)
        self.assertEqual(self.names(), [])
        self.workspace.close(self.metadata.as_uri())
        self.assertEqual(len(self.names()), 80)
        self.metadata.write_text(altered, encoding="utf-8")
        self.assertEqual(self.names(), [])
        self.metadata.write_text(METADATA, encoding="utf-8")
        self.assertEqual(len(self.names()), 80)
        self.metadata.unlink()
        self.assertEqual(self.names(), [])
        self.metadata.write_text(METADATA, encoding="utf-8")
        self.assertEqual(len(self.names()), 80)

    def test_class_scope_shadowing_is_rechecked_after_an_edit(self):
        self.assertEqual(len(self.names()), 80)
        self.library.write_text(api().replace("class Api(Parent):", "class Api(Parent):\n    keyword = object()"), encoding="utf-8")
        self.assertEqual(self.names(), [])
        self.library.write_text(api(), encoding="utf-8")
        self.assertEqual(len(self.names()), 80)

    def test_renamed_helper_is_resolved_only_through_its_current_import(self):
        self.assertEqual(len(self.names()), 80)
        renamed = self.metadata.with_name("renamed_metadata.py")
        self.metadata.rename(renamed)
        self.assertEqual(self.names(), [])
        self.helper.write_text(HELPER.replace("import metadata", "import renamed_metadata as metadata"),
                               encoding="utf-8")
        self.assertEqual(len(self.names()), 80)
        renamed.write_text(METADATA.replace("@robot_keyword(name, tags, types)",
                                            "@robot_keyword(name + ' changed', tags, types)"), encoding="utf-8")
        self.assertEqual(self.names(), [])

    def test_configured_helper_search_path_changes_still_resolve_current_source(self):
        self.write("ExampleProject/helpers.py", "from selected_metadata import keyword\n")
        for name, text in (("first/selected_metadata.py", METADATA),
                           ("other/selected_metadata.py", METADATA.replace("@robot_keyword(name, tags, types)",
                                                                         "@robot_keyword(name + ' changed', tags, types)"))):
            self.write(name, text)
        def configure(directory):
            self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                "robotArguments": ["--pythonpath", str(self.root / directory)]})
        configure("first")
        self.assertEqual(len(self.names()), 80)
        configure("other")
        self.assertEqual(self.names(), [])
        configure("first")
        self.assertEqual(len(self.names()), 80)


if __name__ == "__main__":
    unittest.main()

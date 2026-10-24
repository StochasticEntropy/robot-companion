"""Decorator binding plans reuse syntax while dependency results stay request-local."""

import ast
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from robot_companion_backend import project, source_declarations
from robot_companion_backend.source_cache import MAX_REQUEST_ANALYSES, MAX_SYNTAX_ANALYSES
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import HELPER, METADATA
from test_source_declaration_latency import api


class DeclarationExpressionLatencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb expression facts-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.configure()
        self.library = self.root / "ExampleProject/api.py"
        self.helper = self.root / "ExampleProject/helpers.py"
        self.metadata = self.root / "ExampleProject/metadata.py"
        self.write("ExampleProject/__init__.py", "")
        self.write("ExampleProject/base.py", "raise RuntimeError('source inspection must not import fixtures')\nclass Parent:\n    pass\n")
        self.write("ExampleProject/helpers.py", HELPER)
        self.write("ExampleProject/metadata.py", METADATA)
        self.write("ExampleProject/api.py", api(3))

    def configure(self, arguments=()):
        self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                                               "robotArguments": list(arguments)})

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def names(self, selector="Api"):
        with self.workspace.source_snapshot():
            return [name for _, name in self.workspace.library_reading(self.library, selector, False).keywords]

    def test_1953_decorators_resolve_one_shared_import_per_request(self):
        self.library.write_text(api(1953), encoding="utf-8")
        expected = [f"Typed Step {index}" for index in range(1953)]
        self.assertEqual(self.names(), expected)
        tree = ast.dump(self.workspace.python_tree(self.library), include_attributes=True)
        with mock.patch.object(source_declarations, "_import_module", wraps=source_declarations._import_module) as imported:
            self.assertEqual(self.names(), expected)
            self.assertEqual(imported.call_count, 1, "all identical bindings share one request-local import proof")
            self.assertEqual(self.names(), expected)
            self.assertEqual(imported.call_count, 2, "a new request must resolve the dependency again")
        self.assertEqual(ast.dump(self.workspace.python_tree(self.library), include_attributes=True), tree)

    def test_identical_expression_names_in_distinct_class_scopes_keep_shadowing(self):
        original = api(3)
        other = original[original.index("class Api(Parent):"):].replace("class Api(Parent):", "class Other(Parent):\n    keyword = object()")
        self.library.write_text(original + "\n" + other, encoding="utf-8")
        self.assertEqual(len(self.names()), 3)
        self.assertEqual(self.names("Other"), [])
        self.workspace.open(self.library.as_uri(), original + "\n" + other.replace("    keyword = object()\n", ""), 1)
        self.assertEqual(len(self.names("Other")), 3)
        self.workspace.close(self.library.as_uri())
        self.assertEqual(self.names("Other"), [])

    def test_missing_dependency_creation_deletion_and_recreation_are_rechecked(self):
        self.helper.unlink()
        self.assertEqual(self.names(), [])
        self.helper.write_text(HELPER, encoding="utf-8")
        self.assertEqual(len(self.names()), 3)
        self.metadata.unlink()
        self.assertEqual(self.names(), [])
        self.metadata.write_text(METADATA, encoding="utf-8")
        self.assertEqual(len(self.names()), 3)

    def test_alias_attribute_and_relative_imports_keep_current_dependency_state(self):
        for import_line, call in (("from ExampleProject import helpers as library", "library.keyword"),
                                  ("from .helpers import keyword as local_keyword", "local_keyword")):
            text = api(3).replace("from ExampleProject.helpers import keyword", import_line).replace("@keyword(", f"@{call}(")
            self.library.write_text(text, encoding="utf-8")
            self.assertEqual(len(self.names()), 3)
            self.workspace.open(self.metadata.as_uri(), METADATA.replace("@robot_keyword(name, tags, types)",
                "@robot_keyword(name + ' changed', tags, types)"), 1)
            self.assertEqual(self.names(), [])
            self.workspace.close(self.metadata.as_uri())
            self.assertEqual(len(self.names()), 3)

    def test_search_path_change_changes_unchanged_import_binding(self):
        self.library.write_text(api(3).replace("from ExampleProject.helpers import keyword", "from selected_helper import keyword"), encoding="utf-8")
        self.write("first/selected_helper.py", METADATA)
        self.write("other/selected_helper.py", METADATA.replace("@robot_keyword(name, tags, types)",
                                                              "@robot_keyword(name + ' changed', tags, types)"))
        self.configure(("--pythonpath", str(self.root / "first")))
        self.assertEqual(len(self.names()), 3)
        self.configure(("--pythonpath", str(self.root / "other")))
        self.assertEqual(self.names(), [])
        self.configure(("--pythonpath", str(self.root / "first")))
        self.assertEqual(len(self.names()), 3)

    def test_many_distinct_binding_plans_remain_bounded(self):
        imports = "\n".join(f"from ExampleProject.helpers import keyword as keyword_{index}" for index in range(160))
        text = imports + "\nclass Api:\n" + "".join(
            f"    @keyword_{index}('Step {index}')\n    def step_{index}(self):\n        pass\n" for index in range(160))
        self.library.write_text(text, encoding="utf-8")
        with self.workspace.source_snapshot():
            tree = self.workspace.python_tree(self.library)
            cls = tree.body[-1]
            for index, method in enumerate(cls.body):
                self.assertEqual(source_declarations._reference(self.workspace, self.library,
                    method.decorator_list[0].func, (cls,)), (self.helper, "keyword"))
                self.assertLessEqual(len(self.workspace.source(self.library).syntax_analyses), MAX_SYNTAX_ANALYSES)
                self.assertLessEqual(len(self.workspace.sources.request_analyses), MAX_REQUEST_ANALYSES)
            self.assertGreater(len(self.workspace.sources.request_analyses), 0)
        self.assertEqual(self.workspace.sources.request_analyses, {})


if __name__ == "__main__":
    unittest.main()

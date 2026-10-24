"""Definition candidates reduce proof work without caching keyword/factory outcomes."""

import ast
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from robot_companion_backend import project, source_declarations
from robot_companion_backend.workspace import Workspace, library_reading
from test_lsp_source_declarations_live import HELPER, METADATA
from test_source_declaration_latency import api


class DeclarationTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb declaration targets-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.configure()
        self.library = self.root / "ExampleProject/api.py"
        self.helper = self.root / "ExampleProject/helpers.py"
        self.metadata = self.root / "ExampleProject/metadata.py"
        self.write("ExampleProject/__init__.py", "")
        self.write("ExampleProject/base.py", "raise RuntimeError('do not import passive fixtures')\nclass Parent:\n    pass\n")
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

    def read(self, targets=None):
        with self.workspace.source_snapshot():
            tree = self.workspace.python_tree(self.library)
            reading = library_reading(tree, "Api", True)
            return source_declarations.augment(self.workspace, self.library, "Api", reading, targets=targets)

    def matching(self, target, targets=None):
        return [(node.lineno, name) for node, name in self.read(targets).keywords
                if self.workspace.matches(SimpleNamespace(name=name), target)]

    def assert_parity(self, target, alternatives=None):
        self.assertEqual(self.matching(target, (target,) if alternatives is None else alternatives),
                         self.matching(target))

    def test_1953_methods_need_only_the_selected_method_factory_proofs(self):
        self.library.write_text(api(1953), encoding="utf-8")
        with mock.patch.object(source_declarations, "_literal_name", wraps=source_declarations._literal_name) as literal:
            selected = self.matching("Typed Step 1500", ("Typed Step 1500",))
            self.assertEqual(len(selected), 1)
            self.assertEqual(literal.call_count, 1, "unrelated methods must not run decorator/factory proofs")
        self.assert_parity("Typed Step 1500")

    def test_catalog_reused_then_same_size_edit_overlay_and_close_replace_it(self):
        with mock.patch.object(source_declarations, "_declaration_catalog", wraps=source_declarations._declaration_catalog) as catalog:
            self.assert_parity("Typed Step 1")
            self.assert_parity("Typed Step 2")
            self.assertEqual(catalog.call_count, 1)
            before = self.library.stat()
            original = api(3)
            changed = original.replace("Typed Step 1", "Fresh Step 1")
            self.library.write_text(changed, encoding="utf-8")
            os.utime(self.library, ns=(before.st_atime_ns, before.st_mtime_ns))
            self.assertEqual(self.library.stat().st_size, before.st_size)
            self.assert_parity("Fresh Step 1")
            self.assertTrue(self.matching("Fresh Step 1", ("Fresh Step 1",)))
            self.workspace.open(self.library.as_uri(), original, 1)
            self.assert_parity("Typed Step 1")
            self.assertFalse(self.matching("Fresh Step 1", ("Fresh Step 1",)))
            self.workspace.close(self.library.as_uri())
            self.assert_parity("Fresh Step 1")
            self.assertEqual(catalog.call_count, 4)

    def test_every_literal_position_and_keyword_value_remains_a_possible_name(self):
        text = api(1).replace("'Typed Step 0', extra_flag=True", "'Decoy', 'Selected', extra_flag=True")
        self.library.write_text(text, encoding="utf-8")
        self.assert_parity("Selected")
        self.assertFalse(self.matching("Selected", ("Selected",)))
        shifted = METADATA.replace("def keyword(name=None,", "def keyword(prefix, name=None,")
        self.metadata.write_text(shifted, encoding="utf-8")
        self.assert_parity("Selected")
        self.assertTrue(self.matching("Selected", ("Selected",)))
        keyword_value = api(1).replace("'Typed Step 0', extra_flag=True", "alias='Selected', extra_flag=True")
        renamed_parameter = METADATA.replace("name", "alias")
        self.library.write_text(keyword_value, encoding="utf-8")
        self.metadata.write_text(renamed_parameter, encoding="utf-8")
        self.assert_parity("Selected")
        self.assertTrue(self.matching("Selected", ("Selected",)))

    def test_helper_edits_missing_files_and_configuration_change_are_still_fresh(self):
        self.assert_parity("Typed Step 1")
        altered = METADATA.replace("@robot_keyword(name, tags, types)", "@robot_keyword(name + ' changed', tags, types)")
        self.workspace.open(self.metadata.as_uri(), altered, 1)
        self.assert_parity("Typed Step 1")
        self.assertFalse(self.matching("Typed Step 1", ("Typed Step 1",)))
        self.workspace.close(self.metadata.as_uri())
        self.metadata.unlink()
        self.assert_parity("Typed Step 1")
        self.assertFalse(self.matching("Typed Step 1", ("Typed Step 1",)))
        self.metadata.write_text(METADATA, encoding="utf-8")
        self.assertTrue(self.matching("Typed Step 1", ("Typed Step 1",)))
        self.helper.write_text("from selected_metadata import keyword\n", encoding="utf-8")
        self.write("first/selected_metadata.py", METADATA)
        self.write("other/selected_metadata.py", altered)
        for directory, present in (("first", True), ("other", False), ("first", True)):
            self.configure(("--pythonpath", str(self.root / directory)))
            self.assert_parity("Typed Step 1")
            self.assertEqual(bool(self.matching("Typed Step 1", ("Typed Step 1",))), present)

    def test_all_decorators_and_class_shadowing_remain_authoritative(self):
        original = api(1)
        both = original.replace("class Api(Parent):", "from robot.api.deco import keyword as standard\nclass Api(Parent):")
        both = both.replace("    def step_0", "    @standard('Another Name')\n    def step_0")
        self.library.write_text(both, encoding="utf-8")
        self.assert_parity("Typed Step 0")
        self.assertFalse(self.matching("Typed Step 0", ("Typed Step 0",)))
        self.library.write_text(original.replace("class Api(Parent):", "class Api(Parent):\n    keyword = object()"), encoding="utf-8")
        self.assert_parity("Typed Step 0")
        self.assertFalse(self.matching("Typed Step 0", ("Typed Step 0",)))

    def test_normalized_duplicates_embedded_overlap_and_static_reading_are_preserved(self):
        text = api(5).replace("'Typed Step 0'", "'typed_step_1'")
        text = text.replace("'Typed Step 2'", "'Greet ${person}'").replace("'Typed Step 3'", "'Greet ${person:[A-Z]+}'")
        text = text.replace("class Api(Parent):", "from robot.api.deco import keyword as standard\nclass Api(Parent):")
        text += "    @standard('Known Static')\n    def known(self):\n        pass\n"
        self.library.write_text(text, encoding="utf-8")
        self.assert_parity("Typed Step 1")
        self.assertFalse(self.matching("Typed Step 1", ("Typed Step 1",)))
        self.assert_parity("Greet BOB")
        self.assertEqual(len(self.matching("Greet BOB", ("Greet BOB",))), 2)
        self.assert_parity("Known Static")
        self.assertTrue(self.matching("Known Static", ("Known Static",)))
        self.assert_parity("Typed Step 4", ("ExampleApi.Typed Step 4", "Typed Step 4"))
        self.library.write_text(text.replace("'Typed Step 4'", "'Known Static'"), encoding="utf-8")
        self.assert_parity("Known Static")
        self.assertFalse(self.matching("Known Static", ("Known Static",)))

    def test_embedded_metadata_is_kept_without_regex_work_or_ast_mutation(self):
        text = api(1).replace("extra_flag=True", "extra_flag=True, note='${metadata:[}'")
        self.library.write_text(text, encoding="utf-8")
        before = ast.dump(self.workspace.python_tree(self.library), include_attributes=True)
        with mock.patch("robot.running.arguments.embedded.EmbeddedArguments.from_name",
                        side_effect=AssertionError("a candidate catalog must not evaluate embedded regex")):
            # This metadata value is not the name. Conservatively keeping the
            # method is safe, and only the final resolver may match actual names.
            reading = self.read(("Unrelated",))
        self.assertEqual([name for _, name in reading.keywords], ["Typed Step 0"])
        self.assertEqual(ast.dump(self.workspace.python_tree(self.library), include_attributes=True), before)


if __name__ == "__main__":
    unittest.main()

"""Direct-call declaration prefilters preserve the fresh full-catalog namespace."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from robot_companion_backend import explorer, features, project, source_declarations
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import HELPER, METADATA, WRAPPERS


PREFIX = ("from ExampleProject.base import Parent\nfrom ExampleProject.helpers import keyword\n"
          "from ExampleProject.wrappers import preserve, observed\n"
          "raise RuntimeError('Native queries must not import fixture code')\n\n")


def library_text(class_name, names):
    return PREFIX + f"class {class_name}(Parent):\n" + "".join(
        f"    @keyword({name!r}, extra_flag=True)\n    @observed\n    @preserve\n"
        f"    def method_{index}(self, value: str, count: int = 1) -> str:\n"
        f"        \"\"\"Documentation for {name}.\"\"\"\n        return value\n\n"
        for index, name in enumerate(names))


NAMES = ["Target Step", "Given Target Step", "Api.Domain.Check", "Domain.Check", "Check",
         "Select ${item} Example", "Duplicate Step", "Duplicate Step"]


class DefinitionTargetFilterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native-targets-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        for name, text in {"__init__.py": "", "helpers.py": HELPER, "metadata.py": METADATA,
                           "wrappers.py": WRAPPERS, "base.py": "class Parent:\n    pass\n"}.items():
            self.write(f"ExampleProject/{name}", text)
        self.library_source = library_text("Library", NAMES)
        self.library = self.write("Library.py", self.library_source)
        self.write("steps.resource", "*** Keywords ***\nResource Step\n    No Operation\n")
        self.write("Known.py", "from robot.api.deco import keyword\n@keyword('Known Step')\n"
                   "def known_step(value: str = 'safe'):\n    return value\n")
        self.text = ("*** Settings ***\nLibrary    Library.Library    AS    Api\nLibrary    Known.py\n"
                     "Resource    steps.resource\n*** Variables ***\n${SUITE_VALUE}    sample\n"
                     "*** Test Cases ***\nExample\n    Api.Target Step    value=sample\n"
                     "    Local Step\n    Resource Step\n    Known Step\n    No Operation\n"
                     "    Given Target Step    value=sample\n    Given Api.Target Step    value=sample\n"
                     "    Api.Domain.Check    value=sample\n    Api.Check    value=sample\n"
                     "    Api.Select sample Example    value=sample\n    Api.Duplicate Step    value=sample\n"
                     "    Run Keyword    Api.Target Step    value=sample\n"
                     "    Log    ${SUITE_VALUE}\n    Api.Select ${SUITE_VALUE} Example    value=sample\n"
                     "*** Keywords ***\nLocal Step\n    No Operation\n")
        self.suite = self.write("suite.robot", self.text)
        self.workspace = self.fresh()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def fresh(self):
        fresh = Workspace()
        fresh.roots = [self.root]
        fresh.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        return fresh

    def position(self, token, occurrence=0, text=None):
        matching = [(number, line) for number, line in enumerate((text or self.text).splitlines()) if token in line]
        number, line = matching[occurrence]
        return {"line": number, "character": line.index(token) + len(token) - len(token.lstrip()) + 1}

    def full_definition(self, position):
        oracle = self.fresh()
        oracle.config = self.workspace.config
        for path, (version, text) in self.workspace.documents.items():
            oracle.open(path.as_uri(), text, version)
        full_graph = oracle.graph
        with mock.patch.object(oracle, "graph", side_effect=lambda root, *args, **kwargs: full_graph(root)):
            return oracle.definition(self.suite.as_uri(), position)

    def parity(self, position):
        expected = self.full_definition(position)
        actual = self.workspace.definition(self.suite.as_uri(), position)
        self.assertEqual(actual, expected)
        self.assertEqual(self.workspace.sources.depth, 0)
        self.assertFalse(self.workspace.sources.current)
        self.assertFalse(self.workspace.sources.request_analyses)
        return actual

    def test_direct_targets_match_full_local_resource_standard_and_custom_locations(self):
        for token in ("Api.Target Step", "Local Step", "Resource Step", "Known Step", "No Operation"):
            with self.subTest(token=token):
                first = self.parity(self.position(token))
                self.assertTrue(first)
                self.assertEqual(self.workspace.definition(self.suite.as_uri(), self.position(token)), first)
        custom, = self.parity(self.position("Api.Target Step"))
        self.assertEqual(custom["uri"], self.library.as_uri())
        self.assertEqual(custom["sourceKind"], "declaration")

    def test_bdd_full_names_dot_literals_aliases_embedded_patterns_and_duplicates_preserve_precedence(self):
        for token, method in (("Given Target Step", 1), ("Given Api.Target Step", 0),
                              ("Api.Domain.Check", 2), ("Api.Check", 4), ("Api.Select sample Example", 5)):
            with self.subTest(token=token):
                found, = self.parity(self.position(token))
                expected_line = next(index for index, line in enumerate(self.library_source.splitlines())
                                     if f"def method_{method}(" in line)
                self.assertEqual(found["range"]["start"]["line"], expected_line)
        self.assertEqual(self.parity(self.position("Api.Duplicate Step")), [])
        self.write("Other.py", library_text("Other", ["Check", "Select ${other} Example"]))
        changed = self.text.replace("Library    Known.py", "Library    Known.py\nLibrary    Other.Other    AS    Other")
        changed = changed.replace("    Api.Check    value=sample", "    Check    value=sample")
        changed = changed.replace("    Api.Select sample Example", "    Select sample Example")
        self.workspace.open(self.suite.as_uri(), changed, 1)
        for token in ("    Check    value=sample", "Select sample Example"):
            with self.subTest(ambiguous=token):
                self.assertEqual(len(self.parity(self.position(token, text=changed))), 2)

    def test_indirect_arguments_variables_and_variable_keyword_cells_keep_full_catalog(self):
        queries = [(self.position("Api.Target Step", 2), "indirect"),
                   (self.position("${SUITE_VALUE}", 1), "variable"),
                   (self.position("Api.Select ${SUITE_VALUE} Example"), "variable-keyword")]
        for position, label in queries:
            with self.subTest(kind=label):
                expected = self.full_definition(position)
                with mock.patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graph:
                    self.assertEqual(self.workspace.definition(self.suite.as_uri(), position), expected)
                self.assertTrue(graph.called)
                self.assertIsNone(graph.call_args.kwargs.get("targets"), "Non-direct calls need full import context")
        with mock.patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graph:
            self.workspace.definition(self.suite.as_uri(), self.position("Api.Target Step"))
        self.assertIsNotNone(graph.call_args.kwargs.get("targets"))
        for version, name in enumerate(("x" * 4097, ".".join(["part"] * 33)), 2):
            with self.subTest(unusual_name=name[:40]):
                text = "*** Test Cases ***\nExample\n    " + name + "\n"
                self.workspace.open(self.suite.as_uri(), text, version)
                position = self.position(name, text=text)
                expected = self.full_definition(position)
                with mock.patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graph:
                    self.assertEqual(self.workspace.definition(self.suite.as_uri(), position), expected)
                self.assertIsNone(graph.call_args.kwargs.get("targets"))

    def test_765_custom_methods_only_prove_the_selected_declaration_cold_and_warm(self):
        imports = []
        for index in range(45):
            module = f"Library{index:03}"
            self.write(f"{module}.py", library_text(module, [f"Probe {index:03} {method:02}" for method in range(17)]))
            imports.append(f"Library    {module}.{module}    AS    Alias{index:03}\n")
        text = "*** Settings ***\n" + "".join(imports) + "*** Test Cases ***\nExample\n    Alias023.Probe 023 08    value=sample\n"
        self.workspace.open(self.suite.as_uri(), text, 1)
        position = self.position("Alias023.Probe 023 08", text=text)
        expected = self.full_definition(position)
        self.assertEqual(len(expected), 1)
        self.assertEqual(expected[0]["uri"], (self.root / "Library023.py").as_uri())
        for phase in ("cold", "warm"):
            with self.subTest(phase=phase):
                with mock.patch.object(source_declarations, "_literal_name", wraps=source_declarations._literal_name) as literal:
                    self.assertEqual(self.workspace.definition(self.suite.as_uri(), position), expected)
                self.assertGreater(literal.call_count, 0, "The chosen factory must still be proved in this request")
                self.assertLessEqual(literal.call_count, 12,
                                     "Unrelated custom methods must not each repeat declaration factory resolution")

    def test_factory_parameter_index_changes_with_unchanged_library_are_fresh(self):
        source = library_text("Library", ["First Name"]).replace(
            "@keyword('First Name', extra_flag=True)", "@keyword('First Name', 'Second Name', extra_flag=True)")
        self.library.write_text(source, encoding="utf-8")
        old_metadata = METADATA.replace("name=None, tags=()", "name=None, alternative=None, tags=()")
        new_metadata = METADATA.replace("name=None, tags=()", "alternative=None, name=None, tags=()")
        metadata = self.root / "ExampleProject/metadata.py"
        metadata.write_text(old_metadata, encoding="utf-8")
        text = self.text.replace("Api.Target Step", "Api.First Name") + "\n"
        text = text.replace("    Local Step\n", "    Api.Second Name    value=sample\n")
        self.workspace.open(self.suite.as_uri(), text, 1)
        first = self.position("Api.First Name", text=text)
        second = self.position("Api.Second Name", text=text)
        initial, = self.parity(first)
        self.assertEqual(self.parity(second), [])
        before = metadata.stat()
        self.assertEqual(len(old_metadata.encode("utf-8")), len(new_metadata.encode("utf-8")))
        metadata.write_text(new_metadata, encoding="utf-8")
        os.utime(metadata, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.library.read_text(encoding="utf-8"), source)
        self.assertEqual(self.parity(first), [])
        self.assertEqual(self.parity(second), [initial])
        self.workspace.open(metadata.as_uri(), old_metadata, 1)
        self.assertEqual(self.parity(first), [initial])
        self.assertEqual(self.parity(second), [])
        self.workspace.close(metadata.as_uri())
        self.assertEqual(self.parity(second), [initial])

    def test_target_results_follow_exact_text_overlay_delete_and_pythonpath_changes(self):
        position = self.position("Api.Target Step")
        first, = self.parity(position)
        before = self.library.stat()
        changed = self.library_source.replace("'Target Step'", "'Absent Step'", 1)
        self.assertEqual(len(changed.encode("utf-8")), before.st_size)
        self.library.write_text(changed, encoding="utf-8")
        os.utime(self.library, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.parity(position), [])
        self.workspace.open(self.library.as_uri(), "\n" + self.library_source, 1)
        overlay, = self.parity(position)
        self.assertEqual(overlay["range"]["start"]["line"], first["range"]["start"]["line"] + 1)
        self.workspace.close(self.library.as_uri())
        self.assertEqual(self.parity(position), [])
        self.library.unlink()
        self.assertEqual(self.parity(position), [])
        self.library.write_text(self.library_source, encoding="utf-8")
        self.assertEqual(self.parity(position), [first])
        for index in (1, 2):
            path = self.write(f"runtime-{index}/Library.py", "\n" * index + self.library_source)
            self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                "robotArguments": ["--pythonpath", str(path.parent)]})
            found, = self.parity(position)
            self.assertEqual(found["uri"], path.as_uri())

    def test_full_hover_signature_and_keyword_catalog_stay_rich_after_targeted_definition(self):
        position = self.position("Api.Target Step")
        selected, = self.parity(position)
        with mock.patch.object(self.workspace, "graph", wraps=self.workspace.graph) as graph:
            with self.workspace.source_snapshot():
                hover = features.hover(self.workspace, self.suite.as_uri(), position, features.Markup([]))
                signature = features.signature_help(self.workspace, self.suite.as_uri(),
                    self.position("value=sample"), features.Markup([]))
                keywords = explorer.document_keywords(self.workspace, self.suite.as_uri())
        self.assertTrue(all(call.kwargs.get("targets") is None for call in graph.call_args_list))
        self.assertIn("Documentation for Target Step", hover["contents"]["value"])
        self.assertIn("count", signature["signatures"][0]["label"])
        own = [keyword for group in keywords["imports"] if group["namespace"] == "Api" for keyword in group["keywords"]]
        self.assertEqual({keyword["name"] for keyword in own}, set(NAMES) - {"Duplicate Step"})
        target, = [keyword for keyword in own if keyword["name"] == "Target Step"]
        self.assertTrue(target["signature"])
        self.assertEqual(target["sourceKind"], "declaration")
        self.assertEqual(target["location"], selected)


if __name__ == "__main__":
    unittest.main()

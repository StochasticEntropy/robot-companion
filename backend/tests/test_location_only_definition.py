"""Location-only navigation preserves full-graph identities without argument work."""

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from robot.running.arguments import UserKeywordArgumentParser
from robot_companion_backend import explorer, features, project
from robot_companion_backend import workspace as workspace_module
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import API, HELPER, METADATA, WRAPPERS, NAME


METHOD = ("    @keyword('Build Item')\n"
          "    def build_item(self, value: str, count: int = 1) -> dict[str, list[int]]:\n"
          "        \"\"\"Build the selected synthetic item.\"\"\"\n"
          "        return {}\n\n")
OTHER = ("    @keyword('Shared Step')\n"
         "    def shared_step(self, value: str) -> str:\n"
         "        return value\n\n")
PREFIX = ("from robot.api.deco import keyword\n"
          "raise RuntimeError('Native inspection must not import this library')\n\n"
          "class Library:\n")
LIBRARY = PREFIX + METHOD + OTHER + (
    "    @keyword('Select ${item} Example')\n"
    "    def embedded(self, item: str) -> str:\n        return item\n")
SUITE = ("*** Settings ***\nResource    steps.resource\n"
         "Library    Library.Library    AS    Api\nLibrary    Other.py    AS    Other\n"
         "*** Variables ***\n${SUITE_VALUE}    suite\n"
         "*** Test Cases ***\nExample\n"
         "    Api.Build Item    value=sample    count=2\n"
         "    Resource Step    sample\n    Local Step    sample\n"
         "    Run Keyword    Resource Step    sample\n"
         "    ${result}=    Api.Build Item    value=sample\n"
         "    Log    ${SUITE_VALUE}\n    Log    ${RESOURCE_VALUE}\n    Log    ${result}\n"
         "    Api.Select sample Example\n    Shared Step    sample\n"
         "*** Keywords ***\nLocal Step\n    [Arguments]    ${value}\n    Log    ${value}\n")


class LocationOnlyDefinitionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native-locations-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.library = self.write("Library.py", LIBRARY)
        self.resource = self.write("steps.resource", "*** Variables ***\n${RESOURCE_VALUE}    resource\n"
            "*** Keywords ***\nResource Step\n    [Arguments]    ${value: str}\n    Log    ${value}\n")
        self.write("Other.py", "from robot.api.deco import keyword\n@keyword('Shared Step')\n"
                   "def other(value: str):\n    return value\n")
        self.suite = self.write("suite.robot", SUITE)
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

    def position(self, text, token, occurrence=0):
        lines = [(number, line) for number, line in enumerate(text.splitlines()) if token in line]
        number, line = lines[occurrence]
        return {"line": number, "character": line.index(token) + max(0, len(token) // 2)}

    def full_definition(self, position):
        oracle = self.fresh()
        oracle.config = self.workspace.config
        for path, (version, text) in self.workspace.documents.items():
            oracle.open(path.as_uri(), text, version)
        full_graph = oracle.graph
        # Use the real definition implementation with a separately fresh full graph.
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

    def test_cold_and_warm_locations_match_full_graph_without_python_or_robot_argument_work(self):
        positions = [self.position(SUITE, token, occurrence) for token, occurrence in (
            ("Api.Build Item", 0), ("Resource Step", 0), ("Local Step", 0),
            ("Run Keyword", 0), ("Resource Step", 1), ("${SUITE_VALUE}", 1),
            ("${RESOURCE_VALUE}", 0), ("${result}", 1), ("Api.Select sample Example", 0),
            ("${value}", 1))]
        expected = [self.full_definition(position) for position in positions]
        self.assertTrue(all(expected), "Each parity case must actually resolve a source location")
        parse_origins = []
        original_parse = UserKeywordArgumentParser.parse
        def observed_parse(parser, *args, **kwargs):
            parse_origins.append(sys._getframe(1).f_code.co_name)
            return original_parse(parser, *args, **kwargs)
        with mock.patch.object(workspace_module, "python_arguments", wraps=workspace_module.python_arguments) as python_args:
            with mock.patch.object(workspace_module, "clone_arguments", wraps=workspace_module.clone_arguments) as clones:
                with mock.patch.object(UserKeywordArgumentParser, "parse", new=observed_parse):
                    cold_validations = None
                    for attempt in range(2):
                        for position, locations in zip(positions, expected):
                            self.assertEqual(self.workspace.definition(self.suite.as_uri(), position), locations)
                        # RF validates [Arguments] when first parsing the Robot AST.
                        # This necessary validation must remain, while symbol construction skips specs.
                        validations = sum(origin != "keyword_symbol" for origin in parse_origins)
                        if attempt == 0:
                            cold_validations = validations
                        else:
                            self.assertEqual(validations, cold_validations, "Warm F12 must reuse validated Robot syntax")
                self.assertEqual(parse_origins.count("keyword_symbol"), 0,
                                 "F12 symbol construction must not rebuild Robot argument specs")
            self.assertEqual(clones.call_count, 0, "F12 must not clone Python argument/type graphs")
        self.assertEqual(python_args.call_count, 0, "F12 must not construct Python argument specs")

    def test_full_hover_documentation_and_signature_remain_rich_after_location_only_lookup(self):
        position = self.position(SUITE, "Api.Build Item")
        location, = self.parity(position)
        self.assertEqual(location["uri"], self.library.as_uri())
        with self.workspace.source_snapshot():
            hover = features.hover(self.workspace, self.suite.as_uri(), position, features.Markup([]))
            signature = features.signature_help(self.workspace, self.suite.as_uri(),
                self.position(SUITE, "value=sample"), features.Markup([]))
            keywords = explorer.document_keywords(self.workspace, self.suite.as_uri())
        self.assertIn("Build the selected synthetic item", hover["contents"]["value"])
        label = signature["signatures"][0]["label"]
        self.assertIn("value", label)
        self.assertIn("count", label)
        selected = [keyword for group in keywords["imports"] for keyword in group["keywords"]
                    if keyword["name"] == "Build Item"]
        keyword, = selected
        self.assertEqual(keyword["namespace"], "Api")
        self.assertIn("dict", keyword["returnType"])
        self.assertTrue(keyword["signature"])
        self.assertEqual(self.workspace.definition(self.suite.as_uri(), position), [location])

    def test_alias_ambiguity_and_missing_import_never_choose_an_unrelated_same_name(self):
        ambiguous = self.parity(self.position(SUITE, "Shared Step"))
        self.assertEqual(len(ambiguous), 2)
        self.assertEqual({item["uri"] for item in ambiguous}, {self.library.as_uri(), (self.root / "Other.py").as_uri()})
        changed = SUITE.replace("    Shared Step    sample", "    Api.Shared Step    sample")
        self.workspace.open(self.suite.as_uri(), changed, 1)
        selected = self.parity(self.position(changed, "Api.Shared Step"))
        self.assertEqual([item["uri"] for item in selected], [self.library.as_uri()])
        missing = changed.replace("Library    Library.Library", "Library    Missing.Missing")
        self.workspace.open(self.suite.as_uri(), missing, 2)
        self.assertEqual(self.parity(self.position(missing, "Api.Shared Step")), [])

    def test_location_facts_follow_same_size_mtime_edits_overlays_deletion_and_search_path_changes(self):
        position = self.position(SUITE, "Api.Build Item")
        first, = self.parity(position)
        before = self.library.stat()
        changed = PREFIX + OTHER + METHOD + LIBRARY[len(PREFIX + METHOD + OTHER):]
        self.assertEqual(len(changed.encode("utf-8")), before.st_size)
        self.library.write_text(changed, encoding="utf-8")
        os.utime(self.library, ns=(before.st_atime_ns, before.st_mtime_ns))
        moved, = self.parity(position)
        self.assertNotEqual(moved["range"]["start"]["line"], first["range"]["start"]["line"])
        self.workspace.open(self.library.as_uri(), "\n" + LIBRARY, 1)
        overlay, = self.parity(position)
        self.assertEqual(overlay["range"]["start"]["line"], first["range"]["start"]["line"] + 1)
        self.workspace.close(self.library.as_uri())
        self.assertEqual(self.parity(position), [moved])
        self.library.unlink()
        self.assertEqual(self.parity(position), [])
        self.library.write_text(LIBRARY, encoding="utf-8")
        self.assertEqual(self.parity(position), [first])
        for number in (1, 2):
            path = self.write(f"runtime-{number}/Library.py", "\n" * number + LIBRARY)
            self.workspace.config = project.parse({"version": 1, "cwd": str(self.root),
                "robotArguments": ["--pythonpath", str(path.parent)]})
            found, = self.parity(position)
            self.assertEqual(found["uri"], path.as_uri())
            self.assertEqual(found["range"]["start"]["line"], first["range"]["start"]["line"] + number)

    def test_custom_declaration_identity_and_helper_invalidation_match_full_metadata_graph(self):
        for name, text in {"__init__.py": "", "helpers.py": HELPER, "metadata.py": METADATA,
                           "wrappers.py": WRAPPERS, "base.py": "class Parent:\n    pass\n", "api.py": API}.items():
            self.write(f"ExampleProject/{name}", text)
        text = ("*** Settings ***\nLibrary    ExampleProject.api.Api    AS    Api\n*** Test Cases ***\n"
                f"Example\n    Api.{NAME}    partner=sample\n")
        self.workspace.open(self.suite.as_uri(), text, 1)
        position = self.position(text, NAME)
        found, = self.parity(position)
        self.assertEqual(found["sourceKind"], "declaration")
        self.assertEqual(found["uri"], (self.root / "ExampleProject/api.py").as_uri())
        helper = self.root / "ExampleProject/helpers.py"
        self.workspace.open(helper.as_uri(), HELPER.replace("return metadata.keyword", "return unsupported.keyword"), 1)
        self.assertEqual(self.parity(position), [])
        self.workspace.close(helper.as_uri())
        self.assertEqual(self.parity(position), [found])
        hover = features.hover(self.workspace, self.suite.as_uri(), position, features.Markup([]))
        self.assertIn("Source declaration", hover["contents"]["value"])


if __name__ == "__main__":
    unittest.main()

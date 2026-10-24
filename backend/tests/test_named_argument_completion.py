"""Named-argument edits use the resolved RF signature and the real completion wire."""

import os
from pathlib import Path
import tempfile
import unittest

from client import Client
from robot_companion_backend import features, project
from robot_companion_backend.workspace import Workspace
from test_lsp_source_declarations_live import HELPER, METADATA, WRAPPERS


LIBRARY = ("from robot.api.deco import keyword\n"
           "raise RuntimeError('Language queries must not execute fixture libraries')\n\n"
           "@keyword('Configure')\n"
           "def configure(first: str, second: str = 'fallback', *, mode: str = 'safe') -> str:\n"
           "    \"\"\"Configure the selected synthetic example.\"\"\"\n    return first\n\n"
           "@keyword('Mixed')\n"
           "def mixed(fixed, /, value, *rest, flag: bool = False, **extras):\n    return value\n\n")
DECLARATION = ("from ExampleProject.base import Parent\n"
               "from ExampleProject.helpers import keyword\n"
               "from ExampleProject.wrappers import preserve, observed\n\n"
               "class Api(Parent):\n"
               "    @keyword('Declared Configure', extra_flag=True)\n    @observed\n    @preserve\n"
               "    def configure(self, partner: str, count: int = 1, *, mode: str = 'safe') -> str:\n"
               "        \"\"\"Submit the synthetic example request.\"\"\"\n        return partner\n")
LOCAL = ("*** Keywords ***\nLocal Configure\n"
         "    [Arguments]    ${first}    ${second}=fallback    @{rest}    ${mode}=safe    &{extras}\n"
         "    No Operation\n")


def units(text):
    return len(text.encode("utf-16-le")) // 2


class NamedArgumentCompletionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb named arguments-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.library = self.write("Arguments.py", LIBRARY)
        for name, text in {"__init__.py": "", "helpers.py": HELPER, "metadata.py": METADATA,
                           "wrappers.py": WRAPPERS, "base.py": "class Parent:\n    pass\n",
                           "api.py": DECLARATION}.items():
            self.write(f"ExampleProject/{name}", text)
        self.suite = self.write("example.robot", "*** Test Cases ***\nExample\n    No Operation\n")
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        self.version = 0
        self.client = None

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def finish_client(self):
        try:
            self.assertIsNone(self.client.process.poll())
            self.client.request("shutdown")
            self.client.send("exit")
            self.assertEqual(self.client.process.wait(timeout=5), 0)
        finally:
            self.client.close()
            self.assertFalse(self.client.forced_cleanup)

    def prepare(self, marked, *, keywords="", settings=""):
        prefix = "*** Settings ***\nLibrary    Arguments.py\n" + settings + "*** Test Cases ***\nExample\n"
        text = prefix + marked + "\n" + keywords
        before, after = text.split("<cursor>")
        position = {"line": before.count("\n"), "character": units(before.rsplit("\n", 1)[-1])}
        self.text = before + after
        self.version += 1
        self.workspace.open(self.suite.as_uri(), self.text, self.version)
        self.position = position
        return position

    def complete(self, marked, *, wire=False, keywords="", settings=""):
        position = self.prepare(marked, keywords=keywords, settings=settings)
        with self.workspace.source_snapshot():
            direct = features.completion(self.workspace, self.suite.as_uri(), position)
        if wire:
            if self.client is None:
                self.client = Client(cwd=self.root)
                self.addCleanup(self.finish_client)
                self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {},
                    "initializationOptions": {"robotConfiguration": {
                        "version": 1, "cwd": str(self.root), "robotArguments": []}}})
                self.client.send("initialized", {})
            self.client.send("textDocument/didOpen", {"textDocument": {"uri": self.suite.as_uri(),
                "languageId": "robotframework", "version": self.version, "text": self.text}})
            result = self.client.request("textDocument/completion", {
                "textDocument": {"uri": self.suite.as_uri()}, "position": position})
            self.assertEqual(result, direct)
        return {item["label"]: item for item in direct["items"]}

    def edited(self, item):
        edit = item["textEdit"]
        lines = self.text.splitlines(keepends=True)
        start, end = edit["range"]["start"], edit["range"]["end"]
        self.assertEqual(start["line"], end["line"])
        line = lines[start["line"]]
        encoded = line.encode("utf-16-le")
        lines[start["line"]] = (encoded[:2 * start["character"]].decode("utf-16-le") + edit["newText"]
                                + encoded[2 * end["character"]:].decode("utf-16-le"))
        return "".join(lines)

    def test_wire_initial_new_and_partial_argument_cells_insert_plain_named_arguments(self):
        for marked in ("    Configure    <cursor>", "    Configure    first=one    <cursor>",
                       "    Configure    one    <cursor>", "    Configure    one    mo<cursor>"):
            with self.subTest(marked=marked):
                items = self.complete(marked, wire=True)
                expected = {"first=", "second=", "mode="} if "first=one" not in marked and "    one" not in marked \
                    else {"second=", "mode="}
                self.assertTrue(expected.issuperset(items))
                self.assertIn("mode=", items)
                if marked.endswith("    <cursor>"):
                    self.assertEqual(set(items), expected)
                item = items["mode="]
                self.assertEqual(item["insertTextFormat"], 1)
                self.assertIn("mode=", self.edited(item))
                self.assertNotIn("<cursor>", self.edited(item))
                self.assertNotIn("first=", items if "    one" in marked or "first=one" in marked else {})
        builtin = self.complete("    Log    <cursor>", wire=True)
        self.assertIn("message=", builtin)
        self.assertNotIn("message=", self.complete("    Log    hello    <cursor>", wire=True))

    def test_supplied_positional_and_named_parameters_are_excluded_using_rf_case_sensitive_names(self):
        cases = (("    Configure    one    two    <cursor>", {"mode="}),
                 ("    Configure    second=two    <cursor>", {"first=", "mode="}),
                 ("    Configure    mode=safe    first=one    <cursor>", {"second="}),
                 ("    Configure    First=one    <cursor>", {"second=", "mode="}),
                 ("    Configure    ${value}    <cursor>", {"second=", "mode="}),
                 ("    Configure    unknown=value    <cursor>", {"second=", "mode="}),
                 ("    Configure    <cursor>    mode=safe", {"first=", "second="}),
                 ("    Configure    <cursor>    later", set()),
                 ("    Configure    se<cursor>cond    later", set()),
                 ("    Mixed    fixed    unknown=value    <cursor>", {"value=", "flag="}),
                 ("    Mixed    fixed    Value=one    <cursor>", {"value=", "flag="}),
                 ("    Mixed    fixed    value=one    <cursor>", {"flag="}))
        for marked, expected in cases:
            with self.subTest(marked=marked):
                self.assertEqual(set(self.complete(marked)), expected)
        self.assertEqual(self.complete("    Mixed    <cursor>"), {})
        for marked in ("    Configure    @{values}    <cursor>", "    Configure    &{options}    <cursor>",
                       "    Configure    <cursor>    @{values}", "    Configure    <cursor>    &{options}",
                       "    Configure    one    ${name}=value    <cursor>"):
            with self.subTest(unknown_binding=marked):
                self.assertEqual(self.complete(marked), {})
        items = self.complete("    Mixed    fixed    <cursor>")
        self.assertEqual(set(items), {"value=", "flag="})
        for excluded in ("fixed=", "rest=", "extras=", "*rest", "**extras"):
            self.assertNotIn(excluded, items)

        self.assertFalse(any(label.endswith("=") for label in self.complete("    Configure <cursor>")))
        for separator in ("  ", "\t"):
            with self.subTest(separator=repr(separator)):
                self.assertEqual(set(self.complete("    Configure" + separator + "<cursor>", wire=True)),
                                 {"first=", "second=", "mode="})

    def test_wire_continuation_and_pipe_cells_share_the_same_signature(self):
        for marked in ("    Configure    one\n    ...    <cursor>",
                       "    Configure    one\n    ...    mo<cursor>",
                       "| | Configure | one | <cursor> |", "| | Configure | one |\n| | ... | <cursor> |"):
            with self.subTest(marked=marked):
                items = self.complete(marked, wire=True)
                self.assertIn("mode=", items)
                self.assertNotIn("first=", items)
                if "mo<cursor>" not in marked:
                    self.assertEqual(set(items), {"second=", "mode="})
                self.assertIn("mode=", self.edited(items["mode="]))
        self.assertNotIn("first=", self.complete("| | Configure | | fi<cursor>rst |", wire=True))
        self.assertIn("mode=", self.complete("| | Configure | | mo<cursor> |", wire=True))
        self.assertIn("mode=", self.complete("| | Configure | mo<cursor> | |", wire=True))
        self.assertEqual(self.complete("| | Configure | mo<cursor> | | first=one |", wire=True), {})
        with self.workspace.source_snapshot():
            model = self.workspace.model(self.suite)
            calls = [node for node, _ in self.workspace.walk(model) if type(node).__name__ == "KeywordCall"]
            self.assertTrue(any(token.type == "ARGUMENT" and token.value == ""
                                for call in calls for token in call.tokens))

    def test_name_edits_preserve_existing_value_suffix_and_use_utf16_wire_ranges(self):
        items = self.complete("    Configure    😀    se<cursor>cond=kept", wire=True)
        item = items["second="]
        self.assertIn("    Configure    😀    second=kept\n", self.edited(item))
        self.assertEqual(item["textEdit"]["range"]["start"]["character"], units("    Configure    😀    "))
        items = self.complete("    Configure    mo<cursor>de=fast", wire=True)
        self.assertIn("    Configure    mode=fast\n", self.edited(items["mode="]))
        self.assertEqual(self.complete("    Configure    mode=fa<cursor>st", wire=True), {})

    def test_values_strings_comments_imports_headers_and_ambiguous_calls_have_no_argument_names(self):
        for marked in ("    Configure    'str<cursor>ing'", "    Configure    \"str<cursor>ing\"",
                       "    Configure    path/to/<cursor>value", "    Configure    mode=<cursor>safe",
                       "    Configure    mo<cursor>unt/path", "    Configure    mo<cursor>unt",
                       r"    Configure    mo<cursor>de\=literal",
                       "    Configure    mo<cursor>${suffix}=literal",
                       "    Configure    mo<cursor>%{suffix}=literal",
                       "    Configure    # co<cursor>mment", "    Configure    first=one    # <cursor>"):
            with self.subTest(marked=marked):
                self.assertEqual(self.complete(marked), {})
        for marked in ("    Run Keyword If    con<cursor>", "    Repeat Keyword    rep<cursor>",
                       "    Wait Until Keyword Succeeds    ret<cursor>"):
            with self.subTest(runtime_forwarding=marked):
                self.assertEqual(self.complete(marked, wire=True), {})
        self.assertIn("Configure", self.complete("    Run Keyword    Config<cursor>", wire=True))
        self.write("Shadow.py", "from robot.api.deco import keyword\n"
                   "@keyword('Run Keyword If')\n"
                   "def ordinary(condition, action='safe'):\n    return condition\n")
        shadow = self.complete("    Run Keyword If    con<cursor>", wire=True,
                               settings="Library    Shadow.py\n")
        self.assertIn("condition=", shadow)
        self.write("Other.py", LIBRARY)
        self.assertEqual(self.complete("    Configure    <cursor>", settings="Library    Other.py\n"), {})
        for source in ("*** Settings ***\nLibrary    Arg<cursor>uments.py\n",
                       "*** Test Cases ***\nExa<cursor>mple\n", "*** Key<cursor>words ***\n"):
            before, after = source.split("<cursor>")
            text = before + after
            self.version += 1
            self.workspace.open(self.suite.as_uri(), text, self.version)
            position = {"line": before.count("\n"), "character": units(before.rsplit("\n", 1)[-1])}
            with self.workspace.source_snapshot():
                self.assertEqual(features.completion(self.workspace, self.suite.as_uri(), position)["items"], [])

    def test_robot_arguments_and_source_declaration_metadata_are_read_without_execution(self):
        self.assertEqual(set(self.complete("    Local Configure    one    <cursor>", keywords=LOCAL)),
                         {"second=", "mode="})
        settings = "Library    ExampleProject.api.Api    AS    Api\n"
        items = self.complete("    Api.Declared Configure    <cursor>", wire=True, settings=settings)
        self.assertEqual(set(items), {"partner=", "count=", "mode="})
        count = items["count="]
        self.assertIn("int", count["detail"])
        self.assertIn("1", count["detail"])
        documentation = count["documentation"]["value"]
        self.assertIn("Submit the synthetic example request", documentation)
        self.assertIn("Declared parameters", documentation)
        self.assertIn("runtime", documentation)
        self.assertIn("str", items["mode="]["detail"])
        self.assertIn("safe", items["mode="]["detail"])

    def test_external_exact_text_and_overlay_changes_refresh_signature_and_import_identity(self):
        marked = "    Configure    <cursor>"
        self.assertIn("first=", self.complete(marked, wire=True))
        stat = self.library.stat()
        changed = LIBRARY.replace("first: str", "other: str").replace("return first", "return other")
        self.assertEqual(len(changed), len(LIBRARY))
        self.library.write_text(changed, encoding="utf-8")
        os.utime(self.library, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        items = self.complete(marked, wire=True)
        self.assertIn("other=", items)
        self.assertNotIn("first=", items)
        self.workspace.open(self.library.as_uri(), LIBRARY, 1)
        self.assertIn("first=", self.complete(marked))
        self.workspace.close(self.library.as_uri())
        self.assertIn("other=", self.complete(marked))
        self.library.unlink()
        self.assertEqual(self.complete(marked), {})
        self.library.write_text(LIBRARY, encoding="utf-8")
        self.assertIn("first=", self.complete(marked))
        self.write("Other.py", LIBRARY.replace("first: str", "third: str").replace("return first", "return third"))
        items = self.complete("    Unique.Configure    <cursor>", settings="Library    Other.py    AS    Unique\n")
        self.assertIn("third=", items)
        self.assertNotIn("first=", items)


if __name__ == "__main__":
    unittest.main()

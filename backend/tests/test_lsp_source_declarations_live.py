"""Source declaration parity for literal keyword names behind custom decorators.

The source marker distinguishes declared documentation and arguments from a
verified runtime signature. Workspace code is executed only by explicit Robot
baseline steps, never by a language query.
"""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from client import Client, uri_file
from robot_companion_backend import diagnostics, project, source_declarations
from robot_companion_backend.workspace import Workspace

NAME = "Submit Example Request"
DOC = "Submit the selected synthetic request."
HELPER = ("from ExampleProject import metadata\n\n"
          "def keyword(*args, extra_flag=True, **kwargs):\n"
          "    return metadata.keyword(*args, **kwargs, extra_flag=extra_flag)\n")
METADATA = ("from robot.api.deco import keyword as robot_keyword\nfrom functools import wraps\n\n"
            "def keyword(name=None, tags=(), types=(), extra_flag=False):\n"
            "    def decorate(function):\n"
            "        @robot_keyword(name, tags, types)\n"
            "        @wraps(function)\n"
            "        def wrapped(*args, **kwargs):\n"
            "            return function(*args, **kwargs)\n"
            "        return wrapped\n"
            "    return decorate\n")
WRAPPERS = ("from functools import wraps\n\n"
            "def preserve(function):\n"
            "    @wraps(function)\n"
            "    def wrapped(*args, **kwargs):\n"
            "        return function(*args, **kwargs)\n"
            "    return wrapped\n\n"
            "def observed(function):\n"
            "    @wraps(function)\n"
            "    def wrapped(*args, **kwargs):\n"
            "        return function(*args, **kwargs)\n"
            "    return wrapped\n")
API = ("from ExampleProject.base import Parent\nfrom ExampleProject.helpers import keyword\n"
       "from ExampleProject.wrappers import observed, preserve\nfrom pathlib import Path\n\n"
       "class Api(Parent):\n"
       f"    @keyword({NAME!r}, extra_flag=True)\n"
       "    @observed\n    @preserve\n"
       "    def submit_request(self, partner: str, count: int = 1, *, mode: str = 'safe') -> str:\n"
       f"        \"\"\"{DOC}\"\"\"\n"
       "        Path('keyword-executed.txt').write_text(partner, encoding='utf-8')\n"
       "        return partner\n")
SHADOW = ("from robot.api.deco import keyword\n\n"
          f"@keyword({NAME!r})\n"
          "def shadow(unrelated):\n"
          "    \"\"\"An unimported same-name keyword must not supply documentation.\"\"\"\n"
          "    return unrelated\n")


class SourceDeclarationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb declarations-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.write({"ExampleProject/__init__.py": "", "ExampleProject/helpers.py": HELPER,
                    "ExampleProject/metadata.py": METADATA, "ExampleProject/wrappers.py": WRAPPERS,
                    "ExampleProject/base.py": "class Parent:\n    def parent_only(self):\n        return None\n",
                    "ExampleProject/api.py": API, "UnimportedShadow.py": SHADOW,
                    "ExampleProject/keywords.resource": "*** Settings ***\nLibrary    ExampleProject.api.Api    AS    ExampleApi\n"})
        self.suite = self.root / "ExampleProject/tests/smoke/Selected.robot"
        self.text = ("*** Settings ***\nResource    ExampleProject/keywords.resource\n*** Test Cases ***\n"
                     f"Selected\n    ExampleApi.{NAME}    partner=sample    count=2    mode=safe\n")
        self.write({str(self.suite.relative_to(self.root)): self.text})
        self.client = Client(cwd=self.root)
        self.addCleanup(self.finish)
        self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {},
            "initializationOptions": {"robotConfiguration": {
                "version": 1, "cwd": str(self.root), "robotArguments": []}}})
        self.client.send("initialized", {})
        self.client.send("textDocument/didOpen", {"textDocument": {
            "uri": self.suite.as_uri(), "version": 1, "text": self.text}})

    def finish(self):
        try:
            self.assertIsNone(self.client.process.poll(), "Backend exited before orderly shutdown")
            self.client.request("shutdown")
            self.client.send("exit")
            self.assertEqual(self.client.process.wait(timeout=5), 0)
        finally:
            self.client.close()
        self.assertFalse(self.client.forced_cleanup)

    def write(self, files):
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def query(self, method, character=8, **extra):
        return self.client.request(method, {"textDocument": {"uri": self.suite.as_uri()},
            "position": {"line": 4, "character": character}, **extra})

    def definition(self):
        return self.query("textDocument/definition")

    def keywords(self):
        return self.client.request("robotCompanion/documentKeywords", {
            "textDocument": {"uri": self.suite.as_uri()}})

    def baseline(self):
        run = subprocess.run([sys.executable, "-m", "robot", "--output", "NONE", "--log", "NONE",
                              "--report", "NONE", str(self.suite)], cwd=self.root, capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=30)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual((self.root / "keyword-executed.txt").read_text(encoding="utf-8"), "sample")

    def assert_declaration(self, text=API):
        found = self.definition()
        self.assertEqual(len(found), 1, found)
        self.assertEqual(uri_file(found[0]["uri"]), self.root / "ExampleProject/api.py")
        line = next(index for index, value in enumerate(text.splitlines()) if "def submit_request(" in value)
        self.assertEqual(found[0]["range"]["start"], {"line": line, "character": 8})
        self.assertEqual(found[0]["sourceKind"], "declaration")
        self.assertFalse((self.root / "keyword-executed.txt").exists(), "Native inspection executed a keyword")
        return found[0]

    def test_custom_forwarding_factory_external_parent_and_wrappers_preserve_declared_source(self):
        self.assert_declaration()
        hover = self.query("textDocument/hover")
        self.assertIsNotNone(hover)
        value = hover["contents"]["value"]
        self.assertIn("Source declaration", value)
        self.assertIn(DOC, value)
        self.assertIn("decorator", value.lower())
        self.assertIn("parameter", value.lower())
        self.assertNotIn("unimported", value.lower())
        signature = self.query("textDocument/signatureHelp", self.text.splitlines()[4].index("partner=") + 10)
        self.assertIsNotNone(signature)
        self.assertEqual(len(signature["signatures"]), 1)
        label = signature["signatures"][0]["label"]
        for name in (NAME, "partner", "count", "mode"):
            self.assertIn(name, label)
        self.assertNotIn("self", label)
        signature_doc = signature["signatures"][0]["documentation"]["value"]
        self.assertIn("Source declaration", signature_doc)
        self.assertIn("decorator", signature_doc.lower())
        self.assertIn("parameter", signature_doc.lower())
        selected = [keyword for group in self.keywords()["imports"] if group["kind"] == "library"
                    for keyword in group["keywords"] if keyword["name"] == NAME]
        self.assertEqual(len(selected), 1, selected)
        keyword = selected[0]
        self.assertEqual(keyword["kind"], "library")
        self.assertEqual(keyword["namespace"], "ExampleApi")
        self.assertEqual(keyword["sourceKind"], "declaration")
        self.assertIs(keyword["runtimeSignatureKnown"], False)
        self.assertEqual(uri_file(keyword["location"]["uri"]), self.root / "ExampleProject/api.py")
        self.assertIn("Submit the selected synthetic request", keyword["documentation"])
        self.assertEqual(keyword["required"], [{"name": "partner", "named": False}])
        self.assertIn("partner", " ".join(keyword["signature"]))
        self.assertEqual(keyword["returnType"], "str")
        self.assertFalse((self.root / "keyword-executed.txt").exists())
        self.baseline()

    def test_source_only_declaration_does_not_allow_rename_edits(self):
        self.assert_declaration()
        with self.assertRaises(AssertionError) as raised:
            self.query("textDocument/rename", newName="Rename Must Not Be Applied")
        message = raised.exception.args[0]["error"]["message"]
        self.assertIn("declaration", message.lower())
        self.assertEqual((self.root / "ExampleProject/api.py").read_text(encoding="utf-8"), API)
        self.assertEqual(self.suite.read_text(encoding="utf-8"), self.text)

    def test_source_only_declaration_does_not_offer_a_runtime_import_edit(self):
        self.write({"ExampleProject/Api.py": API,
                    "Known.py": "from robot.api.deco import keyword\n\n"
                                "@keyword('Known Runtime Keyword')\ndef known():\n    return None\n"})
        (self.root / "UnimportedShadow.py").unlink()
        workspace = Workspace()
        workspace.roots = [self.root]
        workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        candidate = self.root / "ExampleProject/Api.py"
        self.assertTrue(any(symbol.declaration for symbol in workspace.python_symbols(candidate, "Api")))
        self.assertEqual(diagnostics.definers(workspace, self.suite, NAME), [])
        self.assertIsNone(diagnostics.import_statement(workspace, self.suite, NAME))
        self.assertEqual(diagnostics.definers(workspace, self.suite, "Known Runtime Keyword"),
                         [self.root / "Known.py"])
        self.assertFalse((self.root / "keyword-executed.txt").exists())

    def test_computed_keyword_name_is_never_selected_from_global_same_name(self):
        for expression in ("NAME", "'Submit ' + 'Example Request'"):
            with self.subTest(expression=expression):
                changed = API.replace("class Api(Parent):", "NAME = " + repr(NAME) + "\n\nclass Api(Parent):")
                changed = changed.replace("@keyword(" + repr(NAME), "@keyword(" + expression)
                self.write({"ExampleProject/api.py": changed})
                self.assertEqual(self.definition(), [])
                self.assertFalse(any(keyword["name"] == NAME for group in self.keywords()["imports"]
                                     for keyword in group["keywords"]))
        self.baseline()  # RF may resolve computed names; source declaration lookup deliberately does not.

    def test_rebound_factory_and_factory_cycle_have_no_arbitrary_target(self):
        cases = {
            "rebound": HELPER + "\nkeyword = object()\n",
            "fake": "def keyword(*args, **kwargs):\n    return lambda function: function\n",
            "cycle": "from ExampleProject.cycle import keyword\n",
            "mutated_kwargs": HELPER.replace("    return metadata.keyword", "    kwargs['name'] = 'Changed'\n    return metadata.keyword"),
            "mutated_args": HELPER.replace("    return metadata.keyword", "    args = ('Changed',)\n    return metadata.keyword"),
            "module_globals_rebinding": HELPER + "\ndef fake(*args, **kwargs):\n    return lambda function: function\nglobals()['keyword'] = fake\n",
        }
        self.write({"ExampleProject/cycle.py": "from ExampleProject.helpers import keyword\n"})
        for label, helper in cases.items():
            with self.subTest(case=label):
                self.write({"ExampleProject/helpers.py": helper})
                self.assertEqual(self.definition(), [])
                self.assertIsNone(self.query("textDocument/hover"))

    def test_factory_name_transform_does_not_turn_a_literal_call_into_a_guessed_target(self):
        self.write({"ExampleProject/metadata.py": METADATA.replace(
            "@robot_keyword(name, tags, types)", "@robot_keyword(name.upper(), tags, types)")})
        self.assertEqual(self.definition(), [])
        self.assertFalse(any(keyword["name"] == NAME for group in self.keywords()["imports"]
                             for keyword in group["keywords"]))
        self.assertFalse((self.root / "keyword-executed.txt").exists())

    def test_duplicate_own_literal_names_never_select_one_declaration(self):
        duplicate = (API + f"\n    @keyword({NAME!r}, extra_flag=True)\n    @preserve\n"
                     "    def another_request(self, unrelated):\n        return unrelated\n")
        self.write({"ExampleProject/api.py": duplicate})
        found = self.definition()
        self.assertNotEqual(len(found), 1, found)
        self.assertTrue(all(uri_file(item["uri"]) == self.root / "ExampleProject/api.py" for item in found))
        self.assertFalse((self.root / "keyword-executed.txt").exists())

    def test_factory_dependency_edits_and_unsaved_source_change_invalidate_the_declaration(self):
        self.assert_declaration()
        self.write({"ExampleProject/helpers.py": "def keyword(*args, **kwargs):\n    return lambda function: function\n"})
        self.assertEqual(self.definition(), [])
        self.write({"ExampleProject/helpers.py": HELPER})
        self.assert_declaration()
        path = self.root / "ExampleProject/api.py"
        changed = API.replace("    def submit_request(", "\n    def submit_request(")
        self.client.send("textDocument/didOpen", {"textDocument": {
            "uri": path.as_uri(), "version": 1, "text": changed}})
        self.assert_declaration(changed)
        self.client.send("textDocument/didClose", {"textDocument": {"uri": path.as_uri()}})
        self.assert_declaration()
        path.unlink()
        self.assertEqual(self.definition(), [])

    def test_request_local_factory_proof_reused_for_thirty_methods_then_revalidated(self):
        header = API.split("class Api(Parent):", 1)[0] + "class Api(Parent):\n"
        methods = "".join(
            f"    @keyword('Submit Example Request {index}', extra_flag=True)\n"
            "    @observed\n    @preserve\n"
            f"    def submit_request_{index}(self, partner: str):\n"
            "        return partner\n" for index in range(30))
        self.write({"ExampleProject/api.py": header + methods})
        workspace = Workspace()
        workspace.roots = [self.root]
        workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        workspace.open(self.suite.as_uri(), self.text, 1)
        with mock.patch.object(source_declarations, "_factory_uncached", wraps=source_declarations._factory_uncached) as factory:
            first = workspace.graph(self.suite).groups[2]
            self.assertEqual({symbol.name for symbol in first}, {f"Submit Example Request {index}" for index in range(30)})
            self.assertTrue(all(symbol.declaration for symbol in first))
            self.assertEqual(factory.call_count, 2, "One helper and one metadata factory proof per request")
            self.assertEqual(len(workspace.graph(self.suite).groups[2]), 30)
            self.assertEqual(factory.call_count, 4, "A fresh request must revalidate both factory sources")
            self.write({"ExampleProject/helpers.py": "def keyword(*args, **kwargs):\n    return lambda function: function\n"})
            self.assertEqual(workspace.graph(self.suite).groups[2], [])
            self.assertGreater(factory.call_count, 4)
        self.assertFalse((self.root / "keyword-executed.txt").exists())

    def test_class_scope_deletion_and_rebinding_refuse_the_original_method(self):
        changes = {
            "delete": "    del submit_request\n",
            "augment": "    submit_request += object()\n",
            "conditional": "    if True:\n        submit_request = object()\n",
            "loop": "    for submit_request in ():\n        pass\n",
            "try": "    try:\n        submit_request = object()\n    except Exception:\n        pass\n",
        }
        for label, statement in changes.items():
            with self.subTest(case=label):
                self.write({"ExampleProject/api.py": API + "\n" + statement})
                self.assertEqual(self.definition(), [])
                self.assertFalse(any(keyword["name"] == NAME for group in self.keywords()["imports"]
                                     for keyword in group["keywords"]))
        local_changes = API.replace("        return partner\n", "        submit_request = partner\n"
                                    "        self.submit_request = partner\n        return partner\n")
        self.write({"ExampleProject/api.py": local_changes})
        self.assert_declaration(local_changes)
        self.assertFalse((self.root / "keyword-executed.txt").exists())

    def test_native_queries_never_import_factory_or_api_modules(self):
        self.write({"ExampleProject/metadata.py": METADATA +
                    "\nfrom pathlib import Path\nPath('module-executed.txt').write_text('executed', encoding='utf-8')\n"})
        self.definition()
        self.keywords()
        self.assertFalse((self.root / "module-executed.txt").exists())
        self.assertFalse((self.root / "keyword-executed.txt").exists())


if __name__ == "__main__":
    unittest.main()

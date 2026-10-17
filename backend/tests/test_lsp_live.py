"""Mandatory RF conformance. Missing approved prerequisites fail, never skip."""

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from client import Client


class LiveLanguageTests(unittest.TestCase):
    def setUp(self):
        import robot
        self.assertEqual(robot.__version__, "7.5")
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-lsp-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in (Path(__file__).parent / "fixtures").iterdir():
            shutil.copyfile(path, self.root / path.name)
        self.client = Client()
        self.addCleanup(self.finish)
        result = self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
        self.assertEqual(result["capabilities"]["positionEncoding"], "utf-16")
        self.assertTrue(result["capabilities"]["definitionProvider"])
        self.assertNotIn("completionProvider", result["capabilities"])
        self.client.send("initialized", {})
        self.uri = (self.root / "audit.robot").as_uri()
        self.text = (self.root / "audit.robot").read_text()
        self.open(self.uri, self.text)

    def finish(self):
        try:
            if self.client.process.poll() is None:
                self.client.request("shutdown")
                self.client.send("exit")
                self.assertEqual(self.client.process.wait(timeout=5), 0)
        finally:
            self.client.close()
            if directory := os.environ.get("RCB_TRANSCRIPTS"):
                target = Path(directory)
                target.mkdir(parents=True, exist_ok=True)
                (target / (self.id() + ".json")).write_text(json.dumps({
                    "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2))

    def open(self, uri, text, version=1):
        self.client.send("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": "robotframework", "version": version, "text": text}})

    def definition(self, text, needle, uri=None, occurrence=0):
        lines = text.splitlines()
        line = next(i for i, value in enumerate(lines) if needle in value and
                    sum(needle in x for x in lines[:i]) == occurrence)
        column = len(lines[line][:lines[line].index(needle)].encode("utf-16-le")) // 2
        return self.client.request("textDocument/definition", {"textDocument": {"uri": uri or self.uri},
                                                               "position": {"line": line, "character": column}})

    def test_audit_definitions_never_choose_unimported_shadow(self):
        for name, file, line in (("Build Record", "AuditLibrary.py", 11),
                                 ("Resource Step", "shared.resource", 1),
                                 ("Local Step", "audit.robot", 17)):
            with self.subTest(name=name):
                results = self.definition(self.text, name)
                self.assertEqual(len(results), 1)
                self.assertEqual(Path(results[0]["uri"]).name, file)
                self.assertEqual(results[0]["range"]["start"]["line"], line)

    def test_alias_and_ambiguity_are_explicit(self):
        (self.root / "Other.py").write_text('from robot.api.deco import keyword\n@keyword("Build Record")\ndef other(): pass\n')
        text = ("*** Settings ***\nLibrary    AuditLibrary.py    WITH NAME    Main\n"
                "Library    Other.py    WITH NAME    Other\n*** Test Cases ***\nT\n"
                "    Build Record\n    Main.Build Record\n    Other.Build Record\n")
        self.open(self.uri, text, 2)
        ambiguous = self.definition(text, "Build Record", occurrence=0)
        self.assertEqual({Path(x["uri"]).name for x in ambiguous}, {"AuditLibrary.py", "Other.py"})
        self.assertEqual(Path(self.definition(text, "Main.Build Record")[0]["uri"]).name, "AuditLibrary.py")
        self.assertEqual(Path(self.definition(text, "Other.Build Record")[0]["uri"]).name, "Other.py")
        self.assertTrue(any(d.get("code") == "ambiguity" for n in self.client.notifications
                            for d in n.get("params", {}).get("diagnostics", [])))

    def test_overlay_version_and_dependency_invalidation(self):
        resource = self.root / "shared.resource"
        changed = "*** Keywords ***\n\nResource Step\n    Log    changed\n"
        self.open(resource.as_uri(), changed)
        self.assertEqual(self.definition(self.text, "Resource Step")[0]["range"]["start"]["line"], 2)
        self.client.send("textDocument/didChange", {"textDocument": {"uri": resource.as_uri(), "version": 2},
                                                   "contentChanges": [{"text": changed.replace("Resource Step", "Renamed")} ]})
        self.assertEqual(self.definition(self.text, "Resource Step"), [])
        self.client.send("textDocument/didClose", {"textDocument": {"uri": resource.as_uri()}})
        self.assertEqual(self.definition(self.text, "Resource Step")[0]["range"]["start"]["line"], 1)
        resource.write_text(changed)
        self.assertEqual(self.definition(self.text, "Resource Step")[0]["range"]["start"]["line"], 2)
        library = self.root / "AuditLibrary.py"
        library.write_text(library.read_text().replace('"Build Record"', '"Renamed"'))
        self.assertEqual(self.definition(self.text, "Build Record"), [])

    def test_variable_scope_utf16_and_embedded_keywords(self):
        text = ("*** Variables ***\n${value}    suite\n*** Test Cases ***\nA\n"
                "    ${value}=    Set Variable    local\n    Log    😀${value}\nB\n"
                "    Log    ${value}\n    Greet Ada\n*** Keywords ***\nGreet ${name}\n"
                "    [Arguments]    ${value}\n    Log    ${value}\n")
        self.open(self.uri, text, 2)
        def at(line, word):
            value = text.splitlines()[line]
            col = len(value[:value.index(word)].encode("utf-16-le")) // 2
            return self.client.request("textDocument/definition", {"textDocument": {"uri": self.uri},
                    "position": {"line": line, "character": col}})
        self.assertEqual(at(5, "${value}")[0]["range"]["start"]["line"], 4)
        self.assertEqual(at(7, "${value}")[0]["range"]["start"]["line"], 1)
        self.assertEqual(at(12, "${value}")[0]["range"]["start"]["line"], 11)
        self.assertEqual(at(8, "Greet Ada")[0]["range"]["start"]["line"], 10)


if __name__ == "__main__":
    unittest.main()

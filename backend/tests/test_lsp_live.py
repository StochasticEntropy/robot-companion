"""Mandatory RF conformance. Missing approved prerequisites fail, never skip."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from client import Client


CAPABILITIES = {
    "positionEncoding": "utf-16", "textDocumentSync": {"openClose": True, "change": 1},
    "definitionProvider": True, "hoverProvider": True,
    "completionProvider": {"triggerCharacters": ["{", "."], "resolveProvider": False},
    "signatureHelpProvider": {"triggerCharacters": [" ", "\t"], "retriggerCharacters": ["="]},
    "referencesProvider": True, "renameProvider": {"prepareProvider": True},
    "documentSymbolProvider": True, "workspaceSymbolProvider": True,
    "semanticTokensProvider": {"legend": {
        "tokenTypes": ["namespace", "property", "class", "function", "variable", "comment", "keyword", "macro",
                       "operator"],
        "tokenModifiers": ["declaration", "resolved", "defaultLibrary"]}, "full": True, "range": True},
    "codeActionProvider": {"codeActionKinds": ["quickfix"]}, "documentFormattingProvider": True,
    "experimental": {"robotCompanion": {"documentKeywords": 1}}}
# A client without CodeAction literal support gets no code actions.
WITHOUT_CODE_ACTIONS = {key: value for key, value in CAPABILITIES.items() if key != "codeActionProvider"}

# Starts a backend service whose RF import reports another release: the gate reads exactly
# the `robot.version.VERSION` the services would run with.
AS_RELEASE = ("import sys, robot.version; robot.version.VERSION = sys.argv.pop(1); "
              "sys.argv[0] = 'robot-companion-backend'; "
              "from robot_companion_backend.__main__ import main; sys.exit(main())")
SUPPORTED_SET = "Supported: Python 3.11 + Robot Framework 7.3.2, Python 3.13 + Robot Framework 7.5."


class UnsupportedRuntimeTests(unittest.TestCase):
    """Every service refuses a Python/RF combination outside the supported rows."""

    def releases(self):
        from robot_companion_backend.runtime import robot_version
        other = "7.5" if robot_version() == "7.3.2" else "7.3.2"  # the other row's RF with this Python
        return (other, "7.4")

    def test_services_refuse_an_unsupported_combination_naming_the_supported_set(self):
        python = "%d.%d" % sys.version_info[:2]
        for release in self.releases():
            for service in ("lsp", "discovery"):
                with self.subTest(release=release, service=service):
                    client = Client(argv=[sys.executable, "-c", AS_RELEASE, release, service])
                    try:
                        with self.assertRaises(AssertionError) as raised:
                            client.request("initialize", {"capabilities": {}})
                        error = raised.exception.args[0]["error"]
                        self.assertEqual(error["code"], -32002)
                        self.assertIn(f"Python {python} with Robot Framework {release}. {SUPPORTED_SET}",
                                      error["message"])
                    finally:
                        client.close()
            with self.subTest(release=release, service="doctor"):
                doctor = subprocess.run([sys.executable, "-c", AS_RELEASE, release, "doctor"],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(doctor.returncode, 2, doctor.stderr)
                runtime = json.loads(doctor.stdout)["runtime"]
                self.assertEqual((runtime["python"], runtime["robotframework"], runtime["supported"]),
                                 (python, release, False))

    def test_doctor_reports_this_supported_row(self):
        doctor = subprocess.run([sys.executable, "-m", "robot_companion_backend", "doctor"],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(doctor.returncode, 0, doctor.stdout + doctor.stderr)
        report = json.loads(doctor.stdout)
        from robot_companion_backend.runtime import robot_version
        self.assertEqual(report["runtime"], {
            "python": "%d.%d" % sys.version_info[:2], "robotframework": robot_version(), "supported": True,
            "supportedRows": [{"python": "3.11", "robotframework": "7.3.2"},
                              {"python": "3.13", "robotframework": "7.5"}]})
        self.assertEqual(report["executable"], sys.executable)
        self.assertEqual(report["dependencies"]["debugpy"], "1.8.22")
        self.assertFalse(report["robotcodePresent"])


class LanguageTestCase(unittest.TestCase):
    """Real backend LSP subprocess over a copied audit corpus; no test methods of its own."""
    client_capabilities = {}

    def setUp(self):
        from robot_companion_backend.runtime import unsupported_reason
        self.assertIsNone(unsupported_reason())  # a supported Python/RF row, never a skip
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-lsp-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for path in (Path(__file__).parent / "fixtures").iterdir():
            shutil.copyfile(path, self.root / path.name)
        self.client = Client()
        self.addCleanup(self.finish)
        # An editor such as VS Code: prepareRename, nested document symbols and CodeAction literals supported.
        editor = {"rename": {"prepareSupport": True}, "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                  "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["", "quickfix"]}}}}
        capabilities = {**self.client_capabilities,
                        "textDocument": {**editor, **self.client_capabilities.get("textDocument", {})}}
        result = self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": capabilities})
        # Exactly the implemented features: no completion resolve; formatting with Robocop 9.1.0 installed.
        self.assertEqual(result["capabilities"], CAPABILITIES)
        self.client.send("initialized", {})
        self.uri = (self.root / "audit.robot").as_uri()
        self.text = (self.root / "audit.robot").read_text()
        self.open(self.uri, self.text)

    def finish(self):
        try:
            self.assertIsNone(self.client.process.poll(), "Backend exited before orderly shutdown")
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

    @staticmethod
    def position(text, needle, occurrence=0, offset=0):
        """UTF-16 position `offset` code points after the needle's start on its nth line.

        A needle ending in a line break only matches at the end of a line.
        """
        lines = text.splitlines()
        core = needle.removesuffix("\n")
        found = (lambda value: value.endswith(core)) if needle != core else (lambda value: core in value)
        line = next(i for i, value in enumerate(lines) if found(value) and
                    sum(map(found, lines[:i])) == occurrence)
        index = len(lines[line]) - len(core) if needle != core else lines[line].index(core)
        prefix = lines[line][:index + offset]
        return {"line": line, "character": len(prefix.encode("utf-16-le")) // 2}

    def at(self, method, text, needle, uri=None, occurrence=0, offset=0):
        return self.client.request(method, {"textDocument": {"uri": uri or self.uri},
                                            "position": self.position(text, needle, occurrence, offset)})

    def definition(self, text, needle, uri=None, occurrence=0):
        return self.at("textDocument/definition", text, needle, uri, occurrence)


class LiveLanguageTests(LanguageTestCase):

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

    def test_import_diagnostics_separate_unmodelled_libraries_from_missing_files(self):
        # A sibling file named like a standard library must not replace RF's own library.
        (self.root / "Collections.py").write_text(
            'from robot.api.deco import keyword\n@keyword("Shadow Step")\ndef shadow(): pass\n')
        text = ("*** Settings ***\nLibrary    Collections\nLibrary    OperatingSystem\n"
                "Library    company.robot.Helpers\nLibrary    Missing.py\nLibrary    AuditLibrary.py\n"
                "*** Test Cases ***\nT\n    Shadow Step\n    Build Record\n")
        self.open(self.uri, text, 2)
        self.assertEqual(self.definition(text, "Shadow Step"), [])
        self.assertEqual(Path(self.definition(text, "Build Record")[0]["uri"]).name, "AuditLibrary.py")
        published = [n["params"] for n in self.client.notifications
                     if n.get("method") == "textDocument/publishDiagnostics" and n["params"]["uri"] == self.uri]
        self.assertEqual(published[-1]["version"], 2)
        diagnostics = {d["range"]["start"]["line"]: d for d in published[-1]["diagnostics"]}
        # Collections (line 1) and OperatingSystem (line 2) are recognised: no diagnostic at all.
        self.assertEqual(sorted(diagnostics), [3, 4])
        self.assertEqual((diagnostics[3]["severity"], diagnostics[3]["code"], diagnostics[3]["message"]),
                         (3, "import", "Library not resolved in this version: company.robot.Helpers"))
        self.assertEqual((diagnostics[4]["severity"], diagnostics[4]["code"]), (1, "import"))
        self.assertTrue(diagnostics[4]["message"].startswith("Unresolved LibraryImport: Missing.py: "))
        # An unsaved module library overlay is indexed instead of being reported as unmodelled.
        helpers = self.root / "company" / "robot" / "Helpers.py"
        self.open(helpers.as_uri(), 'from robot.api.deco import keyword\n@keyword("Assist Step")\ndef assist(): pass\n')
        self.open(self.uri, text + "    Assist Step\n", 3)
        self.assertEqual(Path(self.definition(text + "    Assist Step\n", "Assist Step")[0]["uri"]).name, "Helpers.py")
        # A module import's namespace is its full module name.
        qualified = text + "    company.robot.Helpers.Assist Step\n"
        self.open(self.uri, qualified, 4)
        self.assertEqual(Path(self.definition(qualified, "company.robot.Helpers.Assist Step")[0]["uri"]).name,
                         "Helpers.py")
        self.open(self.uri, text + "    Assist Step\n", 5)
        latest = [n["params"] for n in self.client.notifications
                  if n.get("method") == "textDocument/publishDiagnostics" and n["params"]["uri"] == self.uri][-1]
        self.assertEqual([(d["range"]["start"]["line"], d["severity"]) for d in latest["diagnostics"]], [(4, 1)])

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

    def test_utf16_destination_range(self):
        text = "*** Variables ***\n${😀value}    unicode\n*** Test Cases ***\nT\n    Log    😀${😀value}\n"
        self.open(self.uri, text, 2)
        location = self.definition(text, "${😀value}", occurrence=1)[0]
        self.assertEqual(location["range"], {"start": {"line": 1, "character": 0},
                                            "end": {"line": 1, "character": 10}})

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

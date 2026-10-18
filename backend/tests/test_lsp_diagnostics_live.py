"""Required real-process diagnostics, quick-fix and formatting conformance with RF 7.5 and Robocop 9.1.0."""

import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from client import Client
from test_lsp_live import LanguageTestCase

ERROR, WARNING = 1, 2
UNIQUE = 'from robot.api.deco import keyword\n\n\n@keyword("Unique Step")\ndef unique_step(value):\n    return value\n'
OTHER = 'from robot.api.deco import keyword\n@keyword("Build Record")\ndef other(name="x"): pass\n'


def apply_edits(text, edits):
    """Apply LSP TextEdits (UTF-16 positions) as an editor does: against the original text."""
    lines = text.split("\n")

    def offset(position):
        line = position["line"]
        before = sum(len(value) + 1 for value in lines[:line])
        units, index = position["character"], 0
        value = lines[line] if line < len(lines) else ""
        while units > 0:
            units -= len(value[index].encode("utf-16-le")) // 2
            index += 1
        return before + index
    for edit in sorted(edits, key=lambda e: (e["range"]["start"]["line"], e["range"]["start"]["character"]),
                       reverse=True):
        text = text[:offset(edit["range"]["start"])] + edit["newText"] + text[offset(edit["range"]["end"]):]
    return text


class DiagnosticsTestCase(LanguageTestCase):
    def setUp(self):
        super().setUp()
        self.versions = {self.uri: 1}

    def change(self, uri, text):
        """Open or change a document and return the diagnostics published for its new version."""
        version = self.versions.get(uri, 0) + 1
        self.versions[uri] = version
        if version == 1:
            self.open(uri, text, version)
        else:
            self.client.send("textDocument/didChange", {"textDocument": {"uri": uri, "version": version},
                                                       "contentChanges": [{"text": text}]})
        self.client.request("workspace/symbol", {"query": "\u0000"})  # all notifications before it have arrived
        published = [n["params"] for n in self.client.notifications
                     if n.get("method") == "textDocument/publishDiagnostics" and n["params"]["uri"] == uri]
        self.assertEqual(published[-1]["version"], version)
        return published[-1]["diagnostics"]

    @staticmethod
    def brief(diagnostics):
        """(severity, code, start line, start, end line, end) of each diagnostic, in order."""
        return [(d["severity"], d["code"], d["range"]["start"]["line"], d["range"]["start"]["character"],
                 d["range"]["end"]["line"], d["range"]["end"]["character"]) for d in diagnostics]

    def actions(self, uri, diagnostic, only=None):
        context = {"diagnostics": [diagnostic], **({"only": only} if only is not None else {})}
        return self.client.request("textDocument/codeAction", {
            "textDocument": {"uri": uri}, "range": diagnostic["range"], "context": context})

    def format(self, uri):
        return self.client.request("textDocument/formatting", {
            "textDocument": {"uri": uri}, "options": {"tabSize": 4, "insertSpaces": True}})


class LiveDiagnosticsTests(DiagnosticsTestCase):

    def test_valid_audit_fixtures_have_no_error_or_warning(self):
        self.assertEqual(self.change(self.uri, self.text), [])
        resource = self.root / "shared.resource"
        self.assertEqual(self.change(resource.as_uri(), resource.read_text()), [])

    def test_parsing_and_model_errors_with_utf16_ranges(self):
        text = ("*** Settings ***\nLibary    AuditLibrary.py\n*** Ünknown 😀 ***\nx\n*** Test Cases ***\n"
                "Täst 😀\n    [Föo]    bar\n    FOR    ${i}    IN    1    2\n        Log    ${i}\n"
                "*** Keywords ***\nK\n    [Arguments]    ${a}=1    ${b}\n    RETURN    ${a}${b}\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual([d for d in self.brief(diagnostics) if d[1] == "syntax"], [
            (ERROR, "syntax", 1, 0, 1, 6),          # Libary
            (ERROR, "syntax", 2, 0, 2, 18),         # the whole invalid header, 😀 counted as 2 units
            (ERROR, "syntax", 6, 4, 6, 9),          # [Föo]
            (ERROR, "syntax", 7, 4, 7, 31),         # FOR header without END
            (ERROR, "syntax", 11, 4, 11, 33)])      # non-default argument after default
        messages = [d["message"] for d in diagnostics if d["code"] == "syntax"]
        self.assertTrue(messages[0].startswith("Non-existing setting 'Libary'."))
        self.assertTrue(messages[1].startswith("Unrecognized section header '*** Ünknown 😀 ***'."))
        self.assertEqual(messages[2:], ["Non-existing setting 'Föo'.", "FOR loop must have closing END.",
                                        "Non-default argument after default arguments."])
        # A resource file is parsed as RF parses resources: a test case section is invalid there.
        resource = self.root / "bad.resource"
        diagnostics = self.change(resource.as_uri(), "*** Test Cases ***\nT\n    No Operation\n")
        self.assertEqual(self.brief(diagnostics), [(ERROR, "syntax", 0, 0, 0, 18)])
        self.assertIn("Resource file with 'Test Cases' section is invalid", diagnostics[0]["message"])

    def test_deprecations_are_warnings_and_an_invalid_pattern_does_not_stop_publishing(self):
        text = ("*** Test Case ***\nT\n    Unknown Call\n    Bad Ä\n*** Keywords ***\nBad ${x:[}\n"
                "    No Operation\nOld\n    [Return]    1\n")
        diagnostics = self.change(self.uri, text)
        # RF reports deprecated syntax as warnings; the keyword with an invalid embedded
        # pattern matches nothing, as when RF runs, and publishing goes on.
        self.assertEqual(self.brief(diagnostics), [
            (WARNING, "deprecated", 0, 0, 0, 17), (WARNING, "deprecated", 8, 4, 8, 12),
            (ERROR, "unknown-keyword", 2, 4, 2, 16), (ERROR, "unknown-keyword", 3, 4, 3, 9)])
        self.assertTrue(diagnostics[0]["message"].startswith("Singular section headers like '*** Test Case ***' "
                                                             "are deprecated."))

    def test_unknown_keywords_never_use_the_unimported_shadow(self):
        # Without the AuditLibrary import, Build Record exists only in the unimported AShadow.py.
        text = self.text.replace("Library    AuditLibrary.py\n", "")
        diagnostics = self.change(self.uri, text)
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 10, 18, 10, 30)])
        self.assertEqual(diagnostics[0]["message"], "No keyword with name 'Build Record' found.")
        # Two workspace files define it (AuditLibrary.py and AShadow.py): no import is guessed.
        self.assertEqual(self.actions(self.uri, diagnostics[0]), [])
        unknown = ("*** Test Cases ***\nT\n    😀 Ünknown Step\n    Given Local Step\n    Log    ${{1}}\n"
                   "    ${name}=    Set Variable    Local Step\n    Run Keyword    ${name}\n    ${name} Step\n"
                   "*** Keywords ***\nLocal Step\n    No Operation\n")
        diagnostics = self.change(self.uri, unknown)
        # Only the unknown call; a BDD prefix, a keyword name argument and a name containing a variable are not.
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 2, 4, 2, 19)])
        self.assertEqual(diagnostics[0]["message"], "No keyword with name '😀 Ünknown Step' found.")

    def test_unknown_keywords_are_not_reported_when_the_scope_is_not_static(self):
        (self.root / "Plain.py").write_text("def plain_step():\n    pass\n\n\ndef _private():\n    pass\n")
        (self.root / "Klass.py").write_text("class Klass:\n    def class_step(self):\n        pass\n")
        (self.root / "Deco.py").write_text("from robot.api import deco\n\n\n@deco.keyword('Build Item')\n"
                                           "def make():\n    pass\n")
        (self.root / "Named.py").write_text("from robot.api.deco import keyword\nNAME = 'Computed Step'\n\n\n"
                                            "@keyword(NAME)\ndef computed():\n    pass\n")
        call = "*** Test Cases ***\nT\n    {}\n"
        for imports, step in (("Library    Plain.py", "Plain Step"),          # undecorated function
                              ("Library    Klass.py", "Anything"),            # class library
                              ("Library    company.Helpers", "Anything"),     # unmodelled module name
                              ("Library    Remote    http://127.0.0.1:1", "Anything"),
                              ("Library    Missing.py", "Anything"),          # its own import error instead
                              ("Library    Deco.py", "Build Item"),           # decorator form not indexed
                              ("Library    Named.py", "Computed Step")):      # computed keyword name
            with self.subTest(imports=imports):
                diagnostics = self.change(self.uri, f"*** Settings ***\n{imports}\n" + call.format(step))
                self.assertEqual([d for d in diagnostics if d["code"] == "unknown-keyword"], [])
        # Import Library makes keywords available at run time; translated BDD prefixes are not modelled.
        text = "*** Test Cases ***\nT\n    Import Library    Plain.py\n    Anything\n"
        self.assertEqual(self.change(self.uri, text), [])
        translated = "Language: German\n\n*** Testfälle ***\nT\n    Angenommen Local Step\n"
        self.assertEqual([d for d in self.change(self.uri, translated) if d["code"] == "unknown-keyword"], [])
        # Undecorated public functions only: a private or misspelt name is still unknown.
        diagnostics = self.change(self.uri, "*** Settings ***\nLibrary    Plain.py\n" + call.format("Private"))
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 4, 4, 4, 11)])

    def test_resource_keywords_may_use_keywords_of_suites_importing_them(self):
        resource = self.root / "shared.resource"
        uses_suite = resource.read_text() + "\nUses Suite Library\n    Build Record\n    Not Anywhere\n"
        diagnostics = self.change(resource.as_uri(), uses_suite)
        # audit.robot imports shared.resource and AuditLibrary.py, so Build Record exists when it runs.
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 8, 4, 8, 16)])
        self.assertEqual(diagnostics[0]["message"], "No keyword with name 'Not Anywhere' found.")
        # Imported through a variable by another suite: its importers cannot be known statically.
        (self.root / "curdir.robot").write_text("*** Settings ***\nResource    ${CURDIR}/shared.resource\n"
                                                "Library    Collections\n*** Test Cases ***\nC\n    Uses Suite Library\n")
        diagnostics = self.change(resource.as_uri(), uses_suite + "    Log    ${UNKNOWN}\n")
        self.assertEqual(diagnostics, [])

    def test_ambiguous_call_warns_with_both_sources_and_qualifying_fixes_it(self):
        (self.root / "Other.py").write_text(OTHER)
        text = ("*** Settings ***\nLibrary    AuditLibrary.py\nLibrary    Other.py\n*** Test Cases ***\nT\n"
                "    Given Build Record\n    Other.Build Record\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual(self.brief(diagnostics), [(WARNING, "ambiguity", 5, 10, 5, 22)])
        message = diagnostics[0]["message"]
        self.assertIn("AuditLibrary.Build Record (AuditLibrary.py)", message)
        self.assertIn("Other.Build Record (Other.py)", message)
        self.assertNotIn("AShadow", message)
        actions = self.actions(self.uri, diagnostics[0])
        self.assertEqual([(a["title"], a["kind"]) for a in actions], [
            ("Use AuditLibrary.Build Record (AuditLibrary.py)", "quickfix"),
            ("Use Other.Build Record (Other.py)", "quickfix")])
        self.assertEqual(actions[0]["diagnostics"], diagnostics)
        self.assertEqual(self.actions(self.uri, diagnostics[0], only=["refactor"]), [])
        self.assertEqual(len(self.actions(self.uri, diagnostics[0], only=["quickfix"])), 2)
        fixed = apply_edits(text, actions[0]["edit"]["changes"][self.uri])
        self.assertIn("    Given AuditLibrary.Build Record\n", fixed)
        self.assertEqual(self.change(self.uri, fixed), [])
        self.assertEqual(self.definition(fixed, "AuditLibrary.Build Record")[0]["uri"],
                         (self.root / "AuditLibrary.py").as_uri())
        # Set Library Search Order decides at run time: no warning.
        ordered = text.replace("T\n", "T\n    Set Library Search Order    Other\n")
        self.assertEqual(self.change(self.uri, ordered), [])

    def test_argument_counts_follow_the_resolved_signature(self):
        text = ("*** Settings ***\nLibrary    AuditLibrary.py    AS    Audit\nResource    shared.resource\n"
                "Suite Setup    Resource Step\n*** Test Cases ***\nT\n    [Setup]    Log    a    b    c    d    e    f    g\n"
                "    Audit.Build Record    Ada    extra\n    Build Record    name=Ada\n    Resource Step\n"
                "    Resource Step    one    two\n    Log\n    Log    x    level=WARN    html=False\n"
                "    Log    x    level=INFO    😀\n    Build Record    @{EMPTY}\n    Resource Step    value=named\n"
                "    Greet Ada    extra\n    Local    1    2\n*** Keywords ***\nGreet ${name}\n    Log    ${name}\n"
                "Local\n    [Arguments]    ${a}    @{rest}\n    Log Many    ${a}    @{rest}\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual([(d[1], d[2], d[3], d[5], m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            ("arguments", 3, 15, 28, "Keyword 'Resource Step' expected 1 argument, got 0."),
            ("arguments", 6, 15, 18, "Keyword 'Log' expected 1 to 6 arguments, got 7."),
            ("arguments", 7, 4, 22, "Keyword 'Audit.Build Record' expected 0 to 1 arguments, got 2."),
            ("arguments", 9, 4, 17, "Keyword 'Resource Step' expected 1 argument, got 0."),
            ("arguments", 10, 4, 17, "Keyword 'Resource Step' expected 1 argument, got 2."),
            ("arguments", 11, 4, 7, "Keyword 'Log' expected 1 to 6 arguments, got 0."),
            ("arguments", 13, 4, 7, "Keyword 'Log' got positional argument after named arguments.")])
        self.assertEqual({d["severity"] for d in diagnostics}, {ERROR})

    def test_undefined_variables_warn_without_false_positives_for_dynamic_variables(self):
        (self.root / "setup.robot").write_text(
            "*** Test Cases ***\nS\n    Set Suite Variable    ${FROM_OTHER_SUITE}    1\n"
            "    Run Keyword    Set Global Variable    \\${VIA_RUN_KEYWORD}    2\n"
            "    VAR    ${BY_VAR}    3    scope=SUITE\n    VAR    ${ONLY_LOCAL}    4\n"
            "    [Teardown]    Set Global Variable    ${FROM_TEARDOWN}    5\n")
        (self.root / "__init__.robot").write_text(
            "*** Settings ***\nSuite Setup    Set Suite Variable    $FROM_SUITE_SETUP    6    children=True\n")
        text = ("*** Settings ***\nLibrary    Collections\n*** Variables ***\n${SUITE_VALUE}    s\n"
                "*** Test Cases ***\nFirst\n    ${record}=    Set Variable    Ada\n    Log    ${record.upper()}\n"
                "    Set Test Variable    ${DYNAMIC}    d\n    Log Many    ${DYNAMIC}    ${FROM_OTHER_SUITE}"
                "    ${VIA_RUN_KEYWORD}    ${BY_VAR}    ${FROM_TEARDOWN}    ${FROM_SUITE_SETUP}\n"
                "    Log Many    ${SUITE_VALUE}    ${SPACE * 2}    ${1}    ${0x1F}    ${TEST NAME}    ${CURDIR}"
                "    @{EMPTY}    &{EMPTY}    ${True}\n"
                "    ${maybe}=    Get Variable Value    ${UNSET}    default\n"
                "    FOR    ${i}    IN RANGE    3\n        IF    ${i} > 0    Log    ${previous}\n"
                "        ${previous}=    Set Variable    ${i}\n    END\n    Log    😀${missing}    \\${escaped}\n"
                "    Should Be True    $record == 'Ada'\n    Log    ${ONLY_LOCAL}    ${{ ${record} }}\n"
                "Second\n    [Documentation]    ${not_checked}\n    Log    ${record}\n"
                "*** Keywords ***\nKeyword\n    [Arguments]    ${arg}    @{rest}\n    Log Many    ${arg}    @{rest}    ${arg2}\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual([(d[0], d[1], d[2], d[3], d[5], m["message"])
                          for d, m in zip(self.brief(diagnostics), diagnostics)], [
            (WARNING, "undefined-variable", 16, 13, 23, "Variable '${missing}' is not defined in this scope."),
            (WARNING, "undefined-variable", 18, 11, 24, "Variable '${ONLY_LOCAL}' is not defined in this scope."),
            (WARNING, "undefined-variable", 21, 11, 20, "Variable '${record}' is not defined in this scope."),
            (WARNING, "undefined-variable", 25, 37, 44, "Variable '${arg2}' is not defined in this scope.")])
        # Variable files and Python code that sets variables may define anything: no warning.
        (self.root / "Setter.py").write_text(
            "from robot.libraries.BuiltIn import BuiltIn\n\n\ndef make_value():\n"
            "    BuiltIn().set_test_variable('${made}', 1)\n")
        for imports in ("Variables    vars.py", "Library    Setter.py"):
            with self.subTest(imports=imports):
                varied = f"*** Settings ***\n{imports}\n*** Test Cases ***\nT\n    Log    ${{made}}\n"
                self.assertEqual([d for d in self.change(self.uri, varied) if d["code"] == "undefined-variable"], [])
        # A setter whose variable name is computed may set any name.
        computed = "*** Test Cases ***\nT\n    ${n}=    Set Variable    x\n    Set Test Variable    ${${n}}    1\n" \
                   "    Log    ${anything}\n"
        self.assertEqual(self.change(self.uri, computed), [])
        # RF first replaces `${NAME}` in a setter's name: its value may name the variable set.
        wrapped = ("*** Test Cases ***\nT\n    ${NAME}=    Set Variable    \\${var}\n"
                   "    Set Test Variable    ${NAME}    value\n    Log    ${var}\n")
        self.assertEqual(self.change(self.uri, wrapped), [])

    def test_quick_fix_adds_the_only_defining_resource_or_library(self):
        library = self.root / "lib" / "Unique.py"
        library.parent.mkdir()
        library.write_text(UNIQUE)
        text = "*** Test Cases ***\nT\n    Resource Step    x\n"
        diagnostics = self.change(self.uri, text)
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 2, 4, 2, 17)])
        actions = self.actions(self.uri, diagnostics[0])
        self.assertEqual([(a["title"], a["kind"], a.get("isPreferred")) for a in actions],
                         [("Import resource shared.resource", "quickfix", True)])
        fixed = apply_edits(text, actions[0]["edit"]["changes"][self.uri])
        self.assertEqual(fixed, "*** Settings ***\nResource    shared.resource\n\n" + text)
        self.assertEqual(self.change(self.uri, fixed), [])
        # A library in a subdirectory, added after the last import of an existing Settings section.
        text = fixed.replace("    Resource Step    x\n", "    Resource Step    x\n    Unique Step    y\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 6, 4, 6, 15)])
        actions = self.actions(self.uri, diagnostics[0])
        self.assertEqual([a["title"] for a in actions], ["Import library lib/Unique.py"])
        fixed = apply_edits(text, actions[0]["edit"]["changes"][self.uri])
        self.assertTrue(fixed.startswith("*** Settings ***\nResource    shared.resource\nLibrary    lib/Unique.py\n"))
        self.assertEqual(self.change(self.uri, fixed), [])
        # The fixed suite runs with RF 7.5.
        # A keyword also in an (unimported) standard library is no deterministic import.
        (self.root / "lists.resource").write_text("*** Keywords ***\nAppend To List\n    No Operation\n")
        diagnostics = self.change(self.uri, fixed + "    Append To List\n")
        self.assertEqual(self.brief(diagnostics), [(ERROR, "unknown-keyword", 8, 4, 8, 18)])
        self.assertEqual(self.actions(self.uri, diagnostics[0]), [])
        (self.root / "lists.resource").unlink()
        (self.root / "audit.robot").write_text(fixed)
        run = subprocess.run([sys.executable, "-m", "robot", "--output", "NONE", "--report", "NONE", "--log", "NONE",
                              "audit.robot"], cwd=self.root, capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_code_actions_need_client_literal_support(self):
        client = Client()
        try:
            result = client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            self.assertNotIn("codeActionProvider", result["capabilities"])
            client.send("initialized", {})
            with self.assertRaises(AssertionError) as raised:
                client.request("textDocument/codeAction", {"textDocument": {"uri": self.uri}, "range": {
                    "start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}},
                    "context": {"diagnostics": []}})
            self.assertEqual(raised.exception.args[0]["error"]["code"], -32601)
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()


class LiveFormattingTests(DiagnosticsTestCase):

    def robot(self, directory):
        return subprocess.run([sys.executable, "-m", "robot", "--output", "NONE", "--report", "NONE", "--log", "NONE",
                               "audit.robot"], cwd=directory, capture_output=True, text=True, timeout=120)

    def test_formatting_is_deterministic_idempotent_and_keeps_the_audit_suite_passing(self):
        self.assertEqual(importlib.metadata.version("robotframework-robocop"), "9.1.0")
        before = self.robot(self.root)
        self.assertEqual(before.returncode, 0, before.stdout + before.stderr)
        self.assertIn("1 test, 1 passed, 0 failed", before.stdout)
        for name in ("audit.robot", "shared.resource"):
            with self.subTest(name=name):
                path = self.root / name
                uri, text = path.as_uri(), path.read_text()
                if uri not in self.versions:
                    self.change(uri, text)
                edits = self.format(uri)
                self.assertTrue(edits)
                formatted = apply_edits(text, edits)
                self.assertEqual(edits, self.format(uri), "Formatting the same text twice differs")
                self.change(uri, formatted)
                self.assertEqual(self.format(uri), [], "A second format changed the formatted text")
                path.write_text(formatted)
        self.assertIn("Library     AuditLibrary.py\nResource    shared.resource\n",
                      (self.root / "audit.robot").read_text())
        after = self.robot(self.root)
        self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
        self.assertIn("1 test, 1 passed, 0 failed", after.stdout)
        self.assertEqual(self.change(self.uri, (self.root / "audit.robot").read_text()), [])

    def test_formatting_edits_keep_line_endings_and_utf16_positions(self):
        messy = ("*** settings ***\r\nLibrary  AuditLibrary.py\r\n*** Test Cases ***\r\nTäst 😀\r\n"
                 "  ${x}=  Build Record   name=Ä😀\r\n  Log   ${x}    😀")
        self.change(self.uri, messy)
        edits = self.format(self.uri)
        formatted = apply_edits(messy, edits)
        self.assertEqual(formatted, "*** Settings ***\r\nLibrary    AuditLibrary.py\r\n\r\n\r\n*** Test Cases ***\r\n"
                                    "Täst 😀\r\n    ${x}=    Build Record    name=Ä😀\r\n    Log    ${x}    😀\r\n")
        # The last edit ends after the emoji of the unterminated last line (2 UTF-16 units).
        self.assertEqual(edits[-1]["range"]["end"], {"line": 5, "character": 18})
        self.change(self.uri, formatted)
        self.assertEqual(self.format(self.uri), [])
        self.change(self.uri, "*** Test Cases ***\rT\r    Log  x\r")
        with self.assertRaises(AssertionError) as raised:
            self.format(self.uri)  # LSP counts a lone CR as a line break; no edit could line up
        self.assertEqual(raised.exception.args[0]["error"]["code"], -32803)
        other = self.root / "AuditLibrary.py"
        self.open(other.as_uri(), other.read_text())
        self.assertIsNone(self.format(other.as_uri()))

    def test_formatting_is_not_advertised_without_robocop(self):
        hidden = ("import sys; sys.modules['robocop'] = None; sys.argv = ['robot-companion-backend', 'lsp']; "
                  "from robot_companion_backend.__main__ import main; sys.exit(main())")
        client = Client(argv=[sys.executable, "-c", hidden])
        try:
            result = client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            self.assertNotIn("documentFormattingProvider", result["capabilities"])
            client.send("initialized", {})
            with self.assertRaises(AssertionError) as raised:
                client.request("textDocument/formatting", {"textDocument": {"uri": self.uri},
                                                           "options": {"tabSize": 4, "insertSpaces": True}})
            self.assertEqual(raised.exception.args[0]["error"]["code"], -32601)
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()

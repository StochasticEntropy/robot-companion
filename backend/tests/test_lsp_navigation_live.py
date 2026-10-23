"""Mandatory navigation, symbols and responsiveness under full push diagnostics. Never skips."""

import contextlib
import io
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from client import Client, uri_file
from robot_companion_backend import diagnostic_worker
from robot_companion_backend.workspace import Workspace
import processes
from test_lsp_live import WITHOUT_CODE_ACTIONS, LanguageTestCase

SHADOW = "*** Settings ***\nLibrary    AShadow.py\n*** Test Cases ***\nShadow Test\n    Build Record\n"
ALIAS = ("*** Settings ***\nLibrary    AuditLibrary.py    AS    Audit\nResource    shared.resource\n"
         "*** Tasks ***\nAlias Task\n    [Setup]    Resource Step    setup\n"
         "    ${r}=    Audit.Build Record    name=Bo\n    Build Record\n"
         "    Given shared.Resource Step    bdd\n    # Resource Step in a comment\n")
BOTH = ("*** Settings ***\nLibrary    AuditLibrary.py\nLibrary    AShadow.py\n*** Test Cases ***\n"
        "Ambiguous\n    Build Record\n")
OWN = ("*** Test Cases ***\nOwn\n    Build Record\n    Resource Step\n*** Keywords ***\nBuild Record\n"
       "    No Operation\nResource Step\n    No Operation\n")
SCOPES = ("*** Settings ***\nResource    vars.resource\n*** Variables ***\n${SUITE_VALUE}    from-suite\n"
          "*** Test Cases ***\nFirst\n    ${local}=    Set Variable    ${SUITE_VALUE}\n    Log    ${local} ${SHARED}\n"
          "Second\n    ${local}=    Set Variable    other\n    Log    ${local}\n    Helper    ${SUITE_VALUE}\n"
          "*** Keywords ***\nHelper\n    [Arguments]    ${local}\n    Log    ${local}\n")
VARS = "*** Variables ***\n${SHARED}    shared\n*** Keywords ***\nShared Helper\n    Log    ${SHARED}\n"
UMLAUT = ("*** Keywords ***\nPrüfe 😀 Schritt\n    [Documentation]    Prüfe 😀 Schritt is documented here.\n"
          "    Log    ä😀\n")
CALLS = ("*** Settings ***\nResource    umlaut.resource\n*** Test Cases ***\nGrüße 😀\n"
         "    [Setup]    Prüfe 😀 Schritt\n    ${ä😀}=    umlaut.Prüfe 😀 Schritt\n    Given Prüfe 😀 Schritt\n"
         "    Log    Prüfe 😀 Schritt\n    # Prüfe 😀 Schritt\n")
NEW = "Überprüfe 🚀 Schritt"
EXPRESSIONS = ("*** Settings ***\nResource    helper.resource\n*** Test Cases ***\nT\n"
               "    ${count}=    Set Variable    1\n    IF    $count > 0 and \"$count\" != 'x'    Log    pos\n"
               "    WHILE    $count < 3    limit=5\n        ${count}=    Evaluate    $count + 1\n    END\n"
               "    Should Be True    ${{ $count == 3 }}\n    Log    \\${count} and $count stay literal\n"
               "    Helper    value=1\n    Helper    value\\=1\n    Helper\n    ...    value=2\n"
               "    Log    ${{ {'n': {'v': 1}}['n']['v'] + $count }}\n    Helper    1    items=3\n")
HELPER = ("*** Keywords ***\nHelper\n    [Arguments]    ${value}    @{items}\n"
          "    ${value}=    Catenate    ${value}    x\n    Log    ${value}    @{items}\n")

NESTED = ("*** Variables ***\n${greeting_en}    hi\n*** Test Cases ***\nT\n"
          "    ${x}=    Set Variable    ${5}\n    ${i}=    Set Variable    ${1}\n"
          "    ${items}=    Create List    a    b\n"
          "    Should Be Equal As Integers    ${{ ${x} + 1 }}    6\n"
          "    Should Be Equal As Integers    ${{ {'v': ${x}}['v'] * 2 }}    10\n"
          "    Should Be Equal    ${items}[${i}]    b\n    Log    ${x}\n    Greet    en\n"
          "*** Keywords ***\nGreet\n    [Arguments]    ${lang}\n"
          "    Should Be Equal    ${greeting_${lang}}    hi\n    Log    ${lang}\n")
INLINE_IF = ("*** Variables ***\n${MODE}    fast\n*** Test Cases ***\nT\n"
             "    ${MODE}=    IF    $MODE == 'fast'    Catenate    ${MODE}-x    ELSE IF    $MODE == 'x'"
             "    Set Variable    ${MODE}    ELSE    Set Variable    slow\n"
             "    Should Be Equal    ${MODE}    fast-x\n")
# MIS-359's repro (inline IF and plain assignment): the branch/argument `${MODE}` is the suite
# variable on the first iteration and the local on the second.
LOOP_IF = ("*** Variables ***\n${MODE}    fast\n*** Test Cases ***\nT\n    FOR    ${_}    IN RANGE    2\n"
           "        ${MODE}=    IF    True    Catenate    ${MODE}-x    ELSE    Set Variable    slow\n    END\n"
           "    Should Be Equal    ${MODE}    fast-x-x\nOther\n    Should Be Equal    ${MODE}    fast\n")
LOOP_PLAIN = ("*** Variables ***\n${MODE}    fast\n*** Test Cases ***\nT\n    FOR    ${_}    IN RANGE    2\n"
              "        ${MODE}=    Catenate    ${MODE}-x\n    END\n    Should Be Equal    ${MODE}    fast-x-x\n"
              "Seen\n    FOR    ${i}    IN RANGE    2\n"
              "        IF    $i > 0    Should Be Equal As Integers    ${seen}    0\n"
              "        ${seen}=    Set Variable    ${i}\n    END\n")
# A WHILE condition and an inner FOR body reach a reassignment later in the outer loop; an
# outer body reaches one in an inner loop.
LOOP_NESTED = ("*** Variables ***\n${MODE}    fast\n*** Test Cases ***\nT\n"
               "    WHILE    $MODE != 'fast-x-x'    limit=5\n        FOR    ${_}    IN RANGE    1\n"
               "            Should Start With    ${MODE}    fast\n        END\n"
               "        ${MODE}=    Catenate    ${MODE}-x\n    END\n    Should Be Equal    ${MODE}    fast-x-x\n"
               "U\n    FOR    ${i}    IN RANGE    2\n"
               "        Should Be Equal    ${MODE}    ${{ 'inner' if ${i} else 'fast' }}\n"
               "        FOR    ${j}    IN RANGE    1\n            ${MODE}=    Set Variable    inner\n        END\n"
               "    END\n")
# Control: the loop does not reassign `${MODE}`, so nothing is carried.
NO_LOOP = ("*** Variables ***\n${MODE}    fast\n*** Test Cases ***\nT\n    FOR    ${_}    IN RANGE    2\n"
           "        Should Be Equal    ${MODE}    fast\n    END\n    ${MODE}=    Catenate    ${MODE}-x\n"
           "    Should Be Equal    ${MODE}    fast-x\n")

def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def apply(text, edits):
    """Apply LSP TextEdits (UTF-16 ranges on single lines) to text, last edit first."""
    lines = text.split("\n")
    for edit in sorted(edits, key=lambda e: (e["range"]["start"]["line"], e["range"]["start"]["character"]),
                       reverse=True):
        start, end = edit["range"]["start"], edit["range"]["end"]
        assert start["line"] == end["line"]
        line = lines[start["line"]]
        index = {utf16(line[:i]): i for i in range(len(line) + 1)}
        lines[start["line"]] = line[:index[start["character"]]] + edit["newText"] + line[index[end["character"]]:]
    return "\n".join(lines)


class NavigationTests(LanguageTestCase):
    def write(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def refs(self, text, needle, uri=None, include=True, occurrence=0, offset=0):
        result = self.client.request("textDocument/references", {
            "textDocument": {"uri": uri or self.uri}, "position": self.position(text, needle, occurrence, offset),
            "context": {"includeDeclaration": include}})
        found = {(Path(x["uri"]).name, x["range"]["start"]["line"], x["range"]["start"]["character"],
                  x["range"]["end"]["character"]) for x in result}
        self.assertEqual(len(found), len(result), "duplicate locations")
        return found

    def site(self, name, text, needle, occurrence=0, offset=0, length=None):
        start = self.position(text, needle, occurrence, offset)
        named = needle.removesuffix("\n")
        size = utf16(named[offset:] if length is None else named[offset:offset + length])
        return (name, start["line"], start["character"], start["character"] + size)

    def refused(self, method, text, needle, uri=None, offset=0, **extra):
        params = {"textDocument": {"uri": uri or self.uri}, "position": self.position(text, needle, offset=offset),
                  **extra}
        with self.assertRaises(AssertionError) as caught:
            self.client.request(method, params)
        error = caught.exception.args[0]["error"]
        self.assertEqual(error["code"], -32803)
        return error["message"]

    def rename(self, text, needle, new_name, uri=None, offset=0, occurrence=0):
        return self.client.request("textDocument/rename", {
            "textDocument": {"uri": uri or self.uri}, "position": self.position(text, needle, occurrence, offset),
            "newName": new_name})["changes"]

    def test_keyword_references_follow_imports_and_never_include_shadow(self):
        for name, text in (("shadow.robot", SHADOW), ("alias.robot", ALIAS), ("both.robot", BOTH),
                           ("own.robot", OWN)):
            self.write(name, text)  # on disk only: never opened
        library = (self.root / "AuditLibrary.py").read_text(encoding="utf-8")
        audit = {("AuditLibrary.py", 11, 4, 16), self.site("audit.robot", self.text, "Build Record"),
                 self.site("alias.robot", ALIAS, "Audit.Build Record", offset=6),
                 self.site("alias.robot", ALIAS, "    Build Record\n", offset=4)}
        library_uri = (self.root / "AuditLibrary.py").as_uri()
        for label, found in (("call", self.refs(self.text, "Build Record")),
                             ("alias call", self.refs(ALIAS, "Audit.Build Record", (self.root / "alias.robot").as_uri())),
                             ("definition", self.refs(library, "build_record", library_uri))):
            with self.subTest(label):
                self.assertEqual(found, audit)
        self.assertEqual(self.refs(self.text, "Build Record", include=False), audit - {("AuditLibrary.py", 11, 4, 16)})
        # The unimported shadow, an own same-named keyword and an ambiguous call each stay separate.
        shadow_uri = (self.root / "shadow.robot").as_uri()
        self.assertEqual(self.refs(SHADOW, "    Build Record", shadow_uri, offset=4),
                         {("AShadow.py", 4, 4, 26), self.site("shadow.robot", SHADOW, "    Build Record", offset=4)})
        own_uri = (self.root / "own.robot").as_uri()
        self.assertEqual(self.refs(OWN, "    Build Record", own_uri, offset=4),
                         {self.site("own.robot", OWN, "Build Record", occurrence=1),
                          self.site("own.robot", OWN, "    Build Record", offset=4)})
        ambiguous = self.refs(BOTH, "    Build Record", (self.root / "both.robot").as_uri(), offset=4)
        self.assertEqual(ambiguous, audit | {("AShadow.py", 4, 4, 26),
                                             self.site("shadow.robot", SHADOW, "    Build Record", offset=4),
                                             self.site("both.robot", BOTH, "    Build Record", offset=4)})

    def test_resource_keyword_references_include_setting_bdd_and_qualified_cells(self):
        self.write("alias.robot", ALIAS)
        self.write("own.robot", OWN)
        resource = self.root / "shared.resource"
        expected = {("shared.resource", 1, 0, 13), self.site("audit.robot", self.text, "Resource Step"),
                    self.site("alias.robot", ALIAS, "Resource Step    setup", length=13),
                    self.site("alias.robot", ALIAS, "Given shared.Resource Step", offset=13)}
        self.assertEqual(self.refs(resource.read_text(encoding="utf-8"), "Resource Step", resource.as_uri()), expected)
        self.assertEqual(self.refs(self.text, "Resource Step", include=False), expected - {("shared.resource", 1, 0, 13)})
        # Definition consumes the same setting-cell resolution.
        alias_uri = (self.root / "alias.robot").as_uri()
        location = self.definition(ALIAS, "Resource Step    setup", alias_uri)
        self.assertEqual([(Path(x["uri"]).name, x["range"]["start"]["line"]) for x in location],
                         [("shared.resource", 1)])

    def test_variable_references_stay_within_their_scope(self):
        self.write("vars.resource", VARS)
        self.write("other.robot", "*** Settings ***\nResource    vars.resource\n*** Test Cases ***\nOther\n"
                                  "    Log    ${SHARED}\n")
        self.write("own_shared.robot", "*** Settings ***\nResource    vars.resource\n*** Variables ***\n"
                                       "${SHARED}    own\n*** Test Cases ***\nOwn\n    Log    ${SHARED}\n")
        self.open(self.uri, SCOPES, 2)
        first = {self.site("audit.robot", SCOPES, "${local}=", offset=2, length=5),
                 self.site("audit.robot", SCOPES, "${local} ${SHARED}", offset=2, length=5)}
        self.assertEqual(self.refs(SCOPES, "${local} ${SHARED}", offset=2), first)
        # A keyword-local `${local}` is never a use of the test's, nor the other way round.
        helper = {self.site("audit.robot", SCOPES, "[Arguments]    ${local}", offset=17, length=5),
                  self.site("audit.robot", SCOPES, "Log    ${local}", occurrence=2, offset=9, length=5)}
        self.assertEqual(self.refs(SCOPES, "Log    ${local}", occurrence=2, offset=9), helper)
        suite = {("audit.robot", 3, 2, 13), self.site("audit.robot", SCOPES, "Set Variable    ${SUITE_VALUE}",
                                                      offset=18, length=11),
                 self.site("audit.robot", SCOPES, "Helper    ${SUITE_VALUE}", offset=12, length=11)}
        self.assertEqual(self.refs(SCOPES, "${SUITE_VALUE}", occurrence=1, offset=2), suite)
        self.assertEqual(self.refs(SCOPES, "${SUITE_VALUE}", offset=2), suite)  # from its declaration
        self.assertEqual(self.refs(SCOPES, "${SUITE_VALUE}", occurrence=1, offset=2, include=False),
                         suite - {("audit.robot", 3, 2, 13)})
        # A resource's suite variable is used by each importing suite unless its own Variables shadow it.
        shared = {("vars.resource", 1, 2, 8), ("vars.resource", 4, 13, 19), ("other.robot", 4, 13, 19),
                  self.site("audit.robot", SCOPES, "${SHARED}", offset=2, length=6)}
        self.assertEqual(self.refs(SCOPES, "${SHARED}", offset=2), shared)

    def test_rename_user_keyword_edits_definition_and_every_resolved_call(self):
        resource = self.write("umlaut.resource", UMLAUT)
        uses = "*** Settings ***\nResource    umlaut.resource\n*** Test Cases ***\nT\n    Log    😀\n    Prüfe 😀 Schritt\n"
        own = "*** Test Cases ***\nT\n    Prüfe 😀 Schritt\n*** Keywords ***\nPrüfe 😀 Schritt\n    No Operation\n"
        self.write("uses.robot", uses)
        self.write("own.robot", own)
        self.open(self.uri, CALLS, 2)
        prepared = self.client.request("textDocument/prepareRename", {
            "textDocument": {"uri": self.uri}, "position": self.position(CALLS, "umlaut.Prüfe", offset=9)})
        call = self.position(CALLS, "umlaut.Prüfe", offset=7)
        end = {**call, "character": call["character"] + utf16("Prüfe 😀 Schritt")}  # 16 units, 15 code points
        self.assertEqual(prepared, {"range": {"start": call, "end": end},
                                    "placeholder": "Prüfe 😀 Schritt"})
        self.assertEqual(utf16("    ${ä😀}=    umlaut."), call["character"])  # 😀 is two UTF-16 units
        # An editor caret just after the name (the usual F2 position) selects the same call.
        after = self.client.request("textDocument/prepareRename", {"textDocument": {"uri": self.uri},
                                    "position": end})
        self.assertEqual(after, prepared)
        for label, changes in (("call", self.rename(CALLS, "umlaut.Prüfe", NEW, offset=9)),
                               ("definition", self.rename(UMLAUT, "Prüfe", NEW, resource.as_uri()))):
            with self.subTest(label):
                self.assertEqual(sorted(Path(uri).name for uri in changes), ["audit.robot", "umlaut.resource",
                                                                             "uses.robot"])
                self.assertEqual(apply(UMLAUT, changes[resource.as_uri()]),
                                 UMLAUT.replace("Prüfe 😀 Schritt\n    [Doc", f"{NEW}\n    [Doc"))
                self.assertEqual(apply(CALLS, changes[self.uri]), CALLS
                                 .replace("[Setup]    Prüfe", f"[Setup]    {NEW}").replace(f"{NEW} 😀 Schritt", NEW)
                                 .replace("umlaut.Prüfe 😀 Schritt", f"umlaut.{NEW}")
                                 .replace("Given Prüfe 😀 Schritt", f"Given {NEW}"))
                self.assertEqual(apply(uses, changes[(self.root / "uses.robot").as_uri()]),
                                 uses.replace("    Prüfe 😀 Schritt", f"    {NEW}"))
                self.assertEqual(len(changes[self.uri]), 3)  # not the Log argument or the comment

    def test_rename_refuses_standard_ambiguous_and_invalid_names(self):
        # Python library keywords: test_lsp_explorer_live.LibraryRenameTests.
        self.assertIn("standard library keyword (BuiltIn)",
                      self.refused("textDocument/rename", self.text, "    Log", offset=4, newName="X"))
        self.write("one.resource", "*** Keywords ***\nDup Step\n    No Operation\n")
        self.write("two.resource", "*** Keywords ***\nDup Step\n    No Operation\n")
        self.write("dup.robot", "*** Settings ***\nResource    one.resource\nResource    two.resource\n"
                                "*** Test Cases ***\nT\n    Dup Step\n")
        one = self.root / "one.resource"
        self.assertIn("dup.robot:6 is ambiguous", self.refused("textDocument/rename", one.read_text(encoding="utf-8"),
                                                                "Dup Step", one.as_uri(), newName="Single Step"))
        dup = self.root / "dup.robot"
        self.assertIn("ambiguous", self.refused("textDocument/prepareRename", dup.read_text(encoding="utf-8"),
                                                "    Dup Step", dup.as_uri(), offset=4))
        # prepareRename already reports an ambiguous call elsewhere, as rename does.
        self.assertIn("dup.robot:6 is ambiguous", self.refused("textDocument/prepareRename", one.read_text(encoding="utf-8"),
                                                                "Dup Step", one.as_uri()))
        for invalid in ("Two  cells", "Has\ttab", "${var} name", "", "# comment", "END", "[Tags]", "*** Odd",
                        "a \u00a0b", "a\u2028b", "... more"):
            with self.subTest(invalid=invalid):
                self.assertIn("one non-empty cell", self.refused("textDocument/rename", self.text, "Local Step",
                                                                 newName=invalid))
        self.open(self.uri, self.text + "    Log    ${TEMPDIR}\n", 2)
        self.assertIn("built-in variable", self.refused("textDocument/rename", self.text + "    Log    ${TEMPDIR}\n",
                                                        "${TEMPDIR}", offset=2, newName="T"))

    def test_variable_rename_stays_in_scope_with_utf16_ranges(self):
        text = ("*** Variables ***\n${GRÜSSE}    hallo\n*** Test Cases ***\nÄ 😀\n"
                "    ${wert😀}=    Set Variable    ${GRÜSSE}\n    Log    😀 ${wert😀.upper()} ${GRÜSSE}\n"
                "Other\n    ${wert😀}=    Set Variable    x\n    Log    ${wert😀}    ${GRÜSSE}\n")
        self.open(self.uri, text, 2)
        prepared = self.client.request("textDocument/prepareRename", {
            "textDocument": {"uri": self.uri}, "position": self.position(text, "${wert😀.upper", offset=3)})
        start = self.position(text, "${wert😀.upper", offset=2)
        self.assertEqual(prepared, {"range": {"start": start, "end": {**start, "character": start["character"] + 6}},
                                    "placeholder": "wert😀"})
        for new_name in ("ergebnis", "${ergebnis}"):
            with self.subTest(new_name=new_name):
                changes = self.rename(text, "${wert😀.upper", new_name, offset=3)
                self.assertEqual(list(changes), [self.uri])
                self.assertEqual(apply(text, changes[self.uri]), text.replace(
                    "    ${wert😀}=    Set Variable    ${GRÜSSE}", "    ${ergebnis}=    Set Variable    ${GRÜSSE}")
                    .replace("${wert😀.upper()}", "${ergebnis.upper()}"))
        changes = self.rename(text, "${GRÜSSE}", "GRUSS", offset=2)
        self.assertEqual(apply(text, changes[self.uri]), text.replace("${GRÜSSE}", "${GRUSS}"))
        self.assertIn("variable name", self.refused("textDocument/rename", text, "${GRÜSSE}", offset=2,
                                                    newName="a.b"))

    def test_variable_rename_follows_expressions_and_named_arguments(self):
        helper = self.write("helper.resource", HELPER)
        self.open(self.uri, EXPRESSIONS, 2)
        # `$count` in IF/WHILE conditions, Evaluate and `${{ }}` (nested braces too) is the same
        # variable; `"$count"` in a string literal, `\${count}` and `$count` in Log's text are literal.
        uses = self.refs(EXPRESSIONS, "IF    $count", offset=7)
        self.assertEqual(len(uses), 7)  # assignment, IF, WHILE, reassignment, Evaluate, two ${{ }}
        self.assertIn(self.site("audit.robot", EXPRESSIONS, "${{ $count", offset=5, length=5), uses)
        self.assertIn(self.site("audit.robot", EXPRESSIONS, "+ $count }}", offset=3, length=5), uses)
        self.assertFalse({use for use in uses if use[1] == 10})
        # A caret just after `$count` inside its cell, and one inside `${{ }}`, select the variable.
        for needle, offset in (("$count > 0", 6), ("+ $count }}", 4)):
            with self.subTest(needle=needle):
                prepared = self.client.request("textDocument/prepareRename", {"textDocument": {"uri": self.uri},
                                               "position": self.position(EXPRESSIONS, needle, offset=offset)})
                self.assertEqual(prepared["placeholder"], "count")
        renamed = lambda name, expression: (
            "*** Settings ***\nResource    helper.resource\n*** Test Cases ***\nT\n"
            f"    ${{{name}}}=    Set Variable    1\n    IF    ${expression} > 0 and \"$count\" != 'x'    Log    pos\n"
            f"    WHILE    ${expression} < 3    limit=5\n        ${{{name}}}=    Evaluate    ${expression} + 1\n"
            f"    END\n    Should Be True    ${{{{ ${expression} == 3 }}}}\n    Log    \\${{count}} and $count stay literal\n"
            "    Helper    value=1\n    Helper    value\\=1\n    Helper\n    ...    value=2\n"
            f"    Log    ${{{{ {{'n': {{'v': 1}}}}['n']['v'] + ${expression} }}}}\n    Helper    1    items=3\n")
        changes = self.rename(EXPRESSIONS, "WHILE    $count", "total", offset=10)
        self.assertEqual(apply(EXPRESSIONS, changes[self.uri]), renamed("total", "total"))
        # RF resolves `$my_total` to `${my total}`; a name that is no Python identifier is refused.
        changes = self.rename(EXPRESSIONS, "WHILE    $count", "my total", offset=10)
        self.assertEqual(apply(EXPRESSIONS, changes[self.uri]), renamed("my total", "my_total"))
        self.assertIn("Python expression", self.refused("textDocument/rename", EXPRESSIONS, "WHILE    $count",
                                                        offset=10, newName="my-total"))
        # Renaming a keyword argument, even from a use after its reassignment, also renames
        # `value=` in calls passing it by name, never `value\=1`.
        changes = self.rename(HELPER, "    Log    ${value}", "amount", helper.as_uri(), offset=13)
        self.assertEqual(sorted(Path(uri).name for uri in changes), ["audit.robot", "helper.resource"])
        self.assertEqual(apply(HELPER, changes[helper.as_uri()]), HELPER.replace("${value}", "${amount}"))
        self.assertEqual(apply(EXPRESSIONS, changes[self.uri]), EXPRESSIONS.replace("Helper    value=1",
                         "Helper    amount=1").replace("...    value=2", "...    amount=2"))
        self.assertEqual(self.refs(HELPER, "    Log    ${value}", helper.as_uri(), offset=13, include=False),
                         {self.site("helper.resource", HELPER, "Catenate    ${value}", offset=14, length=5),
                          self.site("helper.resource", HELPER, "Log    ${value}", offset=9, length=5),
                          self.site("audit.robot", EXPRESSIONS, "value=1", length=5),
                          self.site("audit.robot", EXPRESSIONS, "value=2", length=5)})
        # `items=3` is a positional value for `@{items}`, never renamed with it.
        changes = self.rename(HELPER, "@{items}", "entries", helper.as_uri(), offset=2)
        self.assertEqual(list(changes), [helper.as_uri()])
        self.assertEqual(apply(HELPER, changes[helper.as_uri()]), HELPER.replace("@{items}", "@{entries}"))

    def robot_passes(self, path):
        """Run the suite with the backend's RF: the renamed source must still pass."""
        result = subprocess.run([sys.executable, "-m", "robot", "--output", "NONE", "--log", "NONE",
                                 "--report", "NONE", str(path)], cwd=self.root, capture_output=True,
                                text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_nested_variables_and_inline_if_assignment_follow_robot(self):
        nested = self.write("nested.robot", NESTED)
        uri = nested.as_uri()
        self.robot_passes(nested)
        # `${x}` nested in `${{ }}` (also inside dict braces) and in `[${i}]` item access is a use;
        # `${greeting_${lang}}` uses `${lang}`, and its dynamic outer name is no use of anything.
        x = {self.site("nested.robot", NESTED, "${x}=", offset=2, length=1),
             self.site("nested.robot", NESTED, "${{ ${x}", offset=6, length=1),
             self.site("nested.robot", NESTED, "{'v': ${x}", offset=8, length=1),
             self.site("nested.robot", NESTED, "Log    ${x}", offset=9, length=1)}
        self.assertEqual(self.refs(NESTED, "{'v': ${x}", uri, offset=8), x)
        self.assertEqual(self.refs(NESTED, "Log    ${x}", uri, offset=9), x)
        self.assertEqual(self.refs(NESTED, "[${i}]", uri, offset=3),
                         {self.site("nested.robot", NESTED, "${i}=", offset=2, length=1),
                          self.site("nested.robot", NESTED, "[${i}]", offset=3, length=1)})
        lang = {self.site("nested.robot", NESTED, "[Arguments]    ${lang}", offset=17, length=4),
                self.site("nested.robot", NESTED, "${greeting_${lang}}", offset=13, length=4),
                self.site("nested.robot", NESTED, "Log    ${lang}", offset=9, length=4)}
        self.assertEqual(self.refs(NESTED, "${greeting_${lang}}", uri, offset=13), lang)
        self.assertEqual(self.refs(NESTED, "${greeting_en}", uri, offset=2),
                         {self.site("nested.robot", NESTED, "${greeting_en}", offset=2, length=11)})
        for needle, offset, new_name, expected in (
                ("Log    ${x}", 9, "y", NESTED.replace("${x}", "${y}")),
                ("Log    ${lang}", 9, "language", NESTED.replace("${lang}", "${language}"))):
            with self.subTest(new_name=new_name):
                changes = self.rename(NESTED, needle, new_name, uri, offset=offset)
                self.assertEqual(list(changes), [uri])
                renamed = apply(NESTED, changes[uri])
                self.assertEqual(renamed, expected)
                self.write("renamed.robot", renamed)
                self.robot_passes(self.root / "renamed.robot")
        # RF assigns `${MODE}=    IF ...` after the branch runs: the condition and branch values
        # use the suite `${MODE}`, only the assignment and later uses are the local.
        inline = self.write("inline.robot", INLINE_IF)
        uri = inline.as_uri()
        self.robot_passes(inline)
        local = {self.site("inline.robot", INLINE_IF, "    ${MODE}=", offset=6, length=4),
                 self.site("inline.robot", INLINE_IF, "Equal    ${MODE}", offset=11, length=4)}
        suite = {("inline.robot", 1, 2, 6), self.site("inline.robot", INLINE_IF, "$MODE == 'fast'", offset=1, length=4),
                 self.site("inline.robot", INLINE_IF, "${MODE}-x", offset=2, length=4),
                 self.site("inline.robot", INLINE_IF, "$MODE == 'x'", offset=1, length=4),
                 self.site("inline.robot", INLINE_IF, "Variable    ${MODE}", offset=14, length=4)}
        self.assertEqual(self.refs(INLINE_IF, "Equal    ${MODE}", uri, offset=11), local)
        self.assertEqual(self.refs(INLINE_IF, "    ${MODE}=", uri, offset=6), local)
        self.assertEqual(self.refs(INLINE_IF, "${MODE}-x", uri, offset=2), suite)
        # Definition and hover consume the same rule.
        branch = self.position(INLINE_IF, "${MODE}-x", offset=2)
        self.assertEqual(self.client.request("textDocument/definition", {
            "textDocument": {"uri": uri}, "position": branch})[0]["range"]["start"]["line"], 1)
        for needle, offset, new_name, renamed in (
                ("Equal    ${MODE}", 11, "RESULT", INLINE_IF.replace("    ${MODE}=", "    ${RESULT}=")
                 .replace("Equal    ${MODE}", "Equal    ${RESULT}")),
                ("${MODE}-x", 2, "KIND", INLINE_IF.replace("${MODE}    fast\n", "${KIND}    fast\n")
                 .replace("$MODE ==", "$KIND ==").replace("${MODE}-x", "${KIND}-x")
                 .replace("Variable    ${MODE}", "Variable    ${KIND}"))):
            with self.subTest(new_name=new_name):
                changes = self.rename(INLINE_IF, needle, new_name, uri, offset=offset)
                self.assertEqual(apply(INLINE_IF, changes[uri]), renamed)
                self.write("renamed.robot", renamed)
                self.robot_passes(self.root / "renamed.robot")

    def base_site(self, name, text, line, index=0):
        """Site of the index-th `${NAME`/`$NAME` base name (ASCII) on a 0-based line."""
        match = list(re.finditer(r"\$\{?(\w+(?: \w+)*)", text.split("\n")[line]))[index]
        return (name, line, match.start(1), match.end(1))

    def refs_at(self, site):
        uri = (self.root / site[0]).as_uri()
        result = self.client.request("textDocument/references", {
            "textDocument": {"uri": uri}, "position": {"line": site[1], "character": site[2]},
            "context": {"includeDeclaration": True}})
        return {(Path(x["uri"]).name, x["range"]["start"]["line"], x["range"]["start"]["character"],
                 x["range"]["end"]["character"]) for x in result}

    def renamed_at(self, site, text, new_name):
        """The single-file rename result, which the backend's RF must still pass."""
        uri = (self.root / site[0]).as_uri()
        changes = self.client.request("textDocument/rename", {
            "textDocument": {"uri": uri}, "position": {"line": site[1], "character": site[2]},
            "newName": new_name})["changes"]
        self.assertEqual(list(changes), [uri])
        renamed = apply(text, changes[uri])
        self.robot_passes(self.write("renamed.robot", renamed))
        return renamed

    def test_loop_carried_variables_are_referenced_and_renamed_together(self):
        # A use in a FOR/WHILE body above a reassignment there is reached by the suite variable
        # first and by the local later: a reference of both, and renaming either renames both.
        for name, text in (("loop_if.robot", LOOP_IF), ("loop_plain.robot", LOOP_PLAIN)):
            with self.subTest(name=name):
                self.robot_passes(self.write(name, text))
                at = lambda line, index=0: self.base_site(name, text, line, index)
                suite, local, carried = {at(1), at(5, 1)}, {at(5), at(5, 1), at(7)}, at(5, 1)
                if name == "loop_if.robot":
                    suite.add(at(9))  # another test's use of the suite variable
                self.assertEqual(self.refs_at(at(1)), suite)
                self.assertEqual(self.refs_at(at(7)), local)
                self.assertEqual(self.refs_at(at(5)), local)
                self.assertEqual(self.refs_at(carried), suite | local)
                renamed = text.replace("${MODE}", "${KIND}")
                for site in (at(1), at(5), carried, at(7)):
                    with self.subTest(site=site):
                        self.assertEqual(self.renamed_at(site, text, "KIND"), renamed)
        # A variable first set in the loop: on the second iteration the earlier use is that local.
        at = lambda line, index=0: self.base_site("loop_plain.robot", LOOP_PLAIN, line, index)
        self.assertEqual(self.refs_at(at(11)), {at(10, 1), at(11)})
        self.assertEqual(self.refs_at(at(10, 1)), {at(10, 1), at(11)})
        self.assertEqual(self.renamed_at(at(11), LOOP_PLAIN, "last"), LOOP_PLAIN.replace("${seen}", "${last}"))
        # Nested loops: a WHILE condition and an inner FOR body reach the outer reassignment;
        # test U's outer use reaches the inner loop's. Both tests' locals join the suite variable.
        self.robot_passes(self.write("loop_nested.robot", LOOP_NESTED))
        at = lambda line, index=0: self.base_site("loop_nested.robot", LOOP_NESTED, line, index)
        suite = {at(1), at(4), at(6), at(8, 1), at(13)}
        local_t, local_u = {at(4), at(6), at(8), at(8, 1), at(10)}, {at(13), at(15)}
        self.assertEqual(self.refs_at(at(1)), suite)
        self.assertEqual(self.refs_at(at(10)), local_t)
        self.assertEqual(self.refs_at(at(15)), local_u)
        self.assertEqual(self.refs_at(at(6)), suite | local_t)
        self.assertEqual(self.refs_at(at(13)), suite | local_u)
        renamed = LOOP_NESTED.replace("${MODE}", "${KIND}").replace("$MODE", "$KIND")
        for site in (at(1), at(4), at(8), at(15)):
            with self.subTest(site=site):
                self.assertEqual(self.renamed_at(site, LOOP_NESTED, "KIND"), renamed)
        # Control: a loop that does not reassign `${MODE}` carries nothing; unchanged scopes.
        self.robot_passes(self.write("no_loop.robot", NO_LOOP))
        at = lambda line, index=0: self.base_site("no_loop.robot", NO_LOOP, line, index)
        self.assertEqual(self.refs_at(at(1)), {at(1), at(5), at(7, 1)})
        self.assertEqual(self.refs_at(at(8)), {at(7), at(8)})
        self.assertEqual(self.renamed_at(at(1), NO_LOOP, "KIND"), NO_LOOP.replace(
            "${MODE}    fast\n", "${KIND}    fast\n").replace("Equal    ${MODE}    fast\n", "Equal    ${KIND}    fast\n")
            .replace("${MODE}-x", "${KIND}-x"))
        self.assertEqual(self.renamed_at(at(8), NO_LOOP, "RESULT"), NO_LOOP.replace(
            "    ${MODE}=", "    ${RESULT}=").replace("${MODE}    fast-x", "${RESULT}    fast-x"))
        # A built-in reached through a loop cannot be renamed: refused, no edit.
        builtin = ("*** Test Cases ***\nT\n    FOR    ${_}    IN RANGE    2\n        Log    ${PREV TEST NAME}\n"
                   "        ${PREV TEST NAME}=    Set Variable    x\n    END\n")
        uri = self.write("loop_builtin.robot", builtin).as_uri()
        at = lambda line: self.base_site("loop_builtin.robot", builtin, line)
        self.assertEqual(self.refs_at(at(4)), {at(3), at(4)})
        for method, extra in (("textDocument/prepareRename", {}), ("textDocument/rename", {"newName": "x"})):
            with self.subTest(method=method):
                message = self.refused(method, builtin, "${PREV TEST NAME}=", uri, offset=2, **extra)
                self.assertEqual(message, "Cannot rename ${PREV TEST NAME}: the use at loop_builtin.robot:4 is in "
                                 "a FOR/WHILE loop that reassigns it, so it is also reached by a built-in variable.")

    def test_document_symbols_are_hierarchical_with_utf16_ranges(self):
        def symbol(name, kind, detail, whole, selection, children=()):
            return {"name": name, "kind": kind, "detail": detail, "range": whole, "selectionRange": selection,
                    "children": list(children)}

        def span(line, start, end_line, end):
            return {"start": {"line": line, "character": start}, "end": {"line": end_line, "character": end}}
        result = self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": self.uri}})
        record = span(11, 4, 11, 13)
        self.assertEqual(result, [
            symbol("${SUITE_VALUE}", 13, "Variable", span(5, 0, 5, 28), span(5, 0, 5, 14)),
            symbol("Debug Smoke", 6, "Test case", span(8, 0, 14, 25), span(8, 0, 8, 11),
                   [symbol("${record}", 13, "Local variable", record, record)]),
            symbol("Local Step", 12, "Keyword", span(17, 0, 19, 21), span(17, 0, 17, 10))])
        resource = self.root / "shared.resource"  # not open: read from disk
        value = span(2, 19, 2, 27)
        self.assertEqual(self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": resource.as_uri()}}),
                         [symbol("Resource Step", 12, "Keyword", span(1, 0, 4, utf16("    Log    ${value}")), span(1, 0, 1, 13),
                                 [symbol("${value}", 13, "Argument", value, value)])])
        tasks = self.write("tasks.robot", "*** Tasks ***\nAufgabe 😀 Grüße\n    ${ä😀}=    Set Variable    1\n")
        local = span(2, 4, 2, 4 + utf16("${ä😀}"))
        self.assertEqual(self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": tasks.as_uri()}}),
                         [symbol("Aufgabe 😀 Grüße", 6, "Task", span(1, 0, 2, utf16("    ${ä😀}=    Set Variable    1")),
                                 span(1, 0, 1, utf16("Aufgabe 😀 Grüße")),
                                 [symbol("${ä😀}", 13, "Local variable", local, local)])])
        library = (self.root / "AuditLibrary.py").as_uri()
        self.assertEqual(self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": library}}), [])

    def test_workspace_symbols_find_tests_and_keywords_in_unopened_files(self):
        self.write("extra.robot", "*** Test Cases ***\nExtra Täst 😀\n    Log    x\n")
        names = lambda query: {(s["name"], s["kind"], Path(s["location"]["uri"]).name, s["containerName"])
                               for s in self.client.request("workspace/symbol", {"query": query})}
        self.assertEqual(names("step"), {("Local Step", 12, "audit.robot", "Keyword · audit.robot"),
                                         ("Resource Step", 12, "shared.resource", "Keyword · shared.resource")})
        self.assertEqual(names("täst"), {("Extra Täst 😀", 6, "extra.robot", "Test case · extra.robot")})
        self.assertEqual(names("dbg smk"), {("Debug Smoke", 6, "audit.robot", "Test case · audit.robot")})
        self.assertEqual({n for n, *_ in names("")}, {"Local Step", "Resource Step", "Debug Smoke", "Extra Täst 😀"})
        self.assertEqual(names("zzz"), set())
        located = self.client.request("workspace/symbol", {"query": "Extra"})[0]["location"]
        self.assertEqual(located["range"], {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 13}})

    def test_references_and_symbols_follow_did_change_and_watched_files(self):
        local = {("audit.robot", 17, 0, 10), self.site("audit.robot", self.text, "    Local Step\n", offset=4)}
        self.assertEqual(self.refs(self.text, "Local Step"), local)
        changed = self.text.replace("    Log    ${record.name}\n", "    Local Step\n    Fresh Keyword\n") \
            + "Fresh Keyword\n    Local Step\n"
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.uri, "version": 2},
                                                   "contentChanges": [{"text": changed}]})
        calls = {self.site("audit.robot", changed, "    Local Step\n", occurrence=n, offset=4) for n in range(3)}
        self.assertEqual(self.refs(changed, "Local Step"), calls | {("audit.robot", 18, 0, 10)})
        outline = self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": self.uri}})
        self.assertEqual([s["name"] for s in outline], ["${SUITE_VALUE}", "Debug Smoke", "Local Step", "Fresh Keyword"])
        # Disk changes reported by workspace/didChangeWatchedFiles: created, changed, deleted.
        later = self.write("later.robot", "*** Settings ***\nResource    shared.resource\n*** Test Cases ***\n"
                                          "Later Test\n    Resource Step    x\n")
        watched = lambda kind: self.client.send("workspace/didChangeWatchedFiles",
                                                {"changes": [{"uri": later.as_uri(), "type": kind}]})
        watched(1)
        resource_refs = lambda: self.refs(changed, "Resource Step", include=False)
        in_audit = self.site("audit.robot", changed, "Resource Step")
        self.assertEqual(resource_refs(), {in_audit, ("later.robot", 4, 4, 17)})
        self.assertEqual(len(self.client.request("workspace/symbol", {"query": "later test"})), 1)
        later.write_text("*** Test Cases ***\nLater Test\n    No Operation\n", encoding="utf-8")
        watched(2)
        self.assertEqual(resource_refs(), {in_audit})
        later.unlink()
        watched(3)
        self.assertEqual(self.client.request("workspace/symbol", {"query": "later test"}), [])
        resource = self.root / "shared.resource"
        resource.write_text(resource.read_text(encoding="utf-8").replace("Resource Step", "Moved Step"), encoding="utf-8")
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": resource.as_uri(), "type": 2}]})
        self.assertEqual(self.refs(changed, "Resource Step"), set())
        self.assertEqual({s["name"] for s in self.client.request("workspace/symbol", {"query": "step"})},
                         {"Local Step", "Moved Step"})

    def test_workspace_folders_bound_the_scan(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "inner.robot").write_text("*** Keywords ***\nInner Step\n    No Operation\n", encoding="utf-8")
        client = Client()
        try:
            result = client.request("initialize", {"rootUri": None, "capabilities": {},
                                                   "workspaceFolders": [{"uri": sub.as_uri(), "name": "sub"}]})
            # Without client prepareSupport / hierarchy / CodeAction literal support: plain renameProvider,
            # flat symbols and no code actions.
            self.assertEqual(result["capabilities"], {**WITHOUT_CODE_ACTIONS, "renameProvider": True})
            client.send("initialized", {})
            self.assertEqual([s["name"] for s in client.request("workspace/symbol", {"query": ""})], ["Inner Step"])
            inner = (sub / "inner.robot").as_uri()
            self.assertEqual(client.request("textDocument/documentSymbol", {"textDocument": {"uri": inner}}), [
                {"name": "Inner Step", "kind": 12, "location": {"uri": inner, "range": {
                    "start": {"line": 1, "character": 0}, "end": {"line": 2, "character": 16}}}}])
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()


class DiagnosticsSchedulingTests(unittest.TestCase):
    def test_obsolete_publications_are_discarded_and_only_latest_pending_snapshot_is_run(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        sent, published, trees = [], [], []

        class Tree:
            def __init__(self, *args, **kwargs):
                self.process = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO())
                self.stopped = False
                trees.append(self)

            def stop(self):
                self.stopped = True
                release.set()

            def close(self):
                self.closed = True

        class Stream:
            def __init__(self, *args):
                self.complete = False

            def write(self, message):
                if message["method"] == "snapshot":
                    self.generation = message["generation"]
                    sent.append(self.generation)
                    self.complete = False
                elif message["method"] == "document":
                    self.version = message["version"]

            def read(self):
                if not self.complete:
                    entered.set()
                    self.assert_release()
                    self.complete = True
                    return {"method": "textDocument/publishDiagnostics", "params": {"version": self.version}}
                return {"method": "complete"}

            @staticmethod
            def assert_release():
                if not release.wait(5):
                    raise AssertionError("Test did not release the controlled analysis")

        workspace = Workspace()
        path = Path(tempfile.gettempdir()) / "scheduling.robot"
        workspace.documents[path] = (1, "first")
        def notify(method, params):
            published.append((method, params))
            finished.set()
        with mock.patch.object(diagnostic_worker, "ProcessTree", Tree), \
                mock.patch.object(diagnostic_worker, "FramedStream", Stream):
            worker = diagnostic_worker.DiagnosticsWorker(notify)
            try:
                worker.submit(workspace, None)
                self.assertTrue(entered.wait(5))
                workspace.documents[path] = (2, "intermediate")
                worker.submit(workspace, None)
                workspace.documents[path] = (3, "latest unsaved text")
                worker.submit(workspace, None)
                release.set()
                self.assertTrue(finished.wait(5))
            finally:
                worker.close()
        self.assertEqual(sent, [1, 3])
        self.assertEqual(published, [("textDocument/publishDiagnostics", {"version": 3})])
        self.assertTrue(trees[0].stopped)
        self.assertTrue(trees[0].closed)
        self.assertIsNone(worker.thread)


    def test_cleanup_failure_is_reported_and_job_handle_closes_even_when_pipe_close_fails(self):
        stopped = threading.Event()
        published, trees = [], []
        actual_process_tree = diagnostic_worker.ProcessTree

        class Pipe(io.BytesIO):
            def close(self):
                if not self.closed:
                    super().close()
                    raise OSError("synthetic pipe close failure")

        class Tree:
            def __init__(self, *args, **kwargs):
                self.process = SimpleNamespace(stdin=Pipe(), stdout=io.BytesIO())
                self.closed = False
                self.report = kwargs["report"]
                trees.append(self)

            def stop(self):
                # Exercise the real list-valued callback, then the same returned
                # problem. The worker must record one string and report it once.
                problems = []
                actual_process_tree._problem(self, problems, "synthetic stop failure")
                return problems

            def close(self):
                self.closed = True
                stopped.set()

        class Stream:
            def __init__(self, *args):
                pass

            def write(self, message):
                pass

            def read(self):
                raise OSError("synthetic worker loss")

        with mock.patch.object(diagnostic_worker, "ProcessTree", Tree), \
                mock.patch.object(diagnostic_worker, "FramedStream", Stream), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            worker = diagnostic_worker.DiagnosticsWorker(lambda *message: published.append(message))
            worker.submit(Workspace(), None)
            self.assertTrue(stopped.wait(5))
            with self.assertRaisesRegex(RuntimeError, "synthetic stop failure"):
                worker.close()
        self.assertTrue(trees[0].closed)
        self.assertIsNone(worker.thread)
        self.assertEqual(worker.cleanup_problems.count("synthetic stop failure"), 1)
        self.assertTrue(all(isinstance(problem, str) for problem in worker.cleanup_problems))
        self.assertEqual(errors.getvalue().count("synthetic stop failure"), 1)
        self.assertIn("synthetic pipe close failure", errors.getvalue())
        self.assertTrue(any(message[0] == "window/logMessage" for message in published))


class LiveResponsivenessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rcb large diagnostics-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.resource = self.root / "shared.resource"
        self.resource.write_text("*** Keywords ***\nImported Step\n    No Operation\n", encoding="utf-8")
        self.text = ("*** Variables ***\n${value}    sample\n*** Settings ***\nResource    shared.resource\n"
                     "*** Test Cases ***\nT\n    Imported Step\n" + "    Log    ${value}\n" * 40)
        self.suite = self.root / "main.robot"
        self.suite.write_text(self.text, encoding="utf-8")
        self.client = Client(cwd=self.root)
        self.addCleanup(self.client.close)
        self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})

    def open(self, path, text, version=1):
        self.client.send("textDocument/didOpen", {"textDocument": {
            "uri": path.as_uri(), "text": text, "version": version}})

    def definition(self):
        return self.client.request("textDocument/definition", {
            "textDocument": {"uri": self.suite.as_uri()}, "position": {"line": 6, "character": 9}})

    def test_large_importer_fanout_does_not_block_f12_and_owned_worker_stops(self):
        for index in range(3000):
            (self.root / f"case{index}.robot").write_text(self.text, encoding="utf-8")
        self.open(self.suite, self.text)
        self.open(self.resource, self.resource.read_text(encoding="utf-8"))
        started = time.monotonic()
        found = self.definition()
        self.assertLess(time.monotonic() - started, 3, "Push diagnostics blocked import-scoped navigation")
        self.assertEqual([uri_file(item["uri"]) for item in found], [self.resource])
        self.assertEqual(found[0]["range"]["start"], {"line": 1, "character": 0})
        # Prove all files still participate: a distant runtime setter suppresses
        # the unknown-variable warning of the current suite's newest overlay.
        last = self.root / "case2999.robot"
        last.write_text(self.text + "    Set Global Variable    ${from_distant_suite}    value\n", encoding="utf-8")
        changed = self.text + "    Log    ${from_distant_suite}\n"
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.suite.as_uri(), "version": 2},
                                                   "contentChanges": [{"text": changed}]})
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": last.as_uri(), "type": 2}]})
        published = self.client.wait_diagnostics(self.suite.as_uri(), 2, timeout=60)
        self.assertEqual(published["diagnostics"], [])
        owned = processes.descendants(self.client.backend_pid)
        self.assertTrue(owned, "Expected the owned persistent diagnostics worker")
        self.client.request("shutdown")
        self.client.send("exit")
        self.assertEqual(self.client.process.wait(timeout=5), 0)
        remaining = processes.snapshot()
        self.assertFalse({pid for pid, identity in owned.items() if pid in remaining and
                          remaining[pid]["start"] == identity["start"] and remaining[pid]["state"] != "Z"})
        self.assertFalse(self.client.forced_cleanup)

    def test_eof_stops_and_reaps_the_owned_diagnostics_worker(self):
        self.open(self.suite, self.text)
        self.client.wait_diagnostics(self.suite.as_uri(), 1)
        owned = processes.descendants(self.client.backend_pid)
        self.assertTrue(owned)
        self.client.process.stdin.close()
        self.assertEqual(self.client.process.wait(timeout=5), 1)  # EOF without shutdown
        remaining = processes.snapshot()
        self.assertFalse({pid for pid, identity in owned.items() if pid in remaining and
                          remaining[pid]["start"] == identity["start"] and remaining[pid]["state"] != "Z"})
        self.assertFalse(self.client.forced_cleanup)

    def test_nested_suite_resolves_workspace_root_resource_paths_without_explicit_pythonpath(self):
        bavl = self.root / "BAVL"
        mockserver = self.root / "MockServer"
        nested = bavl / "Testcases/Zahllauf"
        nested.mkdir(parents=True)
        mockserver.mkdir()
        (bavl / "Keywords.resource").write_text("*** Keywords ***\nPrüfen\n    No Operation\n", encoding="utf-8")
        (mockserver / "Keywords.resource").write_text("*** Keywords ***\nMock Antwort\n    No Operation\n", encoding="utf-8")
        suite = nested / "Zahllauf_IKS_Mehraugenpruefung.robot"
        text = ("*** Settings ***\nResource    BAVL/Keywords.resource\nResource    MockServer/Keywords.resource\n"
                "*** Test Cases ***\nT\n    Prüfen\n")
        suite.write_text(text, encoding="utf-8")
        client = Client(cwd=self.root)
        try:
            client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {},
                "initializationOptions": {"robotConfiguration": {
                    "version": 1, "cwd": str(self.root), "robotArguments": []}}})
            client.send("textDocument/didOpen", {"textDocument": {
                "uri": suite.as_uri(), "text": text, "version": 1}})
            found = client.request("textDocument/definition", {"textDocument": {"uri": suite.as_uri()},
                                                               "position": {"line": 5, "character": 7}})
            self.assertEqual([uri_file(item["uri"]) for item in found], [bavl / "Keywords.resource"])
            self.assertEqual(client.wait_diagnostics(suite.as_uri(), 1)["diagnostics"], [])
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()

    def test_create_edit_delete_import_change_and_unsaved_overlay_remain_current(self):
        self.open(self.suite, self.text)
        self.assertEqual(uri_file(self.definition()[0]["uri"]), self.resource)
        old = len(self.client.notifications)
        self.resource.unlink()
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": self.resource.as_uri(), "type": 3}]})
        self.assertEqual(self.definition(), [])
        missing = self.client.wait_diagnostics(self.suite.as_uri(), 1, since=old)
        self.assertTrue(any(item["code"] == "import" for item in missing["diagnostics"]))
        self.resource.write_text("*** Keywords ***\nDifferent Step\n    No Operation\n", encoding="utf-8")
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": self.resource.as_uri(), "type": 1}]})
        self.assertEqual(self.definition(), [])
        self.open(self.resource, "*** Keywords ***\nImported Step\n    No Operation\n")
        self.assertEqual(uri_file(self.definition()[0]["uri"]), self.resource)
        self.client.wait_diagnostics(self.resource.as_uri(), 1)
        old = len(self.client.notifications)
        self.client.send("textDocument/didClose", {"textDocument": {"uri": self.resource.as_uri()}})
        self.assertEqual(self.definition(), [])
        disk = self.client.wait_diagnostics(self.suite.as_uri(), 1, since=old)
        self.assertTrue(any(item["code"] == "unknown-keyword" for item in disk["diagnostics"]))
        alternate = self.root / "alternate.resource"
        alternate.write_text("*** Keywords ***\nImported Step\n    No Operation\n", encoding="utf-8")
        changed = self.text.replace("shared.resource", "alternate.resource")
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.suite.as_uri(), "version": 2},
                                                   "contentChanges": [{"text": changed}]})
        self.assertEqual(uri_file(self.definition()[0]["uri"]), alternate)
        self.assertEqual(self.client.wait_diagnostics(self.suite.as_uri(), 2)["diagnostics"], [])


if __name__ == "__main__":
    unittest.main()

"""Mandatory RF 7.5 references, rename and document/workspace symbol conformance. Never skips."""

from pathlib import Path
import unittest

from client import Client
from test_lsp_live import CAPABILITIES, LanguageTestCase

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
        library = (self.root / "AuditLibrary.py").read_text()
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
        self.assertEqual(self.refs(resource.read_text(), "Resource Step", resource.as_uri()), expected)
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

    def test_rename_refuses_library_standard_ambiguous_and_invalid_names(self):
        message = self.refused("textDocument/prepareRename", self.text, "Build Record")
        self.assertIn("Python library AuditLibrary.py", message)
        self.assertIn("not supported", message)
        self.assertEqual(self.refused("textDocument/rename", self.text, "Build Record", newName="X"), message)
        library = self.root / "AuditLibrary.py"
        self.assertIn("Python library AuditLibrary.py",
                      self.refused("textDocument/rename", library.read_text(), "build_record", library.as_uri(),
                                   newName="X"))
        self.assertIn("standard library keyword (BuiltIn)",
                      self.refused("textDocument/rename", self.text, "    Log", offset=4, newName="X"))
        self.write("one.resource", "*** Keywords ***\nDup Step\n    No Operation\n")
        self.write("two.resource", "*** Keywords ***\nDup Step\n    No Operation\n")
        self.write("dup.robot", "*** Settings ***\nResource    one.resource\nResource    two.resource\n"
                                "*** Test Cases ***\nT\n    Dup Step\n")
        one = self.root / "one.resource"
        self.assertIn("dup.robot:6 is ambiguous", self.refused("textDocument/rename", one.read_text(), "Dup Step",
                                                                one.as_uri(), newName="Single Step"))
        dup = self.root / "dup.robot"
        self.assertIn("ambiguous", self.refused("textDocument/prepareRename", dup.read_text(), "    Dup Step",
                                                dup.as_uri(), offset=4))
        for invalid in ("Two  cells", "Has\ttab", "${var} name", "", "# comment"):
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
        self.assertEqual(len(self.refs(changed, "Local Step")), 4)
        outline = self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": self.uri}})
        self.assertEqual([s["name"] for s in outline], ["${SUITE_VALUE}", "Debug Smoke", "Local Step", "Fresh Keyword"])
        # Disk changes reported by workspace/didChangeWatchedFiles: created, changed, deleted.
        later = self.write("later.robot", "*** Settings ***\nResource    shared.resource\n*** Test Cases ***\n"
                                          "Later Test\n    Resource Step    x\n")
        watched = lambda kind: self.client.send("workspace/didChangeWatchedFiles",
                                                {"changes": [{"uri": later.as_uri(), "type": kind}]})
        watched(1)
        resource_refs = lambda: {name for name, *_ in self.refs(changed, "Resource Step", include=False)}
        self.assertEqual(resource_refs(), {"audit.robot", "later.robot"})
        self.assertEqual(len(self.client.request("workspace/symbol", {"query": "later test"})), 1)
        later.write_text("*** Test Cases ***\nLater Test\n    No Operation\n")
        watched(2)
        self.assertEqual(resource_refs(), {"audit.robot"})
        later.unlink()
        watched(3)
        self.assertEqual(self.client.request("workspace/symbol", {"query": "later test"}), [])
        resource = self.root / "shared.resource"
        resource.write_text(resource.read_text().replace("Resource Step", "Moved Step"))
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": resource.as_uri(), "type": 2}]})
        self.assertEqual(self.refs(changed, "Resource Step"), set())
        self.assertEqual({s["name"] for s in self.client.request("workspace/symbol", {"query": "step"})},
                         {"Local Step", "Moved Step"})

    def test_workspace_folders_bound_the_scan(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "inner.robot").write_text("*** Keywords ***\nInner Step\n    No Operation\n")
        client = Client()
        try:
            result = client.request("initialize", {"rootUri": None, "capabilities": {},
                                                   "workspaceFolders": [{"uri": sub.as_uri(), "name": "sub"}]})
            self.assertEqual(result["capabilities"], CAPABILITIES)
            client.send("initialized", {})
            self.assertEqual([s["name"] for s in client.request("workspace/symbol", {"query": ""})], ["Inner Step"])
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()

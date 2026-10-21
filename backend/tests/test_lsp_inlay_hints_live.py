"""Required real-process inlay hint conformance over the named synthetic corpus. Never skips.

`inlay_fixtures/hints.robot` names its cases by test: imported aliases (`Imported Alias`),
ambiguous and shadowed keywords (`Ambiguous And Shadow`), variables (`Variables`) and UTF-16
positions (`Unicode 😀 Positions`). `Unimported.py` defines `Build Record` too but is not
imported, so its argument name `label` and return type `int` must never appear.
"""

from pathlib import Path
import shutil
import unittest

from test_lsp_live import LanguageTestCase

TYPE, PARAMETER = 1, 2
FIXTURES = Path(__file__).parent / "inlay_fixtures"
EVERYTHING = {"start": {"line": 0, "character": 0}, "end": {"line": 10000, "character": 0}}


def units(text):
    return len(text.encode("utf-16-le")) // 2


class InlayHintTests(LanguageTestCase):

    def setUp(self):
        super().setUp()
        shutil.copytree(FIXTURES, self.root / "inlay")
        self.hints_path = self.root / "inlay" / "hints.robot"
        self.hints_uri = self.hints_path.as_uri()
        self.hints_text = self.hints_path.read_text(encoding="utf-8")
        self.open(self.hints_uri, self.hints_text)

    def request(self, uri=None, request_range=EVERYTHING):
        return self.client.request("textDocument/inlayHint", {"textDocument": {"uri": uri or self.hints_uri},
                                                               "range": request_range})

    def shown(self, text, uri=None, request_range=EVERYTHING):
        """(line text, text before the hint, label, kind), decoding each UTF-16 position on its line."""
        lines = text.split("\n")
        result = []
        for hint in self.request(uri, request_range):
            self.assertEqual(set(hint), {"position", "label", "kind", "tooltip"})
            line, character = hint["position"]["line"], hint["position"]["character"]
            encoded = lines[line].encode("utf-16-le")
            self.assertLessEqual(character, len(encoded) // 2, hint)
            result.append((lines[line].strip(), encoded[:character * 2].decode("utf-16-le").strip(), hint["label"],
                           hint["kind"]))
        return result

    def test_named_corpus_exact_hints(self):
        shown = self.shown(self.hints_text)
        for label in ("label=", ": int"):  # Unimported.py's `Build Record` is never chosen
            self.assertNotIn(label, [hint[2] for hint in shown])
        alias = "${record}=    Audit.Build Record    Ada"
        unqualified = "${unqualified}    Build Record    Ada"
        joined = "${joined}=    Combine    head    ${LIST}[0]    tail    more"
        unicode_line = "Combine    Äöü 😀    𝔘 ${GRÜẞE}"
        self.assertEqual(shown, [
            ("Suite Setup    Log    suite-start", "Suite Setup    Log", "message=", PARAMETER),
            # Imported Alias: `AS Audit` qualifies the call; the alias does not change its signature.
            (alias, "${record}", ": Record", TYPE),
            (alias, "${record}=    Audit.Build Record", "name=", PARAMETER),
            ("${named}=    Audit.Build Record    name=Ada", "${named}", ": Record", TYPE),
            (unqualified, "${unqualified}", ": Record", TYPE),
            (unqualified, "${unqualified}    Build Record", "name=", PARAMETER),
            # A typed or multiple assignment gets no return type.
            ("${typed: str}=    Audit.Build Record    Ada", "${typed: str}=    Audit.Build Record", "name=", PARAMETER),
            ("${first}    ${second}=    Audit.Build Record    Ada", "${first}    ${second}=    Audit.Build Record", "name=",
             PARAMETER),
            ("Audit.Build Record    Ada", "Audit.Build Record", "name=", PARAMETER),
            # Ambiguous And Shadow: the unqualified twin, an unknown and an embedded call get none.
            ("TwinA.Twin Step    one", "TwinA.Twin Step", "left=", PARAMETER),
            ("TwinB.Twin Step    one", "TwinB.Twin Step", "right=", PARAMETER),
            ("Shadowed Step    one", "Shadowed Step", "local=", PARAMETER),  # the local keyword wins
            # Variables: a variable is an argument value; nothing is mapped after an expansion,
            # a named argument or the last positional parameter (`*rest`).
            ("Resource Step    ${GRÜẞE}", "Resource Step", "value=", PARAMETER),
            (joined, "${joined}", ": str", TYPE),
            (joined, "${joined}=    Combine", "first:", PARAMETER),  # positional-only
            (joined, "${joined}=    Combine    head", "second=", PARAMETER),
            ("Combine    head    &{MAP}", "Combine", "first:", PARAMETER),
            ("Combine    head    second=${GRÜẞE}    tail", "Combine", "first:", PARAMETER),
            ("Combine    left\\=escaped", "Combine", "first:", PARAMETER),  # an escaped `=` is positional
            # Unicode 😀 Positions
            (unicode_line, "Combine", "first:", PARAMETER),
            (unicode_line, "Combine    Äöü 😀", "second=", PARAMETER),
            ("...    😀 first", "...", "first:", PARAMETER),
            ("...    𝔘 second", "...", "second=", PARAMETER),
            ("Log    ${local}", "Log", "message=", PARAMETER),
            ("Log    ${name}", "Log", "message=", PARAMETER),
        ])

    def test_positions_are_utf16_units_not_code_points(self):
        lines = self.hints_text.split("\n")
        line = next(i for i, value in enumerate(lines) if value == "    Combine    Äöü 😀    𝔘 ${GRÜẞE}")
        before = "    Combine    Äöü 😀    "
        hints = [h for h in self.request() if h["position"]["line"] == line]
        self.assertEqual([(h["position"]["character"], h["label"]) for h in hints],
                         [(15, "first:"), (units(before), "second=")])
        self.assertEqual(units(before), 25)
        self.assertNotEqual(units(before), len(before))  # 😀 is two UTF-16 units
        continued = next(i for i, value in enumerate(lines) if value == "    ...    𝔘 second")
        self.assertEqual([(h["position"], h["label"]) for h in self.request() if h["position"]["line"] == continued],
                         [({"line": continued, "character": 11}, "second=")])

    def test_tooltips_name_the_resolved_definition(self):
        tooltips = {(h["position"]["line"], h["label"]): h["tooltip"] for h in self.request()}
        lines = self.hints_text.split("\n")
        alias = lines.index("    ${record}=    Audit.Build Record    Ada")
        self.assertEqual(tooltips[(alias, "name=")], "Argument name of Build Record · Library Audit · AuditLibrary.py")
        self.assertEqual(tooltips[(alias, ": Record")],
                         "Declared return type of Build Record · Library Audit · AuditLibrary.py")
        shadow = lines.index("    Shadowed Step    one")
        self.assertEqual(tooltips[(shadow, "local=")], "Argument local of Shadowed Step · Local keyword · hints.robot")

    def test_hints_follow_document_edits_and_changed_dependencies(self):
        edited = self.hints_text.replace("    Twin Step    one\n", "    TwinA.Twin Step    two\n    Twin Step    one\n") \
            .replace("\n    Audit.Build Record    Ada\n", "\n    Audit.Build Record    name=Ada\n")
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.hints_uri, "version": 2},
                                                   "contentChanges": [{"text": edited}]})
        shown = self.shown(edited)
        self.assertIn(("TwinA.Twin Step    two", "TwinA.Twin Step", "left=", PARAMETER), shown)
        self.assertNotIn("Audit.Build Record    Ada", [hint[0] for hint in shown])  # now named: no hint
        # A changed library on disk, announced as a watched-file change.
        twin = self.root / "inlay" / "TwinA.py"
        twin.write_text(twin.read_text().replace("def twin_step(left):\n    return left",
                                                 "def twin_step(renamed):\n    return renamed"))
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": twin.as_uri(), "type": 2}]})
        labels = [hint[2] for hint in self.shown(edited) if hint[0].startswith("TwinA.Twin Step")]
        self.assertEqual(labels, ["renamed=", "renamed="])
        # An unsaved resource document's arguments, not its disk content.
        resource = self.root / "inlay" / "shared.resource"
        self.open(resource.as_uri(), resource.read_text().replace("${value}", "${changed}"))
        self.assertIn(("Resource Step    ${GRÜẞE}", "Resource Step", "changed=", PARAMETER), self.shown(edited))

    def test_range_bounds_and_refusals(self):
        lines = self.hints_text.split("\n")
        first, last = lines.index("Imported Alias"), lines.index("Ambiguous And Shadow")
        part = self.request(request_range={"start": {"line": first, "character": 0}, "end": {"line": last, "character": 0}})
        self.assertEqual({h["position"]["line"] for h in part}, set(range(first + 1, last - 1)))
        # Both ends are included: a range of exactly one hint position.
        alias = lines.index("    ${record}=    Audit.Build Record    Ada")
        point = {"line": alias, "character": units("    ${record}")}
        self.assertEqual([h["label"] for h in self.request(request_range={"start": point, "end": point})], [": Record"])
        for invalid in ({"start": {"line": 3, "character": 0}, "end": {"line": 2, "character": 0}},
                        {"start": {"line": -1, "character": 0}, "end": {"line": 2, "character": 0}},
                        {"start": {"line": 0, "character": "0"}, "end": {"line": 2, "character": 0}}):
            with self.subTest(invalid=invalid), self.assertRaises(AssertionError) as raised:
                self.request(request_range=invalid)
            self.assertEqual(raised.exception.args[0]["error"]["code"], -32602)
        self.assertEqual(self.request((self.root / "inlay" / "TwinA.py").as_uri()), [])
        self.assertEqual([h["label"] for h in self.request(self.uri)], [": Record", "value=", "message=", "message="])
        # A Robot file that is not open is read from disk.
        disk = self.root / "inlay" / "disk.robot"
        disk.write_text("*** Settings ***\nLibrary    TwinB.py\n\n*** Test Cases ***\nT\n    Twin Step    x\n")
        self.assertEqual(self.request(disk.as_uri()), [{"position": {"line": 5, "character": 17}, "label": "right=",
                                                        "kind": PARAMETER,
                                                        "tooltip": "Argument right of Twin Step · Library TwinB · TwinB.py"}])

    def test_lsp_line_breaks_and_rf_only_breaks(self):
        # CRLF and a lone CR are LSP line breaks; U+2028 in a comment breaks only RF's lines.
        text = ("*** Settings ***\r\nLibrary    CombineLibrary.py\r\n\r\n*** Test Cases ***\r\nT\r\n"
                "    # note more\r    Combine    😀    𝔘\r\n")
        uri = (self.root / "inlay" / "breaks.robot").as_uri()
        self.open(uri, text)
        self.assertEqual([(h["position"], h["label"]) for h in self.request(uri)],
                         [({"line": 6, "character": 15}, "first:"), ({"line": 6, "character": 21}, "second=")])


if __name__ == "__main__":
    unittest.main()

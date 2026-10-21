"""Required real-process semantic token conformance with each supported runtime row. Never skips."""

import random
import re
import unittest

from robot_companion_backend import semantic_tokens

from client import Client
from test_lsp_live import CAPABILITIES, LanguageTestCase

TYPES = CAPABILITIES["semanticTokensProvider"]["legend"]["tokenTypes"]
MODIFIERS = CAPABILITIES["semanticTokensProvider"]["legend"]["tokenModifiers"]
EDGE = """*** Settings ***
Library    AuditLibrary.py
Resource    shared.resource
Suite Setup    Log    ${GRÜẞE}    # suite comment

*** Variables ***
${GRÜẞE}    Grüße 😀
@{LIST}    a    b
...    c
&{MAP}    k=v

*** Tasks ***
Prüfe 😀 ${GRÜẞE}
    Given Build Record    name=${GRÜẞE}
    When Resource Step    😀${LIST}[0]
    Then Local Step
    And Missing Keyword    %{HOME=x}
    But Log Many    @{LIST}    &{MAP}
\tLog\ttab\t${GRÜẞE}
    Log Many    first
    ...    ${GRÜẞE}
    Greet ${GRÜẞE} Kindly
    Given Literal Name
    FOR    ${i}    IN RANGE    2
        IF    ${i} == 1    BREAK
    END
    TRY
        Fail    x
    EXCEPT    AS    ${err}
        Log    ${err}
    FINALLY
        Log    done
    END
    WHILE    False
        Log    never
    END

*** Keywords ***
Local Step
    ${value}=    Set Variable    😀
    VAR    ${other}    ${value}
    RETURN    ${other}
Greet ${name} Kindly
    Log    ${name}
Given Literal Name
    No Operation

*** Comments ***
free    text
"""
# RF breaks lines at U+2028 and form feeds, LSP clients do not; the rest is RF parsing errors.
BROKEN = ("*** Test Cases ***\nT\n    FOR    ${i}    IN\n    Log    😀 ${ä}\n*** Bogus ***\nfoo    bar\n"
          "*** Keywords ***\nK ${a}\n    Log    x     ${y}\n    Log\f    ${z}\n    Missing Keyword    ${open\n"
          "    IF    True\nL\n    [Invalid]    y    # note\n")
RESOURCE = ("*** Variables ***\r\n${Ä😀}    1\r\n*** Keywords ***\r\nRésumé Step\r\n"
            "    [Arguments]    ${v}=${Ä😀}\r\n    Log Many    ${v}\r\n    ...    @{EMPTY}    &{EMPTY}\r\n")


def lsp_lines(text):
    return re.split(r"\r\n|\r|\n", text)


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def apply_edits(data, edits):
    """LSP SemanticTokensDelta semantics: edits in ascending order, each relative to `data`."""
    result, position = [], 0
    for edit in edits:
        assert set(edit) <= {"start", "deleteCount", "data"} and edit["start"] >= position, edit
        result += data[position:edit["start"]] + edit.get("data", [])
        position = edit["start"] + edit["deleteCount"]
        assert position <= len(data), edit
    return result + data[position:]


class SemanticTokenTests(LanguageTestCase):
    def full(self, uri=None):
        return self.client.request("textDocument/semanticTokens/full", {"textDocument": {"uri": uri or self.uri}})

    def range(self, start, end, uri=None):
        return self.client.request("textDocument/semanticTokens/range", {
            "textDocument": {"uri": uri or self.uri},
            "range": {"start": {"line": start[0], "character": start[1]},
                      "end": {"line": end[0], "character": end[1]}}})

    def delta(self, previous_result_id, uri=None):
        return self.client.request("textDocument/semanticTokens/full/delta", {
            "textDocument": {"uri": uri or self.uri}, "previousResultId": previous_result_id})

    def change(self, text, version, uri=None):
        self.client.send("textDocument/didChange", {"textDocument": {"uri": uri or self.uri, "version": version},
                                                   "contentChanges": [{"text": text}]})

    def fresh_full(self, text, name="audit.robot"):
        """A whole-document result of a newly started service process that saw only `text`."""
        client = Client()
        try:
            client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            client.send("initialized", {})
            uri = (self.root / name).as_uri()
            client.send("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": "robotframework", "version": 1, "text": text}})
            result = client.request("textDocument/semanticTokens/full", {"textDocument": {"uri": uri}})
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
            return result
        finally:
            client.close()

    def decode(self, result, text):
        """Relative LSP data -> {line: [(UTF-16 start, length, text, type, [modifiers])]}, checking
        every token lies on one existing LSP line and that tokens do not overlap."""
        data = result["data"]
        self.assertIn(set(result), ({"data"}, {"data", "resultId"}))
        self.assertEqual(len(data) % 5, 0)
        lines, decoded = lsp_lines(text), {}
        line = start = 0
        previous_end = None
        for index in range(0, len(data), 5):
            delta_line, delta_start, length, kind, bits = data[index:index + 5]
            self.assertTrue(delta_line >= 0 and delta_start >= 0 and length > 0, data[index:index + 5])
            start = start + delta_start if delta_line == 0 else delta_start
            line += delta_line
            if delta_line == 0 and previous_end is not None:
                self.assertGreaterEqual(start, previous_end, "overlapping tokens")
            self.assertLess(line, len(lines))
            units = lines[line].encode("utf-16-le")
            self.assertLessEqual(start + length, len(units) // 2, f"token out of range on line {line}")
            value = units[start * 2:(start + length) * 2].decode("utf-16-le")
            self.assertLess(bits, 1 << len(MODIFIERS))
            decoded.setdefault(line, []).append(
                (start, length, value, TYPES[kind], [m for i, m in enumerate(MODIFIERS) if bits & (1 << i)]))
            previous_end = start + length
        return decoded

    def test_capability_advertises_documented_legend_with_delta(self):
        # setUp asserted the complete capabilities for an editor; a bare client gets the same provider.
        client = Client()
        try:
            result = client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            self.assertEqual(result["capabilities"]["semanticTokensProvider"], {
                "legend": {"tokenTypes": ["namespace", "property", "class", "function", "variable", "comment",
                                          "keyword", "macro", "operator"],
                           "tokenModifiers": ["declaration", "resolved", "defaultLibrary"]},
                "full": {"delta": True}, "range": True})
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()

    def test_audit_fixture_exact_relative_encoding(self):
        result = self.full()
        # Exact LSP 3.17 relative data: [deltaLine, deltaStart, length, type, modifiers] per token.
        self.assertEqual(result["data"], [
            0, 0, 16, 0, 0,     # *** Settings ***            namespace
            1, 0, 7, 1, 0,      # Library                     property
            1, 0, 8, 1, 0,      # Resource                    property
            2, 0, 17, 0, 0,     # *** Variables ***           namespace
            1, 0, 14, 4, 1,     # ${SUITE_VALUE}              variable declaration
            2, 0, 18, 0, 0,     # *** Test Cases ***          namespace
            1, 0, 11, 2, 1,     # Debug Smoke                 class declaration
            1, 4, 15, 1, 0,     # [Documentation]             property
            1, 4, 55, 5, 0,     # #> Build a typed record...  comment
            1, 4, 9, 4, 1,      # ${record}                   variable declaration
            0, 14, 12, 3, 2,    # Build Record                function resolved (AuditLibrary.py)
            1, 4, 13, 3, 2,     # Resource Step               function resolved (shared.resource)
            0, 17, 14, 4, 0,    # ${record.name}              variable
            1, 4, 10, 3, 2,     # Local Step                  function resolved (local)
            1, 4, 3, 3, 6,      # Log                         function resolved defaultLibrary (BuiltIn)
            0, 7, 14, 4, 0,     # ${record.name}              variable
            2, 0, 16, 0, 0,     # *** Keywords ***            namespace
            1, 0, 10, 3, 1,     # Local Step                  function declaration
            1, 4, 15, 1, 0,     # [Documentation]             property
            1, 4, 3, 3, 6,      # Log                         function resolved defaultLibrary
        ])
        # The resolved Build Record call is the one definition finds: AuditLibrary.py, never AShadow.py.
        location = self.definition(self.text, "Build Record")
        self.assertEqual([loc["uri"].rsplit("/", 1)[-1] for loc in location], ["AuditLibrary.py"])

    def test_unimported_or_missing_keywords_are_not_resolved(self):
        # AShadow.py defines `Build Record` but is not imported: as for definition, nothing resolves.
        text = ("*** Test Cases ***\nT\n    Build Record\n    Nonexistent Keyword    ${x}\n"
                "    Given Nonexistent Keyword\n    ${prefix}[0] Step\n")
        self.open(self.uri, text, 2)
        tokens = self.decode(self.full(), text)
        self.assertEqual(self.definition(text, "Build Record"), [])
        self.assertEqual(tokens[2], [(4, 12, "Build Record", "function", [])])
        self.assertEqual(tokens[3], [(4, 19, "Nonexistent Keyword", "function", []),
                                     (27, 4, "${x}", "variable", [])])
        self.assertEqual(tokens[4], [(4, 5, "Given", "macro", []),
                                     (10, 19, "Nonexistent Keyword", "function", [])])
        # A call named partly by a variable is known only at run time.
        # Its item access `[0]` belongs to the variable and is no part of the keyword name.
        self.assertEqual(tokens[5], [(4, 9, "${prefix}", "variable", []), (17, 4, "Step", "function", [])])

    def test_edge_cases_from_the_robot_model(self):
        self.open(self.uri, EDGE, 2)
        tokens = self.decode(self.full(), EDGE)
        library = ["resolved", "defaultLibrary"]
        expected = {
            0: [(0, 16, "*** Settings ***", "namespace", [])],
            1: [(0, 7, "Library", "property", [])],  # import names are not tokenized
            2: [(0, 8, "Resource", "property", [])],
            # Setting, keyword setting cell, variable, trailing comment.
            3: [(0, 11, "Suite Setup", "property", []), (15, 3, "Log", "function", ["resolved", "defaultLibrary"]),
                (22, 8, "${GRÜẞE}", "variable", []), (34, 15, "# suite comment", "comment", [])],
            5: [(0, 17, "*** Variables ***", "namespace", [])],
            6: [(0, 8, "${GRÜẞE}", "variable", ["declaration"])],
            7: [(0, 7, "@{LIST}", "variable", ["declaration"])],
            8: [(0, 3, "...", "operator", [])],
            9: [(0, 6, "&{MAP}", "variable", ["declaration"])],
            11: [(0, 13, "*** Tasks ***", "namespace", [])],
            # Umlaut and non-BMP text before an embedded variable in a task name: UTF-16 offsets.
            12: [(0, 8, "Prüfe 😀", "class", ["declaration"]), (9, 8, "${GRÜẞE}", "variable", [])],
            # BDD prefixes on library, resource, local, missing and standard-library calls.
            13: [(4, 5, "Given", "macro", []), (10, 12, "Build Record", "function", ["resolved"]),
                 (31, 8, "${GRÜẞE}", "variable", [])],
            14: [(4, 4, "When", "macro", []), (9, 13, "Resource Step", "function", ["resolved"]),
                 (28, 7, "${LIST}", "variable", [])],
            15: [(4, 4, "Then", "macro", []), (9, 10, "Local Step", "function", ["resolved"])],
            16: [(4, 3, "And", "macro", []), (8, 15, "Missing Keyword", "function", []),
                 (27, 9, "%{HOME=x}", "variable", [])],
            17: [(4, 3, "But", "macro", []), (8, 8, "Log Many", "function", ["resolved", "defaultLibrary"]),
                 (20, 7, "@{LIST}", "variable", []), (31, 6, "&{MAP}", "variable", [])],
            # Tab separators.
            18: [(1, 3, "Log", "function", ["resolved", "defaultLibrary"]), (9, 8, "${GRÜẞE}", "variable", [])],
            19: [(4, 8, "Log Many", "function", library)],
            # Line continuation of a keyword call.
            20: [(4, 3, "...", "operator", []), (11, 8, "${GRÜẞE}", "variable", [])],
            # An embedded-argument call with a variable in its name.
            21: [(4, 5, "Greet", "function", ["resolved"]), (10, 8, "${GRÜẞE}", "variable", []),
                 (19, 6, "Kindly", "function", ["resolved"])],
            # A keyword whose full name starts like a BDD prefix: no prefix, as in RF.
            22: [(4, 18, "Given Literal Name", "function", ["resolved"])],
            23: [(4, 3, "FOR", "keyword", []), (11, 4, "${i}", "variable", ["declaration"]),
                 (19, 8, "IN RANGE", "keyword", [])],
            24: [(8, 2, "IF", "keyword", []), (14, 4, "${i}", "variable", []), (27, 5, "BREAK", "keyword", [])],
            25: [(4, 3, "END", "keyword", [])],
            26: [(4, 3, "TRY", "keyword", [])],
            27: [(8, 4, "Fail", "function", library)],
            28: [(4, 6, "EXCEPT", "keyword", []), (14, 2, "AS", "keyword", []),
                 (20, 6, "${err}", "variable", ["declaration"])],
            29: [(8, 3, "Log", "function", library), (15, 6, "${err}", "variable", [])],
            30: [(4, 7, "FINALLY", "keyword", [])],
            31: [(8, 3, "Log", "function", library)],
            32: [(4, 3, "END", "keyword", [])],
            33: [(4, 5, "WHILE", "keyword", [])],
            34: [(8, 3, "Log", "function", library)],
            35: [(4, 3, "END", "keyword", [])],
            37: [(0, 16, "*** Keywords ***", "namespace", [])],
            38: [(0, 10, "Local Step", "function", ["declaration"])],
            39: [(4, 8, "${value}", "variable", ["declaration"]),
                 (17, 12, "Set Variable", "function", ["resolved", "defaultLibrary"])],
            40: [(4, 3, "VAR", "keyword", []), (11, 8, "${other}", "variable", ["declaration"]),
                 (23, 8, "${value}", "variable", [])],
            41: [(4, 6, "RETURN", "keyword", []), (14, 8, "${other}", "variable", [])],
            # Embedded arguments are declared in a user keyword name.
            42: [(0, 5, "Greet", "function", ["declaration"]), (6, 7, "${name}", "variable", ["declaration"]),
                 (14, 6, "Kindly", "function", ["declaration"])],
            43: [(4, 3, "Log", "function", library), (11, 7, "${name}", "variable", [])],
            44: [(0, 18, "Given Literal Name", "function", ["declaration"])],
            45: [(4, 12, "No Operation", "function", library)],
            47: [(0, 16, "*** Comments ***", "namespace", [])],
            48: [(0, 4, "free", "comment", []), (8, 4, "text", "comment", [])],
        }
        for line, value in expected.items():
            with self.subTest(line=line):
                self.assertEqual(tokens.get(line), value)
        self.assertEqual(tokens, expected)  # every line: nothing more, empty lines have none

    def test_resource_file_with_crlf_and_non_bmp(self):
        resource = self.root / "uni.resource"
        resource.write_text(RESOURCE, encoding="utf-8", newline="")
        tokens = self.decode(self.full(resource.as_uri()), RESOURCE)
        self.assertEqual(tokens, {
            0: [(0, 17, "*** Variables ***", "namespace", [])],
            1: [(0, 6, "${Ä😀}", "variable", ["declaration"])],
            2: [(0, 16, "*** Keywords ***", "namespace", [])],
            3: [(0, 11, "Résumé Step", "function", ["declaration"])],
            # An argument's default refers to the suite variable; only the argument is declared.
            4: [(4, 11, "[Arguments]", "property", []), (19, 4, "${v}", "variable", ["declaration"]),
                (24, 6, "${Ä😀}", "variable", [])],
            5: [(4, 8, "Log Many", "function", ["resolved", "defaultLibrary"]), (16, 4, "${v}", "variable", [])],
            6: [(4, 3, "...", "operator", []), (11, 8, "@{EMPTY}", "variable", []),
                (23, 8, "&{EMPTY}", "variable", [])],
        })

    def test_parse_errors_keep_parsable_tokens_in_range(self):
        self.open(self.uri, BROKEN, 2)
        tokens = self.decode(self.full(), BROKEN)  # decode asserts every token is inside its LSP line
        self.assertEqual(tokens[2], [(4, 3, "FOR", "keyword", []), (11, 4, "${i}", "variable", ["declaration"]),
                                     (19, 2, "IN", "keyword", [])])  # FOR without values or END
        self.assertEqual(tokens[3], [(4, 3, "Log", "function", ["resolved", "defaultLibrary"]),
                                     (14, 4, "${ä}", "variable", [])])
        self.assertNotIn(4, tokens)  # an unrecognized section header is no header
        self.assertEqual(tokens[7], [(0, 1, "K", "function", ["declaration"]),
                                     (2, 4, "${a}", "variable", ["declaration"])])
        # RF starts a new line after U+2028 and the form feed; the tokens stay on the LSP line.
        self.assertEqual(tokens[8], [(4, 3, "Log", "function", ["resolved", "defaultLibrary"]),
                                     (17, 4, "${y}", "variable", ["declaration"])])
        self.assertEqual(tokens[9], [(4, 3, "Log", "function", ["resolved", "defaultLibrary"]),
                                     (12, 4, "${z}", "variable", ["declaration"])])
        self.assertEqual(tokens[10], [(4, 15, "Missing Keyword", "function", [])])  # `${open` is no variable
        self.assertEqual(tokens[11], [(4, 2, "IF", "keyword", [])])  # IF without END
        # RF's Error statement types its other cells as comments: no token at all.
        self.assertEqual(tokens[12], [(0, 1, "L", "function", ["declaration"])])
        self.assertNotIn(13, tokens)
        # A document that is not Robot data has no tokens; a later request still works.
        python = self.root / "AuditLibrary.py"
        self.assertEqual(self.full(python.as_uri())["data"], [])
        self.assertTrue(self.full()["data"])

    def test_byte_order_mark_counts_on_the_first_line(self):
        text = "\ufeff*** Test Cases ***\nT\n    Log    😀\n"
        self.open(self.uri, text, 2)
        self.assertEqual(self.full()["data"], [0, 1, 18, 0, 0, 1, 0, 1, 2, 1, 1, 4, 3, 3, 6])

    def test_range_returns_only_tokens_inside_it(self):
        self.open(self.uri, EDGE, 2)
        full = self.decode(self.full(), EDGE)
        # Lines 13 and 14 completely.
        part = self.decode(self.range((13, 0), (15, 0)), EDGE)
        self.assertEqual(part, {13: full[13], 14: full[14]})
        # A range starting inside `Given` and ending before `${GRÜẞE}` (column 31) on line 13.
        part = self.decode(self.range((13, 6), (13, 30)), EDGE)
        self.assertEqual(part, {13: [(10, 12, "Build Record", "function", ["resolved"])]})
        # Tokens crossing either end are left out: `Given` (4-9), `Build Record` (10-22), `${GRÜẞE}` (31-39).
        self.assertEqual(self.range((13, 6), (13, 15)), {"data": []})
        part = self.decode(self.range((13, 5), (13, 35)), EDGE)
        self.assertEqual(part, {13: [(10, 12, "Build Record", "function", ["resolved"])]})
        relative = self.range((14, 9), (16, 0))["data"]
        self.assertEqual(relative, [14, 9, 13, 3, 2, 0, 19, 7, 4, 0, 1, 4, 4, 7, 0, 0, 5, 10, 3, 2])
        self.assertEqual(self.range((50, 0), (60, 0)), {"data": []})
        with self.assertRaises(AssertionError) as invalid:
            self.range((14, 0), (13, 0))
        self.assertEqual(invalid.exception.args[0]["error"]["code"], -32602)
        with self.assertRaises(AssertionError) as negative:
            self.range((-1, 0), (13, 0))
        self.assertEqual(negative.exception.args[0]["error"]["code"], -32602)
        self.assertTrue(self.full()["data"])  # the server is still serving

    def test_did_change_is_reflected_in_a_new_full_request(self):
        before = self.decode(self.full(), self.text)
        self.assertEqual(before[11][1], (18, 12, "Build Record", "function", ["resolved"]))
        # Remove the library import: the call no longer resolves, and the edited line is new.
        changed = self.text.replace("Library    AuditLibrary.py\n", "").replace(
            "    Local Step\n", "    Then Local Step    ${SUITE_VALUE}\n")
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.uri, "version": 2},
                                                   "contentChanges": [{"text": changed}]})
        after = self.decode(self.full(), changed)
        self.assertEqual(after[10][1], (18, 12, "Build Record", "function", []))
        self.assertEqual(after[12], [(4, 4, "Then", "macro", []), (9, 10, "Local Step", "function", ["resolved"]),
                                     (23, 14, "${SUITE_VALUE}", "variable", [])])
        self.assertEqual(after[1], [(0, 8, "Resource", "property", [])])

    def test_delta_edits_reconstruct_a_fresh_full_result(self):
        """Each edit's delta, applied to the previous result, equals a fresh process's whole result."""
        crlf = EDGE.replace("\n", "\r\n")
        steps = [
            ("insert a line", EDGE.replace("Prüfe 😀 ${GRÜẞE}\n", "Prüfe 😀 ${GRÜẞE}\n    Log    neu 😀 ${GRÜẞE}\n")),
            ("insert in a line", EDGE.replace("    Then Local Step\n", "    Then Local Step    ${LIST}[0]    Ä\n")),
            ("delete lines", EDGE.replace("    TRY\n        Fail    x\n    EXCEPT    AS    ${err}\n        Log    ${err}\n"
                                          "    FINALLY\n        Log    done\n    END\n", "")),
            ("delete within a line", EDGE.replace("    But Log Many    @{LIST}    &{MAP}", "    But Log Many    &{MAP}")),
            ("non-BMP text before tokens", EDGE.replace("\tLog\ttab\t${GRÜẞE}", "\tLog\t𝔘😀ä\t${GRÜẞE} 😀${LIST}")),
            ("umlaut and emoji in a keyword name", EDGE.replace("Local Step\n    ${value}=", "Lokal Schritt ÄÖÜ 😀\n    ${value}=")),
            ("remove the library import", EDGE.replace("Library    AuditLibrary.py\n", "")),
            ("remove the resource import", EDGE.replace("Library    AuditLibrary.py\nResource    shared.resource\n", "")),
            ("restore both imports", EDGE),
            ("unchanged text", EDGE),
            ("CRLF line breaks", crlf),
            ("delete everything", ""),
            ("type it all again", EDGE),
        ]
        self.open(self.uri, EDGE, 2)
        previous = self.full()
        self.assertEqual(previous["data"], self.fresh_full(EDGE)["data"])
        sizes, before = [], EDGE
        for version, (name, text) in enumerate(steps, 3):
            with self.subTest(step=name):
                self.change(text, version)
                result = self.delta(previous["resultId"])
                self.assertEqual(set(result), {"resultId", "edits"}, "a delta, not a whole result")
                self.assertNotEqual(result["resultId"], previous["resultId"])
                edited = apply_edits(previous["data"], result["edits"])
                fresh = self.fresh_full(text)
                self.assertEqual(edited, fresh["data"], name)
                self.decode({"data": edited}, text)  # every token on its own characters of its LSP line
                self.assertLessEqual(len(result["edits"]), 1)
                for edit in result["edits"]:  # whole tokens only
                    self.assertEqual((edit["start"] % 5, edit["deleteCount"] % 5, len(edit["data"]) % 5), (0, 0, 0))
                if text == before:
                    self.assertEqual(result["edits"], [], "no change, no edit")
                sizes.append((name, sum(len(edit["data"]) + 2 for edit in result["edits"]), len(edited)))
                previous, before = {"resultId": result["resultId"], "data": edited}, text
        # A one-line edit sends far less than the whole result.
        self.assertLess(sizes[0][1], sizes[0][2] / 4, sizes)

    def test_stale_unknown_and_foreign_result_ids_recover_with_a_full_result(self):
        self.open(self.uri, EDGE, 2)
        expected = self.full()["data"]
        first = self.full()
        second = self.full()
        self.assertNotEqual(first["resultId"], second["resultId"])
        # Only the document's last whole result is a delta base: an older one is stale.
        for name, previous in (("stale", first["resultId"]), ("unknown", "no-such-result"), ("missing", None),
                               ("not a string", 7)):
            with self.subTest(previous=name):
                result = self.delta(previous)
                self.assertEqual(set(result), {"resultId", "data"}, "a whole result")
                self.assertEqual(result["data"], expected)
        # The base is per document: another document's last result is unknown here.
        other = (self.root / "shared.resource").as_uri()
        other_id = self.full(other)["resultId"]
        self.full()
        self.assertEqual(self.delta(other_id)["data"], expected)
        # A range result is no delta base and does not replace the last whole result.
        latest = self.full()["resultId"]
        self.range((13, 0), (15, 0))
        self.assertEqual(self.delta(latest)["edits"], [])
        # A closed document forgets its result; reopened, the old ID gets a whole result.
        latest = self.full()["resultId"]
        self.client.send("textDocument/didClose", {"textDocument": {"uri": self.uri}})
        self.open(self.uri, EDGE, 3)
        self.assertEqual(set(self.delta(latest)), {"resultId", "data"})

    def test_a_restarted_service_answers_an_earlier_process_id_with_a_full_result(self):
        self.open(self.uri, EDGE, 2)
        before = self.full()
        restarted = Client()
        try:
            restarted.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            restarted.send("initialized", {})
            restarted.send("textDocument/didOpen", {"textDocument": {
                "uri": self.uri, "languageId": "robotframework", "version": 1, "text": EDGE}})
            request = lambda previous: restarted.request("textDocument/semanticTokens/full/delta", {  # noqa: E731
                "textDocument": {"uri": self.uri}, "previousResultId": previous})
            # The restarted process's own first result never carries an earlier process's ID.
            own = restarted.request("textDocument/semanticTokens/full", {"textDocument": {"uri": self.uri}})
            self.assertNotEqual(own["resultId"], before["resultId"])
            self.assertEqual(own["data"], before["data"])
            recovered = request(before["resultId"])
            self.assertEqual(set(recovered), {"resultId", "data"}, "an earlier process's ID gets a whole result")
            self.assertEqual(recovered["data"], before["data"])
            self.assertEqual(request(recovered["resultId"])["edits"], [])
            restarted.request("shutdown")
            restarted.send("exit")
            self.assertEqual(restarted.process.wait(timeout=5), 0)
        finally:
            restarted.close()
        # The first process still serves its own ID.
        self.assertEqual(self.delta(before["resultId"])["edits"], [])

    def test_kept_results_are_bounded_least_recently_used_out(self):
        limit = semantic_tokens.MAX_RESULTS
        uris = []
        for index in range(limit + 6):
            path = self.root / f"bulk_{index:03}.robot"
            path.write_text(f"*** Test Cases ***\nT{index}\n    Log    {index} ${{X}}\n", encoding="utf-8")
            uris.append(path.as_uri())
        ids = {uri: self.full(uri)["resultId"] for uri in uris}
        # The oldest six were evicted: their IDs get whole results. The kept ones still get edits.
        for uri in uris[:6]:
            self.assertEqual(set(self.delta(ids[uri], uri)), {"resultId", "data"}, uri)
        for uri in uris[6 + 6:]:  # (the six just answered again are now the most recent)
            self.assertEqual(self.delta(ids[uri], uri)["edits"], [], uri)


class DeltaEditTests(unittest.TestCase):
    """The edit computation itself on random token arrays: always whole tokens, always exact."""

    def test_random_arrays_reconstruct_exactly(self):
        from array import array
        generator = random.Random(481)
        for _ in range(400):
            old = [generator.randrange(4) for _ in range(5 * generator.randrange(0, 40))]
            new = list(old)
            for _ in range(generator.randrange(0, 4)):
                at = 5 * generator.randrange(0, len(new) // 5 + 1)
                if generator.random() < 0.5 and new:
                    del new[at:at + 5 * generator.randrange(1, 4)]
                else:
                    new[at:at] = [generator.randrange(4) for _ in range(5 * generator.randrange(1, 4))]
            edits = semantic_tokens.edits(array("I", old), array("I", new))
            self.assertEqual(apply_edits(old, edits), new)
            for edit in edits:
                self.assertEqual((edit["start"] % 5, edit["deleteCount"] % 5, len(edit["data"]) % 5), (0, 0, 0))
            self.assertEqual(edits == [], old == new)
        # Long equal runs cross the chunk size used for comparing.
        old = array("I", range(20000))
        new = array("I", list(range(9000)) + [7, 7, 7, 7, 7] + list(range(9000, 20000)))
        self.assertEqual(semantic_tokens.edits(old, new), [{"start": 9000, "deleteCount": 0, "data": [7, 7, 7, 7, 7]}])


if __name__ == "__main__":
    unittest.main()

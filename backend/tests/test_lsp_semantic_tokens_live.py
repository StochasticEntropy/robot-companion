"""Required real-process semantic token conformance with RF 7.5. Never skips."""

import re
import unittest

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


class SemanticTokenTests(LanguageTestCase):
    def full(self, uri=None):
        return self.client.request("textDocument/semanticTokens/full", {"textDocument": {"uri": uri or self.uri}})

    def range(self, start, end, uri=None):
        return self.client.request("textDocument/semanticTokens/range", {
            "textDocument": {"uri": uri or self.uri},
            "range": {"start": {"line": start[0], "character": start[1]},
                      "end": {"line": end[0], "character": end[1]}}})

    def decode(self, result, text):
        """Relative LSP data -> {line: [(UTF-16 start, length, text, type, [modifiers])]}, checking
        every token lies on one existing LSP line and that tokens do not overlap."""
        data = result["data"]
        self.assertEqual(set(result), {"data"})
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

    def test_capability_advertises_documented_legend_without_delta(self):
        # setUp asserted the complete capabilities for an editor; a bare client gets the same provider.
        client = Client()
        try:
            result = client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})
            self.assertEqual(result["capabilities"]["semanticTokensProvider"], {
                "legend": {"tokenTypes": ["namespace", "property", "class", "function", "variable", "comment",
                                          "keyword", "macro", "operator"],
                           "tokenModifiers": ["declaration", "resolved", "defaultLibrary"]},
                "full": True, "range": True})  # `full` is not `{"delta": true}`
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()
        self.assertEqual(CAPABILITIES["semanticTokensProvider"]["legend"],
                         {"tokenTypes": TYPES, "tokenModifiers": MODIFIERS})

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
                "    Given Nonexistent Keyword\n    ${prefix} Step\n")
        self.open(self.uri, text, 2)
        tokens = self.decode(self.full(), text)
        self.assertEqual(self.definition(text, "Build Record"), [])
        self.assertEqual(tokens[2], [(4, 12, "Build Record", "function", [])])
        self.assertEqual(tokens[3], [(4, 19, "Nonexistent Keyword", "function", []),
                                     (27, 4, "${x}", "variable", [])])
        self.assertEqual(tokens[4], [(4, 5, "Given", "macro", []),
                                     (10, 19, "Nonexistent Keyword", "function", [])])
        # A call named partly by a variable is known only at run time.
        self.assertEqual(tokens[5], [(4, 9, "${prefix}", "variable", []), (14, 4, "Step", "function", [])])

    def test_edge_cases_from_the_robot_model(self):
        self.open(self.uri, EDGE, 2)
        tokens = self.decode(self.full(), EDGE)
        expected = {
            # Setting, keyword setting cell, variable, trailing comment.
            3: [(0, 11, "Suite Setup", "property", []), (15, 3, "Log", "function", ["resolved", "defaultLibrary"]),
                (22, 8, "${GRÜẞE}", "variable", []), (34, 15, "# suite comment", "comment", [])],
            6: [(0, 8, "${GRÜẞE}", "variable", ["declaration"])],
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
            28: [(4, 6, "EXCEPT", "keyword", []), (14, 2, "AS", "keyword", []),
                 (20, 6, "${err}", "variable", ["declaration"])],
            30: [(4, 7, "FINALLY", "keyword", [])],
            33: [(4, 5, "WHILE", "keyword", [])],
            39: [(4, 8, "${value}", "variable", ["declaration"]),
                 (17, 12, "Set Variable", "function", ["resolved", "defaultLibrary"])],
            40: [(4, 3, "VAR", "keyword", []), (11, 8, "${other}", "variable", ["declaration"]),
                 (23, 8, "${value}", "variable", [])],
            41: [(4, 6, "RETURN", "keyword", []), (14, 8, "${other}", "variable", [])],
            # Embedded arguments are declared in a user keyword name.
            42: [(0, 5, "Greet", "function", ["declaration"]), (6, 7, "${name}", "variable", ["declaration"]),
                 (14, 6, "Kindly", "function", ["declaration"])],
            44: [(0, 18, "Given Literal Name", "function", ["declaration"])],
            47: [(0, 16, "*** Comments ***", "namespace", [])],
            48: [(0, 4, "free", "comment", []), (8, 4, "text", "comment", [])],
        }
        for line, value in expected.items():
            with self.subTest(line=line):
                self.assertEqual(tokens.get(line), value)
        self.assertNotIn(36, tokens)  # an empty line has no token

    def test_resource_file_with_crlf_and_non_bmp(self):
        resource = self.root / "uni.resource"
        resource.write_text(RESOURCE, newline="")
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
        self.assertEqual(self.full(python.as_uri()), {"data": []})
        self.assertTrue(self.full()["data"])

    def test_range_returns_only_tokens_inside_it(self):
        self.open(self.uri, EDGE, 2)
        full = self.decode(self.full(), EDGE)
        # Lines 13 and 14 completely.
        part = self.decode(self.range((13, 0), (15, 0)), EDGE)
        self.assertEqual(part, {13: full[13], 14: full[14]})
        # A range ending inside `Build Record` on line 13 and starting after `When` on line 14.
        part = self.decode(self.range((13, 6), (13, 30)), EDGE)
        self.assertEqual(part, {13: [(10, 12, "Build Record", "function", ["resolved"])]})
        relative = self.range((14, 9), (16, 0))["data"]
        self.assertEqual(relative, [14, 9, 13, 3, 2, 0, 19, 7, 4, 0, 1, 4, 4, 7, 0, 0, 5, 10, 3, 2])
        self.assertEqual(self.range((50, 0), (60, 0)), {"data": []})
        with self.assertRaises(AssertionError) as invalid:
            self.range((14, 0), (13, 0))
        self.assertEqual(invalid.exception.args[0]["error"]["code"], -32602)
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


if __name__ == "__main__":
    unittest.main()

"""Mandatory RF 7.5 hover, completion and signature help conformance. Never skips."""

from pathlib import Path
import unittest

from client import Client
from test_lsp_live import LanguageTestCase

ALIASED = ("*** Settings ***\nLibrary    AuditLibrary.py    AS    Audit\nLibrary    Collections\n"
           "Resource    shared.resource\n*** Test Cases ***\nT\n    Audit.Build Record    name=Ada\n"
           "    Append To List    ${list}    x\n    Collections.Append To List    ${list}    y\n")
SCOPES = ("*** Settings ***\nResource    shared.resource\n*** Variables ***\n${SUITE_VALUE}    from-suite\n"
          "${DYNAMIC}    ${SUITE_VALUE}/x\n*** Test Cases ***\nFirst\n    ${first_only}=    Set Variable    1\n"
          "    ${record}=    Build Record\n    Log    ${\nSecond\n    ${second_only}=    Set Variable    2\n"
          "    ${self}=    Set Variable    ${}\n    Log    ${SUITE_VALUE} ${DYNAMIC} ${CURDIR} ${TEMPDIR} ${MISSING}\n"
          "*** Keywords ***\nHelper\n    [Arguments]    ${arg}    ${opt}=fallback\n"
          "    ${kw_local}=    Set Variable    3\n    Log    ${arg} ${opt} ${\n")
MULTI = ('from robot.api.deco import keyword\n\n\n@keyword("Multi Step")\n'
         'def multi(first, second="b", *rest, flag=False, **options):\n'
         '    """Multi docs [click](command:workbench.action.quit) <img src=x>."""\n\n\n'
         '@keyword("Other Step")\ndef other(x):\n    pass\n\n\n'
         '@keyword("Nothing Step")\ndef nothing(x) -> None:\n    pass\n')
SIGNATURES = ("*** Settings ***\nLibrary    AuditLibrary.py    AS    Audit\nLibrary    Multi.py\n"
              "Resource    shared.resource\n*** Test Cases ***\nT\n    Multi Step    \n    Multi Step    1    \n"
              "    Multi Step    1    2    3    \n    Multi Step    flag=\n    Multi Step    other=1\n"
              "    Multi Step    1\n    ...    2\n    Audit.Build Record    name=Ada\n    Resource Step    x\n"
              "    Multi Step x\n    Broken    1\n*** Keywords ***\nBroken\n"
              "    [Arguments]    ${a}=1    ${b}\n    No Operation\n")


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


class FeatureTests(LanguageTestCase):
    def labels(self, result):
        return {item["label"]: item for item in result["items"]}

    def hover(self, text, needle, uri=None, occurrence=0, offset=0):
        return self.at("textDocument/hover", text, needle, uri, occurrence, offset)

    def complete(self, text, needle, offset, uri=None, occurrence=0):
        return self.at("textDocument/completion", text, needle, uri, occurrence, offset)

    def signature(self, text, needle, offset, occurrence=0):
        return self.at("textDocument/signatureHelp", text, needle, occurrence=occurrence, offset=offset)

    def test_keyword_hover_uses_import_aware_resolution(self):
        result = self.hover(self.text, "Build Record")
        self.assertEqual(result["contents"]["kind"], "plaintext")
        value = result["contents"]["value"]
        self.assertIn("Build Record · Library AuditLibrary · AuditLibrary.py", value)
        self.assertIn("Build Record    name: str = Ada", value)
        self.assertIn("Returns Record", value)
        self.assertIn("Build a record for the isolated editor audit.", value)
        for shadow in ("AShadow", "unused", "Unrelated shadow"):
            self.assertNotIn(shadow, value)
        line = self.position(self.text, "Build Record")
        self.assertEqual(result["range"], {"start": line, "end": {**line, "character": line["character"] + 12}})
        resource = self.hover(self.text, "Resource Step")["contents"]["value"]
        self.assertIn("Resource Step · Resource shared.resource", resource)
        self.assertIn("Resource Step    value", resource)
        self.assertIn("A keyword imported from a resource file.", resource)
        local = self.hover(self.text, "Local Step")["contents"]["value"]
        self.assertIn("Local Step · Local keyword · audit.robot", local)
        self.assertIsNone(self.hover(self.text, "Debug Smoke"))  # a test name is not a keyword call

    def test_alias_and_standard_library_hover(self):
        self.open(self.uri, ALIASED, 2)
        alias = self.hover(ALIASED, "Audit.Build Record")["contents"]["value"]
        self.assertIn("Build Record · Library Audit · AuditLibrary.py", alias)
        self.assertNotIn("AShadow", alias)
        for needle in ("Append To List", "Collections.Append To List"):
            with self.subTest(needle=needle):
                value = self.hover(ALIASED, needle)["contents"]["value"]
                self.assertIn("Append To List · Standard library Collections", value)
                self.assertIn("list_: MutableSequence", value)
        # Definition consumes the same resolution: RF's own Collections source.
        location = self.definition(ALIASED, "Append To List")
        self.assertEqual(len(location), 1)
        self.assertEqual(Path(location[0]["uri"]).name, "Collections.py")
        self.assertEqual(Path(self.definition(ALIASED, "Audit.Build Record")[0]["uri"]).name, "AuditLibrary.py")

    def test_variable_hover_shows_only_static_values(self):
        self.open(self.uri, SCOPES, 2)
        suite = self.hover(SCOPES, "${SUITE_VALUE} ${DYNAMIC}")["contents"]["value"]
        self.assertEqual(suite, "${SUITE_VALUE} · Suite variable · Variables section of audit.robot, line 4\n\n"
                                "Value as written: from-suite")
        dynamic = self.hover(SCOPES, "${DYNAMIC} ${CURDIR}")["contents"]["value"]
        self.assertIn("Value as written: ${SUITE_VALUE}/x It refers to variables resolved at run time.", dynamic)
        curdir = self.hover(SCOPES, "${CURDIR} ${TEMPDIR}")["contents"]["value"]
        self.assertIn(f"Value: {self.root} (directory of this file)", curdir)
        tempdir = self.hover(SCOPES, "${TEMPDIR} ${MISSING}")["contents"]["value"]
        self.assertIn("Value is set by Robot Framework at run time.", tempdir)
        self.assertIsNone(self.hover(SCOPES, "${MISSING}"))
        arg = self.hover(SCOPES, "${arg} ${opt}", occurrence=0)["contents"]["value"]
        self.assertEqual(arg, "${arg} · Argument of keyword Helper (audit.robot, line 17)\n\n"
                              "Value is supplied by the caller at run time.")
        default = self.hover(SCOPES, "${opt} ${", occurrence=0)["contents"]["value"]
        self.assertIn("Default as written: fallback", default)
        record = self.hover(SCOPES, "${record}")["contents"]["value"]
        self.assertIn("Assigned in test First (audit.robot, line 9)", record)
        self.assertIn("Value is returned by Build Record at run time.", record)
        resource = (self.root / "shared.resource")
        argument = self.hover(resource.read_text(), "Log    ${value}", resource.as_uri(), offset=7)
        self.assertEqual(argument["contents"]["value"],
                         "${value} · Argument of keyword Resource Step (shared.resource, line 3)\n\n"
                         "Value is supplied by the caller at run time.")
        self.assertEqual(argument["range"]["start"]["line"], 4)
        # The argument of `${SUITE_VALUE}=    Set Variable    ${SUITE_VALUE}` is the earlier value.
        reassigned = SCOPES.replace("    ${self}=    Set Variable    ${}",
                                    "    ${SUITE_VALUE}=    Set Variable    ${SUITE_VALUE}")
        self.open(self.uri, reassigned, 3)
        line = self.position(reassigned, "Set Variable    ${SUITE_VALUE}", offset=16)
        request = {"textDocument": {"uri": self.uri}, "position": line}
        self.assertIn("Suite variable", self.client.request("textDocument/hover", request)["contents"]["value"])
        self.assertEqual(self.client.request("textDocument/definition", request)[0]["range"]["start"]["line"], 3)
        assigned = self.hover(reassigned, "    ${SUITE_VALUE}=", offset=4)["contents"]["value"]
        self.assertIn("Assigned in test Second", assigned)
        self.assertEqual(self.hover(reassigned, "${SUITE_VALUE}", occurrence=0)["range"],
                         {"start": {"line": 3, "character": 0}, "end": {"line": 3, "character": 14}})

    def test_keyword_completion_has_origins_and_no_unimported_shadow(self):
        text = self.text.replace("Resource    shared.resource\n", "Resource    shared.resource\nLibrary    Collections\n")
        text = text.replace("    Local Step\n", "    Local Step\n    \n    ${made}=    Bu\n    Audit.\n")
        self.open(self.uri, text, 2)
        items = self.labels(self.complete(text, "    \n", 4))
        expected = {"Local Step": "Local keyword · audit.robot", "Resource Step": "Resource shared.resource",
                    "Build Record": "Library AuditLibrary · AuditLibrary.py",
                    "Append To List": "Standard library Collections", "Log": "Standard library BuiltIn"}
        for label, detail in expected.items():
            self.assertEqual(items[label]["detail"], detail)
            self.assertEqual(items[label]["insertTextFormat"], 1)
        self.assertEqual([i for i in items.values() if "Build Record" in i["label"]], [items["Build Record"]])
        self.assertFalse([i for i in items.values() if "AShadow" in i["detail"]])
        empty = self.position(text, "    \n")
        empty["character"] = 4
        self.assertEqual(items["Log"]["textEdit"], {"range": {"start": empty, "end": empty}, "newText": "Log"})
        # A partly typed call after an assignment replaces just the keyword cell.
        partial = self.labels(self.complete(text, "Bu\n", 2))
        start = self.position(text, "Bu\n")
        self.assertEqual(partial["Build Record"]["textEdit"]["range"],
                         {"start": start, "end": {**start, "character": start["character"] + 2}})
        # Arguments, settings and test names are not keyword-call cells.
        self.assertEqual(self.complete(text, "name=Ada", 3)["items"], [])
        self.assertEqual(self.complete(text, "Library    AuditLibrary.py", 9)["items"], [])
        self.assertEqual(self.complete(text, "Debug Smoke", 5)["items"], [])
        self.assertEqual(self.complete(text, "    [Documentation]", 4)["items"], [])
        self.assertEqual(self.complete(text, "    Local Step\n", 2)["items"], [])
        self.open(self.uri, ALIASED + "    Audit.\n", 3)
        qualified = self.labels(self.complete(ALIASED + "    Audit.\n", "    Audit.\n", 10))
        self.assertEqual(list(qualified), ["Audit.Build Record"])

    def test_variable_completion_is_scoped(self):
        self.open(self.uri, SCOPES, 2)
        first = self.labels(self.complete(SCOPES, "    Log    ${\n", 13))
        for label in ("${first_only}", "${record}", "${SUITE_VALUE}", "${DYNAMIC}", "${CURDIR}", "${TEMPDIR}"):
            self.assertIn(label, first)
        for label in ("${second_only}", "${arg}", "${opt}", "${kw_local}", "${self}"):
            self.assertNotIn(label, first)
        self.assertEqual(first["${SUITE_VALUE}"]["detail"], "Suite variable · audit.robot")
        start = self.position(SCOPES, "    Log    ${\n", offset=11)
        self.assertEqual(first["${CURDIR}"]["textEdit"], {"range": {
            "start": start, "end": {**start, "character": start["character"] + 2}}, "newText": "${CURDIR}"})
        second = self.labels(self.complete(SCOPES, "${}", 2))
        self.assertIn("${second_only}", second)
        self.assertNotIn("${first_only}", second)
        self.assertNotIn("${self}", second)  # assigned by this same call, not yet visible
        # VS Code's auto-closed brace is replaced, so the result stays `${name}`.
        start = self.position(SCOPES, "${}")
        self.assertEqual(second["${second_only}"]["textEdit"]["range"],
                         {"start": start, "end": {**start, "character": start["character"] + 3}})
        helper = self.labels(self.complete(SCOPES, "${arg} ${opt} ${\n", 16))
        for label in ("${arg}", "${opt}", "${kw_local}", "${SUITE_VALUE}"):
            self.assertIn(label, helper)
        for label in ("${first_only}", "${second_only}", "${record}"):
            self.assertNotIn(label, helper)
        self.assertEqual(helper["${arg}"]["detail"], "Argument of keyword Helper")

    def test_completion_ranges_are_utf16(self):
        text = ("*** Variables ***\n${😀wert}    ä\n*** Test Cases ***\nT\n    ${ä😀}=    Prüf\n"
                "    Log    😀Ä${😀w}\n    Log Many    @{\n*** Keywords ***\nPrüfe Ergebnis\n    No Operation\n")
        self.open(self.uri, text, 2)
        keyword = self.labels(self.complete(text, "Prüf\n", 4))["Prüfe Ergebnis"]
        # `    ${ä😀}=    ` is 14 code points but 15 UTF-16 units (😀 is a surrogate pair).
        self.assertEqual(keyword["textEdit"]["range"], {"start": {"line": 4, "character": 15},
                                                        "end": {"line": 4, "character": 19}})
        variable = self.labels(self.complete(text, "${😀w}", 4))["${😀wert}"]
        line = "    Log    😀Ä${😀w}"
        self.assertEqual(variable["textEdit"], {"range": {
            "start": {"line": 5, "character": utf16("    Log    😀Ä")},
            "end": {"line": 5, "character": utf16(line)}}, "newText": "${😀wert}"})
        self.assertEqual(variable["textEdit"]["range"]["start"]["character"], 14)
        # Inside an existing name, the rest of the name and its brace are replaced.
        inside = self.labels(self.complete(text, "${😀w}", 3))["${😀wert}"]["textEdit"]["range"]
        self.assertEqual(inside["end"], {"line": 5, "character": utf16(line)})
        self.assertEqual(inside["start"]["character"], 14)
        self.assertIn("@{😀wert}", self.labels(self.complete(text, "    Log Many    @{\n", 18)))

    def test_signature_help_positional_and_named(self):
        (self.root / "Multi.py").write_text(MULTI)
        self.open(self.uri, SIGNATURES, 2)
        result = self.signature(SIGNATURES, "    Multi Step    \n", 18)
        signature = result["signatures"][0]
        self.assertEqual(signature["label"], "Multi Step    first    second=b    *rest    flag=False    **options")
        units = signature["label"].encode("utf-16-le")
        self.assertEqual([units[2 * a:2 * b].decode("utf-16-le") for a, b in (p["label"] for p in signature["parameters"])],
                         ["first", "second=b", "*rest", "flag=False", "**options"])
        self.assertEqual(result["activeParameter"], 0)
        cases = (("    Multi Step    1    \n", 22, 1), ("    Multi Step    1    2    3    \n", 32, 2),
                 ("    Multi Step    flag=\n", 23, 3), ("    Multi Step    other=1", 22, 4),
                 ("    ...    2", 12, 1))
        for needle, offset, active in cases:
            with self.subTest(needle=needle):
                result = self.signature(SIGNATURES, needle, offset)
                self.assertEqual((result["activeParameter"], result["signatures"][0]["activeParameter"]),
                                 (active, active))
        self.assertIsNone(self.signature(SIGNATURES, "    Multi Step    \n", 8))  # on the keyword name
        self.assertIsNone(self.signature(SIGNATURES, "    Multi Step x", 16))  # one space: still the name cell
        audit = self.signature(SIGNATURES, "name=Ada", 2)
        self.assertEqual([s["label"] for s in audit["signatures"]], ["Build Record    name: str = Ada"])
        self.assertEqual(audit["activeParameter"], 0)
        self.assertIn("Library Audit · AuditLibrary.py", audit["signatures"][0]["documentation"]["value"])
        resource = self.signature(SIGNATURES, "Resource Step    x", 18)
        self.assertEqual(resource["signatures"][0]["label"], "Resource Step    value")
        self.assertEqual(resource["activeParameter"], 0)
        # RF rejects these [Arguments]; nothing is guessed and the keyword has no docs.
        broken = self.signature(SIGNATURES, "    Broken    1", 14)["signatures"][0]
        self.assertEqual((broken["label"], broken["parameters"], broken["activeParameter"]), ("Broken", [], 0))
        hover = self.at("textDocument/hover", SIGNATURES, "    Broken    1", offset=4)["contents"]["value"]
        self.assertEqual(hover, "Broken · Local keyword · audit.robot\n\nBroken\n\n"
                                "Arguments could not be read statically.")

    def test_hover_shows_return_line_only_for_an_annotation(self):
        (self.root / "Multi.py").write_text(MULTI)
        text = ("*** Settings ***\nLibrary    Multi.py\n*** Test Cases ***\nT\n    Other Step    1\n"
                "    Nothing Step    1\n")
        self.open(self.uri, text, 2)
        other = self.hover(text, "Other Step")["contents"]["value"]
        self.assertEqual(other, "Other Step · Library Multi · Multi.py\n\nOther Step    x")
        self.assertIn("Returns None", self.hover(text, "Nothing Step")["contents"]["value"])

    def test_hover_on_typed_variable_definition_cells(self):
        text = ("*** Variables ***\n${PORT: int}    8080\n*** Test Cases ***\nT\n"
                "    ${n: int}=    Set Variable    1\n    Log    ${PORT} ${n}\n")
        self.open(self.uri, text, 2)
        port = "${PORT: int} · Suite variable · Variables section of audit.robot, line 2\n\nValue as written: 8080"
        local = ("${n: int} · Assigned in test T (audit.robot, line 5)\n\n"
                 "Value is returned by Set Variable at run time.")
        for needle, occurrence, expected, length in (("${PORT: int}", 0, port, 12), ("${PORT} ${n}", 0, port, 7),
                                                     ("${n: int}=", 0, local, 9), ("${n}", 0, local, 4)):
            with self.subTest(needle=needle):
                result = self.hover(text, needle, occurrence=occurrence, offset=2)
                self.assertEqual(result["contents"]["value"], expected)
                start = self.position(text, needle, occurrence)
                end = {**start, "character": start["character"] + length}
                self.assertEqual(result["range"], {"start": start, "end": end})
        self.assertEqual(self.definition(text, "${PORT: int}")[0]["range"]["start"], {"line": 1, "character": 0})

    def test_variable_completion_keeps_an_extended_syntax_suffix(self):
        text = ("*** Test Cases ***\nT\n    ${record}=    Set Variable    1\n"
                "    Log    ${record.name}\n    Log    ${record}[0]\n")
        self.open(self.uri, text, 2)
        for needle, result in (("${record.name}", "    Log    ${record.name}"),
                               ("${record}[0]", "    Log    ${record}[0]")):
            with self.subTest(needle=needle):
                edit = self.labels(self.complete(text, needle, 5))["${record}"]["textEdit"]
                line = text.splitlines()[edit["range"]["start"]["line"]]
                start, end = edit["range"]["start"]["character"], edit["range"]["end"]["character"]
                self.assertEqual(line[start:end], {"${record.name}": "${record", "${record}[0]": "${record}"}[needle])
                self.assertEqual(line[:start] + edit["newText"] + line[end:], result)

    def test_signature_help_ignores_equals_inside_variables(self):
        (self.root / "Multi.py").write_text(MULTI)
        text = ("*** Settings ***\nLibrary    Multi.py\n*** Test Cases ***\nT\n    Multi Step    ${{1 == 1}}\n"
                "    Multi Step    ${{1 == 1}}    2\n    Multi Step    ${d}[a=b]    2\n    Multi Step    x=${{1}}\n")
        self.open(self.uri, text, 2)
        cases = (("    Multi Step    ${{1 == 1}}\n", 22, 0), ("${{1 == 1}}    2", 15, 1),
                 ("${d}[a=b]    2", 13, 1), ("x=${{1}}", 1, 4))
        for needle, offset, active in cases:
            with self.subTest(needle=needle):
                result = self.signature(text, needle, offset)
                self.assertEqual((result["activeParameter"], result["signatures"][0]["activeParameter"]),
                                 (active, active))

    def test_hover_and_completion_follow_edits_without_restart(self):
        resource = self.root / "shared.resource"
        changed = resource.read_text().replace("A keyword imported from a resource file.", "Changed resource doc.")
        changed += "\nFresh Step\n    [Documentation]    Added in the open buffer.\n    No Operation\n"
        self.open(resource.as_uri(), changed)
        text = self.text.replace("    Local Step\n", "    Local Step\n    \n")
        self.open(self.uri, text, 2)
        self.assertIn("Changed resource doc.", self.hover(text, "Resource Step")["contents"]["value"])
        self.assertEqual(self.labels(self.complete(text, "    \n", 4))["Fresh Step"]["detail"],
                         "Resource shared.resource")
        self.client.send("textDocument/didChange", {"textDocument": {"uri": resource.as_uri(), "version": 2},
                         "contentChanges": [{"text": changed.replace("Fresh Step", "Renamed Step")}]})
        items = self.labels(self.complete(text, "    \n", 4))
        self.assertIn("Renamed Step", items)
        self.assertNotIn("Fresh Step", items)
        # Removing the import drops its keywords; adding a standard library adds its keywords.
        without = text.replace("Resource    shared.resource\n", "Library    Collections\n")
        self.client.send("textDocument/didChange", {"textDocument": {"uri": self.uri, "version": 3},
                                                   "contentChanges": [{"text": without}]})
        items = self.labels(self.complete(without, "    \n", 4))
        self.assertNotIn("Resource Step", items)
        self.assertNotIn("Renamed Step", items)
        self.assertIn("Append To List", items)
        self.assertIsNone(self.hover(without, "Resource Step"))
        # A saved library change is reread on the next request.
        library = self.root / "AuditLibrary.py"
        library.write_text(library.read_text().replace("Build a record for", "Rebuilt docs for"))
        self.assertIn("Rebuilt docs for", self.hover(without, "Build Record")["contents"]["value"])

    def test_unsupported_requests_and_unindexed_standard_libraries(self):
        with self.assertRaises(AssertionError) as raised:
            self.client.request("completionItem/resolve", {"label": "Log"})
        self.assertEqual(raised.exception.args[0]["error"]["code"], -32601)
        text = ("*** Settings ***\nLibrary    Remote    http://127.0.0.1:9\nLibrary    Telnet\n"
                "*** Test Cases ***\nT\n    \n")
        self.open(self.uri, text, 2)
        # Remote keywords exist only at run time; nothing connects to the URI.
        items = self.labels(self.complete(text, "    \n", 4))
        self.assertIn("Log", items)
        self.assertFalse([i for i in items.values() if "Remote" in i["detail"]])
        # LSP's last, empty line after the final line break is a valid position.
        end = {"textDocument": {"uri": self.uri}, "position": {"line": text.count("\n"), "character": 0}}
        self.assertIsNone(self.client.request("textDocument/hover", end))
        self.assertIsNone(self.client.request("textDocument/signatureHelp", end))


    def test_standard_library_indexing_never_imports_workspace_modules(self):
        # XML tries `from lxml import etree`; `python -m` starts with the cwd on sys.path.
        marker = self.root / "imported"
        for module in ("lxml.py", "robot.py"):  # neither RF nor its optional imports may load these
            (self.root / module).write_text(f"open({str(marker)!r}, 'w').close()\n")
        client = Client(cwd=self.root)
        try:
            client.request("initialize", {"capabilities": {"textDocument": {"hover": None, "signatureHelp": None}}})
            client.send("initialized", {})
            text = "*** Settings ***\nLibrary    XML\n*** Test Cases ***\nT\n    Parse XML    <a/>\n    \n"
            client.send("textDocument/didOpen", {"textDocument": {
                "uri": self.uri, "languageId": "robotframework", "version": 1, "text": text}})
            items = {i["label"]: i for i in client.request("textDocument/completion", {
                "textDocument": {"uri": self.uri}, "position": {"line": 5, "character": 4}})["items"]}
            self.assertEqual(items["Parse Xml"]["detail"], "Standard library XML")
            hover = client.request("textDocument/hover", {"textDocument": {"uri": self.uri},
                                                         "position": {"line": 4, "character": 4}})
            self.assertEqual(hover["contents"]["kind"], "plaintext")
            self.assertFalse(marker.exists(), "A workspace module was executed")
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()


class MarkdownFeatureTests(LanguageTestCase):
    client_capabilities = {"textDocument": {
        "hover": {"contentFormat": ["markdown", "plaintext"]},
        "signatureHelp": {"signatureInformation": {"documentationFormat": ["markdown"]}}}}

    def test_markdown_escapes_workspace_documentation(self):
        (self.root / "Multi.py").write_text(MULTI)
        text = "*** Settings ***\nLibrary    Multi.py\n*** Test Cases ***\nT\n    Multi Step    1\n    Log    x\n"
        self.open(self.uri, text, 2)
        hover = self.at("textDocument/hover", text, "Multi Step")["contents"]
        self.assertEqual(hover["kind"], "markdown")
        self.assertIn("**Multi Step** · Library Multi · Multi\\.py", hover["value"])
        self.assertIn("```text\nMulti Step    first    second=b    *rest    flag=False    **options\n```", hover["value"])
        self.assertIn("\\[click\\]\\(command:workbench\\.action\\.quit\\) \\<img src=x\\>", hover["value"])
        self.assertNotIn("[click](", hover["value"])
        signature = self.at("textDocument/signatureHelp", text, "    Multi Step    1", offset=19)
        documentation = signature["signatures"][0]["documentation"]
        self.assertEqual(documentation["kind"], "markdown")
        self.assertNotIn("[click](", documentation["value"])
        # RF's bundled standard-library documentation is already Markdown.
        log = self.at("textDocument/hover", text, "Log")["contents"]["value"]
        self.assertIn("**Log** · Standard library BuiltIn", log)
        self.assertIn("`--loglevel`", log)


if __name__ == "__main__":
    unittest.main()

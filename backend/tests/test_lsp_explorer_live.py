"""Required real-process conformance for the keyword explorer request (`robotCompanion/documentKeywords`)
and for renaming Python library keywords. Never skips.

The explorer lists exactly the keywords a Robot file can call, from the same import graph as
definition and hover. A Python library keyword is renamed only through the string literal of
its `@keyword("Name")` decorator, together with every call, or refused with the reason; a
refusal never edits anything. Renamed suites are run with the backend's own Robot Framework.
"""

from pathlib import Path
import tempfile
import unittest

from test_lsp_diagnostics_live import RobotRunTestCase, apply_edits

AUDIT = '''"""Audit helpers for the explorer."""
from robot.api.deco import keyword


@keyword("Build Record")
def build_record(name: str = "Ada") -> str:
    """Build a record for the explorer."""
    return name


def plain_step(value, *, mode):
    """A plain module function."""
    return value
'''
OTHER = ('from robot.api.deco import keyword\n\n\n@keyword("Build Record")\ndef other_build():\n'
         '    """The other library\'s Build Record."""\n    return "other"\n')
# Never imported: none of its keywords may be listed, even with the name of an imported one.
SHADOW = ('from robot.api.deco import keyword\n\n\n@keyword("Build Record")\ndef shadow_build():\n'
          '    """Shadow."""\n\n\ndef shadow_only():\n    pass\n')
SHARED = ("*** Settings ***\nDocumentation    Shared resource docs.\nLibrary    Collections    AS    Coll\n"
          "Resource    inner.resource\n\n*** Keywords ***\nResource Step\n    [Arguments]    ${value}\n"
          "    [Documentation]    From the resource.\n    Log    ${value}\n")
INNER = "*** Keywords ***\nInner Step\n    No Operation\n"
SUITE = ("*** Settings ***\nLibrary    AuditLibrary.py    AS    Audit\nLibrary    Other.py\n"
         "Resource    shared.resource\nLibrary    Missing.py\n\n*** Test Cases ***\nT\n"
         "    ${r}=    Audit.Build Record    name=x\n    Resource Step    v\n\n"
         "*** Keywords ***\nLocal Step\n    No Operation\n")
# A class library whose subclass overrides a base method: the explorer shows the override.
SHAPES = ('class Base:\n    def shared_step(self):\n        """Base implementation."""\n\n\n'
          'class Shapes(Base):\n    def shared_step(self):\n        """Child implementation."""\n        return 1\n')
TWINS = ("*** Settings ***\nLibrary    TwinA.py    AS    Same\nLibrary    TwinB.py    AS    Same\n"
         "*** Test Cases ***\nT\n    No Operation\n")


class ExplorerTestCase(RobotRunTestCase):
    client_capabilities = {"textDocument": {"hover": {"contentFormat": ["markdown"]}}}

    def setUp(self):
        super().setUp()
        self.write({"AuditLibrary.py": AUDIT, "Other.py": OTHER, "Shadow.py": SHADOW, "shared.resource": SHARED,
                    "inner.resource": INNER})
        self.suite = (self.root / "suite.robot").as_uri()
        self.change(self.suite, SUITE)

    def keywords(self, uri=None):
        return self.client.request("robotCompanion/documentKeywords", {"textDocument": {"uri": uri or self.suite}})

    @staticmethod
    def group(result, namespace):
        return next(g for g in result["imports"] if g["namespace"] == namespace)


class ExplorerTests(ExplorerTestCase):
    def test_lists_the_imported_scope_in_rf_order_with_aliases_and_import_sites(self):
        result = self.keywords()
        self.assertEqual(result["uri"], self.suite)
        self.assertEqual(result["version"], 1)
        brief = [(g["kind"], g["name"], g["alias"], g["namespace"], Path(g["uri"]).name,
                  g["importedBy"] and (Path(g["importedBy"]["uri"]).name, g["importedBy"]["range"]["start"]["line"]))
                 for g in result["imports"]]
        self.assertEqual(brief, [
            ("local", "suite.robot", None, "suite", "suite.robot", None),
            ("library", "AuditLibrary.py", "Audit", "Audit", "AuditLibrary.py", ("suite.robot", 1)),
            ("library", "Other.py", None, "Other", "Other.py", ("suite.robot", 2)),
            ("resource", "shared.resource", None, "shared", "shared.resource", ("suite.robot", 3)),
            ("standard", "Collections", "Coll", "Coll", "Collections.py", ("shared.resource", 2)),
            ("resource", "inner.resource", None, "inner", "inner.resource", ("shared.resource", 3)),
            ("standard", "BuiltIn", None, "BuiltIn", "BuiltIn.py", None)])
        names = {(g["namespace"], k["name"]) for g in result["imports"] for k in g["keywords"]}
        self.assertLessEqual({("suite", "Local Step"), ("Audit", "Build Record"), ("Audit", "Plain Step"),
                              ("Other", "Build Record"), ("shared", "Resource Step"), ("inner", "Inner Step"),
                              ("Coll", "Append To List"), ("BuiltIn", "Log")}, names)
        self.assertFalse({name for _, name in names} & {"Shadow Only", "Shadow Build"})
        self.assertFalse(any("Shadow.py" in str(k["location"]) for g in result["imports"] for k in g["keywords"]))
        # The unresolved import is reported where it is written, never guessed.
        self.assertEqual([(Path(u["uri"]).name, u["range"]["start"]["line"]) for u in result["unresolved"]],
                         [("suite.robot", 4)])
        self.assertIn("Missing.py", result["unresolved"][0]["message"])
        self.assertEqual(self.group(result, "shared")["documentation"], "Shared resource docs\\.")
        self.assertEqual(self.group(result, "Audit")["documentation"], "Audit helpers for the explorer\\.")

    def test_each_call_text_resolves_to_its_own_keyword_and_the_signature_is_rf_s(self):
        result = self.keywords()
        listed = [k for g in result["imports"] if g["kind"] != "standard" for k in g["keywords"]]
        listed += [k for k in self.group(result, "Coll")["keywords"] if k["name"] in ("Append To List", "Get From List")]
        calls = {(k["namespace"], k["name"]): k["call"] for k in listed}
        self.assertEqual(calls[("Audit", "Build Record")], "Audit.Build Record")  # two libraries have it
        self.assertEqual(calls[("Other", "Build Record")], "Other.Build Record")
        self.assertEqual(calls[("Audit", "Plain Step")], "Plain Step")
        self.assertEqual(calls[("shared", "Resource Step")], "Resource Step")
        plain = next(k for k in listed if k["name"] == "Plain Step")
        self.assertEqual(plain["signature"], ["value", "*", "mode"])
        self.assertEqual(plain["required"], [{"name": "value", "named": False}, {"name": "mode", "named": True}])
        build = next(k for k in listed if k["namespace"] == "Audit" and k["name"] == "Build Record")
        self.assertEqual((build["signature"], build["required"], build["returnType"]), (["name: str = Ada"], [], "str"))
        # Written into the suite, every call text goes to exactly the listed definition.
        body = "".join(f"    {k['call']}\n" for k in listed)
        text = SUITE.replace("\n\n*** Keywords ***", "\nCalls\n" + body + "\n*** Keywords ***")
        self.change(self.suite, text)
        # Locations from the listing of the edited suite: its own keyword moved down.
        moved = {(k["namespace"], k["name"]): k["location"] for g in self.keywords()["imports"] for k in g["keywords"]}
        for keyword in listed:
            keyword = {**keyword, "location": moved[(keyword["namespace"], keyword["name"])]}
            with self.subTest(call=keyword["call"]):
                found = self.at("textDocument/definition", text, f"    {keyword['call']}\n", self.suite, offset=4)
                self.assertEqual(found, [keyword["location"]])

    def test_a_library_imported_here_and_by_a_resource_is_one_group_with_both_import_sites(self):
        # RF shares one library instance between both imports (also run below: no ambiguity).
        self.write({"shared.resource": SHARED.replace("Resource    inner.resource\n",
                                                      "Resource    inner.resource\nLibrary    Other.py\n")})
        result = self.keywords()
        other = [g for g in result["imports"] if g["namespace"] == "Other"]
        self.assertEqual(len(other), 1)
        self.assertEqual((Path(other[0]["importedBy"]["uri"]).name, other[0]["importedBy"]["range"]["start"]["line"]),
                         ("suite.robot", 2))  # this file's own import, not the resource's
        self.assertEqual([(Path(s["uri"]).name, s["range"]["start"]["line"]) for s in other[0]["importSites"]],
                         [("suite.robot", 2), ("shared.resource", 4)])
        self.assertEqual([k["name"] for k in other[0]["keywords"]], ["Build Record"])
        keys = [(g["kind"], g["namespace"], g["uri"]) for g in result["imports"]]
        self.assertEqual(len(keys), len(set(keys)))
        # Only through the resource: one group, its import site in the resource.
        self.change(self.suite, SUITE.replace("Library    Other.py\n", ""))
        via = [g for g in self.keywords()["imports"] if g["namespace"] == "Other"]
        self.assertEqual([(Path(g["importedBy"]["uri"]).name, len(g["importSites"])) for g in via], [("shared.resource", 1)])
        self.assert_rf("*** Settings ***\nLibrary    Other.py\nResource    shared.resource\n*** Test Cases ***\nT\n"
                       "    ${v}=    Build Record\n    Should Be Equal    ${v}    other\n", 0)

    def test_a_resource_imported_here_and_by_a_resource_is_one_group_with_both_import_sites(self):
        # MIS-624 repro: outer.resource imports shared.resource, which the file also imports itself.
        self.write({"outer.resource": "*** Settings ***\nResource    shared.resource\n"})
        text = ("*** Settings ***\nResource    outer.resource\nResource    shared.resource\n*** Test Cases ***\nT\n"
                "    Resource Step    v\n    Inner Step\n")
        uri = (self.root / "resdirect.robot").as_uri()
        self.change(uri, text)
        result = self.keywords(uri)
        shared = [g for g in result["imports"] if g["namespace"] == "shared"]
        self.assertEqual(len(shared), 1)
        self.assertEqual((Path(shared[0]["importedBy"]["uri"]).name, shared[0]["importedBy"]["range"]["start"]["line"]),
                         ("resdirect.robot", 2))  # this file's own import, not outer.resource's
        self.assertEqual([(Path(s["uri"]).name, s["range"]["start"]["line"]) for s in shared[0]["importSites"]],
                         [("outer.resource", 1), ("resdirect.robot", 2)])
        self.assertEqual([(k["name"], k["call"]) for k in shared[0]["keywords"]], [("Resource Step", "Resource Step")])
        keys = [(g["kind"], g["namespace"], g["uri"]) for g in result["imports"]]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual([g["namespace"] for g in result["imports"]].count("inner"), 1)
        self.assertEqual([g["namespace"] for g in result["imports"]].count("Coll"), 1)
        self.assert_rf(text, 0)
        # Only through outer.resource: one group, its import site in outer.resource.
        self.change(uri, text.replace("Resource    shared.resource\n", ""))
        via = [g for g in self.keywords(uri)["imports"] if g["namespace"] == "shared"]
        self.assertEqual([(Path(g["importedBy"]["uri"]).name, len(g["importSites"])) for g in via], [("outer.resource", 1)])
        # A repeated import of a resource that cannot be read lists no group, as a single import.
        broken = "*** Settings ***\nResource    gone.resource\nResource    gone.resource\n"
        self.change(uri, broken)
        self.assertNotIn("gone", [g["namespace"] for g in self.keywords(uri)["imports"]])

    def test_a_library_under_two_names_gives_each_instance_its_qualified_call(self):
        # MIS-623 repro: RF keeps one instance per name and reports the plain call as ambiguous.
        self.write({"LibA.py": 'def alpha_step():\n    """Alpha."""\n    return "a"\n'})
        cases = {
            "two aliases": ("*** Settings ***\nLibrary    LibA.py    AS    X\nLibrary    LibA.py    AS    Y\n",
                            {"X": "X.Alpha Step", "Y": "Y.Alpha Step"}),
            "alias and plain": ("*** Settings ***\nLibrary    LibA.py    AS    X\nResource    plain.resource\n",
                                {"X": "X.Alpha Step", "LibA": "LibA.Alpha Step"}),
            # RF keeps `X` and `x` apart but matches the `X.` prefix to both: no call reaches one alone.
            "names differing in case": ("*** Settings ***\nLibrary    LibA.py    AS    X\nLibrary    LibA.py    AS    x\n",
                                        {"X": None, "x": None}),
        }
        self.write({"plain.resource": "*** Settings ***\nLibrary    LibA.py\n"})
        for label, (settings, expected) in cases.items():
            with self.subTest(label):
                uri = (self.root / "aliases.robot").as_uri()
                text = settings + "*** Test Cases ***\nT\n    No Operation\n"
                self.change(uri, text)
                listed = {g["namespace"]: g["keywords"] for g in self.keywords(uri)["imports"]
                          if g["uri"] and Path(g["uri"]).name == "LibA.py"}
                self.assertEqual({ns: [k["call"] for k in keywords] for ns, keywords in listed.items()},
                                 {ns: [call] for ns, call in expected.items()})
                calls = [call for call in expected.values() if call]
                for call in calls:  # each call text goes to the listed definition and runs in RF
                    keyword = next(k for ks in listed.values() for k in ks if k["call"] == call)
                    called = text + f"    {call}\n"
                    self.change(uri, called)
                    self.assertEqual(self.at("textDocument/definition", called, f"    {call}\n", uri, offset=4),
                                     [keyword["location"]])
                if calls:
                    self.assert_rf(settings + "*** Test Cases ***\nT\n" + "".join(f"    {c}\n" for c in calls), 0)
                self.assert_rf(settings + "*** Test Cases ***\nT\n    Alpha Step\n", 1,
                               "Multiple keywords with name 'Alpha Step' found")
        # A standard library under two aliases: each alias-qualified call runs without RF's conflict warning.
        text = ("*** Settings ***\nLibrary    Collections    AS    C1\nLibrary    Collections    AS    C2\n"
                "*** Test Cases ***\nT\n    No Operation\n")
        uri = (self.root / "stdaliases.robot").as_uri()
        self.change(uri, text)
        result = self.keywords(uri)
        calls = {ns: next(k["call"] for k in self.group(result, ns)["keywords"] if k["name"] == "Append To List")
                 for ns in ("C1", "C2")}
        self.assertEqual(calls, {"C1": "C1.Append To List", "C2": "C2.Append To List"})
        run = self.robot(text.replace("    No Operation\n", "    ${l}=    Create List\n"
                                      "    C1.Append To List    ${l}    1\n    C2.Append To List    ${l}    2\n"
                                      "    Length Should Be    ${l}    2\n"))
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertNotIn("found both from", run.stdout + run.stderr)

    def test_a_name_no_call_can_reach_alone_has_no_call_text(self):
        for name in ("TwinA.py", "TwinB.py"):
            self.write({name: "def twin_step():\n    pass\n"})
        uri = (self.root / "twins.robot").as_uri()
        # RF keeps the first library for an identical import name. Distinct case-sensitive
        # names remain separate instances, but keyword prefixes match case-insensitively.
        self.change(uri, TWINS.replace("TwinB.py    AS    Same", "TwinB.py    AS    same"))
        twins = [k for g in self.keywords(uri)["imports"] if g["namespace"].casefold() == "same" for k in g["keywords"]]
        self.assertEqual([(k["name"], k["call"]) for k in twins], [("Twin Step", None), ("Twin Step", None)])

    def test_reused_library_name_keeps_the_first_instance_in_explorer_and_robot(self):
        self.write({"TwinA.py": "def twin_step():\n    return 'first'\n",
                    "TwinB.py": "def twin_step():\n    return 'second'\n"})
        uri = (self.root / "first.robot").as_uri()
        text = TWINS.replace("    No Operation\n", "    ${value}=    Twin Step\n    Should Be Equal    ${value}    first\n")
        self.change(uri, text)
        groups = [g for g in self.keywords(uri)["imports"] if g["namespace"] == "Same"]
        self.assertEqual(len(groups), 1)
        self.assertEqual(Path(groups[0]["uri"]).name, "TwinA.py")
        self.assertEqual([(k["name"], k["call"]) for k in groups[0]["keywords"]], [("Twin Step", "Twin Step")])
        self.assert_rf(text, 0)

    def test_documentation_is_the_hover_of_the_definition_rf_uses(self):
        self.write({"Shapes.py": SHAPES})
        text = "*** Settings ***\nLibrary    Shapes.py\n*** Test Cases ***\nT\n    Shared Step\n"
        uri = (self.root / "shapes.robot").as_uri()
        self.change(uri, text)
        listed = self.group(self.keywords(uri), "Shapes")["keywords"]
        self.assertEqual([k["name"] for k in listed], ["Shared Step"])
        self.assertIn("Child implementation", listed[0]["documentation"])
        self.assertNotIn("Base implementation", listed[0]["documentation"])
        hover = self.at("textDocument/hover", text, "Shared Step", uri)
        self.assertEqual(hover["contents"], {"kind": "markdown", "value": listed[0]["documentation"]})
        self.assertEqual(listed[0]["location"], self.definition(text, "Shared Step", uri)[0])

    def test_follows_unsaved_import_and_library_changes(self):
        without = SUITE.replace("Library    Other.py\n", "")
        self.change(self.suite, without)
        result = self.keywords()
        self.assertEqual(result["version"], 2)
        self.assertNotIn("Other", [g["namespace"] for g in result["imports"]])
        self.assertEqual(self.group(result, "Audit")["keywords"][0]["call"], "Build Record")  # no longer ambiguous
        library = (self.root / "AuditLibrary.py").as_uri()
        self.client.send("textDocument/didOpen", {"textDocument": {
            "uri": library, "languageId": "python", "version": 1,
            "text": AUDIT + '\n\n@keyword("Fresh Step")\ndef fresh():\n    pass\n'}})
        self.assertIn("Fresh Step", [k["name"] for k in self.group(self.keywords(), "Audit")["keywords"]])
        self.client.send("textDocument/didClose", {"textDocument": {"uri": library}})
        self.assertNotIn("Fresh Step", [k["name"] for k in self.group(self.keywords(), "Audit")["keywords"]])

    def test_refuses_a_document_that_is_not_a_robot_file(self):
        with self.assertRaises(AssertionError) as caught:
            self.keywords((self.root / "AuditLibrary.py").as_uri())
        self.assertIn("not a Robot Framework file", str(caught.exception))


# A library whose `@keyword("Build Record")` names a module function and a class method.
RENAMED = '''from robot.api.deco import keyword


@keyword("Build Record")
def build_record(name="Ada"):
    """Build a record."""
    return name


def plain_step():
    return "plain"
'''
CALLS = ("*** Settings ***\nLibrary    Records.py    AS    Rec\nResource    via.resource\n*** Test Cases ***\nT\n"
         "    [Setup]    Build Record\n    ${a}=    Build Record    name=x\n    Should Be Equal    ${a}    x\n"
         "    ${b}=    Rec.Build Record\n    Run Keyword    Build Record\n    Given Build Record\n"
         "    Log    Build Record stays text\n    Via Step\n")
VIA = "*** Settings ***\nLibrary    Records.py    AS    Rec\n*** Keywords ***\nVia Step\n    Build Record    name=via\n"


class LibraryRenameTests(ExplorerTestCase):
    client_capabilities = {"workspace": {"workspaceEdit": {"documentChanges": True}}}

    def setUp(self):
        super().setUp()
        self.write({"Records.py": RENAMED, "via.resource": VIA})
        self.calls = (self.root / "calls.robot").as_uri()
        self.change(self.calls, CALLS)
        self.library = (self.root / "Records.py").as_uri()

    def rename(self, text, needle, new_name, uri=None, offset=0):
        return self.client.request("textDocument/rename", {
            "textDocument": {"uri": uri or self.calls}, "position": self.position(text, needle, offset=offset),
            "newName": new_name})

    def refusal(self, text, needle, new_name="Other Name", uri=None, offset=0):
        with self.assertRaises(AssertionError) as caught:
            self.rename(text, needle, new_name, uri, offset)
        return str(caught.exception)

    def test_renames_the_decorator_literal_and_every_call_as_rf_runs_them(self):
        edits = [self.rename(CALLS, "    ${b}=    Rec.Build Record", "Make Record", offset=18),
                 self.rename(RENAMED, "def build_record", "Make Record", self.library, offset=5),
                 self.rename(RENAMED, '@keyword("Build Record")', "Make Record", self.library, offset=11)]
        self.assertEqual(edits[0], edits[1])
        self.assertEqual(edits[0], edits[2])
        changes = {Path(c["textDocument"]["uri"]).name: c for c in edits[0]["documentChanges"]}
        self.assertEqual(sorted(changes), ["Records.py", "calls.robot", "via.resource"])
        # Versioned: the open suite's version, None for files read from disk.
        self.assertEqual({name: c["textDocument"]["version"] for name, c in changes.items()},
                         {"Records.py": None, "calls.robot": 1, "via.resource": None})
        library = apply_edits(RENAMED, changes["Records.py"]["edits"])
        self.assertEqual(library, RENAMED.replace('@keyword("Build Record")', '@keyword("Make Record")'))
        suite = apply_edits(CALLS, changes["calls.robot"]["edits"])
        expected = CALLS
        for before in ("[Setup]    ", "${a}=    ", "Rec.", "Run Keyword    ", "Given "):
            expected = expected.replace(f"{before}Build Record", f"{before}Make Record")
        self.assertEqual(suite, expected)
        self.assertIn("Log    Build Record stays text", suite)
        via = apply_edits(VIA, changes["via.resource"]["edits"])
        self.assertEqual(via, VIA.replace("Build Record", "Make Record"))
        self.assert_rf(CALLS, 0)  # after the requests: the run's module.robot is not part of the rename
        self.write({"Records.py": library, "via.resource": via})
        self.assert_rf(suite, 0)

    def test_prepare_rename_offers_the_keyword_name_at_the_python_definition(self):
        prepared = self.client.request("textDocument/prepareRename", {
            "textDocument": {"uri": self.library}, "position": self.position(RENAMED, "def build_record", offset=6)})
        self.assertEqual(prepared["placeholder"], "Build Record")
        self.assertEqual(prepared["range"], {"start": {"line": 4, "character": 4}, "end": {"line": 4, "character": 16}})
        literal = self.client.request("textDocument/prepareRename", {
            "textDocument": {"uri": self.library}, "position": self.position(RENAMED, '@keyword("Build', offset=12)})
        self.assertEqual(literal, {"placeholder": "Build Record",
                                   "range": {"start": {"line": 3, "character": 10}, "end": {"line": 3, "character": 22}}})

    def assert_unchanged(self):
        self.assertEqual((self.root / "Records.py").read_text(), RENAMED)
        self.assertEqual((self.root / "via.resource").read_text(), VIA)

    def test_refuses_with_the_reason_and_edits_nothing(self):
        cases = []
        plain = "*** Settings ***\nLibrary    Records.py\n*** Test Cases ***\nT\n    Plain Step\n"
        uri = (self.root / "plain.robot").as_uri()
        self.change(uri, plain)
        cases.append(("function name", self.refusal(plain, "    Plain Step", uri=uri, offset=4),
                      "its name comes from the Python function name plain_step"))
        cases.append(("existing resource keyword", self.refusal(CALLS, "Rec.Build Record", "Via Step", offset=5),
                      "in calls.robot that name already calls Via Step (Resource via.resource)"))
        cases.append(("standard keyword", self.refusal(CALLS, "Rec.Build Record", "Log", offset=5),
                      "that name already calls Log (Standard library BuiltIn)"))
        cases.append(("own function", self.refusal(CALLS, "Rec.Build Record", "Plain Step", offset=5),
                      "already has, or may have, a keyword or function of that name"))
        cases.append(("quote", self.refusal(CALLS, "Rec.Build Record", 'Say "Hi"', offset=5),
                      "cannot contain that quote or a backslash"))
        self.write({"Runner.py": 'from robot.libraries.BuiltIn import BuiltIn\n\n\ndef run_it():\n'
                                 '    return BuiltIn().run_keyword("Rec.Build Record")\n'})
        cases.append(("Python string", self.refusal(CALLS, "Rec.Build Record", offset=5),
                      "Runner.py:5 names it in a Python string, which rename does not change"))
        (self.root / "Runner.py").unlink()
        dynamic = RENAMED + ("\n\nclass Records:\n    def get_keyword_names(self):\n        return ['Build Record']\n\n"
                             "    def run_keyword(self, name, args):\n        return name\n")
        self.write({"Records.py": dynamic})
        cases.append(("dynamic", self.refusal(CALLS, "Rec.Build Record", offset=5), "get_keyword_names"))
        self.write({"Records.py": RENAMED.replace('@keyword("Build Record")', '@keyword("Build " "Record")')})
        cases.append(("concatenated", self.refusal(CALLS, "Rec.Build Record", offset=5),
                      "is not one plain single-line string literal"))
        self.write({"Records.py": RENAMED})
        with tempfile.TemporaryDirectory(prefix="rcb-outside-") as outside:
            (Path(outside) / "Far.py").write_text(RENAMED.replace("Build Record", "Far Step"))
            far = f"*** Settings ***\nLibrary    {Path(outside) / 'Far.py'}\n*** Test Cases ***\nT\n    Far Step\n"
            far_uri = (self.root / "far.robot").as_uri()
            self.change(far_uri, far)
            cases.append(("outside", self.refusal(far, "    Far Step", uri=far_uri, offset=4),
                          "outside the workspace folder"))
        for label, message, expected in cases:
            with self.subTest(label):
                self.assertIn(expected, message)
                self.assertIn("-32803", message)
        self.assert_unchanged()
        # prepareRename refuses before a name is typed, with the same reason.
        with self.assertRaises(AssertionError) as caught:
            self.client.request("textDocument/prepareRename", {
                "textDocument": {"uri": uri}, "position": self.position(plain, "    Plain Step", offset=4)})
        self.assertIn("its name comes from the Python function name plain_step", str(caught.exception))


if __name__ == "__main__":
    unittest.main()

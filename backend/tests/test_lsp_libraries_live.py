"""Required real-process conformance for class, hybrid and dynamic libraries and for keywords
run by `Run Keyword` and the other BuiltIn run-keyword variants. Never skips.

Every fixture suite is also run with the backend's own Robot Framework, so what definition,
hover, completion, references, rename and diagnostics claim is checked against what RF runs.
"""

from pathlib import Path
import subprocess
import sys
import sysconfig
import unittest
from unittest import mock

from client import Client, uri_file
from test_lsp_diagnostics_live import AMBIGUOUS, ERROR, NORTH, WARNING, RobotRunTestCase, apply_edits

# A static class library: inheritance, an override, a renamed private method, a static method,
# and names RF never makes keywords (a property, @not_keyword, a dunder).
SHAPES = '''from robot.api.deco import keyword, not_keyword


class Base:
    def base_step(self, value):
        """Run the base step."""
        return value

    def shared_step(self):
        return "base"

    @keyword("Custom Base")
    def _custom(self):
        pass


class Shapes(Base):
    ROBOT_LIBRARY_SCOPE = "GLOBAL"

    def __init__(self):
        self.attr_step = lambda: "attr"

    def shared_step(self):
        """The child's own shared step."""
        return "child"

    @property
    def prop_step(self):
        return 1

    @staticmethod
    def static_step(x):
        return x

    @not_keyword
    def hidden_step(self):
        pass
'''
CLASS_SUITE = ("*** Settings ***\nLibrary    Shapes.py\n*** Test Cases ***\nBase\n    Base Step    1\n"
               "Shared\n    ${v}=    Shared Step\n    Should Be Equal    ${v}    child\nCustom\n    Custom Base\n"
               "Attr\n    Attr Step\nStatic\n    Static Step    1\nProp\n    Prop Step\nHidden\n    Hidden Step\n"
               "Too Many\n    Base Step    1    2\n")
# Not imported by any suite: a same-named keyword there must never be chosen.
SHADOW = ("class ShapesShadow:\n    def base_step(self, value, other):\n        pass\n\n"
          "    def shadow_only_step(self):\n        pass\n")
# A module whose library is its one `@library` class (RF: auto_keywords=False by default).
HELPERS = ("from robot.api.deco import keyword, library\n\n\ndef module_step():\n    pass\n\n\n"
           "@library\nclass Impl:\n    @keyword\n    def impl_step(self):\n        pass\n\n"
           "    def not_auto(self):\n        pass\n")
KITS = ("class Kits:\n    def kit_step(self):\n        pass\n\n\n"
        "class Tools:\n    def tool_step(self, name):\n        pass\n")
HYBRID = ("from robot.api.deco import keyword\n\n\nclass Hyb:\n    def get_keyword_names(self):\n"
          "        return ['hyb_step', 'missing_one', '_renamed']\n\n    def hyb_step(self, x):\n        return x\n\n"
          "    @keyword('Renamed Hyb')\n    def _renamed(self):\n        pass\n\n    def unlisted(self):\n        pass\n")
DYNAMIC = ('class Dyn:\n    def get_keyword_names(self):\n        """Names only; RF runs them through run_keyword."""\n'
           '        return ["Dyn Step", "Other ${thing}", "Dyn Step"]\n\n'
           "    def run_keyword(self, name, args, kwargs):\n        return name\n")
DYNAMIC_ARGS = ("class DynArgs:\n    def get_keyword_names(self):\n        return ['Args Step']\n\n"
                "    def run_keyword(self, name, args):\n        return name\n\n"
                "    def get_keyword_arguments(self, name):\n        return ['one']\n")
DYNAMIC_COMPUTED = ("NAMES = ['Computed Step']\n\n\nclass DynComputed:\n    def get_keyword_names(self):\n"
                    "        return list(NAMES)\n\n    def run_keyword(self, name, args):\n        return name\n")
INDIRECT = ("*** Settings ***\nLibrary    Shapes.py\n*** Test Cases ***\nIndirect\n"
            "    Run Keyword    Local Step    a\n"
            "    Run Keyword If    False    Fail    no    ELSE IF    False    Fail    no    ELSE    Local Step    b\n"
            "    Run Keywords    Local Step    c    AND    No Args Step\n"
            "    Wait Until Keyword Succeeds    2x    0.01s    Local Step    d\n"
            "    Repeat Keyword    2 times    Local Step    e\n"
            "    Run Keyword    Run Keyword    Local Step    f\n"
            "    ${status}=    Run Keyword And Return Status    Base Step    1\n"
            "    BuiltIn.Run Keyword    Local Step    g\n"
            "    Run Keyword    Should Be True    $status\n"
            "    [Teardown]    Run Keyword    No Args Step\n"
            "Broken\n    Run Keyword    Missing Step\n"
            "Args\n    Run Keyword    Local Step\n"
            "Dynamic Name\n    ${name}=    Set Variable    Local Step\n    Run Keyword    ${name}    h\n"
            "*** Keywords ***\nLocal Step\n    [Arguments]    ${value}\n    Log    ${value}\n"
            "No Args Step\n    No Operation\n")


def names(items):
    return [item["label"] for item in items["items"]]


class LibraryTestCase(RobotRunTestCase):
    def setUp(self):
        super().setUp()
        self.write({"Shapes.py": SHAPES, "ShapesShadow.py": SHADOW})

    def spot(self, name, text, needle, occurrence=0, offset=0, length=None):
        """(file, line, start, end) of `needle` (or its first `length` code points after `offset`)."""
        start = self.position(text, needle, occurrence, offset)
        size = len(needle) - offset if length is None else length
        return name, start["line"], start["character"], start["character"] + size

    def places(self, locations):
        return sorted((Path(x["uri"]).name, x["range"]["start"]["line"], x["range"]["start"]["character"],
                       x["range"]["end"]["character"]) for x in locations)

    def defined(self, text, needle, occurrence=0, offset=0):
        return self.places(self.client.request("textDocument/definition", {
            "textDocument": {"uri": self.uri}, "position": self.position(text, needle, occurrence, offset)}))

    def complete(self, text, needle, occurrence=0, offset=None):
        offset = len(needle) if offset is None else offset
        return self.client.request("textDocument/completion", {
            "textDocument": {"uri": self.uri}, "position": self.position(text, needle, occurrence, offset)})

    def references(self, uri, text, needle, offset=0, include=True):
        return self.places(self.client.request("textDocument/references", {
            "textDocument": {"uri": uri}, "position": self.position(text, needle, offset=offset),
            "context": {"includeDeclaration": include}}))

    def published(self, uri):
        """The diagnostics last published for an open document (after a request round trip)."""
        self.client.request("workspace/symbol", {"query": "\u0000"})
        return [n["params"] for n in self.client.notifications
                if n.get("method") == "textDocument/publishDiagnostics" and n["params"]["uri"] == uri][-1]


class ClassLibraryTests(LibraryTestCase):

    def test_class_library_keywords_follow_rf_static_class_rules(self):
        diagnostics = self.change(self.uri, CLASS_SUITE)
        self.assertEqual([(*d, m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            (ERROR, "unknown-keyword", 15, 4, 15, 13, "No keyword with name 'Prop Step' found."),
            (ERROR, "unknown-keyword", 17, 4, 17, 15, "No keyword with name 'Hidden Step' found."),
            (ERROR, "arguments", 19, 4, 19, 13, "Keyword 'Base Step' expected 1 argument, got 2.")])
        self.assert_rf(CLASS_SUITE, 3, "8 tests, 5 passed, 3 failed", "No keyword with name 'Prop Step' found.",
                       "No keyword with name 'Hidden Step' found.", "expected 1 argument, got 2.")
        # Definitions: the inherited method, the override (never the base's), the renamed private one.
        for call, needle in (("Base Step", "    def base_step"), ("Shared Step", "    def shared_step"),
                             ("Custom Base", "    def _custom"), ("Static Step", "    def static_step")):
            with self.subTest(call=call):
                occurrence = 1 if call == "Shared Step" else 0
                self.assertEqual(self.defined(CLASS_SUITE, call), [
                    self.spot("Shapes.py", SHAPES, needle, occurrence, 8, len(needle) - 8)])
        # An instance attribute may be a keyword (RF runs it): never an error, never a definition.
        self.assertEqual(self.defined(CLASS_SUITE, "Attr Step"), [])
        hover = self.at("textDocument/hover", CLASS_SUITE, "Shared Step")["contents"]["value"]
        self.assertIn("Shared Step · Library Shapes · Shapes.py", hover)
        self.assertIn("The child's own shared step.", hover)
        base = self.at("textDocument/hover", CLASS_SUITE, "Base Step")["contents"]["value"]
        self.assertIn("Base Step    value", base)  # no `self`
        self.assertNotIn("self", base)
        static = self.at("textDocument/hover", CLASS_SUITE, "Static Step")["contents"]["value"]
        self.assertIn("Static Step    x", static)
        # Completion offers exactly the class's keywords (one Shared Step), never the shadow's.
        offered = names(self.client.request("textDocument/completion", {
            "textDocument": {"uri": self.uri}, "position": self.position(CLASS_SUITE, "    Static Step", offset=4)}))
        self.assertEqual(sorted(n for n in offered if n in ("Base Step", "Shared Step", "Custom Base", "Static Step",
                                                            "Prop Step", "Hidden Step", "Attr Step", "Init",
                                                            "Shadow Only Step")),
                         ["Base Step", "Custom Base", "Shared Step", "Static Step"])

    def test_references_identify_the_override_and_never_the_shadow(self):
        self.change(self.uri, CLASS_SUITE)
        shapes, shadow = self.root / "Shapes.py", self.root / "ShapesShadow.py"
        child = self.position(SHAPES, "    def shared_step", 1, 8)
        parent = self.position(SHAPES, "    def shared_step", 0, 8)
        calls = {self.spot("audit.robot", CLASS_SUITE, "Shared Step")}
        found = self.places(self.client.request("textDocument/references", {
            "textDocument": {"uri": shapes.as_uri()}, "position": child, "context": {"includeDeclaration": False}}))
        self.assertEqual(set(found), calls)
        found = self.places(self.client.request("textDocument/references", {
            "textDocument": {"uri": shapes.as_uri()}, "position": parent, "context": {"includeDeclaration": False}}))
        self.assertEqual(found, [])  # overridden: no call runs the base's method
        # The unimported shadow's same-named method is never what the suite calls.
        self.assertEqual(self.references(shadow.as_uri(), SHADOW, "    def base_step", offset=8, include=False), [])
        from_call = self.references(self.uri, CLASS_SUITE, "Base Step")
        self.assertNotIn("ShapesShadow.py", {place[0] for place in from_call})
        self.assertEqual(len(from_call), 3)  # the definition and both calls
        hover = self.at("textDocument/hover", CLASS_SUITE, "Base Step")["contents"]["value"]
        self.assertNotIn("ShapesShadow", hover)

    def test_aliases_and_duplicate_names(self):
        aliased = ("*** Settings ***\nLibrary    Shapes.py    AS    Geo\n*** Test Cases ***\nT\n"
                   "    Geo.Base Step    1\n    Base Step    2\n")
        self.assertEqual(self.change(self.uri, aliased), [])
        self.assert_rf(aliased, 0)
        definition = [self.spot("Shapes.py", SHAPES, "    def base_step", 0, 8, 9)]
        self.assertEqual(self.defined(aliased, "Geo.Base Step"), definition)
        hover = self.at("textDocument/hover", aliased, "Geo.Base Step")["contents"]["value"]
        self.assertIn("Library Geo · Shapes.py", hover)
        offered = names(self.client.request("textDocument/completion", {
            "textDocument": {"uri": self.uri}, "position": self.position(aliased, "Geo.Base Step", offset=4)}))
        self.assertIn("Geo.Base Step", offered)
        # Two methods of one class with one keyword name: RF fails both; neither is a definition.
        self.write({"Twin.py": "class Twin:\n    def ring_bell(self):\n        pass\n\n"
                               "    def ringBell(self):\n        pass\n\n    def other_step(self):\n        pass\n"})
        twin = "*** Settings ***\nLibrary    Twin.py\n*** Test Cases ***\nT\n    Ring Bell\nU\n    Other Step\n"
        self.assertEqual(self.change(self.uri, twin), [])
        self.assertEqual(self.defined(twin, "Ring Bell"), [])
        self.assert_rf(twin, 1, "2 tests, 1 passed, 1 failed", "Keyword with same name defined multiple times.")
        # A class keyword and a module keyword of one name: ambiguous, as RF says; qualify fixes it.
        self.write({"ClassBell.py": "class ClassBell:\n    def ring_bell(self):\n        pass\n",
                    "NorthLib.py": NORTH})
        both = "*** Settings ***\nLibrary    ClassBell.py\nLibrary    NorthLib.py\n*** Test Cases ***\nT\n    Ring Bell\n"
        diagnostics = self.change(self.uri, both)
        self.assertEqual(self.brief(diagnostics), [(WARNING, "ambiguity", 5, 4, 5, 13)])
        self.assertIn("ClassBell.Ring Bell (ClassBell.py), NorthLib.Ring Bell (NorthLib.py)",
                      diagnostics[0]["message"])
        self.assert_rf(both, 1, AMBIGUOUS)
        actions = self.actions(self.uri, diagnostics[0])
        self.assertEqual([a["title"] for a in actions], ["Use ClassBell.Ring Bell (ClassBell.py)",
                                                         "Use NorthLib.Ring Bell (NorthLib.py)"])
        fixed = apply_edits(both, actions[0]["edit"]["changes"][self.uri])
        self.assertEqual(self.change(self.uri, fixed), [])
        self.assert_rf(fixed, 0)

    def test_library_class_choice_follows_rf_imports(self):
        self.write({"Helpers.py": HELPERS, "Kits.py": KITS})
        decorated = ("*** Settings ***\nLibrary    Helpers.py\n*** Test Cases ***\nImpl\n    Impl Step\n"
                     "Module\n    Module Step\nNot Auto\n    Not Auto\n")
        diagnostics = self.change(self.uri, decorated)
        self.assertEqual([(d[1], d[2], m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            ("unknown-keyword", 6, "No keyword with name 'Module Step' found."),
            ("unknown-keyword", 8, "No keyword with name 'Not Auto' found.")])
        self.assert_rf(decorated, 2, "3 tests, 1 passed, 2 failed")
        self.assertEqual(self.defined(decorated, "Impl Step"),
                         [self.spot("Helpers.py", HELPERS, "    def impl_step", 0, 8, 9)])
        # `module.ClassName`: that class, under the import's full name; not the module's own class.
        dotted = ("*** Settings ***\nLibrary    Kits.Tools\n*** Test Cases ***\nTool\n    Tool Step    x\n"
                  "Qualified\n    Kits.Tools.Tool Step    y\nKit\n    Kit Step\n")
        diagnostics = self.change(self.uri, dotted)
        self.assertEqual([(d[1], d[2], m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            ("unknown-keyword", 8, "No keyword with name 'Kit Step' found.")])
        self.assert_rf(dotted, 1, "3 tests, 2 passed, 1 failed")
        tool = [self.spot("Kits.py", KITS, "    def tool_step", 0, 8, 9)]
        self.assertEqual(self.defined(dotted, "Tool Step"), tool)
        self.assertEqual(self.defined(dotted, "Kits.Tools.Tool Step"), tool)
        self.assertIn("Library Kits.Tools · Kits.py",
                      self.at("textDocument/hover", dotted, "Tool Step")["contents"]["value"])
        # The module itself, imported by name, is its own-named class.
        own = "*** Settings ***\nLibrary    Kits\n*** Test Cases ***\nT\n    Kit Step\nU\n    Tool Step    z\n"
        self.assertEqual([m["message"] for m in self.change(self.uri, own)], ["No keyword with name 'Tool Step' found."])
        self.assert_rf(own, 1, "2 tests, 1 passed, 1 failed")
        missing = "*** Settings ***\nLibrary    Kits.Missing\n*** Test Cases ***\nT\n    Anything\n"
        diagnostics = self.change(self.uri, missing)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", ERROR)])
        self.assertIn("Module does not contain 'Missing'.", diagnostics[0]["message"])


# A directory of the module's name: without __init__.py a namespace package, which loses to Kits.py.
KITS_TOOLS = "class Tools:\n    def shadow_tool_step(self):\n        pass\n"
# A regular package: its __init__.py beats Kits.py, and its own `Tools` beats the submodule.
KITS_PACKAGE = ("class Kits:\n    def package_kit_step(self):\n        pass\n\n\n"
                "class Tools:\n    def package_tool_step(self):\n        pass\n")
MODULE_SUITE = ("*** Settings ***\nLibrary    Kits.Tools\n*** Test Cases ***\nTool\n    Tool Step    x\n"
                "Shadow\n    Shadow Tool Step\n")
NOT_RESOLVED = "Library not resolved in this version"
INFORMATION = 3  # LSP DiagnosticSeverity


class ModuleSearchTests(LibraryTestCase):
    """Library module names follow Python's import precedence in the suite's directory, the one
    search path location that is modelled: a regular package, then a module, then a namespace."""

    def assert_resolved(self, text, needle, expected, others):
        """Definition, hover, completion and diagnostics agree that `needle` is `expected` (or unknown)
        and that the keywords `others` are not imported."""
        diagnostics = self.change(self.uri, text)
        unknown = {m["message"] for m in diagnostics if m.get("code") == "unknown-keyword"}
        self.assertEqual(self.defined(text, needle), expected)
        hover = self.at("textDocument/hover", text, needle)
        offered = names(self.complete(text, f"    {needle}", offset=5))
        if expected:
            self.assertNotIn(f"No keyword with name '{needle}' found.", unknown)
            self.assertIn(f" · {expected[0][0]}", hover["contents"]["value"])
            self.assertIn(needle, offered)
        else:
            self.assertIn(f"No keyword with name '{needle}' found.", unknown)
            self.assertIsNone(hover)
            self.assertNotIn(needle, offered)
        for other in others:
            self.assertNotIn(other, offered)
        return diagnostics

    def test_a_module_beats_a_namespace_directory_of_its_name(self):
        self.write({"Kits.py": KITS, "Kits/Tools.py": KITS_TOOLS})
        tool = [self.spot("Kits.py", KITS, "    def tool_step", 0, 8, 9)]
        diagnostics = self.assert_resolved(MODULE_SUITE, "Tool Step", tool, ["Shadow Tool Step"])
        self.assertEqual([(*d, m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            (ERROR, "unknown-keyword", 6, 4, 6, 20, "No keyword with name 'Shadow Tool Step' found.")])
        self.assert_rf(MODULE_SUITE, 1, "2 tests, 1 passed, 1 failed", "No keyword with name 'Shadow Tool Step' found.")
        self.assertIn("Library Kits.Tools · Kits.py",
                      self.at("textDocument/hover", MODULE_SUITE, "Tool Step")["contents"]["value"])
        self.assertEqual(self.defined(MODULE_SUITE, "Shadow Tool Step"), [])
        # References: the module's method has the suites' calls (module.robot is the suite RF ran);
        # the directory's same-named class has none.
        self.assertEqual(self.references((self.root / "Kits.py").as_uri(), KITS, "    def tool_step", offset=8,
                                         include=False),
                         [self.spot(suite, MODULE_SUITE, "Tool Step") for suite in ("audit.robot", "module.robot")])
        self.assertEqual(self.references((self.root / "Kits/Tools.py").as_uri(), KITS_TOOLS,
                                         "    def shadow_tool_step", offset=8, include=False), [])
        # A module is not a package: RF cannot import a submodule below it.
        deeper = "*** Settings ***\nLibrary    Kits.Sub.Tools\n*** Test Cases ***\nT\n    Anything\n"
        diagnostics = self.change(self.uri, deeper)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", ERROR)])
        self.assertIn("No module named 'Kits.Sub'; 'Kits' is not a package", diagnostics[0]["message"])
        self.assert_rf(deeper, 1, "No module named 'Kits.Sub'; 'Kits' is not a package")

    def test_without_the_module_the_namespace_directory_is_imported(self):
        self.write({"Kits/Tools.py": KITS_TOOLS})
        shadow = [self.spot("Tools.py", KITS_TOOLS, "    def shadow_tool_step", 0, 8, 16)]
        diagnostics = self.assert_resolved(MODULE_SUITE, "Shadow Tool Step", shadow, [])
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Tool Step' found."])
        self.assert_rf(MODULE_SUITE, 1, "2 tests, 1 passed, 1 failed", "No keyword with name 'Tool Step' found.")
        # Creating Kits.py on disk takes over on the next request, as it does for RF.
        self.write({"Kits.py": KITS})
        self.assert_resolved(MODULE_SUITE, "Tool Step", [self.spot("Kits.py", KITS, "    def tool_step", 0, 8, 9)],
                             ["Shadow Tool Step"])
        (self.root / "Kits.py").unlink()
        # A namespace may have portions in other search path locations, which are not modelled:
        # a name it lacks here is not resolved, and no keyword of the suite is reported unknown.
        missing = "*** Settings ***\nLibrary    Kits.Missing\n*** Test Cases ***\nT\n    Anything\n"
        diagnostics = self.change(self.uri, missing)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", INFORMATION)])
        self.assertIn(f"{NOT_RESOLVED}: Kits.Missing", diagnostics[0]["message"])
        self.assertEqual([m["message"] for m in self.change(self.uri, missing.replace("Kits.Missing", "Kits"))],
                         [f"{NOT_RESOLVED}: Kits"])

    def test_a_regular_package_beats_a_module_of_its_name(self):
        self.write({"Kits.py": KITS, "Kits/__init__.py": KITS_PACKAGE, "Kits/Tools.py": KITS_TOOLS})
        init = [self.spot("__init__.py", KITS_PACKAGE, "    def package_tool_step", 0, 8, 17)]
        text = MODULE_SUITE + "Package\n    Package Tool Step\n"
        diagnostics = self.assert_resolved(text, "Package Tool Step", init, ["Tool Step", "Shadow Tool Step"])
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Tool Step' found.",
                                                                "No keyword with name 'Shadow Tool Step' found."])
        self.assert_rf(text, 2, "3 tests, 1 passed, 2 failed")
        self.assertIn("Library Kits.Tools · __init__.py",
                      self.at("textDocument/hover", text, "Package Tool Step")["contents"]["value"])
        self.assertEqual(self.references((self.root / "Kits/__init__.py").as_uri(), KITS_PACKAGE,
                                         "    def package_tool_step", offset=8, include=False),
                         [self.spot(suite, text, "Package Tool Step") for suite in ("audit.robot", "module.robot")])
        # Imported by its own name, the package is its __init__'s class of that name.
        own = "*** Settings ***\nLibrary    Kits\n*** Test Cases ***\nT\n    Package Kit Step\nU\n    Kit Step\n"
        self.assert_resolved(own, "Package Kit Step", [self.spot("__init__.py", KITS_PACKAGE, "    def package_kit_step",
                                                                 0, 8, 16)], ["Kit Step"])
        self.assert_rf(own, 1, "2 tests, 1 passed, 1 failed", "No keyword with name 'Kit Step' found.")
        # An __init__ without `Tools`: `Kits.Tools` is then the submodule, never Kits.py's class.
        self.write({"Kits/__init__.py": ""})
        shadow = [self.spot("Tools.py", KITS_TOOLS, "    def shadow_tool_step", 0, 8, 16)]
        diagnostics = self.assert_resolved(MODULE_SUITE, "Shadow Tool Step", shadow, ["Tool Step"])
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Tool Step' found."])
        self.assert_rf(MODULE_SUITE, 1, "2 tests, 1 passed, 1 failed", "No keyword with name 'Tool Step' found.")
        # The common `from .Tools import Tools` in __init__: that module's class.
        self.write({"Kits/__init__.py": "from .Tools import Tools\n"})
        diagnostics = self.assert_resolved(MODULE_SUITE, "Shadow Tool Step", shadow, ["Tool Step"])
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Tool Step' found."])
        self.assert_rf(MODULE_SUITE, 1, "2 tests, 1 passed, 1 failed",
                       "No keyword with name 'Tool Step' found.")
        # An __init__ that extends `__path__` may find submodules elsewhere: not resolved, no error.
        self.write({"Kits/__init__.py": "from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n"})
        extended = "*** Settings ***\nLibrary    Kits.Missing\n*** Test Cases ***\nT\n    Anything\n"
        self.assertEqual([(d["code"], d["severity"]) for d in self.change(self.uri, extended)], [("import", INFORMATION)])
        self.write({"Kits/__init__.py": ""})
        # Neither attribute nor submodule: RF's import error.
        missing = "*** Settings ***\nLibrary    Kits.Missing\n*** Test Cases ***\nT\n    Anything\n"
        diagnostics = self.change(self.uri, missing)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", ERROR)])
        self.assertIn("Module does not contain 'Missing'.", diagnostics[0]["message"])
        self.assert_rf(missing, 1, "Module 'Kits' does not contain 'Missing'.")

    def test_a_package_that_changes_its_path_leaves_submodules_unresolved(self):
        # `__path__.append(...)` in place: RF imports Kits/more/Tools.py, which the backend cannot know.
        init = "import os\n\n__path__.append(os.path.join(os.path.dirname(__file__), 'more'))\n"
        self.write({"Kits/__init__.py": init, "Kits/more/Tools.py": KITS_TOOLS})
        text = "*** Settings ***\nLibrary    Kits.Tools\n*** Test Cases ***\nShadow\n    Shadow Tool Step\n"
        diagnostics = self.change(self.uri, text)
        self.assertEqual([(d["code"], d["severity"], d["message"]) for d in diagnostics],
                         [("import", INFORMATION, f"{NOT_RESOLVED}: Kits.Tools")])
        self.assert_rf(text, 0, "1 test, 1 passed, 0 failed")
        self.assertEqual(self.defined(text, "Shadow Tool Step"), [])
        # The same for a submodule below such a package, and for a relative import in its __init__.
        deeper = "*** Settings ***\nLibrary    Kits.Sub.Tools\n*** Test Cases ***\nShadow\n    Shadow Tool Step\n"
        self.write({"Kits/more/Sub/__init__.py": "", "Kits/more/Sub/Tools.py": KITS_TOOLS})
        self.assertEqual([(d["code"], d["severity"]) for d in self.change(self.uri, deeper)], [("import", INFORMATION)])
        self.assert_rf(deeper, 0, "1 test, 1 passed, 0 failed")
        self.write({"Kits/__init__.py": init + "from .Tools import Tools\n"})
        self.assertEqual([(d["code"], d["severity"]) for d in self.change(self.uri, text)], [("import", INFORMATION)])
        self.assert_rf(text, 0, "1 test, 1 passed, 0 failed")

    def test_module_function_libraries_keep_rf_rules(self):
        funcs = "def func_step(value):\n    return value\n\n\ndef _private():\n    pass\n"
        self.write({"Kits/funcs.py": funcs})
        # A module of functions in a namespace directory, imported by its dotted name.
        text = "*** Settings ***\nLibrary    Kits.funcs\n*** Test Cases ***\nT\n    Func Step    1\n"
        self.assertEqual(self.assert_resolved(text, "Func Step", [self.spot("funcs.py", funcs, "def func_step", 0, 4, 9)],
                                              ["Private"]), [])
        self.assert_rf(text, 0)
        # Kits.py beats the directory, and has no `funcs`.
        self.write({"Kits.py": KITS + "\n\ndef helper():\n    pass\n"})
        diagnostics = self.change(self.uri, text)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", ERROR)])
        self.assertIn("Module does not contain 'funcs'.", diagnostics[0]["message"])
        self.assertEqual(self.defined(text, "Func Step"), [])
        self.assert_rf(text, 1, "Module 'Kits' does not contain 'funcs'.")
        # A module's function is not a library.
        function = "*** Settings ***\nLibrary    Kits.helper\n*** Test Cases ***\nT\n    Anything\n"
        diagnostics = self.change(self.uri, function)
        self.assertEqual([(d["code"], d["severity"]) for d in diagnostics], [("import", ERROR)])
        self.assertIn("Expected class or module, got function.", diagnostics[0]["message"])
        self.assert_rf(function, 1, "Expected class or module, got function.")


# A package installed in the selected environment, outside the suite's folder.
INSTALLED = '''"""A library installed in the selected environment."""
from robot.api.deco import keyword


def installed_step(value):
    """Return the value from the installed library."""
    return value


@keyword("Installed Named Step")
def named_implementation():
    pass
'''
INSTALLED_TOOLS = "def installed_tool_step():\n    pass\n"
INSTALLED_SUITE = ("*** Settings ***\nLibrary    acme_installed\n*** Test Cases ***\nInstalled\n"
                   "    Installed Step    1\nNamed\n    Installed Named Step\nTypo\n    Installed Stepp    1\n")


class InstalledLibraryTests(LibraryTestCase):
    """A module name not found in the suite's folder is looked up on the language service's own
    sys.path: the selected interpreter's site-packages. The interpreter here is a real venv inside
    the folder, as a project `.venv` is, whose site-packages holds the library; a `.pth` file adds
    the test interpreter's site-packages for the backend and Robot Framework. The backend and the
    suites RF runs use that venv's interpreter."""

    def setUp(self):
        super().setUp()
        venv = self.root / ".venv"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv)], check=True, timeout=120)
        python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        site = Path(subprocess.run([str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                                   check=True, capture_output=True, text=True, timeout=60).stdout.strip())
        (site / "robot-companion-tests.pth").write_text(sysconfig.get_paths()["purelib"] + "\n", encoding="utf-8")
        self.site = site.resolve()
        for name, text in (("acme_installed/__init__.py", INSTALLED), ("acme_installed/tools.py", INSTALLED_TOOLS)):
            (site / name).parent.mkdir(parents=True, exist_ok=True)
            (site / name).write_text(text, encoding="utf-8")
        self.base = sys.executable
        patcher = mock.patch.object(sys, "executable", str(python))  # Client() and assert_rf start this interpreter
        patcher.start()
        self.addCleanup(patcher.stop)
        self.restart()

    def restart(self, argv=None):
        """A new language service process for the same folder, started with `argv`."""
        old = self.client
        old.request("shutdown")
        old.send("exit")
        self.assertEqual(old.process.wait(timeout=5), 0)
        old.close()
        self.client = Client(argv=argv)
        self.client.request("initialize", {"rootUri": self.root.as_uri(),
                                           "capabilities": {"textDocument": {"rename": {"prepareSupport": True}}}})
        self.client.send("initialized", {})
        self.versions = {}

    def test_installed_library_keywords_have_hover_definition_completion_and_diagnostics(self):
        diagnostics = self.change(self.uri, INSTALLED_SUITE)
        self.assertEqual([(*d, m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            (ERROR, "unknown-keyword", 8, 4, 8, 19, "No keyword with name 'Installed Stepp' found.")])
        self.assert_rf(INSTALLED_SUITE, 1, "3 tests, 2 passed, 1 failed",
                       "No keyword with name 'Installed Stepp' found.")
        definition = self.client.request("textDocument/definition", {
            "textDocument": {"uri": self.uri}, "position": self.position(INSTALLED_SUITE, "Installed Step")})
        self.assertEqual([Path(uri_file(x["uri"])).resolve() for x in definition], [self.site / "acme_installed" / "__init__.py"])
        self.assertEqual(self.defined(INSTALLED_SUITE, "Installed Step"),
                         [self.spot("__init__.py", INSTALLED, "def installed_step", 0, 4, 14)])
        self.assertEqual(self.defined(INSTALLED_SUITE, "Installed Named Step"),
                         [self.spot("__init__.py", INSTALLED, "def named_implementation", 0, 4, 20)])
        hover = self.at("textDocument/hover", INSTALLED_SUITE, "Installed Step")["contents"]["value"]
        self.assertIn("Return the value from the installed library.", hover)
        self.assertIn("Library acme_installed · __init__.py", hover)
        offered = names(self.complete(INSTALLED_SUITE, "    Installed Step", offset=6))
        self.assertIn("Installed Step", offered)
        self.assertIn("Installed Named Step", offered)
        # A submodule of the installed package, as Python imports it.
        tools = "*** Settings ***\nLibrary    acme_installed.tools\n*** Test Cases ***\nT\n    Installed Tool Step\n"
        self.assertEqual(self.change(self.uri, tools), [])
        self.assert_rf(tools, 0, "1 test, 1 passed, 0 failed")
        # The installed library is never edited: rename is refused with the reason.
        self.change(self.uri, INSTALLED_SUITE)
        with self.assertRaises(AssertionError) as caught:
            self.client.request("textDocument/prepareRename", {
                "textDocument": {"uri": self.uri}, "position": self.position(INSTALLED_SUITE, "Installed Named Step")})
        self.assertIn("installed in the selected environment", caught.exception.args[0]["error"]["message"])

    def test_a_module_in_the_suites_folder_beats_the_installed_one(self):
        self.write({"acme_installed.py": "def local_step():\n    pass\n"})
        text = "*** Settings ***\nLibrary    acme_installed\n*** Test Cases ***\nLocal\n    Local Step\nI\n    Installed Step    1\n"
        diagnostics = self.change(self.uri, text)
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Installed Step' found."])
        self.assert_rf(text, 1, "2 tests, 1 passed, 1 failed", "No keyword with name 'Installed Step' found.")
        self.assertEqual(self.defined(text, "Local Step"), [("acme_installed.py", 0, 4, 14)])

    def test_another_interpreter_without_the_package_does_not_resolve_it(self):
        # Each folder's language service runs in its own selected interpreter: without the
        # package on its sys.path the import stays unresolved and no keyword is reported unknown.
        self.restart([self.base, "-m", "robot_companion_backend", "lsp"])
        diagnostics = self.change(self.uri, INSTALLED_SUITE)
        self.assertEqual([(d["code"], d["severity"], d["message"]) for d in diagnostics],
                         [("import", INFORMATION, f"{NOT_RESOLVED}: acme_installed")])
        self.assertEqual(self.defined(INSTALLED_SUITE, "Installed Step"), [])


class DynamicLibraryTests(LibraryTestCase):

    def test_hybrid_library_names_are_its_listed_methods(self):
        self.write({"Hyb.py": HYBRID})
        suite = ("*** Settings ***\nLibrary    Hyb.py\n*** Test Cases ***\nHyb\n    Hyb Step    1\n"
                 "Renamed\n    Renamed Hyb\nMissing\n    Missing One\nUnlisted\n    Unlisted\n")
        diagnostics = self.change(self.uri, suite)
        self.assertEqual([(d[1], d[2], m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            ("unknown-keyword", 8, "No keyword with name 'Missing One' found."),
            ("unknown-keyword", 10, "No keyword with name 'Unlisted' found.")])
        self.assert_rf(suite, 2, "4 tests, 2 passed, 2 failed", "No keyword with name 'Missing One' found.")
        self.assertEqual(self.defined(suite, "Hyb Step"), [self.spot("Hyb.py", HYBRID, "    def hyb_step", 0, 8, 8)])
        self.assertEqual(self.defined(suite, "Renamed Hyb"),
                         [self.spot("Hyb.py", HYBRID, "    def _renamed", 0, 8, 8)])
        self.assertIn("Hyb Step    x", self.at("textDocument/hover", suite, "Hyb Step")["contents"]["value"])

    def test_dynamic_library_names_navigate_to_their_listed_name(self):
        self.write({"Dyn.py": DYNAMIC})
        suite = ("*** Settings ***\nLibrary    Dyn.py\n*** Test Cases ***\nDyn\n    Dyn Step    1    k=v\n"
                 "Embedded\n    Other things\nNot Listed\n    Not Listed Step\n")
        diagnostics = self.change(self.uri, suite)
        self.assertEqual([(d[1], d[2], m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            ("unknown-keyword", 8, "No keyword with name 'Not Listed Step' found.")])
        listed = self.spot("Dyn.py", DYNAMIC, '"Dyn Step"', 0, 1, 8)
        self.assertEqual(self.defined(suite, "Dyn Step"), [listed])
        self.assertEqual(self.defined(suite, "Other things"), [self.spot("Dyn.py", DYNAMIC, '"Other ${thing}"', 0, 1, 14)])
        hover = self.at("textDocument/hover", suite, "Dyn Step")["contents"]["value"]
        self.assertIn("Dyn Step · Library Dyn · Dyn.py", hover)
        self.assertIn("Dyn Step    *varargs    **kwargs", hover)  # RF's default dynamic signature
        offered = names(self.client.request("textDocument/completion", {
            "textDocument": {"uri": self.uri}, "position": self.position(suite, "    Not Listed Step", offset=4)}))
        self.assertIn("Dyn Step", offered)
        self.assertIn("Other ${thing}", offered)
        # References from the listed name in the library source find the call.
        dyn = (self.root / "Dyn.py").as_uri()
        self.assertEqual(self.references(dyn, DYNAMIC, '"Dyn Step"', offset=1, include=False),
                         [self.spot("audit.robot", suite, "Dyn Step")])
        self.assert_rf(suite, 1, "3 tests, 2 passed, 1 failed")  # after references: it writes a suite

    def test_unsupported_dynamic_contracts_stay_unresolved(self):
        self.write({"DynArgs.py": DYNAMIC_ARGS, "DynComputed.py": DYNAMIC_COMPUTED})
        # get_keyword_arguments is run code: the name is known, the signature is not.
        args = "*** Settings ***\nLibrary    DynArgs.py\n*** Test Cases ***\nT\n    Args Step    1    2    3\n"
        self.assertEqual(self.change(self.uri, args), [])
        hover = self.at("textDocument/hover", args, "Args Step")["contents"]["value"]
        self.assertIn("Arguments could not be read statically.", hover)
        self.assert_rf(args, 1, "expected 1 argument, got 3")
        # Computed names: nothing is guessed, nothing is reported.
        computed = ("*** Settings ***\nLibrary    DynComputed.py\n*** Test Cases ***\nT\n    Computed Step\n"
                    "U\n    Anything Else\n")
        self.assertEqual(self.change(self.uri, computed), [])
        self.assertEqual(self.defined(computed, "Computed Step"), [])
        self.assertIsNone(self.at("textDocument/hover", computed, "Computed Step"))
        self.assert_rf(computed, 1, "2 tests, 1 passed, 1 failed")


class RunKeywordTests(LibraryTestCase):

    def test_keywords_run_by_run_keyword_variants_resolve_like_calls(self):
        diagnostics = self.change(self.uri, INDIRECT)
        self.assertEqual([(*d, m["message"]) for d, m in zip(self.brief(diagnostics), diagnostics)], [
            (ERROR, "unknown-keyword", 15, 19, 15, 31, "No keyword with name 'Missing Step' found."),
            (ERROR, "arguments", 17, 19, 17, 29, "Keyword 'Local Step' expected 1 argument, got 0.")])
        self.assert_rf(INDIRECT, 2, "4 tests, 2 passed, 2 failed", "No keyword with name 'Missing Step' found.",
                       "Keyword 'Local Step' expected 1 argument, got 0.")
        local = [("audit.robot", 22, 0, 10)]
        for occurrence in range(8):
            with self.subTest(occurrence=occurrence):
                self.assertEqual(self.defined(INDIRECT, "Local Step", occurrence), local)
        self.assertEqual(self.defined(INDIRECT, "No Args Step"), [("audit.robot", 25, 0, 12)])
        self.assertEqual(self.defined(INDIRECT, "No Args Step", 1), [("audit.robot", 25, 0, 12)])  # [Teardown]
        self.assertEqual(self.defined(INDIRECT, "Base Step"),
                         [self.spot("Shapes.py", SHAPES, "    def base_step", 0, 8, 9)])
        # Other arguments of the variants are not keyword names; `${name}` is named at run time.
        self.assertEqual(self.defined(INDIRECT, "2 times"), [])
        self.assertEqual(self.defined(INDIRECT, "2x"), [])
        self.assertEqual(self.defined(INDIRECT, "Local Step", 8), [])  # the Set Variable value
        hover = self.at("textDocument/hover", INDIRECT, "Base Step")["contents"]["value"]
        self.assertIn("Base Step · Library Shapes · Shapes.py", hover)
        self.assertIn("Local Step · Local keyword · audit.robot",
                      self.at("textDocument/hover", INDIRECT, "Local Step", occurrence=1)["contents"]["value"])

    def test_failures_the_variant_catches_are_not_reported(self):
        # RF catches even "No keyword with name ..." and argument errors in these variants.
        caught = ("*** Test Cases ***\nCaught\n    Run Keyword And Ignore Error    Missing Step\n"
                  "    Run Keyword And Expect Error    *    Local Step\n"
                  "    ${ok}=    Run Keyword And Return Status    Run Keyword    Missing Step\n"
                  "    Run Keyword And Warn On Failure    Local Step    1    2\n"
                  "Retried\n    Wait Until Keyword Succeeds    2x    0s    Missing Step\n"
                  "*** Keywords ***\nLocal Step\n    [Arguments]    ${value}\n    Log    ${value}\n")
        diagnostics = self.change(self.uri, caught)
        self.assertEqual([(d[1], d[2]) for d in self.brief(diagnostics)], [("unknown-keyword", 7)])
        self.assertEqual(self.defined(caught, "Local Step"), [("audit.robot", 9, 0, 10)])  # still navigable
        self.assert_rf(caught, 1, "2 tests, 1 passed, 1 failed",
                       "failed after retrying 2 times. The last error was: No keyword with name 'Missing Step' found.")

    def test_references_and_rename_include_run_keyword_arguments(self):
        self.change(self.uri, INDIRECT)
        found = self.references(self.uri, INDIRECT, "Local Step\n", include=True)
        # The definition, seven runs in Indirect and the one in Args; the Set Variable value is none.
        self.assertEqual(len(found), 9)
        self.assertIn(("audit.robot", 22, 0, 10), found)
        self.assertIn(self.spot("audit.robot", INDIRECT, "Local Step", 5), found)  # Run Keyword    Run Keyword
        self.assertNotIn(19, {place[1] for place in found})
        # A keyword run by Run Keyword evaluates its expression argument as a call does: `$status`.
        self.assertIn(self.spot("audit.robot", INDIRECT, "$status", 0, 1),
                      self.references(self.uri, INDIRECT, "${status}=", offset=2))
        changes = self.client.request("textDocument/rename", {
            "textDocument": {"uri": self.uri}, "position": self.position(INDIRECT, "Local Step\n"),
            "newName": "Renamed Step"})["changes"]
        renamed = apply_edits(INDIRECT, changes[self.uri])
        self.assertEqual(renamed.count("Renamed Step"), 9)
        self.assertEqual(renamed.count("Local Step"), 1)  # only the run-time `Set Variable` value
        # The renamed suite behaves as before, except the runtime-named call now finds nothing.
        self.assert_rf(renamed, 3, "4 tests, 1 passed, 3 failed", "No keyword with name 'Local Step' found.")

    def test_completion_offers_keywords_in_keyword_name_arguments(self):
        text = ("*** Settings ***\nLibrary    Shapes.py\n*** Test Cases ***\nT\n    Run Keyword    Loc\n"
                "    Wait Until Keyword Succeeds    2x    1s    \n    Run Keyword If    \n"
                "    Run Keywords    No Args Step    AND    Bas\n"
                "*** Keywords ***\nLocal Step\n    No Operation\nNo Args Step\n    No Operation\n")
        self.change(self.uri, text)
        typed = self.complete(text, "    Run Keyword    Loc")
        self.assertIn("Local Step", names(typed))
        self.assertIn("Base Step", names(typed))
        edit = next(i for i in typed["items"] if i["label"] == "Local Step")["textEdit"]["range"]
        self.assertEqual(edit, {"start": {"line": 4, "character": 19}, "end": {"line": 4, "character": 22}})
        fresh = self.complete(text, "    Wait Until Keyword Succeeds    2x    1s    ")
        self.assertIn("Local Step", names(fresh))
        point = fresh["items"][0]["textEdit"]["range"]
        self.assertEqual(point["start"], point["end"])
        self.assertEqual(names(self.complete(text, "    Run Keyword If    ")), [])  # the condition comes first
        self.assertIn("Base Step", names(self.complete(text, "    AND    Bas")))
        self.assertNotIn("Shadow Only Step", names(typed))

    def test_unimported_and_shadowed_keywords_are_never_run_keyword_targets(self):
        # Only the unimported ShapesShadow.py defines Shadow Only Step; AShadow.py's Build Record too.
        text = ("*** Test Cases ***\nT\n    Run Keyword    Shadow Only Step\n    Run Keyword    Build Record\n")
        diagnostics = self.change(self.uri, text)
        self.assertEqual([m["message"] for m in diagnostics], ["No keyword with name 'Shadow Only Step' found.",
                                                               "No keyword with name 'Build Record' found."])
        self.assertEqual(self.defined(text, "Shadow Only Step"), [])
        self.assertEqual(self.defined(text, "Build Record"), [])
        self.assert_rf(text, 1, "No keyword with name 'Shadow Only Step' found.")
        # The import quick fix names the one defining file; it is never applied by itself.
        self.assertEqual([a["title"] for a in self.actions(self.uri, diagnostics[0])],
                         ["Import library ShapesShadow.py"])
        # A suite keyword named Run Keyword takes precedence: its arguments are plain values.
        own = ("*** Test Cases ***\nT\n    Run Keyword    Missing Step\n*** Keywords ***\nRun Keyword\n"
               "    [Arguments]    ${name}\n    Log    ${name}\n")
        self.assertEqual(self.change(self.uri, own), [])
        self.assertEqual(self.defined(own, "Missing Step"), [])
        self.assert_rf(own, 0)
        # A list variable before a name hides it: unresolved, never reported.
        hidden = ("*** Variables ***\n@{ARGS}    True    Missing Step\n*** Test Cases ***\nT\n"
                  "    Run Keyword If    @{ARGS}\n    Run Keyword If    @{ARGS}    Also Missing\n")
        self.assertEqual(self.change(self.uri, hidden), [])
        self.assertEqual(self.defined(hidden, "Also Missing"), [])

    def test_semantic_tokens_mark_keyword_name_arguments(self):
        self.change(self.uri, INDIRECT)
        data = self.client.request("textDocument/semanticTokens/full", {"textDocument": {"uri": self.uri}})["data"]
        tokens, line, start = set(), 0, 0
        for index in range(0, len(data), 5):
            delta_line, delta_start, length, kind, bits = data[index:index + 5]
            start = start + delta_start if delta_line == 0 else delta_start
            line += delta_line
            tokens.add((line, start, length, kind, bits))
        local = self.position(INDIRECT, "Local Step")
        missing = self.position(INDIRECT, "Missing Step")
        function, resolved = 3, 2  # TOKEN_TYPES index of "function"; the "resolved" modifier bit
        self.assertIn((local["line"], local["character"], 10, function, resolved), tokens)
        self.assertIn((missing["line"], missing["character"], 12, function, 0), tokens)


class InvalidationTests(LibraryTestCase):

    def test_library_edits_and_import_changes_are_seen_on_the_next_request(self):
        self.change(self.uri, CLASS_SUITE)
        shapes = self.root / "Shapes.py"
        # An unsaved editor change to the library: Base Step is renamed in the class.
        edited = SHAPES.replace("def base_step(self, value):", "def base_action(self, value):")
        self.open(shapes.as_uri(), edited, 1)
        diagnostics = self.published(self.uri)["diagnostics"]
        self.assertIn("No keyword with name 'Base Step' found.", [d["message"] for d in diagnostics])
        self.assertEqual(self.defined(CLASS_SUITE, "Base Step"), [])
        # Closing the editor falls back to the file on disk.
        self.client.send("textDocument/didClose", {"textDocument": {"uri": shapes.as_uri()}})
        self.assertEqual(self.defined(CLASS_SUITE, "Base Step"),
                         [self.spot("Shapes.py", SHAPES, "    def base_step", 0, 8, 9)])
        # A saved change on disk (a dynamic library now), seen without any notification.
        shapes.write_text("class Shapes:\n    def get_keyword_names(self):\n        return ['Base Step']\n\n"
                          "    def run_keyword(self, name, args):\n        pass\n", encoding="utf-8")
        self.assertEqual(self.defined(CLASS_SUITE, "Base Step"), [("Shapes.py", 2, 17, 26)])
        self.client.send("workspace/didChangeWatchedFiles", {"changes": [{"uri": shapes.as_uri(), "type": 2}]})
        messages = [d["message"] for d in self.published(self.uri)["diagnostics"]]
        self.assertIn("No keyword with name 'Shared Step' found.", messages)
        # Removing the import: nothing resolves to the library any more, and the shadow never does.
        without = CLASS_SUITE.replace("Library    Shapes.py\n", "")
        diagnostics = self.change(self.uri, without)
        self.assertIn("No keyword with name 'Base Step' found.", [d["message"] for d in diagnostics])
        self.assertEqual(self.defined(without, "Base Step"), [])
        self.assertEqual(self.at("textDocument/hover", without, "Base Step"), None)
        # Importing the shadow instead: now it is the imported library.
        shadowed = without.replace("*** Settings ***\n", "*** Settings ***\nLibrary    ShapesShadow.py\n")
        self.change(self.uri, shadowed)
        self.assertEqual(self.defined(shadowed, "Base Step"),
                         [self.spot("ShapesShadow.py", SHADOW, "    def base_step", 0, 8, 9)])


if __name__ == "__main__":
    unittest.main()

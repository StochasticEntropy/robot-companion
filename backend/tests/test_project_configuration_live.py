"""Required real-process conformance of the project Robot configuration (robotArguments) with
RF itself: import paths, variable files, command-line and scoped variables, duplicate library
names, ${CURDIR} imports and branch-sensitive variable diagnostics. Each expectation that
states RF behaviour is also checked by running the supported RF row on the same files."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import Client, DapClient
from robot_companion_backend.runtime import robot_version
from test_dap_lifecycle import processes_in

ERROR, WARNING, INFORMATION = 1, 2, 3
MARKER = "open(__file__ + '.executed', 'w').close()  # proves the file is never run by the services\n"
FILES = {
    "lib/pplib.py": MARKER + "def pp_kw(value='x'):\n    return value\n",
    "lib/pkg/__init__.py": "",
    "lib/pkg/mod.py": "def pkg_kw():\n    return 1\n",
    "lib/Alpha.py": "def ring():\n    return 'alpha'\n",
    "lib/Beta.py": "def ring():\n    return 'beta'\n",
    "rootmod.py": "def root_kw():\n    return 'root'\n",
    "suites/sibling.py": "def sibling_kw():\n    return 'sibling'\n",
    "res/shared.resource": "*** Keywords ***\nShared Kw\n    Log    shared\n",
    "vars/static.py": MARKER + "FROM_FILE = 'file'\nRES_DIR = 'not-res'\nLIST__ITEMS = ['a', 'b']\n_PRIVATE = 1\n",
    "vars/data.json": '{\n  "JSON_KEY": "j",\n  "NESTED": {"JSON_KEY": 1}\n}\n',
    "vars/dynamic.py": "def get_variables():\n    return {'DYNAMIC': 1}\n",
    "args.txt": "# Robot argument file\n--pythonpath lib\n",
}
CONFIGURED = ["--argumentfile", "args.txt", "-P", "res", "--variablefile", "vars/static.py",
              "-v", "ENV:prod", "--variable", "RES_DIR:res"]
MAIN = """*** Settings ***
Library    pplib
Library    pkg.mod
Library    rootmod
Resource    shared.resource
Variables    ${CURDIR}/../vars/data.json

*** Variables ***
${ENV}    local

*** Test Cases ***
Uses ${ENV}
    Pp Kw
    Pkg Kw
    Root Kw
    Shared Kw
    Log Many    ${FROM_FILE}    ${JSON_KEY}    ${ENV}    @{ITEMS}
"""


class ProjectTestCase(unittest.TestCase):
    """A workspace with lib/, res/ and vars/ next to suites/, and a backend started for it."""

    def setUp(self):
        from robot_companion_backend.runtime import unsupported_reason
        self.assertIsNone(unsupported_reason())  # a supported Python/RF row, never a skip
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-project-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name, text in {**FILES, "suites/main.robot": MAIN}.items():
            self.write(name, text)
        self.clients, self.versions, self.transcripts = [], {}, 0

    def tearDown(self):
        for client in self.clients:
            self.finish(client)
        self.assert_nothing_ran()

    def assert_nothing_ran(self):
        """Before RF itself runs: no service imported a workspace library or variable file."""
        self.assertEqual(sorted(p.name for p in self.root.rglob("*.executed")), [])

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def configuration(self, arguments=CONFIGURED):
        return {"version": 1, "cwd": str(self.root), "robotArguments": list(arguments)}

    def start(self, configuration=None, configured=True):
        """A language server for the workspace, with initializationOptions.robotConfiguration."""
        self.client = Client()
        self.clients.append(self.client)
        params = {"rootUri": self.root.as_uri(), "capabilities": {"textDocument": {
            "rename": {"prepareSupport": True}, "hover": {"contentFormat": ["plaintext"]}}}}
        if configured:
            params["initializationOptions"] = {"robotConfiguration": configuration or self.configuration()}
        result = self.client.request("initialize", params)
        self.client.send("initialized", {})
        self.versions = {}
        return result

    def finish(self, client):
        try:
            self.assertIsNone(client.process.poll(), "Backend exited before orderly shutdown")
            client.request("shutdown")
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()
            if directory := os.environ.get("RCB_TRANSCRIPTS"):
                target = Path(directory)
                target.mkdir(parents=True, exist_ok=True)
                self.transcripts += 1  # one file per backend process of the test
                (target / f"{self.id()}.{self.transcripts}.json").write_text(json.dumps({
                    "protocol": client.transcript, "stderr": client.stderr.decode(errors="replace")}, indent=2))

    def change(self, name, text):
        """Open or change a document; the diagnostics published for its new version."""
        uri = (self.root / name).as_uri()
        version = self.versions.get(uri, 0) + 1
        self.versions[uri] = version
        if version == 1:
            self.client.send("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": "robotframework", "version": version, "text": text}})
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
        return [(d["severity"], d["code"], d["range"]["start"]["line"], d["message"]) for d in diagnostics]

    @staticmethod
    def position(text, needle, occurrence=0, offset=0):
        lines = text.splitlines()
        line = [i for i, value in enumerate(lines) if needle in value][occurrence]
        return {"line": line, "character": lines[line].index(needle) + offset}

    def at(self, method, name, text, needle, occurrence=0, offset=0, **extra):
        return self.client.request(method, {"textDocument": {"uri": (self.root / name).as_uri()},
                                            "position": self.position(text, needle, occurrence, offset), **extra})

    def targets(self, name, text, needle, occurrence=0, offset=0):
        """(file relative to the workspace, 0-based line, start character) of each definition."""
        return [(Path(r["uri"].removeprefix("file://")).relative_to(self.root).as_posix(),
                 r["range"]["start"]["line"], r["range"]["start"]["character"])
                for r in self.at("textDocument/definition", name, text, needle, occurrence, offset)]

    def rename_error(self, name, text, needle):
        self.client.counter += 1
        self.client.send("textDocument/rename", {"textDocument": {"uri": (self.root / name).as_uri()},
                                                 "position": self.position(text, needle, 0, 2), "newName": "other"},
                         self.client.counter)
        while (message := self.client.messages.get(timeout=10)).get("id") != self.client.counter:
            self.client.notifications.append(message)
        return message["error"]["message"]

    def robot(self, suite, arguments=()):
        """Run the supported RF row in the workspace as Run Test does; output.xml's root."""
        self.assert_nothing_ran()
        output = self.root / "results" / (Path(suite).stem + ".xml")
        subprocess.run([sys.executable, "-m", "robot", *arguments, "--output", str(output), "--log", "NONE",
                        "--report", "NONE", "--console", "none", suite], cwd=self.root, check=False,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=120)
        self.forget_robot_runs()
        return ET.parse(output).getroot()

    def forget_robot_runs(self):
        for marker in self.root.rglob("*.executed"):  # RF itself runs them, as it should
            marker.unlink()

    @staticmethod
    def results(root):
        return {t.get("name"): (t.find("status").get("status"), t.find("status").text or "")
                for t in root.iter("test")}


class ImportPathTests(ProjectTestCase):

    def test_python_path_argument_files_and_run_folder_resolve_imports_as_robot_does(self):
        result = self.start()
        self.assertEqual(result["robotConfiguration"], {
            "version": 1, "cwd": str(self.root), "pythonPath": [str(self.root / "lib"), str(self.root / "res")],
            "variableFiles": [str(self.root / "vars/static.py")], "variables": ["${ENV}", "${RES_DIR}"], "errors": []})
        self.assertEqual(self.change("suites/main.robot", MAIN), [])
        self.assertEqual(self.targets("suites/main.robot", MAIN, "Pp Kw"), [("lib/pplib.py", 1, 4)])
        self.assertEqual(self.targets("suites/main.robot", MAIN, "Pkg Kw"), [("lib/pkg/mod.py", 0, 4)])
        self.assertEqual(self.targets("suites/main.robot", MAIN, "Root Kw"), [("rootmod.py", 0, 4)])
        self.assertEqual(self.targets("suites/main.robot", MAIN, "Shared Kw"), [("res/shared.resource", 1, 0)])
        # A module next to the suite is not on Robot's module search path.
        sibling = "*** Settings ***\nLibrary    sibling\n*** Test Cases ***\nT\n    Sibling Kw\n"
        self.assertEqual(self.brief(self.change("suites/sibling_user.robot", sibling)),
                         [(INFORMATION, "import", 1, "Library not resolved in this version: sibling")])
        self.assertEqual(self.targets("suites/sibling_user.robot", sibling, "Sibling Kw"), [])
        # RF agrees: with the configuration everything imports, the sibling module never does.
        self.write("suites/sibling_user.robot", sibling)
        results = self.results(self.robot("suites/main.robot", CONFIGURED))
        self.assertEqual(results, {"Uses prod": ("PASS", "")})
        results = self.results(self.robot("suites/main.robot", ["--argumentfile", "args.txt", "-P", "res"]))
        self.assertEqual(results, {"Uses local": ("FAIL", "Variable '${FROM_FILE}' not found.")})
        sibling_run = self.results(self.robot("suites/sibling_user.robot", CONFIGURED))
        self.assertEqual(sibling_run, {"T": ("FAIL", "No keyword with name 'Sibling Kw' found.")})

    def test_without_configuration_python_path_imports_are_not_resolved(self):
        result = self.start(configured=False)
        self.assertNotIn("robotConfiguration", result)
        diagnostics = self.brief(self.change("suites/main.robot", MAIN))
        self.assertEqual([d[:3] for d in diagnostics], [(INFORMATION, "import", 1), (INFORMATION, "import", 2),
                                                         (ERROR, "import", 4)])
        self.assertEqual(diagnostics[0][3], "Library not resolved in this version: pplib")
        self.assertTrue(diagnostics[2][3].startswith("Unresolved ResourceImport: shared.resource: "))
        # The folder Robot runs in stays on the search path (python -m robot, the debug worker).
        self.assertEqual(self.targets("suites/main.robot", MAIN, "Root Kw"), [("rootmod.py", 0, 4)])

    def test_invalid_configuration_is_reported_and_never_reads_stdin(self):
        for arguments, error in (
                (["--bogus"], "robotCompanion.robotArguments: option --bogus not recognized"),
                (["--argumentfile", "STDIN"], "robotCompanion.robotArguments: Reading arguments from STDIN is "
                                              "not supported by language and discovery services."),
                (["-A", "missing.txt"], "robotCompanion.robotArguments: Opening argument file '"),
                (["--variablefile", "vars/missing.py"], "--variablefile vars/missing.py: not found"),
                (["--variablefile", "vars/dynamic.py:x"], f"--variablefile {self.root / 'vars/dynamic.py'}: its "
                 "variables come from get_variables when Robot Framework runs it")):
            with self.subTest(arguments=arguments):
                result = self.start(self.configuration(arguments))
                self.assertEqual(len(result["robotConfiguration"]["errors"]), 1)
                self.assertTrue(result["robotConfiguration"]["errors"][0].startswith(error),
                                result["robotConfiguration"]["errors"])
                self.finish(self.clients.pop())
        # A malformed configuration object is a protocol error; nothing starts.
        self.client = Client()
        self.clients.append(self.client)
        with self.assertRaises(AssertionError) as raised:
            self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {},
                                               "initializationOptions": {"robotConfiguration": {"version": 2}}})
        self.assertEqual(raised.exception.args[0]["error"]["code"], -32602)
        self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {}})


class VariableTests(ProjectTestCase):

    def test_command_line_and_file_variables_follow_robot_precedence(self):
        self.start()
        text = MAIN + "    Log    ${MISSING}\n    Log    ${NESTED}[JSON_KEY] ${DYNAMIC}\n"
        diagnostics = self.brief(self.change("suites/main.robot", text))
        self.assertEqual(diagnostics, [
            (WARNING, "undefined-variable", 17, "Variable '${MISSING}' is not defined in this scope."),
            (WARNING, "undefined-variable", 18, "Variable '${DYNAMIC}' is not defined in this scope.")])
        # --variable overrides the Variables section: no source location, its value on hover.
        self.assertEqual(self.targets("suites/main.robot", text, "${ENV}", 2, 2), [])
        hover = self.at("textDocument/hover", "suites/main.robot", text, "${ENV}", 2, 2)["contents"]["value"]
        self.assertEqual(hover, "${ENV} · Command-line variable · robotCompanion.robotArguments (--variable)\n\n"
                                "Value: prod; it overrides suite variables.")
        self.assertEqual(self.targets("suites/main.robot", text, "${FROM_FILE}", 0, 2), [("vars/static.py", 1, 0)])
        self.assertEqual(self.targets("suites/main.robot", text, "@{ITEMS}", 0, 2), [("vars/static.py", 3, 0)])
        self.assertEqual(self.targets("suites/main.robot", text, "${JSON_KEY}", 0, 2), [("vars/data.json", 1, 3)])
        hover = self.at("textDocument/hover", "suites/main.robot", text, "${FROM_FILE}", 0, 2)["contents"]["value"]
        self.assertEqual(hover, "${FROM_FILE} · Variable file static.py, line 2\n\nValue: 'file'")
        items = self.client.request("textDocument/completion", {
            "textDocument": {"uri": (self.root / "suites/main.robot").as_uri()},
            "position": self.position(text, "${MISSING}", 0, 2)})["items"]
        details = {item["label"]: item["detail"] for item in items}
        self.assertEqual((details["${ENV}"], details["${FROM_FILE}"], details["${JSON_KEY}"]),
                         ("Command-line variable", "Variable file · static.py", "Variable file · data.json"))
        self.assertNotIn("${_PRIVATE}", details)
        for needle, message in (("${ENV}", "it is set on the command line"),
                                ("${FROM_FILE}", "it is defined in variable file static.py")):
            self.assertIn(message, self.rename_error("suites/main.robot", text, needle))
        # A variable file whose variables come from get_variables hides variables, not keywords.
        dynamic = text.replace("Variables    ${CURDIR}/../vars/data.json",
                               "Variables    ${CURDIR}/../vars/data.json\nVariables    ../vars/dynamic.py") + \
            "    Not A Keyword\n"
        self.assertEqual(self.brief(self.change("suites/main.robot", dynamic)), [
            (INFORMATION, "import", 6, "Variable file dynamic.py is not read completely: its variables come from "
                                       "get_variables when Robot Framework runs it."),
            (ERROR, "unknown-keyword", 20, "No keyword with name 'Not A Keyword' found.")])
        # RF agrees on precedence and on the missing variables.
        self.assertEqual(self.results(self.robot("suites/main.robot", CONFIGURED)), {"Uses prod": ("PASS", "")})
        self.write("suites/missing.robot", text.replace("Uses ${ENV}", "Missing"))
        results = self.results(self.robot("suites/missing.robot", CONFIGURED))
        self.assertEqual(results, {"Missing": ("FAIL", "Variable '${MISSING}' not found.")})

    def test_curdir_and_variable_based_imports_resolve_before_the_run(self):
        self.start(self.configuration(["-v", "RES_DIR:res"]))
        text = ("*** Settings ***\nResource    ${CURDIR}/../${RES_DIR}/shared.resource\n"
                "Library    ${BASE}/lib/Alpha.py\nResource    %{ROBOT_COMPANION_UNSET}/x.resource\n"
                "Resource    ${CURDIR}/missing.resource\n*** Variables ***\n${BASE}    ${CURDIR}/..\n"
                "*** Test Cases ***\nT\n    Shared Kw\n    Ring\n")
        diagnostics = self.brief(self.change("suites/vars.robot", text))
        self.assertEqual([d[:3] for d in diagnostics], [(INFORMATION, "import", 3), (ERROR, "import", 4)])
        self.assertEqual(diagnostics[0][3], "Import not resolved before the run: %{ROBOT_COMPANION_UNSET}/x.resource "
                                            "uses a variable whose value is known only when Robot Framework runs.")
        self.assertTrue(diagnostics[1][3].startswith("Unresolved ResourceImport: ${CURDIR}/missing.resource: "))
        self.assertEqual(self.targets("suites/vars.robot", text, "Shared Kw"), [("res/shared.resource", 1, 0)])
        self.assertEqual(self.targets("suites/vars.robot", text, "Ring"), [("lib/Alpha.py", 0, 4)])
        # RF agrees: both variable-based imports work; the missing resource is an import error.
        self.write("suites/vars.robot", text.replace("Resource    %{ROBOT_COMPANION_UNSET}/x.resource\n", ""))
        self.assertEqual(self.results(self.robot("suites/vars.robot", ["-v", "RES_DIR:res"])), {"T": ("PASS", "")})

    def test_scoped_variables_are_defined_where_robot_sets_them(self):
        self.start(configured=False)
        text = ("*** Test Cases ***\nFirst\n    VAR    ${suite_var}    s    scope=SUITE\n"
                "    Set Global Variable    ${g}    1\n    Log    ${suite_var}\n"
                "Second\n    Log    ${suite_var} ${g}\n")
        self.assertEqual(self.change("scoped.robot", text), [])
        self.assertEqual(self.targets("scoped.robot", text, "${suite_var}", 2, 2), [("scoped.robot", 2, 11)])
        self.assertEqual(self.targets("scoped.robot", text, "${g}", 1, 2), [("scoped.robot", 3, 27)])
        hover = self.at("textDocument/hover", "scoped.robot", text, "${suite_var}", 2, 2)["contents"]["value"]
        self.assertEqual(hover, "${suite_var} · Suite variable set with VAR scope=SUITE in test First (scoped.robot, "
                                "line 3)\n\nValue as written: s\n\nIt exists only after that step has run.")
        hover = self.at("textDocument/hover", "scoped.robot", text, "${g}", 1, 2)["contents"]["value"]
        self.assertEqual(hover, "${g} · Global variable set with Set Global Variable in test First (scoped.robot, "
                                "line 4)\n\nValue as written: 1\n\nIt exists only after that step has run.")
        # Inside First the VAR is the test's own definition, but other tests use it: no partial rename.
        self.assertIn("it is set with a non-local scope", self.rename_error("scoped.robot", text, "${suite_var}"))
        self.assertIn("non-local scope", self.rename_error("scoped.robot", text.replace("Log    ${suite_var} ${g}",
                                                                                         "Log    ${g}"), "${g}"))
        self.write("scoped.robot", text)
        self.assertEqual(self.results(self.robot("scoped.robot")), {"First": ("PASS", ""), "Second": ("PASS", "")})


class LibraryNameTests(ProjectTestCase):

    def test_duplicate_library_names_keep_the_first_import_as_robot_does(self):
        self.start(configured=False)
        text = ("*** Settings ***\nLibrary    ../lib/Alpha.py    AS    A\nLibrary    ../lib/Beta.py    AS    A\n"
                "Library    ../lib/Alpha.py    AS    First\nLibrary    ../lib/Alpha.py    AS    Second\n"
                "Library    ../lib/Alpha.py    AS    First\n*** Test Cases ***\nQualified\n    ${v}=    A.Ring\n    Should Be Equal    ${v}    alpha\n"
                "Unqualified\n    Ring\n")
        severity = INFORMATION if robot_version() == "7.3.2" else WARNING  # RF 7.3.2 only logs it
        diagnostics = self.brief(self.change("suites/alias.robot", text))
        self.assertEqual(diagnostics, [
            (severity, "import", 2, "Another library named 'A' is already imported (line 2). "
                                    "Robot Framework ignores this import."),
            (WARNING, "ambiguity", 11, "Multiple keywords with name 'Ring' found: A.Ring (Alpha.py), First.Ring "
                                       "(Alpha.py), Second.Ring (Alpha.py). Qualify the call with its library or "
                                       "resource name.")])
        self.assertEqual(self.targets("suites/alias.robot", text, "A.Ring", 0, 2), [("lib/Alpha.py", 0, 4)])
        self.assertEqual(self.targets("suites/alias.robot", text, "    Ring", 0, 4), [("lib/Alpha.py", 0, 4)])
        self.write("suites/alias.robot", text)
        results = self.results(self.robot("suites/alias.robot"))
        self.assertEqual(results["Qualified"], ("PASS", ""))
        self.assertEqual(results["Unqualified"][0], "FAIL")
        self.assertTrue(results["Unqualified"][1].startswith("Multiple keywords with name 'Ring' found."))


class BranchSensitiveTests(ProjectTestCase):
    SUITE = """*** Variables ***
${flag}    ${False}

*** Test Cases ***
Later
    Log    ${a}
    ${a}=    Set Variable    1
Branch
    IF    $flag
        ${b}=    Set Variable    1
    ELSE
        Log    ${b}
    END
Branch Maybe
    IF    $flag
        ${b}=    Set Variable    1
    END
    Log    ${b}
Except
    TRY
        Fail    y
    EXCEPT    x
        ${c}=    Set Variable    1
    EXCEPT    y
        Log    ${c}
    END
Finally
    TRY
        ${c}=    Set Variable    1
    EXCEPT    x
        Log    ${c}
    FINALLY
        Log    ${c}
    END
Loop
    FOR    ${i}    IN RANGE    2
        IF    ${i} == 1
            Log    ${d}
        END
        ${d}=    Set Variable    ${i}
    END
Same Step
    ${e}=    Set Variable    ${e}
Inline
    ${f}=    IF    not $flag    Set Variable    ${f}    ELSE    Set Variable    1
"""

    def test_uses_before_definition_or_in_another_branch_are_reported(self):
        self.start(configured=False)
        diagnostics = self.brief(self.change("flow.robot", self.SUITE))
        self.assertEqual(diagnostics, [
            (WARNING, "undefined-variable", 5, "Variable '${a}' is not defined here: it is first assigned on line 7."),
            (WARNING, "undefined-variable", 11, "Variable '${b}' is not defined here: it is only assigned in "
                                                "another IF/TRY branch (line 10)."),
            (WARNING, "undefined-variable", 24, "Variable '${c}' is not defined here: it is only assigned in "
                                                "another IF/TRY branch (line 23)."),
            (WARNING, "undefined-variable", 42, "Variable '${e}' is not defined here: it is first assigned on line 43."),
            (WARNING, "undefined-variable", 44, "Variable '${f}' is not defined here: it is first assigned on line 45.")])
        # RF fails at each reported use. A use after an IF that may not assign it (Branch Maybe) also
        # fails on this path but is not reported: possibly undefined uses are a named unsupported case.
        self.write("flow.robot", self.SUITE)
        self.assertEqual(self.results(self.robot("flow.robot")), {
            "Later": ("FAIL", "Variable '${a}' not found."), "Branch": ("FAIL", "Variable '${b}' not found."),
            "Branch Maybe": ("FAIL", "Variable '${b}' not found."), "Except": ("FAIL", "Variable '${c}' not found."),
            "Finally": ("PASS", ""), "Loop": ("PASS", ""), "Same Step": ("FAIL", "Variable '${e}' not found."),
            "Inline": ("FAIL", "Variable '${f}' not found.")})


class DiscoveryAndDebugTests(ProjectTestCase):

    def test_discovered_names_match_the_names_robot_runs_with_the_configuration(self):
        self.write("suites/tags.robot", "*** Settings ***\nTest Tags    env-${ENV}\n*** Variables ***\n${ENV}    local\n"
                                        "*** Test Cases ***\nOn ${ENV} with ${FROM_FILE}\n    No Operation\n")
        client = Client(service="discovery")
        self.clients.append(client)
        client.request("initialize", {"capabilities": {}})
        client.send("initialized", {})
        configured = client.request("robotCompanion/discoverTests", {
            "workspaceUri": self.root.as_uri(), "robotConfiguration": self.configuration()})
        plain = client.request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri()})

        def labels(result):
            return sorted(test["label"] for suite in result["items"] for test in suite["children"])
        self.assertEqual(labels(configured), ["On prod with file", "Uses prod"])
        self.assertEqual(labels(plain), ["On local with ${FROM_FILE}", "Uses local"])
        # Run Test reports these names, so Test Explorer results match the discovered items.
        ran = sorted(self.results(self.robot("suites", CONFIGURED)))
        self.assertEqual(ran, labels(configured))
        refused = Client(service="discovery")
        self.clients.append(refused)
        refused.request("initialize", {"capabilities": {}})
        with self.assertRaises(AssertionError) as raised:
            refused.request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri(),
                                                             "robotConfiguration": {"version": 1}})
        self.assertEqual(raised.exception.args[0]["error"]["code"], -32602)

    def test_debug_runs_with_the_same_configuration(self):
        self.write("suites/main.robot", MAIN)
        client = DapClient()
        self.addCleanup(client.close)
        try:
            self.assertTrue(client.request("initialize", {"adapterID": "robot-companion-native",
                                                          "linesStartAt1": True, "pathFormat": "path"})["success"])
            # The extension sends robotArguments and the run's output folder as launch args.
            launch = client.request("launch", {"target": "suites/main.robot", "cwd": str(self.root),
                                               "args": [*CONFIGURED, "--outputdir", str(self.root / "debug")]})
            self.assertTrue(launch["success"], launch)
            client.event("initialized")
            self.assertTrue(client.request("configurationDone", {"breakpoints": {}})["success"])
            self.assertEqual(client.event("exited")["exitCode"], 0)
            client.event("terminated")
            client.request("disconnect", {"terminateDebuggee": True})
            self.assertEqual(client.process.wait(timeout=10), 0)
        finally:
            client.close()
        self.assertFalse(client.forced_cleanup)
        self.assertEqual(processes_in(self.root), [])
        self.forget_robot_runs()
        self.assertEqual(self.results(ET.parse(self.root / "debug" / "output.xml").getroot()),
                         {"Uses prod": ("PASS", "")})


if __name__ == "__main__":
    unittest.main()

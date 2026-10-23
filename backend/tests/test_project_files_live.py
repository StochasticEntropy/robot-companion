"""Required real-process conformance of robot.toml settings and Markdown Robot sources.

robot.toml (RobotCode's documented format; RF reads no TOML): its applied settings reach the
language and discovery services as Robot arguments before robotCompanion.robotArguments, the
`project-config` command gives Run Test and the debugger the same arguments, and RF run with
them agrees. Validation and help are published on the TOML file itself.

Markdown (RF 7.5 reads `robot`/`robotframework` fenced blocks of `.robot.md` suites and `.md`
resources; RF 7.3.2 reads none): on the 7.5 row the services keep the Markdown file's lines and
columns, and RF's own run and debugger lines agree; on the 7.3.2 row the services say that RF
7.3.2 does not read the file, as RF itself ignores or refuses it. Both rows run every test."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from client import Client, DapClient
from robot_companion_backend import robot_toml
from robot_companion_backend.runtime import robot_version
from test_dap_lifecycle import children, processes_in

ERROR, WARNING, INFORMATION = 1, 2, 3
RF75 = robot_version() == "7.5"
MARKER = "open(__file__ + '.executed', 'w').close()  # proves the file is never run by the services\n"

PROJECT = {
    "lib/tomlkw.py": MARKER + "def toml_kw():\n    return 'toml'\n",
    "extra/extrakw.py": "def extra_kw():\n    return 'extra'\n",
    "vars/env.py": MARKER + "FROM_FILE = 'file'\n",
    "pyproject.toml": '[project]\nname = "demo"\n\n[tool.robot]\npython-path = ["replaced"]\n'
                      'extend-args = ["--variable", "FROM_PYPROJECT:p"]\n',
    "robot.toml": '# Robot settings for this project\npython-path = ["lib"]\nvariable-files = ["vars/env.py"]\n\n'
                  '[variables]\nENV = "staging"\nTARGET = "toml"\n',
    ".robot.toml": 'extend-python-path = ["extra"]\nextend-variables = { LOCAL = "yes" }\n',
}
SETTINGS = ["--variable", "TARGET:settings"]
MAIN = """*** Settings ***
Library    tomlkw
Library    extrakw

*** Variables ***
${ENV}    local

*** Test Cases ***
Check ${ENV}
    Toml Kw
    Extra Kw
    Log Many    ${ENV}    ${TARGET}    ${LOCAL}    ${FROM_FILE}    ${FROM_PYPROJECT}
    Should Be Equal    ${ENV}-${TARGET}-${LOCAL}    staging-settings-yes
"""
INVALID = """# robot.toml with problems
python-path = "lib"
output-dir = "results"
bogus = 1
[variables]
COUNT = 3
ENV = { expr = "1 + 2" }
[profiles.ci]
args = ["--dryrun"]
"""

# A Markdown suite with prose, a Python block, an unindented and an indented Robot block.
SUITE = """# Login suite

Prose that Robot Framework ignores: Missing Keyword    ${nothing}

```robot
*** Settings ***
Resource    keywords.md

*** Test Cases ***
First Test
    Shared Keyword
    Log    first
```

```python
print("not Robot")
```

- A list item with an indented block:

  ```robotframework
  *** Test Cases ***
  Second Test
      Shared Keyword
      Missing Keyword
  ```
"""
KEYWORDS = """# Shared keywords

```robot
*** Keywords ***
Shared Keyword
    Log    shared
```
"""
PLAIN = "*** Settings ***\nResource    keywords.md\n\n*** Test Cases ***\nPlain\n    Shared Keyword\n"
README = "# Read me\n\n```robot\n*** Test Cases ***\nExample Only\n    Not A Real Keyword\n```\n"


class ProjectFilesTestCase(unittest.TestCase):
    def setUp(self):
        from robot_companion_backend.runtime import unsupported_reason
        self.assertIsNone(unsupported_reason())  # a supported Python/RF row, never a skip
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-files-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.clients, self.versions, self.transcripts = [], {}, 0

    def tearDown(self):
        for client in self.clients:
            self.finish(client)
        self.assertEqual(sorted(p.name for p in self.root.rglob("*.executed")), [])

    def write(self, files):
        for name, text in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def start(self, arguments=(), service="lsp"):
        client = Client(service)
        self.clients.append(client)
        if service == "lsp":
            self.client = client
        result = client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {"textDocument": {
            "hover": {"contentFormat": ["markdown"]}}}, "initializationOptions": {"robotConfiguration": {
                "version": 1, "cwd": str(self.root), "robotArguments": list(arguments)}}})
        client.send("initialized", {})
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
                self.transcripts += 1
                (target / f"{self.id()}.{self.transcripts}.json").write_text(json.dumps({
                    "protocol": client.transcript, "stderr": client.stderr.decode(errors="replace")}, indent=2))

    def open(self, name, text=None, language="robotframework"):
        """Open a document; the diagnostics published for it."""
        path = self.root / name
        uri = path.as_uri()
        text = path.read_text() if text is None else text
        version = self.versions.get(uri, 0) + 1
        self.versions[uri] = version
        if version == 1:
            self.client.send("textDocument/didOpen", {"textDocument": {
                "uri": uri, "languageId": language, "version": version, "text": text}})
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
        return [(d["severity"], d["code"], d["range"]["start"]["line"], d["range"]["start"]["character"],
                 d["message"]) for d in diagnostics]

    def position(self, name, needle, occurrence=0, offset=0):
        lines = (self.root / name).read_text().splitlines()
        line = [i for i, value in enumerate(lines) if needle in value][occurrence]
        return {"line": line, "character": lines[line].index(needle) + offset}

    def at(self, method, name, needle, occurrence=0, offset=0, **extra):
        return self.client.request(method, {"textDocument": {"uri": (self.root / name).as_uri()},
                                            "position": self.position(name, needle, occurrence, offset), **extra})

    def targets(self, name, needle, occurrence=0, offset=0):
        return [(Path(r["uri"].removeprefix("file://")).relative_to(self.root).as_posix(),
                 r["range"]["start"]["line"], r["range"]["start"]["character"])
                for r in self.at("textDocument/definition", name, needle, occurrence, offset)]

    def project_config(self):
        """The `project-config` reply Run Test and the debugger use (the console script's module)."""
        completed = subprocess.run([sys.executable, "-m", "robot_companion_backend", "project-config", str(self.root)],
                                   capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual((completed.returncode, completed.stderr), (0, ""))
        return json.loads(completed.stdout)

    def robot(self, sources, arguments=()):
        """Run the supported RF row in the workspace as Run Test does: (output.xml root, stderr)."""
        self.assertEqual(sorted(p.name for p in self.root.rglob("*.executed")), [])
        output = self.root / "results" / "output.xml"
        completed = subprocess.run([sys.executable, "-m", "robot", *arguments, "--output", str(output), "--log",
                                    "NONE", "--report", "NONE", "--console", "none", *sources], cwd=self.root,
                                   capture_output=True, text=True, check=False, timeout=120,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        for marker in self.root.rglob("*.executed"):  # RF itself runs them, as it should
            marker.unlink()
        root = ET.parse(output).getroot() if output.is_file() else None
        return root, completed.stderr

    @staticmethod
    def results(root):
        return {t.get("name"): (t.find("status").get("status"), t.find("status").text or "")
                for t in root.iter("test")} if root is not None else {}


class RobotTomlTests(ProjectFilesTestCase):

    def test_applied_settings_reach_language_discovery_and_run_as_robot_arguments(self):
        self.write({**PROJECT, "suites/main.robot": MAIN})
        result = self.start(SETTINGS)
        summary = result["robotConfiguration"]
        self.assertEqual(summary["projectFiles"], [str(self.root / n) for n in ("pyproject.toml", "robot.toml",
                                                                                 ".robot.toml")])
        # robot.toml's python-path replaces pyproject's; .robot.toml's extend- settings add to it.
        self.assertEqual(summary["pythonPath"], [str(self.root / "lib"), str(self.root / "extra")])
        self.assertEqual(summary["variableFiles"], [str(self.root / "vars/env.py")])
        # The last --variable of a name wins, as in RF: robotArguments' TARGET overrides robot.toml's.
        self.assertEqual(summary["variables"], ["${ENV}", "${LOCAL}", "${FROM_PYPROJECT}", "${TARGET}"])
        self.assertEqual(summary["errors"], [])
        self.assertEqual(self.open("suites/main.robot"), [])
        self.assertEqual(self.targets("suites/main.robot", "Toml Kw"), [("lib/tomlkw.py", 1, 4)])
        self.assertEqual(self.targets("suites/main.robot", "Extra Kw"), [("extra/extrakw.py", 0, 4)])
        # A robot.toml variable is defined at its line in robot.toml; robotArguments override it.
        self.assertEqual(self.targets("suites/main.robot", "${ENV}", 1, 2), [("robot.toml", 5, 0)])
        self.assertEqual(self.targets("suites/main.robot", "${LOCAL}", 0, 2), [(".robot.toml", 1, 0)])
        self.assertEqual(self.targets("suites/main.robot", "${TARGET}", 0, 2), [])
        hover = self.at("textDocument/hover", "suites/main.robot", "${ENV}", 1, 2)["contents"]["value"].replace("\\", "")
        self.assertIn("Command-line variable · robot.toml [variables], line 6 (--variable)", hover)
        hover = self.at("textDocument/hover", "suites/main.robot", "${TARGET}", 0, 2)["contents"]["value"].replace("\\", "")
        self.assertIn("robotCompanion.robotArguments (--variable)", hover)
        # Run Test and the debugger: the same arguments from project-config, then the settings.
        report = self.project_config()
        self.assertEqual(report["files"], summary["projectFiles"])
        self.assertEqual(report["arguments"], [
            "--pythonpath", "lib", "--pythonpath", "extra", "--variable", "ENV:staging", "--variable", "TARGET:toml",
            "--variable", "LOCAL:yes", "--variablefile", "vars/env.py", "--variable", "FROM_PYPROJECT:p"])
        self.assertEqual(report["problems"], [])
        self.start(SETTINGS, "discovery")
        found = self.clients[-1].request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri(),
            "robotConfiguration": {"version": 1, "cwd": str(self.root), "robotArguments": SETTINGS}})
        self.assertEqual([t["label"] for s in found["items"] for t in s["children"]], ["Check staging"])
        root, _ = self.robot(["suites"], [*report["arguments"], *SETTINGS])
        self.assertEqual(self.results(root), {"Check staging": ("PASS", "")})

    def test_validation_and_help_are_published_on_the_configuration_file(self):
        self.write({"robot.toml": INVALID, "lib/tomlkw.py": "def toml_kw():\n    pass\n",
                    "suites/main.robot": "*** Settings ***\nLibrary    tomlkw\n"})
        summary = self.start()["robotConfiguration"]
        self.assertEqual(summary["pythonPath"], [])  # the invalid python-path is not applied
        self.assertIn("robot.toml:2: 'python-path' must be an array of strings; it is not applied.", summary["errors"])
        self.assertEqual(self.brief(self.open("robot.toml", language="toml")), [
            (ERROR, "robot-toml", 1, 0, "'python-path' must be an array of strings; it is not applied."),
            (WARNING, "robot-toml", 2, 0, "'output-dir' is a RobotCode setting Robot Companion does not apply (it "
             "applies `python-path`, `variables`, `variable-files`, `extensions`, `args`); pass Robot options with "
             "'args' instead."),
            (WARNING, "robot-toml", 3, 0, "Unknown robot.toml setting 'bogus'; it is not applied."),
            (ERROR, "robot-toml", 5, 0, "'variables.COUNT' must be a string (a name without ':'); it is not applied."),
            (WARNING, "robot-toml", 6, 0, "'variables.ENV' is a RobotCode expression; Robot Companion evaluates no "
             "expressions, so it is not applied."),
            (WARNING, "robot-toml", 7, 1, "'profiles': RobotCode profiles are not applied by Robot Companion (it "
             "applies `python-path`, `variables`, `variable-files`, `extensions`, `args` only).")])
        # The not applied python-path leaves the library unresolved, as Robot without it.
        self.assertEqual(self.brief(self.open("suites/main.robot")),
                         [(INFORMATION, "import", 1, 11, "Library not resolved in this version: tomlkw")])
        help_text = self.at("textDocument/hover", "robot.toml", "python-path", 0, 3)["contents"]
        self.assertEqual(help_text["kind"], "markdown")
        self.assertTrue(help_text["value"].startswith("**python-path** · Applied by Robot Companion as `--pythonpath`."))
        self.assertIn("not applied by Robot Companion", self.at("textDocument/hover", "robot.toml", "output-dir",
                                                                0, 2)["contents"]["value"])
        self.assertIsNone(self.at("textDocument/hover", "robot.toml", "# robot.toml"))
        self.assertEqual(self.at("textDocument/definition", "robot.toml", "python-path"), [])
        # An edit shows its problems before the services restart; a TOML syntax error is located.
        self.assertEqual(self.brief(self.open("robot.toml", 'python-path = ["lib"\nx = 1\n', "toml")), [
            (ERROR, "robot-toml", 1, 0, "Invalid TOML: Unclosed array (at line 2, column 1). This file is not "
             "applied.")])
        self.assertEqual(self.brief(self.open("robot.toml", 'python-path = ["lib"]\n', "toml")), [])

    def test_invalid_args_are_reported_and_robot_arguments_still_apply(self):
        self.write({"robot.toml": 'args = ["--no-such-option"]\n[variables]\nENV = "toml"\n',
                    "lib/tomlkw.py": "def toml_kw():\n    pass\n"})
        summary = self.start(["--pythonpath", "lib"])["robotConfiguration"]
        self.assertEqual(summary["pythonPath"], [str(self.root / "lib")])
        self.assertEqual(summary["variables"], [])
        self.assertEqual(summary["projectFiles"], [])
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(summary["errors"], ["robot.toml: option --nosuchoption not recognized; its settings are not "
                                             "applied."])

    def test_extensions_select_the_suites_discovery_lists_as_robot_runs_them(self):
        self.write({"robot.toml": 'extensions = "robot"\n', "a.robot": "*** Test Cases ***\nRobot Suite Test\n"
                    "    No Operation\n", "b.robot.md": "```robot\n*** Test Cases ***\nMarkdown Suite Test\n"
                    "    No Operation\n```\n"})
        self.start((), "discovery")
        discovery = self.clients[-1]
        found = discovery.request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri(),
            "robotConfiguration": {"version": 1, "cwd": str(self.root), "robotArguments": []}})
        self.assertEqual([t["label"] for s in found["items"] for t in s["children"]], ["Robot Suite Test"])
        self.assertNotIn("errors", found)
        root, _ = self.robot(["."], self.project_config()["arguments"])
        self.assertEqual(sorted(self.results(root)), ["Robot Suite Test"])
        (self.root / "robot.toml").write_text('extensions = "robot:robot.md"\n')
        found = self.clients[-1].request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri(),
            "robotConfiguration": {"version": 1, "cwd": str(self.root), "robotArguments": []}})
        if RF75:
            self.assertEqual([t["label"] for s in found["items"] for t in s["children"]],
                             ["Robot Suite Test", "Markdown Suite Test"])
        else:
            self.assertEqual([t["label"] for s in found["items"] for t in s["children"]], ["Robot Suite Test"])
            self.assertEqual([(Path(e["uri"]).name, e["message"]) for e in found["errors"]], [
                ("b.robot.md", "Not discovered: Robot Framework 7.3.2 does not read Markdown suites. Robot code in "
                 "Markdown needs Robot Framework 7.5.")])

    def test_project_config_command_reads_only_toml(self):
        self.write({"robot.toml": 'python-path = ["lib"]\nvariable-files = ["vars/env.py"]\n',
                    "vars/env.py": MARKER + "X = 1\n"})
        self.assertEqual(self.project_config(), {"version": 1, "files": [str(self.root / "robot.toml")],
                                                 "arguments": ["--pythonpath", "lib", "--variablefile", "vars/env.py"],
                                                 "problems": []})
        refused = subprocess.run([sys.executable, "-m", "robot_companion_backend", "project-config", "relative"],
                                 capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("project-config needs the absolute path of an existing workspace folder", refused.stderr)

    def test_json_schema_is_generated_from_the_applied_settings(self):
        # The extension ships this schema as schemas/robot-toml.schema.json; tests/integration
        # checks that file against this function's output.
        schema = robot_toml.schema()
        self.assertEqual(set(schema["properties"]), robot_toml.ROBOTCODE_KEYS)
        applied = {name for name, spec in schema["properties"].items() if "type" in spec}
        self.assertEqual(applied, {"python-path", "extend-python-path", "variables", "extend-variables",
                                   "variable-files", "extend-variable-files", "extensions", "args", "extend-args"})
        self.assertFalse(schema["additionalProperties"])


class MarkdownTests(ProjectFilesTestCase):

    def setUp(self):
        super().setUp()
        self.write({"login.robot.md": SUITE, "keywords.md": KEYWORDS, "plain.robot": PLAIN, "README.md": README})

    def test_language_features_keep_markdown_lines_and_columns(self):
        self.start()
        suite = self.open("login.robot.md", language="markdown")
        plain = self.open("plain.robot")
        readme = self.open("README.md", language="markdown")
        self.assertEqual(readme, [])  # no Robot file imports it: it is no Robot data
        if not RF75:
            message = ("Robot Framework 7.3.2 does not read Markdown files, so this {} is not used when Robot runs "
                       "and gets no Robot language features. Robot code in Markdown needs Robot Framework 7.5.")
            self.assertEqual(self.brief(suite), [(WARNING, "markdown-unsupported", 0, 0, message.format("suite"))])
            self.assertEqual(self.brief(self.open("keywords.md", language="markdown")),
                             [(WARNING, "markdown-unsupported", 0, 0, message.format("resource"))])
            refusal = ("Invalid resource file extension '.md'. Supported extensions are '.json', '.resource', "
                       "'.rest', '.robot', '.rsrc', '.rst', '.tsv' and '.txt'.")
            self.assertEqual(self.brief(plain), [(ERROR, "import", 1, 12, refusal)])
            self.assertEqual(self.targets("login.robot.md", "Shared Keyword"), [])
            self.assertIsNone(self.at("textDocument/hover", "login.robot.md", "Shared Keyword"))
            self.assertEqual(self.client.request("textDocument/documentSymbol", {"textDocument": {
                "uri": (self.root / "login.robot.md").as_uri()}}), [])
            # RF 7.3.2 agrees: it refuses the resource and does not run the Markdown suite.
            root, _ = self.robot(["."])
            self.assertIn(refusal, [m.text.split(": ", 1)[-1] for m in root.find("errors").iter("msg")])
            self.assertEqual(self.results(root), {"Plain": ("FAIL", "No keyword with name 'Shared Keyword' found.")})
            return
        self.assertEqual(self.brief(suite), [
            (ERROR, "unknown-keyword", 24, 6, "No keyword with name 'Missing Keyword' found.")])
        self.assertEqual(plain, [])
        self.assertEqual(self.open("keywords.md", language="markdown"), [])
        # Prose and fences are no Robot data; positions in blocks keep the file's columns.
        self.assertEqual(self.targets("login.robot.md", "Missing Keyword", 0), [])
        self.assertIsNone(self.at("textDocument/hover", "login.robot.md", "```robot"))
        self.assertEqual(self.targets("login.robot.md", "Shared Keyword", 0, 3), [("keywords.md", 4, 0)])
        self.assertEqual(self.targets("login.robot.md", "Shared Keyword", 1, 3), [("keywords.md", 4, 0)])
        self.assertEqual(self.targets("plain.robot", "Shared Keyword", 0, 3), [("keywords.md", 4, 0)])
        hover = self.at("textDocument/hover", "login.robot.md", "Shared Keyword", 1, 3)
        self.assertEqual(hover["range"], {"start": {"line": 23, "character": 6}, "end": {"line": 23, "character": 20}})
        references = self.at("textDocument/references", "keywords.md", "Shared Keyword", 0, 2,
                             context={"includeDeclaration": True})
        self.assertEqual(sorted((Path(r["uri"]).name, r["range"]["start"]["line"], r["range"]["start"]["character"])
                                for r in references),
                         [("keywords.md", 4, 0), ("login.robot.md", 10, 4), ("login.robot.md", 23, 6),
                          ("plain.robot", 5, 4)])
        # Completion in a Robot block offers the Markdown resource's keyword; rename edits every Markdown use.
        items = self.at("textDocument/completion", "login.robot.md", "Shared Keyword", 1, 6)
        items = items["items"] if isinstance(items, dict) else items
        self.assertIn("Shared Keyword", [item["label"] for item in items])
        edit = self.at("textDocument/rename", "keywords.md", "Shared Keyword", 0, 2, newName="Common Keyword")
        changes = {Path(uri).name: sorted((e["range"]["start"]["line"], e["range"]["start"]["character"],
                                           e["range"]["end"]["character"], e["newText"]) for e in edits)
                   for uri, edits in edit["changes"].items()}
        self.assertEqual(changes, {"keywords.md": [(4, 0, 14, "Common Keyword")],
                                   "login.robot.md": [(10, 4, 18, "Common Keyword"), (23, 6, 20, "Common Keyword")],
                                   "plain.robot": [(5, 4, 18, "Common Keyword")]})
        symbols = self.client.request("textDocument/documentSymbol", {"textDocument": {
            "uri": (self.root / "login.robot.md").as_uri()}})
        self.assertEqual([(s["name"], s["location"]["range"]["start"]) for s in symbols],
                         [("First Test", {"line": 9, "character": 0}), ("Second Test", {"line": 22, "character": 2})])
        names = {s["name"]: Path(s["location"]["uri"]).name for s in self.client.request("workspace/symbol",
                                                                                          {"query": ""})}
        self.assertEqual(names, {"Shared Keyword": "keywords.md", "First Test": "login.robot.md",
                                 "Second Test": "login.robot.md", "Plain": "plain.robot"})  # never README.md's
        data = self.client.request("textDocument/semanticTokens/full", {"textDocument": {
            "uri": (self.root / "login.robot.md").as_uri()}})["data"]
        tokens, line, start = [], 0, 0
        for index in range(0, len(data), 5):
            line, start = line + data[index], (start if data[index] == 0 else 0) + data[index + 1]
            tokens.append((line, start, data[index + 2]))
        self.assertIn((22, 2, len("Second Test")), tokens)  # the indented block's test name
        self.assertIn((23, 6, len("Shared Keyword")), tokens)
        self.assertFalse([t for t in tokens if t[0] < 5 or 12 <= t[0] <= 20])  # prose, fences, the Python block
        # RF 7.5 agrees with every diagnostic and definition: it runs both suites the same way.
        root, _ = self.robot(["."])
        self.assertEqual(self.results(root), {
            "First Test": ("PASS", ""), "Second Test": ("FAIL", "No keyword with name 'Missing Keyword' found."),
            "Plain": ("PASS", "")})

    def test_markdown_resources_are_resolved_by_path_not_by_file_name(self):
        """An imported docs/README.md is a resource; the unimported root README.md, which has the
        same name and a Robot block too, gets nothing on either row (no diagnostics, symbols or
        RF 7.3.2 warning)."""
        self.write({"docs/README.md": "# Docs\n\n```robot\n*** Keywords ***\nDocs Keyword\n    Log    docs\n```\n",
                    "suite.robot": "*** Settings ***\nResource    docs/README.md\n\n*** Test Cases ***\nUses Docs\n"
                                   "    Docs Keyword\n"})
        self.start()
        readme_uri = (self.root / "README.md").as_uri()
        self.assertEqual(self.open("README.md", language="markdown"), [])
        self.assertEqual(self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": readme_uri}}), [])
        names = {(s["name"], s["location"]["uri"].removeprefix(self.root.as_uri() + "/"))
                 for s in self.client.request("workspace/symbol", {"query": ""})}
        self.assertNotIn(("Example Only", "README.md"), names)
        docs = self.open("docs/README.md", language="markdown")
        suite = self.open("suite.robot")
        if RF75:
            self.assertEqual((docs, suite), ([], []))
            self.assertIn(("Docs Keyword", "docs/README.md"), names)
            self.assertEqual(self.targets("suite.robot", "Docs Keyword", 0, 2), [("docs/README.md", 4, 0)])
        else:
            self.assertEqual([d["code"] for d in docs], ["markdown-unsupported"])
            self.assertEqual([d["code"] for d in suite], ["import"])
        self.assertEqual(self.open("README.md", README + "\n", "markdown"), [])  # still nothing after an edit

    def test_discovery_lists_markdown_suites_at_their_lines(self):
        self.start((), "discovery")
        found = self.clients[-1].request("robotCompanion/discoverTests", {"workspaceUri": self.root.as_uri(),
            "robotConfiguration": {"version": 1, "cwd": str(self.root), "robotArguments": []}})
        suites = {s["label"]: [(t["label"], t["range"]["start"]) for t in s["children"]] for s in found["items"]}
        root, _ = self.robot(["."])
        if RF75:
            self.assertEqual(suites, {"Login": [("First Test", {"line": 9, "character": 0}),
                                                ("Second Test", {"line": 22, "character": 2})],
                                      "Plain": [("Plain", {"line": 4, "character": 0})]})
            self.assertEqual([s.get("name") for s in root.find("suite").findall("suite")], ["Login", "Plain"])
            self.assertNotIn("errors", found)
        else:
            self.assertEqual(suites, {"Plain": [("Plain", {"line": 4, "character": 0})]})
            self.assertEqual([(Path(e["uri"]).name, e["message"]) for e in found["errors"]], [
                ("login.robot.md", "Not discovered: Robot Framework 7.3.2 does not read Markdown suites. Robot code in "
                 "Markdown needs Robot Framework 7.5.")])
            self.assertEqual(sorted(self.results(root)), ["Plain"])  # RF 7.3.2 ignores the .robot.md file


class MarkdownViewConformanceTests(unittest.TestCase):
    """The services' Markdown view against RF 7.5's own MarkdownParser on generated files:
    the same Robot lines in the same order, each at the file line `rf_lines` maps RF's line to,
    and at the column the dedent removed. RF 7.3.2 has no Markdown parser at all."""

    PIECES = ("```robot\n", "```\n", "~~~robotframework\n", "~~~\n", "  ```robot\n", "  ```\n", "````robot\n",
              "````\n", "*** Test Cases ***\n", "T\n", "    Log    x\n", "  T2\n", "      No Operation\n", "\n",
              "   \n", "prose\n", "```python\n", "```Robot extra\n", "\t```robot\n", "\tT3\n", "\t    Log  y\n",
              "x\r\n", "  ```robot\r\n", "  T4\r\n", "\r\n", "  ```\r\n", "    Log  \u00fc\U0001d11e\r\n",
              "```   ROBOTFRAMEWORK\n", "~~~~\n", "``robot\n", "x```robot\n")

    def test_view_matches_robot_framework_markdown_parser(self):
        from robot_companion_backend import markdown
        if not RF75:
            import robot.running.builder.parsers as parsers
            self.assertFalse(hasattr(parsers, "MarkdownParser"))
            self.assertFalse(markdown.supported())
            return
        import random
        from io import BytesIO
        from robot.running.builder.parsers import MarkdownParser
        from robot.utils import FileReader
        generator = random.Random(490)
        same = lambda line: line.removesuffix("\r")  # noqa: E731 - RF reads a final lone CR as data
        for _ in range(4000):
            text = "".join(generator.choice(self.PIECES) for _ in range(generator.randint(1, 16)))
            text = ("\ufeff" if generator.random() < 0.1 else "") + (text.rstrip("\n") if generator.random() < 0.3 else text)
            expected = MarkdownParser(None)._read_markdown_data(FileReader(BytesIO(text.encode()))).split("\n")
            view, mapping = markdown.view(text), markdown.rf_lines(text)
            ours = view.text.split("\n")
            self.assertEqual(len(ours), len(text.split("\n")), repr(text))
            for number, line in enumerate(expected, 1):
                if number in mapping:
                    self.assertEqual(same(ours[mapping[number] - 1]), same(line), repr(text))
                else:
                    self.assertEqual(line.strip(), "", repr(text))
            self.assertEqual([same(l) for l in ours if l.strip()], [same(l) for l in expected if l.strip()], repr(text))
            for index, (offset, content) in enumerate(zip(view.offsets, ours)):
                if offset is not None and content:
                    self.assertEqual(text.split("\n")[index][offset:], content, repr(text))


NOT_READ = ("Robot Framework 7.3.2 does not read Markdown files, so this line never runs. Robot code in Markdown "
            "needs Robot Framework 7.5.")
CONTROL = "*** Settings ***\nResource    keywords.md\n\n*** Test Cases ***\nControl\n    Log    control\n    Shared Keyword\n"


class MarkdownDebugTests(unittest.TestCase):
    """The debugger's stack frames and breakpoints use the Markdown file's lines (RF 7.5 row);
    on RF 7.3.2 the suite is not run at all, and the run says so."""

    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp(prefix="rcb-md-dap-")).resolve()
        (self.workspace / "login.robot.md").write_text(SUITE)
        (self.workspace / "keywords.md").write_text(KEYWORDS)
        self.client = DapClient()

    def tearDown(self):
        self.client.close()
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self.id() + ".json")).write_text(json.dumps({
                "protocol": self.client.transcript, "stderr": self.client.stderr.decode(errors="replace")}, indent=2))
        try:
            self.assertFalse(self.client.forced_cleanup, "Test fallback cleaned up a product process leak")
            self.assertEqual(processes_in(self.workspace), [], "Owned Robot process leaked")
        finally:
            shutil.rmtree(self.workspace)

    def ok(self, command, arguments=None):
        response = self.client.request(command, arguments)
        self.assertTrue(response["success"], response)
        return response.get("body", {})

    def test_breakpoints_and_frames_use_markdown_lines(self):
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True, "columnsStartAt1": True,
                               "pathFormat": "path"})
        self.ok("launch", {"target": "login.robot.md", "cwd": str(self.workspace)})
        self.client.event("process")
        self.client.event("initialized")
        suite, keywords = str(self.workspace / "login.robot.md"), str(self.workspace / "keywords.md")
        self.ok("setBreakpoints", {"source": {"path": suite}, "breakpoints": [{"line": 24}, {"line": 3}]})
        self.ok("setBreakpoints", {"source": {"path": keywords}, "breakpoints": [{"line": 6}]})
        self.ok("configurationDone")
        verified = {}
        for _ in range(3):
            body = self.client.event("breakpoint")["breakpoint"]
            verified[(Path(body["source"]["path"]).name, body["line"])] = (body["verified"], body.get("message"))
        if not RF75:  # RF 7.3.2 reads no Markdown: every Markdown breakpoint says so and stays unverified
            self.assertEqual(verified, {key: (False, NOT_READ) for key in
                                        (("login.robot.md", 24), ("login.robot.md", 3), ("keywords.md", 6))})
        else:  # Line 24 (1-based) is `Shared Keyword` in the indented block; line 3 is prose.
            self.assertEqual(verified, {("login.robot.md", 24): (True, None),
                                        ("login.robot.md", 3): (False, "No executable Robot keyword call at this line"),
                                        ("keywords.md", 6): (True, None)})
        if not RF75:
            exited = self.client.event("exited")
            self.assertNotEqual(exited["exitCode"], 0)  # RF 7.3.2 cannot parse a Markdown suite
            self.client.event("terminated")
            self.ok("disconnect", {"terminateDebuggee": True})
            self.assertEqual(self.client.process.wait(timeout=10), 0)
            return
        stops = []
        for _ in range(3):
            stopped = self.client.event("stopped")
            frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
            stops.append([(f["name"], Path(f["source"]["path"]).name, f["line"]) for f in frames])
            self.ok("continue", {"threadId": 1})
        # First Test's Shared Keyword reaches keywords.md:6; Second Test's call stops at line 24.
        self.assertEqual(stops, [
            [("Log", "keywords.md", 6), ("Shared Keyword", "login.robot.md", 11), ("First Test", "login.robot.md", 10)],
            [("Shared Keyword", "login.robot.md", 24), ("Second Test", "login.robot.md", 23)],
            [("Log", "keywords.md", 6), ("Shared Keyword", "login.robot.md", 24), ("Second Test", "login.robot.md", 23)]])
        self.assertEqual(self.client.event("exited")["exitCode"], 1)  # Second Test fails as in RF's own run
        self.client.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)
        self.assertEqual(children(self.client.process.pid), [])


    def test_robot_suite_breakpoint_is_the_control_for_an_imported_markdown_resource(self):
        (self.workspace / "control.robot").write_text(CONTROL)
        self.ok("initialize", {"adapterID": "robot-companion-native", "linesStartAt1": True, "columnsStartAt1": True,
                               "pathFormat": "path"})
        self.ok("launch", {"target": "control.robot", "cwd": str(self.workspace)})
        self.client.event("process")
        self.client.event("initialized")
        control, keywords = str(self.workspace / "control.robot"), str(self.workspace / "keywords.md")
        self.ok("setBreakpoints", {"source": {"path": control}, "breakpoints": [{"line": 6}]})
        self.ok("setBreakpoints", {"source": {"path": keywords}, "breakpoints": [{"line": 6}]})
        self.ok("configurationDone")
        verified = {}
        for _ in range(2):
            body = self.client.event("breakpoint")["breakpoint"]
            verified[Path(body["source"]["path"]).name] = (body["verified"], body.get("message"))
        self.assertEqual(verified, {"control.robot": (True, None),
                                    "keywords.md": (True, None) if RF75 else (False, NOT_READ)})
        stops = []
        for _ in range(2 if RF75 else 1):
            self.client.event("stopped")
            frames = self.ok("stackTrace", {"threadId": 1})["stackFrames"]
            stops.append([(f["name"], Path(f["source"]["path"]).name, f["line"]) for f in frames])
            self.ok("continue", {"threadId": 1})
        expected = [[("Log", "control.robot", 6), ("Control", "control.robot", 5)]]
        if RF75:
            expected.append([("Log", "keywords.md", 6), ("Shared Keyword", "control.robot", 7), ("Control", "control.robot", 5)])
        self.assertEqual(stops, expected)
        # RF 7.3.2 refuses the `.md` import, so Shared Keyword fails as in its own run.
        self.assertEqual(self.client.event("exited")["exitCode"], 0 if RF75 else 1)
        self.client.event("terminated")
        self.ok("disconnect", {"terminateDebuggee": True})
        self.assertEqual(self.client.process.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()

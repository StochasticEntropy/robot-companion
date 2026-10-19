"""Mandatory conformance of the discovery service (normalized discovery API v1).

Real backend subprocesses over copied fixtures; results are compared with `robot --dryrun`
on the same workspace. Missing approved prerequisites fail, never skip.
"""

from collections import Counter
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote, urlsplit

from client import Client

TESTS = Path(__file__).parent
INITIALIZE = {"capabilities": {"robotCompanionDiscovery": {"version": 1}}}
METHOD = "robotCompanion/discoverTests"
# The documented entrypoint as installed in the acceptance venv; from source, `python -m`.
ENTRYPOINT = Path(sys.executable).with_name("robot-companion-backend")
NESTED = {
    "audit.robot": ["Debug Smoke"],
    "suites/broken_syntax.robot": ["Parsable Before Error", "Parsable After Error"],
    "suites/deeper/level_two/names.robot": [
        "Login On staging", "Region staging-eu Works", "Spaced Out", "Numbers 1.5 And 16",
        "Unknown ${NOT_DEFINED} Stays As Written",
        "Duplicate Name", "Duplicate Name", "Grüße aus Köln 🎉 und 𝄞", "Templated Equality"],
    "suites/side_effects.robot": ["Library Code Is Not Executed"],
    "suites/tagged.robot": ["Kept Test"],  # `robot:exclude` tests are dropped, as RF drops them
    "suites/tasks.robot": ["Archive Reports", "Notify Team ✉"],
}
MARKERS = ("library-imported.marker", "variables-imported.marker", "keyword-ran.marker",
           "suite-setup.marker", "test-body.marker")


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def uri_path(uri):
    return Path(unquote(urlsplit(uri).path))


def lsp_lines(text):
    """Lines as LSP clients count them: breaks only at \\n, \\r\\n and \\r."""
    return re.split(r"\r\n|\r|\n", text)


class DiscoveryTestCase(unittest.TestCase):
    def setUp(self):
        from robot_companion_backend.runtime import unsupported_reason
        self.assertIsNone(unsupported_reason())  # a supported Python/RF row, never a skip
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-discovery-")
        self.addCleanup(self.temp.cleanup)
        # A space in the folder name exercises URI percent-encoding.
        self.root = Path(self.temp.name) / "Discovery Workspace"
        self.root.mkdir()
        for path in (TESTS / "fixtures").iterdir():
            shutil.copyfile(path, self.root / path.name)
        shutil.copytree(TESTS / "discovery_fixtures", self.root, dirs_exist_ok=True)
        self.clients = []

    def start(self, initialize=True, **options):
        if "argv" not in options and ENTRYPOINT.is_file():
            options["argv"] = [str(ENTRYPOINT), "discovery"]
        client = Client("discovery", **options)
        self.clients.append(client)
        self.addCleanup(self.finish, client)
        if initialize:
            self.assertEqual(client.request("initialize", {"processId": None, "rootUri": None, "capabilities": {}}),
                             INITIALIZE)
            client.send("initialized", {})
        return client

    def finish(self, client):
        try:
            if not client.closed and client.process.poll() is None:
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()
            self.assertFalse(client.forced_cleanup, "Discovery needed forced process cleanup")
            if directory := os.environ.get("RCB_TRANSCRIPTS"):
                target = Path(directory)
                target.mkdir(parents=True, exist_ok=True)
                name = f"{self.id()}-{self.clients.index(client)}.json"
                (target / name).write_text(json.dumps({
                    "protocol": client.transcript, "stderr": client.stderr.decode(errors="replace")}, indent=2))

    def discover(self, client, root=None):
        return client.request(METHOD, {"workspaceUri": (root or self.root).as_uri()})

    @staticmethod
    def error(client, method, params):
        try:
            result = client.request(method, params)
        except AssertionError as exc:
            return exc.args[0]["error"]
        raise AssertionError(f"Expected a JSON-RPC error, got {result!r}")

    def relative(self, uri):
        return uri_path(uri).relative_to(self.root).as_posix()

    def assert_contract(self, result, root=None):
        """The v1 shape: file suites only, each file once, tests under their own file, URIs inside."""
        root_uri = (root or self.root).as_uri() + "/"
        self.assertEqual(result["version"], 1)
        self.assertLessEqual(set(result), {"version", "items", "errors"})
        uris = [suite["uri"] for suite in result["items"]]
        self.assertEqual(len(uris), len(set(uris)), "a file appears once")
        for suite in result["items"]:
            self.assertEqual(set(suite), {"kind", "label", "uri", "range", "children"})
            self.assertEqual(suite["kind"], "suite")
            self.assertTrue(suite["uri"].startswith(root_uri), suite["uri"])
            self.assertTrue(uri_path(suite["uri"]).is_file())
            self.assertTrue(suite["children"], "files without tests are omitted")
            for test in suite["children"]:
                self.assertEqual(set(test), {"kind", "label", "uri", "range"})
                self.assertEqual((test["kind"], test["uri"]), ("test", suite["uri"]))
                self.assertIsInstance(test["label"], str)
                for item in (suite, test):
                    for end in ("start", "end"):
                        self.assertEqual(set(item["range"][end]), {"line", "character"})
        for error in result.get("errors", ()):
            self.assertEqual(set(error), {"uri", "range", "message"})
            self.assertTrue(error["uri"].startswith(root_uri), error["uri"])

    def tree(self, result):
        return {self.relative(suite["uri"]): [test["label"] for test in suite["children"]]
                for suite in result["items"]}

    def dryrun(self, root=None):
        """RF's own run of the workspace, without executing keywords; RF's ExecutionResult reads it."""
        from robot.api import ExecutionResult
        root = root or self.root
        output = Path(self.temp.name) / "dryrun-output.xml"
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        completed = subprocess.run(
            [sys.executable, "-m", "robot", "--dryrun", "--norpa", "--extension", "robot", "--output", str(output),
             "--log", "NONE", "--report", "NONE", "--console", "dotted", str(root)],
            cwd=self.temp.name, env=environment, capture_output=True, text=True, timeout=120)
        self.assertLess(completed.returncode, 250, completed.stdout + completed.stderr)  # 250+: RF run error
        if directory := os.environ.get("RCB_TRANSCRIPTS"):
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(output, target / f"{self.id()}-dryrun-output.xml")
        return [(test.full_name, test.name, Path(test.source), test.lineno)
                for test in ExecutionResult(str(output)).suite.all_tests]

    @staticmethod
    def long_names(root, result):
        """RF long names of the discovered tests: RF's suite names of the folders, the file
        suite's label and the test's label."""
        from robot.running import TestSuite
        names = []
        for suite in result["items"]:
            path = uri_path(suite["uri"])
            folders = [root, *reversed(path.relative_to(root).parents[:-1])]
            folders = [TestSuite.name_from_source(root / folder) for folder in folders]
            names.extend(".".join([*folders, suite["label"], test["label"]]) for test in suite["children"])
        return names


class DiscoveryServiceTests(DiscoveryTestCase):
    def test_entrypoint_lifecycle_without_node_or_vscode(self):
        """The documented entrypoint over stdio with only the Python environment on PATH."""
        environment = {key: value for key, value in os.environ.items() if key not in ("NODE_OPTIONS", "VSCODE_PID")}
        environment["PATH"] = str(Path(sys.executable).parent)
        for program in ("node", "code", "npm"):
            self.assertIsNone(shutil.which(program, path=environment["PATH"]), program)
        client = self.start(initialize=False, env=environment)
        self.assertEqual(self.error(client, METHOD, {"workspaceUri": self.root.as_uri()})["code"], -32002)
        self.assertEqual(client.request("initialize", {"capabilities": {}}), INITIALIZE)
        client.send("initialized", {})
        self.assertEqual(self.error(client, "initialize", {"capabilities": {}})["code"], -32600)
        unknown = self.error(client, "robotCompanion/runTests", {"workspaceUri": self.root.as_uri()})
        self.assertEqual(unknown["code"], -32601)
        self.assertEqual(client.transcript[-1]["received"]["id"], client.counter)
        client.send("robotCompanion/unknownNotification", {})  # a notification gets no reply
        result = self.discover(client)
        self.assert_contract(result)
        self.assertEqual(self.tree(result), NESTED)
        self.assertIsNone(client.request("shutdown"))
        self.assertEqual(self.error(client, METHOD, {"workspaceUri": self.root.as_uri()})["code"], -32600)
        client.send("exit")
        self.assertEqual(client.process.wait(timeout=5), 0)
        if ENTRYPOINT.is_file():
            self.assertEqual(client.process.args, [str(ENTRYPOINT), "discovery"])
        # Only replies: an unknown notification is logged on stderr, never answered or notified.
        self.assertTrue(all("id" in entry["received"] for entry in client.transcript if "received" in entry))
        client.close()
        self.assertIn("Method not implemented: robotCompanion/unknownNotification", client.stderr.decode())

    def test_audit_and_nested_fixture_match_robot_dryrun(self):
        client = self.start()
        result = self.discover(client)
        self.assert_contract(result)
        self.assertEqual(self.tree(result), NESTED)
        self.assertEqual([self.relative(error["uri"]) for error in result["errors"]],
                         ["suites/broken_syntax.robot"] * 2)
        self.assertNotIn("suites/excluded/hidden_by_init.robot", self.tree(result))  # init `Test Tags`
        # Nothing ran: no library or variable file import, setup, keyword or test body.
        self.assertEqual([marker for marker in MARKERS if list(self.root.rglob(marker))], [])
        suites = {self.relative(suite["uri"]): suite for suite in result["items"]}
        self.assertEqual(suites["audit.robot"]["label"], "Audit")
        self.assertEqual(suites["suites/deeper/level_two/names.robot"]["label"], "Names")
        # Ranges: 0-based UTF-16 positions; a test starts on its name line and ends after its last cell.
        path = self.root / "suites/deeper/level_two/names.robot"
        lines = path.read_text(encoding="utf-8").splitlines()
        names = suites["suites/deeper/level_two/names.robot"]
        self.assertEqual(names["range"], {"start": {"line": 0, "character": 0},
                                          "end": {"line": len(lines) - 1, "character": utf16(lines[-1])}})
        by_label = {test["label"]: test for test in names["children"]}
        umlaut = by_label["Grüße aus Köln 🎉 und 𝄞"]
        line = lines.index("Grüße aus Köln 🎉 und 𝄞")
        self.assertEqual(umlaut["range"], {"start": {"line": line, "character": 0},
                                           "end": {"line": line + 1, "character": utf16(lines[line + 1])}})
        self.assertEqual(utf16(lines[line + 1]), len(lines[line + 1]) + 2)  # two surrogate pairs
        first, second = [test for test in names["children"] if test["label"] == "Duplicate Name"]
        self.assertLess(first["range"]["start"]["line"], second["range"]["start"]["line"])
        templated = by_label["Templated Equality"]
        self.assertEqual(templated["range"]["end"], {"line": len(lines) - 1, "character": utf16(lines[-1])})
        audit = suites["audit.robot"]["children"][0]
        audit_lines = (self.root / "audit.robot").read_text(encoding="utf-8").splitlines()
        self.assertEqual(audit["range"], {"start": {"line": audit_lines.index("Debug Smoke"), "character": 0},
                                          "end": {"line": 14, "character": len("    Log    ${record.name}")}})

        # RF's own run of the same workspace: the same tests, names, files and name lines.
        ran = self.dryrun()
        discovered = Counter((uri_path(suite["uri"]), test["range"]["start"]["line"] + 1, test["label"])
                             for suite in result["items"] for test in suite["children"])
        self.assertEqual(discovered, Counter((source, line, name) for _, name, source, line in ran))
        self.assertEqual(Counter(self.long_names(self.root, result)), Counter(name for name, *_ in ran))
        self.assertIn("Discovery Workspace.Suites.Deeper.Level Two.Names.Login On staging",
                      self.long_names(self.root, result))
        # Positive control: the dry run imports the library and variable file that discovery never touched.
        self.assertTrue((self.root / "suites/library-imported.marker").is_file())
        self.assertTrue((self.root / "suites/variables-imported.marker").is_file())

    def test_ignored_files_symlinks_and_resources_are_not_suites(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        test = "*** Test Cases ***\nOutside Test\n    No Operation\n"
        (outside / "outside.robot").write_text(test, encoding="utf-8")
        for relative in (".hidden/hidden.robot", ".git/inside_git.robot", "suites/.cache/deep/cached.robot",
                         "_private.robot", "_private_dir/private.robot", "CVS/versioned.robot",
                         "suites/notes.robot.txt", "suites/other.rbt", "suites/doc.robot.md"):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(test, encoding="utf-8")
        (self.root / "suites/tests_in.resource").write_text(test, encoding="utf-8")
        (self.root / "linked.robot").symlink_to(outside / "outside.robot")
        (self.root / "linked_dir").symlink_to(outside, target_is_directory=True)
        (self.root / "suites/again.robot").symlink_to(self.root / "audit.robot")
        (self.root / "suites/Upper.ROBOT").write_text(test.replace("Outside", "Upper"), encoding="utf-8")
        client = self.start()
        result = self.discover(client)
        self.assert_contract(result)
        self.assertEqual(self.tree(result), {**NESTED, "suites/Upper.ROBOT": ["Upper Test"]})
        for suite in result["items"]:
            self.assertTrue(uri_path(suite["uri"]).resolve().is_relative_to(self.root.resolve()))

    def test_parsing_errors_are_explicit(self):
        errors_dir = self.root / "errors"
        errors_dir.mkdir()
        (errors_dir / "__init__.robot").write_text("*** Settings ***\nBogus Init Setting    x\n", encoding="utf-8")
        (errors_dir / "latin1.robot").write_bytes("*** Test Cases ***\nCaf\xe9\n    No Operation\n".encode("latin-1"))
        (errors_dir / "fine.robot").write_text("*** Test Cases ***\nFine Test\n    No Operation\n", encoding="utf-8")
        unreadable = errors_dir / "unreadable.robot"
        unreadable.write_text("*** Test Cases ***\nHidden By Mode\n    No Operation\n", encoding="utf-8")
        unreadable.chmod(0)
        self.addCleanup(unreadable.chmod, 0o644)
        can_read = os.access(unreadable, os.R_OK)  # root ignores the mode
        client = self.start()
        result = self.discover(client)
        self.assert_contract(result)
        expected = {**NESTED, "errors/fine.robot": ["Fine Test"]}
        if can_read:
            expected["errors/unreadable.robot"] = ["Hidden By Mode"]
        self.assertEqual(self.tree(result), expected)
        errors = [(self.relative(e["uri"]), e["range"]["start"]["line"], e["message"]) for e in result["errors"]]
        broken = (self.root / "suites/broken_syntax.robot").read_text(encoding="utf-8").splitlines()
        self.assertIn(("suites/broken_syntax.robot", broken.index("    [Unknown Setting]    value"),
                       "Non-existing setting 'Unknown Setting'."), errors)
        self.assertTrue(any(path == "suites/broken_syntax.robot" and line == broken.index("*** Not A Section ***")
                            and message.startswith("Unrecognized section header") for path, line, message in errors))
        self.assertIn(("errors/__init__.robot", 1, "Non-existing setting 'Bogus Init Setting'."), errors)
        self.assertTrue(any(path == "errors/latin1.robot" and message.startswith("Reading failed: UnicodeDecodeError")
                            for path, _, message in errors))
        if not can_read:
            self.assertTrue(any(path == "errors/unreadable.robot" and message.startswith("Reading failed:")
                                for path, _, message in errors))
        # Every error is also logged on stderr; protocol stdout carries only framed messages.
        client.request("shutdown")
        client.send("exit")
        self.assertEqual(client.process.wait(timeout=5), 0)
        client.close()
        logged = client.stderr.decode()
        for path, line, message in errors:
            self.assertIn(f"Discovery error: {(self.root / path).as_uri()}:{line + 1}: {message}", logged)
        self.assertNotIn("Discovery error", json.dumps(client.transcript))

    def test_language_lines_never_import_language_modules(self):
        """A `language:` line naming a Python file makes RF import it; discovery never does,
        and protocol stdout stays clean although the module prints."""
        module = self.root / "evil_language.py"
        module.write_text("from pathlib import Path\nprint('stdout from a language module')\n"
                          "Path(__file__).with_name('language-imported.marker').write_text('imported')\n",
                          encoding="utf-8")
        languages = self.root / "languages"
        languages.mkdir()
        (languages / "custom.robot").write_text(
            f"language: {module}\n\n*** Test Cases ***\nCustom Language Line\n    No Operation\n", encoding="utf-8")
        (languages / "german.robot").write_text(
            "Language: German\n\n*** Testfälle ***\nDeutscher Test\n    No Operation\n", encoding="utf-8")
        client = self.start()
        result = self.discover(client)
        self.assert_contract(result)
        self.assertEqual(self.tree(result), {**NESTED, "languages/custom.robot": ["Custom Language Line"],
                                             "languages/german.robot": ["Deutscher Test"]})
        self.assertTrue(any(self.relative(e["uri"]) == "languages/custom.robot" and e["range"]["start"]["line"] == 0
                            and e["message"].startswith("Invalid language configuration") for e in result["errors"]))
        marker = self.root / "language-imported.marker"
        self.assertFalse(marker.exists())
        self.assertNotIn("stdout from a language module", client.stderr.decode())
        # Positive control: RF's own parser imports the module (RF then fails in its config
        # parser, so `robot` cannot run that file at all).
        from robot.api import get_model
        with self.assertRaises(ValueError):
            get_model(languages / "custom.robot")
        self.assertTrue(marker.is_file())
        (languages / "custom.robot").unlink()
        ran = self.dryrun()
        self.assertEqual(Counter(self.long_names(self.root, self.discover(client))), Counter(name for name, *_ in ran))
        self.assertIn("Discovery Workspace.Languages.German.Deutscher Test", [name for name, *_ in ran])

    def test_line_separators_numbers_and_depth_follow_rf_and_lsp(self):
        """RF numbers lines with str.splitlines; ranges are LSP lines, which break only at
        \\n, \\r\\n and \\r. Labels with RF number variables match RF's own run."""
        edge = Path(self.temp.name) / "Edge Workspace"
        edge.mkdir()
        separators = ("*** Test Cases ***\nFirst Test\n    No Operation    # note\u2028    Log    hidden 🎉\n"
                      "Second Test\n    Log    form\x0c    Log    feed\n")
        (edge / "separators.robot").write_text(separators, encoding="utf-8")
        big = "9" * 5000  # beyond Python's int() digit limit: RF converts it to a float
        (edge / "numbers.robot").write_text(
            f"*** Test Cases ***\nBig ${{{big}}} Value\n    No Operation\nHex ${{0x1F}} Bin ${{0b11}} Exp ${{1e3}}\n"
            "    No Operation\n", encoding="utf-8")
        client = self.start()
        result = self.discover(client, edge)
        self.assert_contract(result, edge)
        suites = {uri_path(suite["uri"]).name: suite for suite in result["items"]}
        lines = lsp_lines(separators)
        first, second = suites["separators.robot"]["children"]
        self.assertEqual(first["range"], {"start": {"line": 1, "character": 0},
                                          "end": {"line": 2, "character": utf16(lines[2])}})
        self.assertEqual(second["range"], {"start": {"line": 3, "character": 0},
                                           "end": {"line": 4, "character": utf16(lines[4])}})
        self.assertEqual(suites["separators.robot"]["range"]["end"], {"line": 4, "character": utf16(lines[4])})
        ran = self.dryrun(edge)
        self.assertEqual(sorted(name for _, name, *_ in ran),
                         sorted(test["label"] for suite in result["items"] for test in suite["children"]))
        self.assertIn("Big inf Value", [name for _, name, *_ in ran])
        self.assertEqual({name: line for _, name, _, line in ran}["Second Test"], 5)  # RF's line, not LSP's
        # A tree deeper than Python's recursion limit is still walked.
        deep = target = Path(self.temp.name) / "deep"
        deep.mkdir()
        levels = [deep]
        for _ in range(1100):  # pathlib's own recursive mkdir would hit the limit too
            target = target / "d"
            target.mkdir()
            levels.append(target)
        (target / "bottom.robot").write_text("*** Test Cases ***\nAt The Bottom\n    No Operation\n", encoding="utf-8")
        # Python 3.11's shutil.rmtree recurses once per level (3.12+ does not), so the temporary
        # directory cleanup could not remove this tree: remove it bottom-up first.
        self.addCleanup(lambda: ((target / "bottom.robot").unlink(), *map(Path.rmdir, reversed(levels))))
        result = self.discover(client, deep)
        self.assertEqual([test["label"] for suite in result["items"] for test in suite["children"]], ["At The Bottom"])

    def test_invalid_workspace_uris_are_errors(self):
        client = self.start()
        afile = (self.root / "audit.robot").as_uri()
        for uri in ("untitled:Untitled-1", "http://example.com/workspace", "vscode-remote://ssh/x",
                    "file://otherhost/tmp", "file:relative/workspace", "file:///../../etc", "file:///tmp/../etc",
                    self.root.as_uri() + "/./suites", self.root.as_uri() + "/missing", afile,
                    self.root.as_uri() + "?query", "file:///tmp/%00x", 42, None):
            with self.subTest(uri=uri):
                error = self.error(client, METHOD, {"workspaceUri": uri})
                self.assertEqual(error["code"], -32602, error)
        self.assertEqual(self.error(client, METHOD, {})["code"], -32602)
        self.assertEqual(self.error(client, METHOD, ["file:///"])["code"], -32602)
        # Still serving after the errors; a trailing slash and localhost name the same folder.
        nested = self.root / "suites"
        result = client.request(METHOD, {"workspaceUri": "file://localhost" + nested.as_uri()[7:] + "/"})
        self.assert_contract(result, nested)
        self.assertEqual({self.relative(s["uri"]) for s in result["items"]},
                         {path for path in NESTED if path.startswith("suites/")})

    def test_second_request_sees_added_edited_and_deleted_files(self):
        client = self.start()
        self.assertEqual(self.tree(self.discover(client)), NESTED)
        added = self.root / "suites/deeper/added.robot"
        added.write_text("*** Test Cases ***\nAdded Test\n    No Operation\n", encoding="utf-8")
        self.assertEqual(self.tree(self.discover(client)), {**NESTED, "suites/deeper/added.robot": ["Added Test"]})
        added.write_text("*** Test Cases ***\nRenamed Test\n    No Operation\nSecond Test\n    No Operation\n",
                         encoding="utf-8")
        tasks = self.root / "suites/tasks.robot"
        tasks.write_text(tasks.read_text(encoding="utf-8").replace("Archive Reports", "Archive All Reports"),
                         encoding="utf-8")
        edited = {**NESTED, "suites/deeper/added.robot": ["Renamed Test", "Second Test"],
                  "suites/tasks.robot": ["Archive All Reports", "Notify Team ✉"]}
        result = self.discover(client)
        self.assertEqual(self.tree(result), edited)
        (self.root / "audit.robot").unlink()
        (self.root / "suites/deeper/level_two/names.robot").unlink()
        (self.root / "suites/deeper/empty.robot").write_text(
            "*** Test Cases ***\nNo Longer Empty\n    No Operation\n", encoding="utf-8")
        deleted = {key: value for key, value in edited.items()
                   if key not in ("audit.robot", "suites/deeper/level_two/names.robot")}
        deleted["suites/deeper/empty.robot"] = ["No Longer Empty"]
        result = self.discover(client)
        self.assertEqual(self.tree(result), deleted)
        self.assertEqual(client.process.poll(), None)
        self.assertEqual(len(self.clients), 1, "one process served every request")
        ran = self.dryrun()
        self.assertEqual(Counter(self.long_names(self.root, result)), Counter(name for name, *_ in ran))

    def test_python_m_in_the_workspace_never_imports_workspace_modules(self):
        """`python -m` puts the cwd first on sys.path; discovery must not import a workspace `robot.py`."""
        (self.root / "robot.py").write_text(
            "from pathlib import Path\nPath(__file__).with_name('workspace-robot.marker').write_text('imported')\n",
            encoding="utf-8")
        client = self.start(cwd=self.root, argv=[sys.executable, "-m", "robot_companion_backend", "discovery"])
        self.assertEqual(self.tree(self.discover(client)), NESTED)
        self.assertFalse((self.root / "workspace-robot.marker").exists())


if __name__ == "__main__":
    unittest.main()

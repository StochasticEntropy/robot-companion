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
from urllib.parse import quote
from unittest.mock import patch

from client import Client, client_uri
import processes
from robot_companion_backend.workspace import file_uri_path

TESTS = Path(__file__).parent
INITIALIZE = {"capabilities": {"robotCompanionDiscovery": {"version": 1, "document": True}}}
METHOD = "robotCompanion/discoverTests"
# The documented entrypoint as installed in the acceptance venv (Windows: its .exe launcher);
# from source, `python -m`.
ENTRYPOINT = shutil.which("robot-companion-backend", path=str(Path(sys.executable).parent))
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
    return Path(file_uri_path(uri))


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
        if "argv" not in options and ENTRYPOINT:
            options["argv"] = [ENTRYPOINT, "discovery"]
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
                    "protocol": client.transcript, "stderr": client.stderr.decode(errors="replace")}, indent=2),
                    encoding="utf-8")

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
        """The v1 shape: file suites only, each file once, tests under their own file, URIs inside.
        The additive `parents` (a suite's directory suites below the folder, outermost first)
        and `tags` (a test's tags) are always present."""
        root_uri = (root or self.root).as_uri() + "/"
        self.assertEqual(result["version"], 1)
        self.assertLessEqual(set(result), {"version", "items", "errors"})
        uris = [suite["uri"] for suite in result["items"]]
        self.assertEqual(len(uris), len(set(uris)), "a file appears once")
        for suite in result["items"]:
            self.assertEqual(set(suite), {"kind", "label", "uri", "range", "children", "parents", "rpa"})
            self.assertIsInstance(suite["rpa"], bool)
            self.assertEqual(suite["kind"], "suite")
            self.assertTrue(suite["uri"].startswith(root_uri), suite["uri"])
            self.assertTrue(uri_path(suite["uri"]).is_file())
            self.assertTrue(suite["children"], "files without tests are omitted")
            folder = uri_path(root_uri)
            self.assertEqual([uri_path(parent["uri"]) for parent in suite["parents"]],
                             [folder / directory for directory in
                              reversed(uri_path(suite["uri"]).relative_to(folder).parents[:-1])])
            for parent in suite["parents"]:
                self.assertEqual(set(parent), {"label", "uri"})
                self.assertIsInstance(parent["label"], str)
            for test in suite["children"]:
                self.assertEqual(set(test), {"kind", "label", "uri", "range", "tags"})
                self.assertEqual((test["kind"], test["uri"]), ("test", suite["uri"]))
                self.assertIsInstance(test["label"], str)
                self.assertTrue(all(isinstance(tag, str) and tag for tag in test["tags"]), test["tags"])
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
        if ENTRYPOINT:
            self.assertEqual(client.process.args, [ENTRYPOINT, "discovery"])
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

    def test_directory_suites_and_tags_match_robot_dryrun(self):
        """Each file suite's directory suites (RF's names, an init file's `Name` included) and
        each test's tags (init and file `Test Tags`, `Default Tags`, `[Tags]`, `-tag` removal)
        are the ones RF's own run of the workspace reports."""
        rules = self.root / "tag rules" / "02__second level"
        rules.mkdir(parents=True)
        (rules.parent / "__init__.robot").write_text(
            "*** Settings ***\nName    Tag Policies\nTest Tags    team-a    nightly\n", encoding="utf-8")
        (rules / "__init__.robot").write_text("*** Settings ***\nTest Tags    level-two\n", encoding="utf-8")
        (rules / "policy.robot").write_text(
            "*** Settings ***\nTest Tags    area-billing\nDefault Tags    needs-review\n\n"
            "*** Test Cases ***\nUses Defaults\n    No Operation\n\n"
            "Own Tags\n    [Tags]    smoke    -nightly\n    No Operation\n\n"
            "Removes Level\n    [Tags]    -level-*\n    No Operation\n", encoding="utf-8")
        client = self.start()
        result = self.discover(client)
        self.assert_contract(result)
        from robot.api import ExecutionResult
        self.dryrun()
        ran = {(Path(test.source), test.lineno): test for test in
               ExecutionResult(str(Path(self.temp.name) / "dryrun-output.xml")).suite.all_tests}
        compared = 0
        for suite in result["items"]:
            for test in suite["children"]:
                expected = ran[(uri_path(test["uri"]), test["range"]["start"]["line"] + 1)]
                self.assertEqual(sorted(test["tags"]), sorted(expected.tags), test["label"])
                chain, parent = [], expected.parent.parent
                while parent is not None and parent.parent is not None:  # up to the folder's own suite
                    chain.insert(0, parent.name)
                    parent = parent.parent
                self.assertEqual([entry["label"] for entry in suite["parents"]], chain, test["label"])
                compared += 1
        self.assertEqual(compared, len(ran))
        policy = next(suite for suite in result["items"] if suite["uri"] == (rules / "policy.robot").as_uri())
        self.assertEqual([(entry["label"], uri_path(entry["uri"])) for entry in policy["parents"]],
                         [("Tag Policies", rules.parent), ("Second Level", rules)])
        self.assertEqual({test["label"]: sorted(test["tags"]) for test in policy["children"]}, {
            "Uses Defaults": ["area-billing", "level-two", "needs-review", "nightly", "team-a"],
            "Own Tags": ["area-billing", "level-two", "smoke", "team-a"],
            "Removes Level": ["area-billing", "nightly", "team-a"]})
        modes = {self.relative(suite["uri"]): suite["rpa"] for suite in result["items"]}
        self.assertEqual((modes["suites/tasks.robot"], modes["suites/tagged.robot"]), (True, False))
        tagged = next(suite for suite in result["items"] if suite["uri"].endswith("/suites/tagged.robot"))
        self.assertEqual([(test["label"], test["tags"]) for test in tagged["children"]], [("Kept Test", ["smoke"])])

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
        if processes.WINDOWS:  # a junction is a link Python 3.11's is_symlink() does not report
            import _winapi
            _winapi.CreateJunction(str(outside), str(self.root / "junction_dir"))
            self.assertFalse((self.root / "junction_dir").is_symlink())
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
        if processes.WINDOWS:
            # A mode does not deny reading on Windows; an open handle that shares nothing does.
            import _winapi
            handle = _winapi.CreateFile(str(unreadable), _winapi.GENERIC_READ, 0, 0, _winapi.OPEN_EXISTING, 0, 0)
            self.addCleanup(_winapi.CloseHandle, handle)
            can_read = False
        else:
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
        if processes.WINDOWS:  # 1,100 levels exceed MAX_PATH: an approved runner prerequisite
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem") as key:
                self.assertEqual(winreg.QueryValueEx(key, "LongPathsEnabled")[0], 1,
                                 "The Windows runner must enable long paths (LongPathsEnabled=1)")
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
        # Built from the real folder too, so only the named rule can refuse it on every platform.
        rooted = (self.root.as_uri() + "/..", self.root.as_uri() + "/../" + quote(self.root.name),
                  self.root.as_uri() + "/%00x", self.root.as_uri() + "/suites/../suites")
        # Windows: no request may reach a share or device, and Win32 trims trailing dots/spaces.
        windows = ("file:////server/share", "file:///%5C%5Cserver%5Cshare", "file:///%5C%5C%3F%5CC%3A%5C",
                   "file:///C:", "file:///C:relative", self.root.as_uri() + "/suites/...",
                   self.root.as_uri() + "/suites/.%20") if processes.WINDOWS else ()
        for uri in ("untitled:Untitled-1", "http://example.com/workspace", "vscode-remote://ssh/x",
                    "file://otherhost/tmp", "file:relative/workspace", "file:///../../etc", "file:///tmp/../etc",
                    self.root.as_uri() + "/./suites", self.root.as_uri() + "/missing", afile,
                    self.root.as_uri() + "?query", "file:///tmp/%00x", 42, None, *rooted, *windows):
            with self.subTest(uri=uri):
                error = self.error(client, METHOD, {"workspaceUri": uri})
                self.assertEqual(error["code"], -32602, error)
        self.assertEqual(self.error(client, METHOD, {})["code"], -32602)
        self.assertEqual(self.error(client, METHOD, ["file:///"])["code"], -32602)
        # Still serving after the errors; a trailing slash and localhost name the same folder.
        nested = self.root / "suites"
        result = client.request(METHOD, {"workspaceUri": "file://localhost" + nested.as_uri()[7:] + "/"})
        self.assert_contract(result, nested)
        # The folder URI exactly as VS Code writes it (Windows: lower-case drive, `%3A`, `%20`) names
        # the same folder; every returned URI maps back to a file inside it.
        same = client.request(METHOD, {"workspaceUri": client_uri(self.root)})
        self.assertEqual(self.tree(same), self.tree(self.discover(client)))
        for suite in same["items"]:
            self.assertTrue(uri_path(suite["uri"]).is_file())
            self.assertTrue(uri_path(suite["uri"]).is_relative_to(self.root), suite["uri"])
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


class FocusedDiscoveryTests(DiscoveryTestCase):
    def focused(self, client, path, configuration=None):
        params = {"workspaceUri": client_uri(self.root), "documentUri": client_uri(path)}
        if configuration is not None:
            params["robotConfiguration"] = configuration
        return client.request(METHOD, params)

    def test_document_result_matches_full_discovery_including_init_defaults_and_configuration(self):
        directory = self.root / "focused" / "nested"
        directory.mkdir(parents=True)
        (directory.parent / "__init__.robot").write_text(
            "*** Settings ***\nName    Focused Policies\nTest Tags    ancestor\n", encoding="utf-8")
        (directory / "__init__.robot").write_text(
            "*** Settings ***\nTest Tags    nested\n", encoding="utf-8")
        (self.root / "robot.toml").write_text('[variables]\nENV = "toml"\n', encoding="utf-8")
        target = directory / "names.robot"
        target.write_text("*** Test Cases ***\nTarget ${ENV}\n    [Tags]    smoke\n    No Operation\n"
                          "Excluded ${ENV}\n    [Tags]    robot:exclude\n    No Operation\n", encoding="utf-8")
        configuration = {"version": 1, "cwd": str(self.root), "robotArguments": ["--variable", "ENV:configured"]}
        client = self.start()
        full = client.request(METHOD, {"workspaceUri": client_uri(self.root), "robotConfiguration": configuration})
        expected = [suite for suite in full["items"] if uri_path(suite["uri"]) == target]
        focused = self.focused(client, target, configuration)
        self.assert_contract(focused)
        self.assertEqual(focused["items"], expected)
        self.assertNotIn("errors", focused, "unrelated syntax errors do not obscure a focused source")
        self.assertEqual(focused["items"][0]["children"][0]["label"], "Target configured")
        self.assertEqual(sorted(focused["items"][0]["children"][0]["tags"]), ["ancestor", "nested", "smoke"])
        self.assertEqual([parent["label"] for parent in focused["items"][0]["parents"]], ["Focused Policies", "Nested"])
        self.assertEqual([marker for marker in MARKERS if list(self.root.rglob(marker))], [])

    def test_new_saved_file_and_edits_are_seen_without_a_full_workspace_discovery(self):
        client = self.start()
        target = self.root / "companion_smoke.robot"
        target.write_text("*** Test Cases ***\nNew Smoke\n    Log    safe\n", encoding="utf-8")
        self.assertEqual(self.tree(self.focused(client, target)), {"companion_smoke.robot": ["New Smoke"]})
        target.write_text("*** Test Cases ***\nRenamed Smoke\n    Log    safe\n", encoding="utf-8")
        self.assertEqual(self.tree(self.focused(client, target)), {"companion_smoke.robot": ["Renamed Smoke"]})
        self.assertIsNone(client.process.poll())

    def test_focused_discovery_does_not_walk_other_directories(self):
        from robot_companion_backend import discovery
        target = self.root / "suites" / "deeper" / "level_two" / "names.robot"
        ancestors = {self.root, target.parent, *target.parent.parents}
        seen = []
        listing = discovery.listing

        def only_ancestors(directory, errors):
            self.assertIn(directory, ancestors, "focused discovery must not visit unrelated workspace branches")
            seen.append(directory)
            return listing(directory, errors)

        with patch.object(discovery, "listing", side_effect=only_ancestors), \
                patch.object(discovery, "suite_files", side_effect=AssertionError("full walk must not run")):
            result = discovery.discover(self.root, document=discovery.document_path(client_uri(target), self.root))
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(seen, [self.root, self.root / "suites", self.root / "suites/deeper", target.parent])

    def test_focused_excluded_tests_and_configured_extension_rules_match_full_discovery(self):
        client = self.start()
        self.assertEqual(self.focused(client, self.root / "suites/excluded/hidden_by_init.robot")["items"], [])
        target = self.root / "audit.robot"
        configuration = {"version": 1, "cwd": str(self.root), "robotArguments": ["--extension", "robot.md"]}
        error = self.error(client, METHOD, {"workspaceUri": self.root.as_uri(), "documentUri": target.as_uri(),
                                           "robotConfiguration": configuration})
        self.assertEqual(error["code"], -32602)
        self.assertIn("configured extensions", error["message"])

    def test_invalid_document_paths_are_rejected_before_reading_them(self):
        client = self.start()
        outside = Path(self.temp.name) / "outside.robot"
        outside.write_text("*** Test Cases ***\nOutside\n    No Operation\n", encoding="utf-8")
        for name in (".hidden.robot", "_hidden.robot", "only.resource"):
            (self.root / name).write_text("*** Test Cases ***\nIgnored\n    No Operation\n", encoding="utf-8")
        cvs = self.root / "CVS"
        cvs.mkdir()
        (cvs / "ignored.robot").write_text("*** Test Cases ***\nIgnored\n    No Operation\n", encoding="utf-8")
        (self.root / "linked.robot").symlink_to(outside)
        uris = [None, 42, "untitled:Untitled-1", "file://otherhost/test.robot", "file:relative.robot",
                self.root.as_uri(), (self.root / "suites").as_uri(), outside.as_uri(),
                (self.root / "missing.robot").as_uri(), (self.root / ".hidden.robot").as_uri(),
                (self.root / "_hidden.robot").as_uri(), (self.root / "only.resource").as_uri(),
                (cvs / "ignored.robot").as_uri(), (self.root / "linked.robot").as_uri(),
                self.root.as_uri() + "/suites/../audit.robot", (self.root / "audit.robot").as_uri() + "?query",
                (self.root / "audit.robot").as_uri() + "#fragment", self.root.as_uri() + "/%00.robot"]
        for uri in uris:
            with self.subTest(uri=uri):
                error = self.error(client, METHOD, {"workspaceUri": client_uri(self.root), "documentUri": uri})
                self.assertEqual(error["code"], -32602, error)
        # A refused request does not poison the process; VS Code's encoded URI works too.
        self.assertEqual(self.tree(self.focused(client, self.root / "audit.robot")), {"audit.robot": ["Debug Smoke"]})


if __name__ == "__main__":
    unittest.main()

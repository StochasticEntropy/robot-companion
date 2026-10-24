"""Real RF keyword-cell completion boundaries, including trimmed single spaces."""

import os
from pathlib import Path
import tempfile
import unittest

from client import Client
from robot_companion_backend import features, project
from robot_companion_backend.workspace import Workspace


LIBRARY = ("from robot.api.deco import keyword\n"
           "raise RuntimeError('Native completion must not execute workspace code')\n"
           "@keyword('Example Build Record')\n"
           "def build_record(name: str, *, mode: str = 'safe'):\n    return name\n"
           "@keyword('Example')\n"
           "def short(first: str, *, mode: str = 'safe'):\n    return first\n"
           "@keyword('Select ${item} Example')\n"
           "def select(item):\n    return item\n")
LOCAL = "*** Keywords ***\nExample Local Step\n    No Operation\n"


def units(text):
    return len(text.encode("utf-16-le")) // 2


class CompletionCellTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rcb completion cells-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.library = self.root / "Library.py"
        self.library.write_text(LIBRARY, encoding="utf-8")
        self.suite = self.root / "example.robot"
        self.workspace = Workspace()
        self.workspace.roots = [self.root]
        self.workspace.config = project.parse({"version": 1, "cwd": str(self.root), "robotArguments": []})
        self.version = 0
        self.client = None

    def finish(self):
        try:
            self.assertIsNone(self.client.process.poll())
            self.client.request("shutdown")
            self.client.send("exit")
            self.assertEqual(self.client.process.wait(timeout=5), 0)
        finally:
            self.client.close()
            self.assertFalse(self.client.forced_cleanup)

    def complete(self, marked, *, wire=False, settings="", suffix=LOCAL):
        source = ("*** Settings ***\nLibrary    Library.py\n" + settings
                  + "*** Test Cases ***\nExample Case\n" + marked + "\n" + suffix)
        before, after = source.split("<cursor>")
        self.text = before + after
        self.position = {"line": before.count("\n"), "character": units(before.rsplit("\n", 1)[-1])}
        self.version += 1
        self.workspace.open(self.suite.as_uri(), self.text, self.version)
        with self.workspace.source_snapshot():
            direct = features.completion(self.workspace, self.suite.as_uri(), self.position)
        self.result = direct
        if wire:
            if self.client is None:
                self.client = Client(cwd=self.root)
                self.addCleanup(self.finish)
                self.client.request("initialize", {"rootUri": self.root.as_uri(), "capabilities": {},
                    "initializationOptions": {"robotConfiguration": {
                        "version": 1, "cwd": str(self.root), "robotArguments": []}}})
                self.client.send("initialized", {})
            self.client.send("textDocument/didOpen", {"textDocument": {"uri": self.suite.as_uri(),
                "languageId": "robotframework", "version": self.version, "text": self.text}})
            actual = self.client.request("textDocument/completion", {
                "textDocument": {"uri": self.suite.as_uri()}, "position": self.position})
            self.assertEqual(actual, direct)
        return {item["label"]: item for item in direct["items"]}

    def applied_line(self, item):
        edit = item["textEdit"]
        start, end = edit["range"]["start"], edit["range"]["end"]
        self.assertEqual(start["line"], end["line"])
        line = self.text.splitlines()[start["line"]].encode("utf-16-le")
        return (line[:2 * start["character"]].decode("utf-16-le") + edit["newText"]
                + line[2 * end["character"]:].decode("utf-16-le"))

    def assert_keyword_edit(self, item, written, replacement):
        line = self.text.splitlines()[self.position["line"]]
        start = line.index(written)
        self.assertEqual(item["textEdit"]["range"], {
            "start": {"line": self.position["line"], "character": units(line[:start])},
            "end": {"line": self.position["line"], "character": units(line[:start + len(written)])}})
        self.assertEqual(self.applied_line(item), line[:start] + replacement + line[start + len(written):])
        self.assertEqual(item["insertTextFormat"], 1)

    def test_single_space_retains_the_entire_direct_keyword_cell_on_the_real_wire(self):
        for written in ("Example ", "Example Build ", "Example Build Re"):
            with self.subTest(written=written):
                items = self.complete("    " + written + "<cursor>", wire=True)
                self.assertIn("Example Build Record", items)
                self.assert_keyword_edit(items["Example Build Record"], written, "Example Build Record")
        items = self.complete("    ${😀result}=    Example <cursor>", wire=True)
        self.assert_keyword_edit(items["Example Build Record"], "Example ", "Example Build Record")
        self.assertGreater(items["Example Build Record"]["textEdit"]["range"]["start"]["character"],
                           self.text.splitlines()[self.position["line"]].index("Example "))

    def test_wire_marks_keyword_and_filtered_argument_results_incomplete_for_fresh_typing(self):
        for marked in ("    Example <cursor>", "    Example Build R<cursor>",
                       "    Example    <cursor>", "    Example    mo<cursor>"):
            with self.subTest(refreshable=marked):
                self.assertTrue(self.complete(marked, wire=True))
                self.assertTrue(self.result["isIncomplete"])
        self.assertEqual(self.complete("    Example    mode=sa<cursor>fe", wire=True), {})
        self.assertFalse(self.result["isIncomplete"])
        self.assertTrue(self.complete("    Log    ${CUR<cursor>}"))
        self.assertFalse(self.result["isIncomplete"])

    def test_actual_indirect_keyword_slots_allow_one_space_and_continuations(self):
        for marked in ("    Run Keyword    Example <cursor>",
                       "    Run Keyword If    True    Example <cursor>",
                       "    Repeat Keyword    2    Example Build <cursor>",
                       "    Run Keyword\n    ...    Example <cursor>"):
            with self.subTest(marked=marked):
                items = self.complete(marked, wire=True)
                self.assertIn("Example Build Record", items)
                written = "Example Build " if "Example Build " in marked else "Example "
                self.assert_keyword_edit(items["Example Build Record"], written, "Example Build Record")

    def test_pipe_keyword_edits_preserve_the_pipe_separator_and_utf16_prefix(self):
        for marked in ("| | Example Build <cursor>|", "| | ${😀result}= | Example <cursor>|"):
            with self.subTest(marked=marked):
                items = self.complete(marked, wire=True)
                item = items["Example Build Record"]
                written = "Example Build " if "Example Build " in marked else "Example "
                self.assert_keyword_edit(item, written, "Example Build Record ")
                self.assertTrue(self.applied_line(item).endswith("Record |"))
        items = self.complete("| | Example Build Re<cursor> |", wire=True)
        self.assert_keyword_edit(items["Example Build Record"], "Example Build Re", "Example Build Record")
        for marked, written, replacement in (
                ("| | Example <cursor> |", "Example ", "Example Build Record"),
                ("| | Example  <cursor>|", "Example  ", "Example Build Record "),
                ("| | Example  <cursor>", "Example  ", "Example Build Record"),
                ("| | Example \t<cursor>|", "Example \t", "Example Build Record "),
                ("| | Example <cursor>\t|", "Example ", "Example Build Record"),
                ("| | Run Keyword | Example <cursor> |", "Example ", "Example Build Record"),
                ("| | Run Keyword | Example   <cursor>|", "Example   ", "Example Build Record "),
                ("| | Example <cursor> | name=existing |", "Example ", "Example Build Record")):
            with self.subTest(pipe_padding=marked):
                items = self.complete(marked, wire=True)
                self.assertIn("Example Build Record", items)
                self.assert_keyword_edit(items["Example Build Record"], written, replacement)
        self.assertEqual(set(self.complete("| | Example | <cursor> |", wire=True)), {"first=", "mode="})
        for marked in ("| | Example | Exa<cursor> |", "| | Run Keyword | Example | <cursor> |"):
            with self.subTest(next_pipe_argument=marked):
                self.assertNotIn("Example Build Record", self.complete(marked, wire=True))

    def test_two_spaces_and_tabs_switch_to_arguments_while_values_and_continuations_stay_values(self):
        for separator in ("  ", "    ", "\t"):
            with self.subTest(separator=repr(separator)):
                items = self.complete("    Example" + separator + "<cursor>", wire=True)
                self.assertEqual(set(items), {"first=", "mode="})
                self.assertNotIn("Example Build Record", items)
        for marked in ("    Example <cursor>   argument", "    Example    mode=<cursor>safe",
                       "    Example    mode <cursor>", "    Example    'Example <cursor>'",
                       "    Example    path/Example <cursor>", "    Example    # Example <cursor>",
                       "    Example\n    ...    Example <cursor>"):
            with self.subTest(argument=marked):
                self.assertNotIn("Example Build Record", self.complete(marked))
        # A direct keyword's argument is not an indirect slot merely because its text is a prefix.
        self.assertNotIn("Example Build Record", self.complete("    Example    Example <cursor>"))

    def test_namespace_embedded_local_and_import_ambiguity_preserve_existing_identity(self):
        items = self.complete("    Audit.Example <cursor>", wire=True,
                              settings="Library    Library.py    AS    Audit\n")
        self.assert_keyword_edit(items["Audit.Example Build Record"], "Audit.Example ",
                                 "Audit.Example Build Record")
        items = self.complete("    Select <cursor>")
        self.assert_keyword_edit(items["Select ${item} Example"], "Select ", "Select ${item} Example")
        self.assertIn("Example Local Step", self.complete("    Example Local <cursor>"))
        (self.root / "Other.py").write_text(LIBRARY, encoding="utf-8")
        items = self.complete("    Example <cursor>", settings="Library    Other.py\n")
        self.assertNotIn("Example Build Record", items)
        self.assertIn("Library.Example Build Record", items)
        self.assertIn("Other.Example Build Record", items)
        for label in ("Library.Example Build Record", "Other.Example Build Record"):
            self.assertIn(label.split(".")[0] + ".py", items[label]["detail"])

    def test_external_exact_text_and_overlay_changes_refresh_keyword_candidates(self):
        marked = "    Example Build <cursor>"
        self.assertIn("Example Build Record", self.complete(marked, wire=True))
        stat = self.library.stat()
        replacement = LIBRARY.replace("Example Build Record", "Example Build Report")
        self.assertEqual(len(replacement), len(LIBRARY))
        self.library.write_text(replacement, encoding="utf-8")
        os.utime(self.library, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        items = self.complete(marked, wire=True)
        self.assertIn("Example Build Report", items)
        self.assertNotIn("Example Build Record", items)
        self.workspace.open(self.library.as_uri(), LIBRARY, 1)
        items = self.complete(marked)
        self.assertIn("Example Build Record", items)
        self.assertNotIn("Example Build Report", items)
        self.workspace.close(self.library.as_uri())
        self.assertIn("Example Build Report", self.complete(marked))
        self.library.unlink()
        self.assertNotIn("Example Build Report", self.complete(marked))
        self.library.write_text(LIBRARY, encoding="utf-8")
        self.assertIn("Example Build Record", self.complete(marked))

    def test_comments_settings_and_owner_headers_remain_outside_keyword_completion(self):
        for marked in ("    # Example <cursor>", "    Example    # Example <cursor>"):
            with self.subTest(comment=marked):
                self.assertEqual(self.complete(marked), {})
        for marked in ("Exa<cursor>mple", "*** Set<cursor>tings ***", "Library    Library<cursor>.py"):
            source = marked.replace("<cursor>", "") + "\n"
            before = marked.split("<cursor>")[0]
            self.version += 1
            self.workspace.open(self.suite.as_uri(), source, self.version)
            with self.workspace.source_snapshot():
                actual = features.completion(self.workspace, self.suite.as_uri(),
                    {"line": 0, "character": units(before)})
            self.assertEqual(actual["items"], [])


if __name__ == "__main__":
    unittest.main()

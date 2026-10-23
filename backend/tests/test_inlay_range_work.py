"""A viewport request must not resolve every call in a large source file."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from robot_companion_backend import inlay_hints
from robot_companion_backend.workspace import Workspace


class InlayRangeWorkTests(unittest.TestCase):
    def test_large_file_resolves_only_requested_statement_with_identical_hints(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.robot"
            calls = [f"    Action {number}    value" for number in range(600)]
            keywords = [f"Action {number}\n    [Arguments]    ${{value}}\n    No Operation" for number in range(600)]
            path.write_text("*** Test Cases ***\nLarge\n" + "\n".join(calls) +
                            "\n*** Keywords ***\n" + "\n".join(keywords) + "\n", encoding="utf-8")
            workspace = Workspace()
            workspace.roots = [path.parent]
            line = 302
            request_range = {"start": {"line": line, "character": 0},
                             "end": {"line": line, "character": 200}}
            with patch.object(workspace, "resolve_call", wraps=workspace.resolve_call) as resolve:
                result = inlay_hints.hints(workspace, path.as_uri(), request_range)
                self.assertEqual(resolve.call_count, 1, "Only the viewport call requires resolution")
            self.assertTrue(result)
            full = [{"position": {"line": row, "character": column}, "label": label,
                     "kind": kind, "tooltip": tooltip}
                    for row, column, label, kind, tooltip in inlay_hints.collect(workspace, path)
                    if row == line]
            self.assertEqual(result, full)

    def test_continuation_argument_in_viewport_keeps_call_above_range(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "continued.robot"
            path.write_text("*** Test Cases ***\nExample\n    Example Keyword\n"
                            "    ...    first\n    ...    second\n*** Keywords ***\n"
                            "Example Keyword\n    [Arguments]    ${first}    ${second}\n"
                            "    No Operation\n", encoding="utf-8")
            workspace = Workspace()
            request_range = {"start": {"line": 4, "character": 0},
                             "end": {"line": 4, "character": 80}}
            result = inlay_hints.hints(workspace, path.as_uri(), request_range)
            self.assertEqual([hint["label"] for hint in result], ["second="])


if __name__ == "__main__":
    unittest.main()

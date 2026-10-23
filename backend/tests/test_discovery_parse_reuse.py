"""A broad discovery pass reuses each suite model without losing RF syntax findings."""

from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from robot.api import get_model

from robot_companion_backend import diagnostics, discovery, markdown, project
from robot_companion_backend.workspace import file_uri_path


class DiscoveryParseReuseTests(unittest.TestCase):
    def test_large_suite_set_is_parsed_once_and_keeps_names_tags_and_errors(self):
        with tempfile.TemporaryDirectory(prefix="rcb-discovery-reuse-") as temporary:
            root = Path(temporary)
            suites = 160
            for index in range(suites):
                (root / f"suite_{index:03}.robot").write_text(
                    "*** Settings ***\nLibrary    SideEffects.py\nTest Tags    batch\n"
                    "*** Test Cases ***\n" + "".join(
                        f"Case {index} {test}\n    Log    A generic value\n" for test in range(4)),
                    encoding="utf-8")
            marker = root / "executed.marker"
            (root / "SideEffects.py").write_text(
                "from pathlib import Path\nPath(__file__).with_name('executed.marker').touch()\n",
                encoding="utf-8")
            broken = root / "broken.robot"
            text = ("*** Settings ***\nNot A Setting    value\n*** Test Cases ***\n"
                    "Unicode 🎉 case\n    Log    value\n")
            broken.write_text(text, encoding="utf-8")
            expected = [discovery.problem(broken, discovery.Positions(text).remap(finding.range),
                                         finding.message)
                        for finding in diagnostics.model_errors(broken, text, diagnostics.source_lines(text),
                                                                resource=False)
                        if finding.severity == diagnostics.ERROR]
            config = project.parse({"version": 1, "cwd": str(root), "robotArguments": []})
            with patch("robot.api.get_model", wraps=get_model) as parser, redirect_stderr(StringIO()):
                found = discovery.discover(root, config)
            self.assertEqual(parser.call_count, suites + 1,
                             "Syntax findings and test building must share one parse per suite")
            self.assertEqual(len(found["items"]), suites + 1)
            self.assertEqual(sum(len(item["children"]) for item in found["items"]), suites * 4 + 1)
            for item in found["items"]:
                if item["uri"] == broken.as_uri():
                    continue
                index = int(Path(file_uri_path(item["uri"])).stem.split("_")[1])
                self.assertEqual([test["label"] for test in item["children"]],
                                 [f"Case {index} {test}" for test in range(4)])
                self.assertTrue(all(test["tags"] == ["batch"] for test in item["children"]))
            # Compare the original RF syntax finding's message and UTF-16 range.
            self.assertEqual([{key: value for key, value in error.items() if key != "severity"}
                              for error in found["errors"]], expected)
            self.assertFalse(marker.exists(), "Discovery must not import a suite library")

    def test_curdir_dependent_errors_keep_raw_utf16_ranges_and_markdown_mapping(self):
        with tempfile.TemporaryDirectory(prefix="rcb-discovery-curdir-range-") as temporary:
            for suffix in ("s", "long_source_directory_" * 4):
                root = Path(temporary) / suffix
                root.mkdir()
                sources = {
                    "settings.robot": "*** Settings ***\r\nNot ${CURDIR} Sätting 🎉    value\r\n"
                                      "*** Test Cases ***\r\nT\r\n    Log    hello\r\n",
                    "test_setting.robot": "*** Test Cases ***\nT\n    [Not ${CURDIR} Sätting 🎉]    value\n"
                                          "    Log    hello\n",
                }
                if markdown.supported():
                    sources["document.robot.md"] = ("# Example\n\n  ```robotframework\n  *** Settings ***\n"
                        "  Not ${CURDIR} Sätting 🎉    value\n  *** Test Cases ***\n"
                        "  T\n      Log    hello\n  ```\n")
                expected = []
                for name, text in sources.items():
                    path = root / name
                    path.write_text(text, encoding="utf-8", newline="")
                    view = markdown.view(text) if markdown.is_markdown(path) else None
                    parsed_text = view.text if view else text
                    for finding in diagnostics.model_errors(path, parsed_text, diagnostics.source_lines(parsed_text),
                                                            resource=False):
                        if finding.severity != diagnostics.ERROR:
                            continue
                        error = discovery.problem(path, discovery.Positions(parsed_text).remap(finding.range),
                                                  finding.message)
                        expected.append(markdown.to_file(error, view) if view else error)
                with patch("robot.api.get_model", wraps=get_model) as parser, redirect_stderr(StringIO()):
                    found = discovery.discover(root)
                self.assertEqual(parser.call_count, 2 * len(sources),
                                 "CURDIR-dependent diagnostics must retain the unexpanded parse")
                self.assertEqual(found["errors"], sorted(expected, key=lambda error: error["uri"]))


if __name__ == "__main__":
    unittest.main()

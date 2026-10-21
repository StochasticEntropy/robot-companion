"""Robot Framework pre-run modifier of Robot Companion's Test Explorer runs.

Robot Companion copies this file into a run's own results folder, next to the run's
`selection.json`, and passes it with `--prerunmodifier`. Robot builds the suites of
the workspace folder first (init files, `Test Tags`, `Default Tags` and `[Tags]`),
then this modifier keeps only the selected tests, identified by their source file and
the line of their name, and removes suites left without tests. Robot applies
`--include`/`--exclude` afterwards, as for any run.

`selection-result.json` records which selected tests Robot found, so a test whose
file changed after discovery is reported instead of silently not run. Nothing is
imported or executed here besides Robot Framework's own model API.
"""

import json
import os
from pathlib import Path

from robot.api import SuiteVisitor


def _key(source, line):
    return os.path.normcase(os.path.realpath(str(source))), int(line)


class RobotCompanionSelection(SuiteVisitor):
    def __init__(self):
        folder = Path(__file__).resolve().parent
        self.result_file = folder / "selection-result.json"
        with open(folder / "selection.json", encoding="utf-8") as stream:
            selection = json.load(stream)
        self.selected = {_key(source, line): [source, line] for source, line in selection["tests"]}
        self.found = set()

    def start_suite(self, suite):
        kept = []
        for test in suite.tests:
            if test.source is None or test.lineno is None:
                continue
            key = _key(test.source, test.lineno)
            if key in self.selected:
                kept.append(test)
                self.found.add(key)
        suite.tests = kept

    def end_suite(self, suite):
        suite.suites = [child for child in suite.suites if child.test_count]
        if suite.parent is None:
            missing = [entry for key, entry in self.selected.items() if key not in self.found]
            with open(self.result_file, "w", encoding="utf-8") as stream:
                json.dump({"found": len(self.found), "missing": missing}, stream)

    def visit_test(self, test):
        pass

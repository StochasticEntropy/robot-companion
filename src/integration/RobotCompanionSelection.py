"""Robot Framework pre-run modifier of Robot Companion's Test Explorer runs.

Robot Companion copies this file into a run's own results folder, next to the run's
`selection.json`, and passes it with `--prerunmodifier`. Robot builds the suites of
the workspace folder first (init files, `Test Tags`, `Default Tags` and `[Tags]`),
then this modifier keeps only the selected tests, identified by their source file,
the line of their name and their name as discovered, and removes suites left without
tests. Robot applies `--include`/`--exclude` afterwards, as for any run.

A test whose name line now holds another test (the file changed after discovery) is
not kept. `selection-result.json` records which selected tests Robot did not find, so
such a test is reported instead of another one running in its place. Nothing is
imported or executed here besides Robot Framework's own model API.
"""

import json
import os
from pathlib import Path
import re

from robot.api import SuiteVisitor
from robot.utils import normalize

VARIABLE = re.compile(r"[$@&%]\{[^{}]*\}")


def _key(source, line):
    return os.path.normcase(os.path.realpath(str(source))), int(line)


def _name(text):
    return normalize(text, ignore="_")


def same_test(written, discovered):
    """The name in Robot's model (as written, before variables are replaced) is the
    discovered name: equal under Robot's name normalization, or, with variables in
    it, its literal parts in order and each variable standing for any text."""
    if _name(written) == _name(discovered):
        return True
    parts = VARIABLE.split(written)
    if len(parts) == 1:
        return False
    pattern = ".*".join(re.escape(_name(part)) for part in parts)
    return re.fullmatch(pattern, _name(discovered), re.DOTALL) is not None


class RobotCompanionSelection(SuiteVisitor):
    def __init__(self):
        folder = Path(__file__).resolve().parent
        self.result_file = folder / "selection-result.json"
        with open(folder / "selection.json", encoding="utf-8") as stream:
            selection = json.load(stream)
        self.selected = {_key(entry[0], entry[1]): entry for entry in selection["tests"]}
        self.found = set()

    def start_suite(self, suite):
        kept = []
        for test in suite.tests:
            if test.source is None or test.lineno is None:
                continue
            key = _key(test.source, test.lineno)
            entry = self.selected.get(key)
            if entry is not None and same_test(test.name, entry[2]):
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

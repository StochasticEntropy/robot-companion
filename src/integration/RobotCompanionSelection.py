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
import textwrap

from robot.api import SuiteVisitor
from robot.utils import FileReader, normalize, unescape
from robot.variables import search_variable


def _key(source, line):
    return os.path.normcase(os.path.realpath(str(source))), int(line)


def _name(text):
    return normalize(text, ignore="_")


def markdown_lines(source):
    """Map RF 7.5's joined Robot-block lines to their Markdown file lines.

    Keep RF's MarkdownParser fence and join rules, as the native backend's
    markdown.rf_lines does. FileReader supplies RF's BOM/newline normalization.
    The copied modifier also runs without the native backend installed.
    """
    blocks, block, close = [], None, None
    with FileReader(source) as reader:
        for number, line in enumerate(reader.readlines(), 1):
            if block is None:
                match = re.match(r"\s*(`{3,}|~{3,})\s*(\S+)", line)
                if match and match[2].lower() in ("robotframework", "robot"):
                    fence = match[1]
                    close = re.compile(rf"\s*{fence[0]}{{{len(fence)},}}\s*")
                    block = []
            elif close.fullmatch(line):
                blocks.append(block)
                block = None
            else:
                block.append((number, line))
    if block:
        blocks.append(block)
    mapping, before = {}, 0
    for number, block in enumerate(blocks):
        for offset, (line, _) in enumerate(block):
            mapping[1 + before + number + offset] = line
        before += textwrap.dedent("".join(text for _, text in block)).count("\n")
    return mapping


def same_test(written, discovered):
    """The name in Robot's model (as written, escapes intact, before variables are
    replaced) is the discovered name (unescaped, known variables replaced), both
    under Robot's name normalization. The written name is brought into the
    discovered form as Robot's replace_string treats literal text: its variables
    are found with Robot's search_variable, the text around them is unescaped,
    and each variable (with its items, such as ${LIST}[0]) stands for any text.
    An escaped variable (\\${x}) is literal text."""
    literals, rest = [], written
    while (match := search_variable(rest, ignore_errors=True)).start >= 0:
        literals.append(rest[:match.start])
        rest = rest[match.end:]
    literals.append(rest)
    parts = [_name(unescape(literal)) for literal in literals]
    if len(parts) == 1:
        return parts[0] == _name(discovered)
    pattern = ".*".join(re.escape(part) for part in parts)
    return re.fullmatch(pattern, _name(discovered), re.DOTALL) is not None


class RobotCompanionSelection(SuiteVisitor):
    def __init__(self):
        folder = Path(__file__).resolve().parent
        self.result_file = folder / "selection-result.json"
        with open(folder / "selection.json", encoding="utf-8") as stream:
            selection = json.load(stream)
        self.selected = {_key(entry[0], entry[1]): entry for entry in selection["tests"]}
        self.found = set()
        self.markdown = {}
        self.runtime_lines = []

    def start_suite(self, suite):
        kept = []
        for test in suite.tests:
            if test.source is None or test.lineno is None:
                continue
            line = test.lineno
            if str(test.source).lower().endswith((".md", ".markdown")):
                source = str(test.source)
                if source not in self.markdown:
                    self.markdown[source] = markdown_lines(source)
                line = self.markdown[source].get(line, line)
            key = _key(test.source, line)
            entry = self.selected.get(key)
            if entry is not None and same_test(test.name, entry[2]):
                kept.append(test)
                self.found.add(key)
                if line != test.lineno:
                    self.runtime_lines.append([entry[0], entry[1], test.lineno])
        suite.tests = kept

    def end_suite(self, suite):
        suite.suites = [child for child in suite.suites if child.test_count]
        if suite.parent is None:
            missing = [entry for key, entry in self.selected.items() if key not in self.found]
            result = {"found": len(self.found), "missing": missing}
            if self.runtime_lines:
                result["runtimeLines"] = self.runtime_lines
            with open(self.result_file, "w", encoding="utf-8") as stream:
                json.dump(result, stream)

    def visit_test(self, test):
        pass

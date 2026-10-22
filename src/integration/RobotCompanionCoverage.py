"""Robot Framework listener of Robot Companion's Test Explorer coverage runs.

Robot Companion copies this file into a run's own folder, next to the run's
`coverage-config.json`, and passes it with `--listener`. Robot creates its
listeners before it imports any test library, so the line tracer installed here
sees the workspace's Python libraries load and run. Only the Python standard
library is used (`sys.settrace`, `threading.settrace`, `compile`): nothing needs
to be installed in the project's Python.

Measured are the `.py` files below the run's workspace folder, except anything
in a `site-packages` or `dist-packages` folder. A line is executable when Python
compiles code for it (the lines of the file's code objects) and executed when
Python reported it to the tracer. Lines run while a test runs are attributed to
that test, identified by its source file and the line of its name; lines run in
suite setups and teardowns belong to the run only.

Not measured, and reported as such in `coverage.json`: files imported before
this listener started, files changed during the run, processes that Robot or a
test started, threads that were already running, and every file when another
tracer (a debugger or coverage tool) was active or replaced this one.
"""

import json
import os
from pathlib import Path
import sys
import threading

VERSION = 1
EXCLUDED_FOLDERS = {"site-packages", "dist-packages"}


def _real(path):
    return os.path.normcase(os.path.realpath(path))


def _code_lines(code):
    """Lines of `code` and of every code object nested in it."""
    lines = {line for _, _, line in code.co_lines() if line}
    for constant in code.co_consts:
        if hasattr(constant, "co_lines"):
            lines |= _code_lines(constant)
    return lines


class RobotCompanionCoverage:
    # Robot calls a listener's public attributes of listener method names, so
    # this listener's own state is private.
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self):
        folder = Path(__file__).resolve().parent
        config = json.loads((folder / "coverage-config.json").read_text(encoding="utf-8"))
        self._result_file = folder / "coverage.json"
        self._own_folder = _real(folder) + os.sep
        self._roots = [_real(root).rstrip(os.sep) + os.sep for root in config["roots"]]
        self._paths = {}  # co_filename -> measured real path, or None
        self._sources = {}  # measured real path -> (co_filename, bytes when first seen)
        self._imported = set()  # measured paths whose module code ran under the tracer
        self._tracers = {}
        self._tests = []
        self._outside = {}  # path -> lines run outside any test
        self._by_test = []  # one {path: lines} per entry of self._tests
        self._current = self._outside
        self._unavailable = None
        if sys.gettrace() is not None:
            self._unavailable = ("another Python tracer (a debugger or coverage tool) was already active when Robot "
                                "started; Robot Companion measures no coverage next to it")
            return
        sys.settrace(self._call)
        threading.settrace(self._call)

    def _measured(self, filename):
        if not filename.endswith(".py") or not os.path.isfile(filename):
            return None
        path = _real(filename)
        if path.startswith(self._own_folder) or EXCLUDED_FOLDERS & set(Path(path).parts):
            return None
        if not any(path.startswith(root) for root in self._roots):
            return None
        if path not in self._sources:
            try:
                self._sources[path] = (filename, Path(filename).read_bytes())
            except OSError:
                return None
        return path

    def _call(self, frame, event, arg):
        code = frame.f_code
        try:
            path = self._paths[code.co_filename]
        except KeyError:
            path = self._paths[code.co_filename] = self._measured(code.co_filename)
        if path is None:
            return None
        if code.co_name == "<module>":
            self._imported.add(path)
        tracer = self._tracers.get(path)
        if tracer is None:
            tracer = self._tracers[path] = self._line_tracer(path)
        return tracer

    def _line_tracer(self, path):
        def trace(frame, event, arg):
            if event == "line":
                lines = self._current.get(path)
                if lines is None:
                    lines = self._current[path] = set()
                lines.add(frame.f_lineno)
            return trace
        return trace

    def start_test(self, data, result):
        self._tests.append({"source": str(data.source), "line": data.lineno, "name": data.name})
        self._current = {}
        self._by_test.append(self._current)

    def end_test(self, data, result):
        self._current = self._outside

    def close(self):
        replaced = self._unavailable is None and sys.gettrace() != self._call
        sys.settrace(None)
        threading.settrace(None)
        if replaced:
            self._unavailable = ("another Python tracer (a debugger or coverage tool) replaced Robot Companion's coverage "
                                "tracer during the run")
        files, unmeasured = [], []
        for path, (filename, source) in sorted(self._sources.items()) if self._unavailable is None else ():
            lines, reason = self._executable(path, filename, source)
            if reason:
                unmeasured.append({"path": filename, "reason": reason})
                continue
            executed = set().union(self._outside.get(path, ()), *(test.get(path, ()) for test in self._by_test)) & lines
            files.append({"path": filename, "lines": sorted(lines), "executed": sorted(executed),
                          "tests": [[index, sorted(test[path] & lines)] for index, test in enumerate(self._by_test)
                                    if test.get(path)]})
        result = {"version": VERSION, "measurement": "lines", "tracer": "sys.settrace",
                  "python": "%d.%d.%d" % sys.version_info[:3], "roots": self._roots, "tests": self._tests,
                  "files": files, "unmeasured": unmeasured, "unavailable": self._unavailable}
        partial = self._result_file.with_suffix(".partial")
        partial.write_text(json.dumps(result), encoding="utf-8")
        os.replace(partial, self._result_file)

    def _executable(self, path, filename, source):
        """The file's executable lines as Python compiled it for this run, or why it
        is not measured."""
        if path not in self._imported:
            return None, "imported before Robot Companion's coverage started"
        try:
            if Path(filename).read_bytes() != source:
                return None, "changed during the run"
        except OSError:
            return None, "removed during the run"
        try:
            return _code_lines(compile(source, filename, "exec", dont_inherit=True)), None
        except (SyntaxError, ValueError) as error:
            return None, "Python cannot compile it: %s" % error

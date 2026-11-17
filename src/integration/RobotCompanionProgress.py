"""Stream run-local Robot events identified by test source and declaration line."""

from functools import lru_cache
import importlib.util
import json
from pathlib import Path


@lru_cache(maxsize=None)
def _markdown_lines(source):
    # Load the run's own selection modifier to share RF's fence-line mapping.
    modifier = Path(__file__).with_name("RobotCompanionSelection.py")
    spec = importlib.util.spec_from_file_location("companion_selection", modifier)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.markdown_lines(source)


def _location(data):
    source = str(data.source)
    line = data.lineno
    if source.lower().endswith((".md", ".markdown")) and line:
        line = _markdown_lines(source).get(line, line)
    return [source, line]


class RobotCompanionProgress:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self):
        path = Path(__file__).with_name("progress.jsonl")
        self._stream = path.open("w", encoding="utf-8", buffering=1)
        self._test = {}
        self._failures = {}

    def _emit(self, event, **details):
        record = dict(self._test, event=event, **details)
        self._stream.write(json.dumps(record) + "\n")

    def start_test(self, data, result):
        source, line = _location(data)
        self._test = {"source": source, "line": line}
        suite = data.parent
        self._pending_teardown = False
        while suite is not None:
            if suite.has_teardown:
                self._pending_teardown = True
                break
            suite = suite.parent
        self._failures.clear()
        self._emit("start")

    def log_message(self, message):
        if message.level in ("INFO", "WARN", "ERROR", "FAIL"):
            text = str(message.message)
            if len(text) > 8192:
                text = text[:8192] + " … [full message in Robot log]"
            self._emit("log", level=message.level, message=text)

    def end_keyword(self, data, result):
        if self._test and result.status == "FAIL" and data.source and data.lineno:
            # Inner failures finish first. A handled failure is irrelevant when
            # a later keyword fails with another message.
            previous = self._failures.get(result.message)
            if previous is None:
                self._failures[result.message] = (result, _location(data))
            else:
                # An outer keyword propagates a nested failure. Two separate
                # branches with the same message have ambiguous provenance.
                ancestor = previous[0]
                while ancestor is not None and ancestor is not result:
                    ancestor = getattr(ancestor, "parent", None)
                if ancestor is None:
                    self._failures[result.message] = (result, None)

    def end_test(self, data, result):
        self._emit("end", status=result.status, message=result.message, pendingTeardown=self._pending_teardown,
                   location=self._failures.get(result.message, (None, None))[1],
                   duration=round(result.elapsed_time.total_seconds() * 1000))
        self._test = {}

    def close(self):
        self._stream.close()

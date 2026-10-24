"""Bounded source and syntax reuse, without caching import resolution.

Each request reads a closed file's current content once while it remains in the
bounded request snapshot. Reuse between requests requires exact text equality,
not filesystem timestamps: external edits still count without a watcher event.
"""

from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from functools import wraps

from .cancellation import checkpoint

MAX_FILES = 512
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_LIBRARY_READINGS = 32
MAX_REQUEST_ANALYSES = 128
MAX_SYNTAX_ANALYSES = 128
MAX_RESOLVED_PATHS = 512


@dataclass
class Source:
    text: str
    size: int
    lines: object = None
    robot_model: object = None
    python_tree: object = None
    module_names: object = None
    declaration_names: object = None
    markdown_view: object = None
    library_readings: OrderedDict = field(default_factory=OrderedDict)
    syntax_analyses: OrderedDict = field(default_factory=OrderedDict)

    def syntax(self, key, compute):
        """A bounded, read-only syntax fact belonging only to this exact text.

        Dependency, configuration and path-resolution proofs belong in
        Sources.analyse instead: those must be reconsidered next request.
        """
        checkpoint()
        if key not in self.syntax_analyses:
            self.syntax_analyses[key] = compute()
            while len(self.syntax_analyses) > MAX_SYNTAX_ANALYSES:
                self.syntax_analyses.popitem(last=False)
        self.syntax_analyses.move_to_end(key)
        return self.syntax_analyses[key]


class Sources:
    """Bounds apply separately to retained syntax and the current request.

    The byte bound measures retained UTF-8 source, not Python object heap size.
    Derived syntax is bounded by the same file/source limits. Oversized sources
    are usable but not retained. A file evicted during a large request is read
    again if revisited, rather than allowing an unbounded request snapshot.
    """

    def __init__(self, max_files=MAX_FILES, max_source_bytes=MAX_SOURCE_BYTES):
        self.max_files, self.max_source_bytes = max_files, max_source_bytes
        self.entries, self.current = OrderedDict(), OrderedDict()
        self.request_analyses = OrderedDict()
        self.resolved_paths = OrderedDict()
        self.pinned = set()
        self.bytes = self.current_bytes = self.depth = 0

    @contextmanager
    def snapshot(self):
        self.depth += 1
        try:
            yield
        finally:
            self.depth -= 1
            if not self.depth:
                self.current.clear()
                self.request_analyses.clear()
                self.resolved_paths.clear()
                self.pinned.clear()
                self.current_bytes = 0

    def _put(self, entries, path, source, size):
        previous = entries.pop(path, None)
        if previous is not None:
            size -= previous.size
        if source.size > self.max_source_bytes or self.max_files <= 0:
            return size
        entries[path] = source
        size += source.size
        while len(entries) > self.max_files or size > self.max_source_bytes:
            _, removed = entries.popitem(last=False)
            size -= removed.size
        return size

    def analyse(self, key, compute):
        checkpoint()
        if not self.depth:
            return compute()
        if key not in self.request_analyses:
            self.request_analyses[key] = compute()
            while len(self.request_analyses) > MAX_REQUEST_ANALYSES:
                self.request_analyses.popitem(last=False)
        self.request_analyses.move_to_end(key)
        return self.request_analyses[key]

    def resolve_path(self, path):
        """Canonicalize once per request, never retain filesystem identity."""
        checkpoint()
        if not self.depth:
            return path.resolve()
        key = path if path.is_absolute() else path.absolute()
        if key in self.resolved_paths:
            self.resolved_paths.move_to_end(key)
            return self.resolved_paths[key]
        resolved = path.resolve()
        self.resolved_paths[key] = resolved
        self.resolved_paths[resolved] = resolved
        while len(self.resolved_paths) > MAX_RESOLVED_PATHS:
            self.resolved_paths.popitem(last=False)
        return resolved

    def _retain(self, path, source):
        """Do not let a one-pass large graph evict all its own reusable syntax.

        Entries used in this request stay resident. New sources may replace
        unvisited old entries, but bypass retention when every resident entry
        is already in use. The next request starts with no pins, so a different
        active graph can still replace the old working set.
        """
        previous = self.entries.pop(path, None)
        if previous is not None:
            self.bytes -= previous.size
        if source.size > self.max_source_bytes or self.max_files <= 0:
            self.pinned.discard(path)
            return
        while len(self.entries) >= self.max_files or self.bytes + source.size > self.max_source_bytes:
            victim = next((key for key in self.entries if key not in self.pinned), None)
            if victim is None:
                self.pinned.discard(path)
                return
            self.bytes -= self.entries.pop(victim).size
        self.entries[path] = source
        self.bytes += source.size
        if self.depth:
            self.pinned.add(path)

    def forget_current(self, path):
        self.request_analyses.clear()
        self.resolved_paths.clear()
        self.pinned.discard(path)
        previous = self.current.pop(path, None)
        if previous is not None:
            self.current_bytes -= previous.size

    def read(self, path, reader):
        checkpoint()
        if self.depth and path in self.current:
            self.current.move_to_end(path)
            return self.current[path]
        try:
            text = reader()
        except (OSError, UnicodeError):
            removed = self.entries.pop(path, None)
            if removed is not None:
                self.bytes -= removed.size
            self.pinned.discard(path)
            raise
        source = self.entries.get(path)
        if source is None or source.text != text:
            source = Source(text, len(text.encode("utf-8")))
        self._retain(path, source)
        if self.depth:
            self.current_bytes = self._put(self.current, path, source, self.current_bytes)
        return source


def snapshot(method):
    """A direct Workspace operation gets the same snapshot as an LSP request."""
    @wraps(method)
    def wrapped(workspace, *args, **kwargs):
        with workspace.source_snapshot():
            return method(workspace, *args, **kwargs)
    return wrapped

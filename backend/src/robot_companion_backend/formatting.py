"""Whole-document formatting with Robocop 9.1.0's formatter, run in-process on the open text.

Robocop is an optional dependency (`robot-companion-backend[format]`); formatting is
advertised only when exactly that version is importable. Its default formatters and
whitespace settings are used; configuration files in the workspace are not read, so the
result depends only on the document text.
"""

from contextlib import redirect_stdout
import difflib
import importlib
import importlib.metadata
from io import StringIO
import re
import sys

from .features import text_range
from .navigation import RequestFailed
from .workspace import ROBOT_SUFFIXES, uri_path

ROBOCOP_VERSION = "9.1.0"
MAXIMUM_PASSES = 5  # Robocop's own runner reruns formatters until the text is stable
LONE_CR = re.compile(r"\r(?!\n)")


def available():
    """The Robocop version used for formatting, or None when it is not installed or its
    formatter modules cannot be imported."""
    try:
        version = importlib.metadata.version("robotframework-robocop")
    except importlib.metadata.PackageNotFoundError:
        return None
    if version != ROBOCOP_VERSION:
        return None
    try:
        with redirect_stdout(sys.stderr):  # stdout is the protocol
            for module in ("robocop.config.manager", "robocop.config.schema", "robocop.formatter.disablers",
                           "robocop.runtime.resolver", "robocop.source_file"):
                importlib.import_module(module)
    except Exception as exc:
        print(f"Robocop {version} cannot be imported; formatting is disabled: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return None
    return version


def robocop_format(text, path):
    from robot.api import get_init_model, get_model, get_resource_model
    with redirect_stdout(sys.stderr):  # stdout is the protocol
        from robocop.config.manager import ConfigManager
        from robocop.config.schema import RawConfig, RawFormatterConfig, RawWhitespaceConfig
        from robocop.formatter import disablers
        from robocop.runtime.resolver import ConfigResolver
        from robocop.source_file import StatementLinesCollector

    if LONE_CR.search(text):
        # Line edits are computed on `\n`/`\r\n` lines; LSP also counts a lone `\r` as a line break.
        raise RequestFailed("Cannot format a document with a carriage return that is not followed by a line feed.")
    loader = get_resource_model if path.suffix == ".resource" else \
        get_init_model if path.stem == "__init__" else get_model
    # Robocop's formatters write `\n`; a `\r\n` document gets its line endings back afterwards.
    windows = "\r\n" in text
    whitespace = RawWhitespaceConfig(line_ending="unix")
    raw = RawConfig(formatter=RawFormatterConfig(whitespace_config=whitespace, overwrite=False, return_result=True),
                    silent=True)
    with redirect_stdout(sys.stderr):  # stdout is the protocol
        manager = ConfigManager(ignore_file_config=True, overwrite_config=raw)
        config = manager.default_config
        formatters = ConfigResolver(load_formatters=True).resolve_config(config).formatters
        current = text.replace("\r\n", "\n")
        for _ in range(MAXIMUM_PASSES):
            model = loader(StringIO(current))
            finder = disablers.RegisterDisablers(config.formatter.start_line, config.formatter.end_line)
            finder.visit(model)
            if finder.is_disabled_in_file(disablers.ALL_FORMATTERS):
                return text  # `# robocop: fmt: off` for the whole file
            for name, formatter in formatters.items():
                formatter.disablers = finder.disablers
                if not finder.disablers.is_disabled_in_file(name):
                    formatter.visit(model)
            formatted = StatementLinesCollector(model).text
            if formatted == current:
                return current.replace("\n", "\r\n") if windows else current
            current = formatted
    raise RequestFailed(f"Robocop {ROBOCOP_VERSION} did not reach a stable format; the document was not changed.")


def lines_with_breaks(text):
    return re.findall(r"[^\n]*\n|[^\n]+$", text)


def text_edits(old, new):
    """Line-based TextEdits turning `old` into `new`, in document order, never overlapping."""
    before, after = lines_with_breaks(old), lines_with_breaks(new)
    edits = []

    def position(index):
        if index < len(before) or not before or before[-1].endswith("\n"):
            return {"line": index, "character": 0}
        last = before[-1]  # the end of a last line without a line break
        return text_range(last, len(before) - 1, len(last), len(last))["end"]
    matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
    for tag, first, last, start, end in matcher.get_opcodes():
        if tag != "equal":
            edits.append({"range": {"start": position(first), "end": position(last)},
                          "newText": "".join(after[start:end])})
    return edits


def format_document(workspace, uri):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        return None
    text = workspace.text(path)
    return text_edits(text, robocop_format(text, path))

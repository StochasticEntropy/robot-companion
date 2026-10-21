"""Document, range and on-type formatting with Robocop 9.1.0's formatter, run in-process on the open text.

Robocop is an optional dependency (`robot-companion-backend[format]`); formatting is
advertised only when exactly that version is importable. Its default formatters and
whitespace settings are used; configuration files in the workspace are not read, so the
result depends only on the document text.

Range and on-type formatting use Robocop's own line limits (`--start-line`/`--end-line`),
without the formatters that order settings and sections or set empty lines between blocks,
and are declined, with nothing edited, when the result would change a line outside the
requested lines or a comment or documentation inside them. On-type formatting changes the
spacing within the completed line only.
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
ON_TYPE_TRIGGER = "\n"  # the line just completed by Enter
# Default formatters that order settings and sections and set the empty lines between tests and
# sections: they work on whole tests and sections, outside any line limits, and are not used
# for range and on-type formatting.
WHOLE_BLOCK_FORMATTERS = frozenset(("MergeAndOrderSections", "OrderSettings", "OrderSettingsSection", "NormalizeNewLines"))


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


def robocop_format(text, path, lines=None):
    """The formatted text; with `lines` (first, last; 1-based, inclusive) statements within those
    lines are formatted, as with Robocop's `--start-line`/`--end-line`, without the
    WHOLE_BLOCK_FORMATTERS."""
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
        start, end = lines or (config.formatter.start_line, config.formatter.end_line)
        for _ in range(MAXIMUM_PASSES):
            model = loader(StringIO(current))
            finder = disablers.RegisterDisablers(start, end)
            finder.visit(model)
            if finder.is_disabled_in_file(disablers.ALL_FORMATTERS):
                return text  # `# robocop: fmt: off` for the whole file
            for name, formatter in formatters.items():
                formatter.disablers = finder.disablers
                if not finder.disablers.is_disabled_in_file(name) and not (lines and name in WHOLE_BLOCK_FORMATTERS):
                    formatter.visit(model)
            formatted = StatementLinesCollector(model).text
            if lines and formatted != current:  # the limited lines, where they are now
                found = locate(lines_with_breaks(current), start - 1, end - 1, lines_with_breaks(formatted))
                if found is None:
                    return formatted.replace("\n", "\r\n") if windows else formatted  # refused by the caller
                start, end = found[0] + 1, found[1]
            if formatted == current:
                return formatted.replace("\n", "\r\n") if windows else formatted
            current = formatted
    raise RequestFailed(f"Robocop {ROBOCOP_VERSION} did not reach a stable format; the document was not changed.")


def lines_with_breaks(text):
    return re.findall(r"[^\n]*\n|[^\n]+$", text)


def text_edits(old, new, offset=0):
    """Line-based TextEdits turning `old` into `new`, in document order, never overlapping;
    `old` starts at document line `offset`."""
    before, after = lines_with_breaks(old), lines_with_breaks(new)
    edits = []

    def position(index):
        if index < len(before) or not before or before[-1].endswith("\n"):
            return {"line": offset + index, "character": 0}
        last = before[-1]  # the end of a last line without a line break
        return text_range(last, offset + len(before) - 1, len(last), len(last))["end"]
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


def kept_text(text, path, first, last):
    """Each comment and documentation value on lines `first`..`last` (0-based) exactly as
    written, from its first cell to the end of its line: what range formatting must not change."""
    from robot.api import get_init_tokens, get_resource_tokens, get_tokens
    tokenize = get_resource_tokens if path.suffix == ".resource" else \
        get_init_tokens if path.stem == "__init__" else get_tokens
    source = text.replace("\r\n", "\n")
    lines, starts, documentation = source.split("\n"), {}, False
    for token in tokenize(StringIO(source)):
        if token.type == "DOCUMENTATION":
            documentation = True
        elif token.type == "EOS":
            documentation = False
        elif first <= token.lineno - 1 <= last and (token.type == "COMMENT" or documentation and token.type == "ARGUMENT"):
            starts.setdefault(token.lineno - 1, token.col_offset)
    return [lines[line][column:].rstrip() for line, column in sorted(starts.items())]


def selected_lines(text, request_range):
    """The 0-based first and last line of an LSP range; a range ending at the start of a
    line does not include that line (a selection of whole lines)."""
    count = len(lines_with_breaks(text))
    start, end = request_range["start"], request_range["end"]
    first, last = start["line"], end["line"]
    if last > first and end["character"] == 0:
        last -= 1
    if not 0 <= first <= last or first >= count:
        return None
    return first, min(last, count - 1)


def locate(before, first, last, after):
    """Where lines `first`..`last` of `before` (0-based; non-blank first and last lines) are in
    `after`, as (start, end) with the end exclusive; None when a non-blank line outside them
    changed. Robocop adds and removes blank lines outside its line limits (around a test or
    section it formats partly); those are not compared."""
    def content(lines):  # a line break Robocop adds after the last line is not a change either
        return [line.rstrip("\r\n") for line in lines if line.strip()]
    above, below = len(content(before[:first])), len(content(before[last + 1:]))
    rows = [index for index, line in enumerate(after) if line.strip()]
    if len(rows) < above + below + 1:
        return None
    start, end = rows[above], rows[len(rows) - below - 1] + 1
    if content(after[:start]) != content(before[:first]) or content(after[end:]) != content(before[last + 1:]):
        return None
    return start, end


def format_lines(workspace, uri, first, last, what, whitespace_only=False):
    """TextEdits formatting lines `first`..`last` (0-based) only, or RequestFailed naming why not.
    Blank lines at the edges of the lines and blank lines Robocop would change outside them
    are left as they are."""
    path = uri_path(uri)
    text = workspace.text(path)
    before = lines_with_breaks(text)
    rows = [index for index in range(first, last + 1) if before[index].strip()]
    if not rows:
        return []
    first, last = rows[0], rows[-1]
    formatted = robocop_format(text, path, (first + 1, last + 1))
    after = lines_with_breaks(formatted)
    found = locate(before, first, last, after)
    if found is None:
        raise RequestFailed(f"{what} declined: Robocop {ROBOCOP_VERSION} would change lines outside lines "
                            f"{first + 1}-{last + 1}; the document was not changed.")
    start, end = found
    old, new = "".join(before[first:last + 1]), "".join(after[start:end])
    if old == new:
        return []
    if kept_text(text, path, first, last) != kept_text(formatted, path, start, end - 1):
        raise RequestFailed(f"{what} declined: Robocop {ROBOCOP_VERSION} would change a comment or documentation "
                            f"in lines {first + 1}-{last + 1}; the document was not changed.")
    if whitespace_only and (old.split() != new.split() or old.count("\n") != new.count("\n")):
        raise RequestFailed(f"{what} declined: Robocop {ROBOCOP_VERSION} would change more than the spacing "
                            f"within line {first + 1}; the document was not changed.")
    return text_edits(old, new, first)


def format_range(workspace, uri, request_range):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        return None
    lines = selected_lines(workspace.text(path), request_range)
    if lines is None:
        raise RequestFailed("Format Selection declined: the range is outside the document; nothing was changed.")
    return format_lines(workspace, uri, *lines, "Format Selection")


def format_on_type(workspace, uri, position, character):
    """After Enter, the whitespace of the line just completed; nothing for other input."""
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES or character != ON_TYPE_TRIGGER:
        return None
    line, lines = position["line"] - 1, lines_with_breaks(workspace.text(path))
    if not 0 <= line < len(lines) or not lines[line].strip():
        return None
    return format_lines(workspace, uri, line, line, "On-type formatting", whitespace_only=True)

"""Markdown Robot sources, as Robot Framework 7.5 reads them (RF 7.3.2 reads none).

RF 7.5's `MarkdownParser` reads only fenced code blocks whose language is `robot` or
`robotframework` (any case), dedents each block and joins the blocks. A `.robot.md` file is a
suite by default (`--extension` lists `robot.md`); `.md` and `.markdown` files are resources
and, with `--extension md`, suites. The services here read the same blocks, with the same
fence rules and the same dedent, but keep the file's lines: every line outside a block is
empty in the Robot view, so a line in the view is the same line in the Markdown file. A
block RF dedents (an indented fence) keeps its lines; its columns move by the removed
indentation, which `View.offsets` records so positions are translated both ways.

RF's own line numbers (the debugger's stack frames) count the joined blocks only;
`rf_lines` maps them back to the Markdown file's lines.
"""

from dataclasses import dataclass
import re
import textwrap

from .runtime import robot_version

SUFFIXES = (".md", ".markdown")
SUITE_SUFFIX = ".robot.md"
PARSER_SUFFIXES = (".robot.md", ".md", ".markdown")  # RF 7.5 MarkdownParser.extensions
PARSER_EXTENSIONS = tuple(suffix[1:] for suffix in PARSER_SUFFIXES)  # as RF's ValidExtensions names them
LANGUAGES = ("robotframework", "robot")
FENCE_OPEN = re.compile(r"\s*(`{3,}|~{3,})\s*(\S+)")  # RF 7.5 MarkdownParser._read_markdown_data


def supported():
    """Whether this Robot Framework reads Markdown sources at all (RF 7.5; not RF 7.3.2)."""
    return robot_version() != "7.3.2"


def is_markdown(path):
    return path.name.lower().endswith(SUFFIXES)


def is_suite_name(path):
    return path.name.lower().endswith(SUITE_SUFFIX)


@dataclass(frozen=True)
class View:
    """The Robot text of a Markdown file with the file's lines; `offsets[line]` is the number of
    characters RF's dedent removed at the start of that line, None for a line outside a block."""
    text: str
    offsets: tuple
    blocks: tuple  # (first line, last line) of each block's content, 0-based, inclusive

    def offset(self, line):
        return self.offsets[line] if 0 <= line < len(self.offsets) else None

    def in_block(self, line):
        return self.offset(line) is not None


def _lines(text):
    """The file's lines as RF's FileReader yields them: split at `\\n` only, which each keeps,
    with `\\r\\n` read as `\\n` and a byte order mark dropped. Also, per line, the characters
    this drops from the editor's line: (leading BOM length, trailing `\\r`)."""
    parts = text.split("\n")
    lines, dropped = [], []
    for number, part in enumerate(parts):
        bom = 1 if number == 0 and part.startswith("\ufeff") else 0
        last = number == len(parts) - 1
        cr = not last and part.endswith("\r")
        content = part[bom:len(part) - cr]
        lines.append(content if last else content + "\n")
        dropped.append((bom, "\r" if cr else ""))
    return lines, dropped


def _blocks(lines):
    """Line indices of each Robot block's content, exactly as RF 7.5 finds them."""
    blocks, block, close = [], None, None
    for index, line in enumerate(lines):
        if block is None:
            match = FENCE_OPEN.match(line)
            if match and match[2].lower() in LANGUAGES:
                fence = match[1]
                close = re.compile(rf"\s*{re.escape(fence[0])}{{{len(fence)},}}\s*")
                block = []
        elif close.fullmatch(line):
            blocks.append(block)
            block = None
        else:
            block.append(index)
    if block:
        blocks.append(block)
    return blocks


def _dedented(lines, block):
    """RF's `textwrap.dedent` of one block, line by line (dedent keeps the number of lines)."""
    return textwrap.dedent("".join(lines[i] for i in block)).split("\n")


def view(text):
    """The line-preserving Robot view of a Markdown file's text."""
    lines, dropped = _lines(text)
    contents, offsets, spans = [""] * len(lines), [None] * len(lines), []
    for block in _blocks(lines):
        for index, dedented in zip(block, _dedented(lines, block)):
            original = lines[index].removesuffix("\n")
            bom, cr = dropped[index]
            contents[index] = dedented + cr if dedented else ""
            # dedent removes a common prefix, or turns a whitespace-only line into an empty one
            offsets[index] = bom + len(original) - len(dedented) if dedented else 0
        if block:  # a fence closed right after it opened is an empty block
            spans.append((block[0], block[-1]))
    return View("\n".join(contents), tuple(offsets), tuple(spans))


def rf_lines(text):
    """{RF line number: Markdown line number} (both 1-based) of the text RF 7.5 parses: the
    dedented blocks joined with `\\n`, so each later block starts one line after the previous one."""
    lines, _ = _lines(text)
    mapping, before = {}, 0
    for number, block in enumerate(_blocks(lines)):
        dedented = textwrap.dedent("".join(lines[i] for i in block))
        first = 1 + before + number  # newlines of the earlier blocks, plus one separator each
        for offset, index in enumerate(block):
            mapping[first + offset] = index + 1
        before += dedented.count("\n")
    return mapping


def to_file(value, view):
    """`value` (positions, or objects and lists holding them) with each position in a Robot
    block moved to the Markdown file's column (after the indentation RF's dedent removed)."""
    if isinstance(value, list):
        return [to_file(item, view) for item in value]
    if not isinstance(value, dict):
        return value
    if value.keys() == {"line", "character"}:
        offset = view.offset(value["line"])
        return {"line": value["line"], "character": value["character"] + offset} if offset else value
    return {key: to_file(item, view) for key, item in value.items()}

"""Normalized discovery API v1 over stdio JSON-RPC with LSP framing.

Suites come from Robot Framework's own parser and suite builder (`get_model`,
`TestSuite.from_model` with the defaults of `__init__.robot` files); nothing is
executed: no test, keyword, library, variable file, language module or inline Python.
Names and tags use the folder's Robot configuration (`--variable`, statically read
`--variablefile`) as Run Test does, so a discovered name is the name Robot reports.
The workspace is read again for every request, so files added, edited or deleted on
disk are seen without a restart.
"""

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from . import diagnostics
from . import project
from . import runtime
from .project import substitute
from .runtime import robot_version
from .lsp import LanguageServer, RequestError
from .protocol import FramedStream
from .workspace import WINDOWS, Workspace, file_uri_path, is_link, utf16_column, variable_base

API_VERSION = 1
METHOD = "robotCompanion/discoverTests"
INVALID_PARAMS = -32602
MAX_RESULT_BYTES = 64 * 1024 * 1024  # a reply listing a large workspace may exceed the 8 MiB request bound
# RF's directory rules (SuiteStructureBuilder): these prefixes and directory names are not suites.
IGNORED_PREFIXES = ("_", ".")
IGNORED_DIRECTORIES = ("CVS",)
LSP_LINE_BREAKS = ("\n", "\r\n", "\r")


def refuse_language_modules():
    """A `language:` line that names no built-in language makes RF's lexer import it as a
    Python module (a path or module name). Discovery never imports it: RF then marks the
    line `Invalid language configuration`, which is reported like other parsing errors."""
    from robot.conf.languages import Languages
    from robot.errors import DataError

    def refuse(self, name_or_path):
        raise DataError("Language modules are not imported during discovery")
    Languages._import_language_module = refuse


def workspace_root(uri):
    """The workspace folder of a local absolute `file:` URI, as the client wrote it.

    Relative paths and `.`/`..` segments (which could leave the filesystem root or the
    folder the client named) are refused rather than normalized."""
    if not isinstance(uri, str):
        raise RequestError(INVALID_PARAMS, "workspaceUri must be a string")
    parsed = urlsplit(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or parsed.query or parsed.fragment:
        raise RequestError(INVALID_PARAMS, f"Only local file: workspace URIs are supported: {uri}")
    try:
        path = file_uri_path(uri)
    except ValueError:  # Windows: no drive letter (a UNC, device or driveless path)
        path = ""
    segments = re.split(r"[\\/]", path) if WINDOWS else path.split("/")
    # Win32 drops trailing dots and spaces of a path segment, so `...` or `. .` would act as `..`.
    if not path or not Path(path).is_absolute() or "\0" in path \
            or any(part in (".", "..") or (WINDOWS and part and not part.rstrip(". ")) for part in segments):
        raise RequestError(INVALID_PARAMS, f"Workspace URI is not an absolute path inside the filesystem root: {uri}")
    root = Path(path)
    if not root.is_dir():
        raise RequestError(INVALID_PARAMS, f"Workspace folder does not exist or is not a directory: {uri}")
    return root


class Positions:
    """RF numbers lines with `str.splitlines`, which also breaks at form feeds, U+2028 and
    similar characters; LSP clients break lines only at `\\n`, `\\r\\n` and `\\r`. Maps RF
    lines and code-point columns to LSP positions in UTF-16 code units."""

    def __init__(self, text):
        self.lines, self.starts = [], []  # RF line text; its (LSP line, UTF-16 offset) start
        line = offset = 0
        for piece in text.splitlines(keepends=True):
            content = piece.splitlines()[0] if piece.splitlines() else ""
            self.lines.append(content)
            self.starts.append((line, offset))
            terminator = piece[len(content):]
            if terminator in LSP_LINE_BREAKS:
                line, offset = line + 1, 0
            else:  # no terminator (last line) or one LSP does not break at
                offset += utf16_column(piece, len(piece))
        self.final = {"line": line, "character": offset}

    def position(self, line, column):
        """RF's 0-based line and code-point column."""
        if line >= len(self.lines):
            return dict(self.final)
        start_line, start = self.starts[line]
        return {"line": start_line, "character": start + utf16_column(self.lines[line], column)}

    def remap(self, range_):
        """A range in UTF-16 units of RF's lines (as diagnostics computes it)."""
        def moved(position):
            if position["line"] >= len(self.lines):
                return dict(self.final)
            start_line, start = self.starts[position["line"]]
            return {"line": start_line, "character": start + position["character"]}
        return {"start": moved(range_["start"]), "end": moved(range_["end"])}

    def end(self):
        """After the last character that is not a final line break."""
        if not self.lines:
            return {"line": 0, "character": 0}
        return self.position(len(self.lines) - 1, len(self.lines[-1]))


def problem(path, range_, message):
    return {"uri": path.as_uri(), "range": range_ or point(0, 0), "message": message}


def point(line, character):
    position = {"line": line, "character": character}
    return {"start": position, "end": dict(position)}


def read(path, errors):
    """The text as RF reads it (UTF-8, BOM removed, CRLF as LF), or None after an error."""
    from robot.utils import FileReader
    try:
        with FileReader(path) as reader:
            return reader.read()
    except (OSError, UnicodeError) as exc:
        errors.append(problem(path, None, f"Reading failed: {type(exc).__name__}: {exc}"))
        return None


def parsing_errors(path, text, errors):
    """RF's own parsing and model errors (deprecation warnings are not errors)."""
    positions = Positions(text)
    with redirect_stdout(sys.stderr):  # stdout is the protocol
        for finding in diagnostics.model_errors(path, text, diagnostics.source_lines(text)):
            if finding.severity == diagnostics.ERROR:
                errors.append(problem(path, positions.remap(finding.range), finding.message))


def listing(directory, errors):
    try:
        return sorted(directory.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        errors.append(problem(directory, None, f"Reading directory failed: {exc.strerror or exc}"))
        return []


def directory_defaults(directory, entries, parent, errors):
    """Test defaults (tags, setup, template, ...) RF takes from the directory's init file.

    A directory without one shares its parent's defaults, so the chain RF resolves
    recursively only grows with init files, not with directory depth."""
    from robot.errors import DataError
    from robot.running import TestDefaults
    from robot.running.builder.parsers import RobotParser
    inits = [e for e in entries if e.name.lower() == "__init__.robot" and not is_link(e) and e.is_file()]
    for extra in inits[1:]:
        errors.append(problem(extra, None, "Ignoring second test suite init file."))  # as RF does
    if not inits and parent is not None:
        return parent
    defaults = TestDefaults(parent)
    if inits and (text := read(inits[0], errors)) is not None:
        parsing_errors(inits[0], text, errors)
        try:
            with redirect_stdout(sys.stderr):
                RobotParser().parse_init_file(inits[0], defaults)
        except DataError as exc:
            errors.append(problem(inits[0], None, f"Parsing failed: {exc}"))
    return defaults


def suite_files(root, errors):
    """`.robot` suite files with their init defaults, in RF's order (case-insensitively
    sorted, depth first).

    As in RF, names starting with `_` or `.` and `CVS` directories are ignored, so
    `__init__.robot` is no suite and dot-directories are never entered. Symbolic links
    (and Windows junctions) are not followed, so every path stays inside the workspace folder. The walk keeps
    its own stack, so directory depth is not bounded by Python's recursion limit."""
    suites = []
    entries = listing(root, errors)
    stack = [(iter(entries), directory_defaults(root, entries, None, errors))]
    while stack:
        pending, defaults = stack[-1]
        entry = next(pending, None)
        if entry is None:
            stack.pop()
        elif is_link(entry) or entry.name.startswith(IGNORED_PREFIXES):
            continue
        elif entry.is_dir():
            if entry.name not in IGNORED_DIRECTORIES:
                children = listing(entry, errors)
                stack.append((iter(children), directory_defaults(entry, children, defaults, errors)))
        elif entry.is_file() and entry.suffix.lower() == ".robot":
            suites.append((entry, defaults))
    return suites


def section_variables(model):
    """Suite variables with a value fixed before the suite runs: single-value scalars of the
    file's own Variables section without type or separator, resolved against each other.
    As in RF, the first definition of a name wins. Anything else (lists, dictionaries,
    inline Python, imports, variable files, command line, suite setup) is only known when
    Robot runs and stays as written."""
    from robot.utils import normalize
    from robot.variables import search_variable
    written, seen = {}, set()
    for section in model.sections:
        for statement in section.body if type(section).__name__ == "VariableSection" else ():
            if type(statement).__name__ != "Variable" or statement.errors:
                continue
            match = search_variable(statement.name, ignore_errors=True)
            key = normalize(match.base or "", ignore="_")
            if key in seen:
                continue
            seen.add(key)
            simple = match.identifier == "$" and match.is_variable() and not match.items and ":" not in match.base
            if simple and len(statement.value) == 1 and statement.separator is None:
                written[key] = statement.value[0]
    known, pending = {}, set()

    def value(key):
        if key not in known and key not in pending:
            pending.add(key)  # a cycle stays unknown
            resolved = substitute(written[key], lookup)
            pending.discard(key)
            if resolved is not None:
                known[key] = resolved
        return known.get(key)

    def lookup(key):
        return value(key) if key in written else None
    for key in written:
        value(key)
    return known


def end_of_block(node, positions):
    """Position after the block's last data or comment token (trailing empty lines excluded)."""
    last = None
    for statement, _ in Workspace.walk(node):
        for token in getattr(statement, "tokens", ()):
            if token.type not in ("EOL", "EOS", "SEPARATOR") and token.value:
                if last is None or (token.lineno, token.end_col_offset) > (last.lineno, last.end_col_offset):
                    last = token
    return positions.position(last.lineno - 1, last.end_col_offset)


def configured_values(root, config):
    """(normalized name -> value) of the configured command-line variables and statically read
    command-line variable files, in RF's precedence, and whether they are complete."""
    workspace = Workspace()
    workspace.roots, workspace.config = [root], config
    symbols, complete, problems = workspace.configured_variables()
    values = {}
    for symbol in symbols:
        key = variable_base(symbol.name[2:-1])
        if key not in values:
            values[key] = symbol.value[0] if symbol.kind == "cli" else \
                project.scalar(symbol.value[0]) if symbol.value else None
    return values, complete, problems


def file_suite(path, text, defaults, errors, configured=({}, True)):
    """One file suite: RF's suite and test names, with UTF-16 ranges from RF's model.

    Tests RF would drop when running (the reserved tag `robot:exclude`, also through the
    init files' `Test Tags`) are left out."""
    from robot.api import get_model
    from robot.errors import DataError
    from robot.model import Tags
    from robot.running import TestSuite
    curdir = str(path.parent).replace("\\", "\\\\")
    try:
        with redirect_stdout(sys.stderr):  # RF logs model errors; stdout is the protocol
            model = get_model(StringIO(text), data_only=False, curdir=curdir)
            model.source = path
            suite = TestSuite.from_model(model, defaults=defaults)
    except DataError as exc:
        errors.append(problem(path, None, f"Parsing failed: {exc}"))
        return None
    positions = Positions(text)
    nodes = {node.lineno: node for node, _ in Workspace.walk(model) if type(node).__name__ == "TestCase"}
    section, (values, complete) = section_variables(model), configured
    # Command-line variables override the Variables section; an unread variable file may define any name.

    def lookup(key):
        if key in values:
            return values[key]
        return section.get(key) if complete else None
    uri = path.as_uri()
    children = []
    for test in suite.tests:
        if Tags(substitute(tag, lookup, partial=True) for tag in test.tags).robot("exclude"):
            continue
        node = nodes[test.lineno]
        token = node.header.get_token("TESTCASE NAME")
        children.append({"kind": "test", "label": substitute(test.name, lookup, partial=True), "uri": uri,
                         "range": {"start": positions.position(token.lineno - 1, token.col_offset),
                                   "end": end_of_block(node, positions)}})
    if not children:
        return None
    return {"kind": "suite", "label": substitute(suite.name, lookup, partial=True), "uri": uri,
            "range": {"start": {"line": 0, "character": 0}, "end": positions.end()}, "children": children}


def discover(root, config=project.EMPTY):
    refuse_language_modules()
    errors, items = [], []
    values, complete, problems = configured_values(root, config)
    errors += [problem(root, None, f"Robot configuration: {message}") for message in problems]
    for path, defaults in suite_files(root, errors):
        text = read(path, errors)
        if text is None:
            continue
        parsing_errors(path, text, errors)
        if (suite := file_suite(path, text, defaults, errors, (values, complete))) is not None:
            items.append(suite)
    for error in errors:
        print(f"Discovery error: {error['uri']}:{error['range']['start']['line'] + 1}: {error['message']}",
              file=sys.stderr)
    result = {"version": API_VERSION, "items": items}
    if errors:
        result["errors"] = errors  # additive: present only when a file could not be read or parsed cleanly
    return result


class DiscoveryServer(LanguageServer):
    """LSP lifecycle (initialize/shutdown/exit) with the one discovery request.

    The client receives only replies; problems with notifications are logged on stderr."""

    def notify(self, method, params):
        print(f"Discovery notification failed: {params.get('message', method)}", file=sys.stderr)

    def dispatch(self, method, params):
        if method == "initialize":
            if self.initialized:
                raise RequestError(-32600, "Already initialized")
            if reason := runtime.unsupported_reason():
                raise RequestError(-32002, reason)
            self.initialized = True
            return {"capabilities": {"robotCompanionDiscovery": {"version": API_VERSION}}}
        if not self.initialized:
            raise RequestError(-32002, "Server not initialized")
        if self.shutdown:
            raise RequestError(-32600, "Server shut down")
        if method == "shutdown":
            self.shutdown = True
            return None
        if method in ("initialized", "$/cancelRequest", "$/setTrace"):
            return None
        if method == METHOD:
            if "workspaceUri" not in params:
                raise RequestError(INVALID_PARAMS, "workspaceUri is required")
            root = workspace_root(params["workspaceUri"])
            try:
                config = project.parse(params.get("robotConfiguration"))
            except ValueError as exc:
                raise RequestError(INVALID_PARAMS, str(exc)) from None
            return discover(root, config)
        raise RequestError(-32601, f"Method not implemented: {method}")


def serve(reader, writer):
    stream = FramedStream(reader, writer)
    stream.max_outgoing = MAX_RESULT_BYTES
    return DiscoveryServer(stream).run()

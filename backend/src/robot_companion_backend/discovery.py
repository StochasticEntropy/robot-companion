"""Normalized discovery API v1 over stdio JSON-RPC with LSP framing.

Suites come from Robot Framework's own parser and suite builder (`get_model`,
`TestSuite.from_model`); nothing is executed: no test, keyword, library, variable
file or inline Python. The workspace is read again for every request, so files
added, edited or deleted on disk are seen without a restart.
"""

from contextlib import redirect_stdout
from io import StringIO
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

from . import diagnostics
from .lsp import LanguageServer, RequestError
from .protocol import FramedStream
from .workspace import Workspace, utf16_column

API_VERSION = 1
METHOD = "robotCompanion/discoverTests"
INVALID_PARAMS = -32602
# RF's directory rules (SuiteStructureBuilder): these prefixes and directory names are not suites.
IGNORED_PREFIXES = ("_", ".")
IGNORED_DIRECTORIES = ("CVS",)
# Built-in variables whose value is fixed before a test starts, by RF's normalized name.
STATIC_BUILTINS = {"space": " ", "empty": "", "true": "True", "false": "False", "none": "None",
                   "null": "None", "/": os.sep, ":": os.pathsep, "\\n": os.linesep}
INTEGER = re.compile(r"-?\d+")


def workspace_root(uri):
    """The workspace folder of a local absolute `file:` URI, as the client wrote it.

    Relative paths and `.`/`..` segments (which could leave the filesystem root or the
    folder the client named) are refused rather than normalized."""
    if not isinstance(uri, str):
        raise RequestError(INVALID_PARAMS, "workspaceUri must be a string")
    parsed = urlsplit(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost") or parsed.query or parsed.fragment:
        raise RequestError(INVALID_PARAMS, f"Only local file: workspace URIs are supported: {uri}")
    path = unquote(parsed.path)
    segments = path.split("/")
    if not path.startswith("/") or "\0" in path or any(part in (".", "..") for part in segments):
        raise RequestError(INVALID_PARAMS, f"Workspace URI is not an absolute path inside the filesystem root: {uri}")
    root = Path(path)
    if not root.is_dir():
        raise RequestError(INVALID_PARAMS, f"Workspace folder does not exist or is not a directory: {uri}")
    return root


def suite_files(root, errors):
    """`.robot` suite files in RF's order (sorted case-insensitively, depth first), plus init files.

    As in RF, names starting with `_` or `.` and `CVS` directories are ignored, so
    `__init__.robot` is no suite and dot-directories are never entered. Symbolic links
    are not followed, so every path stays inside the workspace folder."""
    suites, inits = [], []

    def visit(directory):
        try:
            entries = sorted(directory.iterdir(), key=lambda p: p.name.lower())
        except OSError as exc:
            errors.append(problem(directory, None, f"Reading directory failed: {exc.strerror or exc}"))
            return
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.name.lower() == "__init__.robot" and entry.is_file():
                inits.append(entry)
            elif entry.name.startswith(IGNORED_PREFIXES):
                continue
            elif entry.is_dir():
                if entry.name not in IGNORED_DIRECTORIES:
                    visit(entry)
            elif entry.is_file() and entry.suffix.lower() == ".robot":
                suites.append(entry)
    visit(root)
    return suites, inits


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
    lines = diagnostics.source_lines(text)
    for finding in diagnostics.model_errors(path, text, lines):
        if finding.severity == diagnostics.ERROR:
            errors.append(problem(path, finding.range, finding.message))


def section_variables(model):
    """Suite variables with a value fixed before the suite runs: single-value scalars of the
    file's own Variables section without type or separator, resolved against each other.
    Anything else (lists, dictionaries, inline Python, imports, variable files, command line,
    suite setup) is only known when Robot runs and stays as written."""
    from robot.utils import normalize
    from robot.variables import search_variable
    written = {}
    for section in model.sections:
        for statement in section.body if type(section).__name__ == "VariableSection" else ():
            if type(statement).__name__ != "Variable" or statement.errors:
                continue
            match = search_variable(statement.name, ignore_errors=True)
            simple = match.identifier == "$" and match.is_variable() and not match.items and ":" not in match.base
            key = normalize(match.base, ignore="_")
            if simple and len(statement.value) == 1 and statement.separator is None and key not in written:
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


def substitute(text, lookup, partial=False):
    """RF's own `replace_string(ignore_errors=True)` restricted to statically known scalars.

    Lookup order is RF's: suite variable, built-in, integer. A variable that is not a plain
    known scalar (extended syntax, item access, nesting, inline Python, environment, list or
    dictionary) is never evaluated. With `partial` it stays as written, as when RF cannot
    resolve it; otherwise the whole text is unknown (None)."""
    from robot.utils import normalize
    from robot.variables import Variables, search_variable
    store, parts, rest = Variables(), [], text
    while (match := search_variable(rest, ignore_errors=True)).start >= 0:
        parts.append(rest[:match.start])
        base = match.base or ""
        known = None
        if match.identifier == "$" and not match.items and not base.startswith("{") and "${" not in base:
            key = normalize(base, ignore="_")
            known = lookup(key)
            if known is None:
                known = STATIC_BUILTINS.get(key)
            if known is None and INTEGER.fullmatch(base.strip()):
                known = str(int(base.strip()))
        if known is not None:
            store["${" + base + "}"] = known
            parts.append(match.match)
        elif partial:
            parts.append("\\" + match.match)  # escaped, so RF's replacer leaves it as written
        else:
            return None
        rest = rest[match.end:]
    parts.append(rest)
    return store.replace_string("".join(parts), ignore_errors=True)


def end_of_block(node, lines):
    """Position after the block's last data or comment token (trailing empty lines excluded)."""
    last = None
    for statement, _ in Workspace.walk(node):
        for token in getattr(statement, "tokens", ()):
            if token.type not in ("EOL", "EOS", "SEPARATOR") and token.value:
                if last is None or (token.lineno, token.end_col_offset) > (last.lineno, last.end_col_offset):
                    last = token
    line = last.lineno - 1
    return {"line": line, "character": utf16_column(diagnostics.line_text(lines, line), last.end_col_offset)}


def file_suite(path, text, errors):
    """One file suite: RF's suite and test names, with UTF-16 ranges from RF's model."""
    from robot.api import get_model
    from robot.errors import DataError
    from robot.running import TestSuite
    curdir = str(path.parent).replace("\\", "\\\\")
    try:
        with redirect_stdout(sys.stderr):  # RF logs model errors; stdout is the protocol
            model = get_model(StringIO(text), data_only=False, curdir=curdir)
            model.source = path
            suite = TestSuite.from_model(model)
    except DataError as exc:
        errors.append(problem(path, None, f"Parsing failed: {exc}"))
        return None
    if not suite.tests:
        return None
    lines = diagnostics.source_lines(text)
    nodes = {node.lineno: node for node, _ in Workspace.walk(model)
             if type(node).__name__ == "TestCase"}
    variables = section_variables(model)

    lookup = variables.get
    uri = path.as_uri()
    children = []
    for test in suite.tests:
        node = nodes[test.lineno]
        token = node.header.get_token("TESTCASE NAME")
        line = token.lineno - 1
        start = {"line": line, "character": utf16_column(diagnostics.line_text(lines, line), token.col_offset)}
        children.append({"kind": "test", "label": substitute(test.name, lookup, partial=True), "uri": uri,
                         "range": {"start": start, "end": end_of_block(node, lines)}})
    last = len(lines) - 1
    return {"kind": "suite", "label": substitute(suite.name, lookup, partial=True), "uri": uri,
            "range": {"start": {"line": 0, "character": 0},
                      "end": {"line": last, "character": utf16_column(lines[last], len(lines[last]))}},
            "children": children}


def discover(root):
    errors, items = [], []
    suites, inits = suite_files(root, errors)
    for init in inits:  # their errors also affect the suites below them
        if (text := read(init, errors)) is not None:
            parsing_errors(init, text, errors)
    for path in suites:
        text = read(path, errors)
        if text is None:
            continue
        parsing_errors(path, text, errors)
        if (suite := file_suite(path, text, errors)) is not None:
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
            import importlib.util
            if importlib.util.find_spec("robot") is None:
                raise RequestError(-32002, "Robot Framework 7.5 is required; use the approved backend runtime")
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
            return discover(workspace_root(params["workspaceUri"]))
        raise RequestError(-32601, f"Method not implemented: {method}")


def serve(reader, writer):
    return DiscoveryServer(FramedStream(reader, writer)).run()

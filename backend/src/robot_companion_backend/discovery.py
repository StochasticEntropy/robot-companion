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
import json
import re
import secrets
import sys
import time
from urllib.parse import urlsplit

from . import diagnostics
from . import markdown
from . import project
from . import runtime
from . import robot_toml
from .project import substitute
from .runtime import robot_version
from .lsp import LanguageServer, RequestError
from .protocol import FramedStream
from .workspace import WINDOWS, Workspace, file_uri_path, is_link, utf16_column, variable_base

API_VERSION = 1
METHOD = "robotCompanion/discoverTests"
METHOD_CANCEL = "robotCompanion/cancelDiscovery"
INVALID_PARAMS = -32602
MAX_RESULT_BYTES = 64 * 1024 * 1024  # a reply listing a large workspace may exceed the 8 MiB request bound
BATCH_VERSION = 1
BATCH_SECONDS = 0.2
BATCH_FILES = 8
BATCH_IDLE_SECONDS = 120
# RF's directory rules (SuiteStructureBuilder): these prefixes and directory names are not suites.
IGNORED_PREFIXES = ("_", ".")
IGNORED_DIRECTORIES = ("CVS",)
LSP_LINE_BREAKS = ("\n", "\r\n", "\r")
# ECMAScript String.trim, matching the editor label validator (not Python str.strip).
LABEL_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


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


def problem(path, range_, message, severity=None):
    result = {"uri": path.as_uri(), "range": range_ or point(0, 0), "message": message}
    if severity is not None:
        result["severity"] = {robot_toml.ERROR: "error", robot_toml.WARNING: "warning",
                              robot_toml.INFORMATION: "information"}[severity]
    return result


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


def parsing_errors(path, text, errors, model=None):
    """RF's own parsing and model errors (deprecation warnings are not errors)."""
    positions = Positions(text)
    with redirect_stdout(sys.stderr):  # stdout is the protocol
        for finding in diagnostics.model_errors(path, text, diagnostics.source_lines(text), resource=False, model=model):
            if finding.severity == diagnostics.ERROR:
                errors.append(problem(path, positions.remap(finding.range), finding.message))


def listing(directory, errors):
    try:
        return sorted(directory.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        errors.append(problem(directory, None, f"Reading directory failed: {exc.strerror or exc}"))
        return []


def directory_defaults(directory, entries, parent, errors):
    """Test defaults (tags, setup, template, ...) RF takes from the directory's init file,
    and the directory suite's name: its init file's `Name` setting, else RF's name for
    the directory.

    A directory without one shares its parent's defaults, so the chain RF resolves
    recursively only grows with init files, not with directory depth."""
    from robot.errors import DataError
    from robot.running import TestDefaults, TestSuite
    from robot.running.builder.parsers import RobotParser
    inits = [e for e in entries if e.name.lower() == "__init__.robot" and not is_link(e) and e.is_file()]
    for extra in inits[1:]:
        errors.append(problem(extra, None, "Ignoring second test suite init file."))  # as RF does
    name = TestSuite.name_from_source(directory)
    if not inits and parent is not None:
        return parent, name
    defaults = TestDefaults(parent)
    if inits and (text := read(inits[0], errors)) is not None:
        parsing_errors(inits[0], text, errors)
        try:
            with redirect_stdout(sys.stderr):
                name = RobotParser().parse_init_file(inits[0], defaults).name or name
        except DataError as exc:
            errors.append(problem(inits[0], None, f"Parsing failed: {exc}"))
    return defaults, substitute(name, lambda key: None, partial=True)


def suite_steps(root, errors, extensions=None):
    """Suite files with their init defaults and directory parents, in RF's order (case-insensitively sorted, depth
    first): the files RF's `--extension` (`extensions`, else RF's default) selects that are
    Robot text (`robot`) or, with RF 7.5, Markdown (`robot.md`, `md`, `markdown`). RF 7.3.2
    reads no Markdown: a `.robot.md` file (with the default extensions), or a file of a
    Markdown extension it is given, is reported as not discovered instead of left out silently.

    As in RF, names starting with `_` or `.` and `CVS` directories are ignored, so
    `__init__.robot` is no suite and dot-directories are never entered. Symbolic links
    (and Windows junctions) are not followed, so every path stays inside the workspace folder. The walk keeps
    its own stack, so directory depth is not bounded by Python's recursion limit."""
    from robot.parsing.suitestructure import ValidExtensions
    valid = ValidExtensions(extensions or project.default_extensions())
    entries = listing(root, errors)
    stack = [(iter(entries), directory_defaults(root, entries, None, errors)[0], ())]
    yield 1, None  # Root listing/defaults are one non-preemptible filesystem/parser step.
    while stack:
        pending, defaults, parents = stack[-1]
        entry = next(pending, None)
        if entry is None:
            stack.pop()
            yield 1, None
            continue
        source = None
        if is_link(entry) or entry.name.startswith(IGNORED_PREFIXES):
            pass
        elif entry.is_dir():
            if entry.name not in IGNORED_DIRECTORIES:
                children = listing(entry, errors)
                child_defaults, name = directory_defaults(entry, children, defaults, errors)
                stack.append((iter(children), child_defaults, (*parents, {"label": name, "uri": entry.as_uri()})))
        elif entry.is_file():
            kind = valid.get_extension(entry) if valid.match(entry) else None
            if kind == "robot" or (kind in markdown.PARSER_EXTENSIONS and markdown.supported()):
                source = (entry, defaults, parents)
            # RF 7.5's default would read a `.robot.md` file; an explicit --extension decides alone.
            elif not markdown.supported() and (kind in markdown.PARSER_EXTENSIONS or
                                               (not extensions and kind is None and markdown.is_suite_name(entry))):
                errors.append(problem(entry, None, f"Not discovered: Robot Framework {robot_version()} does not "
                                      "read Markdown suites. Robot code in Markdown needs Robot Framework 7.5."))
        yield 1, source


def suite_files(root, errors, extensions=None):
    """The complete ordered walk, retained for legacy discovery requests."""
    return [source for _, source in suite_steps(root, errors, extensions) if source is not None]


def document_path(uri, root):
    """A saved local source below the workspace, before following any links or reading it."""
    if not isinstance(uri, str):
        raise RequestError(INVALID_PARAMS, "documentUri must be a string")
    parsed = urlsplit(uri)
    if parsed.query or parsed.fragment:
        raise RequestError(INVALID_PARAMS, "documentUri must name a saved local file without a query or fragment")
    try:
        written = file_uri_path(uri)
    except ValueError as exc:
        raise RequestError(INVALID_PARAMS, f"Invalid documentUri: {exc}") from None
    segments = re.split(r"[\\/]", written) if WINDOWS else written.split("/")
    if not written or not Path(written).is_absolute() or "\0" in written \
            or any(part in (".", "..") or (WINDOWS and part and not part.rstrip(". ")) for part in segments):
        raise RequestError(INVALID_PARAMS, "documentUri must be an absolute file URI without dot path segments")
    path = Path(written)
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise RequestError(INVALID_PARAMS, "documentUri is outside its workspace folder") from None
    if not relative.parts:
        raise RequestError(INVALID_PARAMS, "documentUri must name a suite file, not the workspace folder")
    current = root
    for index, part in enumerate(relative.parts):
        if part.startswith(IGNORED_PREFIXES) or (index < len(relative.parts) - 1 and part in IGNORED_DIRECTORIES):
            raise RequestError(INVALID_PARAMS, f"Not discovered: Robot ignores the selected path component '{part}'")
        current /= part
        if is_link(current):
            raise RequestError(INVALID_PARAMS, "Not discovered: the selected suite path contains a symbolic link or junction")
    if not path.is_file():
        raise RequestError(INVALID_PARAMS, "documentUri must name an existing saved suite file")
    return path


def document_suite(root, path, errors, extensions=None):
    """One suite with the same ancestor defaults as a full walk, without visiting other branches."""
    from robot.parsing.suitestructure import ValidExtensions
    valid = ValidExtensions(extensions or project.default_extensions())
    kind = valid.get_extension(path) if valid.match(path) else None
    if not markdown.supported() and (kind in markdown.PARSER_EXTENSIONS or
                                    (not extensions and kind is None and markdown.is_suite_name(path))):
        raise RequestError(INVALID_PARAMS, f"Not discovered: Robot Framework {robot_version()} does not read Markdown suites")
    if kind != "robot" and not (kind in markdown.PARSER_EXTENSIONS and markdown.supported()):
        raise RequestError(INVALID_PARAMS, "Not discovered: the selected file is not a Robot suite allowed by the configured extensions")
    defaults, parents = None, []
    directory = root
    # Only ancestors are listed, to retain RF's case-insensitive __init__.robot
    # recognition and duplicate-init diagnostics. No unrelated directory is entered.
    for part in (None, *path.parent.relative_to(root).parts):
        if part is not None:
            directory /= part
        defaults, name = directory_defaults(directory, listing(directory, errors), defaults, errors)
        if part is not None:
            parents.append({"label": name, "uri": directory.as_uri()})
    return [(path, defaults, tuple(parents))]


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
    # Workspace starts its problem list with config.errors, then appends variable
    # file failures. Preserve source-defined TOML severity before the text-only
    # compatibility view loses it; later variable-file failures remain errors.
    typed = list(config.problems) if config.problems else [project.ConfigurationProblem(text) for text in config.errors]
    typed += [project.ConfigurationProblem(text) for text in problems[len(config.errors):]]
    return values, complete, typed


def file_suite(path, text, defaults, parents, errors, configured=({}, True)):
    """One file suite: RF's suite and test names, with UTF-16 ranges from RF's model.

    `rpa` is true for a file of tasks (Robot runs tasks and tests only in separate runs).
    Each test carries its tags as RF builds them: the init files' and the file's
    `Test Tags`, `Default Tags`, its own `[Tags]` and `-tag` removals, with statically
    known variables replaced. Tests RF would drop when running (the reserved tag
    `robot:exclude`, also through the init files' `Test Tags`) are left out."""
    from robot.api import get_model
    from robot.errors import DataError
    from robot.model import Tags
    from robot.running import TestSuite
    curdir = str(path.parent).replace("\\", "\\\\")
    try:
        with redirect_stdout(sys.stderr):  # RF logs model errors; stdout is the protocol
            model = get_model(StringIO(text), data_only=False, curdir=curdir)
            model.source = path
            # RF expands CURDIR in token values, which can change validation and
            # source spans. Those files retain the original raw diagnostics parse.
            parsing_errors(path, text, errors, model=None if "${CURDIR}" in text else model)
            suite = TestSuite.from_model(model, defaults=defaults)
            if markdown.is_markdown(path):  # RF's MarkdownParser names it without `.robot.md`
                suite.name = TestSuite.name_from_source(path, markdown.PARSER_SUFFIXES)
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
        tags = Tags(substitute(tag, lookup, partial=True) for tag in test.tags)
        if tags.robot("exclude"):
            continue
        node = nodes[test.lineno]
        token = node.header.get_token("TESTCASE NAME")
        name = substitute(test.name, lookup, partial=True)
        if not name.strip(LABEL_WHITESPACE) or "\0" in name:
            reason = "is empty or whitespace-only" if not name.strip(LABEL_WHITESPACE) else "contains a NUL character"
            errors.append(problem(path, point(**positions.position(token.lineno - 1, token.col_offset)),
                                  f"Not discovered: test name {reason}."))
            continue
        children.append({"kind": "test", "label": name, "uri": uri,
                         "range": {"start": positions.position(token.lineno - 1, token.col_offset),
                                   "end": end_of_block(node, positions)},
                         "tags": list(tags)})
    if not children:
        return None
    return {"kind": "suite", "label": substitute(suite.name, lookup, partial=True), "uri": uri,
            "range": {"start": {"line": 0, "character": 0}, "end": positions.end()}, "children": children,
            "parents": list(parents), "rpa": suite.rpa is True}


def read_suite(path, defaults, parents, errors, configured):
    """Read, parse and map one suite identically for full, focused and batch requests."""
    text = read(path, errors)
    if text is None:
        return None
    view = markdown.view(text) if markdown.is_markdown(path) else None
    found = len(errors)
    if view:
        text = view.text  # the Markdown file's lines, with only its Robot blocks
    suite = file_suite(path, text, defaults, parents, errors, configured)
    if view:  # back to the columns of an indented block
        errors[found:] = [markdown.to_file(error, view) for error in errors[found:]]
        suite = suite and markdown.to_file(suite, view)
    return suite


def log_errors(errors):
    for error in errors:
        print(f"Discovery {error.get('severity', 'error')}: {error['uri']}:{error['range']['start']['line'] + 1}: "
              f"{error['message']}",
              file=sys.stderr)


def discover(root, config=project.EMPTY, document=None):
    refuse_language_modules()
    errors, items = [], []
    values, complete, problems = configured_values(root, config)
    errors += [problem(root, None, f"Robot configuration: {finding.message}", finding.severity) for finding in problems]
    sources = document_suite(root, document, errors, config.extensions) if document is not None \
        else suite_files(root, errors, config.extensions)
    for source in sources:
        suite = read_suite(*source, errors, (values, complete))
        if suite is not None:
            items.append(suite)
    log_errors(errors)
    result = {"version": API_VERSION, "items": items}
    if errors:
        result["errors"] = errors  # additive: present only when a file could not be read or parsed cleanly
    return result


def encoded_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def batch_binding(params):
    """The raw workspace/configuration request identity, including absent versus explicit null."""
    return json.dumps([params.get("workspaceUri"), params.get("scanId"),
                       "robotConfiguration" in params, params.get("robotConfiguration")],
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class DiscoveryBatch:
    """One bounded in-memory scan; pages retain no parsed Robot models or emitted suites."""

    def __init__(self, root, config, binding, workspace_uri, scan_id):
        refuse_language_modules()
        self.binding, self.token = binding, None
        self.workspace_uri, self.scan_id = workspace_uri, scan_id
        self.expires = time.monotonic() + BATCH_IDLE_SECONDS
        self.configured = configured_values(root, config)
        values, complete, problems = self.configured
        self.configured = values, complete
        self.walk_errors = [problem(root, None, f"Robot configuration: {finding.message}", finding.severity)
                            for finding in problems]
        self.walk = suite_steps(root, self.walk_errors, config.extensions)
        self.parse_errors = []
        self.checked_errors = self.returned_errors = self.error_count = 0
        self.scanned = self.files = self.suites = self.tests = 0
        self.bytes = encoded_bytes({"version": API_VERSION, "items": []})
        self.done = False

    def close(self):
        self.walk.close()
        self.parse_errors.clear()
        self.walk_errors.clear()

    def account(self, value, error=False):
        if error:
            self.bytes += encoded_bytes(value) + (1 if self.error_count else len(',"errors":[]'))
            self.error_count += 1
        else:
            self.bytes += encoded_bytes(value) + (1 if self.suites else 0)
        if self.bytes > MAX_RESULT_BYTES:
            raise RequestError(-32001, "Discovery result exceeds the 64 MiB aggregate limit; no complete tree was returned")

    def check_walk_errors(self):
        for error in self.walk_errors[self.checked_errors:]:
            self.account(error, error=True)
        self.checked_errors = len(self.walk_errors)

    def page(self):
        deadline, files = time.monotonic() + BATCH_SECONDS, 0
        items, steps = [], 0
        self.check_walk_errors()
        while files < BATCH_FILES and (steps == 0 or time.monotonic() < deadline):
            try:
                scanned, source = next(self.walk)
            except StopIteration:
                self.done = True
                break
            steps += 1
            self.scanned += scanned
            self.check_walk_errors()
            if source is None:
                continue
            files += 1
            self.files += 1
            errors = []
            suite = read_suite(*source, errors, self.configured)
            for error in errors:
                self.account(error, error=True)
            self.parse_errors.extend(errors)
            if suite is not None:
                self.account(suite)
                self.suites += 1
                self.tests += len(suite["children"])
                items.append(suite)
        # Legacy full discovery reports all walk/init errors before file parse
        # errors. Hold only those parse errors until the final page to retain it.
        self.check_walk_errors()
        errors = self.walk_errors[self.returned_errors:]
        self.returned_errors = len(self.walk_errors)
        if self.done:
            errors += self.parse_errors
        log_errors(errors)
        result = {"version": API_VERSION, "items": items}
        if errors:
            result["errors"] = errors
        self.token = None if self.done else secrets.token_urlsafe(24)
        self.expires = time.monotonic() + BATCH_IDLE_SECONDS
        result["batch"] = {"continuation": self.token, "scanned": self.scanned, "files": self.files,
                           "suites": self.suites, "tests": self.tests}
        if encoded_bytes(result) > MAX_RESULT_BYTES:
            raise RequestError(-32001, "Discovery page exceeds the 64 MiB reply limit; no complete tree was returned")
        return result


class DiscoveryServer(LanguageServer):
    """LSP lifecycle (initialize/shutdown/exit) with the one discovery request.

    The client receives only replies; problems with notifications are logged on stderr."""

    def notify(self, method, params):
        print(f"Discovery notification failed: {params.get('message', method)}", file=sys.stderr)

    def close_batch(self):
        job = getattr(self, "discovery_batch", None)
        self.discovery_batch = None
        if job is not None:
            job.close()

    def dispatch(self, method, params):
        try:
            return self.dispatch_discovery(method, params)
        except BaseException:
            # A cancelled/interrupted parser must never be resumed by a token.
            self.close_batch()
            raise

    def batch(self, params, root):
        if "documentUri" in params:
            raise RequestError(INVALID_PARAMS, "Batch discovery is for a complete workspace, not documentUri")
        scan_id = params.get("scanId")
        if not isinstance(scan_id, str) or not scan_id or len(scan_id) > 128 or "\0" in scan_id:
            raise RequestError(INVALID_PARAMS, "Batch discovery needs a nonempty scanId string of at most 128 characters")
        binding = batch_binding(params)
        if "continuation" in params:
            token = params["continuation"]
            job = getattr(self, "discovery_batch", None)
            if not isinstance(token, str) or not token or job is None or job.token != token \
                    or job.binding != binding or time.monotonic() >= job.expires:
                raise RequestError(INVALID_PARAMS, "Discovery continuation is stale, expired, already used or belongs to another workspace/configuration; start a new scan")
            job.token = None  # A token is consumed even when its next page fails.
        else:
            self.close_batch()
            try:
                config = project.parse(params.get("robotConfiguration"))
            except ValueError as exc:
                raise RequestError(INVALID_PARAMS, str(exc)) from None
            job = self.discovery_batch = DiscoveryBatch(root, config, binding, params["workspaceUri"], scan_id)
        result = job.page()
        if job.done:
            self.close_batch()
        return result

    def dispatch_discovery(self, method, params):
        if method == "initialize":
            if self.initialized:
                raise RequestError(-32600, "Already initialized")
            if reason := runtime.unsupported_reason():
                raise RequestError(-32002, reason)
            self.initialized = True
            return {"capabilities": {"robotCompanionDiscovery": {
                "version": API_VERSION, "document": True, "batch": BATCH_VERSION}}}
        if not self.initialized:
            raise RequestError(-32002, "Server not initialized")
        if self.shutdown:
            raise RequestError(-32600, "Server shut down")
        if method == "shutdown":
            self.close_batch()
            self.shutdown = True
            return None
        if method in ("initialized", "$/cancelRequest", "$/setTrace"):
            return None
        if method == METHOD_CANCEL:
            job = getattr(self, "discovery_batch", None)
            if job is not None and params.get("workspaceUri") == job.workspace_uri and params.get("scanId") == job.scan_id:
                self.close_batch()
            return None
        if method == METHOD:
            if type(params.get("batch")) is int and params["batch"] == BATCH_VERSION:
                if "continuation" not in params:
                    self.close_batch()
                if "workspaceUri" not in params:
                    raise RequestError(INVALID_PARAMS, "workspaceUri is required")
                return self.batch(params, workspace_root(params["workspaceUri"]))
            self.close_batch()
            if "batch" in params or "continuation" in params:
                raise RequestError(INVALID_PARAMS, f"Batch discovery requires batch: {BATCH_VERSION}")
            if "workspaceUri" not in params:
                raise RequestError(INVALID_PARAMS, "workspaceUri is required")
            root = workspace_root(params["workspaceUri"])
            try:
                config = project.parse(params.get("robotConfiguration"))
            except ValueError as exc:
                raise RequestError(INVALID_PARAMS, str(exc)) from None
            document = document_path(params["documentUri"], root) if "documentUri" in params else None
            return discover(root, config, document)
        raise RequestError(-32601, f"Method not implemented: {method}")


def serve(reader, writer):
    stream = FramedStream(reader, writer)
    stream.max_outgoing = MAX_RESULT_BYTES
    server = DiscoveryServer(stream)
    try:
        return server.run()
    finally:
        # EOF, exit and malformed framing bypass dispatch, as can a failed write.
        server.close_batch()

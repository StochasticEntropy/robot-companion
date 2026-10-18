"""Source-only import graph: Robot's model for Robot, Python AST for libraries.

No workspace library execution, workspace-wide name map, or dependency on the
extension. Graphs are rebuilt for each request from current overlays and disk
dependencies. Only RF's own standard libraries are read through RF's libdoc.
"""

import ast
from contextlib import contextmanager, redirect_stdout
from dataclasses import dataclass, field, replace
from io import StringIO
from pathlib import Path
import os
import re
import sys
from urllib.parse import unquote, urlsplit

ERROR, INFORMATION = 1, 3  # LSP DiagnosticSeverity
VARIABLE = re.compile(r"[$@&]\{([^}]+)\}")
# RF 7.5 built-in variables (User Guide "Built-in variables"). Only parse-time or
# constant values are known statically; the others are set when Robot runs.
STATIC_BUILTINS = {"${SPACE}": "a single space", "${EMPTY}": "an empty string", "@{EMPTY}": "an empty list",
                   "&{EMPTY}": "an empty dictionary", "${True}": "Python True", "${False}": "Python False",
                   "${None}": "Python None", "${null}": "Python None"}
RUNTIME_BUILTINS = (
    "${TEMPDIR}", "${EXECDIR}", "${/}", "${:}", "${\\n}", "&{OPTIONS}", "${OUTPUT DIR}",
    "${OUTPUT FILE}", "${REPORT FILE}", "${LOG FILE}", "${DEBUG FILE}", "${LOG LEVEL}",
    "${TEST NAME}", "@{TEST TAGS}", "${TEST DOCUMENTATION}", "${TEST STATUS}", "${TEST MESSAGE}",
    "${PREV TEST NAME}", "${PREV TEST STATUS}", "${PREV TEST MESSAGE}", "${SUITE NAME}",
    "${SUITE SOURCE}", "${SUITE DOCUMENTATION}", "&{SUITE METADATA}", "${SUITE STATUS}",
    "${SUITE MESSAGE}", "${KEYWORD STATUS}", "${KEYWORD MESSAGE}")
STANDARD_CACHE = {}  # RF's bundled libraries do not change while the server runs.
ROBOT_SUFFIXES = (".robot", ".resource")
SKIPPED_DIRECTORIES = frozenset(("node_modules", "__pycache__"))
# Settings whose NAME cell is a keyword: `[Setup]`, `Suite Teardown`, `Test Template`, ...
FIXTURES = frozenset(("Setup", "Teardown", "Template", "SuiteSetup", "SuiteTeardown",
                      "TestSetup", "TestTeardown", "TestTemplate"))
BDD_PREFIX = re.compile(r"(?:given|when|then|and|but)\s+", re.IGNORECASE)  # RF's English BDD prefixes


def uri_path(uri):
    parsed = urlsplit(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise ValueError("Only local file URIs are supported in v1")
    return Path(unquote(parsed.path)).resolve()


def normalize(name):
    return name.replace(" ", "").replace("_", "").casefold()


def variable_base(name):
    """Inner variable name (`record.name`, `n: int`) -> normalized base `record`, `n`."""
    return normalize(re.split(r"[.\[:]", name, maxsplit=1)[0])


def utf16_column(text, column):
    return len(text[:column].encode("utf-16-le")) // 2


def codepoint_column(text, units):
    if units < 0:
        raise ValueError("Negative UTF-16 position")
    used = 0
    for index, char in enumerate(text):
        width = len(char.encode("utf-16-le")) // 2
        if used == units:
            return index
        if used + width > units:
            raise ValueError("Position splits a UTF-16 surrogate pair")
        used += width
    if used == units:
        return len(text)
    raise ValueError("Position exceeds line")


@dataclass(frozen=True)
class Symbol:
    name: str
    path: Path | None
    line: int
    column: int
    length: int
    text: str
    namespace: str = ""
    # Metadata for hover/completion/signatures; never part of a symbol's identity.
    kind: str = field(default="", compare=False)
    args: object = field(default=None, compare=False)  # RF ArgumentSpec, or None when unknown
    doc: str = field(default="", compare=False)
    doc_format: str = field(default="ROBOT", compare=False)
    value: tuple | None = field(default=None, compare=False)  # variable cells as written
    owner: str = field(default="", compare=False)

    def location(self):
        start = utf16_column(self.text, self.column)
        return {"uri": self.path.as_uri(), "range": {
            "start": {"line": self.line, "character": start},
            "end": {"line": self.line, "character": utf16_column(self.text, self.column + self.length)},
        }}


@dataclass
class Graph:
    model: object
    groups: tuple  # (local, resources, libraries, standard libraries) in RF precedence
    problems: list
    variables: list  # suite variables: own Variables section, then imported resources


def argument_spec(name, types=None, return_type=None, **parts):
    """RF ArgumentSpec; an annotation RF cannot parse is dropped rather than guessed."""
    from robot.errors import DataError
    from robot.running.arguments import ArgumentSpec

    def valid(hint):
        try:
            ArgumentSpec(name, positional_or_named=["x"], types={"x": hint})
            return True
        except DataError:
            return False
    types = {key: hint for key, hint in (types or {}).items() if valid(hint)}
    if return_type and valid(return_type):
        parts["return_type"] = return_type  # an explicit None would read as `-> None`
    try:
        return ArgumentSpec(name, types=types, **parts)
    except DataError:
        return None


def python_arguments(node, name):
    def default(expr):
        return expr.value if isinstance(expr, ast.Constant) else ast.unparse(expr)
    arguments = node.args
    positional = [*arguments.posonlyargs, *arguments.args]
    defaults = {arg.arg: default(value) for arg, value in
                zip(positional[len(positional) - len(arguments.defaults):], arguments.defaults)}
    defaults.update((arg.arg, default(value)) for arg, value in zip(arguments.kwonlyargs, arguments.kw_defaults)
                    if value is not None)
    every = [*positional, *arguments.kwonlyargs, arguments.vararg, arguments.kwarg]
    return argument_spec(
        name, positional_only=[a.arg for a in arguments.posonlyargs],
        positional_or_named=[a.arg for a in arguments.args],
        var_positional=arguments.vararg.arg if arguments.vararg else None,
        named_only=[a.arg for a in arguments.kwonlyargs],
        var_named=arguments.kwarg.arg if arguments.kwarg else None, defaults=defaults,
        types={a.arg: ast.unparse(a.annotation) for a in every if a is not None and a.annotation},
        return_type=ast.unparse(node.returns) if node.returns else None)


@contextmanager
def without_working_directory():
    """`python -m` puts the cwd (often the workspace) first on sys.path. RF's
    standard libraries try optional imports (XML: lxml, Screenshot: wx), which must
    never execute a same-named workspace module."""
    saved = sys.path[:]
    cwd = os.getcwd()
    sys.path[:] = [entry for entry in saved if entry not in ("", ".") and os.path.abspath(entry) != cwd]
    try:
        yield
    finally:
        sys.path[:] = saved


def standard_symbols(name):
    """RF standard-library keywords from RF's own libdoc; Remote exists only at run time."""
    if name not in STANDARD_CACHE:
        symbols = []
        if name != "Remote":
            from robot.libdocpkg import LibraryDocumentation
            try:
                with redirect_stdout(sys.stderr), without_working_directory():  # stdout is the protocol
                    library = LibraryDocumentation(name)
            except Exception as exc:  # e.g. Dialogs without Tk, Telnet on Python 3.13
                print(f"Standard library {name} not indexed: {type(exc).__name__}: {exc}", file=sys.stderr)
                library = None
            for keyword in library.keywords if library else ():
                path, line, column, length, text = None, 0, 0, 0, ""
                if keyword.source and keyword.lineno and keyword.lineno > 0:
                    path = Path(keyword.source).resolve()
                    try:
                        line = keyword.lineno - 1
                        text = path.read_text(encoding="utf-8").splitlines()[line]
                        header = re.search(r"def\s+(\w+)", text)
                        column, length = (header.start(1), len(header[1])) if header else (0, 0)
                    except (OSError, UnicodeError, IndexError):
                        path = None
                symbols.append(Symbol(keyword.name, path, line, column, length, text, name, kind="standard",
                                      args=keyword.args, doc=keyword.doc, doc_format=library.doc_format))
        STANDARD_CACHE[name] = symbols
    return STANDARD_CACHE[name]


class Workspace:
    def __init__(self):
        self.documents = {}
        self.edges = {}
        self.roots = []  # workspace folders from initialize; scanned again for every request

    def workspace_files(self, extra=()):
        """Robot files on disk under the roots, open Robot documents and `extra`, sorted.

        Hidden directories, node_modules and __pycache__ are skipped; symlinked
        directories are not followed. Nothing is cached, so created, changed and
        deleted files are seen on the next request."""
        found = {path for path in [*self.documents, *extra] if path.suffix in ROBOT_SUFFIXES}
        for root in self.roots:
            for directory, names, files in os.walk(root):
                names[:] = [n for n in names if not n.startswith(".") and n not in SKIPPED_DIRECTORIES]
                found.update(Path(directory, f).resolve() for f in files if f.endswith(ROBOT_SUFFIXES))
        return sorted(found)

    def open(self, uri, text, version):
        path = uri_path(uri)
        old = self.documents.get(path)
        if old and version <= old[0]:
            raise ValueError("Document version must increase")
        self.documents[path] = (version, text)

    def close(self, uri):
        self.documents.pop(uri_path(uri), None)

    def text(self, path):
        return self.documents[path][1] if path in self.documents else path.read_text(encoding="utf-8")

    def model(self, path):
        from robot.api import get_model
        return get_model(StringIO(self.text(path)))

    @staticmethod
    def walk(node, owner=None):
        if type(node).__name__ in ("TestCase", "Keyword"):
            owner = node
        yield node, owner
        for _, value in ast.iter_fields(node):
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        yield from Workspace.walk(item, owner)
            elif isinstance(value, ast.AST):
                yield from Workspace.walk(value, owner)

    def symbol(self, path, name, line, column, namespace="", **metadata):
        lines = self.text(path).splitlines()
        return Symbol(name, path, line - 1, column, len(name), lines[line - 1], namespace, **metadata)

    def python_symbols(self, path, namespace):
        """Only explicitly imported local .py libraries; decorators are read, never run."""
        text = self.text(path)
        tree = ast.parse(text, filename=str(path))
        keyword_names = set()
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module == "robot.api.deco":
                keyword_names.update(n.asname or n.name for n in node.names if n.name == "keyword")
        symbols = []
        for node in tree.body:
            # Class libraries and dynamic decorators need a separate bounded outcome.
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            name = None
            for decorator in node.decorator_list:
                func = decorator.func if isinstance(decorator, ast.Call) else decorator
                if isinstance(func, ast.Name) and func.id in keyword_names:
                    name = node.name.replace("_", " ")
                    if isinstance(decorator, ast.Call):
                        literal = decorator.args[0] if decorator.args else next(
                            (k.value for k in decorator.keywords if k.arg == "name"), None)
                        if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
                            name = literal.value
            if name:
                # Python AST columns are UTF-8 bytes, LSP columns are UTF-16 units.
                line = text.splitlines()[node.lineno - 1]
                prefix = len(line.encode("utf-8")[:node.col_offset].decode("utf-8"))
                header = re.match(r"(?:async\s+)?def\s+", line[prefix:])
                if header is None:
                    raise ValueError("Cannot locate Python function header")
                column = prefix + header.end()
                symbols.append(Symbol(name, path, node.lineno - 1, column, len(node.name), line, namespace,
                                      kind="library", args=python_arguments(node, name),
                                      doc=ast.get_docstring(node) or ""))
        return symbols

    def keyword_symbol(self, path, node, primary):
        from robot.errors import DataError
        from robot.running.arguments import UserKeywordArgumentParser
        token = next(t for t in node.header.tokens if t.type == "KEYWORD NAME")
        settings = {type(item).__name__: item for item in node.body}
        arguments = settings.get("Arguments")
        try:
            args = UserKeywordArgumentParser().parse(
                [t.value for t in arguments.tokens if t.type == "ARGUMENT"] if arguments else [], node.name)
        except DataError:
            args = None  # RF reports the invalid [Arguments] when it runs; the signature stays unknown.
        doc = settings["Documentation"].value if "Documentation" in settings else ""
        return self.symbol(path, node.name, token.lineno, token.col_offset, path.stem,
                           kind="local" if primary else "resource", args=args, doc=doc)

    def suite_variable(self, path, node):
        token = next((t for t in node.tokens if t.type == "VARIABLE"), None)
        match = token and VARIABLE.match(token.value)
        if not match:
            return None
        return self.symbol(path, match[0], token.lineno, token.col_offset, kind="suite", value=tuple(node.value))

    def graph(self, root):
        from robot.libraries import STDLIBS  # RF's standard library name set
        local, resources, libraries, standard, problems = [], [], [], [], []
        own_variables, imported_variables = [], []
        visited = set()
        self.edges = {}

        def add_standard(name, namespace):
            if not any(s.namespace == namespace for s in standard):
                standard.extend(replace(s, namespace=namespace) for s in standard_symbols(name))

        def visit(path, primary=False):
            if path in visited:
                return
            visited.add(path)
            self.edges[path] = []
            model = self.model(path)
            for node, _ in self.walk(model):
                kind = type(node).__name__
                if kind == "Keyword":
                    (local if primary else resources).append(self.keyword_symbol(path, node, primary))
                if kind == "Variable" and (variable := self.suite_variable(path, node)):
                    (own_variables if primary else imported_variables).append(variable)
                if kind not in ("ResourceImport", "LibraryImport"):
                    continue
                name = node.name
                if not name or "${" in name:
                    problems.append((path, node.lineno, "Unresolved dynamic import", ERROR))
                    continue
                candidate = path.parent / name
                if kind == "LibraryImport" and not name.endswith(".py"):
                    if name in STDLIBS:
                        # RF imports these as robot.libraries.<name>, ahead of any sibling file.
                        add_standard(name, node.alias or name)
                        continue
                    candidate = (path.parent / (name.replace(".", "/") + ".py")).resolve()
                    if "/" not in name and candidate not in self.documents and not candidate.is_file():
                        # A module name may come from sys.path/--pythonpath, which is not modelled yet.
                        problems.append((path, node.lineno, f"Library not resolved in this version: {name}",
                                         INFORMATION))
                        continue
                candidate = candidate.resolve()
                self.edges[path].append(candidate)
                try:
                    if kind == "ResourceImport":
                        visit(candidate)
                    else:
                        # RF names a path import by its file stem, a module import by its full name.
                        namespace = node.alias or (Path(name).stem if name.endswith(".py") else name)
                        libraries.extend(self.python_symbols(candidate, namespace))
                except (OSError, SyntaxError, UnicodeError, ValueError) as exc:
                    problems.append((path, node.lineno, f"Unresolved {kind}: {name}: {exc}", ERROR))
            return model

        model = visit(root, True)
        add_standard("BuiltIn", "BuiltIn")  # implicitly imported by every Robot file
        return Graph(model, (local, resources, libraries, standard), problems, own_variables + imported_variables)

    @staticmethod
    def matches(symbol, name):
        if normalize(symbol.name) == normalize(name):
            return True
        if "${" in symbol.name:
            from robot.running.arguments.embedded import EmbeddedArguments
            embedded = EmbeddedArguments.from_name(symbol.name)
            return bool(embedded and embedded.match(name))
        return False

    def resolve_call(self, groups, name):
        """[(symbol, offset)], where the keyword's own name starts at `offset` in `name`:
        after a library/resource prefix (`Audit.`) or an English BDD prefix (`Given `)."""
        found = self.resolve_name(groups, name)
        # As in RF, one BDD prefix is ignored only when the full name matches no keyword.
        if not found and (prefix := BDD_PREFIX.match(name)) and name[prefix.end():]:
            found = [(s, prefix.end() + offset) for s, offset in self.resolve_name(groups, name[prefix.end():])]
        return found

    def resolve_name(self, groups, name):
        # Robot prefers local keywords, then imported resources, then custom
        # libraries, then standard libraries (including the implicit BuiltIn).
        for group in groups:
            found = [(s, 0) for s in group if self.matches(s, name)]
            if not found and "." in name:
                found = [(s, index + 1) for s in group for index, char in enumerate(name)
                         if char == "." and normalize(name[:index]) == normalize(s.namespace)
                         and self.matches(s, name[index + 1:])]
            if found:
                return list({(s.path, s.line, s.column): (s, offset) for s, offset in found}.values())
        return []

    def resolve(self, groups, name):
        return [symbol for symbol, _ in self.resolve_call(groups, name)]

    @staticmethod
    def keyword_cell(node, token):
        """A keyword-call cell or a setup/teardown/template setting naming a keyword (`NONE` disables it)."""
        if token.type == "KEYWORD":
            return True
        return token.type == "NAME" and type(node).__name__ in FIXTURES and bool(token.value) \
            and token.value.upper() != "NONE"

    def token_at(self, model, line, column):
        for node, owner in self.walk(model):
            for token in getattr(node, "tokens", ()):
                if token.lineno == line + 1 and token.col_offset <= column < token.end_col_offset:
                    return node, owner, token
        return None, None, None

    @staticmethod
    def owner_at(model, line):
        for node, _ in Workspace.walk(model):
            if type(node).__name__ in ("TestCase", "Keyword") and node.lineno <= line + 1 <= node.end_lineno:
                return node
        return None

    def scope_variables(self, path, owner, line, exclude=None, assigning=False):
        """Owner arguments and locals defined up to 0-based `line`, in source order.

        RF assigns `${x}=    IF    ...` after the chosen branch runs, so on the inline IF's
        own lines its assignment is visible only to its ASSIGN cells (`assigning`), never to
        the condition or branch values that are evaluated before it."""
        found = []
        if owner is None:
            return found
        is_keyword = type(owner).__name__ == "Keyword"
        label = f"{'keyword' if is_keyword else 'test'} {owner.name}"
        pending = {id(node.header): node.end_lineno for node, _ in self.walk(owner)
                   if type(node).__name__ == "If" and type(node.header).__name__ == "InlineIfHeader"}
        for node, _ in self.walk(owner):
            kind = type(node).__name__
            if node is exclude or node.lineno > line + 1:
                continue
            if kind == "InlineIfHeader" and not assigning and line + 1 <= pending[id(node)]:
                continue
            if kind == "KeywordName" and is_keyword:
                types = ("KEYWORD NAME",)  # embedded arguments: `Greet ${name}`
            elif kind == "Arguments":
                types = ("ARGUMENT",)
            elif kind in ("Var", "ForHeader", "ExceptHeader"):
                types = ("VARIABLE",)
            else:
                types = ("ASSIGN",)
            for token in getattr(node, "tokens", ()):
                if token.type not in types:
                    continue
                # Only an embedded keyword name defines several variables in one token.
                matches = VARIABLE.finditer(token.value) if kind == "KeywordName" else [VARIABLE.match(token.value)]
                for match in filter(None, matches):
                    rest = token.value[match.end():]
                    if kind in ("KeywordName", "Arguments"):
                        role, value = "argument", (rest[1:],) if rest.startswith("=") else None
                    elif kind == "Var":
                        role, value = "var", tuple(t.value for t in node.tokens if t.type == "ARGUMENT")
                    elif kind in ("ForHeader", "ExceptHeader"):
                        role, value = kind.removesuffix("Header").lower(), None
                    else:
                        role, value = "assign", (node.keyword,) if getattr(node, "keyword", None) else None
                    found.append(self.symbol(path, match[0], token.lineno, token.col_offset + match.start(),
                                             kind=role, value=value, owner=label))
        return found

    @staticmethod
    def loop_names(owner):
        """id(node) -> normalized names of the locals assigned anywhere in a FOR/WHILE body
        around that node. RF runs the body (and evaluates a WHILE condition) again after those
        assignments, so on a later iteration a use there sees the local even above them."""
        result = {}

        def assigned(nodes):
            names = set()
            for top in nodes:
                for node, _ in Workspace.walk(top):
                    kind = "VARIABLE" if type(node).__name__ in ("Var", "ForHeader", "ExceptHeader") else "ASSIGN"
                    names.update(variable_base(match[1]) for token in getattr(node, "tokens", ())
                                 if token.type == kind and (match := VARIABLE.match(token.value)))
            return frozenset(names)

        def visit(node, names):
            result[id(node)] = names
            kind = type(node).__name__
            inner = names | assigned(node.body) if kind in ("For", "While") else names
            for field, value in ast.iter_fields(node):
                again = field == "body" or (field == "header" and kind == "While")
                for child in value if isinstance(value, list) else [value]:
                    if isinstance(child, ast.AST):
                        visit(child, inner if again else names)
        if owner is not None:
            visit(owner, frozenset())
        return result

    @staticmethod
    def builtin_variables(path):
        result = [Symbol("${CURDIR}", None, 0, 0, 0, "", kind="builtin", value=(str(path.parent),))]
        result += [Symbol(name, None, 0, 0, 0, "", kind="builtin", value=(value,))
                   for name, value in STATIC_BUILTINS.items()]
        result += [Symbol(name, None, 0, 0, 0, "", kind="builtin") for name in RUNTIME_BUILTINS]
        return result

    def variable_definitions(self, path, graph, owner, variable, line, exclude=None, assigning=False):
        """Innermost definition: last owner local/argument, else suite, else built-in."""
        wanted = normalize(variable)
        scoped = [s for s in self.scope_variables(path, owner, line, exclude, assigning)
                  if variable_base(s.name[2:-1]) == wanted]
        if scoped:
            return scoped[-1:]
        suite = [s for s in graph.variables if variable_base(s.name[2:-1]) == wanted]
        own = [s for s in suite if s.path == path]
        if suite:
            return own or suite
        return [s for s in self.builtin_variables(path) if variable_base(s.name[2:-1]) == wanted][:1]

    def visible_variables(self, path, graph, owner, line, exclude=None):
        """Completion candidates: one entry per name, innermost definition first."""
        seen, result = set(), []
        scoped = reversed(self.scope_variables(path, owner, line, exclude))
        own = [s for s in graph.variables if s.path == path]
        for symbol in [*scoped, *own, *graph.variables, *self.builtin_variables(path)]:
            key = variable_base(symbol.name[2:-1])
            if key not in seen:
                seen.add(key)
                result.append(symbol)
        return result

    def locate(self, uri, position):
        path = uri_path(uri)
        text = self.text(path)
        lines = text.splitlines()
        if not text or text.endswith(("\n", "\r")):
            lines.append("")  # LSP has a last, empty line after a final line break
        line = position["line"]
        if line < 0 or line >= len(lines):
            raise ValueError("Line outside document")
        return path, lines[line], line, codepoint_column(lines[line], position["character"])

    @staticmethod
    def defining_statement(node, token):
        """A variable used in a call/VAR/FOR/EXCEPT value is not yet set by that statement."""
        if token.type in ("ASSIGN", "VARIABLE") or type(node).__name__ not in (
                "KeywordCall", "Var", "ForHeader", "ExceptHeader", "InlineIfHeader"):
            return None
        return node

    @staticmethod
    def variable_at(token, column):
        for match in VARIABLE.finditer(token.value):
            if token.col_offset + match.start() <= column < token.col_offset + match.end():
                return match, re.split(r"[.\[:]", match[1])[0]  # `${rec.name}`, `${PORT: int}`
        return None, None

    def definition(self, uri, position):
        path, _, line, column = self.locate(uri, position)
        graph = self.graph(path)
        node, owner, token = self.token_at(graph.model, line, column)
        if token is None:
            return []
        match, variable = self.variable_at(token, column)
        if match:
            return [s.location() for s in self.variable_definitions(
                path, graph, owner, variable, line, self.defining_statement(node, token),
                token.type == "ASSIGN") if s.path is not None]
        if not self.keyword_cell(node, token):
            return []
        return [s.location() for s in self.resolve(graph.groups, token.value) if s.path is not None]

    def diagnostics(self, uri):
        path = uri_path(uri)
        graph = self.graph(path)
        result = []

        def add(line, message, code, severity=ERROR):
            result.append({"range": {"start": {"line": max(0, line - 1), "character": 0},
                                      "end": {"line": max(0, line - 1), "character": 0}},
                           "severity": severity, "source": "robot-companion-backend", "code": code,
                           "message": message})

        for source, line, message, severity in graph.problems:
            if source == path:
                add(line, message, "import", severity)
        for node, _ in self.walk(graph.model):
            for error in getattr(node, "errors", ()):
                add(node.lineno, error, "syntax")
            for token in getattr(node, "tokens", ()):
                if token.type == "KEYWORD" and len(self.resolve(graph.groups, token.value)) > 1:
                    add(token.lineno, f"Ambiguous keyword: {token.value}; qualify its library/resource", "ambiguity")
        return result

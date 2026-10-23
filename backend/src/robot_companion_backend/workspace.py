"""Source-only import graph: Robot's model for Robot, Python AST for libraries.

No workspace library execution, workspace-wide name map, or dependency on the
extension. Graphs are rebuilt for each request from current overlays and disk
dependencies. Only RF's own standard libraries are read through RF's libdoc.
"""

import ast
from contextlib import contextmanager, redirect_stdout
from dataclasses import dataclass, field, replace
from importlib.machinery import EXTENSION_SUFFIXES
from io import StringIO
from pathlib import Path
import os
import re
import stat
import sys
from urllib.parse import unquote, urlsplit

from . import markdown
from . import project
from .runtime import robot_version
from .source_cache import Sources, MAX_LIBRARY_READINGS, snapshot
from .cancellation import checkpoint

ERROR, WARNING, INFORMATION = 1, 2, 3  # LSP DiagnosticSeverity
VARIABLE = re.compile(r"[$@&]\{([^}]+)\}")
# Built-in variables (User Guide "Built-in variables") of RF 7.3.2 and RF 7.5. Only parse-time
# or constant values are known statically; the others are set when Robot runs.
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
# New in RF 7.5 (test-level [Metadata]); RF 7.3.2 has no such variable.
RUNTIME_BUILTINS_7_5 = ("${TEST METADATA}",)
STANDARD_CACHE = {}  # RF's bundled libraries do not change while the server runs.
ROBOT_SUFFIXES = (".robot", ".resource")
# importlib's FileFinder order (extension modules, source, bytecode); only source code is read.
MODULE_SUFFIXES = [(suffix, False) for suffix in EXTENSION_SUFFIXES] + [(".py", True), (".pyc", False)]
# A `Resource` setting line's cells (plain or pipe-separated format), for Markdown resources.
SETTING_CELLS = re.compile(r"\s*\|\s+|\s+\|\s*|\s{2,}|\t")
SKIPPED_DIRECTORIES = frozenset(("node_modules", "__pycache__"))
# Settings whose NAME cell is a keyword: `[Setup]`, `Suite Teardown`, `Test Template`, ...
FIXTURES = frozenset(("Setup", "Teardown", "Template", "SuiteSetup", "SuiteTeardown",
                      "TestSetup", "TestTeardown", "TestTemplate"))
BDD_PREFIX = re.compile(r"(?:given|when|then|and|but)\s+", re.IGNORECASE)  # RF's English BDD prefixes
# BuiltIn's keywords that run a keyword named by an argument (its `run_keyword_variant(dry_run=True)`
# methods, identical in RF 7.3.2 and RF 7.5): the number of arguments before the keyword name.
RUN_VARIANTS = {"".join(name.split()).casefold(): before for name, before in (
    ("Run Keyword", 0), ("Run Keyword And Ignore Error", 0), ("Run Keyword And Warn On Failure", 0),
    ("Run Keyword And Return Status", 0), ("Run Keyword And Continue On Failure", 0), ("Run Keyword And Return", 0),
    ("Run Keyword If Test Failed", 0), ("Run Keyword If Test Passed", 0), ("Run Keyword If Timeout Occurred", 0),
    ("Run Keyword If All Tests Passed", 0), ("Run Keyword If Any Tests Failed", 0),
    ("Run Keyword And Expect Error", 1), ("Repeat Keyword", 1), ("Run Keyword Unless", 1),
    ("Run Keyword And Return If", 1), ("Wait Until Keyword Succeeds", 2))}
RUN_KEYWORD_IF, RUN_KEYWORDS = "runkeywordif", "runkeywords"  # with ELSE IF/ELSE branches; with AND
# Variants whose run catches the keyword's failure, also "No keyword with name ..." and argument
# errors (checked with RF 7.3.2 and RF 7.5): the test does not fail because of them.
CATCHING = frozenset(("runkeywordandignoreerror", "runkeywordandexpecterror", "runkeywordandreturnstatus",
                      "runkeywordandwarnonfailure"))
# BuiltIn keywords setting a variable with a non-local scope, by normalized name.
SCOPED_SETTERS = {"settestvariable": "TEST", "settaskvariable": "TASK", "setsuitevariable": "SUITE",
                  "setglobalvariable": "GLOBAL"}
WINDOWS = sys.platform == "win32"
WINDOWS_DRIVE_URI_PATH = re.compile(r"/[A-Za-z]:/")  # `/c:/...` once `%3A` is decoded


def file_uri_path(uri, windows=WINDOWS):
    """The local path text of a `file:` URI, not resolved. Remote authorities are refused.

    On Windows only drive-letter URIs are local, as VS Code writes them:
    `file:///c%3A/My%20Tests/a.robot` becomes `c:\\My Tests\\a.robot`. A UNC or device
    path (`file:////server/share`, an encoded `\\\\server`) or a path without a drive is
    refused, so no request reaches a network share."""
    parsed = urlsplit(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise ValueError("Only local file URIs are supported in v1")
    path = unquote(parsed.path)
    if windows:
        if not WINDOWS_DRIVE_URI_PATH.match(path):
            raise ValueError("Only local drive-letter file URIs are supported on Windows")
        path = path[1:].replace("/", "\\")
    return path


def uri_path(uri):
    return Path(file_uri_path(uri)).resolve()


# Windows reparse tags of links (WinNT.h); Python 3.11's is_symlink() misses junctions.
LINK_REPARSE_TAGS = (0xA0000003, 0xA000000C)  # IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK


def is_resource_file(path):
    """A file RF parses as a resource when it is imported, never as a suite: `.resource`, and
    `.md`/`.markdown` except `.robot.md` (RF 7.5)."""
    return path.suffix == ".resource" or (markdown.is_markdown(path) and not markdown.is_suite_name(path))


def is_suite_file(path):
    """A file with RF's suite extensions the services read: `.robot`, and `.robot.md` (RF 7.5)."""
    return path.suffix == ".robot" or markdown.is_suite_name(path)


def resource_imports(text):
    """The Markdown names, as written, of the `Resource` settings in Robot text."""
    names = []
    for line in text.splitlines():
        cells = [cell.strip() for cell in SETTING_CELLS.split(line.strip().strip("|")) if cell.strip()]
        if len(cells) >= 2 and cells[0].casefold() == "resource" and markdown.is_markdown(Path(cells[1])):
            names.append(cells[1])
    return names


def file_key(path):
    """The identity of a file: its device and inode when it exists, so the file system's own
    case rules decide whether two spellings are the same file (Windows and macOS: case-insensitive);
    else its normalized path (an open document not yet saved)."""
    try:
        stat_result = os.stat(path)
        if stat_result.st_ino:
            return (stat_result.st_dev, stat_result.st_ino)
    except OSError:
        pass
    return os.path.normcase(os.path.abspath(path))


def resource_extension_error(path):
    """RF's own refusal of a resource file extension it does not read, None when it reads it
    (RF 7.5 reads `.md` and `.markdown`, RF 7.3.2 does not)."""
    from robot.running.importer import RESOURCE_EXTENSIONS
    from robot.utils import seq2str
    extension = os.path.splitext(path)[1]
    if extension.lower() in RESOURCE_EXTENSIONS:
        return None
    return f"Invalid resource file extension '{extension}'. Supported extensions are " \
        f"{seq2str(sorted(RESOURCE_EXTENSIONS))}."


def is_link(path):
    """A symbolic link, or on Windows also a junction, which a walk must not follow."""
    try:
        status = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISLNK(status.st_mode) or getattr(status, "st_reparse_tag", 0) in LINK_REPARSE_TAGS


def normalize(name):
    return name.replace(" ", "").replace("_", "").casefold()


def var_scope(node):
    """A VAR statement's scope option (`scope=SUITE` -> `SUITE`), "" when it has none."""
    options = [t.value for t in node.tokens if t.type == "OPTION" and normalize(t.value).startswith("scope=")]
    return options[-1].split("=", 1)[1].strip().upper() if options else ""


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
    scope: str = field(default="", compare=False)  # VAR's scope=...; for "scoped" its TEST/SUITE/GLOBAL
    declaration: bool = field(default=False, compare=False)

    def location(self):
        start = utf16_column(self.text, self.column)
        return {"uri": self.path.as_uri(), "range": {
            "start": {"line": self.line, "character": start},
            "end": {"line": self.line, "character": utf16_column(self.text, self.column + self.length)},
        }, **({"sourceKind": "declaration"} if self.declaration else {})}


@dataclass(frozen=True, eq=False)
class Call:
    """A keyword name cell RF runs: a statement's own keyword, or (`indirect`) a keyword name
    argument of a BuiltIn run-keyword variant, with the argument cells passed to it. `caught`:
    a variant around it (`Run Keyword And Ignore Error`) catches its failure."""
    token: object
    arguments: tuple
    indirect: bool = False
    caught: bool = False


@dataclass
class Graph:
    model: object
    groups: tuple  # (local, resources, libraries, standard libraries) in RF precedence
    problems: list
    variables: list  # suite variables: own Variables section, then imported resources
    # One Import per resolved resource/library import statement, in the order RF reads them
    # (nested resources after the import naming them), then the implicit BuiltIn. A library
    # imported by several statements under one name, or a resource imported by several
    # statements, appears once per statement; a resource's keywords are on its first entry.
    imports: list = field(default_factory=list)

    configured: list = field(default_factory=list)  # --variable, then --variablefile variables
    files: list = field(default_factory=list)  # the Robot files of the namespace, the root first
    variables_open: bool = False  # a variable file whose variables cannot all be read statically
    notes: list = field(default_factory=list)  # import findings that hide nothing (RF ignores the import)


@dataclass(frozen=True)
class Import:
    """A resolved import of the graph: `kind` is "resource", "library" or "standard";
    `importer`/`line` (1-based) locate the import statement, None for the implicit BuiltIn."""
    kind: str
    name: str
    alias: str | None
    namespace: str
    path: Path | None
    importer: Path | None
    line: int | None
    symbols: tuple


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


def python_arguments(node, name, bound=False):
    """RF's signature of a function, or of a method called on its instance or class (`bound`):
    without the `self`/`cls` parameter Python passes."""
    def default(expr):
        return expr.value if isinstance(expr, ast.Constant) else ast.unparse(expr)
    arguments = node.args
    positional = [*arguments.posonlyargs, *arguments.args]
    defaults = {arg.arg: default(value) for arg, value in
                zip(positional[len(positional) - len(arguments.defaults):], arguments.defaults)}
    defaults.update((arg.arg, default(value)) for arg, value in zip(arguments.kwonlyargs, arguments.kw_defaults)
                    if value is not None)
    posonly, plain = arguments.posonlyargs, arguments.args
    if bound and positional:
        defaults.pop(positional[0].arg, None)
        posonly, plain = (posonly[1:], plain) if posonly else (posonly, plain[1:])
    elif bound and arguments.vararg is None:
        return None  # Python cannot even pass the instance: RF reports the call's error
    every = [*posonly, *plain, *arguments.kwonlyargs, arguments.vararg, arguments.kwarg]
    return argument_spec(
        name, positional_only=[a.arg for a in posonly],
        positional_or_named=[a.arg for a in plain],
        var_positional=arguments.vararg.arg if arguments.vararg else None,
        named_only=[a.arg for a in arguments.kwonlyargs],
        var_named=arguments.kwarg.arg if arguments.kwarg else None, defaults=defaults,
        types={a.arg: ast.unparse(a.annotation) for a in every if a is not None and a.annotation},
        return_type=ast.unparse(node.returns) if node.returns else None)


def search_path():
    """The language service's own module search path, as directories: the sys.path of the
    interpreter running it, which is the folder's selected environment with its site-packages.
    The working directory that `python -m` puts first is left out, as in
    `without_working_directory`; zip files and missing entries are skipped."""
    cwd = os.path.abspath(os.getcwd())
    directories = []
    for entry in sys.path:
        if entry in ("", ".") or os.path.abspath(entry) == cwd or not os.path.isdir(entry):
            continue
        directory = Path(entry).resolve()
        if directory not in directories:
            directories.append(directory)
    return directories


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


@dataclass
class ModuleReading:
    """RF's static library rules applied to a module's source, which is never run."""
    # [(node, keyword name)] indexed as library keywords: a FunctionDef/AsyncFunctionDef, or the
    # string constant naming a dynamic library's keyword in its `get_keyword_names` list.
    keywords: list
    maybe: set | None  # other normalized names it may expose; None when its keywords cannot be known
    bound: frozenset = frozenset()  # id() of methods RF calls on the instance or class (no `self`/`cls` argument)
    # A dynamic library's keywords take `*varargs` (True: also `**kwargs`); None when unknown.
    named: bool | None = None
    declarations: frozenset = frozenset()  # own source declarations, not a verified runtime contract


# Module-level functions that make RF's keyword set dynamic, or that this reading treats so.
DYNAMIC_FUNCTIONS = frozenset(("get_keyword_names", "run_keyword", "__getattr__", "__dir__"))
# Calls at import time that may bind or rename module attributes the reading cannot see.
REBINDING_CALLS = frozenset(("setattr", "delattr", "globals", "vars", "locals", "exec", "eval"))


def import_time(tree):
    """(node, in_class) for the nodes evaluated when a module is imported, in source order:
    function bodies are skipped, their decorators, defaults and annotations are not."""
    pending = [(statement, False) for statement in reversed(tree.body)]
    while pending:  # iterative: deeply nested module code must not exhaust the stack
        node, in_class = pending.pop()
        yield node, in_class
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            arguments = node.args
            every = [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs, arguments.vararg, arguments.kwarg]
            children = [*getattr(node, "decorator_list", ()), *arguments.defaults,
                        *filter(None, arguments.kw_defaults), getattr(node, "returns", None),
                        *(a.annotation for a in every if a is not None)]
            pending += [(child, in_class) for child in reversed(children) if child is not None]
            continue
        children = []
        for name, value in ast.iter_fields(node):
            inner = in_class or (isinstance(node, ast.ClassDef) and name == "body")
            children += [(child, inner) for child in (value if isinstance(value, list) else [value])
                         if isinstance(child, ast.AST)]
        pending += reversed(children)


def module_reading(tree, stem):
    """The keywords RF's StaticKeywordCreator would create for module `stem` (identical in RF 7.3.2
    and RF 7.5; RF 7.5 only adds Libdoc docstring parsing), as far as its
    top level can be read: every public routine while `ROBOT_AUTO_KEYWORDS` is true, or one
    with `robot_name` (`@keyword`), filtered by `__all__`, without `@not_keyword` ones.

    Indexed are `@keyword` functions (in a module that is not static, every top-level one, as
    before) and, in a static module, plain top-level `def`s that nothing else at module level
    binds or uses. Every other name the module may expose stays in `maybe`, where it only
    silences an unknown-keyword error. A class/dynamic/hybrid library, `import *`, an unread
    decorator, a computed `__all__`/`ROBOT_AUTO_KEYWORDS` or import-time rebinding makes
    `maybe` None."""
    nodes = list(import_time(tree))
    decorators = {"keyword": set(), "not_keyword": set()}
    for node, _ in nodes:
        if isinstance(node, ast.ImportFrom) and node.module == "robot.api.deco":
            for alias in node.names:
                if alias.name in decorators:
                    decorators[alias.name].add(alias.asname or alias.name)

    def keyword_decorated(node):
        return any(isinstance(d.func if isinstance(d, ast.Call) else d, ast.Name) and
                   (d.func if isinstance(d, ast.Call) else d).id in decorators["keyword"] for d in node.decorator_list)

    def unread(decorator):
        func = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(func, ast.Attribute) and func.attr == "keyword":
            return True
        if isinstance(decorator, ast.Call) and isinstance(func, ast.Name) and func.id in decorators["keyword"]:
            literal = decorator.args[0] if decorator.args else next(
                (k.value for k in decorator.keywords if k.arg == "name"), None)
            return literal is not None and not (isinstance(literal, ast.Constant) and isinstance(literal.value, str))
        return False

    def decorated_name(node):
        name = node.name.replace("_", " ")
        for decorator in node.decorator_list:
            if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Name) and \
                    decorator.func.id in decorators["keyword"]:
                literal = decorator.args[0] if decorator.args else next(
                    (k.value for k in decorator.keywords if k.arg == "name"), None)
                if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
                    name = literal.value
        return name

    top = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    decorated = [(n, decorated_name(n)) for n in top if keyword_decorated(n)]
    # Module-level bindings and uses of each name (class bodies bind class attributes instead),
    # and names given at import time (`fn.robot_name = "X"`, a guarded `@keyword("X")`).
    bindings, loaded, positions, renamed, static = {}, set(), set(), [], True
    for node, _ in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            positions.update(id(d.func if isinstance(d, ast.Call) else d) for d in node.decorator_list)
    for node, in_class in nodes:
        bound = []
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                loaded.add(node.id)
                # `keyword("Renamed")(fn)`, `not_keyword(fn)`: decorated at import time, unread.
                static &= id(node) in positions or node.id not in decorators["keyword"] | decorators["not_keyword"]
            else:
                bound.append(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            static &= not any(alias.name == "*" for alias in node.names)
            bound += [(alias.asname or alias.name).split(".")[0] for alias in node.names]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.append(node.name)
            if not in_class and not isinstance(node, ast.ClassDef):
                static &= not any(map(unread, node.decorator_list))
                if keyword_decorated(node) and node not in top:
                    renamed.append((node.name, decorated_name(node)))
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            bound.append(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bound.append(node.rest)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.append(node.name)
        elif isinstance(node, ast.Call):
            func = node.func
            static &= not (isinstance(func, ast.Name) and func.id in REBINDING_CALLS)
        elif isinstance(node, ast.Attribute) and node.attr == "modules":
            static = False  # `sys.modules[__name__]...`
        elif isinstance(node, ast.Attribute) and node.attr == "robot_name" and not isinstance(node.ctx, ast.Load):
            assigned = next((n for n, _ in nodes if isinstance(n, ast.Assign) and n.targets == [node]), None)
            value = assigned.value if assigned is not None else None
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                renamed.append((node.value.id if isinstance(node.value, ast.Name) else None, value.value))
            else:
                static = False  # a computed or deleted keyword name
        if not in_class:
            for name in bound:
                bindings.setdefault(name, []).append(node)
    declared = {name for node in ast.walk(tree) if isinstance(node, (ast.Global, ast.Nonlocal)) for name in node.names}

    def setting(name, valid):
        """The literal value of `name` from its one top-level assignment, `None` when it is not
        set, or `...` when anything else in the module mentions it."""
        mentions = [node for node in ast.walk(tree) if
                    (isinstance(node, ast.Name) and node.id == name) or
                    (isinstance(node, ast.alias) and name in (node.name, node.asname)) or
                    (isinstance(node, (ast.Global, ast.Nonlocal)) and name in node.names) or
                    (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name) or
                    (isinstance(node, ast.arg) and node.arg == name) or
                    (isinstance(node, ast.keyword) and node.arg == name) or
                    (isinstance(node, ast.Attribute) and node.attr == name) or
                    (isinstance(node, ast.Constant) and node.value == name)]
        if not mentions:
            return None
        for statement in tree.body:
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
                target = statement.targets[0]
            elif isinstance(statement, ast.AnnAssign) and statement.value is not None and statement.simple:
                target = statement.target
            else:
                continue
            if isinstance(target, ast.Name) and target.id == name:
                return valid(statement.value) if mentions == [target] else ...
        return ...

    def names_literal(value):
        if isinstance(value, (ast.List, ast.Tuple)) and all(
                isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts):
            return {e.value for e in value.elts}
        return ...
    auto = setting("ROBOT_AUTO_KEYWORDS", lambda value: value.value if isinstance(value, ast.Constant) and
                   isinstance(value.value, bool) else ...)
    included = setting("__all__", names_literal)
    # A binding of the module's own name other than a plain `def` may be the class RF would use.
    own = bindings.get(stem, [])
    static &= auto is not ... and included is not ... and not DYNAMIC_FUNCTIONS & (bindings.keys() | declared) \
        and stem not in declared and all(n in top and not n.decorator_list for n in own)
    if not static:
        return ModuleReading(decorated, None)

    last = {n.name: n for n in top}
    hidden, keywords = set(), []

    def rebound(name):
        """Bound by anything but top-level `def`s (of which the last wins, as in Python)."""
        return name in declared or not all(n in top for n in bindings.get(name, ()))
    for name, node in last.items():
        if rebound(name) or any(identifier == name for identifier, _ in renamed):
            continue  # `fn.robot_name = "X"` renames even a `@keyword` function
        is_keyword = keyword_decorated(node)
        not_keyword = [d for d in node.decorator_list if isinstance(d, ast.Name) and d.id in decorators["not_keyword"]]
        if is_keyword and not not_keyword:
            keywords.append((node, decorated_name(node)))
        elif name in loaded or is_keyword:
            continue  # a call at import time (`register(fn)`) may rename or hide it
        elif node.decorator_list and len(not_keyword) == len(node.decorator_list):
            hidden.add(name)
        elif not node.decorator_list and not name.startswith("_"):
            if auto is False:
                hidden.add(name)
            else:
                from robot.utils import printable_name
                keywords.append((node, printable_name(name, code_style=True)))
    # A `@keyword` function a later binding replaces may still be the one exposed.
    renamed += [(node.name, name) for node, name in decorated if all(node is not n for n, _ in keywords)]
    if included is not None:  # by Python name, also for `@keyword("Custom") def impl`
        keywords = [(node, name) for node, name in keywords if node.name in included]
        renamed = [(identifier, name) for identifier, name in renamed if identifier is None or identifier in included]
    exposed = {name for name, nodes in bindings.items() if not all(isinstance(n, ast.ClassDef) for n in nodes)}
    exposed = {name for name in exposed | declared if not name.startswith("_") and name not in hidden}
    if included is not None:
        exposed &= included
    # Two keywords of one library with one name: RF reports a duplicate when importing it, so
    # neither is indexed, as neither is a name another binding of the module may also expose.
    counts = {}
    for _, name in keywords:
        counts[normalize(name)] = counts.get(normalize(name), 0) + 1
    duplicates = {key for key, count in counts.items() if count > 1}
    indexed = {id(node) for node, name in keywords if normalize(name) not in duplicates}
    maybe = {normalize(name) for name in exposed if rebound(name) or id(last.get(name)) not in indexed}
    maybe |= {normalize(name) for _, name in renamed}
    duplicates |= {normalize(name) for _, name in keywords} & maybe
    keywords = sorted(((node, name) for node, name in keywords if normalize(name) not in duplicates),
                      key=lambda pair: pair[0].lineno)
    return ModuleReading(keywords, maybe | duplicates)


# Library classes: RF's choice of a module's library code (robot.utils.importer) and its class,
# hybrid and dynamic keyword creators (robot.running.testlibraries), identical in RF 7.3.2 and 7.5.

# Class decorators of the standard library, which never give a class RF's library attributes.
SAFE_CLASS_DECORATORS = frozenset(("dataclasses.dataclass", "functools.total_ordering", "enum.unique"))
# RF's dynamic API method names (robot.running.dynamicmethods), tried as written, then in camelCase.
GET_KEYWORD_NAMES = ("get_keyword_names", "getKeywordNames")
RUN_KEYWORD = ("run_keyword", "runKeyword")
GET_KEYWORD_ARGUMENTS = ("get_keyword_arguments", "getKeywordArguments")
# Class attributes through which an instance may have names, or be an object, this reading cannot see.
OPEN_ATTRIBUTES = frozenset(("__getattr__", "__getattribute__", "__dir__", "__new__", "__dict__"))
# Class-body values that are never routines, so never keywords.
DATA_VALUES = (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.JoinedStr, ast.ListComp, ast.SetComp,
               ast.DictComp)
BUILTIN_NAMES = frozenset(dir(__import__("builtins")))


def standard_name(qualified):
    """A dotted name in Python's standard library (`builtins.object`, `enum.Enum`)."""
    return qualified.split(".")[0] in sys.stdlib_module_names | {"builtins"}


class ModuleNames:
    """What the top-level names of a module refer to when it is imported, read from its source."""

    def __init__(self, tree):
        self.tree = tree
        self.bindings = {}
        self.star = False
        for node, in_class in import_time(tree):
            if in_class:
                continue
            names = []
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
            elif isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                names = [node.id]
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                self.star |= any(alias.name == "*" for alias in node.names)
                names = [(alias.asname or alias.name).split(".")[0] for alias in node.names]
            elif isinstance(node, (ast.MatchAs, ast.MatchStar, ast.ExceptHandler)) and node.name:
                names = [node.name]
            elif isinstance(node, ast.MatchMapping) and node.rest:
                names = [node.rest]
            for name in names:
                self.bindings.setdefault(name, []).append(node)
        self.declared = {name for node in ast.walk(tree) if isinstance(node, (ast.Global, ast.Nonlocal))
                         for name in node.names}

    def only(self, name):
        """The one statement binding `name` at import time, or None."""
        nodes = self.bindings.get(name, [])
        return nodes[0] if len(nodes) == 1 and name not in self.declared and not self.star else None

    def reference(self, expr):
        """("class", ClassDef) for a top-level class of this module, ("name", dotted name) for an
        imported or built-in name, or None when what `expr` refers to is unknown."""
        parts = []
        while isinstance(expr, ast.Attribute):
            parts.insert(0, expr.attr)
            expr = expr.value
        if not isinstance(expr, ast.Name):
            return None
        if expr.id not in self.bindings:
            known = expr.id in BUILTIN_NAMES and expr.id not in self.declared and not self.star
            return ("name", ".".join(["builtins", expr.id, *parts])) if known else None
        node = self.only(expr.id)
        if isinstance(node, ast.ClassDef) and not parts and node in self.tree.body:
            return "class", node
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            alias = next(a for a in node.names if (a.asname or a.name) == expr.id)
            return "name", ".".join([node.module, alias.name, *parts])
        if isinstance(node, ast.Import):
            alias = next(a for a in node.names if (a.asname or a.name).split(".")[0] == expr.id)
            return "name", ".".join([alias.name if alias.asname else expr.id, *parts])
        return None

    def decoration(self, decorator):
        """What a decorator does for RF: ("keyword", literal name or None for the method's own name),
        ("not_keyword",), ("library", auto_keywords: a bool, or ... when computed), ("static",),
        ("property",) or ("safe",) for a standard class decorator; None when it is not read."""
        call = decorator if isinstance(decorator, ast.Call) else None
        target = decorator.func if call else decorator
        if isinstance(target, ast.Attribute) and target.attr in ("setter", "getter", "deleter") and not call \
                and isinstance(target.value, ast.Name):
            return ("property",)  # `@name.setter`: the property object `name` of the class body
        reference = self.reference(target)
        name = reference[1] if reference and reference[0] == "name" else None
        if name in ("robot.api.deco.keyword", "robot.api.deco.not_keyword", "robot.api.deco.library"):
            kind = name.rsplit(".", 1)[1]
            if kind == "not_keyword":
                return None if call else (kind,)
            if kind == "library":
                if not call:
                    return kind, False  # `@library` defaults to auto_keywords=False
                if any(k.arg is None for k in call.keywords) or any(isinstance(a, ast.Starred) for a in call.args):
                    return kind, ...
                # library(scope, version, converters, doc_format, listener, auto_keywords=False)
                value = call.args[5] if len(call.args) > 5 else \
                    next((k.value for k in call.keywords if k.arg == "auto_keywords"), None)
                if value is None:
                    return kind, False
                return kind, value.value if isinstance(value, ast.Constant) and isinstance(value.value, bool) else ...
            literal = (call.args[0] if call.args else next((k.value for k in call.keywords if k.arg == "name"), None)) \
                if call else None
            if call and (len(call.args) > 1 or any(k.arg is None for k in call.keywords)):
                return None
            if literal is None or isinstance(literal, ast.Constant) and literal.value is None:
                return kind, None
            return (kind, literal.value) if isinstance(literal, ast.Constant) and isinstance(literal.value, str) \
                else None
        if call:
            return ("safe",) if name in SAFE_CLASS_DECORATORS else None
        if name in ("builtins.staticmethod", "builtins.classmethod"):
            return ("static",) if name.endswith("staticmethod") else ("classmethod",)
        if name in ("builtins.property", "functools.cached_property"):
            return ("property",)
        return ("safe",) if name in SAFE_CLASS_DECORATORS else None

    def auto_attribute(self, cls, seen=()):
        """Whether class `cls` has RF's `ROBOT_AUTO_KEYWORDS` attribute (`@library`, a class-body
        assignment, a base class having it), which makes RF choose it as the module's library
        class; None when that cannot be known statically."""
        if cls in seen or cls.keywords:
            return None
        for decorator in cls.decorator_list:
            kind = self.decoration(decorator)
            if kind is not None and kind[0] == "library":
                return True
            if kind != ("safe",):
                return None
        if any(isinstance(n, ast.Name) and n.id == "ROBOT_AUTO_KEYWORDS" for n in ast.walk(cls)):
            return True
        result = False
        for base in cls.bases:
            reference = self.reference(base)
            if reference is not None and reference[0] == "class":
                inherited = self.auto_attribute(reference[1], (*seen, cls))
                if inherited:
                    return True
                result = None if inherited is None else result
            elif reference is None or not standard_name(reference[1]):
                result = None  # a base outside this module and Python's standard library
        return result

    def mro(self, cls, seen=()):
        """Python's method resolution order of `cls` (C3), when every base is a class of this module."""
        if cls in seen or cls.keywords:
            return None
        lists = []
        for base in cls.bases:
            reference = self.reference(base)
            if reference == ("name", "builtins.object"):
                continue
            if reference is None or reference[0] != "class":
                return None  # a base outside this module may have any attribute
            inherited = self.mro(reference[1], (*seen, cls))
            if inherited is None:
                return None
            lists.append(inherited)
        lists.append([self.reference(base)[1] for base in cls.bases if self.reference(base)[0] == "class"])
        result = [cls]
        while any(lists):
            head = next((candidate[0] for candidate in lists if candidate and
                         not any(candidate[0] in other[1:] for other in lists)), None)
            if head is None:
                return None  # Python refuses such a class
            result.append(head)
            lists = [candidate[1:] if candidate and candidate[0] is head else candidate for candidate in lists]
        return result


def literal_names(function):
    """The names a `get_keyword_names` method returns when its body is only `return [...]` (or a
    tuple) of string literals, after an optional docstring; else None."""
    body = function.body[1:] if ast.get_docstring(function) is not None else function.body
    if function.decorator_list or len(body) != 1 or not isinstance(body[0], ast.Return):
        return None
    value = body[0].value
    if isinstance(value, (ast.List, ast.Tuple)) and all(
            isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts):
        return list(value.elts)
    return None


def is_data(value):
    """A class attribute that is never a routine: a nested class or a literal value."""
    return value == "data" or isinstance(value, DATA_VALUES)


def class_reading(names, cls):
    """The keywords RF creates for library class `cls`: a static class library, a hybrid library
    (`get_keyword_names` only) or a dynamic library (`get_keyword_names` and `run_keyword`).

    Methods are read through Python's MRO over the classes of this module. A base class outside
    the module, an unread decorator, class-body code other than definitions and assignments, an
    attribute hook such as `__getattr__` and a computed `get_keyword_names` make `maybe` None. A
    public instance attribute (`self.step = ...`) and a computed class attribute may be a
    keyword: they stay in `maybe`."""
    from robot.utils import printable_name
    unknown = ModuleReading([], None)
    order = names.mro(cls)
    if order is None:
        return unknown
    attributes, instance, auto = {}, set(), None
    for klass in order:
        own = {}
        for decorator in klass.decorator_list:
            kind = names.decoration(decorator)
            if kind is None or kind[0] != "library":
                return unknown
            if auto is None:
                auto = kind[1]  # the decorator sets the attribute after the class body ran
        for statement in klass.body:
            if isinstance(statement, ast.Pass) or isinstance(statement, ast.Expr) and \
                    isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                continue
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                own[statement.name] = statement  # the last definition of a name wins, as in Python
            elif isinstance(statement, ast.ClassDef):
                own[statement.name] = "data"
            elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                if not all(isinstance(target, ast.Name) for target in targets):
                    return unknown
                if statement.value is not None:  # an annotation alone sets no attribute
                    own.update((target.id, statement.value) for target in targets)
            else:
                return unknown  # conditional definitions, imports, calls in the class body
        if auto is None and "ROBOT_AUTO_KEYWORDS" in own:
            value = own["ROBOT_AUTO_KEYWORDS"]
            auto = value.value if isinstance(value, ast.Constant) and isinstance(value.value, bool) else ...
        for name, value in own.items():
            attributes.setdefault(name, value)
        for function in (s for s in klass.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))):
            parameters = [*function.args.posonlyargs, *function.args.args]
            first = parameters[0].arg if parameters else None
            for node in ast.walk(function):
                if isinstance(node, ast.Name) and node.id in ("setattr", "delattr", "vars") or \
                        isinstance(node, ast.Attribute) and node.attr == "__dict__":
                    return unknown
                if isinstance(node, ast.Attribute) and not isinstance(node.ctx, ast.Load) and \
                        isinstance(node.value, ast.Name) and node.value.id == first:
                    instance.add(node.attr)  # `self.step = ...` in a method
    if OPEN_ATTRIBUTES & (attributes.keys() | instance) or "ROBOT_AUTO_KEYWORDS" in instance or auto is ...:
        return unknown
    # RF uses a dynamic API method only when the attribute is callable: data is no method.
    api = {name: attributes[name] for group in (GET_KEYWORD_NAMES, RUN_KEYWORD, GET_KEYWORD_ARGUMENTS)
           for name in group if name in attributes and not is_data(attributes[name])}
    if instance & {name for group in (GET_KEYWORD_NAMES, RUN_KEYWORD, GET_KEYWORD_ARGUMENTS) for name in group} \
            or any(not isinstance(value, ast.FunctionDef) for value in api.values()):
        return unknown  # a dynamic API method that is computed, assigned or replaced

    def method(group):
        return next((api[name] for name in group if name in api), None)
    getter = method(GET_KEYWORD_NAMES)
    if getter is not None:
        listed = literal_names(getter)
        if listed is None:
            return unknown
        unique, seen = [], set()
        for constant in listed:  # RF drops exact repetitions of a returned name
            if constant.value not in seen:
                seen.add(constant.value)
                unique.append(constant)
        runner = method(RUN_KEYWORD)
        if runner is not None:  # dynamic: every listed name is a keyword run through run_keyword
            if runner.decorator_list:
                return unknown
            # RF passes named arguments when run_keyword takes (name, args, kwargs).
            positional = len([*runner.args.posonlyargs, *runner.args.args]) - 1
            named = None if method(GET_KEYWORD_ARGUMENTS) is not None else positional == 3
            return without_duplicates([(constant, constant.value) for constant in unique], set(), named=named)
        keywords, bound = [], set()  # hybrid: listed names are methods, created as by the static API
        for constant in unique:
            name = constant.value
            value = attributes.get(name)
            if name in instance or value is not None and not is_data(value) and \
                    not isinstance(value, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return unknown
            if value is None or is_data(value):
                continue  # RF reports that it cannot get the method: no keyword
            kinds = [names.decoration(d) for d in value.decorator_list]
            if None in kinds or ("property",) in kinds or ("safe",) in kinds:
                return unknown
            if ("not_keyword",) in kinds:
                continue
            given = next((kind[1] for kind in kinds if kind[0] == "keyword"), None)
            keywords.append((value, given or printable_name(name, code_style=True)))
            if ("static",) not in kinds:
                bound.add(id(value))
        return without_duplicates(keywords, set(), bound=bound)
    auto = True if auto is None else auto
    keywords, maybe, bound, opened = [], set(), set(), False
    for name in sorted(attributes.keys() | instance):
        value = attributes.get(name)
        if is_data(value) and name not in instance:
            continue
        if name in instance or not isinstance(value, (ast.FunctionDef, ast.AsyncFunctionDef)):
            opened = True  # an instance attribute or a computed class attribute may be a routine
            if auto and not name.startswith("_"):
                maybe.add(normalize(printable_name(name, code_style=True)))
            continue
        kinds = [names.decoration(d) for d in value.decorator_list]
        given = next((kind for kind in kinds if kind is not None and kind[0] == "keyword"), None)
        if None in kinds or ("safe",) in kinds or given is not None and kinds[-1] is not given:
            # Unread, or `@keyword` above `@staticmethod` (RF reads the name on the function).
            opened = True
            maybe.add(normalize(printable_name(name, code_style=True)))
            if given is not None and given[1]:
                maybe.add(normalize(given[1]))
            continue
        if ("not_keyword",) in kinds or ("property",) in kinds:
            continue
        if given is None and not (auto and not name.startswith("_")):
            continue
        keywords.append((value, given[1] if given and given[1] else printable_name(name, code_style=True)))
        if ("static",) not in kinds:
            bound.add(id(value))
    if opened:
        # An unread routine may be a module-level `@keyword("Name")` function of this module.
        maybe |= {normalize(kind[1]) for node, in_class in import_time(names.tree)
                  if not in_class and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                  for decorator in node.decorator_list
                  if (kind := names.decoration(decorator)) and kind[0] == "keyword" and kind[1]}
    return without_duplicates(keywords, maybe, bound=bound)


def without_duplicates(keywords, maybe, **details):
    """RF's duplicate rule: two keywords of one library with one normalized name both fail, so
    neither is indexed; one that another unread name may also expose is not indexed either."""
    counts = {}
    for _, name in keywords:
        counts[normalize(name)] = counts.get(normalize(name), 0) + 1
    duplicates = {key for key, count in counts.items() if count > 1} | ({normalize(n) for _, n in keywords} & maybe)
    keywords = sorted(((node, name) for node, name in keywords if normalize(name) not in duplicates),
                      key=lambda pair: (pair[0].lineno, pair[0].col_offset))
    details.setdefault("bound", set())
    return ModuleReading(keywords, maybe | duplicates, frozenset(details["bound"]), details.get("named"))


def library_reading(tree, name, required=False):
    """The keywords of the library RF imports from a module (robot.utils.importer): the class of
    the module's own name, else the one class with RF's `ROBOT_AUTO_KEYWORDS` attribute (such as a
    `@library` class), else the module itself. `required` (an import `module.ClassName`): the
    module must define `name`; RF's error otherwise is raised as ValueError."""
    names = ModuleNames(tree)
    bound = names.bindings.get(name, [])
    node = names.only(name)
    if isinstance(node, ast.ClassDef) and node in tree.body:
        return class_reading(names, node)
    if any(isinstance(n, ast.ClassDef) for n in bound) or required and names.star:
        return ModuleReading([], None)
    if required:
        if not bound:
            raise ValueError(f"Module does not contain '{name}'.")
        if all(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) for n in bound):
            raise ValueError("Expected class or module, got function.")
        return ModuleReading([], None)
    classes = [node for node, in_class in import_time(tree) if isinstance(node, ast.ClassDef) and not in_class]
    states = [(node, names.auto_attribute(node)) for node in classes]
    chosen = [node for node, state in states if state]
    if any(state is None for _, state in states):
        return ModuleReading(module_reading(tree, name).keywords, None)
    if len(chosen) == 1:
        if chosen[0] in tree.body and names.only(chosen[0].name) is chosen[0]:
            return class_reading(names, chosen[0])
        return ModuleReading(module_reading(tree, name).keywords, None)
    return module_reading(tree, name)  # several library classes: RF uses the module


def standard_symbols(name):
    """RF standard-library keywords from RF's own libdoc; Remote exists only at run time."""
    if name not in STANDARD_CACHE:
        symbols = []
        if name != "Remote":
            from robot.libdocpkg import LibraryDocumentation
            try:
                with redirect_stdout(sys.stderr), without_working_directory():  # stdout is the protocol
                    library = LibraryDocumentation(name)
            except Exception as exc:  # e.g. Dialogs without Tk, Telnet on Python 3.13 (Python 3.11 still has telnetlib)
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
        self.readings = {}
        self.roots = []  # workspace folders from initialize; scanned again for every request
        self.config = project.EMPTY  # the folder's Robot configuration (see project.py)
        self.variable_files = {}  # (path, arguments) -> (text, VariableFile) last read
        self.sources = Sources()  # current source and reusable syntax, never a resolved namespace

    def run_folder(self):
        return self.config.cwd or (self.roots[0] if self.roots else None)

    def search_path(self):
        """Where RF finds module names and, after the importing file's folder, relative import
        paths: the configured `--pythonpath` entries, then the folder Robot runs in (on
        `sys.path` with `python -m robot` and in the native debug worker). Installed packages
        are not searched."""
        folder = self.run_folder()
        return [*self.config.python_path, *([folder] if folder and folder not in self.config.python_path else [])]

    def exists(self, path):
        return path.resolve() in self.documents or project.valid_file(path)

    def variable_file(self, name, basedir, args=()):
        """The variable file RF would import for `name` (a path or a module name), read
        statically; None when it is not found."""
        search = self.search_path()
        if name.lower().endswith(project.VARIABLES_BY_PATH_ENDS):
            found = project.find_file(name, basedir, search, self.exists)
        else:
            found = project.module_file(name, search, lambda p: p.resolve() in self.documents or p.is_file())
        if found is None:
            return None
        if found.is_dir():
            found = found / "__init__.py"
        text = self.text(found)
        cached = self.variable_files.get((found, args))
        if cached is None or cached[0] != text:  # read again whenever the text changed
            cached = self.variable_files[(found, args)] = (text, project.read_variable_file(found, text, args))
        return cached[1]

    def file_symbols(self, variables):
        return [Symbol(v.name, variables.path, v.line, v.column, v.length, v.text, kind="variablefile",
                       value=None if v.value is project.UNKNOWN else (v.value,)) for v in variables.variables]

    def configured_variables(self):
        """(symbols, complete, problems) of the configuration's `--variable` and `--variablefile`
        options, in RF's precedence: command-line variables, then the variable files in order."""
        places = self.config.places or (None,) * len(self.config.variables)
        symbols = [self.configured_symbol(name, value, typed, place)
                   for (name, value, typed), place in zip(self.config.variables, places)]
        complete, problems = True, list(self.config.errors)
        for name, args in self.config.variable_files:
            try:
                found = self.variable_file(name, self.config.cwd, args)
            except (OSError, UnicodeError) as exc:
                found, problem = None, f"cannot be read: {exc}"
            else:
                problem = "not found" if found is None else found.problem
            if found is not None:
                symbols += self.file_symbols(found)
            if found is None or not found.complete:
                complete = False
                problems.append(f"--variablefile {name}: {problem}")
        return symbols, complete, problems

    def configured_symbol(self, name, value, typed, place):
        """A command-line variable; one from robot.toml's `[variables]` has its definition there."""
        text = ""
        if place is not None:
            try:
                lines = self.text(place.path).splitlines()
                text = lines[place.line] if place.line < len(lines) else ""
            except (OSError, UnicodeError):
                place = None
        return Symbol(f"${{{name}}}", place.path if place else None, place.line if place else 0,
                      place.column if place else 0, place.length if place else 0, text, kind="cli",
                      value=(value,), owner=typed or "")

    def workspace_files(self, extra=(), suffixes=ROBOT_SUFFIXES):
        """Robot files on disk under the roots, open Robot documents and `extra`, sorted.

        Hidden directories, node_modules and __pycache__ are skipped; symlinked
        directories and Windows junctions are not followed. Nothing is cached, so created, changed and
        deleted files are seen on the next request. With RF 7.5 these include `.robot.md` suites and
        the `.md`/`.markdown` files a Robot file imports as a resource, resolved as RF resolves it."""
        found = {path for path in [*self.documents, *extra] if path.suffix in suffixes}
        candidates = {path for path in [*self.documents, *extra] if suffixes == ROBOT_SUFFIXES and markdown.is_markdown(path)}
        for root in self.roots:
            for directory, names, files in os.walk(root):
                checkpoint()
                names[:] = [n for n in names if not n.startswith(".") and n not in SKIPPED_DIRECTORIES
                            and not is_link(os.path.join(directory, n))]
                found.update(Path(directory, f).resolve() for f in files if f.endswith(suffixes))
                if suffixes == ROBOT_SUFFIXES:
                    candidates.update(Path(directory, f).resolve() for f in files if markdown.is_markdown(Path(f)))
        if markdown.supported() and candidates:
            found |= {path for path in candidates if markdown.is_suite_name(path)}
            found |= self.markdown_resources(found, candidates - found)
        return sorted(found)

    def markdown_resources(self, robot_files, candidates, follow=True):
        """The Markdown candidates a `Resource` setting of the Robot files imports, found as RF
        finds a resource: the name with `${CURDIR}` and the configured command-line variables
        replaced, absolute as given, else next to the importing file, then along the python path
        (`--pythonpath`, robot.toml's `python-path`) and the run folder. A candidate is matched by
        file identity, so another file with the same name (a root README.md when docs/README.md
        is imported) is never one. With `follow`, the imports of Markdown resources found so
        count too (RF 7.5 parses those as resources). An import whose name needs a value known
        only at run time matches nothing."""
        from robot.utils import normalize as normalized
        from robot.variables import search_variable
        keys = {file_key(candidate): candidate for candidate in candidates}
        configured = {normalized(name, ignore="_"): value for name, value, _ in self.config.variables}
        search = self.search_path()
        pending, result = list(robot_files), set()
        while pending:
            path = pending.pop()
            try:
                imports = resource_imports(self.text(path))
            except (OSError, UnicodeError):
                continue
            for written in imports:
                name = written  # variables are replaced only where there are any, as in graph()
                if search_variable(written, ignore_errors=True).start >= 0 or "%{" in written:
                    name = project.substitute(written, lambda key: str(path.parent) if key == "curdir"
                                              else configured.get(key))
                found = project.find_file(name, path.parent, search, self.exists) if name else None
                target = keys.get(file_key(found)) if found is not None else None
                if target is not None and target not in result:
                    result.add(target)
                    if follow:
                        pending.append(target)
        return result

    def imported_markdown(self, path):
        """Whether a workspace `.robot`/`.resource` file imports the Markdown file `path` as a
        resource, resolved as `markdown_resources` does (RF 7.3.2's not-read warning)."""
        return bool(self.markdown_resources([f for f in self.workspace_files() if f.suffix in ROBOT_SUFFIXES],
                                            {path}, follow=False))

    def is_robot_source(self, path):
        """Whether the services read `path` as Robot data: `.robot`/`.resource`, and with RF 7.5 a
        Markdown suite or a Markdown file some workspace Robot file imports as a resource."""
        if path.suffix in ROBOT_SUFFIXES:
            return True
        if not markdown.is_markdown(path) or not markdown.supported():
            return False
        return markdown.is_suite_name(path) or path in self.workspace_files([path])

    def to_editor(self, value, uri=None):
        """A result with each position in a Markdown file moved back by the indentation RF's
        dedent removed from that line (a `uri`/`targetUri`/`textDocument.uri` names the file of
        the positions below it; `uri` is the request's document)."""
        views = {}

        def view_of(document):
            if document not in views:
                try:
                    path = uri_path(document)
                except ValueError:
                    path = None
                views[document] = self.markdown_view(path) if path is not None and markdown.is_markdown(path) \
                    and (path in self.documents or path.is_file()) else None
            return views[document]

        def walk(value, document):
            if isinstance(value, list):
                return [walk(item, document) for item in value]
            if not isinstance(value, dict):
                return value
            if value.keys() == {"line", "character"}:
                view = view_of(document) if isinstance(document, str) else None
                offset = view.offset(value["line"]) if view and isinstance(value["line"], int) else None
                return {"line": value["line"], "character": value["character"] + offset} if offset else value
            if isinstance(value.get("targetUri"), str):  # a LocationLink's origin is in the request document
                return {key: walk(item, document if key == "originSelectionRange" else value["targetUri"])
                        for key, item in value.items()}
            own = value.get("uri") if isinstance(value.get("uri"), str) else None
            if own is None and isinstance(value.get("textDocument"), dict):
                own = value["textDocument"].get("uri")
            result = {}
            for key, item in value.items():
                if key == "changes" and isinstance(item, dict):  # WorkspaceEdit: edits per document URI
                    result[key] = {target: walk(edits, target) for target, edits in item.items()}
                else:
                    result[key] = walk(item, own or document)
            return result
        return walk(value, uri)

    def source_snapshot(self):
        return self.sources.snapshot()

    def source(self, path):
        return self.sources.read(path, lambda: self.documents[path][1] if path in self.documents
                                 else path.read_text(encoding="utf-8"))

    def markdown_view(self, path):
        """The Robot view of the same current source used by the other language features."""
        source = self.source(path)
        if source.markdown_view is None:
            source.markdown_view = markdown.view(source.text)
        return source.markdown_view

    def exists(self, path):
        checkpoint()
        return path in self.documents or path.is_file()

    def open(self, uri, text, version):
        path = uri_path(uri)
        old = self.documents.get(path)
        if old and version <= old[0]:
            raise ValueError("Document version must increase")
        self.documents[path] = (version, text)
        self.sources.forget_current(path)

    def version(self, uri):
        """The version of an open document, None for a file read from disk."""
        entry = self.documents.get(uri_path(uri))
        return entry[0] if entry else None

    def close(self, uri):
        path = uri_path(uri)
        self.documents.pop(path, None)
        self.sources.forget_current(path)

    def text(self, path):
        """A file's current text; for a Markdown file its line-preserving Robot view."""
        if markdown.is_markdown(path):
            return self.markdown_view(path).text
        return self.source(path).text

    @snapshot
    def model(self, path):
        from robot.api import get_model
        source = self.source(path)
        if source.robot_model is None:
            source.robot_model = get_model(StringIO(self.text(path) if markdown.is_markdown(path) else source.text))
        return source.robot_model

    @staticmethod
    def walk(node, owner=None):
        checkpoint()
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
        source = self.source(path)
        if source.lines is None:
            source.lines = tuple(self.text(path).splitlines())
        return Symbol(name, path, line - 1, column, len(name), source.lines[line - 1], namespace, **metadata)

    @snapshot
    def library_reading(self, path, name=None, required=False):
        """`library_reading` of a local .py library's current text, for RF's import `name` (the
        file's stem by default); its code is read, never run."""
        source = self.source(path)
        key = (path.stem if name is None else name, required)
        if key not in source.library_readings:
            source.library_readings[key] = library_reading(self.python_tree(path), *key)
            while len(source.library_readings) > MAX_LIBRARY_READINGS:
                source.library_readings.popitem(last=False)
        source.library_readings.move_to_end(key)
        from .source_declarations import augment
        return augment(self, path, key[0], source.library_readings[key])

    def python_tree(self, path):
        source = self.source(path)
        if source.python_tree is None:
            source.python_tree = ast.parse(source.text, filename=str(path))
        return source.python_tree

    def python_module(self, directory, name):
        """What Python's path finder takes for the module `name` in `directory`, read but never run:
        ("package", its __init__.py), ("module", name.py), ("namespace", the directory), ("compiled",
        file) for code that is not read, or None. A regular package beats a module and a module beats
        a directory without __init__, which is a namespace package only when no search path location
        has a package or module of that name (importlib FileFinder/PathFinder)."""
        checkpoint()
        folder = (directory / name).resolve()
        # An open editor's unsaved file counts, also in a directory not yet created on disk.
        is_dir = folder.is_dir() or any(folder in path.parents for path in self.documents)
        if is_dir:
            for suffix, source in MODULE_SUFFIXES:
                if self.exists(init := folder / f"__init__{suffix}"):
                    return ("package" if source else "compiled"), init
        for suffix, source in MODULE_SUFFIXES:
            if self.exists(module := (directory / f"{name}{suffix}").resolve()):
                return ("module" if source else "compiled"), module
        return ("namespace", folder) if is_dir else None

    def python_library(self, directory, name):
        """(file, selector, required) of the code RF's importer (robot.utils.importer) takes for the
        library module name `name` when `directory` is the search path location of its first part:
        that module, or for `parent.name` the parent's attribute `name` (`required`, read with
        `library_reading`) or else its submodule `name`. None when the code is not found there, since
        sys.path/--pythonpath are not modelled, or cannot be read; ValueError for RF's import error."""
        parts = name.split(".")
        if "" in parts:
            return None
        *parents, last = parts
        if not parents:
            found = self.python_module(directory, name)
            return (found[1], name, False) if found and found[0] in ("package", "module") else None
        kind, place = "namespace", directory
        for index, part in enumerate(parents):
            if kind == "module":
                raise ValueError(f"No module named '{'.'.join(parents[:index + 1])}'; "
                                 f"'{'.'.join(parents[:index])}' is not a package")
            if kind == "package" and self.extends_path(place):
                return None
            found = self.python_module(place.parent if kind == "package" else place, part)
            if found is None or found[0] == "compiled":
                return None
            kind, place = found
        if kind == "module":
            return place, last, True
        if kind == "package":
            # `from parent import name` takes a name the package's __init__ binds before a submodule.
            try:
                names = ModuleNames(self.python_tree(place))
            except (OSError, SyntaxError, UnicodeError, ValueError, RecursionError):
                return place, last, True  # its reading reports why it cannot be imported
            if "__getattr__" in names.bindings:
                return None  # a computed attribute
            node = names.only(last)
            if isinstance(node, ast.ImportFrom) and node.level == 1:
                return None if self.extends_path(place) else self.relative_library(place.parent, node, last)
            if last in names.bindings or names.star:
                return place, last, True
            if self.extends_path(place):
                return None
        found = self.python_module(place.parent if kind == "package" else place, last)
        if found and found[0] in ("package", "module"):
            return found[1], last, False
        if kind == "package" and found is None:
            return place, last, True  # neither attribute nor submodule: RF's "does not contain"
        return None  # a namespace's other portions may be elsewhere on the search path

    def installed_library(self, name, directories=None):
        """`python_library` for a module name found on `search_path()` instead of the importing
        file's directory: the first location with a regular package or module of its first part
        wins, as in Python's path finder, else the namespace portions in order. Read, never run."""
        if "" in name.split("."):
            return None
        first = name.split(".")[0]
        namespaces = []
        for directory in search_path() if directories is None else directories:
            found = self.python_module(directory, first)
            if found is None:
                continue
            if found[0] == "namespace":
                namespaces.append(directory)
                continue
            return self.python_library(directory, name)
        for directory in namespaces:
            if (library := self.python_library(directory, name)) is not None:
                return library
        return None

    @staticmethod
    def installed(path):
        """The install location (site-packages or standard library) of the interpreter running the
        service that holds `path`, or None. Other sys.path entries, such as a project's own source
        directory on PYTHONPATH, are not install locations."""
        import site
        import sysconfig
        paths = sysconfig.get_paths()
        places = [paths.get(name) for name in ("purelib", "platlib", "stdlib", "platstdlib")]
        places += site.getsitepackages() if hasattr(site, "getsitepackages") else []
        for place in places:
            if place and os.path.isdir(place) and path.is_relative_to(directory := Path(place).resolve()):
                return directory
        return None

    def extends_path(self, init):
        """Whether a package's __init__ mentions `__path__` at all (assigns, appends to or extends
        it, also through pkgutil): its submodules may then come from anywhere, so they are unknown."""
        try:
            return "__path__" in self.text(init)
        except (OSError, UnicodeError):
            return False  # reading the package reports the problem

    def relative_library(self, package, node, last):
        """`python_library` for the name `last` that a package's __init__ binds with a relative
        import: `from . import Tools` (that submodule) or `from .tools import Tools` (that name of
        the package's module tools.py). None for any other form."""
        alias = next(a for a in node.names if (a.asname or a.name) == last)
        found = self.python_module(package, node.module or alias.name) if "." not in (node.module or "") else None
        if not found or found[0] not in ("package", "module"):
            return None
        if node.module is None:
            return found[1], last, False
        try:
            bound = alias.name in ModuleNames(self.python_tree(found[1])).bindings
        except (OSError, SyntaxError, UnicodeError, ValueError, RecursionError):
            return None
        return (found[1], alias.name, True) if found[0] == "module" and bound else None

    @snapshot
    def python_symbols(self, path, namespace, reading=None):
        """Keywords of an explicitly imported local .py library, read with `library_reading`."""
        text = self.text(path)
        lines = re.split(r"\r\n|\r|\n", text)  # Python's line breaks, not str.splitlines()
        symbols = []
        reading = reading or self.library_reading(path)
        for node, name in reading.keywords:
            # Python AST columns are UTF-8 bytes, LSP columns are UTF-16 units.
            line = lines[node.lineno - 1]
            prefix = len(line.encode("utf-8")[:node.col_offset].decode("utf-8"))
            if isinstance(node, ast.Constant):
                # A dynamic library's keyword: its name in the `get_keyword_names` list.
                segment = ast.get_source_segment(text, node) or ""
                simple = segment[:1] in ("'", '"') and segment[1:-1] == node.value
                column, length = (prefix + 1, len(node.value)) if simple else \
                    (prefix, len(segment.splitlines()[0]) if segment else 0)
                args = None if reading.named is None else argument_spec(
                    name, var_positional="varargs", var_named="kwargs" if reading.named else None)
                symbols.append(Symbol(name, path, node.lineno - 1, column, length, line, namespace,
                                      kind="library", args=args))
                continue
            header = re.match(r"(?:async\s+)?def\s+", line[prefix:])
            if header is None:
                raise ValueError("Cannot locate Python function header")
            column = prefix + header.end()
            symbols.append(Symbol(name, path, node.lineno - 1, column, len(node.name), line, namespace,
                                  kind="library", args=python_arguments(node, name, id(node) in reading.bound),
                                  doc=ast.get_docstring(node) or "", declaration=id(node) in reading.declarations))
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

    @snapshot
    def graph(self, root):
        """The root file's namespace as RF builds it: each file's Variables section first, then
        its imports in order (a resource's own imports when it is imported). Import names are
        resolved with the variables known at that point; a library name RF has already imported
        makes it ignore the later import."""
        from robot.libraries import STDLIBS  # RF's standard library name set
        from robot.variables import search_variable
        local, resources, libraries, standard, problems, imports, notes = [], [], [], [], [], [], []
        own_variables, imported_variables = [], []
        visited = set()
        read = set()  # resources read without an error
        self.edges = {}
        self.readings = {}  # library path -> its ModuleReading for each import, as RF chose its code

        def add_standard(name, namespace, importer=None, line=None, alias=None):
            if not any(s.namespace == namespace for s in standard):
                standard.extend(replace(s, namespace=namespace) for s in standard_symbols(name))
            # Every import statement is recorded; RF uses one library instance for all of them.
            imports.append(Import("standard", name, alias, namespace, None, importer, line,
                                  tuple(s for s in standard if s.namespace == namespace)))
        search = self.search_path()
        configured, configured_complete, _ = self.configured_variables()
        state = {"open": not configured_complete}
        # Library names the suite has imported (RF's KeywordStore.libraries); BuiltIn comes first.
        imported = {"BuiltIn": ("BuiltIn", (), None, 0)}

        def value(symbol, pending):
            if symbol.kind == "cli":
                return symbol.value[0]
            if symbol.kind == "variablefile":
                return project.scalar(symbol.value[0]) if symbol.value else None
            if symbol.kind != "suite" or symbol.name[0] != "$" or len(symbol.value or ()) != 1 \
                    or id(symbol) in pending:
                return None  # a list, dictionary or several cells, or a cycle
            return project.substitute(symbol.value[0], lookup(symbol.path, pending | {id(symbol)}))

        def lookup(path, pending=frozenset()):
            """RF's variable precedence when `path`'s imports are processed."""
            def find(key):
                if key == "curdir":
                    return str(path.parent)  # replaced when the file is parsed
                for symbol in configured:
                    if variable_base(symbol.name[2:-1]) == key:
                        return value(symbol, pending)
                if not configured_complete:
                    return None  # an unread command-line variable file may define it
                for symbol in [*own_variables, *imported_variables]:
                    if variable_base(symbol.name[2:-1]) == key:
                        return value(symbol, pending)
                if state["open"]:
                    return None
                return str(self.config.cwd) if key == "execdir" and self.config.cwd else None
            return find

        def library_name(path, node, namespace, identity):
            """RF keeps the first library imported under a name and ignores later ones."""
            arguments = tuple(node.args)
            if namespace not in imported:
                imported[namespace] = (identity, arguments, path, node.lineno)
                return True
            first, first_arguments, where, line = imported[namespace]
            if (first, first_arguments) == (identity, arguments):
                # RF shares the original instance; the explorer still needs every import site.
                original = next((entry for entry in imports if entry is not None
                                 and entry.namespace == namespace and entry.kind in ("library", "standard")), None)
                if original is not None:
                    imports.append(replace(original, importer=path, line=node.lineno, name=node.name, alias=node.alias))
                return False  # the same import again: RF only logs it
            at = f"line {line}" if where == path else f"{where.name}, line {line}" if where else "implicitly"
            message = f"Another library named '{namespace}' is already imported ({at}). " \
                if first != identity else f"Library '{namespace}' is already imported with other arguments ({at}). "
            # RF 7.5 warns; RF 7.3.2 logs the ignored import at INFO level only.
            notes.append((path, node.lineno, message + "Robot Framework ignores this import.",
                          INFORMATION if robot_version() == "7.3.2" else WARNING))
            return False

        def visit(path, primary=False):
            if path in visited:
                return
            visited.add(path)
            self.edges[path] = []
            model = self.model(path)
            nodes = [node for node, _ in self.walk(model)]
            for node in nodes:  # RF sets a file's Variables section before its imports
                if type(node).__name__ == "Variable" and (variable := self.suite_variable(path, node)):
                    (own_variables if primary else imported_variables).append(variable)
            for node in nodes:
                kind = type(node).__name__
                if kind == "Keyword":
                    (local if primary else resources).append(self.keyword_symbol(path, node, primary))
                if kind not in ("ResourceImport", "LibraryImport", "VariablesImport"):
                    continue
                written = node.name
                if not written:
                    problems.append((path, node.lineno, "Unresolved dynamic import", ERROR))
                    continue
                name = written
                if search_variable(written, ignore_errors=True).start >= 0 or "%{" in written:
                    name = project.substitute(written, lookup(path))
                    if name is None:
                        problems.append((path, node.lineno, f"Import not resolved before the run: {written} uses a "
                                         "variable whose value is known only when Robot Framework runs.", INFORMATION))
                        continue
                if kind == "VariablesImport":
                    self.import_variables(path, node, name, problems, notes, imported_variables, state)
                    continue
                by_path = kind == "ResourceImport" or name.lower().endswith(project.IMPORT_BY_PATH_ENDS)
                if not by_path:
                    if name in STDLIBS:
                        # RF imports these as robot.libraries.<name>, ahead of any module on the path.
                        if library_name(path, node, node.alias or name, name):
                            add_standard(name, node.alias or name, path, node.lineno, node.alias)
                        continue
                    try:
                        library = self.installed_library(name, [*search, *search_path()])
                    except ValueError as exc:
                        problems.append((path, node.lineno, f"Unresolved {kind}: {name}: {exc}", ERROR))
                        continue
                    if library is None:
                        problems.append((path, node.lineno, f"Library not resolved in this version: {name}", INFORMATION))
                        continue
                    candidate, selector, required = library
                else:
                    selector, required = Path(name.rstrip("/\\")).stem, False
                    candidate = project.find_file(name, path.parent, search, self.exists) or path.parent / name
                    if kind == "LibraryImport" and candidate.is_dir():
                        candidate = candidate / "__init__.py"
                candidate = candidate.resolve()
                # RF finds the file first, then refuses an extension it does not read.
                if kind == "ResourceImport" and self.exists(candidate) and \
                        (refused := resource_extension_error(candidate)):
                    problems.append((path, node.lineno, refused, ERROR))
                    continue
                if kind == "LibraryImport":
                    # RF names a path import by its file (or package) name, a module import by its full name.
                    namespace = node.alias or (Path(name.rstrip("/\\")).stem if by_path else name)
                    if not library_name(path, node, namespace, candidate):
                        continue
                self.edges[path].append(candidate)
                try:
                    if kind == "ResourceImport":
                        if candidate not in visited:  # listed before the resources it imports
                            index = len(imports)
                            imports.append(None)  # stays None when reading the resource fails
                            visit(candidate)
                            imports[index] = Import("resource", name, None, candidate.stem, candidate, path,
                                                    node.lineno, tuple(s for s in resources if s.path == candidate))
                            read.add(candidate)
                        elif candidate != root:
                            # A repeated import of a resource read once: one more import site.
                            imports.append(Import("resource", name, None, candidate.stem, candidate, path,
                                                  node.lineno, ()))
                    else:
                        reading = self.library_reading(candidate, selector, required)
                        self.readings.setdefault(candidate, []).append(reading)
                        symbols = self.python_symbols(candidate, namespace, reading)
                        libraries.extend(symbols)
                        imports.append(Import("library", name, node.alias, namespace, candidate, path, node.lineno,
                                              tuple(symbols)))
                except (OSError, SyntaxError, UnicodeError, ValueError, RecursionError) as exc:
                    problems.append((path, node.lineno, f"Unresolved {kind}: {written}: {exc}", ERROR))
            return model

        model = visit(root, True)
        add_standard("BuiltIn", "BuiltIn")  # implicitly imported by every Robot file
        return Graph(model, (local, resources, libraries, standard), problems, own_variables + imported_variables,
                     [entry for entry in imports
                      if entry is not None and (entry.kind != "resource" or entry.path in read)],
                     configured, list(self.edges), state["open"], notes)

    def import_variables(self, path, node, name, problems, notes, variables, state):
        """A `Variables` import: its file is read statically, never run. A file whose variables
        cannot all be read hides only variables (`state["open"]`), never keywords."""
        arguments = tuple(node.args)
        try:
            found = self.variable_file(name, path.parent, arguments)
        except (OSError, UnicodeError) as exc:
            problems.append((path, node.lineno, f"Unresolved VariablesImport: {node.name}: {exc}", ERROR))
            return
        if found is None:
            by_path = name.lower().endswith(project.VARIABLES_BY_PATH_ENDS)
            if by_path:
                problems.append((path, node.lineno, f"Unresolved VariablesImport: {node.name}: "
                                 f"Variable file '{name}' does not exist.", ERROR))
            else:
                state["open"] = True
                notes.append((path, node.lineno, f"Variable file not resolved in this version: {name}", INFORMATION))
            return
        variables.extend(self.file_symbols(found))
        if not found.complete:
            state["open"] = True
            notes.append((path, node.lineno, f"Variable file {found.path.name} is not read completely: "
                          f"{found.problem}.", INFORMATION))

    @staticmethod
    def matches(symbol, name):
        checkpoint()
        if normalize(symbol.name) == normalize(name):
            return True
        if "${" in symbol.name:
            from robot.errors import DataError
            from robot.running.arguments.embedded import EmbeddedArguments
            try:
                embedded = EmbeddedArguments.from_name(symbol.name)
            except DataError:
                return False  # an invalid embedded pattern (`${x:[}`) matches nothing, as when RF runs
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
                # Two imports of one library under different names are two libraries for RF.
                return list({(s.path, s.line, s.column, s.namespace): (s, offset) for s, offset in found}.values())
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

    def calls(self, groups, node, extra=()):
        """The keyword calls of one statement: its keyword cell and, when that resolves like any
        call to a BuiltIn run-keyword variant, each keyword name argument it runs, also nested
        (`Run Keyword If    ${x}    Step    a    ELSE    Run Keyword    Other`). `extra` cells
        follow the statement's own arguments (a cell the user is typing)."""
        tokens = getattr(node, "tokens", ())
        head = next((t for t in tokens if self.keyword_cell(node, t)), None)
        if head is None:
            return []
        found = []
        pending = [(head, [*(t for t in tokens if t.type == "ARGUMENT"), *extra], False, False)]
        while pending:
            head, cells, indirect, caught = pending.pop(0)
            found.append(Call(head, tuple(cells), indirect, caught))
            variant, runs = self.run_groups(groups, head.value, cells)
            pending += [(group[0], group[1:], True, caught or variant in CATCHING) for group in runs]
        return found

    def call_at(self, groups, node, token):
        return next((call for call in self.calls(groups, node) if call.token is token), None)

    def run_groups(self, groups, name, cells):
        """(normalized variant name, [[name cell, argument cells...]]) of the keywords a BuiltIn
        run-keyword variant runs, split as RF splits them; a list variable before a name hides
        where it is. ("", []) for any other keyword."""
        pairs = self.resolve_call(groups, name)
        symbol = pairs[0][0] if len(pairs) == 1 else None
        if symbol is None or symbol.kind != "standard" or symbol.path is None or symbol.path.stem != "BuiltIn":
            return "", []
        variant = normalize(symbol.name)
        return variant, self.split_runs(variant, cells)

    @staticmethod
    def split_runs(variant, cells):
        from robot.variables import is_list_variable
        listed = {id(cell) for cell in cells if is_list_variable(cell.value)}
        if variant in RUN_VARIANTS:
            before = RUN_VARIANTS[variant]
            if len(cells) <= before or any(id(cell) in listed for cell in cells[:before + 1]):
                return []
            return [list(cells[before:])]
        if variant == RUN_KEYWORDS:
            if all(cell.value != "AND" for cell in cells):
                return [[cell] for cell in cells if id(cell) not in listed]  # each argument is a keyword
            result, group = [], []
            for cell in [*cells, None]:
                if cell is None or cell.value == "AND":
                    if group and id(group[0]) not in listed:
                        result.append(group)
                    group = []
                else:
                    group.append(cell)
            return result
        if variant != RUN_KEYWORD_IF:
            return []
        result = []
        while len(cells) >= 2 and not any(id(cell) in listed for cell in cells[:2]):
            name, rest = cells[1], list(cells[2:])
            values = [cell.value for cell in rest]
            if "ELSE IF" in values:  # RF splits the first ELSE IF before any ELSE
                index = values.index("ELSE IF")
                result.append([name, *rest[:index]])
                cells = rest[index + 1:]
                continue
            if "ELSE" in values:
                index = values.index("ELSE")
                result.append([name, *rest[:index]])
                branch = rest[index + 1:]
                if branch and id(branch[0]) not in listed:
                    result.append(branch)
                break
            result.append([name, *rest])
            break
        return result

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
            scope = ""
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
                        scope = var_scope(node)
                    elif kind in ("ForHeader", "ExceptHeader"):
                        role, value = kind.removesuffix("Header").lower(), None
                    else:
                        role, value = "assign", (node.keyword,) if getattr(node, "keyword", None) else None
                    found.append(self.symbol(path, match[0], token.lineno, token.col_offset + match.start(),
                                             kind=role, value=value, owner=label, scope=scope))
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

    def builtin_variables(self, path):
        folder = self.run_folder()
        result = [Symbol("${CURDIR}", None, 0, 0, 0, "", kind="builtin", value=(str(path.parent),))]
        result += [Symbol(name, None, 0, 0, 0, "", kind="builtin", value=(value,))
                   for name, value in STATIC_BUILTINS.items()]
        runtime = RUNTIME_BUILTINS if robot_version() == "7.3.2" else RUNTIME_BUILTINS + RUNTIME_BUILTINS_7_5
        result += [Symbol(name, None, 0, 0, 0, "", kind="builtin",
                          value=(str(folder),) if name == "${EXECDIR}" and self.config.cwd else None)
                   for name in runtime]
        return result

    def scoped_definitions(self, graph, wanted):
        """Where the suite's tests and keywords set `wanted` with a non-local scope: `VAR` with
        scope=TEST/TASK/SUITE/SUITES/GLOBAL and BuiltIn's Set Test/Task/Suite/Global Variable
        with a literal name. Such a variable exists only after that step has run."""
        found = []
        for path in graph.files:
            try:
                model = self.model(path)
            except (OSError, UnicodeError):
                continue
            for node, owner in self.walk(model):
                kind = type(node).__name__
                label = f"{'keyword' if type(owner).__name__ == 'Keyword' else 'test'} {owner.name}" if owner else ""
                if kind == "Var" and var_scope(node) not in ("", "LOCAL"):
                    token = node.get_token("VARIABLE")
                    how, scope = "VAR", var_scope(node)
                    cells = tuple(t.value for t in node.tokens if t.type == "ARGUMENT")
                elif kind == "KeywordCall" and (scope := SCOPED_SETTERS.get(normalize(node.keyword or "")
                                                                            .removeprefix("builtin."))):
                    token = next((t for t in node.tokens if t.type == "ARGUMENT"), None)
                    how, cells = node.keyword, tuple(node.args[1:])
                else:
                    continue
                match = token and re.fullmatch(r"\\?([$@&])\{([^{}]+)\}|\\?([$@&])([^{}\s]+)", token.value)
                if not match or variable_base(match[2] or match[4]) != wanted:
                    continue
                name = f"{match[1] or match[3]}{{{match[2] or match[4]}}}"
                symbol = Symbol(name, path, token.lineno - 1, token.col_offset, len(token.value),
                                self.text(path).splitlines()[token.lineno - 1], kind="scoped", value=cells,
                                owner=label, scope=scope, doc=how)
                found.append(symbol)
        return found

    def variable_definitions(self, path, graph, owner, variable, line, exclude=None, assigning=False):
        """Innermost definition: the last owner local/argument; else a command-line variable or a
        command-line variable file's (they override every suite variable); else the suite's own
        Variables section, imported resources and variable files; else a built-in; else where
        the suite's tests and keywords set it with a non-local scope."""
        wanted = normalize(variable)
        scoped = [s for s in self.scope_variables(path, owner, line, exclude, assigning)
                  if variable_base(s.name[2:-1]) == wanted]
        if scoped:
            return scoped[-1:]
        configured = [s for s in graph.configured if variable_base(s.name[2:-1]) == wanted]
        if configured:
            return configured[:1]
        suite = [s for s in graph.variables if variable_base(s.name[2:-1]) == wanted]
        own = [s for s in suite if s.path == path]
        if suite:
            return own or suite
        builtin = [s for s in self.builtin_variables(path) if variable_base(s.name[2:-1]) == wanted][:1]
        return builtin or self.scoped_definitions(graph, wanted)

    def visible_variables(self, path, graph, owner, line, exclude=None):
        """Completion candidates: one entry per name, innermost definition first."""
        seen, result = set(), []
        scoped = reversed(self.scope_variables(path, owner, line, exclude))
        own = [s for s in graph.variables if s.path == path]
        for symbol in [*scoped, *graph.configured, *own, *graph.variables, *self.builtin_variables(path)]:
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

    @snapshot
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
        if self.call_at(graph.groups, node, token) is None:
            return []
        # One location per definition, also when it is imported under several library names.
        locations = [s.location() for s in self.resolve(graph.groups, token.value) if s.path is not None]
        return [location for index, location in enumerate(locations) if location not in locations[:index]]


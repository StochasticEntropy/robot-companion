"""Diagnostics and quick fixes from the same import-aware resolution as definition.

Every rule prefers no diagnostic over a false one: a keyword or variable is reported
only when everything that could define it was read statically. The rules are listed
in README.md ("Diagnostics and quick fixes").
"""

import ast
import copy
from dataclasses import dataclass, field
from io import StringIO
import os
from pathlib import Path
import re

from .features import text_range
from .navigation import variable_uses
from .workspace import (BDD_PREFIX, ERROR, ROBOT_SUFFIXES, SKIPPED_DIRECTORIES, VARIABLE, Workspace, normalize,
                        standard_symbols, uri_path, variable_base)

WARNING = 2  # LSP DiagnosticSeverity
SOURCE = "robot-companion-backend"
QUICKFIX = "quickfix"
DATA_TOKENS_SKIPPED = frozenset(("SEPARATOR", "EOL", "EOS", "CONTINUATION"))
# Statements whose ARGUMENT cells RF resolves as variables in a test/keyword body. Settings
# such as [Documentation], [Tags], [Arguments], [Setup] and [Teardown] are not checked.
VARIABLE_STATEMENTS = frozenset(("KeywordCall", "TemplateArguments", "ForHeader", "IfHeader", "ElseIfHeader",
                                 "InlineIfHeader", "WhileHeader", "ExceptHeader", "GroupHeader", "ReturnStatement",
                                 "ReturnSetting", "Var"))
ARGUMENT_STATEMENTS = frozenset(("KeywordCall", "Setup", "Teardown", "SuiteSetup", "SuiteTeardown", "TestSetup",
                                 "TestTeardown"))
# BuiltIn keywords that set a variable named by their first argument.
SETTERS = frozenset(map(normalize, ("Set Test Variable", "Set Task Variable", "Set Suite Variable",
                                    "Set Global Variable", "Set Local Variable")))
# BuiltIn keywords whose first argument names a variable that may not exist.
NAMING = SETTERS | frozenset(map(normalize, ("Get Variable Value", "Variable Should Exist",
                                             "Variable Should Not Exist")))
OPENS_KEYWORDS = frozenset(map(normalize, ("Import Library", "Import Resource")))
OPENS_VARIABLES = frozenset(map(normalize, ("Import Resource", "Import Variables")))
SEARCH_ORDER = normalize("Set Library Search Order")
# A Python library that may create Robot variables while it runs.
PYTHON_SETS_VARIABLES = re.compile(r"set_(?:test|task|suite|global|local)_variable|import_variables|"
                                   r"_variables\b|EXECUTION_CONTEXTS")
EXTENDED = re.compile(r"(.+?)([^\s\w].+)", re.DOTALL)  # RF's extended variable syntax: base, then `.attr`, ` * 4`


def keyword_text(cell):
    """A cell's keyword name without an explicit `BuiltIn.` prefix, normalized."""
    value = normalize(cell)
    return value.removeprefix("builtin.")


def source_lines(text):
    """Lines as RF numbers them: split at `\\n` only, without the `\\r` of `\\r\\n`."""
    return [line.removesuffix("\r") for line in text.split("\n")]


def data_tokens(node):
    return [t for t in getattr(node, "tokens", ()) if t.type not in DATA_TOKENS_SKIPPED]


@dataclass
class Finding:
    range: dict
    severity: int
    code: str
    message: str
    fixes: list = field(default_factory=list)  # (title, [TextEdit], preferred)

    def diagnostic(self):
        return {"range": self.range, "severity": self.severity, "source": SOURCE, "code": self.code,
                "message": self.message}


@dataclass
class Scope:
    """One file's import graph plus what static reading cannot know about it."""
    graph: object
    files: list  # visited .robot/.resource files, the root first
    keywords_open: bool = False  # some keywords exist only at run time (class/dynamic library, Remote, ...)
    variables_open: bool = False  # variable files, Import Variables, Python code setting variables, ...
    search_order: bool = False  # Set Library Search Order resolves ambiguity at run time
    maybe: set = field(default_factory=set)  # normalized names a Python library may also expose


def library_names(text, stem):
    """Normalized public names a module library may expose as keywords besides decorated
    functions (RF makes every public routine of the module a keyword, also imported ones),
    or None when they cannot be known statically: a class or dynamic library, `import *`."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    names = set()

    def visit(body):
        for node in body:
            if isinstance(node, ast.ClassDef) and node.name == stem:
                return False  # RF then uses the class: a class library
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name in ("get_keyword_names", "run_keyword", "__getattr__"):
                    return False  # a dynamic or hybrid library
                names.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                if any(alias.name == "*" for alias in node.names):
                    return False
                names.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    names.update(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
            elif not isinstance(node, ast.ClassDef):
                # Conditional or guarded definitions (`if`, `try`, `with`) at module level.
                nested = [getattr(node, child, None) for child in ("body", "orelse", "finalbody", "handlers")]
                statements = [s for block in nested if isinstance(block, list)
                              for item in block for s in (item.body if isinstance(item, ast.ExceptHandler) else [item])]
                if visit(statements) is False:
                    return False
        return True
    if visit(tree.body) is False:
        return None
    return {normalize(name) for name in names if not name.startswith("_")}


def scope(workspace, path):
    from robot.libraries import STDLIBS
    graph = workspace.graph(path)
    edges = dict(workspace.edges)  # reset by the next graph() call
    files = list(edges)
    result = Scope(graph, files)
    if graph.problems:
        # An unresolved or unmodelled import may define anything.
        result.keywords_open = result.variables_open = True
    for robot_file in files:
        try:
            model = workspace.model(robot_file)
        except (OSError, UnicodeError):
            result.keywords_open = result.variables_open = True
            continue
        for node, _ in Workspace.walk(model):
            kind = type(node).__name__
            if kind == "VariablesImport":
                result.variables_open = True
            elif kind == "LibraryImport" and node.name in STDLIBS and not standard_symbols(node.name):
                result.keywords_open = True  # Remote, or a standard library not importable here
            for token in data_tokens(node):
                if token.type not in ("KEYWORD", "ARGUMENT", "NAME"):
                    continue
                name = keyword_text(token.value)
                result.keywords_open |= name in OPENS_KEYWORDS
                result.variables_open |= name in OPENS_VARIABLES
                result.search_order |= name == SEARCH_ORDER
    libraries = {target for targets in edges.values() for target in targets if target.suffix == ".py"}
    for library in sorted(libraries):
        try:
            text = workspace.text(library)
        except (OSError, UnicodeError):
            result.keywords_open = result.variables_open = True
            continue
        names = library_names(text, library.stem)
        if names is None:
            result.keywords_open = True
        else:
            result.maybe |= names
        result.variables_open |= bool(PYTHON_SETS_VARIABLES.search(text))
    return result


def importers(workspace, path):
    """Scopes of the workspace suites/resources whose import graph includes the resource
    `path`: RF runs a resource keyword in the namespace of the suite that imports it."""
    found = []
    for other in workspace.workspace_files():
        if other == path:
            continue
        try:
            text = workspace.text(other)
        except (OSError, UnicodeError):
            continue
        if path.name not in text:
            continue
        workspace.graph(other)
        if path in workspace.edges:
            found.append(scope(workspace, other))
    return found


def dynamic_variables(workspace):
    """Normalized names set at run time anywhere in the workspace's Robot files (`Set Test
    Variable` and the other BuiltIn setters, also as `Run Keyword` arguments, and `VAR` with a
    non-local scope), or None when a setter's name is itself computed (`${${name}}`)."""
    from robot.variables import search_variable
    names = set()
    for path in workspace.workspace_files():
        try:
            text = workspace.text(path)
        except (OSError, UnicodeError):
            continue
        if "variable" not in text.casefold() and "VAR" not in text:
            continue
        for node, _ in Workspace.walk(workspace.model(path)):
            tokens = data_tokens(node)
            if type(node).__name__ == "Var":
                scopes = [t.value for t in tokens if t.type == "OPTION" and normalize(t.value).startswith("scope=")]
                if any(normalize(s) != "scope=local" for s in scopes):
                    names.update(variable_base(match[1]) for t in tokens if t.type == "VARIABLE"
                                 and (match := VARIABLE.match(t.value)))
                continue
            for cell, value in zip(tokens, tokens[1:]):
                if cell.type not in ("KEYWORD", "ARGUMENT") or keyword_text(cell.value) not in SETTERS:
                    continue
                written = value.value.removeprefix("\\")
                match = search_variable(written, ignore_errors=True)
                if match.start == 0 and match.end == len(written) and match.base is not None:
                    if search_variable(match.base, ignore_errors=True).start >= 0:
                        return None  # `${${name}}`: any name may be set
                    names.add(variable_base(match.base))
                elif written.startswith("$") and "{" not in written:
                    names.add(variable_base(written[1:]))
                else:
                    return None
    return names


def is_number(name):
    candidate = name.strip().replace("_", "")
    for parse in (lambda v: int(v, 0), float):
        try:
            parse(candidate)
            return True
        except ValueError:
            pass
    return False


def defined(name, known):
    if normalize(name) in known or is_number(name):
        return True
    extended = EXTENDED.fullmatch(name)
    return bool(extended) and normalize(extended[1]) in known


def statement_range(lines, node):
    """The first line's data cells of a statement (or of a block's header)."""
    tokens = data_tokens(node) or data_tokens(getattr(node, "header", None))
    if not tokens:
        line = max(0, node.lineno - 1)
        return text_range(lines[line] if line < len(lines) else "", line, 0, 0)
    first = [t for t in tokens if t.lineno == tokens[0].lineno]
    line = first[0].lineno - 1
    return text_range(lines[line], line, first[0].col_offset, first[-1].end_col_offset)


def token_range(lines, token, start=0):
    line = token.lineno - 1
    return text_range(lines[line], line, token.col_offset + start, token.end_col_offset)


def model_errors(path, text, lines):
    """RF's own parsing and model validation errors, with the loader RF uses for the file."""
    from robot.api import get_init_model, get_model, get_resource_model
    loader = get_resource_model if path.suffix == ".resource" else \
        get_init_model if path.stem == "__init__" else get_model
    for node, _ in Workspace.walk(loader(StringIO(text))):
        reported = set()
        for token in getattr(node, "tokens", ()):
            if token.error:
                reported.add(token.error)
                yield Finding(token_range(lines, token), ERROR, "syntax", token.error)
        for error in getattr(node, "errors", ()):
            if error not in reported:
                yield Finding(statement_range(lines, node), ERROR, "syntax", error)


def import_problems(graph, path, lines):
    """Import diagnostics found while building the graph, on the import's name cell."""
    statements = {node.lineno: node for node, _ in Workspace.walk(graph.model)
                  if type(node).__name__ in ("LibraryImport", "ResourceImport")}
    for source, line, message, severity in graph.problems:
        if source != path:
            continue
        node = statements.get(line)
        name = node.get_token("NAME") if node is not None else None
        place = token_range(lines, name) if name is not None else statement_range(lines, node) \
            if node is not None else text_range("", max(0, line - 1), 0, 0)
        yield Finding(place, severity, "import", message)


def call_arguments(node):
    return [t.value for t in node.tokens if t.type == "ARGUMENT"]


def argument_error(symbol, call, arguments):
    """RF's dry-run argument check: counts, named arguments and their order. Values are not
    converted; a `@{list}`/`&{dict}` argument makes the count unknown, as in RF's dry run."""
    from robot.errors import DataError
    from robot.running.arguments.argumentresolver import ArgumentResolver
    from robot.variables import is_dict_variable, is_list_variable
    if any(is_list_variable(value) or is_dict_variable(value) for value in arguments):
        return None  # expanded only at run time
    spec = copy.copy(symbol.args)
    spec.name = call
    try:
        ArgumentResolver(spec).resolve(arguments, None, None)
    except DataError as exc:
        return str(exc)
    return None


def maybe_exists(scope_, call):
    candidates = [call]
    if prefix := BDD_PREFIX.match(call):
        candidates.append(call[prefix.end():])
    candidates += [c[i + 1:] for c in list(candidates) for i, char in enumerate(c) if char == "."]
    return any(normalize(c) in scope_.maybe for c in candidates)


def origin_name(symbol):
    return symbol.path.name if symbol.path is not None else f"standard library {symbol.namespace}"


def keyword_findings(workspace, path, lines, own, others):
    """Unresolved and ambiguous calls and argument errors in keyword cells."""
    from robot.variables import search_variable
    graph = own.graph
    for node, _ in Workspace.walk(graph.model):
        for token in getattr(node, "tokens", ()):
            if not workspace.keyword_cell(node, token):
                continue
            call = token.value
            pairs = workspace.resolve_call(graph.groups, call)
            symbols = list({id(s): s for s, _ in pairs}.values())
            if not symbols:
                if search_variable(call, ignore_errors=True).start >= 0:
                    continue  # a name containing a variable is known only at run time
                scopes = [own, *others]
                if any(s.keywords_open or maybe_exists(s, call) for s in scopes) or \
                        any(workspace.resolve_call(s.graph.groups, call) for s in others):
                    continue
                yield Finding(token_range(lines, token), ERROR, "unknown-keyword",
                              f"No keyword with name '{call}' found.", [("import", call)])
            elif len(symbols) > 1:
                # RF prefers a normal match to embedded ones and honours Set Library Search Order.
                if own.search_order or any("${" in s.name for s in symbols):
                    continue
                offset = pairs[0][1]
                sources = ", ".join(f"{s.namespace}.{s.name} ({origin_name(s)})" if s.kind != "local"
                                    else f"{s.name} ({origin_name(s)})" for s in symbols)
                yield Finding(token_range(lines, token, offset), WARNING, "ambiguity",
                              f"Multiple keywords with name '{call[offset:]}' found: {sources}. "
                              "Qualify the call with its library or resource name.",
                              [("qualify", (token, offset, symbols))])
            elif type(node).__name__ in ARGUMENT_STATEMENTS and symbols[0].args is not None \
                    and "${" not in symbols[0].name:
                message = argument_error(symbols[0], call, call_arguments(node))
                if message:
                    yield Finding(token_range(lines, token), ERROR, "arguments", message)


def variable_findings(workspace, path, lines, own, others):
    """`${name}` uses in test/keyword bodies that nothing visible defines."""
    if own.variables_open or any(s.variables_open for s in others):
        return
    dynamic = dynamic_variables(workspace)
    if dynamic is None:
        return
    graph = own.graph
    known = set(dynamic)
    for each in (own, *others):
        known.update(variable_base(s.name[2:-1]) for s in each.graph.variables)
    known.update(variable_base(s.name[2:-1]) for s in workspace.builtin_variables(path))
    for owner in (node for node, _ in Workspace.walk(graph.model) if type(node).__name__ in ("TestCase", "Keyword")):
        # Anything the test or keyword defines on any line counts: a FOR/WHILE body may use a
        # value assigned later in the body on an earlier iteration.
        local = known | {variable_base(s.name[2:-1])
                         for s in workspace.scope_variables(path, owner, owner.end_lineno, assigning=True)}
        for node, _ in Workspace.walk(owner):
            if type(node).__name__ not in VARIABLE_STATEMENTS:
                continue
            tokens = data_tokens(node)
            for previous, token in zip([None, *tokens], tokens):
                if token.type != "ARGUMENT":
                    continue
                if previous is not None and previous.type in ("KEYWORD", "ARGUMENT") and \
                        keyword_text(previous.value) in NAMING:
                    continue  # `Set Test Variable    ${new}`, `Get Variable Value    ${maybe}`
                for start, end, _, name, expression in variable_uses(token.value):
                    if expression or defined(name, local):
                        continue
                    written = token.value[start:end]
                    yield Finding(text_range(lines[token.lineno - 1], token.lineno - 1, token.col_offset + start,
                                             token.col_offset + end), WARNING, "undefined-variable",
                                  f"Variable '{written}' is not defined in this scope.")


def analyse(workspace, path):
    text = workspace.text(path)
    lines = source_lines(text)
    findings = list(model_errors(path, text, lines))
    own = scope(workspace, path)
    findings += import_problems(own.graph, path, lines)
    others = importers(workspace, path) if path.suffix == ".resource" else []
    findings += keyword_findings(workspace, path, lines, own, others)
    findings += variable_findings(workspace, path, lines, own, others)
    return findings, own


def publishable(workspace, uri):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        return []
    return [finding.diagnostic() for finding in analyse(workspace, path)[0]]


# Quick fixes ---------------------------------------------------------------------------

def python_files(workspace):
    """Workspace .py files, skipping what workspace_files skips and virtual environments."""
    found = set()
    for root in workspace.roots:
        for directory, names, files in os.walk(root):
            names[:] = [n for n in names if not n.startswith(".") and n not in SKIPPED_DIRECTORIES
                        and not Path(directory, n, "pyvenv.cfg").is_file()]
            found.update(Path(directory, f).resolve() for f in files if f.endswith(".py"))
    return sorted(found)


def definers(workspace, path, call):
    """Workspace resource and library files that define the called keyword (a qualified call
    `name.Keyword` only in a file named `name`)."""
    names = [(None, call)]
    if prefix := BDD_PREFIX.match(call):
        names.append((None, call[prefix.end():]))
    names += [(n[:i], n[i + 1:]) for _, n in list(names) for i, char in enumerate(n) if char == "."]
    hints = {normalize(name) for _, name in names}
    files = {}
    for candidate in [*workspace.workspace_files(), *python_files(workspace)]:
        if candidate == path or candidate.suffix not in (".resource", ".py"):
            continue
        try:
            text = workspace.text(candidate)
            if not any(hint in normalize(text) for hint in hints) and "${" not in text:
                continue
            if candidate.suffix == ".py":
                symbols = workspace.python_symbols(candidate, candidate.stem)
            else:
                symbols = [workspace.keyword_symbol(candidate, node, False)
                           for node, _ in Workspace.walk(workspace.model(candidate))
                           if type(node).__name__ == "Keyword"]
        except (OSError, SyntaxError, UnicodeError, ValueError):
            continue
        for qualifier, name in names:
            if qualifier is not None and normalize(qualifier) != normalize(candidate.stem):
                continue
            if any(workspace.matches(s, name) for s in symbols):
                files[candidate] = symbols
    return sorted(files)


def insertion(model, lines, eol, statement):
    """A TextEdit adding `statement` after the last import of the first Settings section,
    or a new Settings section before the first section."""
    sections = [s for s in model.sections if s.header is not None]
    settings = next((s for s in sections if type(s).__name__ == "SettingSection"), None)
    if settings is not None:
        imports = [n for n in settings.body if type(n).__name__ in ("LibraryImport", "ResourceImport",
                                                                    "VariablesImport")]
        anchor = imports[-1] if imports else settings.header
        line = anchor.end_lineno  # the line after the anchor's last line
        if line < len(lines):
            return {"range": text_range("", line, 0, 0), "newText": statement + eol}
        last = len(lines) - 1  # no line break after the anchor: start a new line
        return {"range": text_range(lines[last], last, len(lines[last]), len(lines[last])),
                "newText": eol + statement}
    line = sections[0].header.lineno - 1 if sections else 0
    return {"range": text_range("", line, 0, 0), "newText": f"*** Settings ***{eol}{statement}{eol}{eol}"}


def import_fix(workspace, path, text, lines, model, call):
    files = definers(workspace, path, call)
    if len(files) != 1:
        return []  # never a guess between several files
    target = files[0]
    relative = Path(os.path.relpath(target, path.parent)).as_posix()
    if re.search(r"\s{2}|\t|^\s|\s$|^#", relative):
        return []  # not writable as one Robot cell
    setting = "Resource" if target.suffix == ".resource" else "Library"
    eol = "\r\n" if "\r\n" in text else "\n"
    edit = insertion(model, lines, eol, f"{setting}    {relative}")
    return [(f"Import {setting.lower()} {relative}", [edit], True)]


def qualify_fixes(workspace, graph, lines, token, offset, symbols):
    fixes, seen = [], set()
    called = token.value[offset:]
    for symbol in symbols:
        if symbol.kind == "local":
            continue  # a suite's own keywords have no qualifying name
        qualified = f"{symbol.namespace}.{called}"
        if qualified in seen or len(workspace.resolve(graph.groups, token.value[:offset] + qualified)) != 1:
            continue  # two imports with the same name are not told apart by it
        seen.add(qualified)
        edit = {"range": token_range(lines, token, offset), "newText": qualified}
        fixes.append((f"Use {qualified} ({origin_name(symbol)})", [edit], False))
    return fixes


def kind_requested(only):
    return not only or any(kind in ("", QUICKFIX) or QUICKFIX.startswith(kind + ".") for kind in only)


def overlaps(first, second):
    def at(position):
        return position["line"], position["character"]
    return not (at(first["end"]) < at(second["start"]) or at(second["end"]) < at(first["start"]))


def code_actions(workspace, uri, request_range, only=None):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES or not kind_requested(only):
        return []
    text = workspace.text(path)
    lines = source_lines(text)
    findings, own = analyse(workspace, path)
    actions = []
    for finding in findings:
        if not finding.fixes or not overlaps(finding.range, request_range):
            continue
        for kind, data in finding.fixes:
            if kind == "import":
                fixes = import_fix(workspace, path, text, lines, own.graph.model, data)
            else:
                fixes = qualify_fixes(workspace, own.graph, lines, *data)
            for title, edits, preferred in fixes:
                action = {"title": title, "kind": QUICKFIX, "diagnostics": [finding.diagnostic()],
                          "edit": {"changes": {uri: edits}}}
                if preferred:
                    action["isPreferred"] = True
                actions.append(action)
    return actions

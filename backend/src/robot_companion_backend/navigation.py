"""References, rename and document/workspace symbols from definition's import-aware resolution.

Every request rescans the workspace folders and rebuilds each file's import graph from
current overlays and disk, so edits, saved files and created/deleted files are seen
without a restart. A keyword is identified by its definition location, never by name.
"""

import re

from .features import text_range
from .workspace import ROBOT_SUFFIXES, VARIABLE, normalize, uri_path, variable_base

LOCAL_KINDS = frozenset(("argument", "assign", "var", "for", "except"))
SKIPPED_TOKENS = frozenset(("COMMENT", "SEPARATOR", "EOL", "EOS", "CONTINUATION"))
METHOD, FUNCTION, VARIABLE_SYMBOL = 6, 12, 13  # LSP SymbolKind
# A new keyword name must stay one cell and must not become a variable or comment.
INVALID_KEYWORD_NAME = re.compile(r"[\r\n\t]| {2}|[$@&%]\{|^#|^\.\.\.")
INVALID_VARIABLE_NAME = re.compile(r"[\r\n\t{}$@&%.\[\]:=]| {2}")


class RequestFailed(Exception):
    """A refused request (LSP RequestFailed): the client shows the message, nothing is edited."""
    code = -32803

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def keyword_key(symbol):
    if symbol.path is None:
        return ("standard", normalize(symbol.name))  # an alias never changes identity
    return (symbol.path, symbol.line, symbol.column)


def variable_keys(path, owner, symbols):
    keys = set()
    for symbol in symbols:
        base = variable_base(symbol.name[2:-1])
        if symbol.kind in LOCAL_KINDS:
            keys.add(("local", path, owner.lineno, base))  # scoped to its test/keyword
        elif symbol.kind == "builtin":
            keys.add(("builtin", base))
        else:
            keys.add(("suite", symbol.path, symbol.line, symbol.column))
    return frozenset(keys)


def base_name(match):
    """Variable base name as written: `record` in `${record.name}`, `PORT` in `${PORT: int}`."""
    return re.split(r"[.\[:]", match[1], maxsplit=1)[0]


class Target:
    def __init__(self, kind, symbols, keys, text, line, start, end, path):
        self.kind, self.symbols, self.keys = kind, symbols, keys
        self.text, self.line, self.start, self.end, self.path = text, line, start, end, path

    def range(self):
        return text_range(self.text, self.line, self.start, self.end)


def target_at(workspace, uri, position):
    """The keyword or variable under the cursor, with the name range a rename would replace."""
    path, text, line, column = workspace.locate(uri, position)
    if path.suffix == ".py":
        # A Python keyword at its definition: the function name on its `def` line.
        for symbol in workspace.python_symbols(path, path.stem):
            if symbol.line == line and symbol.column <= column <= symbol.column + symbol.length:
                return Target("keyword", [symbol], frozenset([keyword_key(symbol)]), text, line,
                              symbol.column, symbol.column + symbol.length, path)
        return None
    graph = workspace.graph(path)
    node, owner, token = workspace.token_at(graph.model, line, column)
    if token is None or token.type in SKIPPED_TOKENS:
        return None
    match, variable = workspace.variable_at(token, column)
    if match:
        symbols = workspace.variable_definitions(path, graph, owner, variable, line,
                                                 workspace.defining_statement(node, token))
        if not symbols:
            return None
        start = token.col_offset + match.start(1)
        return Target("variable", symbols, variable_keys(path, owner, symbols), text, line, start,
                      start + len(base_name(match)), path)
    if token.type == "KEYWORD NAME" and type(owner).__name__ == "Keyword":
        symbol = workspace.keyword_symbol(path, owner, path.suffix == ".robot")
        return Target("keyword", [symbol], frozenset([keyword_key(symbol)]), text, line,
                      token.col_offset, token.end_col_offset, path)
    if not workspace.keyword_cell(node, token):
        return None
    pairs = workspace.resolve_call(graph.groups, token.value)
    if not pairs:
        return None
    return Target("keyword", [s for s, _ in pairs], frozenset(keyword_key(s) for s, _ in pairs), text, line,
                  token.col_offset + pairs[0][1], token.end_col_offset, path)


def readable(workspace, path):
    try:
        return workspace.text(path)
    except (OSError, UnicodeError):
        return None


def keyword_sites(workspace, target):
    """(path, line text, line, start, end, resolution keys) of every keyword cell resolving to the target.

    A file is parsed only if its normalized text can contain the name; embedded-argument
    keywords cannot be prefiltered by text."""
    hints = {normalize(s.name) for s in target.symbols}
    embedded = any("${" in s.name for s in target.symbols)
    definitions = [s.path for s in target.symbols if s.path is not None]
    for path in workspace.workspace_files(definitions):
        text = readable(workspace, path)
        if text is None or not (embedded or any(hint in normalize(text) for hint in hints)):
            continue
        graph = workspace.graph(path)
        lines = text.splitlines()
        for node, _ in workspace.walk(graph.model):
            for token in getattr(node, "tokens", ()):
                if not workspace.keyword_cell(node, token):
                    continue
                pairs = workspace.resolve_call(graph.groups, token.value)
                keys = frozenset(keyword_key(s) for s, _ in pairs)
                if keys & target.keys:
                    offset = next(o for s, o in pairs if keyword_key(s) in target.keys)
                    yield path, lines[token.lineno - 1], token.lineno - 1, token.col_offset + offset, \
                        token.end_col_offset, keys


def variable_sites(workspace, target):
    """(path, line text, line, start, end, resolution keys, is definition) of each occurrence."""
    hints = {variable_base(s.name[2:-1]) for s in target.symbols}
    local = next((key for key in target.keys if key[0] == "local"), None)
    definitions = [s.path for s in target.symbols if s.path is not None]
    files = [target.path] if local else workspace.workspace_files(definitions)
    for path in files:
        text = readable(workspace, path)
        if text is None or not any(hint in normalize(text) for hint in hints):
            continue
        graph = workspace.graph(path)
        lines = text.splitlines()
        for node, owner in workspace.walk(graph.model):
            if local and (owner is None or owner.lineno != local[2]):
                continue  # a keyword-local variable is never visible outside its owner
            for token in getattr(node, "tokens", ()):
                if token.type in SKIPPED_TOKENS:
                    continue
                for match in VARIABLE.finditer(token.value):
                    name = base_name(match)
                    if variable_base(name) not in hints:
                        continue
                    line = token.lineno - 1
                    symbols = workspace.variable_definitions(path, graph, owner, name, line,
                                                             workspace.defining_statement(node, token))
                    keys = variable_keys(path, owner, symbols)
                    if keys & target.keys:
                        start = token.col_offset + match.start(1)
                        declared = any(s.path == path and s.line == line and s.column == token.col_offset + match.start()
                                       for s in symbols)
                        yield path, lines[line], line, start, start + len(name), keys, declared


def location(path, text, line, start, end):
    return {"uri": path.as_uri(), "range": text_range(text, line, start, end)}


def unique(locations):
    seen, result = set(), []
    for item in locations:
        key = (item["uri"], item["range"]["start"]["line"], item["range"]["start"]["character"])
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def references(workspace, uri, position, include_declaration):
    target = target_at(workspace, uri, position)
    if target is None:
        return []
    result = []
    if target.kind == "keyword":
        if include_declaration:
            result += [s.location() for s in target.symbols if s.path is not None]
        # A call whose resolution includes another keyword is ambiguous (RF fails it), so it is
        # no reference of either; an ambiguous cursor call finds the calls of each candidate.
        result += [location(*site[:5]) for site in keyword_sites(workspace, target) if site[5] <= target.keys]
    else:
        result += [location(*site[:5]) for site in variable_sites(workspace, target)
                   if site[5] <= target.keys and (include_declaration or not site[6])]
    return unique(result)


def check_renamable(target):
    if target.kind == "keyword":
        symbol = target.symbols[0]
        if len(target.symbols) > 1:
            raise RequestFailed(f"Cannot rename: {symbol.name} is ambiguous ({len(target.symbols)} definitions); "
                                "qualify the call with its library or resource name first.")
        if symbol.kind == "library":
            raise RequestFailed(f"Cannot rename {symbol.name}: it is defined in Python library {symbol.path.name}. "
                                "Renaming library keywords is not supported; rename it in the Python source.")
        if symbol.kind == "standard":
            raise RequestFailed(f"Cannot rename {symbol.name}: it is a Robot Framework standard library keyword "
                                f"({symbol.namespace}).")
        if "${" in symbol.name:
            raise RequestFailed(f"Cannot rename {symbol.name}: keywords with embedded arguments are not "
                                "supported by rename.")
    else:
        symbol = target.symbols[0]
        if symbol.kind == "builtin":
            raise RequestFailed(f"Cannot rename {symbol.name}: it is a Robot Framework built-in variable.")
        if len(target.keys) > 1:
            raise RequestFailed(f"Cannot rename {symbol.name}: it is defined in several imported files.")


def prepare_rename(workspace, uri, position):
    target = target_at(workspace, uri, position)
    if target is None:
        return None
    check_renamable(target)
    return {"range": target.range(), "placeholder": target.text[target.start:target.end]}


def rename(workspace, uri, position, new_name):
    if not isinstance(new_name, str):
        raise TypeError("newName must be a string")
    target = target_at(workspace, uri, position)
    if target is None:
        raise RequestFailed("Nothing to rename here: place the cursor on a keyword or variable.")
    check_renamable(target)
    new_name = new_name.strip()
    if target.kind == "keyword":
        if not new_name or INVALID_KEYWORD_NAME.search(new_name):
            raise RequestFailed("A keyword name must be one non-empty cell without tabs, line breaks, two "
                                "consecutive spaces or variables.")
        definition = target.symbols[0]
        lines = workspace.text(definition.path).splitlines()
        sites = [(definition.path, lines[definition.line], definition.line, definition.column,
                  definition.column + definition.length)]
        for path, text, line, start, end, keys in keyword_sites(workspace, target):
            if keys != target.keys:
                raise RequestFailed(f"Cannot rename {definition.name}: the call at {path.name}:{line + 1} is "
                                    "ambiguous; qualify it with its library or resource name first.")
            sites.append((path, text, line, start, end))
    else:
        if whole := re.fullmatch(r"[$@&]\{(.*)\}", new_name):
            new_name = whole[1].strip()
        if not new_name or INVALID_VARIABLE_NAME.search(new_name):
            raise RequestFailed("A variable name must be non-empty and contain no braces, sigils, `.`, `[`, `]`, "
                                "`:`, `=`, tabs, line breaks or two consecutive spaces.")
        sites = []
        for path, text, line, start, end, keys, _ in variable_sites(workspace, target):
            if keys != target.keys:
                raise RequestFailed(f"Cannot rename {target.symbols[0].name}: the use at {path.name}:{line + 1} "
                                    "is ambiguous.")
            sites.append((path, text, line, start, end))
    changes = {}
    for item in unique([location(*site) for site in sites]):
        changes.setdefault(item["uri"], []).append({"range": item["range"], "newText": new_name})
    return {"changes": changes}


def line_end(lines, line):
    text = lines[min(line, len(lines) - 1)] if lines else ""
    return {"line": line, "character": len(text.encode("utf-16-le")) // 2}


def block_range(lines, node):
    """From the node's first line to its last non-blank line (RF counts trailing blank lines)."""
    end = node.end_lineno - 1
    while end >= node.lineno and end < len(lines) and not lines[end].strip():
        end -= 1
    return {"start": {"line": node.lineno - 1, "character": 0}, "end": line_end(lines, end)}


def outline(workspace, path):
    """(name, kind, detail, range, selection range, children) for tests/tasks, keywords and
    suite variables of one Robot file, in source order."""
    text = workspace.text(path)
    lines = text.splitlines()
    model = workspace.model(path)
    result = []
    for section in model.sections:
        header = section.header.type if section.header else None
        for item in section.body:
            kind = type(item).__name__
            if kind == "Variable":
                token = next((t for t in item.tokens if t.type == "VARIABLE"), None)
                match = token and VARIABLE.match(token.value)
                if match:
                    selection = text_range(lines[token.lineno - 1], token.lineno - 1, token.col_offset,
                                           token.col_offset + len(match[0]))
                    result.append((match[0], VARIABLE_SYMBOL, "Variable", block_range(lines, item), selection, []))
            elif kind in ("TestCase", "Keyword"):
                token = item.header.get_token("TESTCASE NAME" if kind == "TestCase" else "KEYWORD NAME")
                if token is None or not token.value:
                    continue
                selection = text_range(lines[token.lineno - 1], token.lineno - 1, token.col_offset,
                                       token.end_col_offset)
                children, seen = [], set()
                for symbol in workspace.scope_variables(path, item, item.end_lineno):
                    base = variable_base(symbol.name[2:-1])
                    if base not in seen:  # one child per variable: its first definition
                        seen.add(base)
                        place = symbol.location()["range"]
                        children.append((symbol.name, VARIABLE_SYMBOL,
                                         "Argument" if symbol.kind == "argument" else "Local variable",
                                         place, place, []))
                if kind == "Keyword":
                    symbol_kind, detail = FUNCTION, "Keyword"
                else:
                    symbol_kind, detail = METHOD, "Task" if header == "TASK HEADER" else "Test case"
                result.append((token.value, symbol_kind, detail, block_range(lines, item), selection, children))
    return result


def document_symbols(workspace, uri):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        return []

    def convert(entry):
        name, kind, detail, whole, selection, children = entry
        return {"name": name, "kind": kind, "detail": detail, "range": whole, "selectionRange": selection,
                "children": [convert(child) for child in children]}
    return [convert(entry) for entry in outline(workspace, path)]


def fuzzy(query, name):
    """Every query character in order (case, spaces and underscores ignored)."""
    remaining = iter(normalize(name))
    return all(char in remaining for char in normalize(query))


def workspace_symbols(workspace, query):
    if not isinstance(query, str):
        raise TypeError("query must be a string")
    result = []
    for path in workspace.workspace_files():
        if readable(workspace, path) is None:
            continue
        for name, kind, detail, _, selection, _ in outline(workspace, path):
            if kind != VARIABLE_SYMBOL and fuzzy(query, name):
                result.append({"name": name, "kind": kind, "containerName": f"{detail} · {path.name}",
                               "location": {"uri": path.as_uri(), "range": selection}})
    return result

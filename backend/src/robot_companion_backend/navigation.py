"""References, rename and document/workspace symbols from definition's import-aware resolution.

Every request rescans the workspace folders and rebuilds each file's import graph from
current overlays and disk, so edits, saved files and created/deleted files are seen
without a restart. A keyword is identified by its definition location, never by name.
"""

import ast
import io
import re
import tokenize

from .features import origin, text_range
from .workspace import GET_KEYWORD_NAMES, ROBOT_SUFFIXES, VARIABLE, normalize, uri_path, variable_base

LOCAL_KINDS = frozenset(("argument", "assign", "var", "for", "except"))
SKIPPED_TOKENS = frozenset(("COMMENT", "SEPARATOR", "EOL", "EOS", "CONTINUATION"))
METHOD, FUNCTION, VARIABLE_SYMBOL = 6, 12, 13  # LSP SymbolKind
# RF control-structure markers: a keyword with such a name could no longer be called.
RESERVED = frozenset(("FOR", "END", "IF", "ELSE", "ELSE IF", "WHILE", "TRY", "EXCEPT", "FINALLY", "BREAK",
                      "CONTINUE", "RETURN", "VAR", "GROUP"))
INVALID_VARIABLE_CHARACTERS = set("{}$@&%.[]:=\\")
CONDITION_HEADERS = frozenset(("IfHeader", "ElseIfHeader", "InlineIfHeader", "WhileHeader"))
# BuiltIn keywords whose first argument RF evaluates as a Python expression.
EVALUATING = frozenset(normalize(name) for name in (
    "Evaluate", "Should Be True", "Should Not Be True", "Skip If", "Pass Execution If", "Run Keyword If",
    "Run Keyword Unless", "Set Variable If", "Return From Keyword If", "Continue For Loop If",
    "Exit For Loop If", "Run Keyword And Return If"))


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


def carried_local(path, owner, node, name, loops):
    """The owner's local key for `name` when a FOR/WHILE around the node assigns it (see
    `Workspace.loop_names`): from the second iteration on, the use is reached by that local."""
    base = variable_base(name)
    if owner is not None and base in loops.get(id(node), ()):
        return ("local", path, owner.lineno, base)
    return None


def evaluated(workspace, graph, node, token):
    """Is the whole cell a Python expression: a condition, or a BuiltIn evaluating keyword's first argument?"""
    if token.type != "ARGUMENT":
        return False
    if type(node).__name__ in CONDITION_HEADERS:
        return True
    if type(node).__name__ != "KeywordCall":
        return False
    for call in workspace.calls(graph.groups, node):  # also a keyword `Run Keyword` runs
        if call.arguments and call.arguments[0] is token:
            pairs = workspace.resolve_call(graph.groups, call.token.value)
            if len(pairs) == 1 and pairs[0][0].kind == "standard" and normalize(pairs[0][0].name) in EVALUATING:
                return True
    return False


def expression_names(value, start, end):
    """(position of `$`, name) of each `$name` RF substitutes in the Python expression
    value[start:end]: found by Python's tokenizer, so text inside string literals is skipped."""
    text = value[start:end]
    lead = len(text) - len(text.lstrip())
    found, previous = [], None
    try:
        for token in tokenize.generate_tokens(io.StringIO(text.strip()).readline):
            if token.type == tokenize.NAME and previous is not None and previous.string == "$" \
                    and previous.end == token.start:
                found.append((start + lead + previous.start[1], token.string))
            previous = token
    except (tokenize.TokenError, SyntaxError):
        pass  # an incomplete expression: the names before the error still count
    return found


def variable_uses(value, offset=0):
    """(start, end, name start, name, is `$name`) of each variable RF substitutes in `value`,
    following RF's own variable search: nested in an inline expression (`${{ ${x} + 1 }}`),
    in a variable name (`${greeting_${lang}}`, whose outer name is dynamic and not itself a
    use) and in item access (`${list}[${i}]`), plus `$name` inside `${{ }}`. Escaped forms
    (`\\${x}`) are literal text."""
    from robot.variables import search_variable
    position = 0
    while (match := search_variable(value[position:], ignore_errors=True)).start >= 0:
        start, base = position + match.start, match.base or ""
        base_start = start + 2
        if match.identifier == "$" and base.startswith("{") and base.endswith("}"):
            inner_start, inner_end = base_start + 1, base_start + len(base) - 1
            yield from variable_uses(value[inner_start:inner_end], offset + inner_start)
            for dollar, name in expression_names(value, inner_start, inner_end):
                yield offset + dollar, offset + dollar + 1 + len(name), offset + dollar + 1, name, True
        elif search_variable(base, ignore_errors=True).start >= 0:
            yield from variable_uses(base, offset + base_start)
        elif match.identifier in "$@&":
            yield offset + start, offset + base_start + len(base) + 1, offset + base_start, \
                re.split(r"[.\[:]", base, maxsplit=1)[0], False
        item = base_start + len(base) + 1
        for text in match.items:  # `[item]` cells follow the closing brace in order
            yield from variable_uses(text, offset + item + 1)
            item += len(text) + 2
        position += match.end


def occurrences(workspace, graph, node, token):
    """(start, end, name start, name, is `$name` expression) of each variable use in a token:
    RF variable syntax (also nested) and, where RF evaluates the whole cell as Python, `$name`."""
    if token.type in SKIPPED_TOKENS:
        return
    value, seen = token.value, set()
    found = list(variable_uses(value))
    if evaluated(workspace, graph, node, token):
        found += [(dollar, dollar + 1 + len(name), dollar + 1, name, True)
                  for dollar, name in expression_names(value, 0, len(value))]
    for use in found:
        if use[2] not in seen:  # `${{ $x }}` inside an evaluated cell is found twice
            seen.add(use[2])
            yield use


class Target:
    def __init__(self, kind, symbols, keys, text, line, start, end, path, owner=None):
        self.kind, self.symbols, self.keys = kind, symbols, keys
        self.text, self.line, self.start, self.end, self.path, self.owner = text, line, start, end, path, owner

    def range(self):
        return text_range(self.text, self.line, self.start, self.end)


def keyword_target(workspace, path, keyword, text, line, start, end):
    symbol = workspace.keyword_symbol(path, keyword, path.suffix == ".robot")
    return Target("keyword", [symbol], frozenset([keyword_key(symbol)]), text, line, start, end, path)


def target_at(workspace, uri, position):
    """The keyword or variable under the cursor, with the name range a rename would replace.

    A cursor just after a name (where an editor caret usually is) counts as on it."""
    path, text, line, column = workspace.locate(uri, position)
    if path.suffix == ".py":
        # A Python keyword at its definition: the function name on its `def` line, or a dynamic
        # library's name in its `get_keyword_names` list.
        for symbol in library_definitions(workspace, path):
            if symbol.line == line and symbol.column <= column <= symbol.column + symbol.length:
                return Target("keyword", [symbol], frozenset([keyword_key(symbol)]), text, line,
                              symbol.column, symbol.column + symbol.length, path)
            # The name in its `@keyword("Name")` decorator.
            site = name_literal(workspace, symbol)
            if not isinstance(site, str) and site[2] == line and site[3] <= column <= site[4]:
                return Target("keyword", [symbol], frozenset([keyword_key(symbol)]), text, line,
                              site[3], site[4], path)
        return None
    graph = workspace.graph(path)
    return target_in(workspace, graph, path, text, line, column) or (
        target_in(workspace, graph, path, text, line, column - 1) if column else None)


def library_definitions(workspace, path):
    """The keywords of a .py library for each way RF may import it: as its own module name, or
    as `module.ClassName` for each top-level class. One symbol per definition location."""
    tree = ast.parse(workspace.text(path), filename=str(path))
    found = {}
    for name in [path.stem, *(node.name for node in tree.body if isinstance(node, ast.ClassDef))]:
        for symbol in workspace.python_symbols(path, path.stem, workspace.library_reading(path, name)):
            found.setdefault(keyword_key(symbol), symbol)
    return list(found.values())


def target_in(workspace, graph, path, text, line, at):
    node, owner, token = workspace.token_at(graph.model, line, at)
    if token is None or token.type in SKIPPED_TOKENS:
        return None
    for start, end, name_start, name, _ in occurrences(workspace, graph, node, token):
        if token.col_offset + start <= at < token.col_offset + end:
            symbols = workspace.variable_definitions(path, graph, owner, name, line,
                                                     workspace.defining_statement(node, token),
                                                     token.type == "ASSIGN")
            keys = variable_keys(path, owner, symbols)
            carried = carried_local(path, owner, node, name, workspace.loop_names(owner))
            if carried and carried not in keys:
                # Also the loop's local: unset before the loop, the use has only that definition.
                keys |= {carried}
                symbols = symbols or workspace.variable_definitions(path, graph, owner, name, owner.end_lineno)
            if not symbols:
                return None
            start = token.col_offset + name_start
            return Target("variable", symbols, keys, text, line, start, start + len(name), path, owner)
    if token.type == "KEYWORD NAME" and type(owner).__name__ == "Keyword":
        return keyword_target(workspace, path, owner, text, line, token.col_offset, token.end_col_offset)
    if workspace.call_at(graph.groups, node, token) is None:
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
    """(path, line text, line, start, end, resolution keys, call) of every keyword cell, also a
    keyword name argument of `Run Keyword` and the other BuiltIn run-keyword variants,
    resolving to the target. A file is parsed only if its normalized text can contain the
    name; embedded-argument keywords cannot be prefiltered by text."""
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
            for call in workspace.calls(graph.groups, node):
                token = call.token
                pairs = workspace.resolve_call(graph.groups, token.value)
                keys = frozenset(keyword_key(s) for s, _ in pairs)
                if keys & target.keys:
                    offset = next(o for s, o in pairs if keyword_key(s) in target.keys)
                    yield path, lines[token.lineno - 1], token.lineno - 1, token.col_offset + offset, \
                        token.end_col_offset, keys, call


def variable_sites(workspace, target, keys=None):
    """(path, line text, line, start, end, resolution keys, is definition, is `$name`, loop-carried
    local key or None) of each occurrence resolving to, or reached in a loop by, one of `keys`
    (default: the target's). The resolution keys are those of the definitions visible at the line."""
    keys = target.keys if keys is None else keys
    hints = {variable_base(s.name[2:-1]) for s in target.symbols}
    local = all(key[0] == "local" for key in keys)  # never visible outside their owner's file
    owners = {key[2] for key in keys if key[0] == "local"}
    definitions = [target.path, *(key[1] for key in keys if key[0] == "suite")]
    files = [target.path] if local else workspace.workspace_files(definitions)
    for path in files:
        text = readable(workspace, path)
        if text is None or not any(hint in normalize(text) for hint in hints):
            continue
        graph = workspace.graph(path)
        lines = text.splitlines()
        loops = {}
        for node, owner in workspace.walk(graph.model):
            if local and (owner is None or owner.lineno not in owners):
                continue  # a keyword-local variable is never visible outside its owner
            for token in getattr(node, "tokens", ()):
                for start, _, name_start, name, expression in occurrences(workspace, graph, node, token):
                    if variable_base(name) not in hints:
                        continue
                    line = token.lineno - 1
                    symbols = workspace.variable_definitions(path, graph, owner, name, line,
                                                             workspace.defining_statement(node, token),
                                                             token.type == "ASSIGN")
                    found = variable_keys(path, owner, symbols)
                    if id(owner) not in loops:
                        loops[id(owner)] = workspace.loop_names(owner)
                    carried = carried_local(path, owner, node, name, loops[id(owner)])
                    carried = None if carried in found else carried
                    if (found | {carried}) & keys:
                        begin = token.col_offset + name_start
                        declared = any(s.path == path and s.line == line and s.column == token.col_offset + start
                                       for s in symbols)
                        yield path, lines[line], line, begin, begin + len(name), found, declared, expression, \
                            carried


def named_argument_sites(workspace, target):
    """`name=` cells passing a user keyword's `${argument}` by name in calls of its keyword:
    (path, line text, line, start, end, call is unambiguous). Also from a later reassignment
    of the argument, which shares its local identity."""
    from robot.utils import split_from_equals
    local = next((key for key in target.keys if key[0] == "local"), None)
    owner = target.owner
    if local is None or type(owner).__name__ != "Keyword" or "${" in owner.name:
        return  # tests have no arguments; embedded arguments are never passed by name
    argument = next((s for s in workspace.scope_variables(target.path, owner, owner.end_lineno)
                     if s.kind == "argument" and s.name.startswith("${")  # `@{}`/`&{}` take no `name=`
                     and variable_base(s.name[2:-1]) == local[3]), None)
    if argument is None:
        return
    written = re.split(r"[.\[:]", argument.name[2:-1], maxsplit=1)[0].strip()
    calls = keyword_target(workspace, target.path, owner, "", 0, 0, 0)
    lines = {}
    for path, _, _, _, _, keys, call in keyword_sites(workspace, calls):
        for token in call.arguments:  # only the cells passed to this call
            name, value = split_from_equals(token.value)
            if value is not None and name == written:
                text = lines.setdefault(path, workspace.text(path).splitlines())[token.lineno - 1]
                yield path, text, token.lineno - 1, token.col_offset, token.col_offset + len(written), \
                    keys == calls.keys


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
        # A use in a loop that reassigns it later is a reference of both definitions reaching it.
        result += [location(*site[:5]) for site in variable_sites(workspace, target)
                   if (site[5] <= target.keys or site[8] in target.keys) and (include_declaration or not site[6])]
        result += [location(*site[:5]) for site in named_argument_sites(workspace, target) if site[5]]
    return unique(result)


def check_renamable(target):
    symbol = target.symbols[0]
    if target.kind == "keyword":
        if len(target.symbols) > 1:
            raise RequestFailed(f"Cannot rename: {symbol.name} is ambiguous ({len(target.symbols)} definitions); "
                                "qualify the call with its library or resource name first.")
        if symbol.kind == "standard":
            raise RequestFailed(f"Cannot rename {symbol.name}: it is a Robot Framework standard library keyword "
                                f"({symbol.namespace}).")
        if "${" in symbol.name:
            raise RequestFailed(f"Cannot rename {symbol.name}: keywords with embedded arguments are not "
                                "supported by rename.")
    elif symbol.kind == "builtin":
        raise RequestFailed(f"Cannot rename {symbol.name}: it is a Robot Framework built-in variable.")
    elif sum(key[0] == "suite" for key in target.keys) > 1:
        raise RequestFailed(f"Cannot rename {symbol.name}: it is defined in several imported files.")


def python_lines(text):
    return re.split(r"\r\n|\r|\n", text)  # Python's line breaks, not str.splitlines()


def name_literal(workspace, symbol):
    """The site (path, line text, line, start, end, False) of the string literal naming a Python
    library keyword in its `@keyword("Name")` decorator, or the reason (a str) why a rename cannot
    change the keyword's name there without changing Python code that may use it."""
    where = f"{symbol.path.name}:{symbol.line + 1}"
    text = workspace.text(symbol.path)
    tree = ast.parse(text, filename=str(symbol.path))
    if any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in GET_KEYWORD_NAMES
           for node in ast.walk(tree)):
        return (f"it is a keyword of a dynamic or hybrid library ({symbol.path.name} has get_keyword_names), "
                "whose names the library's own code lists and dispatches")
    function = next((node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and node.lineno - 1 == symbol.line and len(node.name) == symbol.length), None)
    if function is None:
        return f"its name in {where} is not a decorated Python function"
    literals = []
    for decorator in function.decorator_list:
        if isinstance(decorator, ast.Call):
            literal = decorator.args[0] if decorator.args else next(
                (k.value for k in decorator.keywords if k.arg == "name"), None)
            if isinstance(literal, ast.Constant) and literal.value == symbol.name:
                literals.append(literal)
    if not literals:
        return (f"its name comes from the Python function name {function.name} ({where}), which Python code "
                f"may also call. Give the function @keyword(\"{symbol.name}\") first, or rename it in the "
                "Python source")
    literal = literals[0]
    segment = ast.get_source_segment(text, literal) or ""
    if len(literals) > 1 or literal.lineno != literal.end_lineno or \
            segment not in (f'"{symbol.name}"', f"'{symbol.name}'"):
        return f"its name in {symbol.path.name}:{literal.lineno} is not one plain single-line string literal"
    line = python_lines(text)[literal.lineno - 1]
    start = len(line.encode("utf-8")[:literal.col_offset].decode("utf-8")) + 1
    return symbol.path, line, literal.lineno - 1, start, start + len(symbol.name), False


def python_mentions(workspace, symbol):
    """RequestFailed when Python code in the workspace names the keyword in a string other than
    its decorator (`BuiltIn().run_keyword("Name")`): a rename would leave that code behind."""
    wanted = normalize(symbol.name)
    for path in workspace.workspace_files([symbol.path], (".py",)):
        text = readable(workspace, path)
        if text is None or wanted not in normalize(text):
            continue
        try:
            tree = ast.parse(text, filename=str(path))
        except (SyntaxError, ValueError):
            raise RequestFailed(f"Cannot rename {symbol.name}: {path.name} mentions it but cannot be read as "
                                "Python, so its uses there are unknown.") from None
        # The name literal of any `@keyword("Name")` defines a keyword (perhaps another library's
        # same-named one); it does not call this one.
        defining = {id(decorator.args[0] if decorator.args else keyword.value)
                    for function in ast.walk(tree) if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
                    for decorator in function.decorator_list if isinstance(decorator, ast.Call)
                    for keyword in [next((k for k in decorator.keywords if k.arg == "name"), None)]
                    if decorator.args or keyword is not None}
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)) or id(node) in defining:
                continue
            value = normalize(node.value)
            if value != wanted and not value.endswith("." + wanted):
                continue
            raise RequestFailed(f"Cannot rename {symbol.name}: {path.name}:{node.lineno} names it in a Python "
                                "string, which rename does not change. Change that code first.")


def library_site(workspace, symbol):
    """The decorator literal a Python library keyword's rename edits, or RequestFailed."""
    if not any(symbol.path.is_relative_to(root) for root in workspace.roots):
        raise RequestFailed(f"Cannot rename {symbol.name}: it is defined in Python library {symbol.path.name} "
                            "outside the workspace folder.")
    if location := workspace.installed(symbol.path):
        raise RequestFailed(f"Cannot rename {symbol.name}: it is defined in Python library {symbol.path.name} "
                            f"installed in the selected environment ({location}).")
    try:
        site = name_literal(workspace, symbol)
    except (OSError, SyntaxError, UnicodeError, ValueError):
        site = f"Python library {symbol.path.name} cannot be read"
    if isinstance(site, str):
        raise RequestFailed(f"Cannot rename {symbol.name} of Python library {symbol.path.name}: {site}.")
    python_mentions(workspace, symbol)
    return site


def check_new_library_name(workspace, target, new_name):
    """RequestFailed when the new name of a Python library keyword is already used: by another
    keyword the library has or may have, or by what a call of it resolves to in a suite that
    imports the library (it would then run another keyword or become ambiguous)."""
    symbol = target.symbols[0]
    wanted = normalize(new_name)
    if wanted == normalize(symbol.name):
        return
    tree = ast.parse(workspace.text(symbol.path), filename=str(symbol.path))
    taken = {normalize(node.name) for node in ast.walk(tree)
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno - 1 != symbol.line}
    for name in [symbol.path.stem, *(node.name for node in tree.body if isinstance(node, ast.ClassDef))]:
        reading = workspace.library_reading(symbol.path, name)
        taken |= {normalize(keyword) for node, keyword in reading.keywords
                  if not (node.lineno - 1 == symbol.line)} | (reading.maybe or set())
    if wanted in taken:
        raise RequestFailed(f"Cannot rename {symbol.name} to {new_name}: Python library {symbol.path.name} already "
                            "has, or may have, a keyword or function of that name.")
    for path in workspace.workspace_files():
        if readable(workspace, path) is None:
            continue
        graph = workspace.graph(path)
        if not any(keyword_key(s) in target.keys for group in graph.groups for s in group):
            continue
        other = [s for s, _ in workspace.resolve_call(graph.groups, new_name) if keyword_key(s) not in target.keys]
        if other:
            raise RequestFailed(f"Cannot rename {symbol.name} to {new_name}: in {path.name} that name already calls "
                                f"{other[0].name} ({origin(other[0])}); the rename would change which keyword runs "
                                "there.")


def loop_closure(workspace, target):
    """(keys, sites) of every definition a rename must change together with the target's.

    A use in a FOR/WHILE body above a reassignment there is reached by the earlier definition
    (such as the suite variable) on the first iteration and by the local afterwards, so
    renaming only one of them would change what RF runs: both are renamed, with all their
    uses. A built-in or a suite variable defined in several imported files cannot join."""
    name, keys = target.symbols[0].name, target.keys
    while True:
        sites = list(variable_sites(workspace, target, keys))
        grown = keys
        for path, _, line, *_, found, _, _, carried in sites:
            if carried is None:
                continue
            grown = grown | found | {carried}
            if any(key[0] == "builtin" for key in grown) or sum(key[0] == "suite" for key in grown) > 1:
                reached = "a built-in variable" if any(key[0] == "builtin" for key in found) \
                    else "a variable defined in several imported files"
                raise RequestFailed(f"Cannot rename {name}: the use at {path.name}:{line + 1} is in a FOR/WHILE "
                                    f"loop that reassigns it, so it is also reached by {reached}.")
        if grown == keys:
            return keys, sites
        keys = grown


def rename_sites(workspace, target):
    """Every (path, line text, line, start, end, is `$name`) a rename edits, or RequestFailed:
    never a partial edit."""
    check_renamable(target)
    name = target.symbols[0].name
    if target.kind == "keyword":
        definition = target.symbols[0]
        if definition.kind == "library":
            sites = [library_site(workspace, definition)]  # the name in `@keyword("Name")`
        else:
            lines = workspace.text(definition.path).splitlines()
            sites = [(definition.path, lines[definition.line], definition.line, definition.column,
                      definition.column + definition.length, False)]
        for path, text, line, start, end, keys, _ in keyword_sites(workspace, target):
            if keys != target.keys:
                raise RequestFailed(f"Cannot rename {name}: the call at {path.name}:{line + 1} is ambiguous; "
                                    "qualify it with its library or resource name first.")
            sites.append((path, text, line, start, end, False))
        return sites
    sites = []
    keys, found = loop_closure(workspace, target)
    for path, text, line, start, end, resolved, _, expression, _ in found:
        if not resolved <= keys:
            raise RequestFailed(f"Cannot rename {name}: the use at {path.name}:{line + 1} is ambiguous.")
        sites.append((path, text, line, start, end, expression))
    for path, text, line, start, end, unambiguous in named_argument_sites(workspace, target):
        if not unambiguous:
            raise RequestFailed(f"Cannot rename {name}: the call passing it by name at {path.name}:{line + 1} "
                                "is ambiguous.")
        sites.append((path, text, line, start, end, False))
    return sites


def prepare_rename(workspace, uri, position):
    target = target_at(workspace, uri, position)
    if target is None:
        return None
    rename_sites(workspace, target)  # the same refusals as rename, before the user types a name
    if target.kind == "keyword" and target.symbols[0].kind == "library":
        # At the Python function name the rename box starts with the keyword's name it changes.
        return {"range": target.range(), "placeholder": target.symbols[0].name}
    return {"range": target.range(), "placeholder": target.text[target.start:target.end]}


def valid_keyword_name(name):
    """One cell (single regular spaces only) that stays a callable keyword name."""
    return bool(name) and "  " not in name and not any(c.isspace() and c != " " for c in name) \
        and not re.search(r"[$@&%]\{", name) and not name.startswith(("#", "...", "[", "*")) \
        and name not in RESERVED


def valid_variable_name(name):
    return bool(name) and "  " not in name and not any(c.isspace() and c != " " for c in name) \
        and not INVALID_VARIABLE_CHARACTERS & set(name)


def rename(workspace, uri, position, new_name):
    if not isinstance(new_name, str):
        raise TypeError("newName must be a string")
    target = target_at(workspace, uri, position)
    if target is None:
        raise RequestFailed("Nothing to rename here: place the cursor on a keyword or variable.")
    new_name = new_name.strip()
    if target.kind == "keyword" and not valid_keyword_name(new_name):
        raise RequestFailed("A keyword name must be one non-empty cell: no tabs, line breaks, other whitespace "
                            "or two consecutive spaces, no variables, no leading #, [, * or ..., and no "
                            "control-structure marker such as END.")
    if target.kind == "variable":
        if whole := re.fullmatch(r"[$@&]\{(.*)\}", new_name):
            new_name = whole[1].strip()
        if not valid_variable_name(new_name):
            raise RequestFailed("A variable name must be non-empty and contain no braces, sigils, `.`, `[`, `]`, "
                                "`:`, `=`, backslashes, tabs, line breaks or two consecutive spaces.")
    sites = rename_sites(workspace, target)
    if target.kind == "keyword" and target.symbols[0].kind == "library":
        quote = sites[0][1][sites[0][3] - 1]
        if quote in new_name or "\\" in new_name:
            raise RequestFailed(f"Cannot rename to {new_name}: the name is written in a Python string between {quote} "
                                "quotes, so it cannot contain that quote or a backslash.")
        check_new_library_name(workspace, target, new_name)
    # RF resolves `$my_total` to `${my total}` (spaces and underscores are ignored), but an
    # expression name must stay a Python identifier.
    expression_name = new_name.replace(" ", "_")
    for path, _, line, *_, expression in sites:
        if expression and not expression_name.isidentifier():
            raise RequestFailed(f"Cannot rename to {new_name}: {path.name}:{line + 1} uses the variable as "
                                f"$name in a Python expression, where {expression_name} is not a valid name.")
    changes, seen = {}, set()
    for path, text, line, start, end, expression in sites:
        item = location(path, text, line, start, end)
        if (item["uri"], line, start) not in seen:
            seen.add((item["uri"], line, start))
            changes.setdefault(item["uri"], []).append(
                {"range": item["range"], "newText": expression_name if expression else new_name})
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


def outline(workspace, path, children=True):
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
                nested, seen = [], set()
                for symbol in workspace.scope_variables(path, item, item.end_lineno) if children else ():
                    base = variable_base(symbol.name[2:-1])
                    if base not in seen:  # one child per variable: its first definition
                        seen.add(base)
                        place = symbol.location()["range"]
                        nested.append((symbol.name, VARIABLE_SYMBOL,
                                       "Argument" if symbol.kind == "argument" else "Local variable",
                                       place, place, []))
                if kind == "Keyword":
                    symbol_kind, detail = FUNCTION, "Keyword"
                else:
                    symbol_kind, detail = METHOD, "Task" if header == "TASK HEADER" else "Test case"
                result.append((token.value, symbol_kind, detail, block_range(lines, item), selection, nested))
    return result


def document_symbols(workspace, uri, hierarchical=True):
    """Nested DocumentSymbols, or flat SymbolInformation for a client without hierarchy support."""
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        return []

    def nested(entry):
        name, kind, detail, whole, selection, children = entry
        return {"name": name, "kind": kind, "detail": detail, "range": whole, "selectionRange": selection,
                "children": [nested(child) for child in children]}

    def flat(entry, container=None):
        name, kind, _, whole, _, children = entry
        item = {"name": name, "kind": kind, "location": {"uri": path.as_uri(), "range": whole}}
        if container:
            item["containerName"] = container
        return [item, *(child for entry in children for child in flat(entry, name))]
    entries = outline(workspace, path)
    if hierarchical:
        return [nested(entry) for entry in entries]
    return [item for entry in entries for item in flat(entry)]


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
        for name, kind, detail, _, selection, _ in outline(workspace, path, children=False):
            if kind != VARIABLE_SYMBOL and fuzzy(query, name):
                result.append({"name": name, "kind": kind, "containerName": f"{detail} · {path.name}",
                               "location": {"uri": path.as_uri(), "range": selection}})
    return result

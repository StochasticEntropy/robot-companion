"""LSP 3.17 inlay hints: argument names and declared return types of keyword calls.

A call gets hints only when definition's import-aware resolution (`Workspace.resolve_call`)
finds exactly one keyword with a statically read signature, so an ambiguous, unresolved or
embedded-argument call gets none. Argument names follow RF's own argument specification:
a value written as `name=value` already names its argument, and nothing after a named
argument or a `@{list}`/`&{dict}` expansion is mapped, because RF decides those only at run
time. A return type is shown only as declared (`-> Record`), after a single untyped `${var}=`
assignment. Nothing is guessed. Positions are LSP UTF-16 units. README.md ("Owned inlay
hints") documents the labels.
"""

from . import features
from .workspace import FIXTURES, ROBOT_SUFFIXES, Workspace, uri_path

TYPE, PARAMETER = 1, 2  # LSP InlayHintKind
POSITIONAL = ("POSITIONAL_ONLY", "POSITIONAL_OR_NAMED")
# Settings whose keyword's arguments follow in the same statement; a template's are in its data rows.
ARGUMENT_FIXTURES = FIXTURES - {"Template", "TestTemplate"}


def call_of(node):
    """(keyword token, argument tokens) of a keyword call or a setup/teardown setting, else None."""
    kind = type(node).__name__
    if kind == "KeywordCall":
        keyword = node.get_token("KEYWORD")
    elif kind in ARGUMENT_FIXTURES:
        keyword = node.get_token("NAME")
        if keyword is not None and not Workspace.keyword_cell(node, keyword):
            keyword = None  # `NONE` disables the fixture
    else:
        return None
    if keyword is None or not keyword.value:
        return None
    return keyword, [token for token in node.tokens if token.type == "ARGUMENT"]


def expansion(value):
    """True for a cell RF expands into several arguments: `@{list}`, `&{dict}`, also with `[item]`."""
    from robot.variables import search_variable
    match = search_variable(value, ignore_errors=True)
    return match.start == 0 and match.end == len(value) and match.identifier in "@&"


def argument_hints(symbol, arguments):
    """(token, column, label, kind, tooltip) before each positional value whose argument RF's spec names."""
    spec = symbol.args
    parameters = [a for a in spec if a.kind in POSITIONAL]
    index = 0
    for token in arguments:
        if expansion(token.value) or features.named_target(spec, token.value) is not None:
            return  # what follows is mapped only when RF runs the call
        if index == len(parameters):
            return  # `*varargs` or too many values: no single argument name applies
        parameter = parameters[index]
        index += 1
        # A positional-only argument cannot be written `name=value`.
        label = f"{parameter.name}:" if parameter.kind == "POSITIONAL_ONLY" else f"{parameter.name}="
        yield token, 0, label, PARAMETER, f"Argument {parameter.name} of {symbol.name} · {features.origin(symbol)}"


def return_hint(symbol, node):
    """(token, column, label, kind, tooltip) after a single untyped `${var}=` assignment of a declared return type."""
    from robot.variables import search_variable
    returns = str(symbol.args.return_type or "")
    assigns = [token for token in node.tokens if token.type == "ASSIGN"] if type(node).__name__ == "KeywordCall" else []
    if not returns or len(assigns) != 1:
        return
    token = assigns[0]
    match = search_variable(token.value, ignore_errors=True)
    if match.start != 0 or match.identifier != "$" or match.items or ":" in match.base or \
            token.value[match.end:].strip() not in ("", "="):
        return  # a typed (`${n: int}=`), item (`${d}[k]=`), list or dictionary assignment
    yield token, match.end, f": {returns}", TYPE, f"Declared return type of {symbol.name} · {features.origin(symbol)}"


def collect(workspace, path, lines=None):
    """[(line, UTF-16 character, label, kind, tooltip)] in document order."""
    from .discovery import Positions  # discovery imports the LSP module
    text = workspace.text(path)
    bom = int(text.startswith("﻿"))  # RF drops it; LSP counts it on the first line
    positions = Positions(text[bom:])
    graph = workspace.graph(path)
    resolved, found = {}, []
    for node, _ in Workspace.walk(graph.model):
        # A continuation can hold an argument hint even when its keyword is above
        # the viewport. Inspect all statement tokens before skipping resolution.
        if lines is not None and not any(lines[0] <= token.lineno - 1 <= lines[1]
                                         for token in getattr(node, "tokens", ())):
            continue
        call = call_of(node)
        if call is None:
            continue
        keyword, arguments = call
        if keyword.value not in resolved:
            symbols = [symbol for symbol, _ in workspace.resolve_call(graph.groups, keyword.value)]
            # Exactly one target with a statically read signature; an embedded-argument
            # keyword takes its arguments from its name.
            single = symbols[0] if len(symbols) == 1 else None
            resolved[keyword.value] = single if single and single.args is not None and "${" not in single.name else None
        symbol = resolved[keyword.value]
        if symbol is None:
            continue
        for token, column, label, kind, tooltip in [*return_hint(symbol, node), *argument_hints(symbol, arguments)]:
            if not 0 < token.lineno <= len(positions.lines):
                continue
            position = positions.position(token.lineno - 1, token.col_offset + column)
            shift = bom if position["line"] == 0 else 0
            found.append((position["line"], position["character"] + shift, label, kind, tooltip))
    return sorted(found)


def hints(workspace, uri, request_range):
    """The hints positioned inside `request_range` (UTF-16 positions, both ends included)."""
    path = uri_path(uri)
    first, last = request_range["start"], request_range["end"]
    begin, finish = (first["line"], first["character"]), (last["line"], last["character"])
    if any(type(value) is not int or value < 0 for value in (*begin, *finish)) or finish < begin:
        raise ValueError("Invalid range")
    if path.suffix not in ROBOT_SUFFIXES:
        return []
    return [{"position": {"line": line, "character": character}, "label": label, "kind": kind, "tooltip": tooltip}
            for line, character, label, kind, tooltip in collect(workspace, path, (begin[0], finish[0]))
            if begin <= (line, character) <= finish]

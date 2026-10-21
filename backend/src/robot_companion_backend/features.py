"""Hover, completion and signature help from the same import-aware resolution as definition."""

from collections import Counter
import re

from .workspace import VARIABLE, normalize, utf16_column

FUNCTION, VARIABLE_ITEM, PLAIN_TEXT = 3, 6, 1  # CompletionItemKind, InsertTextFormat
MARKERS = ("POSITIONAL_ONLY_MARKER", "NAMED_ONLY_MARKER")
# Body indentation, optionally followed by assignment cells: the next cell is a keyword call.
CALL_PREFIX = re.compile(r"(?: {2,}|\t)[ \t]*(?:[$@&]\{[^}]*\} ?=?(?: {2,}|\t)[ \t]*)*")
OPEN_VARIABLE = re.compile(r"([$@&%])\{([^{}]*)$")
# After the cursor: the rest of a name (`${OUT|PUT DIR}`), an optional `.attr`/`[item]` suffix, then `}`.
REST_OF_NAME = re.compile(r"[^{}$@&%\s.\[\]]*(?: [^{}$@&%\s.\[\]]+)*([.\[][^{}$@&%\s]*(?: [^{}$@&%\s]+)*)?\}")


class Markup:
    """Markdown only when the client lists it; user documentation is escaped, never trusted."""

    def __init__(self, formats):
        self.markdown = "markdown" in (formats or ())

    def escape(self, text):
        return re.sub(r"([\\`*_{}\[\]()#+\-.!<>|~])", r"\\\1", text) if self.markdown else text

    def strong(self, text):
        return f"**{self.escape(text)}**" if self.markdown else text

    def code(self, text):
        if not self.markdown:
            return text
        fence = "`" * (max(map(len, re.findall("`+", text)), default=0) + 1)
        return f"{fence} {text} {fence}" if text.startswith("`") or text.endswith("`") else f"{fence}{text}{fence}"

    def block(self, text):
        if not self.markdown:
            return text
        fence = "`" * max(3, max(map(len, re.findall("`+", text)), default=0) + 1)
        return f"{fence}text\n{text}\n{fence}"

    def documentation(self, symbol):
        # RF's own standard libraries ship Markdown documentation; other docs are escaped.
        return symbol.doc if self.markdown and symbol.doc_format == "MARKDOWN" else self.escape(symbol.doc)

    def content(self, parts, separator="\n\n"):
        return {"kind": "markdown" if self.markdown else "plaintext", "value": separator.join(parts)}


def text_range(text, line, start, end):
    return {"start": {"line": line, "character": utf16_column(text, start)},
            "end": {"line": line, "character": utf16_column(text, end)}}


def origin(symbol):
    if symbol.kind == "local":
        return f"Local keyword · {symbol.path.name}"
    if symbol.kind == "resource":
        return f"Resource {symbol.path.name}"
    if symbol.kind == "library":
        return f"Library {symbol.namespace} · {symbol.path.name}"
    return f"Standard library {symbol.namespace}"


def signature_cells(symbol):
    return [symbol.name, *(str(argument) for argument in symbol.args or ())]


def keyword_hover(symbols, markup):
    blocks = []
    for symbol in symbols:
        parts = [f"{markup.strong(symbol.name)} · {markup.escape(origin(symbol))}",
                 markup.block("    ".join(signature_cells(symbol)))]
        if symbol.args is None:
            parts.append(markup.escape("Arguments could not be read statically."))
        elif str(symbol.args.return_type or ""):
            parts.append(f"Returns {markup.code(str(symbol.args.return_type))}")
        if symbol.doc:
            parts.append(markup.documentation(symbol))
        blocks.append("\n\n".join(parts))
    if len(symbols) > 1:
        blocks.insert(0, markup.escape(f"Ambiguous keyword: {len(symbols)} matches; qualify its library/resource."))
    return markup.content(blocks, "\n\n---\n\n" if markup.markdown else "\n\n")


def variable_source(symbol):
    if symbol.kind == "builtin":
        return "Robot Framework built-in variable"
    where = f"{symbol.path.name}, line {symbol.line + 1}"
    return {"suite": f"Suite variable · Variables section of {where}",
            "argument": f"Argument of {symbol.owner} ({where})",
            "assign": f"Assigned in {symbol.owner} ({where})",
            "var": f"Created with VAR in {symbol.owner} ({where})",
            "for": f"FOR loop variable in {symbol.owner} ({where})",
            "except": f"EXCEPT AS variable in {symbol.owner} ({where})"}[symbol.kind]


def variable_value(symbol, markup):
    """Only statically written values; anything decided at run time is said to be unknown."""
    if symbol.kind in ("suite", "var"):
        written = "    ".join(symbol.value or ())
        dynamic = " It refers to variables resolved at run time." if VARIABLE.search(written) else ""
        return f"Value as written: {markup.code(written)}" + markup.escape(dynamic) if written else \
            markup.escape("Value as written: empty")
    if symbol.kind == "argument":
        if symbol.value:
            return f"Default as written: {markup.code(symbol.value[0])}"
        return markup.escape("Value is supplied by the caller at run time.")
    if symbol.kind == "assign":
        if symbol.value:
            return f"Value is returned by {markup.code(symbol.value[0])} at run time."
        return markup.escape("Value is assigned at run time.")
    if symbol.kind == "for":
        return markup.escape("Value is set by the loop at run time.")
    if symbol.kind == "except":
        return markup.escape("Value is the caught error message at run time.")
    if symbol.name == "${CURDIR}":
        return f"Value: {markup.code(symbol.value[0])} (directory of this file)"
    if symbol.value:
        return markup.escape(f"Value: {symbol.value[0]}")
    return markup.escape("Value is set by Robot Framework at run time.")


def variable_hover(symbols, markup):
    blocks = [f"{markup.code(s.name)} · {markup.escape(variable_source(s))}\n\n{variable_value(s, markup)}"
              for s in symbols]
    return markup.content(blocks, "\n\n---\n\n" if markup.markdown else "\n\n")


def hover(workspace, uri, position, markup):
    path, text, line, column = workspace.locate(uri, position)
    graph = workspace.graph(path)
    node, owner, token = workspace.token_at(graph.model, line, column)
    if token is None:
        return None
    match, variable = workspace.variable_at(token, column)
    if match:
        symbols = workspace.variable_definitions(path, graph, owner, variable, line,
                                                 workspace.defining_statement(node, token), token.type == "ASSIGN")
        start = token.col_offset + match.start()
        if symbols:
            return {"contents": variable_hover(symbols, markup),
                    "range": text_range(text, line, start, start + len(match[0]))}
        return None
    if workspace.call_at(graph.groups, node, token) is None:
        return None
    symbols = workspace.resolve(graph.groups, token.value)
    if not symbols:
        return None
    return {"contents": keyword_hover(symbols, markup),
            "range": text_range(text, line, token.col_offset, token.end_col_offset)}


def statement_at(workspace, owner, line, column):
    """Innermost statement of `owner` spanning `line` that starts at or before the cursor."""
    found = None
    for node, _ in workspace.walk(owner):
        tokens = getattr(node, "tokens", None)
        if tokens and node.lineno <= line + 1 <= node.end_lineno \
                and (tokens[0].lineno, tokens[0].col_offset) <= (line + 1, column):
            found = node
    return found


def run_keyword_cell(workspace, graph, statement, text, line, column):
    """(start, end) of the keyword name argument at the cursor that a run-keyword variant runs
    (`Run Keyword    Na|`), by the same rules as definition: an existing cell, or a new one
    after a cell separator at the end of the statement (`Run Keyword    |`)."""
    if statement is None:
        return None
    for call in workspace.calls(graph.groups, statement):
        token = call.token
        if call.indirect and token.lineno == line + 1 and token.col_offset <= column <= token.end_col_offset:
            return token.col_offset, token.end_col_offset
    cells = [t for t in statement.tokens if t.type not in ("SEPARATOR", "EOL", "EOS", "CONTINUATION", "COMMENT")]
    if text[column:].strip() or not cells or (cells[-1].lineno, cells[-1].end_col_offset) > (line + 1, column):
        return None
    last = cells[-1]
    separated = re.fullmatch(r"(?: {2,}|\t)[ \t]*", text[last.end_col_offset:column]) if last.lineno == line + 1 \
        else re.fullmatch(r"[ \t]*\.\.\.(?: {2,}|\t)[ \t]*", text[:column])
    if not separated:
        return None
    from robot.parsing.lexer import Token
    typed = Token("ARGUMENT", "", line + 1, column)
    if any(call.token is typed for call in workspace.calls(graph.groups, statement, [typed])):
        return column, column
    return None


def variable_detail(symbol):
    if symbol.kind == "builtin":
        return "Built-in variable"
    if symbol.kind == "suite":
        return f"Suite variable · {symbol.path.name}"
    if symbol.kind == "argument":
        return f"Argument of {symbol.owner}"
    return f"Local variable in {symbol.owner}"


def completion(workspace, uri, position):
    path, text, line, column = workspace.locate(uri, position)
    graph = workspace.graph(path)
    owner = workspace.owner_at(graph.model, line)
    prefix = text[:column]
    if opened := OPEN_VARIABLE.search(prefix):
        if opened[1] == "%":
            return {"isIncomplete": False, "items": []}  # environment variables are not modelled
        # Replace the rest of the name and its closing brace (an editor's auto-closed `}`),
        # but keep an extended-syntax suffix: `${rec|ord.name}` replaces `${record` only.
        closing = REST_OF_NAME.match(text[column:])
        suffix = closing is not None and closing[1] is not None
        end = column if closing is None else column + (closing.start(1) if suffix else closing.end())
        edit_range = text_range(text, line, opened.start(), end)
        statement = statement_at(workspace, owner, line, column) if owner else None
        items, labels = [], set()
        for index, symbol in enumerate(workspace.visible_variables(path, graph, owner, line, statement)):
            label = f"{opened[1]}{{{symbol.name[2:-1].split(':', 1)[0].strip()}}}"
            if label not in labels:
                labels.add(label)
                items.append({"label": label, "kind": VARIABLE_ITEM, "detail": variable_detail(symbol),
                              "sortText": f"{index:04d}", "insertTextFormat": PLAIN_TEXT,
                              "textEdit": {"range": edit_range, "newText": label[:-1] if suffix else label}})
        return {"isIncomplete": False, "items": items}
    if owner is None or line + 1 <= owner.lineno:
        return {"isIncomplete": False, "items": []}  # settings and headers are not keyword-call cells
    statement = statement_at(workspace, owner, line, column)
    token = next((t for t in getattr(statement, "tokens", ()) if t.type == "KEYWORD" and t.lineno == line + 1
                  and t.col_offset <= column <= t.end_col_offset), None)
    if token is not None:
        start, end = token.col_offset, token.end_col_offset
    elif CALL_PREFIX.fullmatch(prefix) and not text[column:].strip():
        start = end = column
    elif (cell := run_keyword_cell(workspace, graph, statement, text, line, column)) is not None:
        start, end = cell
    else:
        return {"isIncomplete": False, "items": []}
    edit_range = text_range(text, line, start, end)
    typed = text[start:column]
    namespaces = {normalize(s.namespace) for group in graph.groups[1:] for s in group}
    qualifier = next((typed[:i] for i in range(len(typed) - 1, -1, -1)
                      if typed[i] == "." and normalize(typed[:i]) in namespaces), None)
    candidates = []
    if qualifier is not None:
        for rank, group in enumerate(graph.groups[1:], 1):
            candidates += [(rank, f"{qualifier}.{s.name}", s) for s in group
                           if normalize(s.namespace) == normalize(qualifier)]
    else:
        shadowed = set()
        for rank, group in enumerate(graph.groups):
            names = Counter(normalize(s.name) for s in group)
            for symbol in group:
                key = normalize(symbol.name)
                if key not in shadowed:
                    # Same-precedence duplicates are inserted qualified, never as an ambiguous call.
                    label = symbol.name if names[key] == 1 or rank == 0 else f"{symbol.namespace}.{symbol.name}"
                    candidates.append((rank, label, symbol))
            shadowed.update(names)
    items, seen = [], set()
    for rank, label, symbol in candidates:
        if (label, symbol.path, symbol.line) not in seen:
            seen.add((label, symbol.path, symbol.line))
            items.append({"label": label, "kind": FUNCTION, "detail": origin(symbol),
                          "sortText": f"{rank}{label.casefold()}", "insertTextFormat": PLAIN_TEXT,
                          "textEdit": {"range": edit_range, "newText": label}})
    return {"isIncomplete": False, "items": items}


def named_target(spec, value):
    """RF `name=value` syntax: the parameter it names, or None for a positional value.

    RF's own split ignores `=` escaped or inside a variable or `${{expression}}`."""
    from robot.utils import split_from_equals
    name, rest = split_from_equals(value)
    if rest is None or not name:
        return None
    names = {a.name for a in spec if a.kind in ("POSITIONAL_OR_NAMED", "NAMED_ONLY")}
    return name if name in names else spec.var_named


def active_parameter(spec, before, current):
    parameters = [a for a in spec if a.kind not in MARKERS]
    target = named_target(spec, current)
    if target is not None:
        return next(i for i, a in enumerate(parameters) if a.name == target)
    count = sum(named_target(spec, value) is None for value in before)
    slots = [i for i, a in enumerate(parameters) if a.kind in ("POSITIONAL_ONLY", "POSITIONAL_OR_NAMED")]
    if count < len(slots):
        return slots[count]
    # Past the last parameter: an index outside `parameters`. LSP 3.17 lets a client
    # default that to 0; VS Code highlights no parameter.
    return next((i for i, a in enumerate(parameters) if a.kind == "VAR_POSITIONAL"), len(parameters))


def signature_information(symbol, before, current, markup):
    label, parameters = symbol.name, []
    for argument in symbol.args or ():
        label += "    "
        text = str(argument)
        if argument.kind not in MARKERS:
            start = utf16_column(label, len(label))
            parameters.append({"label": [start, start + utf16_column(text, len(text))]})
        label += text
    parts = [markup.escape(origin(symbol))]
    if symbol.doc:
        parts.append(markup.documentation(symbol))
    return {"label": label, "parameters": parameters, "documentation": markup.content(parts),
            "activeParameter": active_parameter(symbol.args, before, current) if symbol.args is not None else 0}


def signature_help(workspace, uri, position, markup):
    path, text, line, column = workspace.locate(uri, position)
    graph = workspace.graph(path)
    owner = workspace.owner_at(graph.model, line)
    statement = statement_at(workspace, owner, line, column) if owner else None
    keyword = statement.get_token("KEYWORD") if type(statement).__name__ == "KeywordCall" else None
    here = (line + 1, column)
    if keyword is None or here <= (keyword.lineno, keyword.end_col_offset):
        return None
    before, current = [], None
    for token in statement.tokens:
        if token.type != "ARGUMENT":
            continue
        if (token.lineno, token.col_offset) <= here <= (token.lineno, token.end_col_offset):
            current = token.value
            break
        if (token.lineno, token.end_col_offset) < here:
            before.append(token)
    if current is None:
        previous = before[-1] if before else keyword
        # A single space continues the previous cell; RF separates cells with 2+ spaces or a tab.
        if previous.lineno == line + 1 and not re.search(r" {2}|\t", text[previous.end_col_offset:column]):
            if previous is keyword:
                return None
            current = before.pop().value
    symbols = workspace.resolve(graph.groups, keyword.value)
    if not symbols:
        return None
    values = [token.value for token in before]
    signatures = [signature_information(s, values, current or "", markup) for s in symbols]
    return {"signatures": signatures, "activeSignature": 0, "activeParameter": signatures[0]["activeParameter"]}

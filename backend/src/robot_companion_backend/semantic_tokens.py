"""LSP 3.17 semantic tokens from RF's own model and definition's import-aware resolution.

Every token is one RF model token (or a part of it: a variable, a BDD prefix), never a
scan of the line. A keyword call is `resolved` when the resolution of
`Workspace.resolve_call` (one BDD prefix ignored only when the full name matches
nothing) finds a definition with a source location: exactly when definition returns one. The legend is documented in README.md
("Semantic tokens").

Whole-document results carry a `resultId`; `full/delta` answers with edits against the
last whole-document result of that document, or with a whole result when the ID is not
that one (stale, unknown, evicted, or from an earlier service process). Deltas never
change token meaning: they are computed from the same complete token set as `full`.
"""

from array import array
from collections import OrderedDict
import secrets

from .workspace import BDD_PREFIX, ROBOT_SUFFIXES, Workspace, uri_path

TOKEN_TYPES = ("namespace", "property", "class", "function", "variable", "comment", "keyword", "macro",
               "operator")
TOKEN_MODIFIERS = ("declaration", "resolved", "defaultLibrary")
LEGEND = {"tokenTypes": list(TOKEN_TYPES), "tokenModifiers": list(TOKEN_MODIFIERS)}
HEADER, SETTING, TEST, KEYWORD, VARIABLE, COMMENT, CONTROL, BDD, CONTINUATION = range(len(TOKEN_TYPES))
DECLARATION, RESOLVED, DEFAULT_LIBRARY = (1 << index for index in range(len(TOKEN_MODIFIERS)))
CONTROL_TOKENS = frozenset(("FOR", "FOR SEPARATOR", "END", "IF", "INLINE IF", "ELSE IF", "ELSE", "TRY", "EXCEPT",
                            "FINALLY", "AS", "WITH NAME", "WHILE", "BREAK", "CONTINUE", "RETURN STATEMENT", "VAR",
                            "GROUP"))
# Documents whose last whole-document result is kept for `full/delta`, least recently used first out.
MAX_RESULTS = 64
# Statements whose first variable in a VARIABLE/ARGUMENT cell defines that variable.
DEFINING = {"Variable": "VARIABLE", "Arguments": "ARGUMENT", "ForHeader": "VARIABLE", "ExceptHeader": "VARIABLE",
            "Var": "VARIABLE"}
SKIPPED = frozenset(("SEPARATOR", "EOL", "EOS", "ERROR", "FATAL ERROR", "INVALID HEADER", "FATAL INVALID HEADER",
                     "CONFIG"))


def variable_spans(value, offset=0):
    """(start, end) of each `${}` `@{}` `&{}` `%{}` variable RF substitutes in `value`, by RF's
    own variable search. A variable is one token including any nested name or inline Python
    (`${greet_${lang}}`, `${{ $x + 1 }}`); variables in its `[item]` access follow it."""
    from robot.variables import search_variable
    position = 0
    while (match := search_variable(value[position:], ignore_errors=True)).start >= 0:
        start = position + match.start
        end = start + len(match.name)
        if match.identifier in "$@&%":
            yield offset + start, offset + end
        for item in match.items:  # `[item]` cells follow the closing brace in order
            yield from variable_spans(item, offset + end + 1)
            end += len(item) + 2
        position += match.end


def variable_extents(value):
    """(start, end) of each top-level variable in `value`, including its `[item]` access."""
    from robot.variables import search_variable
    position = 0
    while (match := search_variable(value[position:], ignore_errors=True)).start >= 0:
        yield position + match.start, position + match.end
        position += match.end


def split(value, offset, kind, modifiers, variable_modifiers=0):
    """`value` as `kind` tokens around its variables (item access included); whitespace-only
    parts are dropped."""
    position = 0
    for start, end in [*variable_extents(value), (len(value), len(value))]:
        part = value[position:start]
        stripped = part.strip()
        if stripped:
            begin = position + len(part) - len(part.lstrip())
            yield offset + begin, len(stripped), kind, modifiers
        for first, last in variable_spans(value[start:end], start):
            yield offset + first, last - first, VARIABLE, variable_modifiers
        position = end


class Classifier:
    def __init__(self, workspace, graph):
        self.workspace, self.groups, self.calls = workspace, graph.groups, {}

    def call(self, name):
        """(BDD prefix length, modifiers) of a keyword call, with definition's resolution."""
        if name not in self.calls:
            found = self.workspace.resolve_name(self.groups, name)
            prefix = BDD_PREFIX.match(name)
            # RF ignores one English BDD prefix only when the full name matches no keyword.
            bdd = prefix.end() if prefix and not found and name[prefix.end():] else 0
            if bdd:
                found = self.workspace.resolve_name(self.groups, name[bdd:])
            # As for definition, which returns only symbols with a source location.
            found = [s for s, _ in found if s.path is not None]
            modifiers = 0
            if found:
                modifiers = RESOLVED | (DEFAULT_LIBRARY if all(s.kind == "standard" for s in found) else 0)
            self.calls[name] = bdd, modifiers
        return self.calls[name]

    def tokens(self, node, token):
        """(code-point column, length, type, modifiers) for one RF token on its line."""
        kind, value, column = token.type, token.value, token.col_offset
        statement = type(node).__name__
        if kind in token.HEADER_TOKENS:
            yield column, len(value.rstrip()), HEADER, 0
        elif kind == "COMMENT":
            yield column, len(value), COMMENT, 0
        elif kind == "CONTINUATION":
            yield column, len(value), CONTINUATION, 0
        elif kind in CONTROL_TOKENS:
            yield column, len(value), CONTROL, 0
        elif kind in token.SETTING_TOKENS:
            yield column, len(value), SETTING, 0
        elif kind == "TESTCASE NAME":
            yield from split(value, column, TEST, DECLARATION)
        elif kind == "KEYWORD NAME":  # embedded arguments (`Greet ${name}`) are its arguments
            yield from split(value, column, KEYWORD, DECLARATION, DECLARATION)
        elif self.workspace.keyword_cell(node, token):
            bdd, modifiers = self.call(value)
            if bdd:
                yield column, len(value[:bdd].rstrip()), BDD, 0
            yield from split(value[bdd:], column + bdd, KEYWORD, modifiers)
        elif kind == "ASSIGN" or DEFINING.get(statement) == kind:
            spans = list(variable_spans(value))
            for index, (start, end) in enumerate(spans):
                defines = index == 0 and start == 0
                yield column + start, end - start, VARIABLE, DECLARATION if defines else 0
        else:
            for start, end in variable_spans(value):
                yield column + start, end - start, VARIABLE, 0


def collect(workspace, path):
    """Absolute tokens [(line, UTF-16 start, UTF-16 length, type, modifiers)] in LSP lines,
    sorted and without overlaps."""
    from .discovery import Positions  # discovery imports the LSP module
    text = workspace.text(path)
    bom = int(text.startswith("\ufeff"))  # RF drops it; LSP counts it on the first line
    positions = Positions(text[bom:])
    graph = workspace.graph(path)
    classifier = Classifier(workspace, graph)
    found = []
    for node, _ in Workspace.walk(graph.model):
        if type(node).__name__ == "Error":
            continue  # RF types the cells after an invalid statement's error as COMMENT
        for token in getattr(node, "tokens", ()):
            if token.type in SKIPPED or not token.value or not 0 < token.lineno <= len(positions.lines):
                continue
            line = token.lineno - 1
            for column, length, kind, modifiers in classifier.tokens(node, token):
                start = positions.position(line, column)
                end = positions.position(line, column + length)
                if length > 0 and end["line"] == start["line"] and end["character"] > start["character"]:
                    shift = bom if start["line"] == 0 else 0
                    found.append((start["line"], start["character"] + shift,
                                  end["character"] - start["character"], kind, modifiers))
    found.sort()
    result = []
    for token in found:
        if result and token[0] == result[-1][0] and token[1] < result[-1][1] + result[-1][2]:
            continue  # LSP tokens never overlap
        result.append(token)
    return result


def encode(tokens):
    """LSP relative encoding: line delta, start delta (from the previous start on its line),
    length, type index and modifier bits per token."""
    data, line, start = [], 0, 0
    for token_line, token_start, length, kind, modifiers in tokens:
        data += [token_line - line, token_start - start if token_line == line else token_start, length, kind,
                 modifiers]
        line, start = token_line, token_start
    return data


def document_tokens(workspace, path):
    return encode(collect(workspace, path) if path.suffix in ROBOT_SUFFIXES else [])


class Results:
    """The last whole-document result per document, for at most `limit` documents; one
    array of the encoded data each, nothing else."""

    def __init__(self, limit=MAX_RESULTS):
        # IDs of this service process never equal an ID an earlier (restarted) process issued.
        self.session, self.counter, self.limit = secrets.token_hex(8), 0, limit
        self.last = OrderedDict()  # path -> (resultId, array of the encoded data)

    def remember(self, path, data):
        self.counter += 1
        result_id = f"{self.session}-{self.counter}"
        self.last.pop(path, None)
        self.last[path] = result_id, array("I", data)
        while len(self.last) > self.limit:
            self.last.popitem(last=False)
        return result_id

    def previous(self, path, result_id):
        """The data of `result_id` if it is this document's last result, else None."""
        last = self.last.get(path)
        return last[1] if last and type(result_id) is str and last[0] == result_id else None

    def forget(self, path):
        self.last.pop(path, None)


def common(old, new, limit, backwards=False):
    """Number of equal leading (trailing) values of two arrays, at most `limit`."""
    count, step = 0, 4096
    while count < limit:  # whole chunks compare in C; the first unequal one value by value
        size = min(step, limit - count)
        a, b = (old[len(old) - count - size:len(old) - count], new[len(new) - count - size:len(new) - count]) \
            if backwards else (old[count:count + size], new[count:count + size])
        if a == b:
            count += size
            continue
        pairs = zip(reversed(a), reversed(b)) if backwards else zip(a, b)
        return count + next(index for index, (x, y) in enumerate(pairs) if x != y)
    return count


def edits(old, new):
    """At most one edit replacing whole tokens: the common token prefix and suffix are kept."""
    prefix = common(old, new, min(len(old), len(new)))
    prefix -= prefix % 5
    suffix = common(old, new, min(len(old), len(new)) - prefix, backwards=True)
    suffix -= suffix % 5
    if prefix == len(old) == len(new):
        return []
    return [{"start": prefix, "deleteCount": len(old) - prefix - suffix, "data": new[prefix:len(new) - suffix].tolist()}]


def full(workspace, uri, results):
    path = uri_path(uri)
    data = document_tokens(workspace, path)
    return {"resultId": results.remember(path, data), "data": data}


def delta(workspace, uri, previous_result_id, results):
    """Edits from `previous_result_id` when it is this document's last result; otherwise
    (stale, unknown, evicted or another process's ID) the whole current result."""
    path = uri_path(uri)
    data = document_tokens(workspace, path)
    previous = results.previous(path, previous_result_id)
    result_id = results.remember(path, data)
    if previous is None:
        return {"resultId": result_id, "data": data}
    return {"resultId": result_id, "edits": edits(previous, results.last[path][1])}


def in_range(workspace, uri, request_range):
    """Only tokens lying completely inside `request_range` (UTF-16 positions)."""
    path = uri_path(uri)
    first, last = request_range["start"], request_range["end"]
    begin, finish = (first["line"], first["character"]), (last["line"], last["character"])
    if any(type(value) is not int or value < 0 for value in (*begin, *finish)) or finish < begin:
        raise ValueError("Invalid range")
    tokens = collect(workspace, path) if path.suffix in ROBOT_SUFFIXES else []
    return {"data": encode([t for t in tokens if begin <= (t[0], t[1]) and (t[0], t[1] + t[2]) <= finish])}

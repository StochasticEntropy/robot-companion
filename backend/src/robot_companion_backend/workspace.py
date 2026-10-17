"""Source-only import graph: Robot's model for Robot, Python AST for libraries.

No library execution, workspace-wide name map, or dependency on the extension.
Graphs are rebuilt for each request from current overlays and disk dependencies.
"""

import ast
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


def uri_path(uri):
    parsed = urlsplit(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise ValueError("Only local file URIs are supported in v1")
    return Path(unquote(parsed.path)).resolve()


def normalize(name):
    return name.replace(" ", "").replace("_", "").casefold()


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
    path: Path
    line: int
    column: int
    length: int
    text: str
    namespace: str = ""

    def location(self):
        start = utf16_column(self.text, self.column)
        return {"uri": self.path.as_uri(), "range": {
            "start": {"line": self.line, "character": start},
            "end": {"line": self.line, "character": utf16_column(self.text, self.column + self.length)},
        }}


class Workspace:
    def __init__(self):
        self.documents = {}
        self.edges = {}

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

    def symbol(self, path, name, line, column, namespace=""):
        lines = self.text(path).splitlines()
        return Symbol(name, path, line - 1, column, len(name), lines[line - 1], namespace)

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
                column = line.index(node.name, prefix)
                symbols.append(Symbol(name, path, node.lineno - 1, column,
                                      len(node.name), line, namespace))
        return symbols

    def graph(self, root):
        local, resources, libraries, problems = [], [], [], []
        visited = set()
        self.edges = {}

        def visit(path, primary=False):
            if path in visited:
                return
            visited.add(path)
            self.edges[path] = []
            model = self.model(path)
            for node, _ in self.walk(model):
                kind = type(node).__name__
                if kind == "Keyword":
                    header = node.header
                    token = next(t for t in header.tokens if t.type == "KEYWORD NAME")
                    target = local if primary else resources
                    target.append(self.symbol(path, node.name, token.lineno, token.col_offset, path.stem))
                if kind not in ("ResourceImport", "LibraryImport"):
                    continue
                name = node.name
                if not name or "${" in name:
                    problems.append((path, node.lineno, "Unresolved dynamic import"))
                    continue
                candidate = path.parent / name
                if kind == "LibraryImport" and not name.endswith(".py"):
                    candidate = path.parent / (name.replace(".", "/") + ".py")
                candidate = candidate.resolve()
                self.edges[path].append(candidate)
                try:
                    if kind == "ResourceImport":
                        visit(candidate)
                    else:
                        namespace = node.alias or Path(name).stem
                        libraries.extend(self.python_symbols(candidate, namespace))
                except (OSError, SyntaxError, UnicodeError) as exc:
                    problems.append((path, node.lineno, f"Unresolved {kind}: {name}: {exc}"))
            return model

        model = visit(root, True)
        return model, (local, resources, libraries), problems

    @staticmethod
    def matches(symbol, name):
        if normalize(symbol.name) == normalize(name):
            return True
        if "${" in symbol.name:
            from robot.running.arguments.embedded import EmbeddedArguments
            embedded = EmbeddedArguments.from_name(symbol.name)
            return bool(embedded and embedded.match(name))
        return False

    def resolve(self, groups, name):
        # Robot prefers local keywords, then imported resources, then libraries.
        for group in groups:
            found = [s for s in group if self.matches(s, name)]
            if not found and "." in name:
                found = [s for s in group for index, char in enumerate(name)
                         if char == "." and normalize(name[:index]) == normalize(s.namespace)
                         and self.matches(s, name[index + 1:])]
            if found:
                return list({(s.path, s.line, s.column): s for s in found}.values())
        return []

    def token_at(self, model, line, column):
        for node, owner in self.walk(model):
            for token in getattr(node, "tokens", ()):
                if token.lineno == line + 1 and token.col_offset <= column < token.end_col_offset:
                    return node, owner, token
        return None, None, None

    def variable_definitions(self, path, model, owner, variable, line):
        suite, scoped = [], []
        for node, context in self.walk(model):
            kind = type(node).__name__
            if kind == "Variable":
                candidates = suite
                types = ("VARIABLE",)
            elif owner is not None and context is owner and node.lineno <= line + 1:
                candidates = scoped
                types = ("ASSIGN", "VARIABLE", "ARGUMENT") if kind in ("Arguments", "Var") else ("ASSIGN",)
            else:
                continue
            for token in getattr(node, "tokens", ()):
                if token.type not in types:
                    continue
                match = re.match(r"[$@&]\{([^}]+)\}", token.value)
                if match and normalize(match[1].split(":", 1)[0]) == normalize(variable):
                    candidates.append(self.symbol(path, match[0], token.lineno, token.col_offset))
        return scoped[-1:] or suite

    def definition(self, uri, position):
        path = uri_path(uri)
        text = self.text(path).splitlines()
        line = position["line"]
        if line < 0 or line >= len(text):
            raise ValueError("Line outside document")
        column = codepoint_column(text[line], position["character"])
        model, groups, _ = self.graph(path)
        _, owner, token = self.token_at(model, line, column)
        if token is None:
            return []
        for match in re.finditer(r"[$@&]\{([^}]+)\}", token.value):
            if token.col_offset + match.start() <= column < token.col_offset + match.end():
                variable = re.split(r"[.\[]", match[1])[0]
                return [s.location() for s in self.variable_definitions(path, model, owner, variable, line)]
        if token.type != "KEYWORD":
            return []
        return [s.location() for s in self.resolve(groups, token.value)]

    def diagnostics(self, uri):
        path = uri_path(uri)
        model, groups, problems = self.graph(path)
        result = []

        def add(line, message, code):
            result.append({"range": {"start": {"line": max(0, line - 1), "character": 0},
                                      "end": {"line": max(0, line - 1), "character": 0}},
                           "severity": 1, "source": "robot-companion-backend", "code": code, "message": message})

        for source, line, message in problems:
            if source == path:
                add(line, message, "import")
        for node, _ in self.walk(model):
            for error in getattr(node, "errors", ()):
                add(node.lineno, error, "syntax")
            for token in getattr(node, "tokens", ()):
                if token.type == "KEYWORD" and len(self.resolve(groups, token.value)) > 1:
                    add(token.lineno, f"Ambiguous keyword: {token.value}; qualify its library/resource", "ambiguity")
        return result

"""The keywords a Robot file can call, grouped by where they come from (`robotCompanion/documentKeywords`).

Built from the same import graph as definition, hover and rename: only the file itself, the
resources and libraries it imports (also through imported resources) and the standard
libraries it imports, with BuiltIn. A library that is not imported never appears. Each
keyword's documentation is its hover text, from the definition Robot Framework uses.
"""

import ast
from collections import defaultdict

from . import features
from .cancellation import checkpoint
from .navigation import RequestFailed, keyword_key
from .workspace import BDD_PREFIX, ROBOT_SUFFIXES, normalize, uri_path

MARKDOWN = features.Markup(("markdown",))


def location(path, line):
    """A zero-width location at the start of 0-based `line`."""
    point = {"line": line, "character": 0}
    return {"uri": path.as_uri(), "range": {"start": point, "end": point}}


class CallIndex:
    """Candidate groups for the shared resolver, built once for this listing."""

    def __init__(self, graph):
        self.groups = []
        self.namespaces = defaultdict(set)
        for group in graph.groups:
            exact = defaultdict(list)
            embedded = []
            for position, symbol in enumerate(group):
                checkpoint()
                exact[normalize(symbol.name)].append((position, symbol))
                if "${" in symbol.name:
                    embedded.append((position, symbol))
                self.namespaces[keyword_key(symbol)].add(symbol.namespace)
            self.groups.append((exact, embedded))

    def candidates(self, text):
        names = [text]
        if prefix := BDD_PREFIX.match(text):
            names.append(text[prefix.end():])
        keys = {normalize(name) for name in names}
        for name in names:
            # Dotted aliases and dotted keyword names make every dot a possible namespace boundary.
            keys.update(normalize(name[i + 1:]) for i, char in enumerate(name) if char == ".")
        for exact, embedded in self.groups:
            candidates = dict(embedded)
            for key in keys:
                candidates.update(exact.get(key, ()))
            yield [candidates[index] for index in sorted(candidates)]


def call_text(workspace, index, symbol):
    """Return the shortest spelling that resolves uniquely to this library instance."""
    key = keyword_key(symbol)
    texts = [symbol.name] if symbol.kind == "local" else [symbol.name, f"{symbol.namespace}.{symbol.name}"]
    for text in texts:
        pairs = workspace.resolve_call(list(index.candidates(text)), text)
        if len(pairs) != 1 or keyword_key(pairs[0][0]) != key:
            continue
        offset = pairs[0][1]
        prefix = normalize(text[:offset - 1]) if offset else None
        if sum(1 for ns in index.namespaces[key] if prefix is None or normalize(ns) == prefix) == 1:
            return text
    return None


def required(spec):
    """Arguments a call must pass: positional ones without a default, then named-only ones."""
    if spec is None:
        return None
    defaults = spec.defaults or {}
    return [{"name": name, "named": False} for name in spec.positional if name not in defaults] + \
        [{"name": name, "named": True} for name in spec.named_only if name not in defaults]


def keyword(workspace, index, symbol):
    spec = symbol.args
    return {
        "name": symbol.name,
        "kind": symbol.kind,
        **({"sourceKind": "declaration", "runtimeSignatureKnown": False} if symbol.declaration else {}),
        "namespace": symbol.namespace,
        "signature": None if spec is None else [str(argument) for argument in spec],
        "required": required(spec),
        "returnType": str(spec.return_type) if spec is not None and spec.return_type else None,
        "documentation": features.keyword_hover([symbol], MARKDOWN)["value"],
        "location": symbol.location() if symbol.path is not None else None,
        "call": call_text(workspace, index, symbol),
    }


def resource_documentation(workspace, path):
    model = workspace.model(path)
    for section in model.sections:
        if section.header is not None and section.header.type == "SETTING HEADER":
            for item in section.body:
                if type(item).__name__ == "Documentation":
                    return item.value
    return ""


def library_documentation(workspace, entry):
    """The docstring of the library class named by the import, else of its module."""
    try:
        tree = workspace.python_tree(entry.path)
    except (OSError, SyntaxError, UnicodeError, ValueError):
        return ""
    selector = entry.path.stem if entry.name.endswith(".py") else entry.name.rsplit(".", 1)[-1]
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == selector:
            return ast.get_docstring(node) or ""
    return ast.get_docstring(tree) or ""


def group(workspace, index, path, entries):
    """One group per library instance (or resource): RF shares one instance between every import
    of the same library under the same name, here or in an imported resource. `importedBy` is
    this file's own import when it has one, else the first; `importSites` lists them all."""
    entry = entries[0]
    written = [e for e in entries if e.importer is not None]  # not the implicit BuiltIn
    sites = [location(e.importer, e.line - 1) for e in written]
    own = next((site for e, site in zip(written, sites) if e.importer == path), None)
    if entry.kind == "resource":
        documentation = resource_documentation(workspace, entry.path)
    elif entry.kind == "library":
        documentation = library_documentation(workspace, entry)
    else:
        documentation = ""
    source = entry.path or next((s.path for s in entry.symbols if s.path is not None), None)
    return {
        "kind": entry.kind,
        "name": entry.name,
        "alias": entry.alias,
        "namespace": entry.namespace,
        "uri": source.as_uri() if source is not None else None,
        "importedBy": own or (sites[0] if sites else None),
        "importSites": sites,
        "documentation": MARKDOWN.escape(documentation),
        "keywords": [keyword(workspace, index, s) for s in entry.symbols],
    }


def instances(imports):
    """The graph's import statements grouped by library instance or resource file, in the order
    of each one's first import."""
    grouped = {}
    for entry in imports:
        grouped.setdefault((entry.kind, entry.namespace, str(entry.path or entry.name)), []).append(entry)
    return list(grouped.values())


def document_keywords(workspace, uri):
    path = uri_path(uri)
    if path.suffix not in ROBOT_SUFFIXES:
        raise RequestFailed(f"{path.name} is not a Robot Framework file (.robot or .resource).")
    graph = workspace.graph(path)
    index = CallIndex(graph)
    own = {
        "kind": "local", "name": path.name, "alias": None, "namespace": path.stem, "uri": path.as_uri(),
        "importedBy": None, "importSites": [], "documentation": "",
        "keywords": [keyword(workspace, index, s) for s in graph.groups[0]],
    }
    return {
        "uri": uri,
        "version": workspace.documents[path][0] if path in workspace.documents else None,
        "imports": [own, *(group(workspace, index, path, entries) for entries in instances(graph.imports))],
        "unresolved": [{**location(file, line - 1), "message": message} for file, line, message, _ in graph.problems],
    }

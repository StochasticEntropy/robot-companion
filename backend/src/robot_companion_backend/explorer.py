"""The keywords a Robot file can call, grouped by where they come from (`robotCompanion/documentKeywords`).

Built from the same import graph as definition, hover and rename: only the file itself, the
resources and libraries it imports (also through imported resources) and the standard
libraries it imports, with BuiltIn. A library that is not imported never appears. Each
keyword's documentation is its hover text, from the definition Robot Framework uses.
"""

import ast

from . import features
from .navigation import RequestFailed, keyword_key
from .workspace import ROBOT_SUFFIXES, normalize, uri_path

MARKDOWN = features.Markup(("markdown",))


def location(path, line):
    """A zero-width location at the start of 0-based `line`."""
    point = {"line": line, "character": 0}
    return {"uri": path.as_uri(), "range": {"start": point, "end": point}}


def reaching(graph, symbol, text, offset):
    """The names of the library instances in which `text` reaches `symbol`'s keyword. RF keeps
    one instance per import name (case-sensitive), so `LibA.py AS X` and `LibA.py AS Y` are two,
    and reports a call that reaches both as "Multiple keywords with name ... found"; a prefix
    (`X.`) is matched case- and space-insensitively."""
    key = keyword_key(symbol)
    prefix = normalize(text[:offset - 1]) if offset else None
    return {s.namespace for group in graph.groups for s in group
            if keyword_key(s) == key and (prefix is None or normalize(s.namespace) == prefix)}


def call_text(workspace, graph, symbol):
    """What to write in this file to call `symbol`: its name when that resolves to it alone,
    else `namespace.name` when that does (a resource's file stem or a library's alias or name),
    in one library instance only; None when neither does, for example two imports with the same alias."""
    key = keyword_key(symbol)
    texts = [symbol.name] if symbol.kind == "local" else [symbol.name, f"{symbol.namespace}.{symbol.name}"]
    for text in texts:
        pairs = workspace.resolve_call(graph.groups, text)
        if len(pairs) == 1 and keyword_key(pairs[0][0]) == key \
                and len(reaching(graph, symbol, text, pairs[0][1])) == 1:
            return text
    return None


def required(spec):
    """Arguments a call must pass: positional ones without a default, then named-only ones."""
    if spec is None:
        return None
    defaults = spec.defaults or {}
    return [{"name": name, "named": False} for name in spec.positional if name not in defaults] + \
        [{"name": name, "named": True} for name in spec.named_only if name not in defaults]


def keyword(workspace, graph, symbol):
    spec = symbol.args
    return {
        "name": symbol.name,
        "kind": symbol.kind,
        "namespace": symbol.namespace,
        "signature": None if spec is None else [str(argument) for argument in spec],
        "required": required(spec),
        "returnType": str(spec.return_type) if spec is not None and spec.return_type else None,
        "documentation": features.keyword_hover([symbol], MARKDOWN)["value"],
        "location": symbol.location() if symbol.path is not None else None,
        "call": call_text(workspace, graph, symbol),
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


def group(workspace, graph, path, entries):
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
        "keywords": [keyword(workspace, graph, s) for s in entry.symbols],
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
    own = {
        "kind": "local", "name": path.name, "alias": None, "namespace": path.stem, "uri": path.as_uri(),
        "importedBy": None, "importSites": [], "documentation": "",
        "keywords": [keyword(workspace, graph, s) for s in graph.groups[0]],
    }
    return {
        "uri": uri,
        "version": workspace.documents[path][0] if path in workspace.documents else None,
        "imports": [own, *(group(workspace, graph, path, entries) for entries in instances(graph.imports))],
        "unresolved": [{**location(file, line - 1), "message": message} for file, line, message, _ in graph.problems],
    }

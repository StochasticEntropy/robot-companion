"""Own class declarations behind statically traced keyword decorator factories.

This does not execute libraries or claim their runtime keyword/argument contract.
Only an explicitly selected class and a literal keyword name yield a declaration.
"""

import ast
from dataclasses import replace
import os
import sys

MAX_FACTORY_DEPTH = 24
STANDARD_KEYWORD = "robot.api.deco.keyword"
STANDARD_WRAPS = "functools.wraps"


def _search_path(workspace):
    """Resolve the interpreter directories once per request, never across requests."""
    from .workspace import search_path
    configured = tuple(workspace.search_path())
    return workspace.sources.analyse(("declaration-search-path", configured, tuple(sys.path), os.getcwd()),
        lambda: [*configured, *search_path()])


def _module(workspace, parts, directories):
    parts, directories = tuple(parts), tuple(directories)
    return workspace.sources.analyse(("declaration-module", parts, directories),
        lambda: _module_uncached(workspace, parts, directories))


def _module_uncached(workspace, parts, directories):
    """Python's package/module precedence, without importing a package."""
    paths = list(directories)
    for index, part in enumerate(parts):
        namespaces = []
        found = None
        for directory in paths:
            candidate = workspace.python_module(directory, part)
            if candidate is None:
                continue
            kind, path = candidate
            if kind == "namespace":
                namespaces.append(path)
                continue
            found = candidate
            break
        if found is None:
            paths = namespaces
            if not paths:
                return None
            continue
        kind, path = found
        if kind not in ("package", "module"):
            return None
        if index == len(parts) - 1:
            return path
        if kind != "package" or workspace.extends_path(path):
            return None
        paths = [path.parent]
    return None


def _import_module(workspace, path, node):
    if node.level:
        directory = path.parent
        for _ in range(node.level - 1):
            directory = directory.parent
        return _module(workspace, node.module.split("."), [directory]) if node.module else \
            directory / "__init__.py"
    return _module(workspace, node.module.split("."), _search_path(workspace)) \
        if node.module else None


def _module_names(workspace, path):
    """Bindings depend only on the same exact source as the cached Python tree."""
    from .workspace import ModuleNames
    source = workspace.source(path)
    if source.module_names is None:
        source.module_names = ModuleNames(workspace.python_tree(path))
    return source.module_names


def _names(workspace, path):
    from .workspace import REBINDING_CALLS, import_time
    source = workspace.source(path)
    if source.declaration_names is None:
        tree = workspace.python_tree(path)
        names = _module_names(workspace, path)
        dynamic = "__getattr__" in names.bindings or any(
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in REBINDING_CALLS
            for node, _ in import_time(tree))
        source.declaration_names = False if dynamic else names
    return source.declaration_names or None


def _lexical_names(body):
    from .workspace import ModuleNames, REBINDING_CALLS, import_time
    tree = ast.Module(body=body, type_ignores=[])
    if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
           and node.func.id in REBINDING_CALLS for node, _ in import_time(tree)):
        return None
    return ModuleNames(tree)


def _scope_names(workspace, path, scope):
    """Lexical bindings are intrinsic to the owning file's exact immutable AST."""
    body = [ast.Expr(value=scope.body)] if isinstance(scope, ast.Lambda) else scope.body
    return workspace.source(path).syntax(("declaration-scope", scope),
        lambda: _lexical_names(body))


def _reference(workspace, path, expression, scopes=()):
    """Resolve a pure local binding plan using this request's dependency state."""
    parts, root = [], expression
    while isinstance(root, ast.Attribute):
        parts.append(root.attr)
        root = root.value
    if not isinstance(root, ast.Name):
        return None
    parts = (root.id, *reversed(parts))
    plan = workspace.source(path).syntax(("declaration-reference", parts, scopes),
        lambda: _reference_plan(workspace, path, expression, root.id, scopes))
    if plan is None or isinstance(plan, str):
        return plan
    if plan[0] == "local":
        return path, plan[1]
    # Only the binding plan survives a request. Dependency paths, including
    # missing modules, must be resolved again after the snapshot ends.
    return workspace.sources.analyse(("declaration-reference", path, plan),
        lambda: _resolve_reference(workspace, path, plan))


def _resolve_reference(workspace, path, plan):
    if plan[0] == "import":
        module = _import_module(workspace, path, plan[1])
    else:
        module = _module(workspace, plan[1], _search_path(workspace))
    return (module, plan[2]) if module is not None else None


def _reference_plan(workspace, path, expression, root, scopes):
    """Source-only bindings, never dependency locations or a global name search."""
    for scope in scopes:
        local = _scope_names(workspace, path, scope)
        arguments = [*scope.args.posonlyargs, *scope.args.args, *scope.args.kwonlyargs] \
            if hasattr(scope, "args") else []
        arguments += [argument for argument in (scope.args.vararg, scope.args.kwarg) if argument] \
            if hasattr(scope, "args") else []
        if local is None or root in local.bindings or root in local.declared or local.star \
                or any(argument.arg == root for argument in arguments):
            return None
    tree = workspace.python_tree(path)
    names = _names(workspace, path)
    if names is None:
        return None
    if isinstance(expression, ast.Name):
        node = names.only(expression.id)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node in tree.body:
            return "local", node.name
        if not isinstance(node, ast.ImportFrom) or any(alias.name == "*" for alias in node.names):
            return None
        alias = next(alias for alias in node.names if (alias.asname or alias.name) == expression.id)
        qualified = f"{node.module}.{alias.name}" if not node.level else ""
        if qualified in (STANDARD_KEYWORD, STANDARD_WRAPS):
            return qualified
        return "import", node, alias.name
    if isinstance(expression, ast.Attribute):
        reference = names.reference(expression)
        if reference and reference[0] == "name":
            qualified = reference[1]
            if qualified in (STANDARD_KEYWORD, STANDARD_WRAPS):
                return qualified
            module_name, _, binding = qualified.rpartition(".")
            return "module", tuple(module_name.split(".")), binding
    return None


def _returns(function):
    """Returns belonging to this function, excluding nested functions/classes."""
    pending = list(function.body)
    while pending:
        node = pending.pop()
        if isinstance(node, ast.Return):
            yield node.value
        elif not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            pending.extend(ast.iter_child_nodes(node))


def _unchanged_parameter(workspace, path, function, name):
    return workspace.source(path).syntax(("unchanged-parameter", function, name),
        lambda: _unchanged_parameter_uncached(workspace, path, function, name))


def _unchanged_parameter_uncached(workspace, path, function, name):
    """The incoming parameter is neither rebound nor shadowed in any nested lexical scope."""
    for scope in ast.walk(function):
        if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        names = _scope_names(workspace, path, scope)
        if names is None or name in names.bindings or name in names.declared or names.star:
            return False
        if scope is not function and hasattr(scope, "args"):
            arguments = [*scope.args.posonlyargs, *scope.args.args, *scope.args.kwonlyargs,
                         scope.args.vararg, scope.args.kwarg]
            if any(argument and argument.arg == name for argument in arguments):
                return False
    return not any(
        isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == name
        and not isinstance(node.ctx, ast.Load)
        or isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id == name
        for node in ast.walk(function))


def _factory(workspace, path, binding, seen=()):
    return workspace.sources.analyse(("keyword-factory", path, binding),
        lambda: _factory_uncached(workspace, path, binding, seen))


def _factory_uncached(workspace, path, binding, seen):
    """(incoming name parameter, positional index), or None when the factory is not proved."""
    key = (path, binding)
    if key in seen or len(seen) >= MAX_FACTORY_DEPTH:
        return None
    tree = workspace.python_tree(path)
    names = _names(workspace, path)
    if names is None:
        return None
    node = names.only(binding)
    if isinstance(node, ast.ImportFrom):
        reference = _reference(workspace, path, ast.Name(id=binding, ctx=ast.Load()))
        if reference == STANDARD_KEYWORD:
            return "name", 0
        return _factory(workspace, *reference, (*seen, key)) if isinstance(reference, tuple) else None
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node not in tree.body \
            or node.decorator_list:
        return None
    returned = list(_returns(node))
    if len(returned) != 1:
        return None
    result = returned[0]
    statements = node.body[1:] if isinstance(node.body[0], ast.Expr) \
        and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str) else node.body
    # A wrapper forwards the original positional/keyword arguments and consumes only its own options.
    if isinstance(result, ast.Call) and node.args.vararg and node.args.kwarg \
            and len(statements) == 1 and isinstance(statements[0], ast.Return) \
            and not node.args.posonlyargs and not node.args.args \
            and _unchanged_parameter(workspace, path, node, node.args.vararg.arg) \
            and _unchanged_parameter(workspace, path, node, node.args.kwarg.arg) \
            and len(result.args) == 1 and isinstance(result.args[0], ast.Starred) \
            and isinstance(result.args[0].value, ast.Name) and result.args[0].value.id == node.args.vararg.arg \
            and all(sum(isinstance(item, ast.Name) and item.id == argument for item in ast.walk(result)) == 1
                    for argument in (node.args.vararg.arg, node.args.kwarg.arg)) \
            and sum(keyword.arg is None and isinstance(keyword.value, ast.Name)
                    and keyword.value.id == node.args.kwarg.arg for keyword in result.keywords) == 1 \
            and all(keyword.arg is not None or isinstance(keyword.value, ast.Name)
                    and keyword.value.id == node.args.kwarg.arg for keyword in result.keywords):
        reference = _reference(workspace, path, result.func, (node,))
        forwarded = ("name", 0) if reference == STANDARD_KEYWORD else \
            _factory(workspace, *reference, (*seen, key)) if isinstance(reference, tuple) else None
        if forwarded is None:
            return None
        parameter, _ = forwarded
        if any(argument.arg == parameter for argument in node.args.kwonlyargs) \
                or any(keyword.arg == parameter for keyword in result.keywords):
            return None
        return forwarded
    # A metadata factory returns a decorator whose wrapper is named by RF and preserves the source function.
    if not isinstance(result, ast.Name):
        return None
    decorators = [child for child in node.body if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                  and child.name == result.id]
    if len(decorators) != 1:
        return None
    decorator = decorators[0]
    bindings = _scope_names(workspace, path, node)
    if bindings is None or bindings.only(result.id) is not decorator:
        return None
    parameters = decorator.args.args
    if len(parameters) != 1 or decorator.args.posonlyargs or decorator.args.kwonlyargs \
            or decorator.args.defaults or decorator.args.kw_defaults or decorator.args.vararg or decorator.args.kwarg:
        return None
    original = parameters[0].arg
    if not _unchanged_parameter(workspace, path, decorator, original):
        return None
    returns = list(_returns(decorator))
    if len(returns) != 1 or not isinstance(returns[0], ast.Name):
        return None
    wrappers = [child for child in decorator.body if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                and child.name == returns[0].id]
    if len(wrappers) != 1 or len(wrappers[0].decorator_list) != 2:
        return None
    bindings = _scope_names(workspace, path, decorator)
    if bindings is None or bindings.only(returns[0].id) is not wrappers[0]:
        return None
    keyword, wraps = wrappers[0].decorator_list
    if not isinstance(keyword, ast.Call) or _reference(workspace, path, keyword.func, (node, decorator)) != STANDARD_KEYWORD \
            or not isinstance(wraps, ast.Call) or _reference(workspace, path, wraps.func, (node, decorator)) != STANDARD_WRAPS \
            or len(wraps.args) != 1 or not isinstance(wraps.args[0], ast.Name) or wraps.args[0].id != original:
        return None
    name = keyword.args[0] if keyword.args else next(
        (item.value for item in keyword.keywords if item.arg == "name"), None)
    arguments = [*node.args.posonlyargs, *node.args.args]
    if not isinstance(name, ast.Name) or not _unchanged_parameter(workspace, path, node, name.id):
        return None
    position = next((index for index, argument in enumerate(arguments) if argument.arg == name.id), None)
    return (name.id, position) if position is not None else None


def _literal_name(workspace, path, decorator, scopes=()):
    try:
        return _literal_name_unchecked(workspace, path, decorator, scopes)
    except (OSError, SyntaxError, UnicodeError, ValueError, RecursionError):
        return None  # An unsupported declaration must not hide other known keywords.


def _literal_name_unchecked(workspace, path, decorator, scopes):
    if not isinstance(decorator, ast.Call) or any(isinstance(arg, ast.Starred) for arg in decorator.args) \
            or any(keyword.arg is None for keyword in decorator.keywords):
        return None
    reference = _reference(workspace, path, decorator.func, scopes)
    factory = ("name", 0) if reference == STANDARD_KEYWORD else \
        _factory(workspace, *reference) if isinstance(reference, tuple) else None
    if factory is None:
        return None
    parameter, index = factory
    values = ([decorator.args[index]] if index < len(decorator.args) else []) + [
        keyword.value for keyword in decorator.keywords if keyword.arg == parameter]
    return values[0].value if len(values) == 1 and isinstance(values[0], ast.Constant) \
        and isinstance(values[0].value, str) else None


def _declaration_catalog(cls):
    """Possible literal names only; the current factory still decides the actual name."""
    from .cancellation import checkpoint
    from .workspace import normalize
    literals = {}
    for method in cls.body:
        checkpoint()
        if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in method.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            for value in (*decorator.args, *(keyword.value for keyword in decorator.keywords)):
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    literals.setdefault(value.value, set()).add(method)
    exact, embedded = {}, set()
    for name, methods in literals.items():
        exact.setdefault(normalize(name), set()).update(methods)
        if "${" in name:
            embedded.update(methods)
    return {name: frozenset(methods) for name, methods in exact.items()}, frozenset(embedded)


def _target_methods(workspace, path, cls, methods, targets):
    from .workspace import normalize
    exact, embedded = workspace.source(path).syntax(("declaration-catalog", cls),
        lambda: _declaration_catalog(cls))
    # Embedded text may be metadata, not the actual keyword name. Keep these
    # methods without evaluating any regex before the normal resolver needs it.
    selected = set(embedded)
    for target in targets:
        selected.update(exact.get(normalize(target), ()))
    return [method for method in methods if method in selected]


def augment(workspace, path, selector, reading, targets=None):
    """Add exact own declarations to an otherwise incomplete class reading."""
    from .workspace import normalize
    tree = workspace.python_tree(path)
    names = _module_names(workspace, path)
    cls = names.only(selector)
    if not isinstance(cls, ast.ClassDef) or cls not in tree.body:
        return reading
    existing = {id(node) for node, _ in reading.keywords}
    # Reuse the existing conservative binding analysis for class scope. It sees
    # deletion, augmentation and conditional writes, but does not enter method bodies.
    class_bindings = _scope_names(workspace, path, cls)
    if class_bindings is None:
        return reading
    methods = [statement for statement in cls.body if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
               and class_bindings.only(statement.name) is statement]
    if targets is not None:
        methods = _target_methods(workspace, path, cls, methods, targets)
    declarations, bound = [], set(reading.bound)
    for method in methods:
        if id(method) in existing:
            continue
        found = [_literal_name(workspace, path, decorator, (cls,)) for decorator in method.decorator_list]
        found = [name for name in found if name is not None]
        if len(found) != 1:
            continue
        declarations.append((method, found[0]))
        if not any(names.decoration(decorator) == ("static",) for decorator in method.decorator_list):
            bound.add(id(method))
    if not declarations:
        return reading
    keywords = [*reading.keywords, *declarations]
    counts = {}
    for _, name in keywords:
        counts[normalize(name)] = counts.get(normalize(name), 0) + 1
    keywords = [(node, name) for node, name in keywords if counts[normalize(name)] == 1]
    declarations = frozenset(id(node) for node, _ in declarations)
    return replace(reading, keywords=keywords, bound=frozenset(bound),
                   declarations=reading.declarations | declarations)

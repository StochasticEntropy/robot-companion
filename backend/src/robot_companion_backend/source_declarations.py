"""Own class declarations behind statically traced keyword decorator factories.

This does not execute libraries or claim their runtime keyword/argument contract.
Only an explicitly selected class and a literal keyword name yield a declaration.
"""

import ast
from dataclasses import replace

MAX_FACTORY_DEPTH = 24
STANDARD_KEYWORD = "robot.api.deco.keyword"
STANDARD_WRAPS = "functools.wraps"


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
    from .workspace import search_path
    if node.level:
        directory = path.parent
        for _ in range(node.level - 1):
            directory = directory.parent
        return _module(workspace, node.module.split("."), [directory]) if node.module else \
            directory / "__init__.py"
    return _module(workspace, node.module.split("."), [*workspace.search_path(), *search_path()]) \
        if node.module else None


def _names(workspace, path):
    from .workspace import ModuleNames, REBINDING_CALLS, import_time
    source = workspace.source(path)
    if source.declaration_names is None:
        tree = workspace.python_tree(path)
        names = ModuleNames(tree)
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


def _scope_names(workspace, scope):
    return workspace.sources.analyse(("declaration-scope", scope),
        lambda: _lexical_names(scope.body))


def _reference(workspace, path, expression, scopes=()):
    """A standard metadata function or an explicit source binding, never a global name search."""
    root = expression
    while isinstance(root, ast.Attribute):
        root = root.value
    if not isinstance(root, ast.Name):
        return None
    for scope in scopes:
        local = _scope_names(workspace, scope)
        arguments = [*scope.args.posonlyargs, *scope.args.args, *scope.args.kwonlyargs] \
            if hasattr(scope, "args") else []
        arguments += [argument for argument in (scope.args.vararg, scope.args.kwarg) if argument] \
            if hasattr(scope, "args") else []
        if local is None or root.id in local.bindings or root.id in local.declared or local.star \
                or any(argument.arg == root.id for argument in arguments):
            return None
    tree = workspace.python_tree(path)
    names = _names(workspace, path)
    if names is None:
        return None
    if isinstance(expression, ast.Name):
        node = names.only(expression.id)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node in tree.body:
            return path, node.name
        if not isinstance(node, ast.ImportFrom) or any(alias.name == "*" for alias in node.names):
            return None
        alias = next(alias for alias in node.names if (alias.asname or alias.name) == expression.id)
        qualified = f"{node.module}.{alias.name}" if not node.level else ""
        if qualified in (STANDARD_KEYWORD, STANDARD_WRAPS):
            return qualified
        module = _import_module(workspace, path, node)
        return (module, alias.name) if module is not None else None
    if isinstance(expression, ast.Attribute):
        reference = names.reference(expression)
        if reference and reference[0] == "name":
            qualified = reference[1]
            if qualified in (STANDARD_KEYWORD, STANDARD_WRAPS):
                return qualified
            module_name, _, binding = qualified.rpartition(".")
            from .workspace import search_path
            module = _module(workspace, module_name.split("."),
                             [*workspace.search_path(), *search_path()])
            return (module, binding) if module is not None else None
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


def _unchanged_parameter(function, name):
    """The incoming parameter is neither rebound nor shadowed in any nested lexical scope."""
    for scope in ast.walk(function):
        if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        body = [ast.Expr(value=scope.body)] if isinstance(scope, ast.Lambda) else scope.body
        names = _lexical_names(body)
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
            and _unchanged_parameter(node, node.args.vararg.arg) and _unchanged_parameter(node, node.args.kwarg.arg) \
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
    bindings = _scope_names(workspace, node)
    if bindings is None or bindings.only(result.id) is not decorator:
        return None
    parameters = decorator.args.args
    if len(parameters) != 1 or decorator.args.posonlyargs or decorator.args.kwonlyargs \
            or decorator.args.defaults or decorator.args.kw_defaults or decorator.args.vararg or decorator.args.kwarg:
        return None
    original = parameters[0].arg
    if not _unchanged_parameter(decorator, original):
        return None
    returns = list(_returns(decorator))
    if len(returns) != 1 or not isinstance(returns[0], ast.Name):
        return None
    wrappers = [child for child in decorator.body if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                and child.name == returns[0].id]
    if len(wrappers) != 1 or len(wrappers[0].decorator_list) != 2:
        return None
    bindings = _scope_names(workspace, decorator)
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
    if not isinstance(name, ast.Name) or not _unchanged_parameter(node, name.id):
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


def augment(workspace, path, selector, reading):
    """Add exact own declarations to an otherwise incomplete class reading."""
    from .workspace import ModuleNames, normalize
    tree = workspace.python_tree(path)
    names = ModuleNames(tree)
    cls = names.only(selector)
    if not isinstance(cls, ast.ClassDef) or cls not in tree.body:
        return reading
    existing = {id(node) for node, _ in reading.keywords}
    # Reuse the existing conservative binding analysis for class scope. It sees
    # deletion, augmentation and conditional writes, but does not enter method bodies.
    class_bindings = _scope_names(workspace, cls)
    if class_bindings is None:
        return reading
    methods = [statement for statement in cls.body if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
               and class_bindings.only(statement.name) is statement]
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

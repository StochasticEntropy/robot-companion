"""Project Robot configuration shared by the language, discovery and debug services.

Robot Companion sends each workspace folder's `robotCompanion.robotArguments` (the arguments
Run Test and the debugger pass to Robot) together with the folder Robot runs in. They are
parsed with RF's own option parser and argument-file reader. `--pythonpath`, `--variablefile`
and `--variable` then apply to language and discovery results as Robot applies them, but
nothing is run: search directories are only listed and read, variable files are read
statically (Python through its syntax tree, JSON and YAML as data), and this process's
`sys.path` never changes.
"""

import ast
from dataclasses import dataclass
import glob
import json
import os
from pathlib import Path
import re

from .runtime import robot_version

CONFIGURATION_VERSION = 1
MAX_ARGUMENT_FILES = 64  # RF re-reads argument files that include each other forever
IMPORT_BY_PATH_ENDS = (".py", "/", os.sep)  # RF's Namespace: a Library name ending so is a path
VARIABLES_BY_PATH_ENDS = (*IMPORT_BY_PATH_ENDS, ".yaml", ".yml", ".json")
UNKNOWN = object()  # a value decided only when the file runs
# Built-in variables whose value is fixed before a test starts, by RF's normalized name.
STATIC_BUILTINS = {"space": " ", "empty": "", "true": "True", "false": "False", "none": "None",
                   "null": "None", "/": os.sep, ":": os.pathsep, "\\n": os.linesep}
# Module-level names that make RF's set of variables of a Python file dynamic.
DYNAMIC_VARIABLES = frozenset(("get_variables", "getVariables", "__getattr__", "__dir__"))
REBINDING_CALLS = frozenset(("setattr", "delattr", "globals", "vars", "locals", "exec", "eval", "__import__"))


@dataclass(frozen=True)
class Configuration:
    """One folder's parsed Robot configuration; `cwd` None when the client sent none."""
    cwd: Path | None = None
    python_path: tuple = ()  # absolute directories, in Robot's order
    variable_files: tuple = ()  # (name or path as given, arguments)
    variables: tuple = ()  # (name, value as given, type or None)
    errors: tuple = ()

    def summary(self):
        return {"version": CONFIGURATION_VERSION, "cwd": str(self.cwd) if self.cwd else None,
                "pythonPath": [str(p) for p in self.python_path],
                "variableFiles": [":".join((name, *args)) for name, args in self.variable_files],
                "variables": ["${%s}" % name for name, _, _ in self.variables], "errors": list(self.errors)}


EMPTY = Configuration()


@dataclass(frozen=True)
class FileVariable:
    """One variable a variable file defines: `name` as `${NAME}`; position of its binding."""
    name: str
    line: int
    column: int
    length: int  # of the name as written in the file
    text: str
    value: object = UNKNOWN


@dataclass(frozen=True)
class VariableFile:
    path: Path
    variables: tuple
    complete: bool  # every name the file defines is in `variables`
    problem: str | None = None  # why it could not be read completely


class ArgumentFiles:
    """RF's `ArgFileParser`, with relative files read from the run folder, no `STDIN` (this
    process's stdin is the protocol) and a bound on files including each other."""

    def __init__(self, cwd):
        from robot.utils.argumentparser import ArgFileParser

        class Parser(ArgFileParser):
            count = 0

            def _get_args(self, path):
                Parser.count += 1
                if Parser.count > MAX_ARGUMENT_FILES:
                    from robot.errors import DataError
                    raise DataError(f"More than {MAX_ARGUMENT_FILES} argument files; do they include each other?")
                if path.upper() == "STDIN":
                    from robot.errors import DataError
                    raise DataError("Reading arguments from STDIN is not supported by language and discovery services.")
                return super()._get_args(str(cwd / path))
        self.parser = Parser(["--argumentfile", "-A"])

    def expand(self, arguments):
        return self.parser.process(list(arguments))


def split_python_path(value):
    """RF's own `--pythonpath` splitting (`:` or `;`, Windows drive letters kept)."""
    from robot.conf.settings import RobotSettings
    return list(RobotSettings._split_pythonpath(None, value))


def parse(options):
    """The `robotConfiguration` object a client sends: `{version: 1, cwd, robotArguments}`."""
    if options is None:
        return EMPTY
    if not isinstance(options, dict) or options.get("version") != CONFIGURATION_VERSION:
        raise ValueError(f"robotConfiguration must be an object with version {CONFIGURATION_VERSION}")
    cwd, arguments = options.get("cwd"), options.get("robotArguments", [])
    if not isinstance(cwd, str) or "\0" in cwd or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        raise ValueError("robotConfiguration.cwd must be an existing absolute directory")
    if not isinstance(arguments, list) or any(not isinstance(a, str) or "\0" in a for a in arguments):
        raise ValueError("robotConfiguration.robotArguments must be an array of strings without NUL characters")
    cwd = Path(cwd).resolve()
    from robot.errors import DataError, Information
    from robot.run import USAGE
    from robot.utils.argumentparser import ArgumentParser
    try:
        expanded = ArgumentFiles(cwd).expand(arguments)
        # A placeholder data source satisfies RF's argument count; the services read the workspace.
        opts, _ = ArgumentParser(USAGE, auto_help=False, auto_version=False, auto_argumentfile=False,
                                 env_options=None).parse_args([*expanded, "robot-companion-placeholder"])
        if opts.get("argumentfile"):
            raise DataError("Using '--argumentfile' option in shortened format like '--argumentf' is not supported.")
    except (DataError, Information) as exc:
        return Configuration(cwd, errors=(f"robotCompanion.robotArguments: {exc}",))
    python_path = []
    for value in opts.get("pythonpath") or ():
        for part in split_python_path(value):
            pattern = os.path.join(cwd, part)
            for found in sorted(glob.glob(pattern)) or [pattern]:  # RF globs relative to the run folder
                found = Path(os.path.abspath(found))
                if found not in python_path:
                    python_path.append(found)
    variables = []
    for value in opts.get("variable") or ():
        typed = re.fullmatch("([^:]+): ([^:]+):(.*)", value)  # RF 7.3+: `NAME: int:42`
        if typed:
            variables.append((typed[1], typed[3], typed[2]))
        else:
            name, _, written = value.partition(":")
            variables.append((name, written, None))
    files = tuple(split_variable_file(value, cwd) for value in opts.get("variablefile") or ())
    return Configuration(cwd, tuple(python_path), files, tuple(variables))


def split_variable_file(value, cwd):
    """RF's `split_args_from_name_or_path` (`vars.py:arg1:arg2`), with an existing path taken
    relative to the run folder rather than to this process's working directory."""
    from robot.utils.text import _get_arg_separator_index_from_name_or_path

    def existing(name):
        return str(cwd / name) if (cwd / name).exists() else None
    if found := existing(value):
        return found, ()
    index = _get_arg_separator_index_from_name_or_path(value)
    if index == -1:
        return value, ()
    return existing(value[:index]) or value[:index], tuple(value[index + 1:].split(value[index]))


def valid_file(path):
    """RF's `_is_valid_file`: a file, or a package directory."""
    return path.is_file() or (path.is_dir() and (path / "__init__.py").is_file())


def find_file(name, basedir, search, exists=valid_file):
    """RF's `find_file`: absolute as given, else next to the importing file, then along the
    module search path. None when nothing is found."""
    relative = Path(os.path.normpath(name.replace("/", os.sep)))
    if relative.is_absolute():
        return relative.resolve() if exists(relative) else None
    for base in [basedir, *search]:
        if base is not None and base.is_dir() and exists(candidate := base / relative):
            return candidate.resolve()
    return None


def module_file(name, search, exists=Path.is_file):
    """The source a module name imports from the search path (`a.b` -> `a/b.py` or
    `a/b/__init__.py`), as Python's path finder looks, or None."""
    if not re.fullmatch(r"[^\W\d][\w]*(\.[^\W\d][\w]*)*", name):
        return None
    parts = name.split(".")
    for base in search:
        for candidate in (base.joinpath(*parts[:-1], parts[-1] + ".py"), base.joinpath(*parts, "__init__.py")):
            if exists(candidate):
                return candidate.resolve()
    return None


def substitute(text, lookup, partial=False):
    """RF's own `replace_string(ignore_errors=True)` restricted to statically known scalars.

    Lookup order is the caller's, then the built-ins above, then RF's own number conversion.
    A variable that is not a plain known scalar (extended syntax, item access, nesting,
    inline Python, environment, list or dictionary) is never evaluated. With `partial` it
    stays as written, as when RF cannot resolve it; otherwise the whole text is unknown (None)."""
    from robot.utils import normalize
    from robot.variables import Variables, search_variable
    from robot.variables.finders import NOT_FOUND, NumberFinder
    store, parts, rest = Variables(), [], text
    while (match := search_variable(rest, ignore_errors=True)).start >= 0:
        parts.append(rest[:match.start])
        base = match.base or ""
        known = None
        if match.identifier == "$" and not match.items and not base.startswith("{") and "${" not in base:
            key = normalize(base, ignore="_")
            known = lookup(key)
            if known is None:
                known = STATIC_BUILTINS.get(key)
            # RF 7.3.2's NumberFinder.find takes the decorated name ("${1e3}"); RF 7.5 takes the
            # VariableMatch. The conversion rules themselves are identical in both releases.
            number = NumberFinder().find(match.match if robot_version() == "7.3.2" else match)
            if known is None and number is not NOT_FOUND:
                known = number
        if known is not None:
            store["${" + base + "}"] = known
            parts.append(match.match)
        elif partial:
            parts.append("\\" + match.match)  # escaped, so RF's replacer leaves it as written
        else:
            return None
        rest = rest[match.end:]
    parts.append(rest)
    return store.replace_string("".join(parts), ignore_errors=True)


def scalar(value):
    """A statically read value usable in a name or path, as RF would turn it into text."""
    if value is UNKNOWN or isinstance(value, (list, tuple, dict, set)):
        return None
    return value


# Variable files ------------------------------------------------------------------------

def decorated(name):
    """RF's `LIST__`/`DICT__` prefixes name a list or dictionary variable."""
    for prefix, sigil in (("LIST__", "@"), ("DICT__", "&")):
        if name.startswith(prefix):
            return f"{sigil}{{{name[len(prefix):]}}}"
    return f"${{{name}}}"


def python_variables(path, text):
    """What RF's static Python variable file importer would expose, from the syntax tree:
    every public module-level binding (assignments, imports, functions, classes), filtered
    by a literal `__all__`. `get_variables`, a class named like the module (RF then reads
    an instance), star imports and import-time rebinding make the file dynamic."""
    from .workspace import import_time
    tree = ast.parse(text, filename=str(path))
    lines = re.split(r"\r\n|\r|\n", text)
    bindings, complete, problem = {}, True, None
    for node, in_class in import_time(tree):
        if in_class:
            continue
        bound = []
        if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
            bound.append((node.id, node))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if any(alias.name == "*" for alias in node.names):
                complete, problem = False, "it uses a star import"
            bound += [((alias.asname or alias.name).split(".")[0], node) for alias in node.names]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.append((node.name, node))
            if isinstance(node, ast.ClassDef) and node.name == path.stem:
                complete, problem = False, f"Robot Framework reads an instance of its class {node.name}"
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            complete, problem = False, "it declares global names inside functions"
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in REBINDING_CALLS:
            complete, problem = False, f"it calls {node.func.id}() at import time"
        elif isinstance(node, ast.Attribute) and node.attr == "modules":
            complete, problem = False, "it changes sys.modules"
        for name, where in bound:
            bindings.setdefault(name, []).append(where)
    if DYNAMIC_VARIABLES & bindings.keys():
        name = sorted(DYNAMIC_VARIABLES & bindings.keys())[0]
        complete, problem = False, f"its variables come from {name} when Robot Framework runs it"
    included = None
    if "__all__" in bindings:
        statement = next((s for s in tree.body if isinstance(s, ast.Assign) and
                          [getattr(t, "id", None) for t in s.targets] == ["__all__"]), None)
        try:
            included = set(ast.literal_eval(statement.value)) if statement is not None and \
                len(bindings["__all__"]) == 1 else None
        except (ValueError, TypeError, SyntaxError):
            included = None
        if included is None:
            complete, problem = False, "its __all__ is computed"
    assigned = {}  # id(Name target) -> its value when the statement binds only that name
    for statement in tree.body:
        targets = statement.targets if isinstance(statement, ast.Assign) else \
            [statement.target] if isinstance(statement, ast.AnnAssign) and statement.value is not None else []
        if len(targets) == 1 and isinstance(targets[0], ast.Name):
            assigned[id(targets[0])] = statement.value
    variables = []
    for name, nodes in bindings.items():
        if name.startswith("_") or (included is not None and name not in included):
            continue
        last = nodes[-1]
        value = UNKNOWN
        if len(nodes) == 1 and id(last) in assigned:
            try:
                value = ast.literal_eval(assigned[id(last)])
            except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                value = UNKNOWN
        line_number = last.lineno
        line = lines[line_number - 1]
        prefix = len(line.encode("utf-8")[:last.col_offset].decode("utf-8", errors="ignore"))
        column = line.find(name, prefix)
        variables.append(FileVariable(decorated(name), line_number - 1, max(column, 0), len(name) if column >= 0 else 0,
                                      line, value))
    return VariableFile(path, tuple(sorted(variables, key=lambda v: (v.line, v.column))), complete, problem)


def json_keys(text):
    """(key, offset) of the top-level object's keys, in order, of text that is valid JSON."""
    found, depth, index, last = [], 0, 0, None  # last: a string just read inside the top-level object
    while index < len(text):
        char = text[index]
        if char == '"':
            start = index
            index += 1
            while text[index] != '"':
                index += 2 if text[index] == "\\" else 1
            last = (json.loads(text[start:index + 1]), start) if depth == 1 else None
        elif char == ":" and depth == 1 and last:
            found.append(last)
            last = None
        elif not char.isspace():
            depth += {"{": 1, "[": 1, "}": -1, "]": -1}.get(char, 0)
            last = None
        index += 1
    return found


def data_variables(path, text, values):
    """Variables of a JSON/YAML file that RF reads as a mapping, at their keys' lines."""
    lines = text.splitlines()
    positions = {}
    if path.suffix.lower() == ".json":
        for key, offset in json_keys(text):
            line = text.count("\n", 0, offset)
            positions.setdefault(key, (line, offset + 1 - (text.rfind("\n", 0, offset) + 1)))  # after the quote
    else:
        for number, content in enumerate(lines):
            if match := re.match(r"""(["']?)([^"':#][^:#]*?)\1\s*:(?:\s|$)""", content):
                positions.setdefault(match[2], (number, match.start(2)))
    variables = []
    for key, value in values.items():
        line, column = positions.get(str(key), (0, 0))
        length = len(str(key)) if str(key) in positions else 0
        variables.append(FileVariable(f"${{{key}}}", line, column, length, lines[line] if line < len(lines) else "",
                                      value if not isinstance(value, (dict, list)) else UNKNOWN))
    return VariableFile(path, tuple(variables), True)


def read_variable_file(path, text, args=()):
    """The variables RF would import from the variable file at `path`, read without running it."""
    suffix = path.suffix.lower()
    if suffix in (".yaml", ".yml", ".json"):
        if args:
            return VariableFile(path, (), False, f"{suffix[1:].upper()} variable files do not accept arguments")
        if suffix == ".json":
            try:
                values = json.loads(text)
            except ValueError as exc:
                return VariableFile(path, (), False, f"it is not valid JSON: {exc}")
        else:
            try:
                import yaml
            except ImportError:
                return VariableFile(path, (), False, "PyYAML is not installed in the backend environment")
            try:
                values = yaml.safe_load(text)
            except yaml.YAMLError as exc:
                return VariableFile(path, (), False, f"it is not plain YAML data: {' '.join(str(exc).split())}")
        if not isinstance(values, dict):
            return VariableFile(path, (), False, "it is not a mapping")
        return data_variables(path, text, values)
    try:
        result = python_variables(path, text)
    except (SyntaxError, ValueError, RecursionError) as exc:
        return VariableFile(path, (), False, f"its Python source cannot be read: {exc}")
    if args and result.complete:
        return VariableFile(path, (), False, "static variable files do not accept arguments")
    return result

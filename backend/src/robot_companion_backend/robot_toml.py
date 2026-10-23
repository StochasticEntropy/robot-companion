"""The project's `robot.toml` configuration (RobotCode's documented file format), as the services apply it.

Robot Framework itself reads no TOML file; RobotCode does. As RobotCode 2.7.0 does, the workspace
folder's `pyproject.toml` (its `[tool.robot]` table), `robot.toml` and `.robot.toml` are read in
that order, a later file's setting replacing an earlier one's and an `extend-` setting adding to
it. Only the settings in `KEYS` are applied: they become Robot arguments placed before
`robotCompanion.robotArguments`, so the language and discovery services, Run Test and the
debugger apply the same options. RobotCode's other settings (profiles, output, listeners, ...)
are recognized and reported as not applied, unknown keys as unknown, wrong value types as
errors; nothing is evaluated (RobotCode's `{ expr = ... }` values are not applied either).

Only the standard library's `tomllib` (Python 3.11+) is used; no file is imported or run.
"""

from dataclasses import dataclass
from pathlib import Path
import re
import tomllib

FILES = ("pyproject.toml", "robot.toml", ".robot.toml")  # RobotCode's order: a later file wins
ERROR, WARNING, INFORMATION = 1, 2, 3  # LSP DiagnosticSeverity
EXTEND = "extend-"
SCHEMA_ID = "https://github.com/StochasticEntropy/robot-companion/schemas/robot-toml.schema.json"


@dataclass(frozen=True)
class Key:
    name: str
    option: str | None  # the Robot option each value becomes; None for `args` (Robot arguments as given)
    kind: str  # "list" (of strings), "table" (name -> string), "string", "arguments" (list of strings)
    help: str
    example: str


KEYS = {key.name: key for key in (
    Key("python-path", "--pythonpath", "list",
        "Directories where Robot Framework finds module-name libraries, variable modules and, after the "
        "importing file's folder, relative import paths. Relative paths are relative to the workspace folder.",
        'python-path = ["lib", "resources"]'),
    Key("variables", "--variable", "table",
        "Scalar variables with a string value, by name without `${}`; they override the suites' own variables.",
        '[variables]\nENV = "staging"'),
    Key("variable-files", "--variablefile", "list",
        "Python, JSON or YAML variable files, optionally with arguments after a colon (`vars.py:arg`).",
        'variable-files = ["config/env.py"]'),
    Key("extensions", "--extension", "string",
        "File extensions Robot Framework parses as suites when it runs a directory, separated with a colon "
        "(`robot:robot.md`). Test Explorer discovery lists the same files.",
        'extensions = "robot:robot.md"'),
    Key("args", None, "arguments",
        "Any other Robot Framework command-line arguments, as separate strings. Run Test and the debugger pass "
        "them to Robot; the language services apply the options above when they are given here.",
        'args = ["--loglevel", "DEBUG"]'),
)}
EXTENDABLE = frozenset(name for name, key in KEYS.items() if key.kind != "string")  # RobotCode has no extend-extensions
# Every top-level setting of RobotCode 2.7.0's `RobotConfig` (robotcode.robot.config.model).
ROBOTCODE_KEYS = frozenset((
    "args", "console", "console-colors", "console-links", "console-markers", "console-width", "debug-file",
    "default-profiles", "doc", "dotted", "dry-run", "env", "excludes", "exit-on-error", "exit-on-failure",
    "expand-keywords", "extend-args", "extend-env", "extend-excludes", "extend-expand-keywords",
    "extend-flatten-keywords", "extend-includes", "extend-languages", "extend-listeners", "extend-metadata",
    "extend-parse-include", "extend-parsers", "extend-paths", "extend-pre-rebot-modifiers",
    "extend-pre-run-modifiers", "extend-profiles", "extend-python-path", "extend-remove-keywords",
    "extend-set-tag", "extend-skip", "extend-skip-on-failure", "extend-suites", "extend-tag-doc",
    "extend-tag-stat-combine", "extend-tag-stat-exclude", "extend-tag-stat-include", "extend-tag-stat-link",
    "extend-tasks", "extend-tests", "extend-variable-files", "extend-variables", "extend-wrapper", "extensions",
    "flatten-keywords", "includes", "languages", "legacy-output", "libdoc", "listeners", "log", "log-level",
    "log-title", "max-assign-length", "max-error-lines", "metadata", "name", "no-status-rc", "output",
    "output-dir", "parse-include", "parsers", "paths", "pre-rebot-modifiers", "pre-run-modifiers", "profiles",
    "python-path", "quiet", "randomize", "re-run-failed", "re-run-failed-suites", "rebot", "remove-keywords",
    "report", "report-background", "report-title", "rpa", "run-empty-suite", "set-tag", "skip",
    "skip-on-failure", "skip-teardown-on-exit", "split-log", "suite-stat-level", "suites", "tag-doc",
    "tag-stat-combine", "tag-stat-exclude", "tag-stat-include", "tag-stat-link", "tasks", "testdoc", "tests",
    "timestamp-outputs", "tool", "variable-files", "variables", "wrapper", "xunit"))
PROFILE_KEYS = frozenset(("profiles", "extend-profiles", "default-profiles"))
APPLIED = ", ".join(f"`{name}`" for name in KEYS)
TOML_ERROR_AT = re.compile(r"\(at line (\d+), column (\d+)\)")


@dataclass(frozen=True)
class Problem:
    path: Path
    line: int  # 0-based
    start: int  # columns in code points of that line
    end: int
    severity: int
    message: str

    def text(self):
        return f"{self.path.name}:{self.line + 1}: {self.message}"


@dataclass(frozen=True)
class Variable:
    name: str
    value: str
    path: Path
    line: int
    column: int
    length: int


@dataclass(frozen=True)
class Project:
    """The applied configuration: its files, the Robot arguments it becomes and what was wrong."""
    files: tuple = ()  # files with a configuration, in the order applied
    arguments: tuple = ()
    variables: tuple = ()  # Variable, with the location of the definition that applies
    problems: tuple = ()

    def report(self):
        return {"version": 1, "files": [str(p) for p in self.files], "arguments": list(self.arguments),
                "problems": [{"path": str(p.path), "line": p.line, "character": p.start, "severity": p.severity,
                              "message": p.message} for p in self.problems]}


def is_configuration_file(path):
    return path.name in FILES


def locations(text, base=()):
    """{key path tuple: (line, start, end)} of each `key = value` line and `[table]` header, the
    first one of each path; enough for diagnostics and hover (TOML values spanning lines are skipped)."""
    found, table, multiline = {}, (), None
    for number, line in enumerate(text.splitlines()):
        if multiline:
            if line.count(multiline) % 2:
                multiline = None
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        header = re.match(r"\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$", line)
        if header:
            table = tuple(part.strip().strip("\"'") for part in header[1].split("."))
            start = line.index(header[1])
            for size in range(1, len(table) + 1):  # `[profiles.ci]` also places `profiles`
                found.setdefault(table[:size], (number, start, start + len(header[1])))
            continue
        assignment = re.match(r"\s*((?:[A-Za-z0-9_-]+|\"[^\"]*\"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|\"[^\"]*\"|'[^']*'))*)"
                              r"\s*=", line)
        if assignment:
            parts = tuple(part.strip().strip("\"'") for part in re.split(r"\s*\.\s*(?=(?:[^\"']|\"[^\"]*\"|'[^']*')*$)",
                                                                        assignment[1]))
            found.setdefault(table + parts, (number, assignment.start(1), assignment.end(1)))
            rest = line[assignment.end():]
            for quote in ('"""', "'''"):
                if rest.count(quote) % 2:
                    multiline = quote
    return {key[len(base):]: value for key, value in found.items() if key[:len(base)] == base}


def settings_table(path, data):
    """The configuration table of a parsed file, and its key path in the file; (None, ()) for a
    `pyproject.toml` without `[tool.robot]`."""
    if path.name == "pyproject.toml":
        tool = data.get("tool")
        robot = tool.get("robot") if isinstance(tool, dict) else None
        return (robot, ("tool", "robot")) if isinstance(robot, dict) else (None, ())
    return data, ()


class Reader:
    """One file's settings, validated and merged into the configuration read so far."""

    def __init__(self, path, text, values, problems):
        self.path, self.values, self.problems = path, values, problems
        self.text = text

    def problem(self, key, severity, message):
        line, start, end = self.where.get(key, (0, 0, 0))
        self.problems.append(Problem(self.path, line, start, end, severity, message))

    def strings(self, key, value):
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            self.problem((key,), ERROR, f"'{key}' must be an array of strings; it is not applied.")
            return None
        if any("\0" in item for item in value):
            self.problem((key,), ERROR, f"'{key}' must not contain NUL characters; it is not applied.")
            return None
        return list(value)

    def table(self, key, value):
        if not isinstance(value, dict):
            self.problem((key,), ERROR, f"'{key}' must be a table of names and string values; it is not applied.")
            return None
        result = {}
        for name, item in value.items():
            if isinstance(item, dict) and "expr" in item:
                self.problem((key, name), WARNING, f"'{key}.{name}' is a RobotCode expression; Robot Companion "
                             "evaluates no expressions, so it is not applied.")
            elif not isinstance(item, str) or "\0" in item or "\0" in name or ":" in name:
                self.problem((key, name), ERROR, f"'{key}.{name}' must be a string (a name without ':'); "
                             "it is not applied.")
            else:
                result[name] = (item, (self.path, *self.where.get((key, name), self.where.get((key,), (0, 0, 0)))))
        return result

    def read(self, settings, base):
        self.where = locations(self.text, base)
        applied = False
        # A setting before the `extend-` settings that add to it, whatever their order in the file.
        for key in sorted(settings, key=lambda name: name.startswith(EXTEND)):
            value = settings[key]
            name = key[len(EXTEND):] if key.startswith(EXTEND) and key[len(EXTEND):] in EXTENDABLE else key
            spec = KEYS.get(name)
            if spec is None:
                if key in PROFILE_KEYS:
                    self.problem((key,), WARNING, f"'{key}': RobotCode profiles are not applied by Robot Companion "
                                 f"(it applies {APPLIED} only).")
                elif key == "tool":
                    self.problem((key,), INFORMATION, "'tool': RobotCode tool settings are not used by Robot "
                                 "Companion.")
                elif key in ROBOTCODE_KEYS:
                    self.problem((key,), WARNING, f"'{key}' is a RobotCode setting Robot Companion does not apply "
                                 f"(it applies {APPLIED}); pass Robot options with 'args' instead.")
                else:
                    self.problem((key,), WARNING, f"Unknown robot.toml setting '{key}'; it is not applied.")
                continue
            if spec.kind == "string":
                if not isinstance(value, str) or "\0" in value:
                    self.problem((key,), ERROR, f"'{key}' must be a string; it is not applied.")
                    continue
                checked = value
            elif spec.kind == "table":
                checked = self.table(key, value)
            else:
                checked = self.strings(key, value)
            if checked is None:
                continue
            applied = True
            old = self.values.get(name)
            if key != name and old is not None:  # extend-: add to the setting read so far
                checked = {**old, **checked} if isinstance(old, dict) else [*old, *checked]
            self.values[name] = checked
        return applied


def read_files(folder, texts=None):
    """[(path, text)] of the configuration files in `folder`, in RobotCode's order. `texts`
    (path -> text) gives the current text of open documents."""
    found = []
    for name in FILES:
        path = folder / name
        if texts and path in texts:
            found.append((path, texts[path]))
        elif path.is_file():
            found.append((path, path.read_text(encoding="utf-8")))
    return found


def load(folder, texts=None):
    """The `Project` configuration of the workspace folder (the folder Robot runs in)."""
    values, problems, files = {}, [], []
    try:
        sources = read_files(Path(folder), texts)
    except (OSError, UnicodeError) as exc:
        return Project(problems=(Problem(Path(folder), 0, 0, 0, ERROR, f"Reading the configuration failed: {exc}"),))
    for path, text in sources:
        file_problems = []
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError as exc:
            at = TOML_ERROR_AT.search(str(exc))
            line, column = (int(at[1]) - 1, max(int(at[2]) - 1, 0)) if at else (0, 0)
            problems.append(Problem(path, line, column, column + 1, ERROR,
                                    f"Invalid TOML: {exc}. This file is not applied."))
            continue
        settings, base = settings_table(path, data)
        if settings is None:
            continue
        if Reader(path, text, values, file_problems).read(settings, base) or not file_problems:
            files.append(path)
        problems += file_problems
    return Project(tuple(files), tuple(arguments(values)), tuple(variables(values)), tuple(problems))


def arguments(values):
    """The Robot arguments of the merged settings, in the order of `KEYS`."""
    result = []
    for name, spec in KEYS.items():
        value = values.get(name)
        if value is None:
            continue
        if spec.kind == "list":
            for item in value:
                result += [spec.option, item]
        elif spec.kind == "table":
            for variable, (item, _) in value.items():
                result += [spec.option, f"{variable}:{item}"]
        elif spec.kind == "string":
            result += [spec.option, value]
        else:
            result += value
    return result


def variables(values):
    """Each merged `variables` entry, with the place of the definition that applies."""
    return [Variable(name, item, path, line, start, end - start)
            for name, (item, (path, line, start, end)) in (values.get("variables") or {}).items()]


def hover(path, text, line, column):
    """Help (Markdown) for the setting at a 0-based line and code-point column, or None."""
    base = ("tool", "robot") if path.name == "pyproject.toml" else ()
    for key, (number, start, end) in locations(text, base).items():
        if number != line or not start <= column <= end or not key:
            continue
        name = key[0]
        if len(key) == 2 and name in ("variables", EXTEND + "variables"):
            return f"**${{{key[1]}}}** · robot.toml variable, applied as `--variable {key[1]}:<value>`."
        base_name = name[len(EXTEND):] if name.startswith(EXTEND) and name[len(EXTEND):] in EXTENDABLE else name
        spec = KEYS.get(base_name)
        if spec:
            option = f"`{spec.option}`" if spec.option else "Robot arguments as given"
            action = f"Adds to `{base_name}`; applied" if base_name != name else "Applied"
            return f"**{name}** · {action} by Robot Companion as {option}.\n\n{spec.help}\n\n```toml\n{spec.example}\n```"
        if name in ROBOTCODE_KEYS:
            return f"**{name}** · RobotCode setting, not applied by Robot Companion. Robot Companion applies " \
                   f"{APPLIED}; pass other Robot options with `args`."
        return f"**{name}** · Unknown robot.toml setting, not applied."
    return None


def schema():
    """JSON Schema of the settings, generated from `KEYS` (the extension ships it as
    `schemas/robot-toml.schema.json` for TOML editors)."""
    def value_schema(spec):
        if spec.kind == "table":
            return {"type": "object", "additionalProperties": {"type": "string"}}
        if spec.kind == "string":
            return {"type": "string"}
        return {"type": "array", "items": {"type": "string"}}
    properties = {}
    for name in sorted(ROBOTCODE_KEYS | set(KEYS)):
        base_name = name[len(EXTEND):] if name.startswith(EXTEND) and name[len(EXTEND):] in EXTENDABLE else name
        spec = KEYS.get(base_name)
        if spec is None:
            properties[name] = {"description": "RobotCode setting; not applied by Robot Companion."}
            continue
        prefix = f"Adds to `{base_name}`. " if name != base_name else ""
        option = f" Applied as {spec.option}." if spec.option else ""
        properties[name] = {**value_schema(spec), "description": prefix + spec.help + option}
    return {"$schema": "http://json-schema.org/draft-07/schema#", "$id": SCHEMA_ID,
            "title": "robot.toml settings applied by Robot Companion", "type": "object",
            "properties": properties, "additionalProperties": False}

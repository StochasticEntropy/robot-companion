# Robot Companion backend preview

Independent Python language, test-discovery and debug services for Robot Framework.
The backend runs without Node.js, VS Code or RobotCode. Robot Companion connects
to its services over standard input/output.

This backend accompanies the [Robot Companion 1.3.0 preview](https://github.com/StochasticEntropy/robot-companion/releases/tag/v1.3.0-preview.1).
It is experimental and does not provide complete RobotCode feature parity.

## Runtime requirements

Use one of these exact Python/Robot Framework combinations:

| Python | Robot Framework | debugpy | Optional formatter |
| --- | --- | --- | --- |
| 3.11 | 7.3.2 | 1.8.22 | Robocop 9.1.0 |
| 3.13 | 7.5 | 1.8.22 | Robocop 9.1.0 |

The services refuse other combinations. Python 3.12 is unsupported. The preview's
offline dependency download targets **Python 3.11, Windows x64**; it is not a
Windows ARM or 32-bit package set.

Automated validation of the combined runtime code ran on **Linux aarch64,
Python 3.11.17 and Robot Framework 7.3.2**. The code includes Windows URI handling,
UTF-8 worker output and Windows process-tree ownership, but this combined preview
**has not been qualified on Windows**. Linux tests and Windows-path logic tests
do not establish Windows compatibility. The backend release harness below also runs
on Windows; a passing exact-SHA backend run is not editor or full preview
qualification. macOS and other architectures are also
unqualified. The Python 3.13/Robot Framework 7.5 combination is supported by the
runtime gate; this combined preview was not rerun on that row.

## Install

Download and unpack the backend wheel, dependency wheels and verification helper
from the preview release. Install into the Python environment that contains your
project's Robot libraries. Check your project's dependency requirements first:
these commands install the exact supported Robot Framework and debugpy versions.

For the supplied offline Windows x64/Python 3.11 download, run PowerShell from the
unpacked directory and replace the interpreter path:

```powershell
$ProjectPython = 'C:\your-project\.venv\Scripts\python.exe'
& $ProjectPython -m pip install --force-reinstall --no-index --find-links .\wheels `
  -c .\wheels\constraints.txt '.\robot_companion_backend-0.1.0.dev1-py3-none-any.whl[format]'
& $ProjectPython .\verify-installed-backend.py
& $ProjectPython -m robot_companion_backend doctor
```

The optional `[format]` extra installs Robocop 9.1.0; omit it if document formatting
is not needed. The bundled wheels support only the Windows/Python row stated above.
For another supported runtime, provide dependency wheels matching its interpreter
and platform, or allow pip to obtain dependencies:

```sh
python -m pip install --force-reinstall './robot_companion_backend-0.1.0.dev1-py3-none-any.whl[format]'
python -m robot_companion_backend doctor
```

Keep `--force-reinstall`: preview builds retain backend version `0.1.0.dev1`, so
an older build can have the same version. The supplied verifier checks installed
package bytes against the exact downloaded wheel; a version check alone cannot
distinguish those builds. It must report `match: true`.

`doctor` reports the interpreter, dependency versions, supported runtime row,
formatter availability and whether RobotCode is present. A successful independent
backend environment reports `supported: true` and `robotcodePresent: false`.
If your project already depends on RobotCode, use a separate compatible environment
rather than removing packages from an existing environment without checking its needs.

## Services

The console entry point and Python module accept the same service argument:

```sh
robot-companion-backend doctor
robot-companion-backend lsp
robot-companion-backend discovery
robot-companion-backend dap
```

Equivalent module commands are `python -m robot_companion_backend doctor`,
`python -m robot_companion_backend lsp`, `python -m robot_companion_backend discovery`
and `python -m robot_companion_backend dap`. Language, discovery and debug services
speak framed protocol messages over standard input/output; they are intended to
be launched by a client such as Robot Companion, rather than used as interactive
terminal commands. Configure the extension to use the backend executable inside
your project environment. The release's Windows preview guide covers the editor setup.

## Implemented features

- Import-aware keyword and variable definitions, hover, completion, signature
  help, references, rename and document/workspace symbols.
- Keywords of class, hybrid and dynamic libraries read from their source, and keyword
  names passed to `Run Keyword` and the other BuiltIn run-keyword variants, by the rules in
  [Library and Run Keyword resolution](#library-and-run-keyword-resolution).
- Rename of Python library keywords named by `@keyword("Name")`, by the rules in
  [Python library keyword rename](#python-library-keyword-rename).
- The keywords a Robot file can call, grouped by import, through the request in
  [Keyword list request](#keyword-list-request).
- Parser and static-model diagnostics, import/qualification quick fixes and
  document formatting with the optional Robocop dependency.
- Semantic tokens for full documents and ranges.
- Normalized test discovery for Robot file suites, including source locations
  and explicit discovery errors.
- Robot breakpoints, conditions and logpoints; paused stack/scopes/variables;
  continue and stepping; live Robot keyword execution in the debug console.
- A versioned debugpy handoff for Python debugging in the same Robot worker,
  with owned-process cleanup when debugging ends.

Language indexing reads workspace libraries statically and follows imports;
it does not execute arbitrary workspace libraries to discover keywords.

## Library and Run Keyword resolution

Definition, hover, completion, references, rename, semantic tokens and diagnostics share
one resolution: the import graph of the file, rebuilt for every request from the open
editors' text (Robot Companion also sends the unsaved text of open Python libraries) and
the files on disk. Signature help inside a `Run Keyword` argument still shows
`Run Keyword`'s own signature. An edited, saved, created or deleted
library or suite, and an added or removed import, is seen at the next request. A library
that the file does not import, directly or through its resources, is never chosen, even
when it defines a keyword of the same name.

Workspace Python files are parsed, never imported or run; only Robot Framework's own
standard libraries are read through Libdoc. The backend applies Robot Framework's rules
(the same in 7.3.2 and 7.5) to the source:

- **Which code is the library.** As Robot Framework does: the module's class of the
  import's name (`Library    Shapes.py` and `Library    Shapes` use class `Shapes`), else the
  module's one class with a `ROBOT_AUTO_KEYWORDS` attribute (such as a `@library` class),
  else the module. `Library    Module.ClassName` uses that class of `Module.py`; a
  missing class is an import error.
- **Which module a name means.** A module name is looked up as Python imports it, in the
  importing file's directory: a package with `__init__.py` comes before `Module.py`, and
  `Module.py` before a directory `Module/` without `__init__.py` (a namespace package).
  So `Library    Kits.Tools` uses class `Tools` of `Kits.py` even when a directory `Kits/`
  holds a `Tools.py`; that file is used only without `Kits.py`. In a package,
  `Library    Kits.Tools` is the `Tools` that `Kits/__init__.py` defines (also through
  `from .Tools import Tools` or `from . import Tools`), else the submodule
  `Kits/Tools.py`; with neither it is an import error. An `__init__.py` that mentions
  `__path__` (assigns, appends to or extends it) or defines `__getattr__` is not followed:
  its submodules are not resolved, with the information diagnostic. File names are matched as the file
  system does, which ignores case on Windows and macOS where Python does not.
- **Installed libraries.** A module name whose first part is neither a package nor a module in
  the importing file's directory is looked up the same way in each directory of the language
  service's own `sys.path`, in order (the working directory that `python -m` adds is left out):
  the first directory with a package or module of that name is used, else a namespace
  directory. Started with a project's interpreter, that is its site-packages, so the project's
  installed libraries resolve, are read and are never imported. They are not renamed. A library
  found only through `--pythonpath`, a compiled module, or a name missing from a namespace
  directory, whose other parts may be elsewhere on the search path, is not resolved (an
  information diagnostic says so).
- **Class libraries.** Public methods, also inherited ones, in Python's method resolution
  order over classes of the same module, so an override replaces its base method; names
  given with `@keyword`, also on `_private` methods; `@not_keyword` and properties are no
  keywords; `@library` and `ROBOT_AUTO_KEYWORDS = False` keep only `@keyword` methods.
  Signatures leave out `self`/`cls`. Two methods with one keyword name fail in Robot
  Framework: neither is offered or reported.
- **Hybrid libraries** (`get_keyword_names` without `run_keyword`): the listed names that
  are methods of the class.
- **Dynamic libraries** (`get_keyword_names` and `run_keyword`): every listed name, also
  with embedded arguments. Go to Definition opens the name in the `get_keyword_names`
  list. The signature is Robot Framework's default `*varargs` (with `**kwargs` when
  `run_keyword` accepts named arguments); with `get_keyword_arguments` the signature is
  run-time information, so hover says it could not be read and argument counts are not
  checked. `get_keyword_documentation` is not shown.
- **Run Keyword.** The keyword name arguments of `Run Keyword`, `Run Keyword If` (also
  its `ELSE IF` and `ELSE` branches), `Run Keywords` (split at `AND`, else every argument),
  `Run Keyword Unless`, `Run Keyword And Ignore Error`, `Run Keyword And Warn On Failure`,
  `Run Keyword And Return Status`, `Run Keyword And Continue On Failure`,
  `Run Keyword And Expect Error`, `Run Keyword And Return`, `Run Keyword And Return If`,
  `Repeat Keyword`, `Wait Until Keyword Succeeds` and the `Run Keyword If Test Failed`,
  `... Test Passed`, `... Timeout Occurred`, `... All Tests Passed` and
  `... Any Tests Failed` teardown variants resolve like keyword calls, also nested and in
  setup and teardown settings, and only when the outer name resolves to BuiltIn's
  keyword: a suite's own `Run Keyword` keyword takes precedence. Completion offers keywords
  in such an argument, also in a new one typed after `Run Keyword    `. Unknown keywords
  and argument counts inside `Run Keyword And Ignore Error`, `... Expect Error`,
  `... Return Status` and `... Warn On Failure` are not reported, because Robot Framework
  catches those errors there; navigation still works.

What is not read statically stays unresolved and is never reported as an unknown
keyword: a keyword name containing a variable (`Run Keyword    ${name}`) or following a
list variable; a class with a base class outside its module (also a built-in such as
`dict`), with a decorator other than Robot Framework's, `staticmethod`, `classmethod` and
`property`, with other code than definitions and assignments in its body, or with
`__getattr__`, `__getattribute__`, `__dir__`, `__new__` or `setattr`; a computed
`get_keyword_names`; a module whose classes may have `ROBOT_AUTO_KEYWORDS` from a
third-party base class. A public instance attribute (`self.step = ...`) or computed class
attribute may be a keyword: calling it is never an error, but it has no definition.

## Python library keyword rename

`textDocument/rename` and `textDocument/prepareRename` on a Python library keyword (at a
call, at the function name or at its decorator string) edit the string literal of its
`@keyword("Name")` decorator and every call in the workspace folders that resolves to that
keyword, by the resolution above. The function name and all other Python code stay as
they are. A client that declares `workspace.workspaceEdit.documentChanges` gets the edit as
`documentChanges` with each open document's version (`null` for a file read from disk), so
the client can refuse the whole edit when a file changed meanwhile; other clients get
`changes`.

The request fails with `RequestFailed` (-32803) and a message naming the reason, editing
nothing, when:

- the keyword's name comes from its function name (no decorator string to change);
- the library file defines `get_keyword_names` (dynamic or hybrid library);
- the decorator's name is not exactly one plain single-line string literal;
- a Python file under the workspace folders contains a string equal to the keyword's name
  (also `Library.Name`) other than a `@keyword` decorator name, or mentions the name and
  cannot be parsed;
- the keyword's definition is not a `def` in the library file, or the file cannot be read or parsed;
- the library is outside the workspace folders;
- a call is ambiguous (as for every keyword rename);
- the new name contains the literal's quote character or a backslash, is already the name
  of another keyword or function the library has or may have, or already resolves to
  another keyword in a Robot file that can call the renamed one.

Keyword names RF computes at run time (`Run Keyword    ${name}`) and names in documentation
or comments are not found and not changed.

## Keyword list request

`robotCompanion/documentKeywords` with `{"textDocument": {"uri": ...}}` returns the keywords
a `.robot` or `.resource` file can call, from the same import graph. The server advertises
it as `capabilities.experimental.robotCompanion.documentKeywords: 1`. Result:

- `version`: the open document's version, `null` when it was read from disk;
- `imports`: the file itself (`kind` `local`), then each resolved import in the order Robot
  Framework reads them (`resource`, `library`, `standard`; nested resource imports follow the
  resource importing them), then BuiltIn. Each has `name` (as imported), `alias`,
  `namespace`, `uri`, `importedBy` (this file's own import line when it has one, else the first),
  `importSites` (every import statement of it; RF shares one library instance between imports of
  the same library under the same name, and reads a resource imported by several statements
  once, so each is listed once) and `documentation` (escaped
  Markdown: the resource's `Documentation` setting or the library class's or module's
  docstring), and `keywords`;
- each keyword has `name`, `kind`, `namespace`, `signature` (argument strings, `null` when
  unknown), `required` (arguments a call must pass: `{"name", "named"}`), `returnType`,
  `documentation` (its hover Markdown), `location` and `call`: the text that resolves to
  exactly this keyword, in one library instance, in that file (its name, else
  `namespace.name`; a library imported under two names gets the qualified name), or `null`;
- `unresolved`: each import that could not be resolved, with its location and message.

A library the file does not import is never listed. Other files are refused.

## Current limits

Module search paths, variable files and some runtime-variable scopes are incomplete;
class, hybrid and dynamic libraries are read only as described above. Keyword names in
template rows are not resolved. Python library keywords named by their function name, and
dynamic or hybrid library keywords, are not renamed (see above). The same library imported
under two names (`AS X` and `AS Y`, or `AS` in one file and none in another) is treated as one
by definition, diagnostics and rename, where Robot Framework reports a plain call as
ambiguous; only `documentKeywords` gives each instance its own qualified call text.
Discovery does not expose directory suites, tags or all `__init__.robot` settings.

Formatting uses Robocop defaults; range/on-type formatting, refactorings and source
actions are unavailable. Semantic token deltas and inlay hints are unavailable.
Large-workspace performance, remote workspaces and full multi-root behavior remain
unqualified.

Debugging does not support hit-count, function, data or reverse breakpoints,
`setVariable`, exception-breakpoint controls, attach/restart workflows or breakpoint
changes after configuration. Full debugger parity is not claimed.

## Build and validation

The package uses a dependency-free in-tree PEP 517 build backend. From the repository:

```sh
SOURCE_DATE_EPOCH=1792368000 python backend/scripts/build_dists.py backend dist
```

`python backend/scripts/verify_release.py --python <interpreter> --wheels <dir> --evidence <new dir>`
builds a clean commit, installs it offline and runs every declared suite from the
installed wheel, outside the checkout, on Linux and on Windows. Each command runs in
its own process group on Linux (observed through `/proc`) or in its own kill-on-close
Job Object on Windows, and owned processes left behind fail the run. Exact-SHA
results are recorded in the issue handoff, not here.

The validation below describes the published preview wheel; later source changes are
listed in the [backend changelog](CHANGELOG.md).

The public wheel rebuild changes documentation/metadata only: its 18 Python runtime
modules are byte-identical to the previously validated combined preview. That runtime
completed 15 installed-wheel suites: 152 passed and one documented RF-absent
lifecycle case skipped. Every required live suite had zero skips. Nine frontend
integration tests also passed, including real Robot console execution, Python
stepping and stop cleanup. Artifact verification and offline installation checks
are recorded separately for the public wheel; these do not constitute Windows
qualification.

The backend is MIT licensed. Third-party dependency archives retain their own
licenses and notices; see the release's third-party wheel inventory.

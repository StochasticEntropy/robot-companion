# Independent Robot backend

This distribution is a work-in-progress native backend for the Robot Companion
replacement program. It has no dependency on Node, VS Code, Companion or RobotCode.
The extension and its RobotCode path remain separate and unchanged.

**Current checkpoint (phase 1 plus language features):** bounded stdio transport,
an RF parser-backed LSP with definition, diagnostics with quick fixes, document
formatting (with the optional Robocop 9.1.0), hover, completion,
signature help, references, rename and document/workspace symbols, a test discovery
service (normalized discovery API v1), an owned DAP worker
with an RF listener and paused-thread command loop, the
versioned debugpy handoff v1, the copied v1 audit corpus and headless tests. On each
supported runtime row (see below; debugpy 1.8.22, Robocop 9.1.0, RobotCode absent), the live LSP, LSP feature, LSP navigation, LSP diagnostics, LSP semantic token, discovery, Robot DAP,
conditional breakpoint/logpoint, worker process-tree and mixed Robot/Python suites run against real backend, Robot and debugpy subprocesses. `verify_release.py` builds, installs and
runs every suite from the installed wheel. The exact-SHA results are recorded in
the issue's `artifact-handoff`; this README does not borrow a pass for a later
commit. Phase 1 is not full language-server/debugger parity (see the inventory).

## Runtime and installation

Supported is a matrix of runtime rows, each one Python minor version with one exact
Robot Framework release (`robot_companion_backend.runtime.SUPPORTED`):

| Row | Python | Robot Framework | debugpy | Robocop (`format` extra) | Approved offline wheel set (task containers) |
| --- | --- | --- | --- | --- | --- |
| 3.11 | 3.11 (verified with 3.11.17) | 7.3.2 | 1.8.22 | 9.1.0 | MIS-430: read-only `/opt/robot-wheels-py311`, `MANIFEST.sha256`; interpreter `/opt/python3.11/bin/python3.11` |
| 3.13 | 3.13 (verified with 3.13.7) | 7.5 | 1.8.22 | 9.1.0 | WOL-805: read-only `/opt/robot-wheels`, operator's `robot-backend-wheels.sha256` |

Both rows are verified on **Linux aarch64 only**. Windows qualification (the preview
target Windows / Python 3.11 / RF 7.3.2) is MIS-434 and **not complete: Windows is not
supported yet**. The full Windows run
[39283871806](https://github.com/StochasticEntropy/robot-companion/actions/runs/39283871806)
at `32e8bef5af9490a8befde2136693e3ca355822b6` executed all 13 suite families on
Windows 2022 x64 / Python 3.11.9 / RF 7.3.2 / debugpy 1.8.22 / Robocop 9.1.0.
Build, installation, doctor, transport, live LSP and discovery passed; debugging,
cleanup and portability assertions failed. Repairs in this branch require a new
exact-commit full run and do not change the published preview. No macOS or other
architecture has been validated. `pyproject.toml`
declares the same rows (`requires-python = ">=3.11,!=3.12.*,<3.14"` and
`robotframework==7.3.2; python_version == "3.11"` / `robotframework==7.5; python_version
== "3.13"`), and `constraints.txt` pins each row's versions. Every service refuses any
other combination before using RF (LSP and discovery `initialize` fail with -32002, a DAP
`launch` fails with the worker's prerequisite message, `doctor` exits 2), naming the
interpreter, its Python and RF versions and the supported set, for example
`Unsupported runtime in /venv/bin/python: Python 3.13 with Robot Framework 7.3.2.
Supported: Python 3.11 + Robot Framework 7.3.2, Python 3.13 + Robot Framework 7.5.`
The check reads the `robot.version` the services would import, not distribution
metadata. The optional `format` extra adds Robocop 9.1.0 (`robotframework-robocop`, with
its pinned dependencies) for document formatting on both rows.

The rows differ only where RF itself differs; the backend follows the running RF:

Automated validation of the combined runtime code ran on **Linux aarch64,
Python 3.11.17 and Robot Framework 7.3.2**. The code includes Windows URI handling,
UTF-8 worker output and Windows process-tree ownership, but this combined preview
**has not been qualified on Windows**. Linux tests and Windows-path logic tests
do not establish Windows compatibility. The backend release harness below also runs
on Windows; a passing exact-SHA backend run is not editor or full preview
qualification. macOS and other architectures are also
unqualified. The Python 3.13/Robot Framework 7.5 combination is supported by the
runtime gate; this combined preview was not rerun on that row.

- Standard-library documentation in hovers and signature help: RF 7.5's bundled
  libraries are Markdown and shown as such; RF 7.3.2's are in RF's own ROBOT format and
  shown escaped, like any other non-Markdown documentation. RF 7.3.2's Collections
  keywords have no type annotations, so their signatures show none.
- `${TEST METADATA}` (with test-level `[Metadata]`) exists only in RF 7.5; on the 3.11 row
  it is an undefined variable (RF 7.3.2 fails on it) and `[Metadata]` in a test is RF
  7.3.2's own syntax error.
- RF's number lookup (`${1e3}`, `${0x1F}`) is called with each release's own API; the
  conversion rules are identical.
- The Telnet standard library imports on Python 3.11 and is indexed there; Python 3.13
  has no `telnetlib`, so it stays unindexed on that row.

Robot Companion carries this backend and installs it into a folder's selected project
interpreter after you confirm (**Install Backend**; see the extension README's
*Backend setup and updates*). The steps below are the manual, offline alternative.

Download and unpack the backend wheel, dependency wheels and verification helper
from the preview release. Install into the Python environment that contains your
project's Robot libraries. Check your project's dependency requirements first:
these commands install the exact supported Robot Framework and debugpy versions.
The package uses a dependency-free in-tree PEP 517 backend
(`build_backend/rcb_build.py`), because the approved wheel set has no setuptools,
wheel or build package. It writes a `py3-none-any` wheel with a hashed RECORD and an
sdist using sorted entries, fixed modes and `SOURCE_DATE_EPOCH` timestamps.
`scripts/build_dists.py` is a minimal frontend for its hooks; pip can also build
the wheel directly. From the repository checkout, with an independent venv (the
commands below leave the checkout clean; `build_dists.py` writes no bytecode):

```bash
python3.13 -m venv /tmp/rcb-venv
python3.13 backend/scripts/build_dists.py backend /tmp/rcb-dist
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links /opt/robot-wheels \
  -c backend/constraints.txt "$(ls /tmp/rcb-dist/*.whl)[format]"
/tmp/rcb-venv/bin/robot-companion-backend doctor
```

For the Python 3.11 row use `/opt/python3.11/bin/python3.11` for the venv and
`--find-links /opt/robot-wheels-py311`; the same `constraints.txt` selects RF 7.3.2.

The optional `[format]` extra installs Robocop 9.1.0; omit it if formatting
is not needed. The bundled wheels support only the Windows/Python row stated above.
For another supported runtime, provide dependency wheels matching its interpreter
and platform, or allow pip to obtain dependencies:

pip can also build and install directly (`PYTHONDONTWRITEBYTECODE=1 pip install
--no-index --find-links /opt/robot-wheels ./backend`), since the build needs no
requirements; without that variable pip's in-tree build hook leaves
`backend/build_backend/__pycache__` behind. Build from a clean checkout, because the
sdist includes every file in its source trees. Editable
installs (`pip install -e`) are not supported; run from source with
`PYTHONPATH=backend/src` instead. No frontend dependency directory is needed.
Never install RobotCode in this venv; the operator's prepared `/opt/robot-backend`
venv contains RobotCode and is therefore **not** an acceptance environment.
`doctor` prints JSON versions (Python, `executable`, RF, debugpy), including
`"formatter": {"robocop": "9.1.0"}` (or `null` without the `format` extra), and a
`runtime` record with this interpreter's Python/RF row, whether it is `supported` and
the `supportedRows`. It returns 2 if RF/debugpy is missing, the row is unsupported or
RobotCode is present. Robocop is optional for doctor. A successful doctor is a prerequisite probe,
not conformance. Without `[format]` the server runs without formatting.

## Verify the standalone release

After the operator supplies the approved read-only local wheel directory, run
this from a **clean committed checkout** on Linux or Windows, once per runtime row
(Windows: `venv\Scripts\python.exe`, the system temporary folder as default scratch root,
and long paths enabled, `LongPathsEnabled=1`, for the discovery depth case). `--python`
selects the row's interpreter for the backend venv (default: the harness's own Python);
it must be the Python minor version of a supported row, and `--wheels` that row's wheel
set. Choose a new evidence path for each attempt:

```bash
# Python 3.11 + RF 7.3.2
PYTHONDONTWRITEBYTECODE=1 python3 backend/scripts/verify_release.py \
  --python /opt/python3.11/bin/python3.11 --wheels /opt/robot-wheels-py311 \
  --scratch-root /tmp --evidence /evidence/mis433/py311-batch-1
# Python 3.13 + RF 7.5
PYTHONDONTWRITEBYTECODE=1 python3 backend/scripts/verify_release.py \
  --python /usr/local/bin/python3.13 --wheels /opt/robot-wheels \
  --scratch-root /tmp --evidence /evidence/mis433/py313-batch-1
```

This runner does not download packages or use Node, VS Code, Companion or
RobotCode. It exports exactly `git archive HEAD backend` to a new owned scratch
directory, creates an isolated venv, builds an sdist and wheel with the in-tree
backend, unpacks the sdist and has pip rebuild the wheel from it (`--no-index`),
requires that wheel to be byte-identical, and installs the built wheel with its
`format` extra and pinned dependencies from the local wheel directory. `release.json`
records the formatter (`"formatter": {"name": "robotframework-robocop", "version":
"9.1.0"}`); a venv without it fails, because the diagnostics suite tests formatting. The scratch root contains an **empty `node_modules`**
and no extension source. The installed-package probe rejects RobotCode/Companion
and any backend import outside the venv. Build/test subprocesses receive a small
environment without task credentials, source PYTHONPATH, user-site or proxy settings.
The source identity reads use the checkout's existing Git authorization; the
runner never changes Git configuration.

Command logs and separate stdout files retain the child's exact bytes, encoding
and native line endings. Producers of UTF-8 machine-readable output configure
their own streams; the runner does not force UTF-8 mode on Windows. JSON receipts
are UTF-8.

It then runs the nine mechanical harness cases, transport/lifecycle tests, the
process-tree/control-channel suite and all nine required live
LSP/LSP-feature/LSP-navigation/LSP-diagnostics/discovery/Robot/conditional/process/mixed suites
sequentially using the venv Python and copied synthetic fixtures. Build/test commands have a 300-second bound; source Git reads have a 30-second
bound and their own cleanup/receipts. On Linux, `/proc`
and process-local orphan adoption track owned descendants across separate process
groups; a timeout or leaked child triggers bounded TERM/KILL/reap and makes that
step fail even if its parent exited zero. On Windows each command starts suspended in
its own kill-on-close Job Object, so every descendant (orphans included) is a job member;
members left after the command are terminated and reported the same way. No host service/configuration is changed.
Zero-test suites, expected failures and skipped required live tests cannot produce
a conformance pass. The RF-absent lifecycle-only case may skip in a prepared RF
runtime; its result is counted explicitly.

`release.json` records the requested interpreter, the committed source's
`supportedRows`, `doctor`'s report and its `row`, and `workerInterpreter`: the paused
Robot worker's argv[0] and executable from `test_dap_live.py` (Linux `/proc`; Windows the
recorded command line and image, plus the base interpreter the venv launcher started),
which must equal the installed backend's `sys.executable` (a missing or different record fails the
release). It also records the full source SHA, clean state before/after, exact argv,
exits/timeouts/cleanup, Python/package versions, input wheel hashes, install-report
hashes, built artifact hashes and suite pass/fail/skip counts. Logs, per-command
receipts, pip install reports, protocol transcripts and built distributions remain
under `--evidence`. The owned venv/work directory is retained at the path in that
report for reproduction. Evidence and scratch paths inside the product checkout
are rejected, and existing evidence batches are never overwritten. Exit 0 means
all release checks passed; exit 2 means an unmet preflight prerequisite, and exit
1 means a failed check or invalid source state. Successful-test counts record actual unittest success outcomes, including correct
subtest/unexpected-success accounting. Receipts are written atomically; Pass is
published only after retained artifacts and final source checks. An interrupted
or partial report is not a pass. The commit timestamp supplies SOURCE_DATE_EPOCH.
Same-source builds are byte-identical (frontend build vs pip rebuild from the sdist,
and a repeated build in `test_release_harness.py`); other platforms are unverified.

The nine `test_release_harness.py` cases exercise real synthetic command failures,
timeouts, detached children, receipt rules and build reproducibility/RECORD hashes
without RF; they are mechanical tooling evidence only. They can be
run separately with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s backend/tests -p test_release_harness.py -v`.

## Launch the language service

The proposed v1 descriptor uses explicit executable/argv arrays, without a shell:

```json
{
  "id": "robot-companion-native",
  "version": "0.1.0.dev1",
  "contractVersion": 1,
  "language": {
    "executable": "/tmp/rcb-venv/bin/robot-companion-backend",
    "argv": ["lsp"],
    "transport": "stdio"
  }
}
```

The caller supplies cwd, environment and workspace URI. Protocol stdout contains
only Content-Length-framed UTF-8 JSON. Errors go to stderr or LSP error replies.
Only local file URIs and UTF-16 positions are supported. Initialize fails explicitly
when RF is absent. Full-text synchronization is required; the server rejects
non-increasing document versions and incremental-range changes.

After installation, run `robot-companion-backend lsp`. From source, use
`PYTHONPATH=backend/src python3 -m robot_companion_backend lsp`.

`initialize` advertises `positionEncoding: "utf-16"` and exactly `definitionProvider`, `hoverProvider`,
`completionProvider` (`triggerCharacters` `{` and `.`, `resolveProvider: false`),
`signatureHelpProvider` (triggers space and tab, retrigger `=`), `referencesProvider`,
`renameProvider` (with `prepareProvider` when the client declares
`textDocument.rename.prepareSupport`, otherwise `true`), `documentSymbolProvider` and
`workspaceSymbolProvider`, plus full-text sync. `codeActionProvider` with
`codeActionKinds: ["quickfix"]` is added only when the client declares
`textDocument.codeAction.codeActionLiteralSupport` (the server returns `CodeAction`
literals, never commands), and `documentFormattingProvider: true` only when Robocop
9.1.0 is installed. Without them, `textDocument/codeAction` and
`textDocument/formatting` fail with `Method not implemented` (-32601). Range and
on-type formatting, semantic tokens and workspace-folder change notifications are not
advertised. The workspace
folders of `initialize` (`workspaceFolders`, else `rootUri`, else `rootPath`; local
`file:` folders only; on Windows drive-letter URIs, as VS Code writes them,
`file:///c%3A/...`, while UNC/device paths are refused) bound the scan used by references, rename and workspace symbols;
they are fixed for the session.
Completion items carry plain text only (`insertTextFormat` 1); snippets, commit
characters and `labelDetails` are not used, and `completionItem/resolve` fails with
`Method not implemented`. Hover and signature documentation
are Markdown only when the client lists `markdown` in `textDocument.hover.contentFormat`
or `signatureHelp.signatureInformation.documentationFormat`; otherwise plain text.

### Hover, completion and signature help

All three use the same per-request import graph and keyword resolution as
`textDocument/definition` (see Architecture), so an unimported library such as the
audit corpus's `AShadow.py` never supplies a hover, completion item or signature.

- **Keyword hover** on a keyword-call cell shows the resolved keyword's name and
  origin (`Local keyword · audit.robot`, `Resource shared.resource`,
  `Library AuditLibrary · AuditLibrary.py`, `Library Audit · AuditLibrary.py` for an
  alias, `Standard library Collections`), its argument specification as RF formats it
  (`Build Record    name: str = Ada`), a `Returns` line only when the keyword has a
  return annotation (`def other(x):` has none; `-> None` says `Returns None`) and its
  documentation. An ambiguous call shows every match with an explicit ambiguity line.
  Workspace documentation is escaped in Markdown, so a docstring cannot inject links,
  images or HTML; RF 7.5's own standard-library documentation is Markdown and is
  passed through (RF 7.3.2's is RF's ROBOT format and is escaped).
- **Variable hover** shows the innermost definition visible at the cursor (current
  test/keyword local or argument, else the suite's own Variables section, else an
  imported resource's, else a built-in) with its source file and line. Only values
  written in the source are shown: a suite/`VAR` value as written (flagged when it
  refers to other variables), an argument default as written, `${CURDIR}` (the
  document's directory) and constant built-ins such as `${SPACE}` or `${True}`.
  Assignments, loop/`EXCEPT` variables, arguments without a default and run-time
  built-ins say that their value is known only at run time. Unknown names give no hover.
  A variable used in a call's arguments resolves to its value before that call, so in
  `${x}=    Set Variable    ${x}` the argument is the earlier `${x}` (also for definition).
  A typed definition cell (`${PORT: int}    8080`, `${n: int}=    Set Variable    1`)
  shows the same variable as its later uses `${PORT}` and `${n}`.
- **Keyword completion** is offered in a keyword-call cell: an empty body cell after
  indentation and optional assignments with nothing after the cursor, or a partly
  typed `KEYWORD` cell (its whole cell is the edit range). Items list local keywords, imported resources (also
  transitively), imported Python libraries, imported standard libraries and the
  implicit BuiltIn, in RF precedence; a lower-precedence keyword with the same name is
  omitted, and same-precedence duplicates are inserted qualified (`Other.Build Record`).
  Each item's `detail` is its origin. Typing a library/resource name and `.`
  (`Audit.`) lists that namespace's keywords qualified. Settings, headers, test names
  and argument cells receive no keyword items.
- **Variable completion** after an unclosed `${`, `@{` or `&{` lists one item per
  visible variable: locals assigned on earlier lines of the same test/keyword (not
  the call being typed), its arguments (including embedded `Greet ${name}`
  arguments), `FOR`/`EXCEPT AS`/`VAR` variables, suite variables and the running RF's built-ins
  (`${CURDIR}`, `${TEMPDIR}`, `${TEST NAME}`, ...). Variables of another test or
  keyword are never offered, nor a variable assigned by the call being typed. The
  edit range runs from the sigil through the rest of the name and its closing `}`
  when one follows the cursor (an editor's auto-closed brace or an existing name).
  An extended-syntax suffix is kept: in `${rec|ord.name}` or `${rec|ord[0]}` only
  `${record` is replaced, so the result is `${record.name}`. Without a closing `}`
  (`Got ${rec| from the API.`) nothing after the cursor is replaced. `%{` environment
  variables return no items.
- **Signature help** inside a keyword call's argument cells (including `...`
  continuation lines) returns one signature per resolved keyword, labelled
  `Name    arg1    arg2=default    *varargs    **kwargs`, with UTF-16 offset
  parameter labels. The active parameter follows RF argument mapping: a `name=value`
  cell (split as RF does, so an escaped `\=` or a `=` inside a variable, item access or
  `${{1 == 1}}` expression is no named argument) selects that named parameter (or `**kwargs` for an unknown name when the
  keyword accepts them); otherwise the count of preceding positional cells selects
  the positional parameter, then `*varargs`. Past the last parameter without
  varargs, the index is outside `parameters`; VS Code then highlights none, while LSP
  3.17 lets other clients default it to the first parameter. A cursor on the
  keyword name, or separated from it by a single space, gets no signature.

All ranges are UTF-16, including lines with umlauts and non-BMP characters.
Edits to open documents (`didChange`), saved dependency files and import changes
are visible on the next request without a restart.

Keyword cells of `[Setup]`, `[Teardown]`, `[Template]`, `Suite Setup`/`Teardown`,
`Test`/`Task Setup`/`Teardown` and `Test Template` (not `NONE`) resolve like calls for
definition, hover, references and rename. As in RF, one English BDD prefix (`Given`,
`When`, `Then`, `And`, `But`) is ignored when the full name matches no keyword.

### References, rename and symbols

Implemented in `navigation.py`. A keyword is identified by its resolved definition
location, never by its name, using the same import-aware resolution as definition.

- **Workspace scope.** Each request scans the `.robot`/`.resource` files under the
  workspace folders (skipping hidden directories, `node_modules` and `__pycache__`;
  symlinked directories and Windows junctions are not followed), plus open Robot documents and the file that
  defines the target. Open documents use their unsaved text; other files are read from
  disk. Nothing is cached, so `didChange`, saved files and files created, changed or
  deleted on disk (as reported by `workspace/didChangeWatchedFiles`) are reflected on the
  next request without a restart. Files whose text cannot contain the name are not parsed.
- **Keyword references** (`textDocument/references`) work at a call, at a setting cell,
  at a `.robot`/`.resource` keyword definition and at a Python library keyword's
  function name on its `def` line. They return every keyword cell in the workspace
  whose own import graph resolves to that same definition, plus the definition when
  `includeDeclaration` is true. On the audit corpus, references to AuditLibrary.py's
  `Build Record` include `Audit.Build Record` alias calls, and never a call that
  resolves to the unimported AShadow.py, to a file's own same-named keyword, or an
  ambiguous call (RF fails an ambiguous call, so it is a reference of no single
  keyword). At an ambiguous call itself, the result covers each candidate's calls and
  that call. Each range covers the keyword's own name, after any `Audit.`/`shared.`
  prefix or BDD prefix.
- **Variable references** use the definition's scope: a test/keyword local or argument
  (including embedded `Greet ${name}` arguments, `FOR`, `EXCEPT AS` and `VAR`) only
  within that test or keyword, every assignment of the same name there included; a
  suite variable in every workspace file that resolves to that Variables-section entry
  (the defining file and suites importing its resource, unless their own Variables
  section shadows it, or a test-local assignment shadows it from that line on); a
  built-in in every file that uses it. Uses are `${name}`, `@{name}`, `&{name}` and,
  where RF evaluates Python, `$name`: in `IF`/`ELSE IF`/inline `IF`/`WHILE` conditions,
  inside `${{ }}` (nested braces included) and in the first argument of BuiltIn's
  evaluating keywords (`Evaluate`, `Should Be True`, `Skip If`, `Run Keyword If`,
  `Set Variable If`, ...). `$name` is found with Python's tokenizer, so `"$name"` inside
  a string literal is text, as in RF. Variables are found with RF's own variable search,
  so nested uses count: `${x}` inside `${{ ${x} + 1 }}` (also inside dict or list
  braces), `${lang}` inside `${greeting_${lang}}` (whose dynamic outer name is no use of
  any variable) and `${i}` in `${items}[${i}]`. Escaped `\${name}` and comments are
  literal text. An inline IF assignment (`${MODE}=    IF    $MODE == 'fast'    Catenate
  ${MODE}-x    ELSE ...`) is set after the branch runs, as in RF: its condition and branch
  values use the previously visible `${MODE}` (here the suite variable), and only the
  ASSIGN cell and later uses are the new local; definition and hover follow the same rule.
  Inside a `FOR` or `WHILE` body (nested loops included) that assigns a local of the
  same name anywhere in it, RF reaches every use in that body, and a `WHILE` condition,
  by that local from the next iteration on, even above the assignment: in
  `FOR    ${_}    IN RANGE    2` / `${MODE}=    Catenate    ${MODE}-x` the argument
  `${MODE}` is the suite variable first and the local afterwards. Such a use is a
  reference of both: from the suite variable, from the local and, at the use itself,
  of everything either reaches. A use that is set only in the loop (unset before it) is
  a reference of that local. Definition and hover still name only the definition
  visible at that line (here the suite variable).
  A user keyword's `${argument}` is also referenced by the `name=` cells of calls
  passing it by name (not `name\=`; `@{}`/`&{}` arguments take no `name=`), from any of
  its uses, including after a reassignment.
  Ranges cover the base name only (`record` in `${record.name}`, `PORT` in
  `${PORT: int}`, `count` in `$count`).
- **Rename** (`textDocument/prepareRename`, `textDocument/rename`) returns a
  `WorkspaceEdit` with `changes`. For a user keyword defined in a `.robot`/`.resource`
  file it changes the definition name and every reference above, replacing only the
  keyword's own name, so `shared.` and `Given ` prefixes stay. Comments, documentation
  text, arguments with the same text and other same-named keywords are not edited.
  Variable rename edits every use above, including `$name` in expressions and the
  `name=` cells passing a keyword argument by name. In expressions a new name's spaces
  become underscores (`${my total}` is used as `$my_total`, which RF resolves to it);
  if that is still no Python identifier (`my-total`), the rename is refused.
  A use in a loop reached by two definitions (see above) renames both together, with all
  of their uses: renaming the suite `${MODE}` in the example also renames that test's
  local `${MODE}`, and renaming the local also renames the suite variable everywhere,
  so RF runs the same; renaming only one would change the loop's result. If a
  built-in variable or a suite variable defined in several imported files reaches such
  a use, the rename is refused instead ("the use at f.robot:6 is in a FOR/WHILE loop
  that reassigns it, so it is also reached by a built-in variable").
  Refused with an LSP `RequestFailed` (-32803) error and no edit: Python library keywords
  ("rename it in the Python source"; advisory scope, not implemented), RF standard
  library keywords, an ambiguous call or definition, any ambiguous call in the
  workspace that includes the target, keywords with embedded arguments, built-in
  variables, a suite variable defined in several imported files (also when it reaches a
  loop use shared with the target), and invalid names.
  A new keyword name must be one cell (single regular spaces only: no tab, line break,
  other whitespace or two consecutive spaces), contain no variable, not start with
  `#`, `[`, `*` or `...` and not be a control-structure marker (`END`, `FOR`, `IF`, ...);
  a new variable name may be given as `name` or `${name}` and must not contain
  braces, sigils, `.`, `[`, `]`, `:`, `=`, backslashes, other whitespace or two spaces.
  Clashes with another visible keyword or variable of the new name are not detected.
  `prepareRename` returns the name range and current text, `null` where there is
  nothing to rename, and every refusal rename would give (it computes the same edit).
  A cursor just after a name, where an editor caret usually is, counts as on it.
- **Document symbols** (`textDocument/documentSymbol`) return hierarchical
  `DocumentSymbol`s for a `.robot`/`.resource` file in source order: suite variables
  (kind Variable, detail `Variable`), test cases (kind Method, detail `Test case`),
  tasks (kind Method, detail `Task`) and keywords (kind Function, detail `Keyword`).
  Tests, tasks and keywords contain one child per argument or local variable (its first
  definition; detail `Argument` or `Local variable`). `range` runs from the name line to
  the last non-blank line, `selectionRange` is the name. Other files return `[]`. A
  client without `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport` gets
  the same entries as flat `SymbolInformation` (children name their parent in
  `containerName`).
- **Workspace symbols** (`workspace/symbol`) return `SymbolInformation` for tests, tasks
  and user keywords of every scanned file, open or not. The query matches when its
  characters occur in order in the name, ignoring case, spaces and underscores (an
  empty query returns all). The location is the name; `containerName` is
  `<kind> · <file>`. Python library keywords and variables are not listed.

Not modelled: keyword names passed as arguments (`Run Keyword    Local Step`, `Wait
Until Keyword Succeeds`), variables set dynamically (`Set Suite Variable`, `VAR ...
scope=SUITE`/`GLOBAL`, which stay local to their test or keyword), conditions after
the first in `Run Keyword If`/`Set Variable If`, variable files, `.txt`/`.rst`/`.tsv`
resources, a resource calling a keyword of the suite that imports it, static
class/dynamic libraries and Python names the module-library reading does not index
(imported, assigned, conditional or otherwise decorated names; inherited from definition),
and folders added after `initialize`. Outside the loop rule above, variable scope
follows source lines, so a `[Teardown]` above an assignment does not see it, and an
assignment in one `IF` branch counts for later lines whichever branch runs. Loops count
every assignment in their body, also one in a branch that never runs (references and
rename then include more uses, never fewer). `name=` cells in `[Template]` data
rows are not linked to the template keyword's arguments. Columns of an unopened file
that starts with a UTF-8 byte order mark are not adjusted for it. Those occurrences are neither found
nor renamed. No performance numbers on a large
workspace have been measured; every request rescans and reparses candidate files.

### Diagnostics and quick fixes

Implemented in `diagnostics.py`. On `didOpen`, `didChange`, `didClose` and
`workspace/didChangeWatchedFiles` the server publishes `textDocument/publishDiagnostics`
(with the document version) for every open `.robot`/`.resource` document, computed from
the same per-request import graph as definition. Every range is UTF-16 and covers the
offending cell or name. Each diagnostic has `source: "robot-companion-backend"` and one of
these codes:

| Code | Severity | Rule |
| --- | --- | --- |
| `syntax` | Error | The running RF's own parsing and model validation errors, with RF's message, from the loader RF uses for the file (`get_resource_model` for `.resource`, `get_init_model` for `__init__.robot`): unknown settings (`Libary`, `[Föo]`), invalid section headers, a FOR/IF without `END`, `[Arguments]` order, `RETURN` outside a keyword, a test case section in a resource, ... The range is the erroneous cell, or the statement's first line. |
| `deprecated` | Warning | Syntax the running RF still runs but reports as deprecated, as RF does (a model error on a token that is not an error token): singular section headers (`*** Test Case ***`), `[Return]`. |
| `import` | Error / Information | Unchanged rules: a missing `.py`/path or resource import is an error; a module-name library without a sibling file is an Information `Library not resolved in this version`. The range is the import's name cell. |
| `unknown-keyword` | Error | A keyword cell (body call, `[Setup]`/`[Teardown]`/`[Template]`, `Suite`/`Test Setup`/`Teardown`, `Test Template`) that resolves to nothing in the file's import-aware scope: `No keyword with name 'X' found.` An unimported library such as AShadow.py never counts. |
| `ambiguity` | Warning | A call matching several keywords of the same precedence (two imported libraries or resources), naming each source: `Multiple keywords with name 'Build Record' found: AuditLibrary.Build Record (AuditLibrary.py), Other.Build Record (Other.py). ...` The range is the keyword name after any BDD prefix. |
| `arguments` | Error | A body call or setup/teardown setting whose arguments the single resolved keyword's signature cannot accept, checked with RF's own dry-run resolver and message (`Keyword 'Resource Step' expected 1 argument, got 0.`, `... got positional argument after named arguments.`). |
| `undefined-variable` | Warning | A `${name}`/`@{name}`/`&{name}` use in a test or keyword body that nothing visible defines: `Variable '${missing}' is not defined in this scope.` |

To prefer no diagnostic over a false one:

- **Unknown keywords** are not reported when the scope cannot be known statically: any
  import problem (including an unmodelled module library), `Remote` or a standard library
  that cannot be imported here, a class library (a class named like its module), a
  dynamic/hybrid library (`get_keyword_names`, `run_keyword`, `__getattr__`), `from x
  import *`, a keyword decorator the index does not read (`@deco.keyword(...)`,
  `@keyword(NAME)`), `Import Library`/`Import Resource` anywhere in the graph, or a
  `Language:` header (translated BDD prefixes and settings are not modelled; neither is
  RF's `--language` option). A keyword with an invalid embedded-argument pattern
  matches nothing, as when RF runs. A name matching a public name an imported module
  library binds but does not index (see *Module library keywords* below) is not
  reported, nor a call whose name contains a variable. A name RF hides through a
  literal `__all__`, `ROBOT_AUTO_KEYWORDS = False` or `@not_keyword` is reported. In a `.resource` file, a keyword also counts as
  found when it resolves in any workspace suite or resource whose import graph includes
  that resource, because RF runs a resource keyword in the importing suite's namespace;
  the same holds for a `.robot` file without tests. If a workspace file imports it
  through a variable (`Resource    ${CURDIR}/x.resource`), its importers are unknown and
  neither unknown keywords nor undefined variables are reported in it.
- **Ambiguity** is reported only between indexed keywords, never from a name a library
  may expose without being indexed. It is not reported when an embedded-argument keyword is
  among the matches (RF prefers a normal match and the best embedded match) or when `Set
  Library Search Order` is used anywhere in its graph or an importing suite's graph. A
  custom library keyword wins over a standard library (`def log(message)` over BuiltIn's
  `Log`) without a warning, as RF runs it. Private keywords (`robot:private`) are not
  modelled.
- **Arguments** are not checked for embedded-argument keywords, keywords whose signature
  cannot be read statically, `[Template]` data rows, or calls with a `@{list}`/`&{dict}`
  argument (expanded only at run time, as in RF's dry run). Nor are they checked for a
  resolved library keyword when `Set Library Search Order` is used in its scope, or for a
  library or standard keyword whose name another imported library may expose without
  indexing it: RF may run that other keyword. Argument types are not converted or checked.
- **Undefined variables** are checked only in the ARGUMENT cells of body statements
  (keyword calls, template rows, `FOR`/`IF`/`ELSE IF`/`WHILE`/`EXCEPT`/`GROUP` headers,
  `RETURN`, `[Return]` and `VAR` values), never in settings such as `[Documentation]`,
  `[Tags]`, `[Arguments]` defaults, `[Setup]` or `[Teardown]` (a teardown runs after the
  body). A variable counts as defined when the test or keyword defines it on **any**
  line (arguments, embedded arguments, assignments, `FOR`, `EXCEPT AS`, `VAR`), so a
  loop may use a value assigned later in its body; when the suite's or an imported
  resource's Variables section defines it (in a `.resource`, also any importing suite's);
  when it is a built-in of the running RF, a number (`${1}`, `${0x1F}`) or the base of RF's
  extended syntax (`${SPACE * 2}`, `${record.upper()}`); or when **any** Robot file in the
  workspace (or any file of its import graph) sets that name dynamically: `Set
  Test`/`Task`/`Suite`/`Global`/`Local Variable` as a call, a setup/teardown setting or a
  `Run Keyword ...` argument, with the name as `\${name}`, `$name` or `${name}`, or `VAR`
  with a `scope=` other than `LOCAL`. As RF's setters do, the name cell is resolved first:
  `\${name}` and `$name` set `name`; `${name}` sets `name` unless `name` is a known
  variable whose value reads as a variable name (`${HOLDER}    \${held}` in any workspace
  Variables section sets `held`). Its value is known for Variables-section values, `VAR`
  and `Set Variable` with one variable-free cell, and built-ins; an argument, another
  assignment or a dynamically set `name` has a run-time value, which may name any
  variable. The first
  argument of those setters and of `Get Variable Value`, `Variable Should Exist` and
  `Variable Should Not Exist` is a name, not a use. No variable is reported at all for a
  file whose graph has a `Variables` import, `Import Variables`, `Import Resource`, an
  import problem or a Python library that may set variables (it mentions
  `set_test_variable`, `set_suite_variable`, ...), or when any workspace setter's name has
  a run-time value (`${${name}}`, a wrapper keyword's `${name}` argument, a
  `[Template]    Set Test Variable`). A Python library that sets a global
  variable but is imported only by another suite is not seen. `$name` in Python
  expressions, `%{ENV}` and escaped `\${name}` are not checked. Variables given on the
  command line (`--variable`, `--variablefile`) are unknown statically, so a use that only
  they define is reported; the warning severity reflects that.

**Module library keywords.** A `.py` library is read with Python's AST, never imported,
by one shared reading (`module_reading` in `workspace.py`) that indexes keywords and
gives the diagnostics their open scope, following RF's static module-library rule (identical in RF 7.3.2 and RF 7.5)
(every public routine while `ROBOT_AUTO_KEYWORDS` is true, or one with `robot_name`,
filtered by `__all__`, without `@not_keyword` ones):

- `@keyword` functions are indexed as before (literal or no name argument), in a static
  module only when no later binding replaces the function and no `fn.robot_name = ...`
  renames it; a replaced, renamed, guarded (`if`/`try`) or `@not_keyword`-stacked one keeps
  its names as names the module may expose.
- A plain top-level `def`/`async def` (no decorator, public) is indexed as a library
  keyword named as RF displays it (`ring_bell` → `Ring Bell`, RF's `printable_name`), with
  its location, arguments and docstring, when the module is static (below) and nothing
  else at module level binds the name (assignment, import, `class`, `del`, a `for`/`with`/
  `except`/walrus/`match` target, a definition inside `if`/`try`/`with`, a `global`
  declaration in any function) or uses it at import time (`register(ring_bell)`,
  `ring_bell.robot_name = ...`, a decorator or default value). Of several plain `def`s of one
  name the last counts, as in Python.
- A literal `__all__` (one top-level assignment of a list/tuple of strings, also annotated)
  filters by Python name, also `@keyword` functions (`@keyword("Custom") def impl` stays
  `Custom` when `"impl"` is listed). A literal `ROBOT_AUTO_KEYWORDS = False` hides plain
  `def`s. `@not_keyword` (imported from `robot.api.deco`) hides its function.
- Two keywords of one library with one normalized name (`ring_bell` and `ringBell`, or a
  plain and a `@keyword` function) are both left unindexed: RF reports a duplicate when
  importing the library, not an ambiguity.
- Every other public name the module binds (imports, assignments, conditional or otherwise
  decorated functions, a name a function declares `global`) and a literal name given at
  import time (`fn.robot_name = "Named"`) is only a name it *may* expose: it silences an unknown-keyword
  error and argument checks for that name, never makes a call ambiguous and has no
  definition.
- The module's keywords are unknown (nothing more indexed, unknown keywords not
  reported) for a class library (any binding of the module's name other than a plain
  `def`), a module-level `get_keyword_names`, `run_keyword`, `__getattr__` or `__dir__`
  (bound in any way),
  `import *`, an unread keyword decorator (`@deco.keyword`, `@keyword(NAME)`), any other
  mention of `__all__` or `ROBOT_AUTO_KEYWORDS` (computed, `+=`, `.append`, item
  assignment, `del`, conditional, imported, `global`), an import-time call of `setattr`,
  `delattr`, `globals`, `vars`, `locals`, `exec` or `eval`, `sys.modules`, or the
  `keyword`/`not_keyword` decorators called outside decorator position
  (`keyword("Renamed")(fn)`), or a computed or deleted `robot_name`.

Known gaps, each a missed diagnostic rather than a false one: a collision through an
imported or assigned name (`from NorthLib import ring_bell` next to `SouthLib.py`) is not
reported as ambiguous, and such a call gets definition and hover from the one indexed
keyword (argument checks skipped); a library that fails to import when RF runs (a
missing dependency) still counts as defining its keywords; same-library duplicates and
modules with a module-level `get_keyword_names`/`run_keyword` (RF treats those as
plain module libraries) stay suppressed rather than modelled. One gap can give a false
error, unchanged from before: a function imported from another module that carries its
own `@keyword("Shared Step")` name is known only by its Python name, so a call `Shared Step`
is reported as unknown. Bare `@keyword` names keep their current display (`ring bell`).

**Quick fixes** (`textDocument/codeAction`, kind `quickfix`) are recomputed from the
current text for the diagnostics overlapping the requested range; `context.only` is
honoured. Each action names the diagnostic it fixes and carries a `WorkspaceEdit` with
`changes` for the document:

- *Import resource `x.resource`* / *Import library `lib/X.py`* (`isPreferred`) for an
  `unknown-keyword` when exactly one workspace `.resource` file or Python library file
  (keywords as the module-library reading indexes them; virtual environments, hidden directories,
  `node_modules` and `__pycache__` are skipped) defines the keyword. A qualified call
  `X.Keyword` only considers a file named `X`. If several files define it (such as
  AuditLibrary.py and the unimported AShadow.py for `Build Record`) no import is offered.
  No import is offered either when an RF standard library also has such a keyword, or
  when the relative path contains a variable, an escape or a cell separator.
  The edit inserts `Resource    <relative path>` or `Library    <relative path>` after the
  last import of the Settings section, or a new Settings section before the first
  section, keeping the document's line endings.
- *Use `Name.Keyword` (file)* for each library/resource candidate of an `ambiguity`
  warning, replacing only the keyword name (a BDD prefix stays) when the qualified name
  then resolves to exactly that keyword. A suite's own keywords have no qualifier.

Arguments and undefined variables have no automatic fix.

### Formatting

Implemented in `formatting.py`, available with the optional `format` extra (Robocop
9.1.0): `initialize` advertises it only when that exact version is installed and its
formatter modules import (output of the import goes to stderr). `textDocument/formatting` formats a whole `.robot`/`.resource` document in the
server process with Robocop's default formatters (`NormalizeSeparators`,
`MergeAndOrderSections`, `OrderSettings`, `OrderSettingsSection`, `NormalizeTags`,
`AlignSettingsSection`, `AlignVariablesSection`, `NormalizeNewLines`,
`NormalizeSectionHeaderName`, `NormalizeSettingName`, `SplitTooLongLine`, `InlineIf`;
four-space separators, 120-character lines), rerunning them until the text is stable (at
most five passes; otherwise the request fails and nothing changes). Workspace Robocop
configuration files are not read and the LSP `FormattingOptions` are ignored, so the
result depends only on the document text; `# robocop: fmt: off` disablers are honoured.
A document containing `\r\n` is returned with `\r\n` line endings throughout; one
with a lone `\r` line break is refused with `RequestFailed` (LSP counts a lone `\r` as a
line break, which the line edits would not match). The reply is line-based `TextEdit`s
against the current text in document order (UTF-16 positions), `[]` when the text is
already formatted (so a second format returns no edits), and `null` for other files.
Formatting the audit corpus is deterministic and the audit suite passes under the row's RF
before and after it. Note that Robocop's defaults lower-case tags and may reorder
settings and sections. Range formatting and configurable Robocop rules are not
implemented.

## Launch the debug adapter

Run `robot-companion-backend dap` (from source:
`PYTHONPATH=backend/src python3 -m robot_companion_backend dap`). Stdout carries only
Content-Length-framed DAP messages. The adapter handles `initialize`, `launch`,
`setBreakpoints` (also during the run), `configurationDone`, `pause`, `threads`,
`terminate` and `disconnect`. While the worker is paused it also handles `stackTrace`,
`scopes`, `variables`, `continue`, `next`, `stepIn`, `stepOut` and `evaluate`;
`test_dap_live.py` and `test_dap_controls_live.py` exercise them live on both runtime
rows. Other requests fail with `Unsupported request: <command>`.
`initialize` advertises only
`supportsConfigurationDoneRequest`, `supportsTerminateRequest`,
`supportsConditionalBreakpoints` and `supportsLogPoints`, and requires 1-based
lines/columns and absolute file-system paths. Hit-count, function, data and exception
breakpoints are not advertised.

`launch` takes `target` (a suite path or list, relative to `cwd`), optional `cwd`
(default: the adapter's cwd) and optional `args` (extra Robot CLI arguments). It starts
one Robot worker (`python -m robot_companion_backend.worker`) with the adapter's own
interpreter, in its own process tree, with an authenticated private control channel
(see *Worker control channel and process tree*). The
worker's UTF-8 stdout/stderr become DAP `output` events with native line endings
(CRLF on Windows). If the worker's interpreter is not a
supported Python/RF row (including RF not importable), `launch` fails with that prerequisite message and the worker's
real exit code. It does not report a mocked success. After a successful launch the
adapter sends `process` and `initialized`. `configurationDone` then starts the run, and
`exited`/`terminated` follow when the worker ends.

Breakpoints initially return `verified: false`. At `configurationDone`, the worker
parses each requested Robot source with RF's model, emits `breakpoint` changes for
executable keyword-call lines, then installs an RF listener. Source verification
means a line contains a keyword call; it does not promise that the run imports or
reaches that file. A breakpoint stops only when the running keyword's own source file
and line match: the same line in an unimported resource or another file of the same
name is never a stop target. Hit counts (`hitCondition` fails the whole
`setBreakpoints` request) are explicitly unsupported.

### Changing breakpoints during a run

After `configurationDone`, `setBreakpoints` still replaces the complete set of one
source (an empty list removes all of that source's breakpoints; other sources are
untouched). The whole request is validated first: an invalid batch fails and leaves
the current set unchanged. An entry with the same line, `condition` and `logMessage` as
a current one keeps its ID; every other entry gets a new ID, and a removed ID is never
reused in the session.

- **Paused:** the Robot thread verifies and applies the new set before the reply, so
  the reply carries the real `verified` results and a following `continue` already
  uses the new set.
- **Running:** the reply comes at once with `verified: false` and the message
  `Applies when the running Robot test reaches its next keyword (safe point)`. The
  set is applied when the next keyword starts; the adapter then sends a `breakpoint`
  `changed` event per entry with the real result. When several replacements of one
  source wait for the same safe point, only the latest one's events are sent and only
  its breakpoints can hit. A removal that reaches the worker before a stop is reported
  prevents that stop; a stop already reported is not undone. At most 64 replacements
  may wait for a safe point; a further one fails with an explicit message.
- **Ended run:** the reply marks each entry `verified: false`, `The Robot run has ended`.

Verification parses the saved file as it is now. Breakpoint changes are not source
reload: RF keeps the suite it loaded when the run started, so after editing a running
suite's text, start a new run.

### Pause and Step Out

`pause` (thread 1) is accepted only while a configured run is running; before
`configurationDone`, for an unknown thread, while already paused and after the worker
ended it fails with one explicit message. An accepted pause is answered at once, with a
`console` output line *Pause requested: Robot stops before its next keyword. Library
code that is running now is not interrupted.* The **safe point** is the start of the
next keyword RF actually runs: not a NOT RUN keyword, not the inner keyword BuiltIn's
`Run Keyword` family runs for its caller's line, and never during a console, condition
or logpoint evaluation. There the worker reports `stopped` with `reason: "pause"`. If a
breakpoint hits at the same keyword, the stop is reported once, as `breakpoint` with
its IDs, and also answers the pause. A pause requested while a library keyword blocks
(a long `Sleep` or Python code waiting on I/O) stays pending until that keyword
returns; there is no `stopped` event and no stack meanwhile, and `terminate` or
`disconnect` still ends the run at once. A pause still pending when the run ends is
dropped. In the regular-step fixture (`loop.robot`, a 50 ms `Sleep` per iteration) the
stop arrives within 5 seconds of the request (measured about 0.05 s); that bound is
for this fixture only, not a general guarantee.

`stepOut` leaves the Robot user keyword whose body holds the current line: the top
frame is the keyword about to run, and library frames of the `Run Keyword` family below
it belong to the same line and are passed over. The worker records each keyword
invocation, so a recursive call or a second call on the same line is a different
target. When that invocation has finished (including an early `RETURN` and its
teardown), the run stops with `reason: "step"` before the next keyword its caller (or a
shallower frame) runs, with fresh frame and variable handles. A breakpoint or pause on
the way stops first and cancels the Step Out. If the test ends before such a keyword,
the run continues normally without a stop. At test or suite level (no enclosing user
keyword) `stepOut` fails with *Step Out is not available here: the current line is not
inside a Robot user keyword (test or suite level). Use Step Over or Continue.*; the
worker stays paused with its handles valid.

While Robot runs, one pump thread in the worker is the only reader of the control
channel. It queues messages in arrival order and evaluates nothing; only the Robot
thread changes breakpoints, pause and step state, drains the queue at each keyword
start (a bounded snapshot: later messages wait for the next keyword) and in its pause
loop. A closed or malformed control channel ends the worker (exit 4).

### Conditional breakpoints and logpoints

A `SourceBreakpoint` may carry `condition` and/or `logMessage`; both must be strings,
otherwise the whole `setBreakpoints` request fails (`Breakpoint condition must be a
string`). They are checked by the worker with RF at `configurationDone` and evaluated
in the listener on the **Robot execution thread**, when the keyword call on that line
starts, in the current Robot variable context: inside a user keyword its arguments and
locals, in a test body its `FOR` variable. The call's own arguments are not yet bound.
No separate Robot run or detached Python process is used.

Expressions use RF's IF/WHILE condition semantics (`evaluate_expression`, identical in RF 7.3.2 and RF 7.5, with
`resolve_variables=True`, see "Evaluating expressions" in the RF User Guide):
`$name` is the live variable object (`$iteration == 2`, `$record.name == 'Ada'`),
`${name}` is replaced with its value before Python evaluates the text (`${count} > 2`),
and modules are imported on demand (`len($items) > 1`, `os.sep == '/'`). The result is
Python truthiness. Evaluation can call code with side effects, as RF conditions can;
recursive debug stops are suppressed while it runs.

| Input | Disposition |
| --- | --- |
| `condition` empty or only whitespace | `breakpoint` event `verified: false`, `Breakpoint condition is empty`; never stops |
| `condition` not valid Python after `$name` decoration (`$iteration ==`, nesting too deep to compile) | `verified: false`, `Breakpoint condition is not a valid RF expression: <Python error>`; never stops. Expressions containing a variable reference (`${}`, `@{}`, `&{}`, `%{}`) are only checked when evaluated |
| Evaluation raises (unknown `$missing`, `1 / $value` with 0, ...) | `important` DAP `output` with source/line: `Breakpoint <id> condition error at <file>:<line>: <RF error>; not stopping`. The hit counts as **not** met, every time it fails; later evaluations are independent |
| Evaluates false | Continues without a `stopped` event |
| Evaluates true | Normal `stopped` with `reason: "breakpoint"` and this breakpoint's ID |

A `logMessage` breakpoint never stops: when its line starts (and its condition, if any,
is true) it emits one DAP `output` event, category `console`, with `source` and `line`
and the rendered message plus `\n`. In the message:

- `{expression}` is evaluated with the condition semantics above and inserted with
  `str()` (`iteration={$iteration}`, `next={$value + 1}`). It ends at its matching
  brace, so dictionary literals nest (`{ {'a': 1}['a'] }`, starting with a space);
  braces inside string literals of the expression are not supported.
- `${name}`, `@{name}`, `&{name}` and `%{NAME}`, including extended and item syntax
  (`${record.name}`, `${items}[0]`), are RF's scalar replacement of that variable
  (the list, dictionary or environment value), inserted with `str()`.
- `{{` and `}}` are literal braces, so `${{x}}` prints `${x}`. Everything else,
  including a backslash, is literal text (RF's `\${x}` escaping does not apply).
- A failing part renders inline as `<error: <RF error>>`; the rest of the message is
  still emitted. The rendered message is cut after 65,536 characters and an error
  text after 4,096, each marked `... [truncated]`.

An empty message, an unclosed `{` or `${`, a lone `}`, an empty `{}` and an expression
that is not valid Python are reported at `configurationDone` as `verified: false` with
the reason (for example `Log message has an unclosed '{' at offset 5; write '{{' for a
brace`) and never emit or stop. Several breakpoints on one line are evaluated
independently; logpoints are emitted before a stop or step on the same keyword.
Breakpoints and logpoints (plain ones included) match only keywords RF actually runs
from their own line: a keyword in a branch RF does not take (reported as NOT RUN, for
example the other side of an inline `IF`) never hits, and the inner keyword that
BuiltIn's `Run Keyword` family runs for its caller's line (`Run Keyword    Log    x`)
does not hit a second time. A recursive call on the same line is a new call and hits
each time. Stepping is unchanged and may still stop on such keywords.

The listener's pause loop handles requests on the **same Robot
execution thread**. `stackTrace` returns the active Robot keyword/test stack;
`scopes` exposes the current frame's visible Robot variables (not separately
classified local/suite/global scopes). Outer frames have source locations, but
live scopes/evaluation there are explicitly unsupported. Compound variables expose
dictionary keys, sequence indices or object instance attributes. Handles are
monotonic and valid only for the pause that issued them; resume invalidates them.
`next` stops at the next keyword at the same or shallower depth; `stepIn` stops at
the next keyword, including a nested resource keyword. `pause` and `stepOut` are
described in *Pause and Step Out* above.

`evaluate` requires an explicit current Robot `frameId`, `context: "repl"` and one
Robot keyword call (Robot cell separators, no assignment or newline). It parses
that call with RF and uses `BuiltIn.run_keyword` in the paused context, preserving
live variables and keyword side effects. It never uses Python expression eval or
starts another Robot process. Evaluations suppress recursive debug stops. A command
timeout terminates the worker instead of leaving a desynchronized session. Hover
and watch evaluation are not advertised or supported. The worker parses the Robot
CLI with RF's public `RobotFramework.parse_arguments` and adds the in-process
listener to any user listeners (`run_cli` cannot take a listener instance).

`terminate`/`disconnect` stop the worker's whole process tree: SIGTERM to its process
group, SIGKILL after 5 seconds; group members that outlive the worker (also after a
run ends by itself) get SIGKILL before the worker is reaped. A malformed request gets a failed response; a
malformed frame produces an `important` output event and exit 1.

### Worker control channel and process tree

The adapter and its Robot worker exchange the unchanged framed control and event
messages over one private loopback TCP connection (`control.py`, standard library
only). For each launch the adapter listens on `127.0.0.1` with an OS-allocated port
(never a fixed port) and generates a random 32-byte session secret. The worker gets
the port in its argv (`--control-port`) and the secret as one hex line on its stdin
pipe, which the adapter closes after writing, so the secret is never in argv or the
environment and the worker's stdin then reads EOF, as before. Both ends prove the
secret with HMAC-SHA256 over a fresh nonce from each side; the secret itself never
crosses the socket:

1. worker → adapter: `RCB-CONTROL-1\n` and a 32-byte worker nonce;
2. adapter → worker: a 32-byte adapter nonce and `HMAC(secret, "adapter" + worker nonce + adapter nonce)`;
3. worker → adapter: `HMAC(secret, "worker" + adapter nonce + worker nonce)`.

Any other connection is closed and reported as an `important` output
`Refused an unauthenticated Robot worker control connection: <address> (<reason>)`;
the adapter keeps waiting for its own worker. Connections are authenticated one at a
time; each whole handshake has a 2-second bound (not per read), the launch 30 seconds,
and the worker waits up to 30 seconds for its own handshake. After ten reported
refusals one summary line follows and further refusals are not reported each, so a
local process cannot flood the client. A local process that keeps connecting can still
delay or fail a launch; it cannot get a connection accepted. Once the worker is authenticated the listener is closed, so a
session has exactly one control connection and later connections are refused by the
OS. A worker that refuses the adapter's proof, or exits before it connects, fails
`launch` with `Robot worker did not open its control channel (worker exit code N)`.
On Windows the listener also sets `SO_EXCLUSIVEADDRUSE`. Inherited file descriptors
(`pass_fds`) are no longer used.

`process_tree.py` owns starting and stopping both child trees, the Robot worker and
the Python handoff's debugpy adapter:

| | POSIX (Linux verified) | Windows (**not Windows-verified**) |
| --- | --- | --- |
| Start | `start_new_session=True`: the child leads a new process group | `CREATE_NEW_PROCESS_GROUP \| CREATE_SUSPENDED`; assigned to a new Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (ctypes), then its threads are resumed (Toolhelp thread snapshot, `ResumeThread`) |
| Stop | SIGTERM to the group, SIGKILL after 5 s | `TerminateJobObject` at once (no `CTRL_BREAK_EVENT`, which can reach every process on a shared console) |
| Leftovers after the leader exits | SIGKILL to the group while the exited leader is still unreaped (`os.waitid(..., WNOWAIT)`), then reap | `TerminateJobObject`; closing the job handle (also when the adapter dies) kills every member |

Because the child starts suspended and is resumed only after assignment, every
process it starts is in the job, including the real interpreter that a venv's
`python.exe` redirector starts. On POSIX the group is never signalled after its leader
was reaped, so a reused process group ID cannot be hit. All waits and reaps go through
the tree (`ProcessTree.poll/wait/stop`). POSIX-only names (`os.killpg`, `signal.SIGKILL`) and the
Windows API are referenced only inside their platform's functions, so every runtime
module imports on both platforms. Windows process handles are released after reap;
concurrent tree waits serialize native handle access. Failed job assignment also
closes the process, job and pipe handles.

When the worker ends without the adapter stopping it, by a signal (POSIX) or with an
exit status above 255 (a Windows NTSTATUS such as `0xC0000005`), the adapter sends an
`important` output `Robot worker crashed: terminated by SIGKILL` (or `exit status
0x...`), kills the rest of its tree and sends `exited` with the real code and
`terminated`. A control channel that fails after readiness is reported as `Robot worker
control channel failed: <error>`. Robot's own results (exit 0-255) are normal exits; a
Windows process killed from outside with a small exit code is not recognised as a
crash.

Failed cleanup is never ignored: a group that cannot be signalled, a job that cannot
be terminated or a process still running after it was killed is sent as an `important`
output `<Robot worker|Python adapter> cleanup failed: <detail>`, written to stderr as
`Debug cleanup failed: ...`, and the `dap` service then exits with status **5** instead
of 0 (disconnect) or 1 (input closed or malformed frame).

Windows status: the first full live run failed (see Runtime and installation).
The current repairs still need a passing exact-commit Windows run (MIS-434).
Their pure logic (Popen flags, Job Object structure, error mapping, stop control flow
with a stand-in job) and an import of every runtime module with `sys.platform` set to
`win32` and POSIX-only names removed are checked on Linux (`test_process_tree.py`). On
Windows the same suite runs real trees in Job Objects, and the live suites observe
processes through `tests/processes.py`: a Toolhelp32 process snapshot with creation
times (never `/proc`), following venv launchers to the base interpreter, so a leaked
child Python process is found even after its parent exited. On Windows a stop has no
graceful step: the job is terminated at once and the worker reports exit code 1.

## Python handoff v1

This contract is exercised by `test_dap_mixed_live.py` with debugpy 1.8.22. It is a
backend extension, **not advertised in initialize**.
Request it explicitly in Robot `launch` with `"pythonDebug": {"handoffVersion": 1}`.
Other versions, boolean versions and unknown options fail. The backend requires
exactly debugpy 1.8.22; missing/wrong versions produce a prerequisite error rather
than a successful handoff. A normal Robot-only launch does not start debugpy.

The parent owns a separate `python -m debugpy.adapter` stdio subprocess in its own
process tree (`process_tree.py`) and a single-client loopback DAP proxy on an OS-allocated port. It
emits `robotCompanion/pythonSession` with this v1 body:

| Field | Meaning |
| --- | --- |
| `version`, `phase`, `sessionId` | `1`, `"start"`, and a per-session opaque ID |
| `adapter.id`, `adapter.version`, `adapter.processId` | `debugpy`, `1.8.22`, owned adapter PID |
| `owner.processId`, `owner.debuggeeProcessId` | Native DAP adapter PID and actual Robot interpreter PID from authenticated worker readiness |
| `connect.host`, `connect.port` | `127.0.0.1` and the allocated child DAP proxy port |
| `configuration` | Child `request: "attach"`, `listen: {host: "127.0.0.1", port: 0}`, `subProcess: false`, `justMyCode: false` |
| `lifecycle` | Parent owns adapter, connection and debuggee cleanup |

On Windows the interpreter can be below a venv launcher. The DAP `process` event
and process-tree ownership retain that launched root; `owner.debuggeeProcessId`
identifies the interpreter that debugpy attaches to. The subsequent
`pythonConnected` event must report that same interpreter and handoff version.

Use two DAP connections; handles and thread IDs belong to the connection that
issued them. After Robot launch, connect the child client to `connect`, initialize
it, and send its `attach` request with the supplied configuration. Keep attach
pending while receiving child events. The proxy observes debugpy 1.8.22's
`debugpyWaitingForServer` event and sends its local endpoint to the Robot worker.
The worker calls public `debugpy.configure(subProcess=False)` and `debugpy.connect`
in that same Robot process. It never uses `debugpy.listen` to spawn an untracked
adapter, private debugpy launcher APIs, or a second Robot run.

Wait for child `initialized`, set Python breakpoints, send child
`configurationDone`, and collect the attach response. Wait for the parent's
`robotCompanion/pythonConnected` event (v1 session ID and existing debuggee PID),
set Robot breakpoints and send Robot `configurationDone`. The parent rejects
configuration until the worker reports Python connected. Child DAP `launch` or
changing the supplied local attach endpoint/subprocess configuration closes the
mixed session; the child is an attachment to the owned worker only.

Drive Python frames/scopes/variables/evaluate/step through the child connection.
After continuing Python, select a newly obtained Robot frame on the parent
connection before executing Robot keywords. Robot handles from an earlier pause
are invalid. Parent terminate/disconnect/EOF stops the worker even while Python is
paused, closes the child connection/listener, terminates/reaps the adapter process
group and emits `robotCompanion/pythonSession` with `version: 1`, `phase: "end"`
and the same `sessionId`. Unexpected child connection/adapter loss terminates the
owned Robot worker, preventing an orphan session. Reconnection is unsupported.

The attach/event ordering above is measured against debugpy 1.8.22 only. Child
connection loss closes handles even when the lost peer makes a buffered writer's
final flush fail, so `terminated` and the session `end` event are still sent.

## Launch the discovery service

`robot-companion-backend discovery` (from source:
`PYTHONPATH=backend/src python3 -m robot_companion_backend discovery`) serves Robot
Companion's **normalized discovery API v1**, so Test Explorer can list tests without
RobotCode. It needs only this distribution on a supported runtime row: no RobotCode, Node or
VS Code. Its contract-v1 descriptor entry, launched without a shell (the caller supplies
cwd and environment as for the other services):

```json
{
  "services": {
    "discovery": {
      "executable": "/tmp/rcb-venv/bin/robot-companion-backend",
      "argv": ["discovery"],
      "transport": "stdio"
    }
  }
}
```

Transport is stdio JSON-RPC 2.0 with LSP Content-Length framing and the LSP lifecycle:
`initialize` returns exactly `{"capabilities": {"robotCompanionDiscovery": {"version": 1}}}`
(and fails with -32002 when RF is absent); `shutdown`, then `exit` ends the process with
code 0 (1 without `shutdown`). Requests before `initialize` fail with -32002, after
`shutdown` with -32600. An unknown method with an id gets -32601; unknown notifications are
not answered and are logged on stderr. Protocol stdout carries only replies; logs,
including RF's own parser messages, go to stderr.

`robotCompanion/discoverTests` with `{"workspaceUri": "file:///…"}` returns
`{"version": 1, "items": [suite, …]}`. A suite is `{"kind": "suite", "label", "uri",
"range", "children": [test, …]}` and a test `{"kind": "test", "label", "uri", "range"}`
with its suite file's URI. Top-level items are file suites only, each file once, in RF's
order (case-insensitively sorted, depth first). Ranges are 0-based LSP positions in UTF-16
code units: a suite spans its file; a test starts at its name on the name line and ends
after its last data or comment cell (trailing empty lines excluded). Lines are counted as
LSP clients count them (breaks at `\n`, `\r\n`, `\r` only), although RF also breaks lines at
form feeds, U+2028 and similar characters. Duplicate test names in one file are all
returned, in file order; the client disambiguates them by occurrence. Replies may be up to
64 MiB (requests stay bounded at 8 MiB).

- **Robot's own parser and suite builder.** Each file is read with RF's `FileReader`
  (UTF-8, BOM removed), parsed with `get_model` and built with `TestSuite.from_model`, with
  the test defaults RF's `parse_init_file` takes from the `__init__.robot` files above it.
  Nothing is executed: no test, keyword, setup, library, variable file or inline Python.
  A `language:` line naming no built-in language would make RF's lexer import it as a
  Python module; discovery refuses that import, so RF reports the line as `Invalid language
  configuration` (an error, below) and built-in languages (`Language: German`) still work.
  `*** Tasks ***`, templated tests and the running RF's other syntax come from RF's own model.
  Tests RF drops when it runs, those tagged `robot:exclude` (directly, through a variable
  of the file or through an init file's `Test Tags`), are left out too.
- **Labels are RF's names.** A suite's label is RF's suite name (`audit.robot` → `Audit`).
  A test's label is the name RF gives the test when it runs: RF replaces variables in
  test names (`Login On ${ENVIRONMENT}` runs as `Login On staging`), so discovery applies
  RF's own `replace_string` to the variables known before the suite runs: single-value
  scalars of the file's own `*** Variables ***` section (resolved against each other),
  `${SPACE}`, `${EMPTY}`, `${TRUE}`/`${FALSE}`/`${NONE}`, `${/}`, `${:}`, `${\n}` and
  numbers converted by RF's own `NumberFinder` (`${1.5}`, `${0x10}`). Other variables
  (resources, variable files, command line, environment such as `%{HOME=x}`, other
  built-ins such as `${TEMPDIR}`, extended syntax, item access, inline Python, values set
  during the run) stay as written, as RF writes a variable it cannot resolve; RF may
  resolve some of them at run time.
- **What is a suite.** RF's directory rules: `.robot` files (suffix case-insensitive);
  names starting with `_` or `.` (so `__init__.robot` and every dot-directory) and `CVS`
  directories are ignored. `.resource`, `.rbt`, `.robot.rst`/`.robot.md` and other files
  are not suites. Files without tests or tasks are omitted. Symbolic links (files and
  directories) and Windows junctions are not followed, so every reported URI is the workspace folder's path plus
  a relative path inside it; RF itself would follow them.
- **Errors are explicit.** A file with RF parsing or model errors (an unknown setting, an
  invalid section header, ...) still returns the tests RF builds from it, as `robot` runs
  them. A file that cannot be read or decoded is omitted. In both cases, and for errors in
  `__init__.robot` files or unreadable directories, the result carries an additive
  `"errors": [{"uri", "range", "message"}, …]` array (only when there is an error; same
  messages as RF), and each error is logged on stderr as
  `Discovery error: <uri>:<1-based line>: <message>`. Deprecation warnings are not errors.
- **Workspace URI.** Only an absolute local `file:` URI (empty or `localhost` authority, no
  query or fragment, no `.`/`..` segment) of an existing directory is accepted; on Windows
  it must name a drive (`file:///c%3A/...` or `file:///C:/...`), never a UNC or device path,
  and a segment of only dots and spaces is refused, because Win32 trims them; anything
  else, a missing or non-string `workspaceUri` and non-object params return JSON-RPC error
  -32602. Reported URIs are the folder's path as given (not resolved through symbolic
  links) plus the relative file path, encoded by Python's `Path.as_uri()`; a
  `file://localhost/...` folder is reported as `file:///...`. Before `initialize` any
  request fails with -32002 and after `shutdown` with -32600, as in the LSP lifecycle.
- **Freshness.** Nothing is cached: every request reads the workspace again, so files
  added, edited or deleted on disk are reflected by the next request without a restart.
  On a synthetic 500-file, 10,000-test workspace one request took about 1.5 s (advisory,
  container measurement; not a performance guarantee).

`test_discovery_live.py` has nine real-process cases on each runtime row, started through the
installed `robot-companion-backend discovery` script when present (else `python -m`): the
lifecycle and error codes with only the venv's `bin` on `PATH` (no Node, npm or VS Code);
the audit corpus plus a nested multi-directory fixture (`tests/discovery_fixtures`: tasks
with a template, `${variables}` in names, a duplicate name, umlauts and non-BMP characters,
`${1.5}`/`${0x10}` numbers, a templated test, a parse-error file, an empty file, a
resource, `__init__.robot` files including one whose `Test Tags robot:exclude` drops its
directory, tests excluded by tag and by a variable tag, library and variable-file imports
with side effects) compared with
`robot --dryrun --norpa --extension robot` on the same workspace — the same multiset of
long names and of (file, name line, name), with exact UTF-16 ranges — and no import or
keyword side effect from discovery while the dry run (positive control) imports the
library and variable file; ignored, hidden, private, `CVS`, resource, other-extension and
symlinked files; explicit errors (parse errors, an `__init__.robot` error, Latin-1 and
unreadable files) in the result and on stderr; fourteen refused workspace URIs; added,
renamed and deleted files seen by one process; a workspace `robot.py` never imported
when the service runs as `python -m` in the workspace; a `language:` line naming a
Python file never imported (RF's own parser imports it, the positive control) while
`Language: German` works and matches the dry run; and LSP ranges across U+2028 and
form-feed line breaks, a 5,000-digit number variable (RF's `inf`) and a 1,100-level
directory tree.

## Headless checks

From the repository root, without npm or VS Code:

```bash
# Mechanical checks: no RF required, not language/debug acceptance.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_transport.py -v

# Required parser-backed checks: fails rather than skipping if RF is missing.
RCB_TRANSCRIPTS=/evidence/mis191/lsp PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_live.py -v

# Required hover/completion/signature help checks; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis321/lsp-features PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_features_live.py -v

# Required references/rename/document and workspace symbol checks; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis350/lsp-navigation PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_navigation_live.py -v

# Required diagnostics/quick-fix/formatting checks; fails without a supported RF row and Robocop 9.1.0.
RCB_TRANSCRIPTS=/evidence/mis364/lsp-diagnostics PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_diagnostics_live.py -v

# Required semantic token checks (full, range, didChange); fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis427/lsp-semantic-tokens PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_semantic_tokens_live.py -v

# Required discovery API v1 checks, compared with `robot --dryrun`; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis388/discovery PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_discovery_live.py -v

# DAP lifecycle: real adapter/worker subprocesses, no RF required.
RCB_TRANSCRIPTS=/evidence/mis191/dap PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_lifecycle.py -v

# Process tree and control channel with real processes/sockets, Windows logic and win32 import; needs a supported RF row.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_process_tree.py -v

# Required live Robot pause/console/stepping/cleanup; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis191/dap-live PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_live.py -v

# Required conditional breakpoint/logpoint conformance; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis424/dap-conditional PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_conditional_live.py -v

# Required breakpoint editing, Pause and Step Out checks; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis500/dap-controls PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_controls_live.py -v

# Required control channel refusal, worker crash and whole-tree cleanup; fails without a supported RF row.
RCB_TRANSCRIPTS=/evidence/mis432/dap-process PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_process_live.py -v

# Required real two-session Robot/debugpy conformance; fails without RF/debugpy.
RCB_TRANSCRIPTS=/evidence/mis191/mixed-live PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_mixed_live.py -v
```

The DAP lifecycle suite checks capability advertisement, unsupported/malformed requests
and frames, failed process creation without leaked pipe or socket descriptors, RF-absent
launch errors, and Python handoff version/missing-debugpy prerequisite errors. Cleanup checks require process observation
(Linux /proc or a Windows process snapshot) and fail if it is unavailable. The suite also checks that terminate
and disconnect leave no child of the adapter and no process in the launch cwd. Its
prerequisite case is skipped when RF is installed. `test_dap_live.py` starts actual
adapter/Robot subprocesses and requires a supported RF row with RobotCode absent. Its four cases
assert breakpoint verification (including a nonexecutable line), the audit pause,
stack/scopes/compound record variables, the from-suite-console result, a console-only variable mutation surviving resume, next/stepIn,
Resource Step with Ada in the paused context, stale-handle rejection, successful
completion, and paused terminate/disconnect/client-EOF cleanup. Protocol transcripts
and Robot output files are retained through `RCB_TRANSCRIPTS`.

`test_dap_conditional_live.py` has five required real-process cases on a generated
`FOR ${iteration} IN RANGE 3` suite: `$iteration == 2` on the loop-body call stops once,
with `${iteration}` 2 in the live variables and a live `Catenate` console result, while
the same condition on the `FOR` line (unverified), on another `loop.robot` and on an
unimported resource defining the same keyword never stops, and a false `${value} == 99`
in the resource keyword's scope never stops; the test then passes. Logpoints print
`iteration=0/1/2` plus a conditional resource logpoint (values 1 and 2 only) with literal
braces, `${value}`, expressions and an inline error, with no `stopped` event and an
unchanged Robot log, and a `Run Keyword` line logged once with `@{items}`. Invalid
inputs check each refusal and unverified reason (including a 100,000-term expression),
runtime condition errors (no stop for value 0, stops for 1 and 2) and their `important`
output, a truncated huge logpoint value and a single conditional stop on a `Run Keyword`
line. A recursive resource keyword whose recursive call is on one line logs `n=2` and
`n=1` there (not the NOT RUN call with 0) and stops once at `$n == 1`, with two
`Countdown` frames on that line above the first call. A pause on a conditional
breakpoint is terminated and leaves no process.

`test_dap_controls_live.py` copies `tests/controls_fixtures` (synthetic suites) into a
directory whose name has a space and `Ü`. Five cases drive the worker's control pump
over a real socket pair: fragmented UTF-8 frames keep arrival order, a snapshot never
blocks, malformed framing and EOF end the queue, and stop with an idle open peer is
bounded. Thirteen real-process cases check: paused replacement (kept and new IDs,
`verified` in the reply, no stop at a removed line, another source untouched, invalid
batches leaving the set unchanged, a nonexecutable line, no reused ID); running
replacements applied at the next keyword after a blocking call, where only the latest
of three generations reports and stops; Pause on the regular-step loop within
5 seconds and a breakpoint added while running; Pause during a blocking call (no
`stopped`, `stackTrace` refused) then terminate, and client EOF with queued controls;
refusals before launch, before `configurationDone`, while running, while paused, for
an unknown thread and after the run; nested Step Out to the exact caller lines with the
completed keyword's values (LF and CRLF sources), stale handles refused, a NOT RUN
branch skipped and the outermost refusal keeping the session usable with a live
console keyword; recursion by invocation, a `Run Keyword` wrapper, an early `RETURN`
and completion without a next caller; and three Pause / console keyword / Step Out /
add breakpoint / Continue cycles. Every case asserts that no owned process remains and
that the test fallback cleanup did not run.

`test_process_tree.py` has twenty-one required cases. With real processes it checks that
a started child leads its own process group, that stop terminates it and a grandchild,
escalates to SIGKILL for a tree ignoring SIGTERM, kills a grandchild left by an exited
leader with the leader still an unreaped zombie and never signals the group again after
the reap, and reports a group that cannot be signalled; the adapter reports cleanup
failure on output and stderr and exits 5, also after its DAP client has gone. With real
loopback sockets, a raw-bytes and a wrong-proof foreign connection are refused before
the secret holder (a separate process) is accepted, the listener then refuses
connections, a peer sending one byte every 0.3 s is cut off by the whole-handshake
deadline, refusal output is capped, and the worker side refuses a listener without the
secret. Not Windows-verified: Windows Popen flags, the Job Object and THREADENTRY32
structures and kill-on-close flag, thread resume and error mapping with a stand-in
kernel32, stop control flow with a stand-in job, and the import of every runtime module with `sys.platform`
`win32` and `os.killpg`, `signal.SIGKILL` and other POSIX-only names removed (RF is
imported first as a dependency, hence the RF requirement).

`test_dap_process_live.py` has six required real-process cases on a generated suite
whose library starts a grandchild Python process. A test-only `sitecustomize` holds
the worker for two seconds so that two foreign connections (raw bytes; the correct
greeting with a wrong proof) reach the listener first: both are refused and
reported, the launch succeeds, the port is closed afterwards, the worker's argv and
environment variable names carry no secret, and the session pauses, evaluates
`Catenate` and completes. Other cases: a worker that exits before connecting fails
`launch` without leaking a child or descriptor; a paused worker killed with SIGKILL is
reported as crashed with `exited` -9 and its grandchild is killed; terminate of a
worker and grandchild that both ignore SIGTERM escalates to SIGKILL; disconnect kills
the paused tree; and a grandchild left by a finished run is killed.

`test_dap_mixed_live.py` contains six required real-process cases. It drives the
Robot pause/console, the owned debugpy child attachment, AuditLibrary.py line
18→19, `count == 3`, explicit return to the Robot frame and Resource Step with Ada,
a console-only mutation, stale Robot frame rejection, and successful completion.
Separate cases terminate, disconnect or close the parent input while Python is
paused, and close the child connection, including a worker that ignores SIGTERM. Cleanup checks observe worker/adapter
processes, child-reader EOF and closure of the allocated port. Missing RF or
debugpy is an error, never a skip.

Use the independent backend venv's Python for acceptance. Omit `PYTHONPATH` when
checking the installed wheel so the source checkout cannot mask packaging errors.
The client launches actual backend subprocesses with bounded timeouts and drains
stderr. Cleanup first closes parent input and waits for owned shutdown; its bounded
forced fallback uses retained child PID/start-time identities and is reported
as a test failure if needed during successful live cases. Readers are joined.
The live suite covers audit navigation, unimported shadow exclusion, aliases and
ambiguity, import diagnostic severities (standard library, unmodelled module,
missing file), changed library/resource sources and overlays, variables in distinct
owners, embedded keywords, UTF-16 positions and orderly shutdown.
`test_lsp_features_live.py` has fifteen real-process cases: audit hover never choosing
AShadow.py, resource/local/alias/Collections hover and the matching definition,
static-only variable hover (suite, dynamic, `${CURDIR}`, run-time built-in, unknown,
arguments in the test file and in a resource), keyword completion origins without
the shadow plus non-call cells, scoped variable completion including the
other-test/other-keyword and same-call negatives, UTF-16 edit ranges with umlauts and
emoji, positional/named/varargs/kwargs/continuation signature help, invalidation by
resource `didChange`, import changes and a saved library, unsupported
`completionItem/resolve` and unindexed Remote/Telnet imports, a server started in
the workspace never executing a workspace `lxml.py` while indexing XML, escaped
Markdown documentation, no `Returns` line without a return annotation, hover on
typed variable definition cells, variable completion keeping an extended-syntax
suffix, and signature help ignoring `=` inside variables and inline expressions. Same-call variable resolution, invalid `[Arguments]` and
completion before existing cell text are also asserted.
`test_lsp_navigation_live.py` has thirteen real-process cases: keyword references from a
call, an alias call and the Python definition that include `Audit.Build Record` and
never the AShadow.py, own same-named or ambiguous calls; resource keyword references
through `[Setup]`, BDD and qualified cells; variable references limited to their scope
(the out-of-scope keyword/test-local negative and a shadowing suite); keyword rename
with exact UTF-16 edits on umlaut/emoji lines that keeps prefixes and leaves comments,
documentation, arguments and another same-named keyword alone, also from a caret just
after the name; refused rename (and prepareRename) of the Python and BuiltIn keywords,
ambiguous keywords and calls, invalid names and a built-in variable; scoped variable
rename; `$name` expression uses, escaped literals and `name=` named-argument callers;
variables nested in `${{ }}`, in a variable name and in item access, and inline IF
assignment scope, each renamed and the renamed suite run with the row's RF; loop-carried
variables (the MIS-359 inline-IF and plain-assignment repro, a variable first set in a
loop, a WHILE condition and inner FOR body reaching an outer reassignment, an outer
body reaching an inner one, and a loop without reassignment as control) with exact
reference sets from each definition and use, every rename run with the row's RF, and a
refused rename where a built-in reaches the loop use;
hierarchical document symbols; workspace symbols in unopened files; invalidation by
`didChange` and by created/changed/deleted files reported with
`workspace/didChangeWatchedFiles`; and a `workspaceFolders`-bounded scan with plain
`renameProvider`, flat symbols and no code actions for a client without
prepare/hierarchy/CodeAction-literal support.
`test_lsp_diagnostics_live.py` has twenty-five real-process cases: no error or warning for
the valid audit.robot and shared.resource; `${TEST METADATA}` defined only on the RF 7.5 row,
each row checked against RF's own run of the suite; RF parsing/model errors with UTF-16 ranges
after umlauts and emoji (and a test case section in a resource); deprecated syntax as
warnings and a keyword with an invalid embedded pattern not stopping publication; `Build Record` without
the AuditLibrary.py import reported as unknown although the unimported AShadow.py defines
it, with no import guessed between the two; BDD prefixes, `Run Keyword` names and
variable keyword names not reported; unknown keywords suppressed for class,
unmodelled, Remote and missing libraries, `@deco.keyword`, a computed
keyword name, `Import Library` and a `Language:` header; a resource keyword using a
keyword of the suite importing it, and no report in a resource imported through
`${CURDIR}`; the ambiguity warning naming
both sources, its qualifying quick fixes, `context.only`, applying one and the warning
disappearing, and `Set Library Search Order`; argument-count errors for library, alias,
resource, BuiltIn and setup/suite-setup calls with no false error for named, `@{}` or
embedded arguments; undefined-variable warnings (including another test's local and
another file's `VAR` without scope) with no warning for dynamically set variables (`Set
Suite Variable` in another suite, `Set Global Variable` via `Run Keyword` and as a
`[Teardown]`, `Suite Setup    Set Suite Variable` in `__init__.robot`, `VAR scope=SUITE`, a
a `RETURN ${nope}` value warned while an argument returned (also from an inline IF) is not, a
setter whose `${NAME}` holds the name locally or in an imported resource, a wrapper keyword
passing the name as an argument) while the rule stays active after `Set Suite Variable
${COUNT}` with a literal value, loop-carried values, extended syntax, numbers, built-ins, `Get Variable
Value`, `$name` and escaped uses, a `Variables` import, a variable-setting Python library
or a computed setter name; the import quick fixes for a resource and a library in a
subdirectory, applied, clearing the diagnostic and the fixed suite passing with the row's RF, and
none for a keyword a standard library also defines;
no code actions without CodeAction literal support; Robocop formatting of the audit corpus
that is deterministic, idempotent and keeps the audit suite passing; CRLF line endings
and UTF-16 edit ranges with emoji; a lone CR refused; `null` for a Python file; and no
`documentFormattingProvider` (and -32601) when Robocop cannot be imported. Nine of them
cover module library keywords, each fixture also run with the row's RF and its outcome
asserted: plain `ring_bell` functions in two libraries, and one with a `@keyword("Ring
Bell")`, giving one ambiguity warning (UTF-16 range after an emoji) whose qualify fixes
clear it and pass with RF; a literal `__all__` (also annotated) hiding a plain and a
`@keyword` function by Python name; `ROBOT_AUTO_KEYWORDS = False`; `@not_keyword`; a
custom `def log` winning over BuiltIn; argument counts of a plain function, skipped under
`Set Library Search Order` and when another library exposes the name through an assigned
name; definition and hover with UTF-16 ranges, unqualified and qualified; and no
diagnostic, as intended divergences where RF fails, for a class library, a class-based
dynamic library, an imported name, a conditional definition, another decorator, a
computed or mutated `__all__`, a computed `ROBOT_AUTO_KEYWORDS`, `keyword("Renamed
Plain")(plain)`, a literal `robot_name` (also renaming a `@keyword` function next to
NorthLib.py) and a guarded `@keyword` (those four pass with RF), a name bound through
`global`, and `ring_bell`/`ringBell` in one library (qualified, and unqualified next to
NorthLib.py).
Full backend conformance is the release runner: installed wheel with the `format` extra,
all fifteen suites, RobotCode absent.

## Architecture and limits

`protocol.py` bounds headers to 8 KiB and payloads to 8 MiB, handles short byte
reads, serializes writes and rejects malformed frames. `lsp.py` handles lifecycle,
full-text overlays, workspace folders, definition requests and diagnostic
publication, and dispatches hover, completion and signature help to `features.py`,
references, rename and symbols to `navigation.py`, diagnostics and code actions to
`diagnostics.py` and formatting to `formatting.py`. Requests run
serially; completed requests may ignore subsequent cancellation notifications.
No asynchronous worker returns an old document result.
`discovery.py` serves the discovery API with the same lifecycle loop; it walks the
workspace by RF's directory rules, builds each file with RF's reader, parser and suite
builder, and takes errors from the same `model_errors` as diagnostics.

`workspace.py` uses Robot Framework's parser/model for Robot syntax and an explicit
resource/library graph rooted at each document. It follows imports rather than
scanning every Python file. Python AST reads a library's `@keyword` functions and,
for a statically readable module, its plain top-level functions (see *Module library
keywords*) without importing or executing a library. Local, resource and library precedence
is explicit; ambiguity returns all matching source locations and a warning,
never an alphabetically chosen path. Standard-library imports (`Library
Collections`, RF's `robot.libraries.STDLIBS`) are recognised without a diagnostic
and, as in RF, ahead of a sibling file of the same name. Their keywords, and those of
the implicitly imported BuiltIn, come from RF's own libdoc for the installed RF,
cached per server process; definitions point into RF's library source. This imports
RF's bundled library modules in the language-server process (output kept off the
protocol stdout; the `lsp` service drops its cwd from `sys.path` at start, and libdoc
runs without it again, so that optional
imports such as XML's `lxml`, or RF itself, cannot load a same-named workspace module); workspace
libraries are still never imported. Remote is not
inspected (its keywords exist only at run time and would require a connection), and
a standard library that cannot be imported in the runtime (Telnet on Python 3.13; Python 3.11 still has `telnetlib`,
Dialogs without Tk) contributes no keywords, logged on stderr. Custom libraries take
precedence over standard libraries, as in RF. Another module-name library without a
sibling file (`a.b.C` maps to `a/b/C.py`; an open unsaved buffer counts) gets an
Information diagnostic `Library not resolved in this version: <name>`, because
sys.path and `--pythonpath` are not modelled; a misspelt module name is therefore
not an error. A missing `.py` or path import is an error.
Imported dependencies are reread per request, so a saved source change cannot
reuse a stale symbol cache. Unsaved text overlays
win until close. Source positions convert code points/Python AST UTF-8 offsets to
LSP UTF-16. Variables resolve within the current owner (arguments, embedded
arguments, assignments, `VAR`, `FOR` and `EXCEPT AS` variables), then the suite's
Variables section, then imported resources' Variables sections, then RF built-ins.
A module-name library's namespace is its full module name (`company.robot.Helpers`),
a path import's is its file stem. Python keyword arguments, defaults, annotations and
docstrings come from the AST; resource keyword arguments from RF's own
`[Arguments]` parser.

`test_lsp_live.py`, `test_lsp_features_live.py`, `test_lsp_navigation_live.py`,
`test_lsp_diagnostics_live.py` and `test_lsp_semantic_tokens_live.py` verify these
behaviors on both runtime rows.
Static Python class libraries, dynamic/module search paths, variable files,
variable-based imports (still an error diagnostic), keyword completion and signature
help in setting cells, `Run Keyword` arguments, complete runtime variable
scopes and large-workspace performance need further outcomes. These class/dynamic-library
and static-model limits are the same on both runtime rows. No workspace library code is executed during indexing.

## Capability inventory and continuation

| Family | Current state | Evidence / next boundary |
| --- | --- | --- |
| Byte framing, malformed input, CLI subprocesses, Python definition columns and lines | Mechanical checks pass | `test_transport.py`, 11 tests |
| LSP lifecycle, definition, parser/import graph | Phase 1, live on both runtime rows | `test_lsp_live.py`, 8 real-process cases (2 refuse unsupported Python/RF rows) |
| Hover (keywords, static variable values), completion (keywords, scoped variables), signature help | Implemented for keyword-call cells in test/keyword bodies, live on both runtime rows; no completion resolve/snippets | `test_lsp_features_live.py`, 15 real-process cases |
| Diagnostics: RF parsing/model errors, imports, unknown keywords, ambiguity, argument counts, undefined variables | Implemented with the documented static rules, live on both runtime rows, including plain functions of statically readable module libraries (`__all__`, `ROBOT_AUTO_KEYWORDS`, `@not_keyword`); imported/assigned-name collisions not reported; no CLI `--variable` knowledge | `test_lsp_diagnostics_live.py` (25 real-process cases, 9 for module library keywords with RF runs on each row), import severities in `test_lsp_live.py` |
| Semantic tokens (`full`, `range`): headers, settings, test/keyword names, keyword calls with `resolved`/`defaultLibrary`, variables, comments, control markers, BDD prefixes, continuation | Implemented from RF's model and definition's resolution, live on both runtime rows; no `full/delta`, no `$name` expression or qualifier tokens | `test_lsp_semantic_tokens_live.py`, 9 real-process cases |
| Code actions: import quick fix, qualify ambiguous call | Implemented (`quickfix` only, clients with CodeAction literal support) | `test_lsp_diagnostics_live.py`, applied edits clear the diagnostic |
| Document formatting | Implemented with optional Robocop 9.1.0 defaults; no range/on-type formatting or Robocop configuration | `test_lsp_diagnostics_live.py`, idempotent and audit suite passing before/after |
| DAP lifecycle: initialize, launch prerequisite, breakpoints, threads, terminate/disconnect | Phase 1 | `test_dap_lifecycle.py`, 7 tests (RF-absent case skips with RF installed) |
| Worker control channel (authenticated loopback socket) and process-tree lifecycle (`process_tree.py`) | Live on Linux on both runtime rows: foreign connection refused, crash reported, whole tree killed, failed cleanup reported (exit 5); Windows Job Object qualification is source-bound in MIS-434 | `test_process_tree.py`, 25 tests; `test_dap_process_live.py`, 6 real-process cases; Windows execution and a process-snapshot leak check: MIS-434 |
| Conditional Robot breakpoints and logpoints (`supportsConditionalBreakpoints`, `supportsLogPoints`) | Implemented with RF condition semantics on the Robot thread, live on both runtime rows; replaceable during the run like plain breakpoints | `test_dap_conditional_live.py`, 5 real-process cases |
| Robot pause, stack/scopes/variables, step/continue, live console evaluate | Phase 1, live on both runtime rows | `test_dap_live.py`, 4 real-process cases |
| Breakpoint changes after `configurationDone`, `pause`, `stepOut` | Implemented at keyword-start safe points, live on both runtime rows; blocking library code is not interrupted; Step Out refused at test/suite level | `test_dap_controls_live.py`, 18 cases (13 real-process, 5 control-pump socket cases) |
| Versioned debugpy child handoff and cleanup | Phase 1 v1, live with debugpy 1.8.22; not advertised in initialize | `test_dap_mixed_live.py`, 6 real-process cases |
| Standalone wheel/sdist build, install and conformance | Offline in-tree build, pip rebuild identity, installed-wheel suites per runtime row, worker interpreter recorded | `backend/scripts/verify_release.py --python <row interpreter> --wheels <row wheel set>` |
| Runtime matrix: Python 3.11 + RF 7.3.2, Python 3.13 + RF 7.5 | Both rows verified on Linux aarch64 only; other combinations refused | Windows qualification: MIS-434 |
| References (keywords, scoped variables), rename (user keywords, scoped variables), document/workspace symbols | Implemented for `.robot`/`.resource` workspace files, live on both runtime rows; Python/standard-library keyword rename refused; `Run Keyword` arguments not modelled | `test_lsp_navigation_live.py`, 13 real-process cases |
| Test discovery: normalized discovery API v1 (`discovery` service) | Implemented for `.robot` file suites with the running RF's parser/builder and init defaults; labels resolve only statically known variables; no directory suites, tags or `__init__.robot` suite settings in the result | `test_discovery_live.py`, 9 real-process cases compared with `robot --dryrun` |
| Per-test results/streaming, range formatting, other code actions (refactorings, source actions), semantic token deltas, inlay hints | Missing | Separate bounded outcomes |
| Multi-root/remote, config, other platforms/versions | Unverified | Windows: MIS-434; other rows need their own outcome |
| Hit-count (`hitCondition` refused), reverse/data/function breakpoints, setVariable, exceptions | Unsupported | Do not advertise them |
| Notebook/TOML/Markdown, secondary AI/tool integrations | Missing | Program parity inventory; no LLM in this product |

The Lead owns follow-up scheduling under MIS-190 and decides phase-1 acceptance.
This document does not claim full language-server/debugger parity or any UI
interaction coverage. Next bounded backend outcomes: debug robustness (hit-count breakpoints,
exception breakpoints); per-test result
streaming through the normalized adapter API (run IDs, per-test status/output); range formatting
and configurable Robocop rules; static class and dynamic
libraries plus module search paths and variable files; `Run Keyword` arguments for
navigation and rename, and Python library keyword rename; keyword completion and
signature help in setting cells; completion item resolve with documentation;
command-line variables and private keywords for diagnostics; large-workspace performance
of the per-request rescans; an RF/Python/platform compatibility matrix; and frontend integration of the v1
descriptor in its own outcome. The supplied `audit-evidence` issue document retains the real baseline
interaction audit (VS Code 1.116.0); this headless source change requires no new
browser/UI flow and does not claim testing in VS Code 1.141.0.

`dap` advertises `restart` and `cancel` in addition to its breakpoint and terminate
capabilities. A restart keeps the client session and its Robot breakpoint IDs and
replaces the Robot worker, the debugpy adapter and the Python child. Robot frame and
variable handles of an earlier run are refused, and the run's inputs cannot change
(an unchanged echo may name a new `--outputdir`; Robot's other spellings of that option, such
as `--outputd`, `-d` or `-dresults`, count as the same option). A restart never writes into an
earlier run's output folder: one that names none (an empty request, a prepared session's
echo) writes below the first run's folder (`restart-<n>`) and names it on the console. A run
that ends just as a restart arrives ends; the restart is refused. `cancel` applies to an
in-flight `launch`, `attach` or `restart`; unknown request IDs are ignored. `disconnect` and
`terminate` always end the owned run. The worker is first asked to stop through its control
channel and ends at its pause or next keyword boundary, which Robot records as *Execution
stopped by user.* (exit code 253) whether Robot or Python is paused; signals follow after
2 seconds only if it has not ended. A restart replaces a run the same way.

`dap-prepare` is the supported way to attach. It runs in the foreground, starts and owns
a Robot worker (with `--attach-python` also a debugpy adapter) that waits before Robot
runs anything, and prints `preparedSession: <path>`. That path is a private one-use
descriptor (POSIX mode 0600 in a 0700 folder; on Windows a protected DACL for the current
account and SYSTEM), at most 16 KiB. Within the attach lease (30 seconds, or a shorter
`--attach-timeout`), a client starts `dap-connect` as its stdio debug adapter. On stdin it
first writes one JSON line, `{"version": 1, "preparedSession": "<path>", "workspace":
"<folder>", "backend": {"id": "robot-companion-native", "version": "0.1.0.dev1"}}`, and
then speaks DAP. The connector reads and checks the descriptor once (owner, permissions,
no link, size, schema, expiry, workspace and backend). It then authenticates to the owner
on 127.0.0.1 with HMAC-SHA256 over fresh nonces, bound to the session ID and the
descriptor digest; the secret never crosses the socket. The first authenticated
connection claims the session: the descriptor is removed, and replays fail. Failed
handshakes only close their own connection. `dap-connect --check` reads the same startup line and runs every check except contacting
the owner. It prints `{"ok": true, "sessionId": …}` or `{"ok": false, "message": …}`
(exit 0 or 2) and never claims the session, so an editor can refuse a consumed or invalid
descriptor before it starts a debug session. The client then sends `attach` (with no
`processId`, `host` or `port`) and configures the run as after a `launch`. The owner ends
its run, removes the descriptor and exits when the lease expires, when an attached client
does not finish configuration within 30 seconds, and on disconnect, connection loss,
Ctrl+C or SIGTERM. This protects against other accounts and other sessions, not against
a hostile process of the same account.

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

- Parser and static-model diagnostics, import/qualification quick fixes, an
  add-missing-imports source action, and document, range and on-type formatting
  with the optional Robocop dependency.
- Semantic tokens for full documents and ranges.
- Inlay hints: argument names and declared return types of keyword calls that
  resolve through the file's imports to exactly one keyword.
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

Formatting uses Robocop defaults. Range and on-type formatting leave out the
formatters that order settings and sections or set empty lines between them, and
decline requests that would change other lines, comments or documentation.
Refactorings and other source actions are unavailable. Semantic token deltas and
inlay hints are unavailable.
Formatting uses Robocop defaults; range/on-type formatting, refactorings and source
actions are unavailable. Semantic token deltas are unavailable. Inlay hints do not map
arguments after a named argument or a list/dictionary expansion, and show no type for a
keyword without a declared return type.
Large-workspace performance, remote workspaces and full multi-root behavior remain
unqualified.

Debugging does not support hit-count, function, data or reverse breakpoints,
`setVariable`, exception-breakpoint controls or breakpoint changes after configuration.
Attach is limited to prepared sessions: attaching to an arbitrary process ID or network
endpoint, detaching (`terminateDebuggee: false`) and reconnecting are unsupported.
Restart cannot change the run's inputs. Full debugger parity is not claimed.

## Build and validation

The package uses a dependency-free in-tree PEP 517 build backend. From the repository:

```sh
SOURCE_DATE_EPOCH=1792368000 python backend/scripts/build_dists.py backend dist
```

`python backend/scripts/bundle_extension.py <offline wheel dir>` rebuilds the copy the
extension carries in `bundled-backend/`: this wheel (fixed timestamps), the debugpy 1.8.22
wheel checked against its published SHA-256, and `manifest.json` with both hashes, the
supported rows and the digest of the installed `robot_companion_backend/` files that the
extension compares after installing. Run it after every backend source change;
`tests/integration/backend-bundle.test.js` fails while the committed copy is stale.

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

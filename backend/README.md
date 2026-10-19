# Independent Robot backend

This distribution is a work-in-progress native backend for the Robot Companion
replacement program. It has no dependency on Node, VS Code, Companion or RobotCode.
The extension and its RobotCode path remain separate and unchanged.

**Current checkpoint (phase 1 plus language features):** bounded stdio transport,
an RF parser-backed LSP with definition, diagnostics with quick fixes, document
formatting (with the optional Robocop 9.1.0), hover, completion,
signature help, references, rename, document/workspace symbols and semantic tokens,
a test discovery service (normalized discovery API v1), an owned DAP worker
with an RF listener and paused-thread command loop, the
versioned debugpy handoff v1, the copied v1 audit corpus and headless tests. With
the approved offline runtime (RF 7.5, debugpy 1.8.22, Robocop 9.1.0, Python 3.13.7,
RobotCode absent), the live LSP, LSP feature, LSP navigation, LSP diagnostics, LSP semantic token,
discovery, Robot DAP
and mixed Robot/Python suites run against real backend, Robot and debugpy subprocesses. `verify_release.py` builds, installs and
runs every suite from the installed wheel. The exact-SHA results are recorded in
the issue's `artifact-handoff`; this README does not borrow a pass for a later
commit. Phase 1 is not full language-server/debugger parity (see the inventory).

## Runtime and installation

Supported: Python 3.13 on Linux with Robot Framework 7.5 and debugpy 1.8.22,
pinned exactly in `pyproject.toml` and `constraints.txt`. The optional `format`
extra adds Robocop 9.1.0 (`robotframework-robocop`, with its pinned dependencies) for
document formatting. The approved WOL-805 offline wheel set (in task containers:
read-only `/opt/robot-wheels`, SHA-256 checked against the operator's
`robot-backend-wheels.sha256`) supplies them. No other Python/RF/debugpy/Robocop
version or platform has been validated.

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

pip can also build and install directly (`PYTHONDONTWRITEBYTECODE=1 pip install
--no-index --find-links /opt/robot-wheels ./backend`), since the build needs no
requirements; without that variable pip's in-tree build hook leaves
`backend/build_backend/__pycache__` behind. Build from a clean checkout, because the
sdist includes every file in its source trees. Editable
installs (`pip install -e`) are not supported; run from source with
`PYTHONPATH=backend/src` instead. No frontend dependency directory is needed.
Never install RobotCode in this venv; the operator's prepared `/opt/robot-backend`
venv contains RobotCode and is therefore **not** an acceptance environment.
`doctor` prints JSON versions, including `"formatter": {"robocop": "9.1.0"}` (or `null`
without the `format` extra), and returns 2 if RF/debugpy is missing or RobotCode is
present. Robocop is optional for doctor. A successful doctor is a prerequisite probe,
not conformance. Without `[format]` the server runs without formatting.

## Verify the standalone release

After the operator supplies the approved read-only local wheel directory, run
this from a **clean committed checkout** with Python 3.13 on Linux. Choose a new
evidence path for each attempt:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 backend/scripts/verify_release.py \
  --wheels "$APPROVED_WHEELS" \
  --scratch-root /tmp \
  --evidence /evidence/mis191/release-batch-1
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

It then runs the nine mechanical harness cases, transport/lifecycle tests and all
seven required live LSP/LSP-feature/LSP-navigation/LSP-diagnostics/discovery/Robot/mixed suites
sequentially using the venv Python and copied synthetic fixtures. Build/test commands have a 300-second bound; source Git reads have a 30-second
bound and their own cleanup/receipts. Linux `/proc`
and process-local orphan adoption track owned descendants across separate process
groups; a timeout or leaked child triggers bounded TERM/KILL/reap and makes that
step fail even if its parent exited zero. No host service/configuration is changed.
Zero-test suites, expected failures and skipped required live tests cannot produce
a conformance pass. The RF-absent lifecycle-only case may skip in a prepared RF
runtime; its result is counted explicitly.

`release.json` records the full source SHA, clean state before/after, exact argv,
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
`textDocument.rename.prepareSupport`, otherwise `true`), `documentSymbolProvider`,
`workspaceSymbolProvider` and `semanticTokensProvider` (the legend below, `full: true`,
`range: true`, no `full/delta`), plus full-text sync. `codeActionProvider` with
`codeActionKinds: ["quickfix"]` is added only when the client declares
`textDocument.codeAction.codeActionLiteralSupport` (the server returns `CodeAction`
literals, never commands), and `documentFormattingProvider: true` only when Robocop
9.1.0 is installed. Without them, `textDocument/codeAction` and
`textDocument/formatting` fail with `Method not implemented` (-32601). Range and
on-type formatting, semantic token deltas, inlay hints and workspace-folder change
notifications are not advertised. The workspace
folders of `initialize` (`workspaceFolders`, else `rootUri`, else `rootPath`; local
`file:` folders only) bound the scan used by references, rename and workspace symbols;
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
  images or HTML; RF's own standard-library documentation is RF 7.5 Markdown and is
  passed through.
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
  arguments), `FOR`/`EXCEPT AS`/`VAR` variables, suite variables and RF 7.5 built-ins
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
  symlinked directories are not followed), plus open Robot documents and the file that
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
| `syntax` | Error | RF 7.5's own parsing and model validation errors, with RF's message, from the loader RF uses for the file (`get_resource_model` for `.resource`, `get_init_model` for `__init__.robot`): unknown settings (`Libary`, `[Föo]`), invalid section headers, a FOR/IF without `END`, `[Arguments]` order, `RETURN` outside a keyword, a test case section in a resource, ... The range is the erroneous cell, or the statement's first line. |
| `deprecated` | Warning | Syntax RF 7.5 still runs but reports as deprecated, as RF does (a model error on a token that is not an error token): singular section headers (`*** Test Case ***`), `[Return]`. |
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
  when it is an RF 7.5 built-in, a number (`${1}`, `${0x1F}`) or the base of RF's
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
gives the diagnostics their open scope, following RF 7.5's static module-library rule
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
modules with a module-level `get_keyword_names`/`run_keyword` (RF 7.5 treats those as
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
Formatting the audit corpus is deterministic and the audit suite passes under RF 7.5
before and after it. Note that Robocop's defaults lower-case tags and may reorder
settings and sections. Range formatting and configurable Robocop rules are not
implemented.

### Semantic tokens

Implemented in `semantic_tokens.py`. `textDocument/semanticTokens/full` and
`textDocument/semanticTokens/range` return `{"data": [...]}` in the LSP 3.17 relative
encoding (per token: line delta, start delta from the previous token on the same line,
length, type index, modifier bits) with 0-based lines and UTF-16 code units, sorted and
never overlapping. There is no `resultId` and no `full/delta`: every request
recomputes the complete set from the current document overlay and import graph, so a
request after `didChange` reflects the edit. A range request returns only tokens lying
completely inside the requested range (a token crossing either end is left out); an
end before the start or a negative position is rejected with -32602. Files other than
`.robot`/`.resource` return `{"data": []}`.

Legend (`initialize` → `semanticTokensProvider.legend`), all standard LSP token types
except the custom modifier `resolved`:

| Index | Token type | Robot meaning |
| --- | --- | --- |
| 0 | `namespace` | Section header (`*** Settings ***`, `*** Test Cases ***`, `*** Tasks ***`, `*** Keywords ***`, `*** Variables ***`, `*** Comments ***`); an unrecognized header gets no token |
| 1 | `property` | Setting name: `Library`, `Resource`, `Suite Setup`, `Test Template`, `[Documentation]`, `[Arguments]`, `[Tags]`, `[Setup]`, ... |
| 2 | `class` | Test or task name (with `declaration`) |
| 3 | `function` | User keyword name (with `declaration`) and keyword call: a call cell, or the keyword cell of `[Setup]`, `[Teardown]`, `[Template]`, `Suite`/`Test`/`Task Setup`/`Teardown` and `Test Template` (not `NONE`) |
| 4 | `variable` | `${}` `@{}` `&{}` `%{}` variables in any cell, also embedded in test, keyword and call names and in arguments; `declaration` where defined |
| 5 | `comment` | `#` comments (whole-line and trailing) and `*** Comments ***` content |
| 6 | `keyword` | Control-structure markers: `FOR`, `IN`/`IN RANGE`/`IN ENUMERATE`/`IN ZIP`, `END`, `IF`, `ELSE IF`, `ELSE`, `TRY`, `EXCEPT`, `FINALLY`, `AS`, `WHILE`, `BREAK`, `CONTINUE`, `RETURN`, `VAR`, `GROUP`, and an import's `AS`/`WITH NAME` |
| 7 | `macro` | English BDD prefix of a keyword call: `Given`, `When`, `Then`, `And`, `But` |
| 8 | `operator` | Line continuation `...` |

| Bit | Modifier | Meaning |
| --- | --- | --- |
| 1 | `declaration` | Definition site: test/task and user keyword names, embedded arguments in a keyword name, `[Arguments]`, `Variables` section entries, assignments (`${x}=`), `VAR`, `FOR` and `EXCEPT AS` variables (only the variable itself, not variables in a default value) |
| 2 | `resolved` (custom) | A keyword call that resolves with definition's import-aware resolution: local, imported resource, imported Python library or RF standard library (including the implicit BuiltIn). A call without it does not resolve statically: a missing keyword, an unimported library such as AShadow.py, a name built from variables or a keyword of an open (class, dynamic, unmodelled) library |
| 4 | `defaultLibrary` | A resolved call whose definitions are all RF standard-library keywords |

Classification comes only from RF 7.5's own parsing model (`get_model`) and the same
per-request import graph as definition (`Workspace.graph` and `resolve_name`), never
from a line scan: each RF token is classified by its RF token type, and variables
inside a cell are found with RF's `search_variable`. A variable is one token including
a nested name or inline Python (`${greet_${lang}}`, `${{ $x + 1 }}`); variables in its
`[item]` access are tokens after it, the item text itself is not. A BDD prefix is
split off only when the full name does not match a keyword, as RF does, so a keyword
named `Given Literal Name` stays one `function` token. In the audit fixture, `Build
Record` is `function` + `resolved` through AuditLibrary.py (the location definition
returns), never through the unimported AShadow.py; without that import it is a
`function` with no modifier. Parsing errors keep the tokens of everything RF still
parses (a `FOR` without values or `END`, an `IF` without `END`, an unclosed `${`); RF's
`ERROR` tokens, unrecognized headers and invalid statements (RF's `Error` node, such as
a non-existing `[Setting]`, whose other cells RF types as comments) get none. RF numbers lines with
`str.splitlines`, which also breaks at U+2028 and form feeds; tokens are mapped back to
LSP lines (`\n`, `\r\n`, `\r`), so no token leaves its LSP line. Tabs and any run of
spaces are separators as RF lexes them.

Not tokenized: import names, plain arguments, tags, documentation text, `OPTION`
cells (`limit=3`), `$name` in expressions (`IF    $x > 0`), translated (`Language:`)
BDD prefixes, keyword names passed to `Run Keyword` and similar, and a library or
resource qualifier (`Audit.Build Record` is one `function` token). Timing (advisory):
a warm in-process full request for a generated 3,504-line suite (7,504 tokens) took
0.06–0.07 s with Python 3.13.7 and RF 7.5. Next candidates: `full/delta` with
`resultId`, inlay hints (argument names at call sites), qualifier and `$name`
expression tokens.

## Launch the debug adapter

Run `robot-companion-backend dap` (from source:
`PYTHONPATH=backend/src python3 -m robot_companion_backend dap`). Stdout carries only
Content-Length-framed DAP messages. The adapter handles `initialize`, `launch`,
`setBreakpoints`, `configurationDone`, `threads`, `terminate` and `disconnect`.
While the worker is paused it also handles `stackTrace`, `scopes`, `variables`,
`continue`, `next`, `stepIn` and `evaluate`; `test_dap_live.py` exercises them live
with RF 7.5. Other requests fail with `Unsupported request: <command>`.
`initialize` advertises only
`supportsConfigurationDoneRequest` and `supportsTerminateRequest` and requires 1-based
lines/columns and absolute file-system paths.

`launch` takes `target` (a suite path or list, relative to `cwd`), optional `cwd`
(default: the adapter's cwd) and optional `args` (extra Robot CLI arguments). It starts
one Robot worker (`python -m robot_companion_backend.worker`) with the adapter's own
interpreter, in a new process group, with private framed control/event pipes. The
worker's stdout/stderr become DAP `output` events. If Robot Framework 7.5 cannot be
imported in the worker, `launch` fails with that prerequisite message and the worker's
real exit code. It does not report a mocked success. After a successful launch the
adapter sends `process` and `initialized`. `configurationDone` then starts the run, and
`exited`/`terminated` follow when the worker ends.

Breakpoints initially return `verified: false`. At `configurationDone`, the worker
parses each requested Robot source with RF's model, emits `breakpoint` changes for
executable keyword-call lines, then installs an RF listener. Source verification
means a line contains a keyword call; it does not promise that the run imports or
reaches that file. Conditions, hit counts, logpoints and breakpoint changes after
configuration are explicitly unsupported at this checkpoint.

The listener's pause loop handles requests on the **same Robot
execution thread**. `stackTrace` returns the active Robot keyword/test stack;
`scopes` exposes the current frame's visible Robot variables (not separately
classified local/suite/global scopes). Outer frames have source locations, but
live scopes/evaluation there are explicitly unsupported. Compound variables expose
dictionary keys, sequence indices or object instance attributes. Handles are
monotonic and valid only for the pause that issued them; resume invalidates them.
`next` stops at the next keyword at the same or shallower depth; `stepIn` stops at
the next keyword, including a nested resource keyword. Async `pause` is unsupported.

`evaluate` requires an explicit current Robot `frameId`, `context: "repl"` and one
Robot keyword call (Robot cell separators, no assignment or newline). It parses
that call with RF and uses `BuiltIn.run_keyword` in the paused context, preserving
live variables and keyword side effects. It never uses Python expression eval or
starts another Robot process. Evaluations suppress recursive debug stops. A command
timeout terminates the worker instead of leaving a desynchronized session. Hover
and watch evaluation are not advertised or supported. The worker parses the Robot
CLI with RF's public `RobotFramework.parse_arguments` and adds the in-process
listener to any user listeners (`run_cli` cannot take a listener instance).

`terminate`/`disconnect` send SIGTERM to the worker's process group, then SIGKILL
after 5 seconds, and reap it. A malformed request gets a failed response; a
malformed frame produces an `important` output event and exit 1.

## Python handoff v1

This contract is exercised by `test_dap_mixed_live.py` with debugpy 1.8.22. It is a
backend extension, **not advertised in initialize**.
Request it explicitly in Robot `launch` with `"pythonDebug": {"handoffVersion": 1}`.
Other versions, boolean versions and unknown options fail. The backend requires
exactly debugpy 1.8.22; missing/wrong versions produce a prerequisite error rather
than a successful handoff. A normal Robot-only launch does not start debugpy.

The parent owns a separate `python -m debugpy.adapter` stdio subprocess in its own
process group and a single-client loopback DAP proxy on an OS-allocated port. It
emits `robotCompanion/pythonSession` with this v1 body:

| Field | Meaning |
| --- | --- |
| `version`, `phase`, `sessionId` | `1`, `"start"`, and a per-session opaque ID |
| `adapter.id`, `adapter.version`, `adapter.processId` | `debugpy`, `1.8.22`, owned adapter PID |
| `owner.processId`, `owner.debuggeeProcessId` | Native DAP adapter PID and existing Robot worker PID |
| `connect.host`, `connect.port` | `127.0.0.1` and the allocated child DAP proxy port |
| `configuration` | Child `request: "attach"`, `listen: {host: "127.0.0.1", port: 0}`, `subProcess: false`, `justMyCode: false` |
| `lifecycle` | Parent owns adapter, connection and debuggee cleanup |

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
RobotCode. It needs only this distribution, RF 7.5 and Python 3.13: no RobotCode, Node or
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
  `*** Tasks ***`, templated tests and RF 7.5's other syntax come from RF's own model.
  Tests RF drops when it runs, those tagged `robot:exclude` (directly, through a variable
  of the file or through an init file's `Test Tags`), are left out too.
- **Labels are RF's names.** A suite's label is RF's suite name (`audit.robot` → `Audit`).
  A test's label is the name RF gives the test when it runs: RF 7.5 replaces variables in
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
  directories) are not followed, so every reported URI is the workspace folder's path plus
  a relative path inside it; RF itself would follow them.
- **Errors are explicit.** A file with RF parsing or model errors (an unknown setting, an
  invalid section header, ...) still returns the tests RF builds from it, as `robot` runs
  them. A file that cannot be read or decoded is omitted. In both cases, and for errors in
  `__init__.robot` files or unreadable directories, the result carries an additive
  `"errors": [{"uri", "range", "message"}, …]` array (only when there is an error; same
  messages as RF), and each error is logged on stderr as
  `Discovery error: <uri>:<1-based line>: <message>`. Deprecation warnings are not errors.
- **Workspace URI.** Only an absolute local `file:` URI (empty or `localhost` authority, no
  query or fragment, no `.`/`..` segment) of an existing directory is accepted; anything
  else, a missing or non-string `workspaceUri` and non-object params return JSON-RPC error
  -32602. Reported URIs are the folder's path as given (not resolved through symbolic
  links) plus the relative file path, encoded by Python's `Path.as_uri()`; a
  `file://localhost/...` folder is reported as `file:///...`. Before `initialize` any
  request fails with -32002 and after `shutdown` with -32600, as in the LSP lifecycle.
- **Freshness.** Nothing is cached: every request reads the workspace again, so files
  added, edited or deleted on disk are reflected by the next request without a restart.
  On a synthetic 500-file, 10,000-test workspace one request took about 1.5 s (advisory,
  container measurement; not a performance guarantee).

`test_discovery_live.py` has nine real-process cases with RF 7.5, started through the
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

# Required hover/completion/signature help checks; fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis321/lsp-features PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_features_live.py -v

# Required references/rename/document and workspace symbol checks; fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis350/lsp-navigation PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_navigation_live.py -v

# Required diagnostics/quick-fix/formatting checks; fails without RF 7.5 and Robocop 9.1.0.
RCB_TRANSCRIPTS=/evidence/mis364/lsp-diagnostics PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_diagnostics_live.py -v

# Required semantic token checks (full, range, didChange); fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis427/lsp-semantic-tokens PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_semantic_tokens_live.py -v

# Required discovery API v1 checks, compared with `robot --dryrun`; fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis388/discovery PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_discovery_live.py -v

# DAP lifecycle: real adapter/worker subprocesses, no RF required.
RCB_TRANSCRIPTS=/evidence/mis191/dap PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_lifecycle.py -v

# Required live Robot pause/console/stepping/cleanup; fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis191/dap-live PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_live.py -v

# Required real two-session Robot/debugpy conformance; fails without RF/debugpy.
RCB_TRANSCRIPTS=/evidence/mis191/mixed-live PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_mixed_live.py -v
```

The DAP lifecycle suite checks capability advertisement, unsupported/malformed requests
and frames, failed process creation without leaked pipe descriptors, RF-absent
launch errors, and Python handoff version/missing-debugpy prerequisite errors. Cleanup checks require Linux /proc explicitly;
they fail if process observation is unavailable. The suite also checks that terminate
and disconnect leave no child of the adapter and no process in the launch cwd. Its
prerequisite case is skipped when RF is installed. `test_dap_live.py` starts actual
adapter/Robot subprocesses and requires RF 7.5 with RobotCode absent. Its four cases
assert breakpoint verification (including a nonexecutable line), the audit pause,
stack/scopes/compound record variables, the from-suite-console result, a console-only variable mutation surviving resume, next/stepIn,
Resource Step with Ada in the paused context, stale-handle rejection, successful
completion, and paused terminate/disconnect/client-EOF cleanup. Protocol transcripts
and Robot output files are retained through `RCB_TRANSCRIPTS`.

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
assignment scope, each renamed and the renamed suite run with RF 7.5; loop-carried
variables (the MIS-359 inline-IF and plain-assignment repro, a variable first set in a
loop, a WHILE condition and inner FOR body reaching an outer reassignment, an outer
body reaching an inner one, and a loop without reassignment as control) with exact
reference sets from each definition and use, every rename run with RF 7.5, and a
refused rename where a built-in reaches the loop use;
hierarchical document symbols; workspace symbols in unopened files; invalidation by
`didChange` and by created/changed/deleted files reported with
`workspace/didChangeWatchedFiles`; and a `workspaceFolders`-bounded scan with plain
`renameProvider`, flat symbols and no code actions for a client without
prepare/hierarchy/CodeAction-literal support.
`test_lsp_diagnostics_live.py` has twenty-four real-process cases: no error or warning for
the valid audit.robot and shared.resource; RF parsing/model errors with UTF-16 ranges
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
subdirectory, applied, clearing the diagnostic and the fixed suite passing with RF 7.5, and
none for a keyword a standard library also defines;
no code actions without CodeAction literal support; Robocop formatting of the audit corpus
that is deterministic, idempotent and keeps the audit suite passing; CRLF line endings
and UTF-16 edit ranges with emoji; a lone CR refused; `null` for a Python file; and no
`documentFormattingProvider` (and -32601) when Robocop cannot be imported. Nine of them
cover module library keywords, each fixture also run with RF 7.5 and its outcome
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
`test_lsp_semantic_tokens_live.py` has eight real-process cases with exact expected
tokens: the advertised legend with `full`/`range` and no delta (also for a client
declaring no capabilities); the audit fixture's complete relative `data` array, with
`Build Record` resolved and definition pointing to AuditLibrary.py; the unimported
AShadow.py keyword, a nonexistent keyword (also behind `Given`) and a call named by a
variable left unresolved; a `*** Tasks ***` file with umlaut and non-BMP text before
variables, tabs, `...` continuation, all five BDD prefixes, `%{}` `@{}` `&{}` and
item access, an embedded-argument keyword and call, `FOR`/`IF`/`TRY`/`WHILE`, `VAR` and
`RETURN`; a CRLF `.resource` file; a file with parse errors, U+2028 and a form feed
(every token inside its LSP line, no crash); range requests (whole lines, mid-token
ends, exact relative data, past the end, invalid range); and a `didChange` reflected by
the next full request.
Full backend conformance is the release runner: installed wheel with the `format` extra,
all eleven suites, RobotCode absent.

## Architecture and limits

`protocol.py` bounds headers to 8 KiB and payloads to 8 MiB, handles short byte
reads, serializes writes and rejects malformed frames. `lsp.py` handles lifecycle,
full-text overlays, workspace folders, definition requests and diagnostic
publication, and dispatches hover, completion and signature help to `features.py`,
references, rename and symbols to `navigation.py`, diagnostics and code actions to
`diagnostics.py`, formatting to `formatting.py` and semantic tokens to
`semantic_tokens.py`. Requests run
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
the implicitly imported BuiltIn, come from RF's own libdoc for the installed RF 7.5,
cached per server process; definitions point into RF's library source. This imports
RF's bundled library modules in the language-server process (output kept off the
protocol stdout; the `lsp` service drops its cwd from `sys.path` at start, and libdoc
runs without it again, so that optional
imports such as XML's `lxml`, or RF itself, cannot load a same-named workspace module); workspace
libraries are still never imported. Remote is not
inspected (its keywords exist only at run time and would require a connection), and
a standard library that cannot be imported in the runtime (Telnet on Python 3.13,
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
behaviors with RF 7.5.
Static Python class libraries, dynamic/module search paths, variable files,
variable-based imports (still an error diagnostic), keyword completion and signature
help in setting cells, `Run Keyword` arguments, complete runtime variable
scopes and large-workspace performance need further outcomes. No workspace library code is executed during indexing.

## Capability inventory and continuation

| Family | Current state | Evidence / next boundary |
| --- | --- | --- |
| Byte framing, malformed input, CLI subprocesses, Python definition columns and lines | Mechanical checks pass | `test_transport.py`, 11 tests |
| LSP lifecycle, definition, parser/import graph | Phase 1, live with RF 7.5 | `test_lsp_live.py`, 6 real-process cases |
| Hover (keywords, static variable values), completion (keywords, scoped variables), signature help | Implemented for keyword-call cells in test/keyword bodies, live with RF 7.5; no completion resolve/snippets | `test_lsp_features_live.py`, 15 real-process cases |
| Diagnostics: RF parsing/model errors, imports, unknown keywords, ambiguity, argument counts, undefined variables | Implemented with the documented static rules, live with RF 7.5, including plain functions of statically readable module libraries (`__all__`, `ROBOT_AUTO_KEYWORDS`, `@not_keyword`); imported/assigned-name collisions not reported; no CLI `--variable` knowledge | `test_lsp_diagnostics_live.py` (24 real-process cases, 9 for module library keywords with RF 7.5 runs), import severities in `test_lsp_live.py` |
| Semantic tokens (`full`, `range`): headers, settings, test/keyword names, keyword calls with `resolved`/`defaultLibrary`, variables, comments, control markers, BDD prefixes, continuation | Implemented from RF's model and definition's resolution, live with RF 7.5; no `full/delta`, no `$name` expression or qualifier tokens | `test_lsp_semantic_tokens_live.py`, 8 real-process cases |
| Code actions: import quick fix, qualify ambiguous call | Implemented (`quickfix` only, clients with CodeAction literal support) | `test_lsp_diagnostics_live.py`, applied edits clear the diagnostic |
| Document formatting | Implemented with optional Robocop 9.1.0 defaults; no range/on-type formatting or Robocop configuration | `test_lsp_diagnostics_live.py`, idempotent and audit suite passing before/after |
| DAP lifecycle: initialize, launch prerequisite, breakpoints, threads, terminate/disconnect | Phase 1 | `test_dap_lifecycle.py`, 7 tests (RF-absent case skips with RF installed) |
| Robot pause, stack/scopes/variables, step/continue, live console evaluate | Phase 1, live with RF 7.5 | `test_dap_live.py`, 4 real-process cases |
| Versioned debugpy child handoff and cleanup | Phase 1 v1, live with debugpy 1.8.22; not advertised in initialize | `test_dap_mixed_live.py`, 6 real-process cases |
| Standalone wheel/sdist build, install and conformance | Offline in-tree build, pip rebuild identity, installed-wheel suites | `backend/scripts/verify_release.py --wheels /opt/robot-wheels` |
| References (keywords, scoped variables), rename (user keywords, scoped variables), document/workspace symbols | Implemented for `.robot`/`.resource` workspace files, live with RF 7.5; Python/standard-library keyword rename refused; `Run Keyword` arguments not modelled | `test_lsp_navigation_live.py`, 13 real-process cases |
| Test discovery: normalized discovery API v1 (`discovery` service) | Implemented for `.robot` file suites with RF 7.5's parser/builder and init defaults; labels resolve only statically known variables; no directory suites, tags or `__init__.robot` suite settings in the result | `test_discovery_live.py`, 9 real-process cases compared with `robot --dryrun` |
| Per-test results/streaming, range formatting, other code actions (refactorings, source actions), semantic token deltas, inlay hints | Missing | Separate bounded outcomes |
| Multi-root/remote, config, broad compatibility | Unverified | Explicit version/platform matrix later |
| Reverse/data/function breakpoints, setVariable, exceptions | Unsupported | Do not advertise them |
| Notebook/TOML/Markdown, secondary AI/tool integrations | Missing | Program parity inventory; no LLM in this product |

The Lead owns follow-up scheduling under MIS-190 and decides phase-1 acceptance.
This document does not claim full language-server/debugger parity or any UI
interaction coverage. Next bounded backend outcomes: debug robustness (conditional/hit-count/log breakpoints, async
pause, exception breakpoints, breakpoint changes after configuration); per-test result
streaming through the normalized adapter API (run IDs, per-test status/output); range formatting
and configurable Robocop rules; static class and dynamic
libraries plus module search paths and variable files; `Run Keyword` arguments for
navigation and rename, and Python library keyword rename; keyword completion and
signature help in setting cells; completion item resolve with documentation;
command-line variables and private keywords for diagnostics; semantic token deltas
(`full/delta`) and inlay hints; Companion exposure of semantic tokens (an integration
outcome); large-workspace performance
of the per-request rescans; an RF/Python/platform compatibility matrix; and frontend integration of the v1
descriptor in its own outcome. The supplied `audit-evidence` issue document retains the real baseline
interaction audit (VS Code 1.116.0); this headless source change requires no new
browser/UI flow and does not claim testing in VS Code 1.141.0.

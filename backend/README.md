# Independent Robot backend

This distribution is a work-in-progress native backend for the Robot Companion
replacement program. It has no dependency on Node, VS Code, Companion or RobotCode.
The extension and its RobotCode path remain separate and unchanged.

**Current checkpoint (phase 1 plus language features):** bounded stdio transport,
an RF parser-backed LSP with definition, limited diagnostics, hover, completion,
signature help, references, rename and document/workspace symbols, an owned DAP worker
with an RF listener and paused-thread command loop, the
versioned debugpy handoff v1, the copied v1 audit corpus and headless tests. With
the approved offline runtime (RF 7.5, debugpy 1.8.22, Python 3.13.7, RobotCode
absent), the live LSP, LSP feature, LSP navigation, Robot DAP and mixed Robot/Python
suites run against real backend, Robot and debugpy subprocesses. `verify_release.py` builds, installs and
runs every suite from the installed wheel. The exact-SHA results are recorded in
the issue's `artifact-handoff`; this README does not borrow a pass for a later
commit. Phase 1 is not full language-server/debugger parity (see the inventory).

## Runtime and installation

Supported: Python 3.13 on Linux with Robot Framework 7.5 and debugpy 1.8.22,
pinned exactly in `pyproject.toml` and `constraints.txt`. The approved WOL-805
offline wheel set (in task containers: read-only `/opt/robot-wheels`, SHA-256
checked against the operator's `robot-backend-wheels.sha256`) supplies them. No
other Python/RF/debugpy version or platform has been validated.

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
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links /opt/robot-wheels /tmp/rcb-dist/*.whl
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
`doctor` prints JSON versions and returns 2 if RF/debugpy is missing or RobotCode is
present. A successful doctor is a prerequisite probe, not conformance.

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
pinned dependencies from the local wheel directory. The scratch root contains an **empty `node_modules`**
and no extension source. The installed-package probe rejects RobotCode/Companion
and any backend import outside the venv. Build/test subprocesses receive a small
environment without task credentials, source PYTHONPATH, user-site or proxy settings.
The source identity reads use the checkout's existing Git authorization; the
runner never changes Git configuration.

It then runs the nine mechanical harness cases, transport/lifecycle tests and all
five required live LSP/LSP-feature/LSP-navigation/Robot/mixed suites sequentially using the venv Python and
copied synthetic fixtures. Build/test commands have a 300-second bound; source Git reads have a 30-second
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

`initialize` advertises exactly `definitionProvider`, `hoverProvider`,
`completionProvider` (`triggerCharacters` `{` and `.`, `resolveProvider: false`),
`signatureHelpProvider` (triggers space and tab, retrigger `=`), `referencesProvider`,
`renameProvider` (with `prepareProvider` when the client declares
`textDocument.rename.prepareSupport`, otherwise `true`), `documentSymbolProvider` and
`workspaceSymbolProvider`, plus full-text sync. Formatting, code actions, semantic
tokens and workspace-folder change notifications are not advertised. The workspace
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
  a string literal is text, as in RF. Escaped `\${name}` and comments are literal text.
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
  Refused with an LSP `RequestFailed` (-32803) error and no edit: Python library keywords
  ("rename it in the Python source"; advisory scope, not implemented), RF standard
  library keywords, an ambiguous call or definition, any ambiguous call in the
  workspace that includes the target, keywords with embedded arguments, built-in
  variables, a suite variable defined in several imported files, and invalid names.
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
class/dynamic libraries and undecorated Python functions (inherited from definition),
and folders added after `initialize`. Variable scope follows source lines, so a
`[Teardown]` above an assignment does not see it. Those occurrences are neither found
nor renamed. No performance numbers on a large
workspace have been measured; every request rescans and reparses candidate files.

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
`test_lsp_navigation_live.py` has eleven real-process cases: keyword references from a
call, an alias call and the Python definition that include `Audit.Build Record` and
never the AShadow.py, own same-named or ambiguous calls; resource keyword references
through `[Setup]`, BDD and qualified cells; variable references limited to their scope
(the out-of-scope keyword/test-local negative and a shadowing suite); keyword rename
with exact UTF-16 edits on umlaut/emoji lines that keeps prefixes and leaves comments,
documentation, arguments and another same-named keyword alone, also from a caret just
after the name; refused rename (and prepareRename) of the Python and BuiltIn keywords,
ambiguous keywords and calls, invalid names and a built-in variable; scoped variable
rename; `$name` expression uses, escaped literals and `name=` named-argument callers;
hierarchical document symbols; workspace symbols in unopened files; invalidation by
`didChange` and by created/changed/deleted files reported with
`workspace/didChangeWatchedFiles`; and a `workspaceFolders`-bounded scan with plain
`renameProvider` and flat symbols for a client without prepare/hierarchy support.
Full backend conformance is the release runner: installed wheel, all
eight suites, RobotCode absent.

## Architecture and limits

`protocol.py` bounds headers to 8 KiB and payloads to 8 MiB, handles short byte
reads, serializes writes and rejects malformed frames. `lsp.py` handles lifecycle,
full-text overlays, workspace folders, definition requests and diagnostic
publication, and dispatches hover, completion and signature help to `features.py` and
references, rename and symbols to `navigation.py`. Requests run
serially; completed requests may ignore subsequent cancellation notifications.
No asynchronous worker returns an old document result.

`workspace.py` uses Robot Framework's parser/model for Robot syntax and an explicit
resource/library graph rooted at each document. It follows imports rather than
scanning every Python file. Python AST reads decorated module-level functions
without importing or executing a library. Local, resource and library precedence
is explicit; ambiguity returns all matching source locations and a diagnostic,
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

`test_lsp_live.py`, `test_lsp_features_live.py` and `test_lsp_navigation_live.py`
verify these behaviors with RF 7.5.
Static Python class libraries, dynamic/module search paths, variable files,
variable-based imports (still an error diagnostic), keyword completion and signature
help in setting cells, `Run Keyword` arguments, complete runtime variable
scopes and large-workspace performance need further outcomes. No workspace library code is executed during indexing.

## Capability inventory and continuation

| Family | Current state | Evidence / next boundary |
| --- | --- | --- |
| Byte framing, malformed input, CLI subprocesses | Mechanical checks pass | `test_transport.py`, 10 tests |
| LSP lifecycle, definition, parser/import graph | Phase 1, live with RF 7.5 | `test_lsp_live.py`, 6 real-process cases |
| Hover (keywords, static variable values), completion (keywords, scoped variables), signature help | Implemented for keyword-call cells in test/keyword bodies, live with RF 7.5; no completion resolve/snippets | `test_lsp_features_live.py`, 15 real-process cases |
| Diagnostics: RF syntax errors, unresolved local imports, keyword ambiguity only | Limited phase-1 subset, live with RF 7.5 | Ambiguity and import severities in `test_lsp_live.py`; syntax errors are RF's own model errors, not separately asserted |
| DAP lifecycle: initialize, launch prerequisite, breakpoints, threads, terminate/disconnect | Phase 1 | `test_dap_lifecycle.py`, 7 tests (RF-absent case skips with RF installed) |
| Robot pause, stack/scopes/variables, step/continue, live console evaluate | Phase 1, live with RF 7.5 | `test_dap_live.py`, 4 real-process cases |
| Versioned debugpy child handoff and cleanup | Phase 1 v1, live with debugpy 1.8.22; not advertised in initialize | `test_dap_mixed_live.py`, 6 real-process cases |
| Standalone wheel/sdist build, install and conformance | Offline in-tree build, pip rebuild identity, installed-wheel suites | `backend/scripts/verify_release.py --wheels /opt/robot-wheels` |
| References (keywords, scoped variables), rename (user keywords, scoped variables), document/workspace symbols | Implemented for `.robot`/`.resource` workspace files, live with RF 7.5; Python/standard-library keyword rename refused; `Run Keyword` arguments not modelled | `test_lsp_navigation_live.py`, 11 real-process cases |
| Full diagnostics, formatting, code actions, discovery/results | Missing | Separate bounded semantic/execution outcomes |
| Multi-root/remote, config, broad compatibility | Unverified | Explicit version/platform matrix later |
| Reverse/data/function breakpoints, setVariable, exceptions | Unsupported | Do not advertise them |
| Notebook/TOML/Markdown, secondary AI/tool integrations | Missing | Program parity inventory; no LLM in this product |

The Lead owns follow-up scheduling under MIS-190 and decides phase-1 acceptance.
This document does not claim full language-server/debugger parity or any UI
interaction coverage. Next bounded backend outcomes: formatting and code actions;
broader diagnostics (unknown keywords, argument counts, variables); test
discovery/results through the normalized adapter API; static class and dynamic
libraries plus module search paths and variable files; `Run Keyword` arguments for
navigation and rename, and Python library keyword rename; keyword completion and
signature help in setting cells; completion item resolve with documentation; conditional/hit-count/log breakpoints and async pause;
an RF/Python/platform compatibility matrix; and frontend integration of the v1
descriptor in its own outcome. The supplied `audit-evidence` issue document retains the real baseline
interaction audit (VS Code 1.116.0); this headless source change requires no new
browser/UI flow and does not claim testing in VS Code 1.141.0.

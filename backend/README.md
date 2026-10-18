# Independent Robot backend

This distribution is a work-in-progress native backend for the Robot Companion
replacement program. It has no dependency on Node, VS Code, Companion or RobotCode.
The extension and its RobotCode path remain separate and unchanged.

**Current checkpoint:** bounded stdio transport, LSP source, an owned DAP worker
and experimental RF listener/paused-thread command source, plus the copied v1
audit corpus and headless tests. The dependency-free mechanical and DAP lifecycle
checks pass. Robot parser-backed conformance, a live Robot run, installation and
package build remain unverified: the assigned runtime has no Robot Framework,
debugpy or build dependencies. The new live DAP suite fails at that prerequisite;
it does not skip or substitute mocked behavior. The debugpy handoff is still
missing. This is not the phase-1 acceptance handoff.

## Runtime and installation

The initial target is Python 3.13 and Robot Framework 7.5. The package declares
exact initial dependency versions in `pyproject.toml` and `constraints.txt`.
These are version inputs, not a completed hash-locked runtime manifest; WOL-805
must supply the approved credential-free wheels and measured transitive hashes.
No other Python/RF version or platform has been validated.

From the repository checkout, after that runtime is supplied, use an independent
venv and its read-only wheel directory (substitute the operator-provided path):

```bash
python3.13 -m venv /tmp/rcb-venv
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links "$APPROVED_WHEELS" -c backend/constraints.txt build setuptools wheel
/tmp/rcb-venv/bin/python -m build --no-isolation --outdir /tmp/rcb-dist backend
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links "$APPROVED_WHEELS" /tmp/rcb-dist/*.whl
/tmp/rcb-venv/bin/robot-companion-backend doctor
```

These installation commands are pending verification, not recorded successes.
No frontend dependency directory is needed. Never install RobotCode in this venv.
`doctor` prints JSON versions and returns 2 if a required tool is missing or
RobotCode is present. A successful doctor is a prerequisite probe, not conformance.

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

## Launch the debug adapter

Run `robot-companion-backend dap` (from source:
`PYTHONPATH=backend/src python3 -m robot_companion_backend dap`). Stdout carries only
Content-Length-framed DAP messages. The adapter handles `initialize`, `launch`,
`setBreakpoints`, `configurationDone`, `threads`, `terminate` and `disconnect`.
Experimental source also handles `stackTrace`, `scopes`, `variables`, `continue`,
`next`, `stepIn` and `evaluate` while the worker is paused; these paths have **not
been live-verified**. Other requests fail with `Unsupported request: <command>`.
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

The listener's experimental pause loop handles requests on the **same Robot
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
and watch evaluation are not advertised or supported. These listener behaviors
remain source-only until `test_dap_live.py` passes with RF 7.5.

`terminate`/`disconnect` send SIGTERM to the worker's process group, then SIGKILL
after 5 seconds, and reap it. A malformed request gets a failed response; a
malformed frame produces an `important` output event and exit 1.

## Headless checks

From the repository root, without npm or VS Code:

```bash
# Mechanical checks: no RF required, not language/debug acceptance.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_transport.py -v

# Required parser-backed checks: fails rather than skipping if RF is missing.
RCB_TRANSCRIPTS=/evidence/mis191/lsp PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_live.py -v

# DAP lifecycle: real adapter/worker subprocesses, no RF required.
RCB_TRANSCRIPTS=/evidence/mis191/dap PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_lifecycle.py -v

# Required live Robot pause/console/stepping/cleanup; fails without RF 7.5.
RCB_TRANSCRIPTS=/evidence/mis191/dap-live PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_dap_live.py -v
```

The DAP lifecycle suite checks capability advertisement, unsupported/malformed requests
and frames, and the RF-absent launch prerequisite error. It also checks that terminate
and disconnect leave no child of the adapter and no process in the launch cwd. Its
prerequisite case is skipped when RF is installed. `test_dap_live.py` starts actual
adapter/Robot subprocesses and requires RF 7.5 with RobotCode absent. Its four cases
assert breakpoint verification (including a nonexecutable line), the audit pause,
stack/scopes/compound record variables, the from-suite-console result, next/stepIn,
Resource Step with Ada in the paused context, stale-handle rejection, successful
completion, and paused terminate/disconnect/client-EOF cleanup. Protocol transcripts
and Robot output files are retained through `RCB_TRANSCRIPTS`. The suite is source
awaiting a prepared runtime, not passing live evidence.

Use the independent backend venv's Python for acceptance. Omit `PYTHONPATH` when
checking the installed wheel so the source checkout cannot mask packaging errors.
The client launches actual backend subprocesses with bounded timeouts and drains
stderr. Cleanup terminates/kills only its own subprocess and joins its readers.
The live suite covers audit navigation, unimported shadow exclusion, aliases and
ambiguity, changed library/resource sources and overlays, variables in distinct
owners, embedded keywords, UTF-16 positions and orderly shutdown. It currently
cannot run in the assigned runtime. Full backend conformance also requires the
live Robot DAP suite and the not-yet-written mixed debugpy suite.

## Architecture and limits

`protocol.py` bounds headers to 8 KiB and payloads to 8 MiB, handles short byte
reads, serializes writes and rejects malformed frames. `lsp.py` handles lifecycle,
full-text overlays, definition requests and diagnostic publication. Requests run
serially; completed requests may ignore subsequent cancellation notifications.
No asynchronous worker returns an old document result.

`workspace.py` uses Robot Framework's parser/model for Robot syntax and an explicit
resource/library graph rooted at each document. It follows imports rather than
scanning every Python file. Python AST reads decorated module-level functions
without importing or executing a library. Local, resource and library precedence
is explicit; ambiguity returns all matching source locations and a diagnostic,
never an alphabetically chosen path. Imported dependencies are reread per request,
so a saved source change cannot reuse a stale symbol cache. Unsaved text overlays
win until close. Source positions convert code points/Python AST UTF-8 offsets to
LSP UTF-16. Variables resolve within the current owner, then the suite table.

At this checkpoint these parser behaviors are source implementations awaiting
real-runtime verification. Static Python class libraries, dynamic/module search
paths, variable-based imports, complete runtime variable scopes and large-workspace
performance need further outcomes. No library code is executed during indexing.

## Capability inventory and continuation

| Family | Current state | Evidence / next boundary |
| --- | --- | --- |
| Byte framing, malformed input, CLI subprocesses | Mechanical checks pass | `test_transport.py`, 10 tests |
| LSP lifecycle, definition, parser/import graph, diagnostics | Source implemented, runtime unverified | `test_lsp_live.py`; run with RF 7.5 |
| DAP lifecycle: initialize, launch prerequisite, breakpoints recorded, threads, terminate/disconnect | Lifecycle checks pass without RF; live launch unverified | `test_dap_lifecycle.py`, 4 tests; run live with RF 7.5 |
| Robot pause, stack/scopes/variables, step/continue, live console evaluate | Experimental source only; runtime unverified | `test_dap_live.py`, 4 required real-process cases; fails without RF 7.5 |
| Versioned debugpy child handoff and cleanup | Missing | Prove audit Python lines 18→19, count=3, return to Robot |
| Standalone wheel/sdist install | Declared, unverified | Build/install offline in prepared backend venv |
| Hover, completion/signature, references/rename, symbols | Missing | Separate bounded language outcomes |
| Full diagnostics, formatting, code actions, discovery/results | Missing | Separate bounded semantic/execution outcomes |
| Multi-root/remote, config, broad compatibility | Unverified | Explicit version/platform matrix later |
| Reverse/data/function breakpoints, setVariable, exceptions | Unsupported | Do not advertise them |
| Notebook/TOML/Markdown, secondary AI/tool integrations | Missing | Program parity inventory; no LLM in this product |

The Lead owns follow-up scheduling under MIS-190. This checkpoint does not claim
full language-server/debugger parity, any UI interaction coverage, or phase-1
acceptance. The supplied `audit-evidence` issue document retains the real baseline
interaction audit (VS Code 1.116.0); this headless source change requires no new
browser/UI flow and does not claim testing in VS Code 1.141.0.

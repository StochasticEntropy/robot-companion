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
it does not skip or substitute mocked behavior. A versioned mixed Python handoff
and its real-process suite are also source-only and unverified. This is not the
phase-1 acceptance handoff.

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
directory, creates an isolated venv, installs pinned build tools from local
wheels using `--no-index`, builds an sdist and wheel, and installs the wheel with
its pinned dependencies. The scratch root contains an **empty `node_modules`**
and no extension source. The installed-package probe rejects RobotCode/Companion
and any backend import outside the venv. Build/test subprocesses receive a small
environment without task credentials, source PYTHONPATH, user-site or proxy settings.
The source identity reads use the checkout's existing Git authorization; the
runner never changes Git configuration.

It then runs the seven mechanical harness cases, transport/lifecycle tests and all
three required live LSP/Robot/mixed suites sequentially using the venv Python and
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
or partial report is not a pass. The commit timestamp supplies SOURCE_DATE_EPOCH;
byte-for-byte reproducibility across independent builds remains unproven.

The full build/install/live command is **not yet verified**: no approved wheel
path has been supplied to this author runtime. The seven `test_release_harness.py`
cases exercise real synthetic command failures, timeouts, detached children and
receipt rules without RF; they are mechanical tooling evidence only. They can be
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

## Experimental Python handoff v1

This contract is **source-only, not live-proven or advertised in initialize**.
Request it explicitly in Robot `launch` with `"pythonDebug": {"handoffVersion": 1}`.
Other versions, boolean versions and unknown options fail. The backend requires
exactly debugpy 1.8.17; missing/wrong versions produce a prerequisite error rather
than a successful handoff. A normal Robot-only launch does not start debugpy.

The parent owns a separate `python -m debugpy.adapter` stdio subprocess in its own
process group and a single-client loopback DAP proxy on an OS-allocated port. It
emits `robotCompanion/pythonSession` with this v1 body:

| Field | Meaning |
| --- | --- |
| `version`, `phase`, `sessionId` | `1`, `"start"`, and a per-session opaque ID |
| `adapter.id`, `adapter.version`, `adapter.processId` | `debugpy`, `1.8.17`, owned adapter PID |
| `owner.processId`, `owner.debuggeeProcessId` | Native DAP adapter PID and existing Robot worker PID |
| `connect.host`, `connect.port` | `127.0.0.1` and the allocated child DAP proxy port |
| `configuration` | Child `request: "attach"`, `listen: {host: "127.0.0.1", port: 0}`, `subProcess: false`, `justMyCode: false` |
| `lifecycle` | Parent owns adapter, connection and debuggee cleanup |

Use two DAP connections; handles and thread IDs belong to the connection that
issued them. After Robot launch, connect the child client to `connect`, initialize
it, and send its `attach` request with the supplied configuration. Keep attach
pending while receiving child events. The proxy observes debugpy 1.8.17's
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

The debugpy attach/event ordering, RF callback context, mixed stepping and live
cleanup remain unverified until the mandatory mixed suite passes at the artifact
SHA. Version pinning and source checks alone do not prove this contract works.

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
and Robot output files are retained through `RCB_TRANSCRIPTS`. The suite is source
awaiting a prepared runtime, not passing live evidence.

`test_dap_mixed_live.py` contains six required real-process cases. It drives the
Robot pause/console, the owned debugpy child attachment, AuditLibrary.py line
18→19, `count == 3`, explicit return to the Robot frame and Resource Step with Ada,
a console-only mutation, stale Robot frame rejection, and successful completion.
Separate cases terminate, disconnect or close the parent input while Python is
paused, and close the child connection, including a worker that ignores SIGTERM. Cleanup checks observe worker/adapter
processes, child-reader EOF and closure of the allocated port. These cases are
source-only; missing RF or debugpy is an error, never a skip.

Use the independent backend venv's Python for acceptance. Omit `PYTHONPATH` when
checking the installed wheel so the source checkout cannot mask packaging errors.
The client launches actual backend subprocesses with bounded timeouts and drains
stderr. Cleanup first closes parent input and waits for owned shutdown; its bounded
forced fallback uses retained child PID/start-time identities and is reported
as a test failure if needed during successful live cases. Readers are joined.
The live suite covers audit navigation, unimported shadow exclusion, aliases and
ambiguity, changed library/resource sources and overlays, variables in distinct
owners, embedded keywords, UTF-16 positions and orderly shutdown. It currently
cannot run in the assigned runtime. Full backend conformance also requires the
live Robot and mixed debugpy DAP suites, followed by offline install/build proof.

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
| DAP lifecycle: initialize, launch prerequisite, breakpoints recorded, threads, terminate/disconnect | Lifecycle checks pass without RF; live launch unverified | `test_dap_lifecycle.py`, 7 tests; run live with RF 7.5 |
| Robot pause, stack/scopes/variables, step/continue, live console evaluate | Experimental source only; runtime unverified | `test_dap_live.py`, 4 required real-process cases; fails without RF 7.5 |
| Versioned debugpy child handoff and cleanup | Experimental v1 source only; runtime unverified | `test_dap_mixed_live.py`, 6 real-process cases; requires RF 7.5/debugpy 1.8.17 |
| Standalone wheel/sdist build, install and conformance | Offline runner source and mechanical checks; actual release unverified | `backend/scripts/verify_release.py`; requires approved local wheels |
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

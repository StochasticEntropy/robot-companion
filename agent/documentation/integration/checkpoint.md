# MIS-192 implementation checkpoint

Base: `4c4932211df8d9b312e6f3030cb08c1b286514f0`.
This is preparatory implementation, not an acceptance handoff.

## Baseline and design

Read issue documents `interface-contract` (revision
`ccad25fb-98a9-4fcd-87c4-a38fa38e5df8`), `audit-evidence` (revision
`9dfecd92-c389-47bf-88e8-844cd9277366`), `delivery-plan`, `operations-intake`,
company standing guidelines revision 35, README, CHANGELOG,
INLINE_DOCUMENTATION, CACHING and RELEASE_CHECKLIST. No newer owner comment or
separate technical/UX brief was supplied. The interface contract is the supplied
architecture brief; scope remains the seven phase-1 criteria.

The retained audit covers the exact base and interaction requirement: Companion
without RobotCode has no native F12/Cmd-click/debugger and its Return Explorer
pointer link chooses unimported AShadow.py. That is baseline failure evidence,
not a fixed-state pass. The prior audit used VS Code 1.116.0; current automated
baseline uses 1.141.0. Native VS Code controls, theme colors, editor fonts, focus
and keyboard conventions remain the design direction; no new webview or visual
system is introduced in this checkpoint.

## Implemented foundation

`src/integration/backend-contract.js` supplies the launch boundary:

- Version-1 descriptors validate ID/version, file workspace URI, absolute cwd,
  explicit executable/argv and environment, and stdio service transport.
- Language and execution/debug selections are independent. Optional discovery
  is absent explicitly. Coexistence selects no owned services and does not read
  executable descriptors. Owned language registration now consumes this boundary.
- The launch guard refuses untrusted execution before reading descriptors.
  The LSP process owner repeats the guard immediately before spawn. No interpreter
  probes or package installation run. Mode/root changes stop owned processes.
- A per-root execution-context cache preserves existing robotCommand parsing
  and robotArguments, snapshots inputs, and supports removal/disposal. It is not
  wired to the runner yet. No second environment picker or interpreter guess.
- `lsp-session.js` owns a stdio JSON-RPC process with byte framing, initialize /
  initialized / shutdown / exit, accurate returned capabilities, UTF-16 position
  negotiation, stderr separation, cancellation, request timeouts, restart and
  forced cleanup. The extension now wires it through `language-workspace.js`.
  A local Node subprocess fixture proves plumbing, not RobotCode compatibility.
- `language-workspace.js` registers opt-in owned definitions and diagnostics,
  full/incremental text sync, save/file events, cancellation and stale-result guards.
  It owns per-root lifecycle, output/status/restart commands and disposal.
  Coexistence remains the default, registering no owned definition providers or
  backend process. Robot file language registration and workspace-host placement
  are in package.json. README and CHANGELOG describe experimental scope honestly.
- Audit corpus copied into tests/integration/fixtures/audit-v1 independently.

## Verification and limits

`npm run test:integration`: exit 0, 15 tests.
These exercise malformed descriptors, unsupported services/transport, independent
selection, no-read Restricted Mode/coexistence guards and root/settings isolation.
The subprocess is a protocol fixture; no native or RobotCode runtime pass is claimed.

Baseline command:
`mkdir -p .vscode-test && ln -sfn /opt/vscode-test/vscode-linux-arm64-1.141.0 .vscode-test/ && xvfb-run -a npm run test:all`.
Exit 0, 71 UI tests plus existing deterministic checks. Detailed log retained at
/evidence/mis-192/baseline-test-all.log. This precedes product changes; it does not
verify later commits. Existing suite includes real CDP webview pointer actions,
but none proves the new native navigation/debug/Test Explorer criteria.

Runtime: Linux arm64, Node 24.19.0, Python 3.13.7, preseeded VS Code 1.141.0.
robotframework, robotcode, robotcode-language-server, robotcode-debugger,
debugpy and pytest are not installed. No packages were fetched. Existing
operations-intake identifies WOL-805 as runtime preparation. Live RobotCode 2.7.0 /
RF 7.5 launch, debug and result acceptance remain unavailable pending that setup.

## Criteria state and next action

1. Partial: language registration, owned/coexistence lifecycle and process cleanup
   work with a local fixture. Pinned RobotCode bridge/runtime and live trust
   transitions remain unverified; duplicate external run-CodeLens policy remains.
2. Partial: actual F12/Peek/Ctrl-click consume fixture source ranges. Real semantic
   identity, shared enrichment navigation and full audit/alias/ambiguity/change
   coverage remain. Original Return Explorer shadow bug remains.
3. Missing: owned DAP, debugpy handoff, mixed sessions and live console journey.
4. Missing: normalized discovery/result API, native TestController and real run.
   Existing CodeLens runner is unchanged.
5. Partial: descriptor/error and local protocol subprocess checks; real
   RobotCode-backed fallback remains to implement. No native acceptance claim.
6. Partial: seven owned-language UI checks include actual CDP editor clicks,
   F12, Linux Peek (Ctrl+Shift+F10), Ctrl-click, source ranges and focus at
   1280x900. Restart/mode exit, save/watch, versioned diagnostics, cancellation
   and stale results are checked. No live Robot/debug/Test Explorer acceptance.
7. Partial: context boundary and trust guards tested in isolation; experimental
   configuration and limits documented in README. Shared run/debug execution
   context wiring remains. Remote/multi-root and minimum VS Code are unverified;
   a unit test with two roots is not host compatibility proof.

Advisory inner review found sparse argv arrays were accepted because Array.some
skips holes. The validator now checks a dense copy, with a rejection regression.
A second advisory pass found unbounded startup-error termination and stale server
request replies across restart. Startup/parser errors now escalate to SIGKILL;
server replies are bound to their originating child. Real subprocess regressions
cover SIGTERM-ignoring fixtures and delayed old-session handlers. The advisory
review is not a product gate and establishes no UI acceptance.

Resume verification at c859c93fd508892f62ee03ee9427427943ef40cb:
`ROBOT_COMPANION_VSCODE_EXECUTABLE=/opt/vscode-test/vscode-linux-arm64-1.141.0/code xvfb-run -a npm run test:all`: exit 0, 71 UI tests and 15 protocol tests plus existing checks.
Log: /evidence/mis-192/resume-c859c93/test-all.log. This rerun precedes the owned-language wiring.

Owned-language dirty iteration: same executable, `ROBOT_COMPANION_UI_SUITE=language`
and `ROBOT_COMPANION_UI_EVIDENCE_DIR=/evidence/mis-192/language-work-in-progress`,
`xvfb-run -a npm run test:ui`: exit 0, seven UI tests. Log:
/evidence/mis-192/resume-c859c93/language-ui-expanded.log. Action transcript and
F12/Peek screenshots are in the evidence directory. This is automated real UI input,
not a human usability session. Exact committed-source checks are recorded durably
in the issue implementation-checkpoint document after committing.

Next command: `npm run test:integration`; then implement and validate the pinned
RobotCode bridge through the approved runtime path. Continue semantic-link and DAP
integration. Runtime preparation remains WOL-805; no separate dependency on the
independent backend artifact is introduced.
Do not touch backend/**, import the sibling artifact, fetch dependencies, claim
mock support as real, or request final review of this partial checkpoint.


## Interrupted-run recovery — 17 October 2026

This section supersedes the earlier next-command/evidence-availability notes.
Resumed at `ec1789f6ca392b94ecb18aef73502bdfe8380ae7` with five dirty files;
all pending work was preserved. Read back current guidelines revision 35 and
all copied issue documents. The previous container's `/evidence/mis-192` directory
was absent; historical issue-document results remain historical and are not new
source-bound passes.

Completed bounded shutdown/startup/input-pipe failure cleanup. Concurrent stop
calls share one promise, so a second lifecycle transition cannot interrupt a
clean shutdown. Mode/root changes and disposal initiate stopping immediately,
including while initialization is awaiting its response. Nested root selectors
and watchers check the URI's owning folder before dispatch. Regression checks
cover hung shutdown, broken stdin, restart after interrupted initialization,
mode exit during initialization, and nested definition/file-event isolation.

The UI runner uses a fresh saved synthetic workspace to add/remove nested roots
without a single-folder-to-workspace conversion. It waits for workspace-folder
change events and complete editor selections. An audit call's current line is
located from its text after a previous test saves an edit. These changes preserve
range, request-count and cleanup assertions.

Dirty iteration commands:

- `npm run test:integration`: exit 0, 18/18 tests, log
  `/evidence/mis-192/recovery-20261017/integration-final-dirty.log`.
- `ROBOT_COMPANION_UI_SUITE=language ROBOT_COMPANION_UI_EVIDENCE_DIR=/evidence/mis-192/recovery-20261017/ui-fourth ROBOT_COMPANION_VSCODE_EXECUTABLE=/opt/vscode-test/vscode-linux-arm64-1.141.0/code xvfb-run -a npm run test:ui`:
  exit 0, 9/9 UI tests. Log `language-ui-fourth.log` in that recovery directory;
  action JSON and F12/Peek images in `ui-fourth/`. Actual CDP click/F12/Peek/Escape/
  Ctrl-click at 1280x900: AuditLibrary.py line 12 column 5, shared.resource line 2,
  native editor focus, clean restart/mode exit, nested requests/events isolated.
  Images were inspected. Automated UI input is not a human usability session.

Earlier failed iteration logs are retained alongside the successful logs: initial
selection race; unsaved workspace-folder conversion masking the original failure;
concurrent stop interrupting graceful exit; and fixed row lookup after a saved edit.
No product acceptance round was opened or consumed by these author iterations.

README and CHANGELOG now describe the scoped lifecycle/routing behavior. The
criteria matrix above remains partial: no real Robot backend/semantic-resolution,
DAP/mixed evaluation, discovery/results or native-backend acceptance is claimed.
Only nested local language routing has fixture-based host coverage; broader
multi-root, remote, minimum VS Code and live trust transitions remain unverified.
The runtime is still Linux arm64, shell Node 24.19.0, extension-host Node 24.21.0,
VS Code 1.141.0, Python 3.13.7; RF, RobotCode component packages and debugpy are
absent. Existing WOL-805 operations-intake is retained without another request.

After this checkpoint commit, record an exact-SHA full-suite result and advisory
recheck in the existing issue `implementation-checkpoint` document. Reproduce with
`ROBOT_COMPANION_VSCODE_EXECUTABLE=/opt/vscode-test/vscode-linux-arm64-1.141.0/code ROBOT_COMPANION_UI_EVIDENCE_DIR=/evidence/mis-192/exact-source-ui xvfb-run -a npm run test:all`.
No package fetch is needed. The runner owns the fresh profile, synthetic data,
dynamic CDP port and app cleanup. Preserve failed workspaces/evidence; no shared
browser or user extensions are used.

Next implementation command: `sed -n '1,220p' src/integration/backend-contract.js`.
Then add the integration-owned pinned RobotCode launch/compatibility bridge and
its deterministic failure checks, keeping language and execution/debug selection
separate. Validate real services only through the approved prepared runtime, then
complete shared semantic identity, DAP/debugpy ownership and normalized discovery.
This is a continuation checkpoint, not author-handoff or final acceptance.


Documentation cross-check: the existing English/German overview and reference now
distinguish default coexistence from experimental owned LSP, link the descriptor
configuration, and retain real-backend/debug/discovery and host/version limitations.
The earlier unconditional no-language-server/no-diagnostics claims are removed.
Full-suite verification at lifecycle commit cd5029f20bec7970293eb8c2038a90164594c92f
passed: exit 0, 80 UI tests, 18 protocol tests, existing return/run checks and
45 named + 5 stray-tag + 2500 fuzzed HTML-fragment cases. That pass does not
certify the subsequent documentation commit; fresh source-bound results belong
in the issue checkpoint and /evidence.


The final advisory documentation pass found inherited Limits paragraphs still
contradicting owned diagnostics/execution and workspace-host placement. Those
English/German paragraphs now distinguish static enrichment/default coexistence
from explicitly launched adapters, and mark remote compatibility unverified.
The advisory allowance is exhausted; no further inner recheck or acceptance is
claimed. Final independent product reviews remain with the Lead at full hand-in.

At c19da757aab1f8699f428e20c49c3b6f0db9d258, full offline test:all also passed
(exit 0, 80 UI / 18 protocol plus existing checks). Owned Chromium 154.0.8037.57
pointer/Tab interactions reached the new local guide anchor in English/German at
1280 and 390 px. The new paragraph fits with visible focus. An additional global
mobile-layout assertion failed: the existing header extends to 442 px at a 390 px
viewport. Serving the exact preceding cd5029f documentation through the same fresh
browser reproduces the same 442 px width and identical header coordinates in both
languages. This inherited layout limitation is preserved, not counted as a mobile
layout pass or repaired as part of the backend-adapter work. Evidence is under
/evidence/mis-192/c19da757aab1f8699f428e20c49c3b6f0db9d258/, including failed
assertion output, four interaction screenshots and baseline comparison JSON.

## Return Explorer definition identity (MIS-235/MIS-239 bounded dispatch)

Base 6c06aee5933ddd148e27c766a9520b992805e274 plus a preserved uncommitted tranche
from an interrupted run. In owned mode the Return Explorer's keyword definition
link and its docstring/return/enum metadata use the backend's single resolved
definition (`src/integration/definition-identity.js`), joined to index metadata by
resolved URI and line only. No/several targets show a notice and no link; a clicked
link is re-resolved and refused if stale. Owned documents bypass the return/enum
runtime caches and prewarm; the cache settings signature includes the language
generation. Coexistence paths are unchanged.

Focused checks before commit: `npm run test:integration` exit 0, 21/21; language UI
suite exit 0, 11/11 at 1280x900 with RobotCode extension absent. Actual CDP pointer
clicks on the Return Explorer link reach AuditLibrary.py line 12/column 5 from the
keyword-doc, argument and return-variable views and for `Audit.Build Record`;
shared.resource line 2 and audit.robot line 18 keep their ranges; missing and
ambiguous fixture responses render no link. UI test robustness: click points must be
layout-stable and land on the target line (late CodeLens rendering), and Return
Explorer link clicks wait for re-renders to settle. Fixture mappings prove routing
only, not Robot import semantics. The pinned RobotCode bridge, owned DAP and Test
Explorer remain. Exact-SHA full `test:all` was not rerun for this checkpoint.

Argument/documentation link audit (follow-up tranche): every keyword-source link the
Return Explorer builds goes through the owned identity: keyword-doc definition,
argument/enum view and return view. In owned mode "Other Matching Definitions" is
empty. Docstring argument names preview the argument and move to the Robot call
site by design. Every other open-location link targets the Robot document itself
(owner, assignment, current-value lines), not a keyword definition. The existing UI
test already clicks a docstring argument link and then that view's definition link
through to AuditLibrary.py line 12/column 5. No source change was needed; README and
the EN/DE reference no longer list these links as unconnected.

## Owned debug lifecycle, Tranche A (CEO MIS-262 fixture-first order)

Fixture-only. `src/integration/dap-session.js` is an integration-owned inline
debug adapter: it spawns the contract-v1 `services.debug` executable/argv (stdio,
no shell) from `robotCompanion.executionBackend`, records negotiated capabilities,
names missing journey capabilities in the Debug Console, answers pending requests
and ends the session if the process dies, and stops the process with a bounded
grace period (stdin end, then SIGTERM after 1 s, then SIGKILL). It imports no
VS Code API, so RobotCode/debugpy handoff can be normalized there later.
`src/integration/debug-workspace.js` registers the `robotcompanion` type: the
configuration provider checks trust, owned mode and the descriptor before
anything starts; the descriptor factory re-checks immediately before spawn; mode or
descriptor changes stop running sessions; deactivate stops all owned processes.
The language descriptor is never read for debugging.

Checks: `tests/integration/dap-session.test.js` (local DAP fixture
`tests/integration/fixtures/dap/server.js`) covers descriptor errors, logs off the
protocol, capability reporting, a backend ignoring disconnect/SIGTERM, a crash
and a missing executable. `tests/ui/suite/debug-workspace-ui.test.js` clicks Run
and Debug's start button and the debug toolbar's stop button at 1280x900 and
checks the protocol transcript and the owned process exit. Robot breakpoints,
stepping, variables, Debug Console keywords, the Python handoff and the live
journey remain blocked on the WOL-805 runtime. Next: Tranche B, the TestController.

## Owned Test Explorer discovery, Tranche B (CEO MIS-262 fixture-first order)

Fixture-only. `LspSession` takes a `service` option, so the optional
`services.discovery` process reuses JSON-RPC framing, the initialize handshake and
bounded stop. `src/integration/test-discovery.js` validates the normalized
discovery result v1 (`robotCompanion/discoverTests`). It derives IDs from source
(the suite is its file URI; a test is that URI, `::`, its name, plus `#n` for a
repeated name). It rejects non-file URIs, sources outside the folder and invalid ranges.
`src/integration/test-workspace.js` creates the `robotCompanion` TestController
only while an owned, trusted folder has a discovery service that advertises
`robotCompanionDiscovery.version` 1. Failures become an error item, saves
rediscover, and coexistence disposes the controller and stops the process. Its
Run profile delegates each test to the existing `robotCompanion.runTest` runner
(robotCommand, per-run output folder). Status comes from the run outcome, not yet
from parsed Robot output.

Checks: `tests/integration/test-discovery.test.js` (local discovery fixture
`tests/integration/fixtures/discovery/server.js`, a line scan with no Robot
semantics). `tests/ui/suite/test-workspace-ui.test.js` clicks the suite row,
clicks the test row (which opens its source line), clicks the row's Run Test
action (fake `robot`, passed) and checks that coexistence, a debug-only backend
and invalid results register no partial controller. Real Robot runs, per-test
results, Test Explorer debug, rerun and cancellation remain open.

## Pinned RobotCode 2.7.0 language bridge, Tranche C (WOL-805 runtime applied 18 Oct 2026)

Runtime: operator image venv `/opt/robot-backend` (Robot Framework 7.5 on Python
3.13.7, robotcode 2.7.0, debugpy 1.8.22), read-only wheels in `/opt/robot-wheels`.
Nothing was fetched.

`src/integration/robotcode-bridge.js` holds every RobotCode-specific detail. It
builds explicit descriptors (`python -m robotcode.cli language-server --stdio`;
the `debug-launch --stdio` argv is reserved for the debug tranche). It pins the
version: a `robotcode` descriptor must declare 2.7.0 and the server's
`serverInfo` must be *RobotCode Language Server 2.7.0*, otherwise the language
workspace fails visibly and registers nothing. It also answers
`robotcode.documentationServer` with `startOnDemand: true`. Without that,
RobotCode binds a fixed localhost port (3100) for its extension-only doc server,
and shutdown waits for that server's poll loop.

`LspSession` keeps the server's `serverInfo`, closes stdin after `exit`
(RobotCode leaves its stdio loop only at EOF) and gives a running backend 2 s
(`stopTimeoutMs`) to shut down. Non-running stops keep the 500 ms SIGTERM bound.

Checks: `tests/integration/robotcode-bridge.test.js` runs the real language
server on a copy of audit-v1. It checks imported `Build Record` → AuditLibrary.py
12:1 despite AShadow.py, `Resource Step` → shared.resource 2:1, `Local Step` →
audit.robot 18:1, and the new `alias.robot` (`AS Audit`): `Audit.Build Record` →
AuditLibrary.py 12:1, with the `Audit.` prefix → the import line. It also checks
that no listening socket is open and that stop gives exit code 0, plus version-pin
refusals. Live cases are skipped by name when the venv is absent
(`ROBOT_COMPANION_ROBOTCODE_PYTHON` overrides the path).
`tests/ui/suite/language-workspace-ui.test.js` has a live case at 1280x900 with
actual pointer and key input. Editor click plus F12, Linux Peek and Ctrl-click,
and the Return Explorer's **Jump to keyword definition** link, all reach the
imported library and the resource/local sources. Mode exit then shows RobotCode
exit code 0.

Debug (RobotCode `debug-launch` behind `dap-session.js`, debugpy handoff),
discovery/results from real Robot output and the full live journey remain next.

## Pinned RobotCode 2.7.0 debug bridge, Tranche D (2026-10-18)

`RobotCodeDebugBridge` (in `robotcode-bridge.js`) is consulted by
`DapProcessAdapter` for `robotcode` descriptors. It translates the
`robotcompanion` launch configuration plus the per-root `ExecutionContexts`
entry (cwd, robotArguments) and a per-run `debug-runs/` output folder into
RobotCode launch arguments: `internalConsole`, `attachPython`, and
`attachPythonPort: 0` for a dynamic loopback port.

The adapter renumbers client request seq so it can send its own `robot/sync`.
RobotCode blocks up to 15 s per synced event without it. RobotCode custom
events (`robot*`, `debugpyStarted`) are not forwarded. `debugpyStarted` becomes
a `pythonChild` endpoint. `DebugWorkspace` turns that endpoint into an attach
child session of the same type with `parentSession` and `MergeWithParent`. Its
descriptor is `DebugAdapterServer(port, 127.0.0.1)` and is valid only for a
one-time handoff token. The child must attach while RobotCode waits in
configurationDone. debugpy rejects an empty attach-arguments object, which VS
Code never sends.

The adapter process is spawned detached (its own process group). Stop and
close signal the group, SIGTERM then SIGKILL, because a paused Robot run
ignores a graceful SIGTERM. The debugpy adapter runs in its own group and exits
when the Robot process is gone. The `breakpoints` contribution now covers
robotframework and python.

Checks: `tests/integration/robotcode-debug.test.js` replays the audit
transcript over the adapter with a raw DAP client for the Python child.
`tests/ui/suite/robotcode-debug-ui.test.js` does it in VS Code with gutter
clicks, the Run and Debug start button, Debug Console typing, F5/F10 and a
Call Stack Robot frame click. It checks output.xml for 1 PASS and Ada, and that
the process group is gone.

## RobotCode discovery and per-test results, Tranche E (2026-10-18)

RobotCode has no discovery service, so `RobotCodeDiscovery` (in
`robotcode-bridge.js`) wraps the one-shot command
`python -m robotcode.cli --format json --no-color --no-pager discover tests
<folder>` (execFile, no shell, 60 s timeout). It has the same start, request
and stop shape as the discovery `LspSession`, and `normalizeRobotCodeTests`
groups RobotCode's flat test list into normalized v1 suites. IDs are still
derived by `test-discovery.js`. `TestWorkspace` selects it for `robotcode`
descriptors.

`src/integration/robot-results.js` reads `output.xml`; only a `<status>` that is a
direct child of `<test>` counts. Test Explorer runs take each test's status
(PASS/FAIL with message/SKIP) from the run's own output.xml, matched by source
path and test name, and fall back to the exit outcome.

Checks: integration unit and live discovery tests plus a `robot-results` unit
test. A live UI case in `test-workspace-ui.test.js` checks that RobotCode
discovers 21 suites in the synthetic workspace, then clicks the audit.robot
row, the Debug Smoke row (opens line 9) and the row's Run Test action, with
robotCommand set to the venv's `robot`. The run reports PASS from output.xml
(Robot 7.5).

## MIS-322 Test Explorer run selection, rerun failed, Stop and Debug Test (2026-10-18)

Base: accepted MIS-192 artifact `030c9a3e00419e04cf2a48a09a1e8b43dca32459`, fast-forwarded
into this issue's worktree. `backend/**` untouched; no sibling artifact imported.

- `src/integration/test-runs.js` (no VS Code): `planSuiteRuns` groups the selection
  into one Robot run per suite file (`--test` filters; a whole suite runs unfiltered),
  `matchResults` maps each requested test to its own `<test>` entry in that run's
  output.xml by source, name and occurrence, and `RobotProcess` spawns Robot detached
  (own process group, no shell) and cancels the group with SIGTERM, then SIGKILL after
  2 s. Robot's command and arguments come from the existing `ExecutionContexts`
  adapter (`robotCommand`, `robotArguments`); no environment picker.
- `TestWorkspace` no longer delegates to the CodeLens runner. Run reports
  Passed/Failed(message anchored at the item range)/Skipped from output.xml only; a
  test without an entry is errored with the exit outcome (never Passed by exit code).
  `--output output.xml` is forced after user arguments. Stop keeps results Robot had
  finished and marks the rest Skipped (Robot's "Execution terminated by signal" /
  "stopped due to a fatal error" entries count as unfinished). A Debug profile exists only while a discovered root's backend has a debug
  service; it starts a `robotcompanion` launch (`args: --test ...`, linked `testRun`)
  and reads the result from `DebugWorkspace.onDidFinishRun` (session output folder).
- Fixture `tests/integration/fixtures/test-explorer/` (copied into the UI workspace as
  `integration-test-explorer/`): pass/fail-until-flag/unselected, and a test that waits
  in a `sleep` child in Robot's process group.
- Checks: `tests/integration/test-runs.test.js` (real Robot 7.5: concurrent runs keep
  their own results, rerun after fix, Stop kills the group in <5 s, later run works);
  `tests/ui/suite/test-explorer-runs-ui.test.js` (`ROBOT_COMPANION_UI_SUITE=test-explorer`,
  live, 1280x900): Ctrl-click multi-selection + row Run Test, failure peek at the source
  line, Test Results Rerun Failed Tests action, suite-row Run, Stop (Cancel Test Run)
  with `pgrep -g` empty, Debug Test to a gutter breakpoint then F5, and the
  discovery-unavailable fallback (F12, CodeLens Run Test click, Run and Debug start).

Remaining gaps (README): coverage, continuous run, tag/filter profiles, live per-test
progress within a suite run, Robot's case/space/underscore-insensitive `--test` matching.
Stop during a Debug Test session is implemented (token → stopDebugging) but not in the
live UI check.

Advisory inner review (judge, read-only) of c4ff061 found and the repair fixed: test
names ending in `#n` were read as repeat occurrences (occurrence now recorded at
discovery); a run could wait forever on `close` when a leftover process kept Robot's
pipes open (now settles 2 s after `exit` and kills the group); exit-code-only Passed;
Stop discarding finished results; double-cancel timers; pruning of in-use run folders;
undisposed processes on deactivate; Stop before a Debug Test session registered.
`tests/integration/test-runs.test.js` covers the engine-level cases.

Round-2 repair (Lead F1/F2 on b9ded59). Reproduced live: during a Debug Test waiting in
`sleep 300`, Stop sent `disconnect`, RobotCode never answered, and the session plus the
launcher, Robot, debugpy adapter and `sleep` stayed alive. Robot and `sleep` share the adapter's
process group, and debugpy has its own group and exits with Robot. `DapProcessAdapter` now
kills the group 2 s after an unanswered disconnect/terminate and always emits `terminated`
when its process is gone. Test Explorer Stop calls `stopDebugging` and, after 3 s,
`DebugWorkspace.forceStop`. The live UI case clicks both Stops: processes gone in about 4.8 s
(Testing) and about 2.2 s (toolbar), the test shows Skipped, and later Run/Debug Test pass.

## MIS-319 review follow-ups (2026-10-18)

Base `030c9a3e00419e04cf2a48a09a1e8b43dca32459` (accepted MIS-192), fast-forwarded into the
MIS-319 worktree. Baseline at the base: owned UI suites 20/20, viewport 1280x900; the
Debug Console showed `start debugpy session on port 55633` and debugpy's frozen-modules
warning, and no `Log` messages (`outputLog: false`).

- Debug Console: `RobotCodeDebugBridge.event` drops RobotCode's own stderr line
  `start debugpy session on port N` until `debugpyStarted` (later stderr is program output and
  is never rewritten). The line comes from `robotcode/debugger/run.py` (`find_free_port(0)` always
  differs from the requested port 0). Launches now set `outputLog: true` (launch attribute
  `outputLog: false` opts out), so `Log` messages reach the console with their source line.
  The frozen-modules warning stays: silencing it needs `-Xfrozen_modules=off` or
  `PYDEVD_DISABLE_FILE_VALIDATION=1` in the run environment.
- Coexistence picker: reproduced red first (choosing Robot Companion in the debugger picker
  said "Open a .robot or .resource file"). `resolveDebugConfiguration` now gives the trust or
  coexistence refusal for that path. Option chosen: the debugger stays listed; choosing it
  refuses with the existing explanation (`hiddenWhen` would not cover VS Code's language-based
  auto-selection for an open `.robot` file).
- Real CodeLens click: owned mode with the README's RobotCode debug/discovery descriptor and
  `robotCommand` = venv `robot`; a CDP click on the rendered **Run Test** lens passes.
- Advisory, done: the Python child is no longer `compact`, so Call Stack keeps the Robot session
  (Running) with the paused Python session nested under it; asserted in the live debug test.
- Advisory, done: `tests/ui/trust-transitions.js` (`npm run test:trust`) starts a normal VS Code
  window with workspace trust enabled and checks Restricted / Trust / Don't Trust with clicks
  and `/proc`. Not part of `test:all`.
- Observed, not changed: at the Python stop the Variables view can still show the Robot scopes
  in the fast automated run; the Python session received no `scopes` request before the next
  action (base behaviour too).

Iteration evidence: `/evidence/mis-319/baseline-030c9a3/`, `/evidence/mis-319/dev/*`.
`ROBOT_COMPANION_UI_GREP` filters UI tests for author iterations. Exact-SHA results are in the
issue `artifact-handoff` document.

## MIS-351 owned hover, completion, signature help, references, rename and symbols (2026-10-18)

Base: accepted MIS-322 `f66e7e156c7f5cfc6557b1ca25e2cf1c7ef9ea1a`, fast-forwarded, then the
accepted MIS-319 `2de7b0e8cbc1307e927d946189eedd0be85c1d32` merged in this worktree
(merge `f9a487cfb2f9f08f2d64df1a7b62b94a3bc67da7`). Conflicts were README/CHANGELOG/reference
wording only; both entries kept. On the merge the MIS-319 real CodeLens click failed twice:
after MIS-322's Test Explorer steps the pointer rested on an Explorer row whose path tooltip
covered the **Run Test** lens, so the kept hit check refused it. The test now first rests the
pointer on the editor margin; test:all on the merge then passed (UI 100, integration 54).

- `language-protocol.js`: LSP results to VS Code objects (ranges checked, file URIs only,
  untrusted markdown, only `triggerSuggest`/`triggerParameterHints` item commands, rename
  edits limited to text edits inside the owning workspace folder).
- `language-merge.js` (no VS Code): the owned-mode precedence rule. Hover: Companion sections
  first; server paragraphs whose text Companion shows are dropped, with headings left empty;
  a heading without paragraphs counts as a paragraph. Completion: server items repeating a
  Companion label/insert text are dropped. Node tests in `tests/integration/language-merge.test.js`.
- `LanguageWorkspace.register` adds one provider per advertised capability (`root.features`).
  Hover and completion are composed there: Companion's own registrations stand back
  (`backendProvides`) in roots whose backend provides them, and a completion trigger
  character reaches only the side that registered it. `LspSession` now declares client support
  for hover, completion, signature help, references, rename (prepare), hierarchical document
  symbols and workspace symbols; RobotCode 2.7.0 advertises document/workspace symbols only then.
- Fixture modes `language-features` / `language-features-partial` (no hover/rename) with
  per-method request counts.
- Live UI `tests/ui/suite/robotcode-language-ui.test.js` (1280x900, CDP input). Observed VS Code
  1.141 behaviour: a refused rename *edit* is an info notification, a refused *prepare* is the
  inline message; `files.refactoring.autoSave` (default true) saves renamed files, so the test
  restores `audit.robot`/`shared.resource` for later suites. Companion's documentation hover
  covers the `#>`/`[Documentation]` lines, not the keyword call line.

Not exposed (README gaps): formatting, code actions, semantic tokens, inlay hints, document
highlight, implementation, folding/selection ranges, server CodeLens, inline values.

## MIS-363 provider selection: native backend or RobotCode (2026-10-18)

Base: accepted MIS-351 `3930ebc50e71e069ce7406fa8288384e43921a68`, fast-forwarded, then the accepted
MIS-350 backend `b56f1bc13f547f4f8147b12549408a1a4463b079` merged in this worktree (merge
`47dbf676155e2156c0ea34ffd620ef9b119c20d3`; disjoint paths, no conflicts). `backend/**` and
`agent/documentation/backend/` are unchanged after the merge.

- `native-backend.js`: descriptor builder (`robot-companion-backend lsp` / `dap`), declared-version pin
  (0.1.0.dev1), post-initialize serverInfo check, `NativeDebugBridge` (launch arguments with
  `--outputdir` and `pythonDebug: {handoffVersion: 1}`, Python-source breakpoints answered in the
  adapter, `robotCompanion/pythonSession` → normalized `pythonChild` with its attach configuration,
  `configurationDone` held until `pythonConnected` and the child's own configurationDone, owned
  worker/debugpy process groups). `backend-providers.js` selects the provider per descriptor;
  `dap-session.js` consults any bridge through `launchArguments/answer/hold/event`.
- `backend-contract.requireService` refuses a missing/non-executable service executable before spawn.
- `provider-status.js`: three language status items (Language/Debug/Tests). Hover details are short
  counts because the hover row does not wrap (long details pushed the Details link off-screen);
  Details prints the full lines. Debug capabilities come from an initialize-only probe.
- `robotCompanion.discoveryBackend`: discovery when the execution descriptor has none (native).
- `LspSession` sends `shutdown` without `params` (native rejects `null`; JSON-RPC 2.0 requires
  structured params) and still sends `exit`/EOF if shutdown fails.
- Tests: `tests/native-backend.js` builds the wheel from a copy of `backend/` and installs it offline
  into `$TMPDIR/robot-companion-native-<backend tree hash>` (receipt: commands, exits, packages,
  doctor, RobotCode absent). Live native integration cases; language/debug UI suites parametrized
  per provider; `provider-switch-ui.test.js` (four combinations with status hover/Details, refusals,
  both mixed combinations live, switch back, discovery per combination with native Debug Test,
  coexistence); `test:trust` runs both providers and is now part of `test:all`.
- Observations: the Companion-features language case creates and deletes an imported enum library;
  RobotCode then lost references for the audit file in later cases, so that case runs last. VS Code's
  main thread logs `Invalid debug adapter` after owned sessions with a Python child for both providers;
  no test or session is affected.

## MIS-402 deterministic UI checks (2026-10-18)

Base: accepted MIS-384 `8f355f2e35d4f566a2b4af526c9fbf3d729162ca`, fast-forwarded. Test-only;
no product or `backend/**` change.

- Stale/cancelled definitions (`language-workspace-ui.test.js`): the protocol fixture no longer
  delays definitions by a timer. `fixture/holdDefinitions` keeps each answer until
  `fixture/releaseDefinitions`; `fixture/heldDefinitions` counts them. The UTF-16 case releases
  the held answer only after the fixture has received the edit's `didChange` (same version as
  the editor), so the answer is stale by protocol order. The mode-transition case keeps its
  answer held until the backend stops.
- Debug toolbar Stop (`test-explorer-runs-ui.test.js`): issued while the Debug Test is paused at
  a breakpoint on `Wait In Child Process`, with the toolbar Stop point and Continue button
  settled. The Testing Stop still stops Robot waiting in `sleep 300`. In VS Code 1.141 a toolbar
  Stop on a session linked to a test run cancels the test run first (`cancelCorrelatedTestRun`);
  the session then ends through Robot Companion's `stopDebugging`, so the run is reported
  cancelled before the session ends. The one observed `completed` was not reproduced: 0 of 27
  toolbar Stops during `sleep 300` (15 of them under heavy CPU load), so no product race was
  found and no product code changed.
- Process ownership: `debugRunProcesses()` keeps only processes whose environment has this UI
  run's `ROBOT_COMPANION_UI_USER_DATA_DIR` (inherited from the extension host, also by the
  debugpy adapter that is reparented to init). The case first starts a `sleep 300` without
  that marker and checks it is not matched; an earlier review run had matched its own
  waiting `sleep 300`.
- No cascade: the suite teardown waits for (and, after 10 s, kills) this run's leftover
  debug processes, clears test results (and so the failed badge on the Testing icon) and
  notifications.

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

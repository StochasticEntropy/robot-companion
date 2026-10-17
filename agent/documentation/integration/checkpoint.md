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

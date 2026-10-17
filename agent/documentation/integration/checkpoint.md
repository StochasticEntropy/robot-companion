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

`src/integration/backend-contract.js` is an internal, unregistered module:

- Version-1 descriptors validate ID/version, file workspace URI, absolute cwd,
  explicit executable/argv and environment, and stdio service transport.
- Language and execution/debug selections are independent. Optional discovery
  is absent explicitly. Coexistence selects no owned services and does not read
  executable descriptors. This does not yet change extension registration.
- The launch guard refuses untrusted execution before reading descriptors.
  No module starts processes or probes environments. Lifecycle integration must
  call the guard at spawn time and stop processes on trust/mode/root changes.
- A per-root execution-context cache preserves existing robotCommand parsing
  and robotArguments, snapshots inputs, and supports removal/disposal. It is not
  wired to the runner yet. No second environment picker or interpreter guess.
- `lsp-session.js` owns a stdio JSON-RPC process with byte framing, initialize /
  initialized / shutdown / exit, accurate returned capabilities, UTF-16 position
  negotiation, stderr separation, cancellation, request timeouts, restart and
  forced cleanup. It is not registered in the extension. A local Node subprocess
  fixture proves protocol/error lifecycle only, not RobotCode compatibility.
- Audit corpus copied into tests/integration/fixtures/audit-v1 independently.

## Verification and limits

`npm run test:integration`: exit 0, 13 tests.
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

1. Missing: registration, RobotCode-backed LSP lifecycle and mode/trust event
   cleanup. Descriptor/selection and local protocol-process foundation only.
2. Missing: semantic definition identity and shared enrichment navigation, full
   audit and alias/ambiguity/UTF-16/change coverage. Original shadow bug remains.
3. Missing: owned DAP, debugpy handoff, mixed sessions and live console journey.
4. Missing: normalized discovery/result API, native TestController and real run.
   Existing CodeLens runner is unchanged.
5. Partial: descriptor/error and local protocol subprocess checks; real
   RobotCode-backed fallback remains to implement. No native acceptance claim.
6. Missing: new criterion-specific UI/protocol checks and final source-bound
   test:all. Existing baseline is retained separately.
7. Partial: context boundary and trust guards tested in isolation; integration,
   configuration and user docs remain. Remote/multi-root and minimum VS Code
   are unverified; a unit test with two roots is not host compatibility proof.

Advisory inner review found sparse argv arrays were accepted because Array.some
skips holes. The validator now checks a dense copy, with a rejection regression.
The advisory review is not a product gate and establishes no UI acceptance.

Next command: `npm run test:integration`, then implement the pinned RobotCode
bridge using the approved runtime/dependency path and wire the existing stdio
session into owned/coexistence registration. Follow with semantic-link and DAP
integration. Runtime preparation remains WOL-805; no separate dependency on the
independent backend artifact is introduced.
Do not touch backend/**, import the sibling artifact, fetch dependencies, claim
mock support as real, or request final review of this partial checkpoint.

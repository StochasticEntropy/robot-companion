# MIS-505 baseline interaction audit

Source: f89ddff08e6efd366f765f9317203ce67d6f49c2, clean on entry. Linux aarch64, VS Code 1.141.0, owned fresh Electron/Chromium profiles, external extensions absent, synthetic fixture copies only. Xvfb 1280x901x24 yields CSS 1280x900. Container PID 1 is tini; /dev/shm is 1 GiB.

Before source edits, execute the targeted grep described in baseline/ui.log. Result: 2 passed, 3 failed, exit 1. Exact Return Explorer pointers and F12/Peek/Ctrl-click passed. Repeat the bounded ordered probe with malformed descriptor and UTF-16 edits as immediate predecessors (baseline-order/ui.log): 4 passed, exit 0. Full original-order baseline started clean; its result and navigation observation live under baseline-full.

1. Peek close: not reproduced in initial isolated or ordered probes. Both press Escape once and observe disappearance, without a retry. The full-order CDP observer records focused element, editor, selection, Peek presence and notifications every 200 ms; preserve this rather than inventing a product diagnosis.
2. Return Explorer: imported definition, argument and return-variable source links reached AuditLibrary.py line 12 / UTF-16 column 5 in both probes. No source mismatch is established by these runs. Keep exact path/column assertions and add failure diagnostics and an explicitly non-BMP call-site column check.
3. Discovery: reproduced exact failing no-Debug-Test assertion. backendDescriptor substitutes native debug+discovery when executionBackend is absent. The existing test had cleared the descriptor while calling that absence a lack of services. Test absence/default and explicit descriptor without debug separately; retain no-Debug-Test assertions for the latter.
4. Output: reproduced on native language + RobotCode execution. The collected DOM begins with the middle of the native capability line; the visible latest Debug and Tests rows are correct. VS Code virtualizes wrapped Output lines above the visible panel. Verification must navigate/read the complete latest status block through the real Output control, preserving full capability assertions and selected-provider identities.
5. Refusal: reproduced first native version case; status and Output show both versions and the language refusal, but the expected toast was not visible. Clearing descriptors before entering coexistence briefly selects native defaults in an unprepared fixture project; recorded notifications show missing default executables for unrelated services. Explicitly isolate contracts and enter coexistence before clearing settings; retain exact setting/value/refusal/no-process assertions.

No UI redesign is proposed. Existing Robot Companion surfaces, colors, typography, source semantics, explicit RobotCode fallback, native defaults and trust/ownership assertions remain authoritative. This is automated actual-input evidence, not a human usability session. Windows actual UI (MIS-435) and broad host qualification (MIS-488) remain separate.

## Full baseline and changes

The complete UI baseline at the same clean source finished **140 passed, 4 failed**, exit 1 (`/evidence/mis505/baseline-full/ui.log`). The local Peek and Return Explorer cases passed in original suite order too. Three known failures reproduced. The additional failure was Refresh Tests: `Invalid parameters (-32602)` from CDP while the Testing view had no rendered tree. Its screenshot and row dump are retained. Tree scrolling now waits for a real, visible hit-tested tree point; CDP errors name the command for future diagnosis.

The repair changes the qualification harness and documentation only. No `src/` or `backend/` implementation changes are needed based on these observations. In particular:

- The preview-default integration test distinguishes absent overrides (both native debug/discovery) from explicit service omissions. The actual editor discovery matrix checks a native default with the owned installed executable, as well as an explicit discovery-only contract with no Debug Test. The no-debug assertion remains.
- Provider fixture teardown enters coexistence before clearing descriptors. Refusal cases explicitly select the other side's service omission, avoiding unrelated default executable failures; exact values, setting names, visible notifications, refusal statuses and no-process checks remain.
- Status Details is clicked with actual input. The Output editor is focused, its contents selected/copied by real keyboard events, and only the newest appended `owned:` block is checked against the full language/debug capability expressions. Copied blocks and screenshots are retained. This avoids treating absent DOM nodes from Output virtualization as missing content.
- Language pointer hit tests target the intended audit editor, not an embedded Peek or Output editor. Peek waits for keyboard focus, receives one Escape, and records before/after focus, source URI, selection and notifications. A failure records diagnostics and fails without retrying Escape. Navigation checks exact URIs and UTF-16 positions, editor keyboard focus, and screenshots. A non-BMP assignment-name case checks the argument column differs from the code-point column, then follows its definition link. The original source, alias, stale, missing and ambiguous cases remain.

## Reproduction and evidence

Use a fresh isolated Linux container with the provisioned `node_modules`, Node 24, Python 3.13, `/opt/robot-wheels`, `/opt/robot-backend/bin/python` (RobotCode 2.7.0) and `/opt/vscode-test/vscode-linux-arm64-1.141.0`. Do not fetch dependencies. The UI runner builds/installs the current native backend offline into an owned temporary venv; the native venv receipt records source tree hash, wheel hash, packages and absence of RobotCode.

On this container an owned scratch executable wrapper invokes:

```sh
#!/bin/sh
exec /opt/vscode-test/vscode-linux-arm64-1.141.0/code --no-sandbox "$@"
```

Set `ROBOT_COMPANION_VSCODE_EXECUTABLE` to that executable wrapper. The wrapper lives outside source under the run scratch directory; `/evidence/mis505/launch-path` records its actual location. Launch/check commands from the ticket worktree:

```sh
mkdir -p .vscode-test
ln -sfn /opt/vscode-test/vscode-linux-arm64-1.141.0 .vscode-test/
ROBOT_COMPANION_UI_EVIDENCE_DIR=/evidence/mis505/final \
  xvfb-run -a -s '-screen 0 1280x901x24' npm run test:all
```

Leave `ROBOT_COMPANION_UI_GREP` and `ROBOT_COMPANION_UI_SUITE` unset for qualification. The UI runner creates a synthetic saved workspace, copies the small fixtures, starts a fresh profile and extension directory with a dynamic CDP port, and uses real CDP pointer/type/key input. Profile paths and `DevToolsActivePort` are owned by that run. Success removes workspace/profile; failure retains its synthetic workspace and reports the path. No host/user browser or business data is used.

Evidence batches: `baseline`, `baseline-order`, `baseline-full`, `iteration1`, and the clean committed candidate's `final` under `/evidence/mis505/`. Final source SHA, initial/final dirty state, exact command exits, actual counts, retained screenshot/log paths and process cleanup are published in MIS-505's `author-handoff` issue document. That document is the durable review handoff; private container paths alone are not acceptance. Author checks and screenshot inspection do not constitute Lead acceptance or a human usability session.

Native default behavior and the explicit RobotCode fallback remain shipped as before. Backend source is unchanged, so no new backend compatibility-row claim is made here. Windows actual editor qualification remains MIS-435 and broad host qualification remains MIS-488. No publication, push, merge, deployment or full-program acceptance is part of this outcome.

## Bounded author iterations

The first changed-harness run (`iteration1`) executed eight targeted cases: seven passed, one failed because its Output click target used the full, virtualized `.view-lines` rectangle, which extends outside the panel. The hit-tested target was corrected to the actual Output editor viewport. `iteration2` then executed the four-combination provider case and all four refusal subcases: both tests passed, exit 0. These exploratory runs used a dirty author tree and are not the final source-bound gate. The exact command/filter, source diff and exits are retained under `/evidence/mis505`; final qualification runs all cases from a clean committed candidate without a filter.

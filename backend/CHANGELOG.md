# Backend changelog

## Unreleased (MIS-478)

- `dap` advertises and implements `restart` and `cancel`. A restart keeps the client session and its Robot breakpoint IDs and replaces the Robot worker, the debugpy adapter and the Python child. Robot handles of earlier runs are refused (*Stale Robot handle from an earlier run of this session*), and changed run inputs are refused before anything changes. `cancel` ends an in-flight `launch`, `attach` or `restart` with the `cancelled` message, and a second lifecycle request while one runs is refused as busy. `disconnect` with `terminateDebuggee: false` fails with *Owned native sessions cannot detach; disconnect ends the owned run* and still ends the run; `terminated` follows the disconnect response once. `attach` without a prepared session, and attach by `processId`/`host`/`port`/`connect`/`secret`, fail with named messages.
- New `dap-prepare` and `dap-connect` commands (`prepared.py`) implement prepared-session attach: a foreground owner of the run, a private one-use descriptor and HMAC-authenticated loopback claim. See the README's Services section.
- New required suites `test_prepared.py`, `test_dap_restart_live.py` and `test_dap_prepared_live.py` run in the release harness. A build from this source has 19 runtime modules (adds `prepared.py`), so the 18-module note below applies only to the published 0.1.0.dev1 preview build.

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.
- Include the accepted Windows qualification repairs (MIS-434, `cf6fc04`): the worker reports its actual interpreter PID for the debugpy handoff, reaped Windows process handles close explicitly, an idle Python child DAP reader is cancelled without blocking on a buffered socket read, and the live suites observe processes portably through `tests/processes.py`.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

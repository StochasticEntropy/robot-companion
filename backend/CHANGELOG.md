# Backend changelog

## Unreleased

- Advanced debugging (MIS-479): hit counts, two default-off Robot failure filters and `setVariable` for paused Robot scalars are implemented and advertised (`supportsHitConditionalBreakpoints`, `exceptionBreakpointFilters`, `supportsSetVariable`). A hit count is `N`, `==N`, `>=N` or `%N` with N from 1 to 2147483647; any other value refuses the whole `setBreakpoints` request. Each executed call counts (not NOT RUN, `Run Keyword` inner duplicates or console evaluation) before the condition. `robot-failed-keyword` stops at each keyword ending FAIL, handled or not; `robot-failed-test` at the final FAIL after teardown. Stops have reason `exception` and name the Robot failure; they are read-only. After configuration the worker has one control reader that queues commands for the Robot thread: filter changes are acknowledged when queued and applied in revision order at the next listener callback, or at once while paused. `setVariable` writes one strict JSON scalar with RF's `set_local` into the active scope; RF's own and command-line variables, non-scalar values, outer frames, member handles and failure stops are refused. New suites `test_dap_advanced.py` and the required live `test_dap_advanced_live.py`.
- Windows mixed-debug parent shutdown now cancels an idle child DAP reader without waiting on a buffered socket read; real socket tests cover cancellation with an open peer and fragmented Unicode  frames. Windows API dependencies load at DAP startup so module initialization is separate from failed-launch resource measurements; repeated-attempt leak and no-fallback assertions are unchanged.
- Repair Windows preview conformance paths (MIS-434): the authenticated readiness message supplies the actual worker interpreter PID for debugpy handoff, reaped Windows process handles close explicitly, and failure-path resource tests remain mandatory. The live driver captures backend creation identity before shutdown; bounded listener refusal still requires an explicit refusal (never a timeout), Unicode harness output is explicit UTF-8, and Robot console checks preserve native line endings. Qualification belongs to the exact-SHA full release receipt; the historical full Windows run 39283871806 failed and remains evidence.

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

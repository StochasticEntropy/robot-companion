# Backend changelog

## 0.1.0.dev1 — author checkpoint

- Added bounded stdio framing, an explicit runtime probe and a standalone Python distribution definition.
- Added LSP source for parser/import-based navigation, current document overlays and limited syntax/import/ambiguity diagnostics; real RF conformance remains unverified.
- Added a `dap` service: a stdio DAP lifecycle subset with one owned Robot worker process group, an explicit RF prerequisite error, recorded unverified breakpoints and terminate/disconnect cleanup.
- Added experimental paused-thread RF listener source for breakpoint verification, stack/scopes/variables, continue/next/stepIn and live Robot keyword console calls, with a required real-process DAP suite; live behavior remains unverified without RF 7.5.
- Fixed private pipe cleanup when a worker fails to spawn; lifecycle checks cover real failed launches and reject unavailable Linux process observation.
- Added experimental Python handoff v1 source with an owned debugpy adapter, loopback child DAP connection, same-worker attachment and mixed-session cleanup; six real-process conformance cases remain runtime-unverified.
- Added an offline standalone build/install and conformance runner with source/hash/count receipts, isolated frontend-free venv execution and bounded owned-process cleanup; actual release verification still needs approved wheels.
- Copied the synthetic v1 audit corpus and added real-subprocess transport and language conformance drivers.

Live Robot and mixed debugpy conformance, plus standalone package acceptance, remain pending.

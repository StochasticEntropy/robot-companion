# Backend changelog

## 0.1.0.dev1 — author checkpoint

- Added bounded stdio framing, an explicit runtime probe and a standalone Python distribution definition.
- Added LSP source for parser/import-based navigation, current document overlays and limited syntax/import/ambiguity diagnostics; real RF conformance remains unverified.
- Added a `dap` service: a stdio DAP lifecycle subset with one owned Robot worker process group, an explicit RF prerequisite error, recorded unverified breakpoints and terminate/disconnect cleanup.
- Added experimental paused-thread RF listener source for breakpoint verification, stack/scopes/variables, continue/next/stepIn and live Robot keyword console calls, with a required real-process DAP suite; live behavior remains unverified without RF 7.5.
- Copied the synthetic v1 audit corpus and added real-subprocess transport and language conformance drivers.

Live Robot pause/stack/variables/console conformance, debugpy handoff and standalone package acceptance remain pending.

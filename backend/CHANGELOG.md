# Backend changelog

## 0.1.0.dev1 — author checkpoint

- Added bounded stdio framing, an explicit runtime probe and a standalone Python distribution definition.
- Added LSP source for parser/import-based navigation, current document overlays and limited syntax/import/ambiguity diagnostics; real RF conformance remains unverified.
- Added a `dap` service: a stdio DAP lifecycle subset with one owned Robot worker process group, an explicit RF prerequisite error, recorded unverified breakpoints and terminate/disconnect cleanup.
- Copied the synthetic v1 audit corpus and added real-subprocess transport and language conformance drivers.

Robot pause/stack/variables, live console, debugpy handoff and standalone package acceptance remain pending.

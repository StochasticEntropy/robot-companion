# Backend changelog

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add semantic token deltas (`full/delta`): edits against a document's last whole result, computed from the complete token set. The last result of at most 64 documents is kept; stale, unknown, evicted or earlier-process result IDs get the whole result.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

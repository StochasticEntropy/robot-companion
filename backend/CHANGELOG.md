# Backend changelog

## Unreleased

- Read class libraries (inheritance within the module, overrides, `@keyword`/`@not_keyword`/`@library`, static and class methods), hybrid libraries and dynamic libraries with a literal `get_keyword_names` list from their source, as Robot Framework 7.3.2 and 7.5 create their keywords; `Library    Module.ClassName` imports that class. Workspace code is still never imported or run.
- Resolve keyword names passed to `Run Keyword` and the other BuiltIn run-keyword variants for definition, hover, completion, references, rename, semantic tokens and diagnostics; errors that `Run Keyword And Ignore Error` and similar variants catch are not reported.
- Rename a Python library keyword through the string literal of its `@keyword("Name")` decorator and every call, or refuse with the reason and edit nothing (function-named, dynamic/hybrid, non-literal names, Python string mentions, name collisions, libraries outside the workspace). Rename edits are versioned `documentChanges` for clients that support them.
- Add the `robotCompanion/documentKeywords` request: the keywords a Robot file can call, grouped by import with alias, import line, documentation, signature and a call text that resolves to exactly that keyword.
- Names that cannot be read statically stay unresolved and unreported. A module library with a class whose base comes from a third-party package is no longer treated as fully known, so its unknown keywords are not reported.

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

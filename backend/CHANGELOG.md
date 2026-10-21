# Backend changelog

## Unreleased

- Read class libraries (inheritance within the module, overrides, `@keyword`/`@not_keyword`/`@library`, static and class methods), hybrid libraries and dynamic libraries with a literal `get_keyword_names` list from their source, as Robot Framework 7.3.2 and 7.5 create their keywords; `Library    Module.ClassName` imports that class. Workspace code is still never imported or run.
- Resolve keyword names passed to `Run Keyword` and the other BuiltIn run-keyword variants for definition, hover, completion, references, rename, semantic tokens and diagnostics; errors that `Run Keyword And Ignore Error` and similar variants catch are not reported.
- Library module names follow Python's import precedence in the importing file's directory: a package with `__init__.py`, then `Module.py`, then a directory without `__init__.py`. `Library    Kits.Tools` with both `Kits.py` and a directory `Kits/` now uses `Kits.py` as Robot Framework does, instead of `Kits/Tools.py`.
- A module library not found in the importing file's directory is looked up on the language service's own `sys.path` (the interpreter's site-packages), read the same way and never imported, so a project's installed libraries get definition, hover, completion and unknown-keyword diagnostics. A module beside the importing file still comes first, and rename refuses keywords of installed libraries.
- Rename a Python library keyword through the string literal of its `@keyword("Name")` decorator and every call, or refuse with the reason and edit nothing (function-named, dynamic/hybrid, non-literal names, Python string mentions, name collisions, libraries outside the workspace). Rename edits are versioned `documentChanges` for clients that support them.
- Add the `robotCompanion/documentKeywords` request: the keywords a Robot file can call, grouped by import with alias, import line, documentation, signature and a call text that resolves to exactly that keyword.
- `documentKeywords`: a resource imported by several statements is one group with every import site; a library imported under two names gives each instance its qualified `call` (`X.Name`), and `call` is `null` when only names differing in case could reach it.
- Names that cannot be read statically stay unresolved and unreported. A module library with a class whose base comes from a third-party package is no longer treated as fully known, so its unknown keywords are not reported.
- The release harness and conformance suites support Windows as well as Linux (ported from accepted MIS-434; this is not Windows qualification of the preview or the editor): `verify_release.py` uses the venv `Scripts` layout and passes a minimal Windows environment, each release command runs suspended in its own kill-on-close Job Object, and the live suites observe processes through `tests/processes.py` (Linux `/proc`, Windows Toolhelp32 snapshot) with Windows equivalents for the POSIX-only cases. The authenticated worker readiness message supplies the worker interpreter's actual PID for the debugpy handoff, reaped Windows process handles are closed explicitly, and a Windows mixed-debug shutdown cancels an idle child DAP reader without waiting on a buffered socket read. All suites, including the library and semantic-token suites, use explicit UTF-8 text I/O. The worker-crash and leftover-reaping tests again kill only the leader on Linux, not its process group, so the backend's own cleanup of the grandchild stays tested. Exact-SHA Linux and Windows results are recorded in the issue handoff, not here.

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

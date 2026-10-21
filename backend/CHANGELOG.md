# Backend changelog

## Unreleased

- Add the `robotConfiguration` initialization option (language) and request parameter (discovery): the folder's Robot arguments, parsed with RF's own parser; `--pythonpath`, `--variablefile`, `--variable` and argument files apply statically, nothing is imported or run, and `STDIN` argument files are refused.
- Resolve module-name imports on the configured python path and the run folder (no longer next to the importing file), `${CURDIR}` and statically known variables in import names, and `Variables` imports of Python, JSON and YAML files.
- Keep the first library imported under a name, as RF does, and treat one library imported under two names as two libraries.
- Report branch-sensitive undefined variables, and define variables set with a non-local scope for navigation and hover.
- Report `SystemExit` from a breakpoint condition or logpoint expression instead of ending the Robot run.
- Add the required live suite `test_project_configuration_live`.
- Apply the folder's robot.toml settings (`python-path`, `variables`, `variable-files`, `extensions`, `args` and their `extend-` forms) before the client's Robot arguments; report other settings, unknown keys, wrong types and TOML errors on the file, with hover help; add `robot-companion-backend project-config <folder>`.
- Honor `--extension` in discovery, and keep only the last `--variable` of a name, as RF does.
- Serve Markdown Robot sources with RF 7.5 (`.robot.md` suites, `.md`/`.markdown` resources) at their own lines and columns, also in debugger frames and breakpoints; with RF 7.3.2 report such files as not read, and refuse resource extensions RF refuses with its own message.
- Add the required live suite `test_project_files_live` (both runtime rows).

## 0.1.0.dev1 — Robot Companion 1.3.0 preview

- Support Python 3.11 with Robot Framework 7.3.2 and Python 3.13 with Robot Framework 7.5; refuse other runtime combinations.
- Add import-aware language navigation, completion, hover, signature help, references, rename, symbols, diagnostics, quick fixes and optional document formatting.
- Add full/range semantic tokens and normalized Robot test discovery.
- Add Robot breakpoint debugging, conditional breakpoints, logpoints, live debug-console keyword execution and a debugpy handoff for Python debugging in the same worker.
- Add authenticated worker control, owned-process cleanup, Windows drive-letter URI handling, junction avoidance and UTF-8 worker output.
- Package a standalone wheel and source archive with reproducible timestamps and embedded license metadata.

This is an experimental preview. The combined runtime has automated Linux aarch64/Python 3.11 validation; it has not been qualified on Windows, macOS or other architectures. Full language-server and debugger parity is not claimed.

The public artifact rebuild replaces documentation and metadata while preserving all 18 runtime modules byte-for-byte. Preview builds retain version `0.1.0.dev1`; use the artifact SHA-256 and installed-file verifier to identify the exact build.

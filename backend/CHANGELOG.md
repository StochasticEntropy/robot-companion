# Backend changelog

## Unreleased

- Hover on a Python library keyword without a return annotation (`def other(x):`) no longer shows a false `Returns None`; an invalid annotation is likewise omitted, while `-> None` still shows `Returns None`.
- Hover and definition on a typed variable definition cell (`${PORT: int}    8080`, `${n: int}=    Set Variable    1`) now find that variable, as for its later uses.
- Accepting a variable completion inside an extended-syntax name (`${rec|ord.name}`, `${rec|ord[0]}`) keeps the suffix: the edit replaces only the sigil and base name.
- Signature help splits `name=value` with RF's own rule, so `=` inside a variable, item access or inline expression (`Multi Step    ${{1 == 1}}`) is a positional value, not `**options`.
- Added `textDocument/hover`, `textDocument/completion` and `textDocument/signatureHelp`, advertised in `initialize` (completion `resolveProvider: false`, no snippets). They share definition's import-aware resolution, so unimported libraries (AShadow.py) never contribute. Hover shows keyword origin, RF-formatted arguments, return annotation and documentation, and variable source plus only statically written values. Completion offers keywords in call cells with their origin and scoped variables after `${`, with UTF-16 edit ranges. Signature help tracks positional, `name=value`, varargs and kwargs arguments. Markdown is used only when the client asks for it; workspace documentation is escaped. New required live suite `test_lsp_features_live.py` (15 cases) runs in the release harness.
- Standard-library and implicit BuiltIn keywords are now indexed from RF's own libdoc (Remote and unimportable libraries excepted), so they resolve for definition, hover, completion and signature help, below custom libraries as in RF.
- Variables now also resolve to imported resources' Variables sections, embedded keyword arguments, `FOR` and `EXCEPT AS` variables; a `VAR` value no longer counts as a definition of the variables it refers to.
- The `lsp` service removes its cwd from `sys.path` at start, and standard-library indexing does so again, so neither RF itself (`robot.py`) nor optional imports (XML's `lxml`, Screenshot's `wx`) can execute a same-named workspace module when the server runs as `python -m`.
- A variable used in a call's arguments resolves to its definition before that call (`${x}=    Set Variable    ${x}`), for definition and hover.
- A Python library whose function header cannot be located becomes an import diagnostic instead of failing every request for the importing file.
- A module-name library's namespace is its full module name (`company.robot.Helpers.Keyword`), not the text before its last dot.
- A position on the empty line after a final line break is accepted instead of failing.
- Standard-library imports (`Library    Collections`, `OperatingSystem`, ...) no longer produce an error diagnostic; as in RF, they win over a sibling file of the same name. Other module-name libraries without a sibling file (`a.b.C` → `a/b/C.py`, open buffer or disk) get an Information diagnostic `Library not resolved in this version: <name>`. Missing `.py`/path imports remain errors.
- LSP error replies carry the plain message instead of the `(code, message)` tuple repr.
- `scripts/build_dists.py` writes no `__pycache__` into the source checkout; the README's direct pip build sets `PYTHONDONTWRITEBYTECODE=1` for the same reason.

## 0.1.0.dev1 — phase-1 vertical slice

- Ran the live LSP, Robot DAP and mixed Robot/debugpy suites against the approved offline runtime (Python 3.13.7, RF 7.5, debugpy 1.8.22, RobotCode absent).
- Fixed the Robot worker: `run_cli` takes no listener instance, so the worker now parses the CLI with RF's public parser and adds its in-process listener before executing.
- Fixed Python child connection loss: a failing final flush of the lost socket no longer aborts cleanup, so `terminated` and the session `end` event are still sent.
- Repinned debugpy to the approved 1.8.22 (was 1.8.17, which the approved wheel set does not contain).
- Replaced the setuptools build with a dependency-free, reproducible in-tree PEP 517 backend and a minimal frontend; the release runner requires pip's rebuild from the sdist to be byte-identical. `doctor` no longer reports build tools as runtime requirements.
- Added bounded stdio framing, an explicit runtime probe and a standalone Python distribution definition.
- Added the LSP for parser/import-based navigation, current document overlays and limited syntax/import/ambiguity diagnostics.
- Added a `dap` service: a stdio DAP lifecycle subset with one owned Robot worker process group, an explicit RF prerequisite error, recorded unverified breakpoints and terminate/disconnect cleanup.
- Added the paused-thread RF listener for breakpoint verification, stack/scopes/variables, continue/next/stepIn and live Robot keyword console calls, with a required real-process DAP suite.
- Fixed private pipe cleanup when a worker fails to spawn; lifecycle checks cover real failed launches and reject unavailable Linux process observation.
- Added Python handoff v1 with an owned debugpy adapter, loopback child DAP connection, same-worker attachment and mixed-session cleanup, with six real-process conformance cases.
- Added an offline standalone build/install and conformance runner with source/hash/count receipts, isolated frontend-free venv execution and bounded owned-process cleanup.
- Copied the synthetic v1 audit corpus and added real-subprocess transport and language conformance drivers.

Exact-SHA release results are recorded in the issue `artifact-handoff`, not here.

# Backend changelog

## Unreleased

- Standard-library imports (`Library    Collections`, `OperatingSystem`, ...) no longer produce an error diagnostic; as in RF, they win over a sibling file of the same name. Their keywords are not indexed (no definitions). Other module-name libraries without a sibling file (`a.b.C` → `a/b/C.py`, open buffer or disk) get an Information diagnostic `Library not resolved in this version: <name>`. Missing `.py`/path imports remain errors.
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

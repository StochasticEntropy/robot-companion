# Backend implementation checkpoint

## Current state

MIS-191 phase 1 was accepted at 305485294f44f1111a4c7705b6ace812160e2145; its
exact-SHA release receipts are in that issue's `artifact-handoff`. `backend/README.md`
is the current capability inventory and command reference.

MIS-310 (follow-up to the MIS-191 acceptance review) builds on that commit. Valid
standard-library imports such as `Library    Collections` no longer produce an error
diagnostic: names in RF's `robot.libraries.STDLIBS` are recognised, as in RF, ahead
of a sibling file, without indexing their keywords. Other module names without a
sibling file (`a.b.C` → `a/b/C.py`, open buffer or disk) get an Information
diagnostic `Library not resolved in this version`. A missing `.py`/path import is
still an error. It also gives LSP error replies their plain message, keeps
`build_dists.py` from writing `__pycache__` into the checkout and corrects the
README diagnostics wording. Exact-SHA checks are in the MIS-310 `author-handoff`.
Scope: `backend/` and this directory only; root npm and extension files unchanged.

MIS-321 (MIS-190 backend continuation) builds on the accepted MIS-310 artifact
04653b04c8cf4c6d037719c408a915158d030493, fast-forwarded into its own worktree. It adds
`textDocument/hover`, `textDocument/completion` and `textDocument/signatureHelp`
(`features.py`), advertised in `initialize` without completion resolve or snippets.
All three use definition's per-request import graph and resolution, so unimported
AShadow.py never contributes. Standard-library keywords (explicit imports and the
implicit BuiltIn) now come from RF 7.5's own libdoc, cached per process; workspace
libraries are still only read through the AST, and Remote is never inspected.
Variable scope gained imported resource variables, embedded keyword arguments and
`FOR`/`EXCEPT AS` variables. Verified with Python 3.13.7, RF 7.5 and debugpy 1.8.22
from `/opt/robot-wheels`, RobotCode absent: the new required live suite
`test_lsp_features_live.py` runs in `verify_release.py` with the existing suites.
Exact-SHA release receipts are in the MIS-321 `artifact-handoff`, not here.
`backend/README.md` is the capability inventory and command reference.

MIS-339 (follow-up to the MIS-321 technical review, MIS-336) builds on the accepted
MIS-321 artifact 5817d32773f38a957d4734cb2d3dfa0e1f5e680a, fast-forwarded into its own
worktree. It fixes four minor edges: no `Returns None` hover line without a return
annotation, hover/definition on typed variable definition cells (`${PORT: int}`),
variable completion keeping an extended-syntax suffix (`${rec|ord.name}`), and
signature help using RF's `split_from_equals` so `=` inside `${{1 == 1}}` is no named
argument. Each has a live case in `test_lsp_features_live.py` (now 15 cases). Settings
keyword cells and BDD prefixes remain out of scope. Exact-SHA release receipts are in
the MIS-339 `artifact-handoff`.

MIS-350 (MIS-190 backend continuation) builds on the accepted MIS-339 artifact
fdc501b6552de472e5d8f92eba1481ee594f6e2a, fast-forwarded into its own worktree. It adds
`textDocument/references`, `textDocument/prepareRename`/`rename`,
`textDocument/documentSymbol` and `workspace/symbol` (`navigation.py`), advertised in
`initialize`. A keyword is identified by its resolved definition location from the
same per-file import graph as definition: references to AuditLibrary.py's `Build
Record` include alias calls and exclude AShadow.py, same-named own keywords and
ambiguous calls. Variables are found and renamed within their scope only, including
`$name` expression uses and `name=` cells passing a keyword argument by name. After
the round-1 technical review (MIS-352), variables nested in `${{ }}`, in variable names
and in item access are found with RF's own variable search, and an inline IF's
assignment is visible only after its branch runs (definition and hover too); a live
case renames each and runs the renamed suite with RF 7.5. Rename of
`.robot`/`.resource` user keywords keeps call prefixes; Python library and
standard-library keywords are refused with `RequestFailed` (Python library rename stays
advisory). The `initialize` workspace folders are rescanned on every request, with no
cache, so `didChange` and on-disk changes reported by `workspace/didChangeWatchedFiles`
are reflected without a restart. Setting keyword cells (`[Setup]`, `Suite Teardown`,
`Test Template`, ...) and one English BDD prefix now resolve for definition and hover
too. Verified with Python 3.13.7, RF 7.5 and debugpy 1.8.22 from `/opt/robot-wheels`,
RobotCode absent: the new required live suite `test_lsp_navigation_live.py` (12 cases)
runs in `verify_release.py` with the seven existing suites. Exact-SHA release receipts
are in the MIS-350 `artifact-handoff`. Not modelled: `Run Keyword` arguments, dynamic
variables, variable files, folders added after `initialize`; no large-workspace timing.

MIS-362 (follow-up to the MIS-350 technical review, MIS-359) builds on the accepted
MIS-350 artifact b56f1bc13f547f4f8147b12549408a1a4463b079, fast-forwarded into its own
worktree. A variable use inside a `FOR`/`WHILE` body (or `WHILE` condition, nested
loops included) whose loop assigns a local of the same name is now also bound to that
local (`Workspace.loop_names`), so references from either definition include it.
Chosen rename behaviour: rename both definitions consistently (closure over
loop-carried links, all uses of each), refusing with `RequestFailed` and no edit only
when a built-in or multi-file suite variable joins. Definition and hover still return
the line-visible definition. A new live case in `test_lsp_navigation_live.py` (now 13)
covers the inline-IF and plain-assignment repro, nested loops and a no-loop control
with exact reference sets and RF 7.5 runs of every renamed suite. Exact-SHA release
receipts are in the MIS-362 `artifact-handoff`.

MIS-364 (MIS-190 backend continuation) builds on the accepted MIS-350 artifact
b56f1bc13f547f4f8147b12549408a1a4463b079, fast-forwarded into its own worktree. It adds
broader diagnostics, quick-fix code actions and formatting (`diagnostics.py`,
`formatting.py`). Diagnostics: RF parsing/model errors (RF's resource/init loaders where
they apply), unknown keywords in the import-aware scope (AShadow.py never counts),
ambiguous calls as warnings naming each source, argument counts checked with RF's dry-run
resolver, and undefined `${variable}` uses in test/keyword bodies as warnings. The rule
throughout is "no diagnostic rather than a false one": open scopes (class/dynamic/
unmodelled libraries, `Import Library`, variable files, variable-setting Python code) turn
a rule off, a variable defined on any line of its test/keyword counts (loops), and any
dynamic setter in the workspace (`Set Test/Suite/Global Variable`, `VAR scope=...`) defines
its name everywhere; README "Diagnostics and quick fixes" lists every rule. Quick fixes
(`quickfix` CodeAction literals, only for clients declaring literal support): import the
single workspace resource/library that defines an unknown keyword, or qualify an
ambiguous call. Formatting uses Robocop 9.1.0's default formatters in-process (optional
`format` extra; advertised only when installed; workspace Robocop config not read), is
idempotent and keeps the audit suite passing under RF 7.5. The release runner installs
the extra and records the formatter. The new required live suite
`test_lsp_diagnostics_live.py` (15 cases) runs with the eight existing suites. Verified
with Python 3.13.7, RF 7.5, debugpy 1.8.22 and Robocop 9.1.0 from `/opt/robot-wheels`,
RobotCode absent; exact-SHA release receipts are in the MIS-364 `artifact-handoff`.
Shared-file note: MIS-362 (loop-carried variable binding) runs from the same base; this
outcome calls `scope_variables` and `variable_uses` but does not change them.

MIS-388 (MIS-190 backend continuation) first merged both accepted heads in its own
worktree: MIS-362 b1b58f09937a19344a00bdac1d6f6a7d4d2a31a1 (loop-carried variable
binding) and MIS-364 48abc76b37d8c8a2135ace99a382ba38eed3d62b (diagnostics, code
actions, formatting). Only this document, the README inventory and the CHANGELOG
conflicted; both behaviours are kept unchanged.

Next backend candidates (each its own bounded outcome): test discovery/results through
the normalized adapter API; debug robustness (conditional/hit-count/log breakpoints,
async pause, exception breakpoints, breakpoint changes after configuration); range
formatting and configurable Robocop rules; static class/dynamic libraries, module search
paths and variable files (they would also narrow the diagnostics' open scopes);
command-line variables and private keywords for diagnostics; `Run Keyword` arguments for
navigation and rename, and Python library keyword rename; keyword completion/signature
help in setting cells; completion item resolve with documentation; and large-workspace
performance numbers.

## Historical record (superseded, MIS-191 before acceptance)

The sections below describe intermediate MIS-191 checkpoints. Statements that a
check is unverified, unavailable or "next author work" are superseded by the
accepted state above and are kept only as history.

Base: 4c4932211df8d9b312e6f3030cb08c1b286514f0.
Scope: backend source/package/tests/docs only; root npm and extension files unchanged.

The supplied `interface-contract`, `audit-evidence`, `delivery-plan` and
`operations-intake` issue documents were read. Baseline interaction audit is the
17 October synthetic audit retained in `audit-evidence`, at the stated base,
with VS Code 1.116.0 / Python 3.13.2 / RF 7.5 / RobotCode 2.7.0.
The current assigned runtime is Python 3.13.7 and has none of robotframework,
debugpy, build, setuptools, wheel or pytest. No dependencies were fetched.
WOL-805 is the already-recorded runtime preparation; no duplicate escalation.

This checkpoint adds standalone packaging inputs, strict transport, LSP source
and a headless real-process driver/corpus. It is not a complete outcome and must
not be routed for final acceptance. DAP lifecycle is implemented and mechanically
checked; RF pause/stack/scopes/variables/stepping/live-console source and a mandatory
real-process suite are now present but unverified. Parser-backed behavior
and build/install are unverified. Backend README carries the precise capability
inventory and runnable commands; raw checks are retained under `/evidence/mis191`.
The issue checkpoint document records the actual commit and command exits.

Mechanical checks initially found a UTF-16 boundary ordering error; it was fixed
and all ten checks passed. The mandatory RF suite fails at its prerequisite
import in this runtime; those failures are infrastructure evidence, not passes
or mocked language acceptance. No browser was started and no UI coverage claimed.

Slice (c) adds experimental versioned debugpy handoff and mixed-session cleanup
source plus six required real two-session conformance cases; live proof is still
unavailable. The backend owns the child stdio adapter and loopback proxy, while
public debugpy.connect attaches the existing Robot worker.

The standalone release harness now exports committed backend-only source, builds
and installs offline in an isolated venv, checks installed import identity and
frontend absence, and runs all required suites with structured command/count/hash
receipts and bounded owned-process cleanup. Eight mechanical harness cases are
separate from unavailable full build/install and live RF/debugpy proof.

Next author work requires the operator-supplied approved local wheel path: execute
backend/scripts/verify_release.py, retain its exact-SHA receipts, then repair any
measured live/packaging failures before final artifact-handoff. The paused Robot
listener uses the existing worker thread and pause-scoped handles; its four-case
`test_dap_live.py` suite fails rather than skips when RF 7.5 is absent. Then execute all RF/debugpy checks and offline build/install in the
approved runtime. Never replace live Robot keyword execution with Python eval
or a new Robot process. Keep the sibling RobotCode integration independent.

Read-only advisory review of checkpoint f7599201f149c00f499851a125c1299c8ca343d9
found a 5,000-digit Content-Length escaping the protocol error path and a short
Python function name matching inside `def`. Both were reproduced as focused
regression inputs and fixed. The reader bounds integer conversion, and source
columns now start after the function header. The subprocess framing check covers
the large numeric header; static AST checks cover short/async/Unicode identifiers.
The client now uses an absolute request deadline, live teardown rejects an early
server exit, and a live case asserts a UTF-16 destination range. The RF-dependent
checks still require the missing approved runtime. These advisory findings do not
constitute a product repair round or a final acceptance review.

Phase-1 completion tranche (18 October): the operator applied WOL-805 (read-only
`/opt/robot-wheels`: RF 7.5, debugpy 1.8.22, RobotCode 2.7.0 and dependencies;
prepared venv `/opt/robot-backend`, which contains RobotCode and is not used for
acceptance). In an owned venv with only RF and debugpy, the live suites first
exposed two defects: the worker passed a listener instance to `run_cli` (rejected
by RF, so no pause occurred), and a lost Python child connection raised
BrokenPipeError while closing buffered socket handles, so `terminated` was never
sent. Both are fixed. The approved set has debugpy 1.8.22 rather than the planned
1.8.17 and no setuptools/wheel/build, so debugpy was repinned and the package now
builds with a dependency-free in-tree PEP 517 backend. The release runner proves
pip's rebuild from the sdist is byte-identical. Exact-SHA command exits, counts and
transcripts are in the issue `artifact-handoff`.

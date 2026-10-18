# MIS-191 implementation checkpoint

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
receipts and bounded owned-process cleanup. Six mechanical harness cases are
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

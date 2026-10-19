# MIS-434 Windows repair evidence

Scope: `backend/` and `agent/documentation/backend/`. Accepted dependencies remain
merged. Baseline: `32e8bef5af9490a8befde2136693e3ca355822b6`. The native Lead stage
and consumed 1-of-2 changes-request count are preserved.

## Baseline and criteria

The issue's `windows-ci-39283871806-raw-logs` document supplies seven original
Windows logs. All seven were decoded and their exact SHA256 hashes verified before
editing. Its full run failed; the earlier bootstrap's 16 passes cannot establish
conformance. The retained backend protocol traces cover these same requirements;
this outcome does not change extension screens or claim a human usability session.
The frontend design brief adds no screen or visual change to this backend-only scope.

- F1 / AC2–3: readiness reports `os.getpid()` over the authenticated worker channel;
  the Python handoff uses that actual interpreter PID. The launch-root process PID
  remains available separately. Live mixed-debug checks still require connected PID
  agreement, real step/evaluate/return, full owned-tree exit and no fallback cleanup.
- F2 / AC3: explicitly close a reaped Windows Popen process handle; assignment
  failure also releases pipes. Keep repeated-attempt handle thresholds, and record
  measured before/after counts. Additional failure-path logic tests require Job,
  process-handle and pipe closure. Full Windows execution decides whether these
  changes resolve the retained leak finding; Linux stand-ins alone cannot prove it.
- F3 / AC3: capture backend PID and creation identity while alive, retain them in
  cleanup transcripts, and refuse an unavailable owned creation-time observation.
- F4 / AC2–3: require the listening descriptor to be closed and require an explicit
  connection refusal within ten seconds (Windows SYN retries can exceed the old
  two-second bound). A timeout still fails; wrong-proof/raw peers remain refused.
- F5 / AC2,4: Unicode fixture explicitly encodes its own output as UTF-8 without
  global UTF-8 mode; preserve native Robot console line endings and deterministic
  platform signal descriptions. Historical Unicode exit-1 cause was inferred;
  no unretained child log is presented as proof.

## Initial affected checks

All commands ran in the registered author worktree with copied synthetic fixtures.
Set `PYTHONDONTWRITEBYTECODE=1`, `PYTHONPATH=backend/src:backend/tests` and
`RCB_TRANSCRIPTS=/evidence/mis434/repair/affected-protocol`.

- Prepared `/opt/robot-backend/bin/python` attempt: exit 1, invalid for conformance
  because RobotCode is present. Retained `affected-linux313.txt`; not a product pass.
- Created owned offline venvs under `/evidence/mis434/repair/scratch`, Python 3.13.7
  and 3.11.17, from `/opt/robot-wheels` and `/opt/robot-wheels-py311` respectively;
  venv creation/install exits 0. No package download or project environment mutation.
- `.../venv313/bin/python -m unittest -v test_process_tree test_release_harness
  test_dap_lifecycle test_dap_live test_dap_conditional_live test_dap_process_live
  test_dap_mixed_live`: exit 0, 60 run, 59 pass, 1 non-required conditional skip.
  Retained `affected-isolated313.txt` and protocol transcripts. Two new resource
  failure-path tests added afterward also pass (2/2, exit 0), retained
  `failure-resource-tests.txt`.
- `git diff --check`: exit 0.

## Source-bound release boundary

The exact final commit and complete Linux/Windows receipts belong in this issue's
`author-handoff`, so this document does not borrow a passing result for a later SHA.
Run `backend/scripts/verify_release.py` once for each Linux row with its approved
wheel directory, then the existing versioned Windows broker with suite `backend`,
Python `3.11`, and equal source/backend SHAs at the clean owned HEAD. Retain the
persisted UUID, bound ZIP hash, all suite counts, actual RF XML outcomes and cleanup
observations under `/evidence/mis434/repair` and in durable issue documents.

Remaining class/dynamic-library limitations and independent extension/RobotCode
workflows are unchanged; Windows backend qualification does not prove extension
Windows UX or authorize publication. Lead acceptance requires fresh independent
technical review at the final clean SHA.

## First repaired Windows run and focused investigation

Source 9b09bd2c8dbd8e55fdcebec3586dcd3c7498bc65, request
8f568e55-1f1e-4583-b8c0-84f8d3c2d2c8, GitHub run 39311948743: Fail.
The ZIP was downloaded and SHA256 verified (f929528eae2181e4541fe706355d868f15dc08aff920ecc15b31b35c93520b8b).
142 bodies: 135 pass, 6 failure records, 4 errors, 1 non-required skip; no required
live skips. F3–F5 pass. F1 now reaches real stepping/PID agreement, but four parent
shutdown/completion cases still hang and need test fallback. Child-loss cases pass.
F2 remains 29/31 extra handles. Both Linux full rows and pinned VS Code checks pass
at that exact source. All are retained in the issue's windows-repair-39311948743
document; the failed Windows receipt is never acceptance.

The next commit is diagnostic fixture instrumentation, not another product repair:
per-attempt handle samples, isolated Windows listener/job/failed-Popen samples in
the test process (never warming the backend), and a test-only native-main wrapper
that dumps thread stacks if a mixed session stalls. Existing assertions and all
mandatory families remain intact. The wrapper's three affected cases pass on the
isolated Linux 3.13 row (exit 0); they do not establish Windows correctness.

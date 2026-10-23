# Windows CI backend qualification and UI bootstrap

This workflow provides a standard GitHub-hosted Windows x64 test substrate, full
backend release evidence for current backend sources, and legacy probes for older
sources. It does not accept or publish a product artifact. MIS-434 and MIS-435
still require their independent native qualification review. In particular, the first UI smoke tests
Companion's rendered documentation source links. It does not claim native
keyword navigation, Robot debugging or mixed Python debugging.

## Dispatch contract

Workflow: `.github/workflows/windows-tests.yml`.

| Input | Value |
| --- | --- |
| `source_sha` | Required, exact lowercase 40-character Companion commit in this repository |
| `backend_sha` | Required, exact lowercase 40-character backend commit; exploratory qualification commits are allowed but never treated as accepted |
| `python_version` | `3.13` (default) or `3.11` |
| `request_id` | Required, canonical lowercase UUID; one request per dispatch |
| `suite` | `backend`, `ui-smoke`, or `both` (default) |

The dispatch run name is `Paperclip Windows CI <request_id>`. The controls are
checked out at `github.workflow_sha`, independently of either product source.
Both source identities are checked before the corresponding process runs.
The initial push trigger is limited to `codex/windows-ci-bootstrap` and these
CI files. On that trigger, Companion source is the push SHA and backend source
is accepted MIS-432 `9cbf7fbf2c81760113bdc08854f9820fd04d4f15`; that backend
commit must already be published to a reachable immutable CI ref. A push run
gets a generated UUID. There is no schedule, pull-request-target trigger or
automatic publication.

Only the literal standard `windows-2022` runner is selected. Private repository
contexts are skipped before allocating a runner, and the broker must reject
unexecuted/skipped runs. There is no paid, larger or self-hosted fallback.
Actions are official, pinned to full commits, with `contents: read` only and
`persist-credentials: false` on every checkout. No Actions caches are used.

## Checks

The backend step invokes the CI-owned runner, outside the product checkout:

```text
python controls/.github/scripts/windows-backend.py --source backend-source --python-version <row> --evidence evidence/backend --expected-source-sha <backend_sha>
```

For a selected source containing `backend/scripts/verify_release.py`, `backend`
(and the backend half of `both`) automatically runs that exact committed harness
unchanged. Its literal suite contract must retain all 13 mandatory baseline suites and all
10 required live families. Additional unique `test_*.py` basenames are allowed;
every declared suite must run and have matching retained counts. This includes
newer 15-suite sources without requiring an infrastructure-only rollout. The
runner first downloads only the version/hash-locked Windows wheels, then invokes:

```text
python backend-source/backend/scripts/verify_release.py --wheels <locked-wheelhouse> --python <requested-row-python> --evidence evidence/backend/full --scratch-root <owned-scratch>
```

The harness checks the clean source, archives/builds the committed backend,
verifies a byte-identical wheel rebuild from the sdist, installs the wheel and
format extra offline, runs doctor, and executes every declared installed-wheel suite.
These cover transport, DAP lifecycle and process trees, release tooling, live LSP
features/navigation/diagnostics, discovery, Robot debugging, conditional and
process debugging, and mixed Robot/Python `debugpy` sessions. It retains structured
counts, command and cleanup receipts, protocol transcripts and worker-interpreter
proof. Failures remain failures and suites are never removed or rewritten. The
harness's existing skip policy is unchanged: required live suites reject skipped
cases; portable suites can report their existing conditional skips, with the
actual counts retained for native review.

The ephemeral runner enables `LongPathsEnabled=1`; the controls independently
observe its registry value and type. Full conformance uses the ordinary Windows
locale: no `PYTHONUTF8`, `PYTHONIOENCODING` or `-X utf8` override is passed. The
whole unchanged harness runs inside an additional CI-owned Windows Job Object.
An exit-zero product harness cannot pass if that independent oracle needs forced
cleanup, times out, cannot observe processes or finds survivors. The full command
has a 25-minute hard limit within the 35-minute job budget; expected runtime is
roughly 5–15 minutes. Only the product's cleanup receipts and independent review
can establish native product acceptance.

For old selected sources without the full harness, the runner retains its
explicitly labelled initial transport/tooling probes. Their historical explicit
UTF-8 mode remains confined to that legacy path. They cannot be mistaken for the
full 13-suite result: `backend/result.json` records the kind, scope and not-run
checks, while full runs add `harness.mode: full`, the harness digest, all declared count
receipts and a hashed required-evidence inventory. A failed product check does
not suppress the UI check. `3.11` requires source implementing that runtime row;
selecting an input cannot waive package metadata or runtime checks.

The UI setup uses locked npm dependencies with lifecycle scripts disabled,
Node 24.19.0 and the official VS Code 1.141.0 Windows x64 archive through
`@vscode/test-electron`. The download helper validates the archive stream
against the official response's length/checksum. It has no latest fallback.
The UI receipt requires the distribution's actual product/package version,
full commit and manifest hashes, plus the real `Code.exe` hash. Both the flat
and commit-prefixed Windows resource layouts are resolved; missing, ambiguous
or mismatched metadata fails instead of silently omitting the runtime identity.
These are hashes of the extracted files, not a claimed archive hash.
The runner creates a fresh workspace/profile/extensions directory, and starts
VS Code with only ordinary Windows runtime variables. GitHub tokens, runner
command-file channels, proxy credentials, Node injection options and Python
source paths are not inherited by the product.

Exactly one Mocha case runs. VS Code APIs arrange the CRLF `.robot` fixture,
open the Companion documentation panel, and inspect results. CDP sends a real
hit-tested pointer click into the editor's `Log` token, verifies DOM editor
focus, and then sends the End key. Bounded real mouse-wheel input brings the
rendered documentation target into its sidebar viewport when necessary,
followed by a trusted pointer click on that hit-tested source sentence.
The point is inside an actual text range/client rectangle, so a wrapped inline
span's bounding-box center cannot select blank space. The proof retains the
source rectangles, frame origins and both parent/local CDP hits; obstruction,
wrong-frame and target-containment checks all remain required.
The click must move the editor from line 6 to the
exact source sentence on line 4. Before/after screenshots and the input log
are retained. Zero tests or any skipped case fails. No direct source-jump
command, fabricated webview, provider result or detached Robot process counts
as the tested click.

The UI wrapper records the Windows session and rendered viewport. Process
ownership follows the unique profile marker and observed descendants, bound
to their process creation times. It waits for normal exit; forced cleanup or
an unavailable/vacuous process check fails the smoke. This is Electron UI
evidence, not proof of Windows native-dialog or SendInput coverage.

The workflow passes its available PowerShell 7 executable as an absolute path
and writes host metadata from that already-running shell. The Node wrapper
never launches legacy Windows PowerShell 5.1. Process snapshots use the
explicit PowerShell 7 runtime, its built-in module paths and an owned analysis
cache, with the original 20-second deadline. Snapshot timings, exits and
bounded errors are recorded without dumping unrelated process command lines.
A snapshot preflight must succeed before VS Code starts. If startup never
reaches VS Code, cleanup is marked not applicable and `executed` stays false;
an empty observation cannot produce a UI pass.

## Receipt and artifacts

One artifact is named `windows-ci-<request_id>`, retained for one day. Its root
`result.json` contains `version: 1`, `request_id`, `source_sha`, `backend_sha`,
`python_version`, `suite`, `scope: windows-ci-bootstrap`, `control_sha`,
`workflow_sha`, `run_id`, `runner_os: Windows`, `runner_arch: X64`,
`runner_label: windows-2022`, `status` and `infrastructureReady`.

`backend` and `ui` record whether each check was requested, its actual step
outcome, and its nested receipt. Missing receipts fail selected checks.
`infrastructureReady` reports successful substrate proof independently of
backend product pass/fail; it does not change `status` or qualify the product.
The root explicitly marks `qualification: false`.

Only JSON receipts, text logs and PNG screenshots are uploaded. Full-harness
text `.stdout` files are retained too; the binary Git `source-archive.stdout`
and built distributions are omitted, with their hashes still recorded. All full
backend JSON/count/command/protocol/text evidence is protected from truncation or
budget pruning. Its immutable inventory is rechecked before upload; missing or
changed proof makes the selected backend fail. Other logs are bounded, and all
omission/truncation is listed. If protected evidence cannot fit the hard artifact
budget, reporting/upload fails rather than presenting a partial pass. The entire uncompressed artifact is
limited to 20 MiB, with one MiB reserved for the root receipt. Checkouts,
venvs, profiles, npm caches and binary distributions are excluded. Upload
happens before the final workflow gate preserves selected failures as a
failed run. A receipt is consumed only after its run/control identity and
requested source/runtime values have been matched by the caller.

Local non-Windows validation can check JavaScript/YAML syntax, the CI control
tests and explicit refusal of non-Windows execution. Those checks are not
Windows product acceptance. The full backend receipts provide evidence for MIS-434; native acceptance remains
a separately tracked review. Full Windows VS Code navigation, live Robot console,
mixed Python debugging, cancellation and UI process-tree qualification remain
the MIS-435 product gates. The existing one-case UI smoke remains independently
selectable and does not claim that broader coverage.

## Required native libraries UI control

The native-libraries selection runs the existing backend full harness, the original documentation UI smoke, and the unchanged candidate-declared native-libraries harness. Its Python row is exactly3.11.9; Node is24.19.0 and VS Code1.141.0 commit2a59476c9bfcb90b3ddc372c36762471b7dfad1c. Test-time npm installation is offline with lifecycle scripts off, using the preceding exact-lockfile cache fill. The approved hash-locked Windows wheels feed the candidate native backend. No RobotCode, grep filter, missing backend, zero/per-file-empty/skipped/failing tests or missing screenshots may pass. All child commands run under the existing independent Windows Job Object oracle; forced cleanup/unknown ownership fails. The native UI artifact inventory is hash-checked and cannot be pruned or truncated to fit the20MiB limit. A full artifact exceeding that bound fails visibly. This is actual platform evidence only after a genuine Windows run and its normal independent native acceptance; portable control tests alone are insufficient.

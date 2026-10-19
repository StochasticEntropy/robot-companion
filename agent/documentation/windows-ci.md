# Windows CI bootstrap

This workflow provides a standard GitHub-hosted Windows x64 test substrate and
initial product probes. It does not accept or publish a product artifact and
does not complete MIS-434 or MIS-435. In particular, the first UI smoke tests
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

Its receipt enumerates the installed-wheel checks actually run and those not
run. A failed product check does not suppress the UI check. `3.11` requires
source that implements that runtime row; selecting an input cannot waive
package metadata or runtime checks.

The UI setup uses locked npm dependencies with lifecycle scripts disabled,
Node 24.19.0 and the official VS Code 1.141.0 Windows x64 archive through
`@vscode/test-electron`. The download helper validates the archive stream
against the official response's length/checksum. It has no latest fallback.
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

Only JSON receipts, text logs and PNG screenshots are uploaded. Logs are
bounded; omission/truncation is listed. The entire uncompressed artifact is
limited to 20 MiB, with one MiB reserved for the root receipt. Checkouts,
venvs, profiles, npm caches and binary distributions are excluded. Upload
happens before the final workflow gate preserves selected failures as a
failed run. A receipt is consumed only after its run/control identity and
requested source/runtime values have been matched by the caller.

Local non-Windows validation can check JavaScript/YAML syntax, the CI control
tests and explicit refusal of non-Windows execution. Those checks are not
Windows product acceptance. Full Windows native navigation, live Robot
console, mixed Python debugging, cancellation and process-tree qualification
remain the separately tracked product gates.

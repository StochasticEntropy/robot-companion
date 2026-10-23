# Bounded full-workspace discovery

The native discovery service and editor opt into discovery batch API v1. A cold
scan of a generated 1,000-suite, 20,000-test workspace exceeded the existing
10-second client deadline while the backend was still parsing normally. A warm
parse cache would not repair that first scan. Discovery therefore yields bounded
pages without excluding suites or changing Robot's parser authority.

`initialize` adds `robotCompanionDiscovery.batch: 1`. An opted-in request is
`robotCompanion/discoverTests` with `workspaceUri`, optional `robotConfiguration`,
`batch: 1`, and a fresh client-generated `scanId`. Subsequent requests add the
opaque `continuation` returned by the preceding page. Each token is single-use
and bound to the exact workspace URI, scan ID and raw configuration. The service
retains only one scan; another full, focused or new batch scan supersedes it.

Each reply retains `version: 1`, `items` and optional `errors`, and adds
`batch: { continuation, scanned, files, suites, tests }`. Counts are cumulative;
`scanned` counts walk checkpoints, `files` candidate suite files, `suites` nonempty
returned suites and `tests` their returned tests. A null continuation ends the
scan. Pages target 200 ms and at most eight suite files; a single filesystem or
Robot parser operation is not interrupted. Idle tokens expire after 120 seconds.
Results retain the existing 64 MiB aggregate limit. Legacy full requests and
focused `documentUri` requests keep their existing format and semantics.

The editor keeps the normal per-request deadline, a five-minute full-scan budget
and a 10,000-page safety bound. It validates every page and commits the complete
tree atomically. It rejects invalid/repeated tokens, inconsistent counts and
foreign source locations. Directory consistency and duplicate suites are checked
across the complete result before replacing Test Explorer items. Progress counts
appear in the Tests provider status and output channel; they are not a partial
Test Explorer tree. Existing generation, trust, settings and interpreter guards
also apply between pages.

`robotCompanion/cancelDiscovery` is a notification with `workspaceUri` and `scanId`.
It closes only that matching scan, including when an ordinary queued request
cancellation never enters dispatch. The editor sends it on abort, supersession
or incomplete failure. An old scan's cancellation cannot close a newer scan.
Parser exceptions, shutdown and service exit also discard continuations. This
does not introduce a scheduler or persistent parse cache; new scans reread disk.

Focused checks are `test_discovery_batches.py`, existing discovery conformance and
`tests/integration/discovery-batches.test.js`. The generated large-project receipt
compares the complete paged result with the legacy result and records every page's
latency. No project library, variable file or test body is executed by discovery.

Discovery requires nonempty, non-whitespace labels without NUL characters. Robot
can produce an empty test name from pipe syntax, escaping or static variable
substitution. The backend reports those tests as source-located discovery errors
and leaves them out of the selectable tree; valid tests and subsequent pages are
retained. The frontend's source/label validation and exact run selectors remain
strict. Focused discovery retains the error and refuses unsafe execution.

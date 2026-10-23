# Foreground language cancellation

`LanguageServer` retains one dispatcher and one workspace. Its input reader only
frames messages, admits bounded work and marks cancellation; it never dispatches,
changes an overlay or writes stdout. The interruptible raw pipe reader avoids
leaving a daemon inside Python's buffered stdin lock at interpreter shutdown.

Cancellation of a queued request replaces its payload with a small error reply
and releases request admission. Cancellation of active read-only work sets that
request's event. `cancellation.request` installs it only on the dispatch thread;
source reads, source analyses, Robot AST walks, module probes and symbol matching
check it. The snapshot's existing `finally` clears request-local state on exit.
Active initialize and shutdown finish their state transitions without interruption.
If still queued, they can be cancelled before their transition starts. Request-form
`$/` methods receive MethodNotFound; cancellation is a notification.

Overload never blocks input waiting for a dispatcher slot: that would hide later
cancellations. There are at most 64 admitted requests, including the active one.
Rejected requests retain only their ID and busy reply. All queued items, including
notifications and these replies, remain bounded to 256 messages and 16 MiB.
Exhaustion or an input exception is a protocol failure and cancels active work;
document changes are never silently dropped. Output remains on the dispatcher.

This is cooperative cancellation, not concurrent analysis or a persistent graph
cache. A parser, filesystem call or regex already in progress must return before
its next checkpoint. Intake failure and close stop the owned reader. Actual
Windows editor qualification remains separate from framed/component regressions.
The separate discovery service inherits this lifecycle through `DiscoveryServer`.
Its Robot AST walks observe the request context too; its directory inventory and
single RF parse operations are not preempted by these checkpoints.

Inlay hints additionally avoid resolving off-range statements. A continuation
statement is retained when any of its tokens is on a requested line, and the
existing final UTF-16 position filter still determines the returned hints.

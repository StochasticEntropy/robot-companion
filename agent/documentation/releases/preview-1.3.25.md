# Robot Companion 1.3.25 editor workflow preview

The local preview pairs suite actions in VS Code, connects editor-run results to
existing Testing entries, opens keyword search during loading, and rechecks exact
Return Explorer locations. Backend 0.1.0.dev21 adds source-linked Robot stop
context and ordinary Robot INFO messages to Debug Console.

Independent UX review accepted the editor entry points, warm Testing identity,
keyword search and link handling. Six focused VS Code checks passed during the
editor work, including actual Run and Debug menu clicks, a paused breakpoint,
keyword search and Return Explorer links. This editor evidence predates the
dev21 console additions.

A separate independent native DAP run on macOS with Robot Framework 7.5 verified
the linked INFO and stop rows, source locations, active and caller scopes, console
evaluation and successful Continue. The listener regression passed against both
Robot Framework versions. The cross-version listener probe used Python 3.13.
The final checkout passed 90 focused integration and 7 bundle/environment checks.
Three broader macOS process tests failed on the unchanged baseline too.

The hidden VS Code process did not load the synthetic workspace. The final
console changes have protocol and listener evidence, with visual editor and
Windows validation pending. The local VSIX passed archive and source-byte checks.
Its SHA-256 is a48a476707890214df7b81fda757a8463c8c62e15e832758fec7066a065e2167.

# Robot Companion 1.3.3 alpha integration

This alpha preview retains the stable release channel. Available integrated runtime/editor
checks do not establish full Windows VS Code interaction qualification. A known reproducible
failure is still repaired before publishing.

Baseline: published 1.3.2, 98f17c630150e8c129c756d734757cd9c1452e54.

Accepted input commits are preserved as merge parents: MIS-476 0aa14cf,
MIS-477 9915cd6, MIS-670/693 95d6254, MIS-478/713 92687bc,
MIS-500 42b9d9a, MIS-479/730 e1c6042, MIS-480 2fa4dd2,
MIS-481 9881c26, MIS-489 b3ea61f, MIS-484 8ab0a90,
MIS-488/694/707/718 231ad72 and MIS-690 ef986e5.
MIS-713's later accepted gate decision supersedes its older rejected review document.

Integration retains the previously published Windows process-identity, deterministic
handle release and cancelable socket I/O repairs. It combines debugger lifecycle and
breakpoint generations separately, uses one stoppable worker control reader for live
controls and failure filters, preserves old-run handle invalidation and registers all
accepted UI suites and required backend suites. Selected-environment lifecycle stays
shared with native Robot configuration and import-aware library indexing.

Backend version is 0.1.0.dev3. Rebuild bundled-backend from the final source after any
backend change. Installed byte digests, exact wheel identity and VSIX contents are release
gates. Read back public GitHub and Marketplace assets before claiming publication.

Unaccepted features excluded: MIS-486, MIS-487, MIS-490. Overall parity MIS-493 and
the managed Windows CI broker scope MIS-601 remain open. Full Windows editor
interaction for this combined preview remains unverified. Do not reset review counters or
borrow individual branch results as merged-source qualification.

Actual failed attempts and final source-bound results belong to the release validation
assets. The first combined integration run exposed a workspace-host manifest conflict,
a missing ast import in merged branch-sensitive diagnostics, and stale version expectations;
these were corrected without skipping the tests.

# Audit corpus v1

Copied verbatim from MIS-192 `audit-evidence`, revision
`9dfecd92-c389-47bf-88e8-844cd9277366`. Synthetic data only.

Expected definitions (one-based lines): `Build Record` → AuditLibrary.py:12;
`Resource Step` → shared.resource:2; `Local Step` → audit.robot:18.
AShadow.py is deliberately not imported and must never resolve as Build Record.

Debug transcript: Robot breakpoint audit.robot:12; evaluate
`Catenate    SEPARATOR=-    ${SUITE_VALUE}    console` → `'from-suite-console'`;
Python breakpoint AuditLibrary.py:18, step to :19, evaluate `count` → `3`;
Robot breakpoint audit.robot:13, select Robot frame/session, evaluate
`Resource Step    ${record.name}` → logs `Ada`, returns None; finish → 1 PASS.

`alias.robot` (added for MIS-192) imports AuditLibrary.py `AS Audit`;
`Audit.Build Record` → AuditLibrary.py:12.

This copy is input for future live acceptance, not evidence of an integration
pass. Additional alias/ambiguity/embedded/change/scoped-variable/UTF-16/cancel
cases remain to be added with their expected outcomes.

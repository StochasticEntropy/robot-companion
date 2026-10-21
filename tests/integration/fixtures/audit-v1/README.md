# Audit corpus v1

Synthetic fixtures for import-aware navigation and mixed Robot/Python debugging.

Expected definitions (one-based lines): `Build Record` → AuditLibrary.py:12;
`Resource Step` → shared.resource:2; `Local Step` → audit.robot:18.
AShadow.py is deliberately not imported and must never resolve as Build Record.

Debug transcript: Robot breakpoint audit.robot:12; evaluate
`Catenate    SEPARATOR=-    ${SUITE_VALUE}    console` → `'from-suite-console'`;
Python breakpoint AuditLibrary.py:18, step to :19, evaluate `count` → `3`;
Robot breakpoint audit.robot:13, select Robot frame/session, evaluate
`Resource Step    ${record.name}` → logs `Ada`, returns None; finish → 1 PASS.

`alias.robot` imports AuditLibrary.py `AS Audit`;
`Audit.Build Record` → AuditLibrary.py:12.

*** Settings ***
Library    AuditLibrary.py    AS    Audit

*** Test Cases ***
Alias Smoke
    ${record}=    Audit.Build Record    name=Ada
    Log    ${record.name}

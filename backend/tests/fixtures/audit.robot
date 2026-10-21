*** Settings ***
Library    AuditLibrary.py
Resource    shared.resource

*** Variables ***
${SUITE_VALUE}    from-suite

*** Test Cases ***
Debug Smoke
    [Documentation]    Robot Companion replacement audit: navigation and debugging.
    #> Build a typed record and inspect it in the debugger.
    ${record}=    Build Record    name=Ada
    Resource Step    ${record.name}
    Local Step
    Log    ${record.name}

*** Keywords ***
Local Step
    [Documentation]    A local keyword used to verify native definition navigation.
    Log    local-step

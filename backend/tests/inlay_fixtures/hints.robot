*** Settings ***
Library    AuditLibrary.py    AS    Audit
Library    CombineLibrary.py
Library    TwinA.py
Library    TwinB.py
Resource    shared.resource
Suite Setup    Log    suite-start

*** Variables ***
${GRÜẞE}    Grüße 😀
@{LIST}    a    b
&{MAP}    second=b

*** Test Cases ***
Imported Alias
    ${record}=    Audit.Build Record    Ada
    ${named}=    Audit.Build Record    name=Ada
    ${unqualified}    Build Record    Ada
    ${typed: str}=    Audit.Build Record    Ada
    ${first}    ${second}=    Audit.Build Record    Ada
    Audit.Build Record    Ada

Ambiguous And Shadow
    Twin Step    one
    TwinA.Twin Step    one
    TwinB.Twin Step    one
    Shadowed Step    one
    Unknown Step    one
    Greet Ada Kindly

Variables
    Resource Step    ${GRÜẞE}
    ${joined}=    Combine    head    ${LIST}[0]    tail    more
    Combine    @{LIST}    tail
    Combine    head    &{MAP}
    Combine    head    second=${GRÜẞE}    tail
    Combine    left\=escaped
    Log Many    a    b

Unicode 😀 Positions
    Combine    Äöü 😀    𝔘 ${GRÜẞE}
    Combine
    ...    😀 first
    ...    𝔘 second

*** Keywords ***
Shadowed Step
    [Arguments]    ${local}
    Log    ${local}

Greet ${name} Kindly
    Log    ${name}

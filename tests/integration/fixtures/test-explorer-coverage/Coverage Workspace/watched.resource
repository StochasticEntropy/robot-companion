*** Variables ***
${WAIT}    0.1s

*** Keywords ***
Check Value
    [Arguments]    ${value}
    Should Be Equal As Integers    ${value}    1

Wait A Moment
    Sleep    ${WAIT}

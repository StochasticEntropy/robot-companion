*** Settings ***
Documentation    Synthetic regular-step loop for Pause: short Robot keywords, about 120 s at most.

*** Test Cases ***
Regular Loop
    Log To Console    controls-loop-ready
    FOR    ${index}    IN RANGE    2400
        Tick    ${index}
    END

*** Keywords ***
Tick
    [Arguments]    ${index}
    Set Test Variable    ${TICK}    ${index}
    Sleep    0.05s

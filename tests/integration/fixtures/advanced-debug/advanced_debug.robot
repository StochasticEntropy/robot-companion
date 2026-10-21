*** Settings ***
Documentation     Synthetic suite for native advanced debugging: hit counts, value edits and Robot failure stops.
Library           DebugValues.py

*** Variables ***
${counter}        suite
${message}        before

*** Test Cases ***
Edit And Count
    VAR    ${counter}    test
    FOR    ${i}    IN RANGE    1    4
        Local Check    ${i}
    END
    Log    ${message}
    Should Be Equal    ${message}    after
    ${holder}=    Make Holder
    ${total}=    Python Count    ${message}
    Should Be Equal    ${total}    ${9}

Handled Robot Failure
    TRY
        Fail    synthetic handled failure
    EXCEPT    synthetic handled failure
        Log    handled
    END

Propagated Robot Failure
    Fail    synthetic failure

*** Keywords ***
Local Check
    [Arguments]    ${n}
    Log    check-${n}

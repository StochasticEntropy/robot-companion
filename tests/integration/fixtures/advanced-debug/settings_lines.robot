*** Settings ***
Documentation     Synthetic passing suite: breakpoints on setup and teardown lines, an empty Hit Count.
Suite Setup       Log    settings-setup
Suite Teardown    Log    settings-teardown
Library           DebugValues.py

*** Test Cases ***
Passing Mixed Run
    FOR    ${i}    IN RANGE    1    3
        Log    loop-${i}
    END
    ${total}=    Python Count    abc
    Should Be Equal    ${total}    ${3}

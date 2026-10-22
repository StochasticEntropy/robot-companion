*** Settings ***
Documentation     Synthetic coverage workspace: Python keyword libraries whose lines
...               Robot Companion's coverage listener measures per test.
Library           Process
Library           libraries/OrderLibrary.py
Suite Setup       Open Store

*** Test Cases ***
Small Order Has No Discount
    [Tags]    smoke
    ${total}=    Order Total    2
    Should Be Equal As Integers    ${total}    20

Large Order Has A Discount
    ${total}=    Order Total    200
    Should Be Equal As Integers    ${total}    1600

Background Worker Answers
    ${answer}=    Run In Background
    Should Be Equal As Integers    ${answer}    42

Separate Process Is Not Measured
    ${python}=    Evaluate    sys.executable    modules=sys
    ${result}=    Run Process    ${python}    ${CURDIR}/scripts/worker.py
    Should Be Equal    ${result.stdout}    worker ran

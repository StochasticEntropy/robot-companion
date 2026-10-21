*** Settings ***
Library    projectlib

*** Variables ***
${ENV}    local

*** Test Cases ***
Check ${ENV} on ${TARGET}
    ${result}=    Project Step
    Should Be Equal    ${result}    configured
    Log    ${TARGET}

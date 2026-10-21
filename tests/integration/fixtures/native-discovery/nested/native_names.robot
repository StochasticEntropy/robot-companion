*** Settings ***
Documentation    Synthetic tests for native Test Explorer discovery and runs.
Library    OperatingSystem

*** Variables ***
${ENVIRONMENT}    staging

*** Test Cases ***
Grüße aus Köln 🎉 und 𝄞
    Log    Ümlaut 🎉 und 𝄞

Duplicate Name
    Log    first-occurrence

Duplicate Name
    Fail    second occurrence fails

Needs Ready Flag
    File Should Exist    ${CURDIR}/native.ready

Login On ${ENVIRONMENT}
    Log    ${ENVIRONMENT}

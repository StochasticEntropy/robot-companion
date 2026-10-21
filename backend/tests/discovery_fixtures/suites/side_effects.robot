*** Settings ***
Library    OperatingSystem
Library    SideEffectLibrary.py
Variables    side_variables.py
Suite Setup    Create File    ${CURDIR}/suite-setup.marker    ran

*** Test Cases ***
Library Code Is Not Executed
    Side Effect Keyword
    Create File    ${CURDIR}/test-body.marker    ran

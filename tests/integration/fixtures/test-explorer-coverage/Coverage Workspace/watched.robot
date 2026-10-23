*** Settings ***
Documentation     Continuous run fixture: saving this file or watched.resource runs these tests again.
Resource          watched.resource

*** Test Cases ***
Watched Passes
    Check Value    1

Watched Waits
    Wait A Moment

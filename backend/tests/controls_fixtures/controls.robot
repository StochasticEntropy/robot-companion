*** Settings ***
Documentation    Synthetic Step Out fixtures for the native debug adapter controls.
Resource    controls.resource

*** Test Cases ***
Nested Step Out
    ${result}=    Outer    start
    IF    $result == 'never'    Log    not-run-branch
    Log    after-outer ${result}
    Log    nested-done

Recursive Step Out
    Recurse    2
    Log    after-recursion

Wrapped Step Out
    Run Keyword    Inner    wrapped
    Log    after-wrapped

Early Return Step Out
    ${value}=    Early    yes
    Log    after-early ${value}

Last Step Out
    Inner    last

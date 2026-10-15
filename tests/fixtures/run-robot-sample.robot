*** Settings ***
Documentation    Synthetic suite for the Run Test / Run Suite UI tests.

*** Test Cases ***
Passing Test
    Log    passes

Failing Test
    Fail    fails on purpose

Sum * Check
    Log    glob characters in the name

Sum Total Check
    Log    would match the unescaped pattern above

Slow Test
    Log    the fake runner waits before it finishes

Invalid Test
    Log    the fake runner rejects this selection

*** Keywords ***
Helper Keyword
    Log    not a test

*** Settings ***
Documentation    Synthetic Test Explorer suite: a passing test and a test
...              that waits in a child process until the run is stopped.
Library    WaitLibrary.py

*** Test Cases ***
Billing Passes
    Log    billing-ok

Billing Waits For Stop
    Wait In Child Process    300

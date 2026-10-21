*** Settings ***
Documentation    Synthetic blocking library call: Pause waits for the next Robot keyword.
Library    Blocking.py

*** Test Cases ***
Blocking Call
    Log To Console    controls-blocking-ready
    Wait For Release    release.flag
    Log    after-release
    Log    blocking-done

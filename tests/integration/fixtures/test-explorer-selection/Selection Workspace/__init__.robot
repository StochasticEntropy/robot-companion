*** Settings ***
Documentation    Root init: its setup and tags apply to every selected test.
Suite Setup      Append To Marker    root-setup
Test Tags        workspace
Library          OperatingSystem

*** Keywords ***
Append To Marker
    [Arguments]    ${text}
    Append To File    ${OUTPUT_DIR}${/}markers.txt    ${text}\n

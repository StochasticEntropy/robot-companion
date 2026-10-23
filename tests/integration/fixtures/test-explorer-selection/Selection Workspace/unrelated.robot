*** Settings ***
Library    OperatingSystem

*** Test Cases ***
Unrelated Must Not Run
    [Tags]    smoke
    Append To File    ${OUTPUT_DIR}${/}markers.txt    unrelated-ran\n

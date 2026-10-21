*** Settings ***
Name             API Suites
Suite Setup      Append To File    ${OUTPUT_DIR}${/}markers.txt    api-setup\n
Test Tags        api
Library          OperatingSystem

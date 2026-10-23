*** Settings ***
Library    OperatingSystem
Library    Process

*** Test Cases ***
Starts A Worker And Waits
    [Tags]    worker
    ${python}=    Evaluate    sys.executable    modules=sys
    ${worker}=    Start Process    ${python}    -c    import time; time.sleep(300)
    ${pid}=    Get Process Id    ${worker}
    ${pid}=    Convert To String    ${pid}
    Create File    ${OUTPUT_DIR}${/}worker.pid    ${pid}
    Sleep    300s

Never Reached
    [Tags]    worker
    Log    after the long test

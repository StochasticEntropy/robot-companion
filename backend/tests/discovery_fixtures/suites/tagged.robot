*** Variables ***
${KIND}    exclude

*** Test Cases ***
Kept Test
    [Tags]    smoke
    No Operation

Excluded By Tag
    [Tags]    robot:exclude
    No Operation

Excluded By Variable Tag
    [Tags]    robot:${KIND}
    No Operation

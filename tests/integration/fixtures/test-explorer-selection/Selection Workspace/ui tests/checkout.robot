*** Test Cases ***
Checkout Passes
    [Tags]    smoke    ui
    Log    paid

Checkout Fails
    [Tags]    ui
    Fail    Card declined

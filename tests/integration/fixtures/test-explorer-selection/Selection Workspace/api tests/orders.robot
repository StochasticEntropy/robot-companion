*** Settings ***
Default Tags     needs-review

*** Test Cases ***
Create Order
    [Tags]    smoke
    Log    created

Cancel Order
    [Tags]    slow    -api
    Log    cancelled

Create Order
    [Tags]    smoke    duplicate
    Log    second create

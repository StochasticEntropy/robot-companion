*** Settings ***
Resource    Demo/Keywords.resource

*** Test Cases ***
T001 Order Confirmation Document Validation
    [Documentation]
    ...    ## Scenario
    ...    - A generated order confirmation is checked after the basket setup finished.
    ...    - The business context stays visible while later inline checks explain the technical trail.
    ...      -> The preview must still jump to the correct later inline notes.
    ...      -> The mixed documentation style should remain readable in one block.
    ...    ## Reference values
    ...    - Ordered on: 2024-03-10
    ...    - Shipped on: 2024-05-01
    ...    - Status: ACTIVE
    [Tags]
    ...    Demo    Preview    MixedDocumentation

    ${orderedOn}=    Set Variable    2024-03-10
    ${shippedOn}=    Set Variable    2024-05-01
    ${status}=    Set Variable    ACTIVE

    #> ## Flow
    #> ### Build baseline state
    #> - The initial basket is created so later validation works on an active order.
    Demo Create Basket    orderedOn=${orderedOn}
    ...    shippedOn=${shippedOn}

    #> - The confirmation document is generated for the active order.
    ${document}=    Demo Read Confirmation
    ...    orderedOn=${orderedOn}
    ...    shippedOn=${shippedOn}

    #>> -> The generated document is available for downstream validation.
    Demo Validate Document State
    ...    document=${document}
    ...    expectedStatus=${status}

    #>> -> The generated document metadata stays aligned with the source order.
    Demo Validate Document Metadata
    ...    document=${document}
    ...    orderedOn=${orderedOn}

    #> ### Compare visible output
    #> - The UI summary shows the same active state as the backend result.
    Demo Open UI Summary
    ...    document=${document}

    #>> -> The summary banner shows the expected active order state.
    Demo Validate Summary Banner
    ...    expectedStatus=${status}

    #>> -> The summary detail panel exposes the shipping date and the order date.
    Demo Validate Summary Detail
    ...    orderedOn=${orderedOn}
    ...    shippedOn=${shippedOn}

    #> ### Confirm audit trail
    #> - The final audit entry references the processed document.
    Demo Validate Audit Trail
    ...    document=${document}

    #>> -> The audit entry stores the same identifiers as the generated document.
    Demo Validate Audit Identifiers
    ...    document=${document}

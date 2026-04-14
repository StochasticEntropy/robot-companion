*** Settings ***
Resource    Demo/Keywords.resource

*** Test Cases ***
T001 Synthetic Attachment Validation
    [Documentation]
    ...    ## Scenario
    ...    - A generated attachment is checked after the baseline setup finished.
    ...    - The business context stays visible while later inline checks explain the technical trail.
    ...      -> The preview must still jump to the correct later inline notes.
    ...      -> The mixed documentation style should remain readable in one block.
    ...    ## Reference values
    ...    - Request date: 10.03.2024
    ...    - Effective date: 01.05.2024
    ...    - Status: ACTIVE
    [Tags]
    ...    Demo    Preview    MixedDocumentation

    ${requestDate}=    Set Variable    10.03.2024
    ${effectiveDate}=    Set Variable    01.05.2024
    ${status}=    Set Variable    ACTIVE

    #> ## Flow
    #> ### Build baseline state
    #> - The initial dataset is created so later validation works on an active record.
    Demo Create Baseline    requestDate=${requestDate}
    ...    effectiveDate=${effectiveDate}

    #> - The attachment source is generated for the active record.
    ${attachment}=    Demo Read Attachment
    ...    requestDate=${requestDate}
    ...    effectiveDate=${effectiveDate}

    #>> -> The generated attachment is available for downstream validation.
    Demo Validate Attachment State
    ...    attachment=${attachment}
    ...    expectedStatus=${status}

    #>> -> The generated attachment metadata stays aligned with the source record.
    Demo Validate Attachment Metadata
    ...    attachment=${attachment}
    ...    requestDate=${requestDate}

    #> ### Compare visible output
    #> - The UI summary shows the same active state as the backend result.
    Demo Open UI Summary
    ...    attachment=${attachment}

    #>> -> The summary banner shows the expected active lifecycle.
    Demo Validate Summary Banner
    ...    expectedStatus=${status}

    #>> -> The summary detail panel exposes the effective date and request date.
    Demo Validate Summary Detail
    ...    requestDate=${requestDate}
    ...    effectiveDate=${effectiveDate}

    #> ### Confirm audit trail
    #> - The final audit entry references the processed attachment.
    Demo Validate Audit Trail
    ...    attachment=${attachment}

    #>> -> The audit entry stores the same identifiers as the generated attachment.
    Demo Validate Audit Identifiers
    ...    attachment=${attachment}

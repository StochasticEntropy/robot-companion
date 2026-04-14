*** Settings ***
Resource    Demo/Keywords.resource

*** Test Cases ***
T001 Synthetic Garnishment Calculation
    [Documentation]
    ...    ## Scenario
    ...    - 1.499,99 EUR income with 0 dependents and prior amount 0,00 EUR results in 0,00 EUR.
    ...    - Base amount = max(0,00 EUR, synthetic calculation formula) + max(0 EUR, synthetic delta) = 0,00 EUR
    ...      -> seizable amount = 0,00 EUR - prior amount = 0,00 EUR
    ...      -> protected amount = 1.499,99 EUR - 0,00 EUR = 1.499,99 EUR
    [Tags]
    ...    Demo    Garnishment    Preview

    ${requestDate}=    Set Variable    10.03.2024
    ${effectiveDate}=    Set Variable    01.05.2024
    ${seizableAmount}=    Set Variable    0,00
    ${protectedAmount}=    Set Variable    1499,99

    #> ## Flow
    #> ### Build baseline scenario
    #> - Create the baseline benefit so the calculation runs on an active case.
    Demo Create Baseline
    ...    requestDate=${requestDate}
    ...    effectiveDate=${effectiveDate}

    #> - Link the benefit and store the expected status for the search response.
    Demo Link Benefit
    ...    protectedAmount=${protectedAmount}

    #>> -> The schedule row is created even when the income stays below the limit.
    Demo Validate Schedule Row
    ...    requestDate=${requestDate}

    #>> -> The search response returns the manually stored seizable and protected amounts.
    Demo Validate Search Response
    ...    seizableAmount=${seizableAmount}
    ...    protectedAmount=${protectedAmount}

    #> - Calculate the seizable amount for the snapshot date.
    Demo Calculate Amounts
    ...    effectiveDate=${effectiveDate}

    #>> -> The calculation returns the expected seizable and protected amounts.
    Demo Validate Calculated Amounts
    ...    seizableAmount=${seizableAmount}
    ...    protectedAmount=${protectedAmount}

    #>> -> The refreshed values are visible in the search response.
    Demo Validate Refreshed Search
    ...    effectiveDate=${effectiveDate}

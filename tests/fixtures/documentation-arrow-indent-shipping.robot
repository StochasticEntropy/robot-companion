*** Settings ***
Resource    Demo/Keywords.resource

*** Test Cases ***
T001 Voucher Discount Applies To Basket Total
    [Documentation]
    ...    ## Scenario
    ...    - A 120.00 EUR basket with voucher SAVE10 and no prior discount.
    ...    - Discount = 10% of the basket total, capped at the voucher maximum = 12.00 EUR
    ...      -> discounted amount = 12.00 EUR - 0.00 EUR prior discount = 12.00 EUR
    ...      -> payable amount = 120.00 EUR - 12.00 EUR = 108.00 EUR
    [Tags]
    ...    Demo    Vouchers    Preview

    ${orderedOn}=    Set Variable    2026-03-12
    ${voucherCode}=    Set Variable    SAVE10
    ${discountedAmount}=    Set Variable    12.00
    ${payableAmount}=    Set Variable    108.00

    #> ## Flow
    #> ### Build the basket
    #> - Create the basket so the discount runs against real line items.
    Demo Create Basket
    ...    orderedOn=${orderedOn}
    ...    voucherCode=${voucherCode}

    #> - Apply the voucher and store the expected payable total.
    Demo Apply Voucher
    ...    payableAmount=${payableAmount}

    #>> -> The voucher row is created even when the basket stays below the free-shipping limit.
    Demo Validate Voucher Row
    ...    orderedOn=${orderedOn}

    #>> -> The basket response returns the stored discounted and payable amounts.
    Demo Validate Basket Response
    ...    discountedAmount=${discountedAmount}
    ...    payableAmount=${payableAmount}

    #> - Recalculate the discount after the basket is repriced.
    Demo Calculate Amounts
    ...    voucherCode=${voucherCode}

    #>> -> The calculation returns the expected discounted and payable amounts.
    Demo Validate Calculated Amounts
    ...    discountedAmount=${discountedAmount}
    ...    payableAmount=${payableAmount}

    #>> -> The refreshed values are visible in the basket response.
    Demo Validate Refreshed Basket
    ...    voucherCode=${voucherCode}

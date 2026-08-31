*** Settings ***
Resource            Shop/Core.resource
Resource            Shop/Admin.resource
Resource            Shop/Api.resource

Test Setup          Shop Setup    Core    Admin
Test Teardown       Shop Teardown    Core    Admin

Test Tags
...    Integration   ShopCore    ShopAdmin


*** Test Cases ***
T001 Partial Refund For A Returned Order
    # [Documentation]
    # ...    # E001 Partial refund for a returned order in the admin UI
    # ...
    # ...    ## Goal
    # ...
    # ...    Show that a delivered order with returned items can be refunded from the admin UI,
    # ...    that the refundable total is prefilled, that the refund is stored, and that the
    # ...    amount checks still apply for the remaining balance.
    # ...
    # ...    ## Flow
    # ...
    # ...    ### Seed a delivered order
    # ...
    # ...    - A sample order of 280.00 USD is placed through the API and marked as delivered.
    # ...    - The payment provider is synced so the captured payment is visible.
    # ...      -> The admin UI shows the order as delivered.
    # ...
    # ...    ### Return two items and refund most of their value
    # ...
    # ...    - Two items worth 78.00 and 36.00 USD are returned, so 114.00 USD is refundable.
    # ...    - The refund dialog is opened from the order detail view.
    # ...    - A reason is picked and the amount is set to 113.00 USD.
    # ...    - Saving confirms that the refund was queued with the provider.
    # ...    - The payment provider is synced again.
    # ...      -> The dialog shows the reason list and the prefilled refundable total.
    # ...      -> The refund is sent to the provider and recorded on the order.
    # ...
    # ...    ### Check the stored refund
    # ...
    # ...      -> The refund row is stored with the expected amount and reason.
    # ...      -> The payment entry shows the matching provider reference.
    # ...      -> Reloading the admin UI leaves 1.00 USD refundable.
    # ...
    # ...    ### Check the amount validation
    # ...
    # ...    - The last refundable dollar is refunded as well.
    # ...    - An amount above the remaining total is rejected.
    # ...    - The provider is synced and the order is reloaded.
    # ...      -> The UI refuses an amount larger than what is still refundable.
    # ...      -> The UI checks the lower bound too.
    # ...      -> The order ends with nothing left to refund.
    [Tags]
    ...    shop     refund     returns     payments     adminDialog     delivered     order
    ...    DEMO-1001

    ${orderType}=                                  Set Variable  STANDARD
    ${articleCode}=                               Set Variable  DEMO_ARTICLE
    ${bundleCode}=                                Set Variable  BUNDLE_ALPHA
    ${customerCode}=                              Set Variable  55598765
    ${externalRef}=                               Set Variable  66332211

    ${placedOn}=                                  Set Variable  2026-02-11
    ${deliveredOn}=                               Set Variable  2026-02-19
    ${returnRequestedOn}=                         Set Variable  2026-03-12

    ${refundQueuedOn}=                            Set Variable  2026-03-17
    ${refundSettledOn}=                           Set Variable  2026-03-24
    ${statementOn}=                               Set Variable  2026-04-08

    #> ## Flow
    #> ### Seed a delivered order
    #> - Turn off the admin mock switch so the seeded order is visible
    Shop Mock Control     adminUi=${False}

    ${customer}=    Shop Create Sample Customer

    ${order}=    Shop Place Sample Order
    ...    customerId=${customer.customerId}
    ...    customerCode=${customerCode}
    ...    placedOn=${placedOn}
    ...    orderType=${orderType}
    ...    articleCode=${articleCode}

    Shop Set Clock    ${deliveredOn}

    #> - Ship the order and capture the payment
    ${shipment}=   Shop Ship Order With Options Via Api
    ...    customerId=${customer.customerId}
    ...    orderId=${order.OrderId}
    ...    shipmentId=${order.ShipmentId}
    ...    deliveredOn=${deliveredOn}
    ...    carrier=DEMO_CARRIER
    ...    articleCode=${articleCode}
    ...    orderType=${orderType}
    ...    itemsTotal=220.00
    ...    giftWrapTotal=18.50
    ...    shippingTotal=41.50
    ...    orderTotal=280.00
    ...    shippingMethod=EXPRESS
    ...    packagingType=Box
    ...    bundleCode=${bundleCode}
    ...    channelType=WEB_SHOP
    ...    warehouseCode=WH2

    Shop Sync Payment Provider For Shipment
    ...    sampleCustomer=${customer}
    ...    shipment=${shipment}
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}
    ...    deliveredOn=${deliveredOn}
    ...    customerCode=${customerCode}
    ...    externalRef=${externalRef}
    ...    pickQueue=1
    ...    packMarker=2
    ...    multiSource=2
    ...    retryLimit=1
    ...    pageSize=25
    ...    batchSize=50
    ...    updateMarker=${True}
    ...    postToLedger=${True}
    ...    notifyCustomer=${False}

    ${orderNumber}=  Shop Lookup Order Number
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}
    ${orderRowId}=  Shop Lookup Order Row Id
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}

    #> - The customer returns two items worth 78.00 and 36.00 USD
    Shop Open Return Case    ${returnRequestedOn}
    ...    customerId=${customer.customerId}

    Shop Register Returned Items
    ...    customerId=${customer.customerId}
    ...    itemOne=78.00
    ...    itemTwo=36.00

    ${returnResult}=  Shop Accept Return Via Api
    ...    customerId=${customer.customerId}
    ...    shipmentId=${order.ShipmentId}
    ...    returnReason=CUSTOMER_RETURN
    ...    receivedOn=${refundQueuedOn}

    Shop Sync Payment Provider
    ...    afterResult=${returnResult}

    Shop Advance Clock
    ...    days=7

    Shop Sync Payment Provider
    ...    notifyUi=${False}

    #> ### Open the order in the admin UI and refund the returned value
    #> - The order is searched in the UI and opened in the detail view.
    Shop UI Start
    Shop UI Search Orders    customerId=${customer.customerId}

    #>> -> The UI shows the delivered order with a refundable total.
    Shop UI Navigate To Detail
    Shop UI Verify Detail Row
    ...    orderId=${order.OrderId}
    ...    placedOn=${placedOn}
    ...    deliveredOn=${deliveredOn}
    ...    trackingState=Delivered
    ...    packagingType=Box
    ...    orderType=Standard
    ...    packSlipLabel=STD
    ...    shippingMethod=Express
    ...    status=Delivered
    ...    refundable=114.00 USD
    ...    refundableHint=Returned items
    Shop UI Navigate To Refund
    Shop UI Verify Refund Visible     visible=${True}
    #> - The refund dialog is opened.
    Shop UI Fill Refund
    ...    action=Issue refund
    Shop UI Verify Refund Reasons
    ...    reason=Select a reason|Damaged on arrival|Wrong size|Late delivery|Changed mind|Missing accessory|Price match
    Shop UI Fill Refund
    ...    reason=Damaged on arrival
    #> - A reason is picked and the amount is set to 113.00 USD.
    #>> -> The dialog shows the reason list and the prefilled refundable total.
    Shop UI Verify Refund Values
    ...    action=Issue refund
    ...    reason=Damaged on arrival
    ...    amount=114.00
    Shop UI Fill Refund
    ...    amount=113.00
    Shop UI Verify Refund Summary    total=113.00
    #> - Saving confirms that the refund was queued.
    Shop UI Save Refund
    Shop UI Verify Message    message=Refund queued; the provider result follows shortly.

    #> - The payment provider is synced again.
    #>> -> The refund is sent to the provider and recorded on the order.
    Shop Sync Payment Provider
    ...    notifyUi=${False}
    ...    postToLedger=${True}


    #> ### Check the stored refund
    #>> -> The refund row is stored with the expected amount and reason.
    #>> -> The payment entry shows the matching provider reference.
    ${entry}=  Shop Verify Refund Row Via Database
    ...    entryType=REFUND
    ...    createdOn=${refundQueuedOn}
    ...    processedOn=${refundSettledOn}
    ...    status=SENT
    ...    reason=DamagedOnArrival
    ...    itemsAmount=114.00
    ...    refundAmount=-113.00
    ...    carrier=DEMO_CARRIER
    ...    returnLabel=RL-66332211
    ...    orderRef=${orderNumber}
    ...    orderRowId=${orderRowId}

    Shop Verify Refund Total Via Database
    ...    refundAmount=-113.00
    ...    entryKind=MANUAL_REFUND
    ...    refundId=${entry[0].id}
    ...    expectedCount=1

    Shop Verify Payment Entry Via Database
    ...    refundId=${entry[0].id}
    ...    createdOn=${refundQueuedOn}
    ...    description=Manual refund
    ...    paymentMethod=CARD
    ...    providerRef=PR-4821
    ...    settlementBatch=SB-19
    ...    amount=-113.00
    ...    status=OK
    ...    expectedCount=1

    #>> -> Reloading the admin UI leaves 1.00 USD refundable.
    Shop UI Reload Page
    Shop UI Verify Detail Row
    ...    orderId=${order.OrderId}
    ...    placedOn=${placedOn}
    ...    deliveredOn=${deliveredOn}
    ...    trackingState=Delivered
    ...    packagingType=Box
    ...    orderType=Standard
    ...    packSlipLabel=STD
    ...    shippingMethod=Express
    ...    status=Delivered
    ...    refundable=1.00 USD
    ...    refundableHint=Returned items

    Shop UI Navigate To Refund
    Shop UI Verify Refund Visible     visible=${True}
    Shop UI Fill Refund
    ...    action=Issue refund
    ...    amount=250.00

    Shop UI Verify Refund Validation
    ...    amount=${True}
    ...    message=Refund amount exceeds the remaining refundable total.

    Shop UI Fill Refund
    ...    action=Issue refund
    ...    reason=Damaged on arrival

    #> ### The last refundable dollar is refunded too
    #> - The remaining dollar is saved as a final refund.
    Shop UI Verify Refund Values
    ...    action=Issue refund
    ...    reason=Damaged on arrival
    ...    amount=1.00

    Shop UI Save Refund

    Shop Advance Clock
    Shop Sync Payment Provider
    ...    notifyUi=${False}
    ...    postToLedger=${True}

    ${entry}=  Shop Verify Refund Row Via Database
    ...    entryType=REFUND
    ...    createdOn=${refundSettledOn}
    ...    processedOn=${statementOn}
    ...    status=SENT
    ...    reason=DamagedOnArrival
    ...    itemsAmount=114.00
    ...    refundAmount=-1.00
    ...    carrier=DEMO_CARRIER
    ...    returnLabel=RL-66332211
    ...    orderRef=${orderNumber}
    ...    orderRowId=${orderRowId}

    Shop Verify Refund Total Via Database
    ...    refundAmount=-1.00
    ...    entryKind=MANUAL_REFUND
    ...    refundId=${entry[0].id}
    ...    expectedCount=1

    Shop Verify Payment Entry Via Database
    ...    refundId=${entry[0].id}
    ...    createdOn=${refundSettledOn}
    ...    description=Manual refund
    ...    paymentMethod=CARD
    ...    providerRef=PR-4822
    ...    settlementBatch=SB-20
    ...    amount=-1.00
    ...    status=OK
    ...    expectedCount=1

    #> ### Nothing left to refund
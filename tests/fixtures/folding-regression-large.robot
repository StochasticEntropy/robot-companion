*** Settings ***
Resource            Shop/Keywords.resource

Test Setup          Shop Setup    Shop
Test Teardown       Shop Teardown    Shop

Test Tags      SHOP


*** Test Cases ***
T001 Shop Order End To End With Provider Sync
    [Tags]
    ...    smoke     api     queue     export     files     shopFlow

    ${PlacedOn}=                Set Variable  2026-02-11
    ${DeliveredOn}=             Set Variable  2026-02-19
    ${StatementOn}=             Set Variable  2026-03-17
    # ${CapturedOn}=                 Set Variable  2026-02-12
    VAR    ${CapturedOn}    2026-02-12
    ${CustomerCode}=            Set Variable  55512345
    ${OrderType}=               Set Variable  STANDARD
    ${ArticleCode}=             Set Variable  DEMO_ARTICLE
    ${BundleCode}=              Set Variable  BUNDLE_ALPHA
    ${FilePrefix}=              Set Variable  SH-
    ${ExternalRef}=             Set Variable  77441122


    #> ## Test flow

    #> ### Create sample data
    #> 1. Create primary sample customer
    ${customer}=    Shop Create Sample Customer

    #> 1. Write order to mock store
    ${order}=    Shop Place Sample Order
    ...    customerId=${customer.customerId}
    ...    customerCode=${CustomerCode}
    ...    placedOn=${PlacedOn}
    ...    orderType=${OrderType}
    ...    articleCode=${ArticleCode}

    #> ### Ship the order and sync the provider
    #> - Ship the order without a delivery deadline
    Shop Set Clock    ${DeliveredOn}
    ${shipment}=    Shop Ship Order Via Api
    ...    customerId=${customer.customerId}
    ...    orderId=${order.OrderId}
    ...    shipmentId=${order.ShipmentId}
    ...    capturedOn=${CapturedOn}
    ...    deliveryDeadline=${NONE}
    ...    articleCode=${ArticleCode}
    ...    bundleCode=${BundleCode}
    ...    orderType=${OrderType}
    ...    itemsTotal=200.00
    ...    shippingTotal=80.00
    ...    orderTotal=280.00

    #> - Sync the payment provider with sample input
    #> - Refresh queue with code 1 and update markers
    ${syncResult}=    Shop Sync Payment Provider
    ...    sampleCustomer=${customer}
    ...    shipment=${shipment}
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}
    ...    capturedOn=${CapturedOn}
    ...    customerCode=${CustomerCode}
    ...    externalRef=${ExternalRef}
    ...    pickQueue=1
    ...    packMarker=2
    ...    multiSource=2
    ...    retryLimit=1
    ...    pageSize=25
    ...    batchSize=50
    ...    updateMarker=${True}
    #> ### Review generated records
    ${OrderNumber}=    Shop Lookup Order Number
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}

    #> - first level
    ${OrderRowId}=    Shop Lookup Order Row Id
    ...    shipmentId=${order.ShipmentId}
    ...    customerId=${customer.customerId}

    #>> - Check database rows and api calls
    Shop Check Queue Table Via Database
    ...    orderRowId=${OrderRowId}
    ...    queueStage=SHIPMENT_START
    ...    status=DONE
    ...    createdOn=${DeliveredOn}
    ...    sentOn=${DeliveredOn}
    ...    capturedOn=${CapturedOn}
    ...    finishedOn=
    ...    closedMarker=${NONE}
    ...    hasRollback=${False}
    ...    amount=280.00

    #> - next first level
    Shop Check Order History Via Database
    ...    queueRowId=${NONE}
    ...    customerId=${customer.customerId}
    ...    orderRef=${OrderNumber}
    ...    channel=WEB
    ...    eventType=STANDARD_FLOW
    ...    createdOn=${CapturedOn}
    ...    closedOn=${NONE}
    ...    capturedOn=${CapturedOn}
    ...    completedOn=${NONE}

    Shop Check Order History Via Api Log
    ...    syncJob=${syncResult.jobId}
    ...    customerId=${customer.customerId}
    ...    orderRef=${OrderNumber}
    ...    createdOn=${CapturedOn}
    ...    closedOn=${NONE}
    ...    eventType=STANDARD_FLOW
    ...    capturedOn=${CapturedOn}
    ...    completedOn=${NONE}
    ...    amount=280.00

    ${LedgerResponse}=    Shop Read Ledger File
    # ...    fileName=${syncResult.archiveFile}
    ...    fileName=${syncResult.reportFile}
    ...    shipmentId=${FilePrefix}${order.ShipmentId}
    ...    articleCode=${ArticleCode}

    Shop Verify Ledger Sum By Order
    ...    ledgerResponse=${LedgerResponse}
    ...    shipmentId=${FilePrefix}${order.ShipmentId}

    Shop Verify Ledger Row
    ...    ledgerResponse=${LedgerResponse}
    ...    expectedRows=2
    ...    shipmentRef=${FilePrefix}${order.ShipmentId}
    ...    countryCode=US
    ...    extraMarker=X
    ...    totalAmount=280.00

    #> - Check export file
    #>> -> Check export file Check export file Check export file Check export file Check export file
    ${ExportData}=    Shop Read Export File Via Api
    ...    exportType=SHIPPING_BATCH
    ...    statementOn=${StatementOn}

    Shop Verify Export Row
    ...    exportData=${ExportData}
    ...    sampleCustomer=${customer}
    ...    statementOn=${StatementOn}
    ...    regionCode=WEST
    ...    orderRef=${OrderNumber}01
    ...    sourceCode=1
    ...    deliveryMode=GROUND
    ...    eventName=STANDARD
    ...    shippedOn=${DeliveredOn}
    ...    amount=280.00

    Shop Verify Export Summary
    ...    fileName=${syncResult.summaryFile}
    ...    batchNumber=1

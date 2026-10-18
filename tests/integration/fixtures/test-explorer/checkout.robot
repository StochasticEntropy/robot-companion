*** Settings ***
Documentation    Synthetic Test Explorer suite: one passing test, one failing
...              until checkout.ready exists next to this file, and one that
...              is never selected.
Library    OperatingSystem

*** Test Cases ***
Checkout Passes
    Log    checkout-ok

Checkout Needs Ready Flag
    File Should Exist    ${CURDIR}/checkout.ready

Checkout Not Selected
    Log    not-selected

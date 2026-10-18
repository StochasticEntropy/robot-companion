*** Variables ***
${ENVIRONMENT}    staging
${REGION}    ${ENVIRONMENT}-eu
@{ITEMS}    a    b

*** Test Cases ***
Login On ${ENVIRONMENT}
    Log    ${ENVIRONMENT}

Region ${REGION} Works
    Log    ${REGION}

Spaced${SPACE}Out
    No Operation

Numbers ${1.5} And ${0x10}
    No Operation

Unknown ${NOT_DEFINED} Stays As Written
    No Operation

Duplicate Name
    Log    first

Duplicate Name
    Log    second

Grüße aus Köln 🎉 und 𝄞
    Log    Ümlaut 🎉 und 𝄞

Templated Equality
    [Template]    Should Be Equal
    1    1
    ä    ä

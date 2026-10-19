*** Test Cases ***
Parsable Before Error
    [Unknown Setting]    value
    Log    still parsed

*** Not A Section ***
Ignored Content

*** Test Cases ***
Parsable After Error
    Log    ok

*** Keywords ***
Outer
    [Arguments]    ${value}
    ${inner}=    Inner    ${value}
    IF    $inner == 'never'    Log    not-run-in-outer
    Log    outer-after-inner ${inner}
    RETURN    ${inner}-outer

Inner
    [Arguments]    ${value}
    Set Test Variable    ${INNER_MARK}    inner-${value}
    Log    inner-leaf ${value}
    Log    inner-remainder ${value}
    Set Test Variable    ${INNER_DONE}    done-${value}
    RETURN    inner-${value}

Recurse
    [Arguments]    ${depth}
    IF    ${depth} > 0
        Recurse    ${{ int($depth) - 1 }}
    END
    Log    recurse-leaf ${depth}

Early
    [Arguments]    ${flag}
    IF    '${flag}' == 'yes'
        Log    early-leaf
        RETURN    early
    END
    Log    early-never

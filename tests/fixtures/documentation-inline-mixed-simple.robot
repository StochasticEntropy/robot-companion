*** Test Cases ***
T001 Mixed Documentation And Inline
    [Documentation]
    ...    ## Scenario
    ...    - A seeded case already exists.
    ...    - The overview values are displayed.
    ...      -> The summary banner stays visible.
    ...    ## Context
    ...    Supporting notes explain why the follow-up checks matter.
    Log    before docs

    #> ## Flow
    #> ### Prepare case
    #> - Open the case in the UI.
    Demo Keyword    first=1

    #>> -> The first inline proof is visible in the result panel.
    Demo Keyword    second=2

    #> ### Verify result
    #> - The visible state is validated.
    Demo Keyword    third=3

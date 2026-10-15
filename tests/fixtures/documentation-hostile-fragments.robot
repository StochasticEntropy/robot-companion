*** Test Cases ***
Hostile Plain Svg
    [Documentation]    Hostile documentation: an SVG that overflows its box.
    ...
    ...    <svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Hostile Svg After Section
    [Documentation]    Hostile documentation: a stray section end tag, then an SVG.
    ...
    ...    </section><svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Hostile Svg After Section And Divs
    [Documentation]    Hostile documentation: stray section and div end tags, then an SVG.
    ...
    ...    </section></div></div><svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Hostile Raw Style
    [Documentation]    Hostile documentation: a raw style element.
    ...
    ...    <style data-rc-hostile="style">body * { display: none !important; } a, button { color: rgb(255, 0, 0) !important; }</style>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Hostile Style Attribute
    [Documentation]    Hostile documentation: a style attribute that would pull content over the controls.
    ...
    ...    <p data-rc-hostile="style-attribute" style="margin-top:-3000px;height:6000px;background:rgb(255,0,0)">styled</p>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Hostile Fixed Overlay
    [Documentation]    Hostile documentation: a fixed element over the whole viewport.
    ...
    ...    <div data-rc-hostile="fixed" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:rgb(255,0,0)">overlay</div>
    ...
    ...    rc-doc-text after the hostile part.
    ...
    ...    - Expected result
    ...      -> See <color value="#0f766e">the custom colour</color>.
    ...        -> A deeper arrow line.
    Log    probe

Return Explorer Hostile Docstrings
    Hostile Svg First Line
    Hostile Svg After Section Docstring
    Hostile Svg After Section And Divs Docstring
    Hostile Raw Style Docstring
    Hostile Style Attribute Docstring
    Hostile Fixed Overlay Docstring

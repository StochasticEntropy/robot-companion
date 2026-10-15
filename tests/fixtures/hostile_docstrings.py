"""Python keywords whose docstrings carry hostile HTML, for the Return Explorer UI tests.

Each docstring is one line that starts with the hostile HTML.
"""

from robot.api.deco import keyword


@keyword("Hostile Svg First Line")
def hostile_svg_first_line():
    """<svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg> rc-doc-text after the hostile part."""


@keyword("Hostile Svg After Section Docstring")
def hostile_svg_after_section_docstring():
    """</section><svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg> rc-doc-text after the hostile part."""


@keyword("Hostile Svg After Section And Divs Docstring")
def hostile_svg_after_section_and_divs_docstring():
    """</section></div></div><svg data-rc-hostile="svg" width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="rgb(255, 0, 0)"/></svg> rc-doc-text after the hostile part."""


@keyword("Hostile Raw Style Docstring")
def hostile_raw_style_docstring():
    """<style data-rc-hostile="style">body * { display: none !important; } a, button { color: rgb(255, 0, 0) !important; }</style> rc-doc-text after the hostile part."""


@keyword("Hostile Style Attribute Docstring")
def hostile_style_attribute_docstring():
    """<p data-rc-hostile="style-attribute" style="margin-top:-3000px;height:6000px;background:rgb(255,0,0)">styled</p> rc-doc-text after the hostile part."""


@keyword("Hostile Fixed Overlay Docstring")
def hostile_fixed_overlay_docstring():
    """<div data-rc-hostile="fixed" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:rgb(255,0,0)">overlay</div> rc-doc-text after the hostile part."""

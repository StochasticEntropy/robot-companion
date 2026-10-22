*** Settings ***
Resource    markdown_keywords.md
Library     tomlkw
*** Test Cases ***
Robot Control Test
    Log    control
    Toml Kw
    Markdown Shared Keyword

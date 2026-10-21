# Markdown login checks

Robot Framework 7.5 runs only the fenced `robot` blocks of this file.

```robot
*** Settings ***
Library     tomlkw
Resource    markdown_keywords.md

*** Test Cases ***
Markdown First Test
    Markdown Shared Keyword
    Toml Kw
    Should Be Equal    ${ENV}    staging
```

- A block indented in a list item:

  ```robot
  *** Test Cases ***
  Markdown Second Test
      Markdown Missing Keyword
  ```

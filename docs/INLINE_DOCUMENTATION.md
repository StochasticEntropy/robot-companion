# Inline Documentation

Robot Companion can render lightweight inline documentation directly from comments inside `*** Test Cases ***`, `*** Tasks ***`, and `*** Keywords ***`.

## Basic idea

Write comment lines that start with `#>` or `#>>` inside a Robot owner body:

```robotframework
*** Test Cases ***
Example Case
    #> ## Flow
    #> ### Prepare sample data
    #> - Create a synthetic record
    Log    step one
    #>> -> The record is now visible in the UI.
    Log    step two
```

These lines are picked up by the Documentation Preview and rendered as Markdown next to the testcase or keyword they belong to.

## Marker syntax

- `#> ## ...` or `#> ### ...`
  Creates a headline in the preview.
- `#> ...`
  Creates a first-level documentation line.
  This can be plain text, a bullet like `- item`, or a numbered item like `1. item`.
- `#>> ...`
  Creates a nested second-level documentation line.
  This is commonly used for follow-up bullets or arrow notes such as `#>> -> result`.

Rendering can handle deeper indentation patterns, but the preview folding actions currently use these three exact buckets:

- `Level 3`: headline lines from `#> ## ...` and `#> ### ...`
- `Level 4`: first-level lines from `#> ...` that are not headlines
- `Level 5`: second-level lines from `#>> ...`

## How it groups content

- Inline documentation belongs to the nearest testcase, task, or keyword body where it appears.
- Normal Robot steps between documentation markers stay part of that section's folded body.
- A new headline starts a new top-level documentation section.
- A new first-level peer closes the previous first-level body.
- A `#>>` line stays nested under the nearest first-level or headline section above it.

## When to use inline docs vs `[Documentation]`

Use inline docs when you want documentation to stay close to the concrete Robot steps it describes.

Use `[Documentation]` when you want one compact documentation block at the top of the owner.

Both styles are supported by Robot Companion and appear in the same Documentation Preview.

## Tips

- Prefer short action-oriented lines.
- Use `#> ### ...` for meaningful subsections inside a large testcase.
- Use `#>> -> ...` for expected outcomes or verification notes under a step.
- If folding behavior matters, stick to the exact marker classes above instead of mixing many indentation styles.

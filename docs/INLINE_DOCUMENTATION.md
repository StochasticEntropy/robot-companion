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

Consecutive plain documentation comments form one flowing paragraph, so source wrapping does not create visible line breaks:

```robotframework
#> A long explanation can be split in the source,
#> while the preview keeps it on the same flowing line.
```

The same applies to plain `[Documentation]` continuation rows.

To wrap a long bullet across source lines without forcing a line break in the preview, indent the continuation after the marker:

```robotframework
#> - A long bullet can be split in the source,
#>   while its continuation renders as part of the same flowing line.
```

An explicitly marked next bullet such as `#> - Another item` still starts a separate list item.

Arrow notes support the same source wrapping:

```robotframework
#>> -> A long expected result can be split in the source,
#>>    while its continuation renders as part of the same flowing line.
```

A new `#>> -> Another result` remains a separate arrow note.

## Wrapped `[Documentation]` rows

The same wrapping behavior applies to Robot `[Documentation]` continuation rows. Add extra indentation after the `...` cell separator to continue the preceding bullet or arrow without forcing a rendered line break:

```robotframework
[Documentation]
...    - A long scenario description can be split in the source,
...        while its continuation renders as part of the same flowing line.
...        -> A long expected result can also be split,
...           while that continuation stays on the same flowing arrow line.
```

An explicit next `-` bullet or `->` arrow still starts a separate rendered item.

## Intentional line breaks

Use an explicit Markdown `<br>` when text should start on a new rendered line while remaining part of the same paragraph, bullet, or arrow:

```robotframework
#> First paragraph line.<br>
#> Intentional second paragraph line.

#> - First bullet line.<br>
#>   Intentional second bullet line.

#>> -> First arrow line.<br>
#>>    Intentional second arrow line.

[Documentation]
...    First paragraph line.<br>
...    Intentional second paragraph line.
...
...    - First scenario line.<br>
...        Intentional second scenario line.
...        -> First expected-result line.<br>
...           Intentional second expected-result line.
```

Use a new explicit `-` or `->` instead when the content is a semantically separate item.

Rendering can handle deeper indentation patterns, but the preview folding actions currently use these buckets:

- `Headlines`: headline lines from `#> ## ...` and `#> ### ...`
- `Steps`: all step lines from `#> ...` that are not headlines, together with nested `#>> ...` lines

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

## Inline colors

Documentation text can use explicit opt-in color markup in the live preview and PDF/print export. Markdown export keeps the original tags so the exported file stays readable and editable.

Use semantic tags when the color has meaning:

```robotframework
#> - <note>Background context</note>
#> - <question>Open clarification</question>
#> - <warning>Risk to check</warning>
#> - <error>Known mismatch</error>
#> - <success>Expected result confirmed</success>
```

Use short color tags when you only want a visual color:

```robotframework
#> - <red>red</red>, <orange>orange</orange>, <yellow>yellow</yellow>, <green>green</green>
#> - <blue>blue</blue>, <pink>pink</pink>, <purple>purple</purple>, <gray>gray</gray>
```

For rare custom colors, use the allowlisted color tag:

```robotframework
#>> -> See <color value="#0f766e">the new clarification</color>.
```

Allowed custom color names are `red`, `orange`, `yellow`, `green`, `blue`, `pink`, `purple`, and `gray`. Hex colors can use `#RGB` or `#RRGGBB`. Unsupported tags or attributes are rendered as plain text instead of executable HTML.

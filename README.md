# Robot Markdown Companion

Read-only VS Code companion extension to render Robot Framework `[Documentation]` blocks as Markdown and show local variable values from `Set Variable` on hover, without replacing the normal text editor and without interfering with RobotCode language features.

## What it does

- Adds a synced side preview view: `robotDocPreview.view` in the `Robot Doc` Activity Bar container.
- Parses `[Documentation]` blocks in `*** Test Cases ***`, `*** Tasks ***`, and `*** Keywords ***`.
- Supports continuation lines (`...`) as Markdown content.
- Preserves visual line breaks and indentation intent from Robot continuation lines.
- Supports `->` and `=>` as visual indent markers (including nested forms like `-> ->` / `=> =>`).
- Adds variable hover enrichment: hovering `${...}` / `@{...}` / `&{...}` / `%{...}` can show the latest local `Set Variable` value from the same test/keyword before the cursor.
- Keeps RobotCode workflows intact because it does not register custom editors, formatters, diagnostics, or completion providers.

## Commands

- `robotDocPreview.toggle`
- `robotDocPreview.openCurrentBlock`

## Settings

- `robotDocPreview.enableCodeLens` (default: `true`)
- `robotDocPreview.enableHoverPreview` (default: `true`)
- `robotDocPreview.enableVariableValueHover` (default: `true`)
- `robotDocPreview.autoSyncSelection` (default: `true`)
- `robotDocPreview.debounceMs` (default: `200`)
- `robotDocPreview.hoverLineLimit` (default: `300`)
- `robotDocPreview.variableHoverLineLimit` (default: `30`)

## Notes

- This extension is intentionally read-only.
- Variable hover resolves only local `Set Variable` assignments within the current test/keyword block, using the latest assignment at or above the hovered line.
- Rendering uses VS Code's built-in markdown renderer (`markdown.api.render`) with a safe fallback.

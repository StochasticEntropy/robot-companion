# Changelog

## 0.1.3

- Added variable value hover enrichment for Robot variables (`${...}`, `@{...}`, `&{...}`, `%{...}`).
- Variable hover now shows raw values from local `Set Variable` assignments in the same test/keyword before the cursor.
- Added settings:
  - `robotDocPreview.enableVariableValueHover`
  - `robotDocPreview.variableHoverLineLimit`
- Extended command visibility to `.resource` files.

## 0.1.1

- Polished Marketplace metadata and README publish instructions.
- Added license and packaging ignore configuration.
- Improved Robot documentation rendering behavior for arrow-style (`->` / `=>`) lines.

## 0.1.0

- Initial Marketplace-ready release of Robot Markdown Companion.
- Added read-only side preview for Robot Framework `[Documentation]` blocks.
- Added optional CodeLens and hover preview support.
- Added live sync on active editor, cursor movement, and debounced edits.
- Added visual handling for `->` and `=>` indentation markers.

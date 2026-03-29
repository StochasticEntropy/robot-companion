# Changelog

## 0.1.29

- Fixed Python keyword-signature parsing when inline `# ...` comments are present in parameter lines.
- Restored missing hover/side-panel resolution for affected named args such as `betriebsnummerKk` and `aktenzeichenKk` in `BAVL ZMV_CONNECT Meldung KK Datei Erzeugen - Mock Funktion`.

## 0.1.28

- Refined enum side-panel UX to reduce duplicate assignment navigation/details and keep the key resolved value focus.
- Improved side-panel metadata layout with clearer label order: Testcase, Keyword, Argument.
- Improved current-value display consistency and formatting in hover/side panel, including enum-mapped current values.
- Fixed hover inline-value escaping so underscores render cleanly (no unwanted _ escapes).

## 0.1.27

- Improved current-value visibility in hover and side panel:
  - Shows a prominent current-value highlight at the top of enum hints.
  - Shows clearer current-value summary in variable hover.
  - Adds direct jump links to `Set Variable` source lines in variable hover.
  - Adds a current-value summary card in the side panel for enum context, including source and jump link when available.

## 0.1.26

- Added typed variable dropdown suggestions for named argument values in Robot keyword calls.
- Suggestions now prioritize in-scope variables assigned from keyword returns whose return type matches the expected argument type.
- Added setting `robotDocPreview.enableTypedVariableCompletions` (default: `true`) to enable/disable these completion suggestions.

## 0.1.25

- Improved enum hint readability for variable-driven arguments:
  - Shows `Set Variable` source line for resolved current values.
  - Adds jump link to the `Set Variable` assignment line.
  - Marks matching enum member lines with `<= current` and shows a concise resolved member summary.

## 0.1.24

- Added `.gitignore` to ignore local `.vsix` packaging artifacts.
- Added `docs/RELEASE_CHECKLIST.md` with a minimal release verification flow.
- Added README reference to the release checklist.

## 0.1.23

- Added source line details to **Return Hint For Argument Value** (shows where the argument variable was assigned from a keyword return).
- Added clickable jump links in hover and return side panel to navigate directly to the assignment line.

## 0.1.22

- Collapsed duplicate enum candidates that have identical member sets, even when discovered from multiple files.
- Added a hover/side-panel note indicating when duplicate enum definitions were collapsed.

## 0.1.21

- Renamed visible extension name from **Robot Markdown Companion** to **Robot Companion** (`displayName`).
- Updated README title to match the new extension name.
- Updated Command Palette command titles/categories to use **Robot Companion** consistently.

## 0.1.20

- Added command `robotDocPreview.invalidateCaches` to clear all documentation/enum/return caches and refresh both side panels.
- Included the new cache command in extension contributions and README command list.

## 0.1.19

- Side panel enum/argument view now triggers when cursor is on either named argument key or value.
- Side panel now prefers argument enum context (with return hint section) over return-variable-only view when both apply at the same cursor location.
- Improved named argument value hit detection at value-end cursor positions.

## 0.1.18

- Added transitive enum/type-hint propagation through Robot keyword wrappers (`.resource` and keyword robot files).
- Named argument hints can now resolve when a Robot keyword forwards arguments to another Robot keyword that eventually ends in a Python `@keyword` with type hints.

## 0.1.17

- Added setting `robotDocPreview.enableEnumArgumentFallback` to control lower-confidence argument-name fallback across keywords.
- Default for enum argument fallback is now off, so only direct keyword+argument enum/type-hint mappings are used unless explicitly enabled.

## 0.1.16

- Added alias-aware local enum resolution from Python imports (`from ... import Enum` / `from ... import Enum as Alias`) for keyword argument annotations.
- Added source-file-aware enum matching precedence: local enum class, imported alias target, then direct global enum token match.
- Added fallback provenance labels (`direct`, `argument-fallback`, `annotation-only`) and low-confidence notes in hover and side panel when fallback paths are used.

## 0.1.15

- Robot Return Explorer side panel now also syncs when cursor is on enum-mapped named arguments (not only return variables).
- Enum context now renders argument-focused details in the side panel so users can inspect accepted enum values outside hover.
- Reused shared enum preview resolution for hover and side panel to keep enum matching behavior consistent.

## 0.1.14

- Developer technical section now keeps class structure but omits field type annotations to reduce clutter.
- Simple one-dot/two-dot Robot access paths remain unchanged.
## 0.1.13

- Simple return view now shows copy-ready Robot access paths instead of intermediate class/type nodes.
- First section lists one-dot access paths (for example `${result.field}`), second section lists two-dot paths (for example `${result.field.subfield}`).
- Technical developer section remains intact below the simple sections in Robot Return Explorer.
## 0.1.12

- Return Explorer now shows a simple access-first view at the top and keeps full technical details below it for developers.
- Return hover now favors the simple view and points users to the side panel for full technical depth.
- Added technical depth/field settings: `robotDocPreview.returnTechnicalMaxDepth`, `robotDocPreview.returnTechnicalMaxFieldsPerType`.

## 0.1.11

- Simplified return structure output for Robot users: field-first display with cleaner nested options.
- Restricted structured-type parsing to class-level declarations to avoid method/signature noise in return explorer.
- Improved inherited-type handling and reduced technical wrapper noise (NoCheck, Unset, Sentinel, etc.).
- Reduced default return depth/field limits for more readable hover and side-panel output.

## 0.1.10

- Return structure explorer now resolves inherited base types for dataclass/typed response wrappers (including classes with `pass`).
- Added inherited-type expansion in return hover and Robot Return Explorer output.

## 0.1.9

- Added Robot Return Explorer side panel for structured keyword return inspection.
- Added return value hover for keyword-call assigned variables, including dot-notation variable access.
- Indexed structured Python return types (dataclass/typed class fields) and keyword return annotations for richer Robot return hints.

## 0.1.8

- Removed enum index hard cap of 4000 Python files to support larger repositories.
- Stopped excluding generated-folder Python files from enum indexing so generated enums remain discoverable.

## 0.1.7

- Fixed enum hover resolving to unrelated enums by removing global value-only fallback.
- Fixed keyword signature parsing for long parameter lists (up to 300 lines), restoring enum mapping for large Robot keywords.
- Enum hover now follows keyword + argument mapping reliably on continuation lines.

## 0.1.6

- Clean follow-up release to align Marketplace installs on one version baseline.
- Includes hover recovery + enum hover guardrails from 0.1.5 for consistent behavior across machines.

## 0.1.5

- Fixed hover regression where enum hover helpers were missing and could break all extension hover behavior.
- Added enum hover settings back to extension configuration:
  - `robotDocPreview.enableEnumValueHover`
  - `robotDocPreview.enumHoverMaxEnums`
  - `robotDocPreview.enumHoverMaxMembers`
- Added enum hover error guardrails so enum failures no longer block variable/doc hover.

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

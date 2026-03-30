# Changelog

## 0.2.11

- Added import-aware return type resolution to reduce same-name type collisions across large codebases:
  - return annotations now resolve using local module context, `from ... import ...` aliases, and `import ... as ...` module aliases.
  - return type selection now prefers qualified-name matches (module path + type) before generic fallback heuristics.
- Improved nested return-structure resolution:
  - nested field annotations are resolved with the declaring type's source-file import context.
  - structured type and enum rendering now respect qualified-name preferences consistently in hover and Return Explorer.
- Improved typed return-variable matching used by argument assistance by resolving return annotations through the same import-aware path.

## 0.2.10

- Improved cross-platform reliability for keyword-doc argument links in Return Explorer:
  - argument links now route through `openLocation` with preview metadata, using the same navigation path as other working location links.
  - fixed preview-command timing/race behavior so single-click argument navigation is more consistent.
  - improved `Jump back to keyword` stability after argument preview transitions.

## 0.2.9

- Fixed keyword-doc argument preview link reliability across environments:
  - fallback navigation for missing call arguments now keeps keyword-token context.
  - reduced click race conditions so argument preview links work on first click more reliably.
- Improved command-driven navigation behavior in Return Explorer:
  - `openLocation` now triggers an immediate Return Explorer refresh.
  - `Jump back to keyword` now restores the keyword-doc context consistently after argument preview.

## 0.2.8

- Moved keyword-doc source navigation into a dedicated **Keyword Definition** section in Robot Return Explorer details.
- Added `Jump to keyword definition` directly under the **Keyword Definition** headline.
- Added argument-link navigation in keyword docs:
  - `Args` entries now link to the corresponding named argument in the current Robot keyword call when available.
  - Added a non-intrusive tip line explaining clickable argument names.
- Added stable named-argument range extraction helper and reused it for hover/value detection and keyword-call argument parsing.
- Keyword-doc argument links now work even when the argument is not present in the current call:
  - clicking an `Args` entry opens an argument preview mode using keyword+argument mapping.
  - when argument exists in the call, navigation still jumps to that argument location.
- Added `Jump back to keyword` link in keyword-argument preview mode.
- In keyword-argument preview mode, enum rendering is simplified:
  - shows only argument name in the “What This Argument Accepts” block (no `arg=value` line),
  - hides “Resolved current value …”,
  - hides `<= current` enum member marker.

## 0.2.7

- Improved cache invalidation command reliability:
  - `Robot Companion: Invalidate All Caches` now forces an immediate index refresh for the active Robot document before refreshing the Return Explorer view.
  - Indexing now prefers open editor content for indexed files, reducing stale results when files are open.
- Cleaned command palette labels to avoid duplicated `Robot Companion:` prefixes (category now provides the prefix once).

## 0.2.6

- Improved keyword-doc `Args` rendering for indented option lists: nested bullets and continuation lines now stay under the owning argument instead of flattening to top-level bullets.

## 0.2.5

- Added keyword documentation rendering in **Robot Return Explorer** when cursor is on a keyword call token.
- Indexed Python `@keyword(...)` docstrings with source metadata (file, line, function) in the shared index.
- Added best-effort Google-style docstring normalization (`Args`, `Returns`, `Raises`) with warning notes instead of hard failures.
- Added warning-banner behavior for ambiguous keyword matches and doc parse issues, while still rendering the best available content.
- Added jump links from keyword-doc context to Python keyword definitions.

## 0.2.4

- Documentation Preview now shows testcase owner names as the primary list label and adds `Jump to testcase` links in the list.
- Added a `Jump to testcase` link directly under the preview headline for the selected documentation block.
- Preview headline now uses testcase name (`ownerName`) as the main title instead of derived markdown title.

## 0.2.3

- Documentation Preview list now shows testcase owner names as the main item label (removed duplicated subtitle line in the list).

## 0.2.2

- Changed default sidebar view order back to documentation-first: **Documentation Preview** on top, **Robot Return Explorer** below.

## 0.2.1

- Updated repository metadata URLs to `StochasticEntropy/robot-companion`.
- Updated local `origin` remote recommendation in internal notes to the new repo naming.

## 0.2.0

- BREAKING: Renamed extension namespace from `robotDocPreview.*` to `robotCompanion.*` for commands, views/container IDs, and settings keys.
- Re-positioned UX to make **Robot Return Explorer** the primary sidebar workflow; **Documentation Preview** remains available in the same container as a secondary capability.
- Updated command palette labels for Robot Companion positioning (including `robotCompanion.toggle` -> focus Return Explorer).
- Introduced `src/*` module layout scaffolding and moved runtime entrypoint to `src/core/extension.js` with root `extension.js` delegating to it.
- Updated README and internal docs for the Robot Companion 0.2.0 naming and workflow model.

## 0.1.34

- Improved nested collection access hints: when a second-level (or deeper) path goes through a collection-typed field, the path now inserts index access on that segment (for example `${bp.adresse[0].ort}`).

## 0.1.33

- Collection-like return hints now show indexed access only (for example `${var[0].field}`), removing the duplicate non-indexed variant for those contexts.

## 0.1.32

- Added configurable generic subtype return resolution across return hover, side panel, and argument return hints:
  - `robotCompanion.returnSubtypeResolutionMode` (`always` | `never` | `include` | `exclude`, default `always`)
  - `robotCompanion.returnSubtypeIncludeContainers` (default `[]`)
  - `robotCompanion.returnSubtypeExcludeContainers` (default `[]`)
- Return annotation parsing now resolves nested generic subtypes (for example `list[T]`, `ListWrapper[T]`, `Optional[list[T]]`) based on the selected policy.
- Structured type indexing now marks indexable wrappers (`__getitem__` / `__iter__`) and uses that signal for include-mode subtype resolution.
- Collection-like return hints now emit both access styles, including indexed Robot syntax `${var[0].field}`.

## 0.1.31

- Added configurable depth for **Return Hint For Argument Value**:
  - New setting: `robotCompanion.returnHintArgumentMaxDepth` (default: `2`)
- Return hint access path generation now respects that depth in both hover and side panel.

## 0.1.30

- Cleaned hover output by removing redundant "Return hint for argument value" when it duplicates the same `Set Variable` source already shown as `Value source`.
- Aligned hover dedupe behavior with side-panel behavior for the same argument-resolution context.

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
- Added setting `robotCompanion.enableTypedVariableCompletions` (default: `true`) to enable/disable these completion suggestions.

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

- Added command `robotCompanion.invalidateCaches` to clear all documentation/enum/return caches and refresh both side panels.
- Included the new cache command in extension contributions and README command list.

## 0.1.19

- Side panel enum/argument view now triggers when cursor is on either named argument key or value.
- Side panel now prefers argument enum context (with return hint section) over return-variable-only view when both apply at the same cursor location.
- Improved named argument value hit detection at value-end cursor positions.

## 0.1.18

- Added transitive enum/type-hint propagation through Robot keyword wrappers (`.resource` and keyword robot files).
- Named argument hints can now resolve when a Robot keyword forwards arguments to another Robot keyword that eventually ends in a Python `@keyword` with type hints.

## 0.1.17

- Added setting `robotCompanion.enableEnumArgumentFallback` to control lower-confidence argument-name fallback across keywords.
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
- Added technical depth/field settings: `robotCompanion.returnTechnicalMaxDepth`, `robotCompanion.returnTechnicalMaxFieldsPerType`.

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
  - `robotCompanion.enableEnumValueHover`
  - `robotCompanion.enumHoverMaxEnums`
  - `robotCompanion.enumHoverMaxMembers`
- Added enum hover error guardrails so enum failures no longer block variable/doc hover.

## 0.1.3

- Added variable value hover enrichment for Robot variables (`${...}`, `@{...}`, `&{...}`, `%{...}`).
- Variable hover now shows raw values from local `Set Variable` assignments in the same test/keyword before the cursor.
- Added settings:
  - `robotCompanion.enableVariableValueHover`
  - `robotCompanion.variableHoverLineLimit`
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

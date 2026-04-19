# Robot Companion

Robot Companion is a non-invasive VS Code extension for Robot Framework focused on return/enum/value intelligence, with synchronized markdown documentation rendering in the same companion sidebar.

## What it does

- Shows **Documentation Preview** and **Robot Return Explorer** in the same sidebar container (documentation is listed first by default).
- Provides return structure + argument context workflow in **Robot Return Explorer**.
- Shows indexed Python `@keyword(...)` docstrings in **Robot Return Explorer** when cursor is on a keyword call token.
- Parses Robot docs from `*** Test Cases ***`, `*** Tasks ***`, and `*** Keywords ***`, including `...` continuation lines.
- Adds hover intelligence for:
  - local `Set Variable` values,
  - named-argument enum/type hints,
  - keyword return structures.
- Preserves RobotCode workflows because it does not replace the text editor or register formatter/diagnostic providers.

## Commands

- `Robot Companion: Focus Return Explorer` (`robotCompanion.toggle`)
- `Robot Companion: Open Current Documentation Block` (`robotCompanion.openCurrentBlock`)
- `Robot Companion: Invalidate All Caches` (`robotCompanion.invalidateCaches`)
- `Robot Companion: Show Output` (`robotCompanion.showOutput`)

## Views

- `robotCompanion.view` — **Documentation Preview**
- `robotCompanion.returnView` — **Robot Return Explorer**

## Documentation Color Markup

Documentation comments and `[Documentation]` Markdown support explicit color tags in the live preview and PDF/print export:

- Semantic tags: `<note>`, `<question>`, `<warning>`, `<error>`, `<success>`
- Color shortcuts: `<red>`, `<orange>`, `<yellow>`, `<green>`, `<blue>`, `<pink>`, `<purple>`, `<gray>`
- Custom colors: `<color value="red">...</color>`, `<color value="#0f766e">...</color>`

Unsupported colors, attributes, or arbitrary HTML styles are rendered as plain text. Markdown export preserves the author-facing tags.

## Settings

- `robotCompanion.enableCodeLens`
- `robotCompanion.enableDocumentationHoverPreview`
- `robotCompanion.enableEnumValueHover`
- `robotCompanion.enableEnumArgumentFallback`
- `robotCompanion.enumCompletionDisplayMode`
- `robotCompanion.logLevel`
- `robotCompanion.enableVariableValueHover`
- `robotCompanion.enableTypedVariableCompletions`
- `robotCompanion.enableReturnMemberCompletions`
- `robotCompanion.returnFieldNameStyle`
- `robotCompanion.returnIncludeProperties`
- `robotCompanion.returnMemberCompletionMaxDepth`
- `robotCompanion.enableReturnValueHover`
- `robotCompanion.enableReturnExplorer`
- `robotCompanion.indexImportFolderPatterns`
- `robotCompanion.indexExcludeFolderPatterns`
- `robotCompanion.autoSyncSelection`
- `robotCompanion.enableOpenFilePrewarm`
- `robotCompanion.prewarmMode`
- `robotCompanion.debounceMs`
- `robotCompanion.hoverLineLimit`
- `robotCompanion.enumHoverMaxEnums`
- `robotCompanion.enumHoverMaxMembers`
- `robotCompanion.returnHoverMaxDepth`
- `robotCompanion.returnPreviewMaxDepth`
- `robotCompanion.returnHintArgumentMaxDepth`
- `robotCompanion.returnSubtypeResolutionMode`
- `robotCompanion.returnSubtypeIncludeContainers`
- `robotCompanion.returnSubtypeExcludeContainers`
- `robotCompanion.returnMaxFieldsPerType`
- `robotCompanion.returnTechnicalMaxDepth`
- `robotCompanion.returnTechnicalMaxFieldsPerType`
- `robotCompanion.enableReturnTypeDiskCache`
- `robotCompanion.returnTypeCacheMaxEntries`
- `robotCompanion.variableHoverLineLimit`

Index pattern examples:

- `robotCompanion.indexImportFolderPatterns`: `["**"]` (default), `["robots3/BAVL/**"]`
- `robotCompanion.indexExcludeFolderPatterns`: `[".git",".venv","venv","__pycache__","node_modules","tests"]` (default), `["**/gen/**","**/generated/**"]`

## Notes

- Extension behavior is non-invasive by default: it does not replace the editor, formatter, or diagnostics, but explicit actions such as argument insertion and documentation export can edit or write files.
- Caches (documentation + enum/type/return index) can be reset via the invalidate command.
- Robot Companion writes diagnostic logs to a dedicated `Robot Companion` Output channel; use `robotCompanion.logLevel` (`off`, `error`, `warn`, `info`, `debug`) to control verbosity.
- Runtime caches for open Robot files are prewarmed by default so return/argument previews appear faster; technical return details load lazily.
- Return resolution is type-scoped in the worker: repeated variables that resolve to the same return type reuse one cached compute result (including technical tree data).
- `${var.}` member completions in named-argument values reuse the same worker return-type cache (memory + disk); first request may be cold, follow-up keystrokes are cache-first.
- Enum completions after `arg=` can be configured to show enum `name`, `value`, or `both`; default is `name`.
- Return member access can be rendered as camelCase aliases (`statusCode`), raw `snake_case`, or both via `robotCompanion.returnFieldNameStyle`; the default is `camelcase`.
- Python `@property` members can be included or hidden in return hover/explorer/member access via `robotCompanion.returnIncludeProperties`; the default is `true`.
- `robotCompanion.returnMaxFieldsPerType` defaults to `0`, which means return access lists are unlimited unless you set an explicit cap.
- CamelCase aliases are only shown for return types that actually support CamelCase access. Technical return details stay on the raw source field names.
- Worker return-type cache can be persisted per workspace (`enableReturnTypeDiskCache`) and is reused on startup when index fingerprint matches.
- Keyword-doc view is best-effort: ambiguous matches or parse quirks show a warning banner, but content still renders.
- Keyword-doc entries include jump links to Python keyword definitions when source locations are indexed.
- Rendered documentation-block hover is off by default via `robotCompanion.enableDocumentationHoverPreview`; variable, enum, and return hovers still work independently inside documentation lines.
- Inline documentation marker guide: `docs/INLINE_DOCUMENTATION.md`.
- Release verification guide: `docs/RELEASE_CHECKLIST.md`.

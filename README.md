# Robot Companion

Robot Companion is a read-only VS Code extension for Robot Framework focused on return/enum/value intelligence, with synchronized markdown documentation rendering in the same companion sidebar.

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

## Views

- `robotCompanion.view` — **Documentation Preview**
- `robotCompanion.returnView` — **Robot Return Explorer**

## Settings

- `robotCompanion.enableCodeLens`
- `robotCompanion.enableHoverPreview`
- `robotCompanion.enableEnumValueHover`
- `robotCompanion.enableEnumArgumentFallback`
- `robotCompanion.enableVariableValueHover`
- `robotCompanion.enableTypedVariableCompletions`
- `robotCompanion.enableReturnMemberCompletions`
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

- Extension behavior is read-only.
- Caches (documentation + enum/type/return index) can be reset via the invalidate command.
- Runtime caches for open Robot files are prewarmed by default so return/argument previews appear faster; technical return details load lazily.
- Return resolution is type-scoped in the worker: repeated variables that resolve to the same return type reuse one cached compute result (including technical tree data).
- `${var.}` member completions in named-argument values reuse the same worker return-type cache (memory + disk); first request may be cold, follow-up keystrokes are cache-first.
- Worker return-type cache can be persisted per workspace (`enableReturnTypeDiskCache`) and is reused on startup when index fingerprint matches.
- Keyword-doc view is best-effort: ambiguous matches or parse quirks show a warning banner, but content still renders.
- Keyword-doc entries include jump links to Python keyword definitions when source locations are indexed.
- Release verification guide: `docs/RELEASE_CHECKLIST.md`.

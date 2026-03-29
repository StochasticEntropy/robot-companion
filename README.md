# Robot Companion

Robot Companion is a read-only VS Code extension for Robot Framework focused on return/enum/value intelligence, with synchronized markdown documentation rendering in the same companion sidebar.

## What it does

- Shows **Documentation Preview** and **Robot Return Explorer** in the same sidebar container (documentation is listed first by default).
- Provides return structure + argument context workflow in **Robot Return Explorer**.
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
- `robotCompanion.enableReturnValueHover`
- `robotCompanion.enableReturnExplorer`
- `robotCompanion.autoSyncSelection`
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
- `robotCompanion.variableHoverLineLimit`

## Notes

- Extension behavior is read-only.
- Caches (documentation + enum/type/return index) can be reset via the invalidate command.
- Release verification guide: `docs/RELEASE_CHECKLIST.md`.

# Release Verification Checklist

Use this checklist before publishing a new Marketplace version.

## 1. Build and Package

- Confirm `package.json` and `package-lock.json` have the same version.
- Run:
  - `npm run package`
- Verify a new `.vsix` was created for the target version.

## 2. Basic Runtime Checks (Extension Development Host)

- Open a `.robot` file with RobotCode enabled.
- Verify Command Palette commands are available:
  - `Robot Companion: Toggle Side Preview`
  - `Robot Companion: Open Current Documentation Block`
  - `Robot Companion: Invalidate All Caches`
- Confirm `Robot Doc Preview` and `Robot Return Explorer` side views load.

## 3. Documentation Preview Checks

- `[Documentation]` blocks render in side preview.
- Cursor sync selects nearest block when moving through file.
- Hover preview shows rendered documentation (if enabled).

## 4. Enum and Return Hint Checks

- Hover named argument values and confirm enum hints resolve.
- If duplicate enum definitions exist, confirm duplicates are collapsed.
- For variable-based argument values, confirm:
  - `Current value` resolves from local `Set Variable` when available.
  - `Return Hint For Argument Value` shows source line.
  - `Jump to assignment line` link navigates to the assignment.

## 5. Cache and Stability Checks

- Run `Robot Companion: Invalidate All Caches`.
- Re-hover and confirm hints still resolve correctly.
- Confirm no hover hard-failures in Extension Host output.

## 6. Publish

- Update `CHANGELOG.md` with the new version entry.
- Run:
  - `npm run publish`
- Verify Marketplace shows the new version.

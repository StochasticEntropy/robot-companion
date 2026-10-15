# Release Verification Checklist

Use this checklist before publishing a new Marketplace version.

## 1. Build and Package

- Confirm `package.json` and `package-lock.json` have the same version.
- Run:
  - `npm run package`
- Verify a new `.vsix` was created for the target version.

## 2. Basic Runtime Checks (Extension Development Host)

- Open a `.robot` file with RobotCode enabled.
- Verify all 14 Command Palette commands are available:
  - `Robot Companion: Focus Return Explorer`
  - `Robot Companion: Open Current Documentation Block`
  - `Robot Companion: Invalidate All Caches`
  - `Robot Companion: Show Output`
  - `Robot Companion: Export Current Documentation as Markdown`
  - `Robot Companion: Export Current Documentation as PDF`
  - `Robot Companion: Export Selected Documentation as Markdown`
  - `Robot Companion: Export Selected Documentation as PDF`
  - `Robot Companion: Use Robot Companion as Default Folding Provider`
  - `Robot Companion: Fold Documentation To Headlines`
  - `Robot Companion: Fold Documentation To Steps`
  - `Robot Companion: Unfold Documentation`
  - `Robot Companion: Run Test at Cursor`
  - `Robot Companion: Run Suite`
- Confirm `Robot Return Explorer` and `Documentation Preview` side views load.

## 3. Documentation Preview Checks

- `[Documentation]` blocks render in side preview.
- Cursor sync shows the current test, task, or keyword's documentation; an undocumented owner does not show another owner's text.
- Hover preview shows rendered documentation (if enabled).
- With the sidebar hidden (`Ctrl+B`), the CodeLens above a block and the hover link reveal the preview at that block.

## 4. Running Tests Checks

- With Robot Framework installed and `robotCompanion.robotCommand` pointing at it, use the *Run Test* CodeLens on a passing and a failing test and *Run Suite* on the header.
- Confirm the `Robot Companion Test Run` output starts with the command line and cwd, the notification states passed / N failed, and *Open Log* / *Open Report* open that run's files.
- Set `robotCompanion.robotCommand` to a missing command and confirm the not-found message names the command and the setting.
- In Restricted Mode, confirm *Run Test* starts nothing and says the workspace must be trusted.

## 5. Enum and Return Hint Checks

- Hover named argument values and confirm enum hints resolve.
- If duplicate enum definitions exist, confirm duplicates are collapsed.
- For variable-based argument values, confirm:
  - `Current value` resolves from local `Set Variable` when available.
  - `Return Hint For Argument Value` shows source line.
  - `Jump to assignment line` link navigates to the assignment.

## 6. Cache and Stability Checks

- Run `Robot Companion: Invalidate All Caches`.
- Re-hover and confirm hints still resolve correctly.
- Confirm no hover hard-failures in Extension Host output.

## 7. Publish

- Update `CHANGELOG.md` with the new version entry.
- Run:
  - `npm run publish`
- Verify Marketplace shows the new version.

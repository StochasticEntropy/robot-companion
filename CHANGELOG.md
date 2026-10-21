# Changelog

## Unreleased

- The native language service now reads `Library    module_name` imports from the selected interpreter's site-packages (its `sys.path`) without importing them: hover with documentation, Go to Definition, completion and the unknown-keyword error for a misspelled call work for a project's installed libraries, and each folder sees only its own interpreter's libraries. Checked in a normal VS Code window with real pointer and keyboard input on Linux for Python 3.11 / RF 7.3.2 and Python 3.13 / RF 7.5 (`npm run test:project-environment`); not yet on Windows.
- Shortened Robot environment warnings in the status bar so the language/provider status remains reachable, with the full diagnostic in the tooltip, and labelled Debug Console environment metadata separately from program output.

- One selected project interpreter per workspace folder now controls the native language, Test Explorer discovery and debug services (`<python> -m robot_companion_backend lsp|discovery|dap`) as well as Run Test, Run Suite and Test Explorer **Run** (`<python> -m robot`). Explicit backend descriptors, `robotCompanion.nativeBackendExecutable` (backend) and `robotCompanion.robotCommand` (runs only) keep precedence; with no interpreter selected the `.venv` backend executable remains the fallback. Before a native service starts, an owned bounded check identifies the interpreter, its Python and Robot Framework versions and the installed backend's version and file digest; **Show Language Service Status**, the `{}` rows, the Robot status tooltip, the output channels and the Debug Console name them, and an interpreter that cannot run the supported backend is refused before anything starts with one notification naming it. A changed selection restarts only that folder's language and discovery services and stops only its debug sessions. Checked with real interpreters and real input in a normal VS Code window (`npm run test:project-environment`): two folders (Python 3.11 / RF 7.3.2 and 3.13 / RF 7.5), overrides, fallback, restart persistence, refusal and Restricted Mode with Trust. Windows has not been checked live. See [one environment for every service](README.md#one-environment-for-language-discovery-debug-and-runs).

- Added **Select Robot Environment** and a clickable Robot status item, with per-folder persisted Python/executable choices, optional Python-extension follow mode, conventional environment discovery and truthful availability/version checks.
- Explicit `robotCompanion.robotCommand` settings retain precedence; selected Python runs as the exact interpreter plus `-m robot`, while standalone/default runs and explicit executable/command behavior remain compatible.
- Added environment-specific recovery and separately confirmed, cancellable `robotframework` installation; detection, optional API activation, runs and installation require workspace trust at execution boundaries.
- A cancelled or timed-out installation or probe now keeps runs blocked, or its probe slot, until the process has exited (forced kill after 250 ms, released at the latest after two seconds). Starting a run during installation says that robotframework is being installed instead of naming a suite. Two quick clicks on the status item leave the new picker open. The README states when availability checks run in a trusted workspace and after trust is granted.
- Added bounded/cancellable probes, stale-flow protection, native keyboard/custom-path checks, synthetic Python-provider lifecycle coverage, two-root checks, real restart (graceful exit and relaunch) and install-confirmation checks driven over CDP, and a separate native Restricted Mode host. Genuine installed Python-provider and live Windows integration remain unverified offline.
- Native backend: class, hybrid and dynamic libraries resolve from their source as Robot Framework creates their keywords (inheritance and overrides, `@keyword` names, `Library    Module.ClassName`), and keyword names passed to `Run Keyword`, `Run Keyword If` and the other BuiltIn run-keyword variants work with F12, hover, completion, references, rename, semantic highlighting and diagnostics. A dotted library name such as `Library    Kits.Tools` now means the module Python imports: a package with `__init__.py`, then `Kits.py`, then a directory `Kits/` without `__init__.py`, so a same-named directory no longer hides `Kits.py`. Unsaved text of open Python library editors is sent to the native backend, so an edit takes effect before saving. Workspace libraries are still only read, never run; what cannot be read statically stays unresolved and unreported. See [Native library and Run Keyword resolution](README.md#native-library-and-run-keyword-resolution).
- Tests only: four UI tests written for the earlier coexistence default now select the mode they check, since this preview defaults to owned mode: the Return Explorer containment check of hostile Python docstrings and the language suite's "coexistence starts nothing" check select coexistence; the Test Explorer combination without `executionBackend` now expects the preview's native default **Debug Test** (README table), and "no Debug Test without a debug service" is checked with a discovery-only `executionBackend`. The provider status check reads the Output view's rows in on-screen order and scrolls it up with the mouse wheel until the **Details** Language and Debug lines are both visible; beside VS Code 1.141's Chat side bar the view is too small to show every Details line at once.
- Tests only: the native backend test venv is also built on Windows (`Scripts\python.exe`, `Scripts\robot-companion-backend.exe`, Python 3.11 or 3.13), `ROBOT_COMPANION_UI_SUITE=native-libraries` runs only the native library resolution UI suite, and `ROBOT_COMPANION_UI_REQUIRE_NATIVE=1` makes a missing native backend, a skipped test or zero executed tests fail the UI run, with per-suite counts in the evidence directory. Not yet run on Windows. See [Development](README.md#development).
- New **Robot Keywords** view and **Search Keywords in Scope** command (native backend): the keywords the current Robot file can call, grouped by the imports Robot Framework resolves, with aliases, *via* nested resources and unresolved imports; never an unimported library. A keyword opens its definition and shows its hover documentation; **Insert Keyword Call** writes a call that resolves to that keyword (`Alias.Name` when needed) with its required arguments as placeholders. See [Robot Keywords view and keyword search](README.md#robot-keywords-view-and-keyword-search).
- Robot Keywords view: a resource imported both by the file and by an imported resource is one group without *via*, its tooltip listing the file's own import line first; a library imported under two names (`AS X` and `AS Y`) inserts `X.Name` / `Y.Name` instead of a plain name Robot Framework reports as ambiguous; and **Insert Keyword Call** in a keyword's context menu explains why when no call text reaches only that keyword. See [Robot Keywords view and keyword search](README.md#robot-keywords-view-and-keyword-search).
- **Rename Symbol** on a Python library keyword named by `@keyword("Name")` now renames the decorator string and every call; other Python library keywords are refused with the reason, and nothing is edited. Native rename edits are versioned, so a file edited meanwhile refuses the whole rename. See [Rename a Python library keyword](README.md#rename-a-python-library-keyword).
- Documentation Preview and Return Explorer: their own command links (the preview's toolbar, subtitle and overview, the explorer's Jump to keyword definition) now run their command through the preview's allowlisted message. VS Code ignored a link click when workbench focus left the view during the click (for example, an editor still taking focus from the previous link), so the click did nothing. Links inside rendered documentation are unchanged. Tests only: the containment test's clicks now require the control to report the trusted click.

## 1.3.0 — prerelease

- Experimental native-backend preview with source provenance and artifact hashes in the release download. Native language, debug and discovery are the default; the restricted `robotCompanion.nativeBackendExecutable` setting selects the project environment. RobotCode remains optional through advanced descriptors. No automatic installation.
- Windows qualification is incomplete. This combined preview has targeted validation; complete Windows qualification remains pending.

## Previously unreleased implementation work

- Owned mode now exposes the language server's semantic tokens as semantic highlighting, only when the server advertises `semanticTokensProvider` and with exactly its legend: whole-document tokens for `full`, visible-range tokens for `range`; semantic token deltas are never requested. A server's `workspace/semanticTokens/refresh` makes VS Code ask again, and data outside the legend is refused. The native backend 0.1.0.dev1 offers whole-document and range tokens (keyword calls are `function`, with `resolved` when the call resolves through the file's imports; variables, settings as `property`, section headers as `namespace`), coloured by the default themes. The pinned RobotCode 2.7.0 bridge offers whole-document tokens in RobotCode's own legend (`keywordCall`, `settingImport`, `headerTestcase`, …); without the RobotCode VS Code extension's colour mappings only LSP-type tokens such as `variable` are coloured, and the README shows `editor.semanticTokenColorCustomizations` rules for the others. Coexistence mode registers none and Restricted Mode starts no process; Robot Companion still contributes no TextMate grammar. Checked live with both providers at 1280x900 with actual input (**Developer: Inspect Editor Tokens and Scopes** from the Command Palette, also on a line with umlauts and non-BMP characters); gating with a local protocol fixture. Inlay hints and semantic token deltas are not exposed. See [owned semantic highlighting](README.md#owned-semantic-highlighting).
- Owned mode now exposes the language server's code actions (lightbulb, **Quick Fix** Ctrl/Cmd+., **Refactor...**, **Source Action...**), **Format Document** and **Format Selection**, each only when the server advertises it; coexistence mode registers none and Restricted Mode starts no process. Code action edits are fetched with `codeAction/resolve` when the server supports it and follow the same rules as rename edits; actions that would only run a command Robot Companion does not know are not offered. Problems view entries now show the server's diagnostic code. With the native backend (built with its `format` extra): **Import resource …** / **Import library …** for a keyword that only one unimported workspace file defines, **Use Library.Keyword (file)** to qualify an ambiguous call, and Robocop 9.1.0 formatting; the native backend offers no range formatting (Format Selection), refactorings or source actions. With RobotCode 2.7.0: **Create Keyword**, its variable and argument fixes, **Extract keyword**, **Surround with TRY…** and **Assign keyword result to variable**, Format Document and Format Selection; its **Open Documentation** source action is not offered, and the selection RobotCode makes after an edit is done by Robot Companion. Checked live with actual keyboard and pointer input at 1280x900; gating with a local protocol fixture. See [owned code actions and formatting](README.md#owned-code-actions-and-formatting).
- Register Robot Framework files and add an opt-in owned language service with explicit workspace-host launch descriptors, document synchronization, definition navigation and diagnostics; coexistence remains the default. See [experimental configuration and limits](README.md#experimental-owned-language-service).
- Bound owned language-process cleanup during stalled startup/shutdown and broken input pipes, and prevent duplicate definition requests and file notifications from overlapping workspace folders.
- Add experimental owned Test Explorer discovery. When `robotCompanion.executionBackend` has a discovery service, its tests appear under **Robot Companion** with IDs built from the file URI and test name. A click opens the test's source. Discovery failures show as an error item. Coexistence mode and backends without discovery register no test controller. Discovery is also checked with a local discovery fixture; running is described in the Test Explorer run entry below. See [owned Test Explorer discovery](README.md#experimental-owned-test-explorer-discovery).
- Add an experimental owned **Robot Companion** debug type for owned mode. It is selected through the new `robotCompanion.executionBackend` descriptor, independently of the language service, and starts one owned stdio adapter process per session without a shell. It reports capabilities the backend does not advertise in the Debug Console, and on stop sends `disconnect`, then terminates and kills the process if it does not exit. Coexistence mode, Restricted Mode and invalid or debug-less descriptors start nothing. Lifecycle checked with a local DAP fixture; RobotCode debugging is listed below. See [the owned debug type](README.md#experimental-owned-debug-type).
- Add a pinned RobotCode 2.7.0 language bridge for experimental owned mode. A `robotCompanion.languageBackend` descriptor with `"id": "robotcode"` runs the RobotCode 2.7.0 Python language server (`python -m robotcode.cli language-server --stdio`) from an environment you prepare, without the RobotCode VS Code extension. Robot Companion refuses the service, with both versions named in the **Robot Companion Language** output, if the descriptor or the running server is not 2.7.0, and starts RobotCode's documentation web server only on demand so no port is opened. Owned language processes now get two seconds to shut down cleanly, and their input is closed after `exit`. Checked against the real RobotCode 2.7.0 / Robot Framework 7.5 packages: imported, resource, local and aliased keywords resolve correctly, an unimported same-named `AShadow.py` keyword is never chosen, and F12, Peek, Ctrl-click and the Return Explorer link open `AuditLibrary.py` line 12. See [the RobotCode bridge](README.md#pinned-robotcode-270-language-bridge).
- Test Explorer can discover tests with the pinned RobotCode 2.7.0 packages (`robotcode discover tests`, described as the `discovery` service of a `robotcode` execution backend). Results of a Test Explorer run now come from each test's entry in the run's `output.xml`: passed, failed with Robot's message, or skipped. The run's exit outcome is used only when there is no such entry. See [owned Test Explorer discovery](README.md#experimental-owned-test-explorer-discovery).
- Debug Robot tests with the pinned RobotCode 2.7.0 Python packages through the owned **Robot Companion** debug type, without the RobotCode, Python or debugpy VS Code extensions. You get Robot breakpoints, stepping, variables and Robot keywords typed into the Debug Console. A **Python:** child session stops on Python breakpoints, steps and evaluates Python; selecting a Robot frame sends console input back to Robot. Python breakpoints can now be set in `.py` files. Each debug run writes to its own results folder, adds `robotCompanion.robotArguments`, and on stop ends every process the session started. See [the owned debug type](README.md#experimental-owned-debug-type).
- Test Explorer in owned mode now runs real Robot Framework for a multi-selection (also across suites), a suite or everything: one Robot run per suite file with `robotCompanion.robotCommand`, `--test` filters for the selected tests and an output folder of its own, instead of one CodeLens-runner call per test. Each test's result (Passed, Failed with Robot's message at the test's source line, Skipped) comes only from its own run's `output.xml`. **Rerun Failed Tests** runs only the failed tests. **Stop** ends the Robot process group (SIGTERM, then SIGKILL after two seconds) and marks unfinished tests **Skipped**. During **Debug Test**, the Testing Stop and the debug toolbar Stop end the session; when the debug backend does not end it by itself, Robot Companion ends the debug adapter's process group (RobotCode, Robot and Robot's child processes) within a few seconds. The same bounded stop now applies to any owned debug session whose backend leaves a disconnect unanswered. **Debug Test** starts the owned **Robot Companion** debug type for exactly the selected tests and reports the result when the session ends. Checked live with actual clicks in VS Code against Robot Framework 7.5 and RobotCode 2.7.0. Coverage, continuous run, tag/filter profiles and live per-test progress are not supported yet. See [Test Explorer run, debug, rerun and Stop](README.md#test-explorer-run-debug-rerun-and-stop).
- Owned RobotCode debugging: the Debug Console no longer shows RobotCode's internal "start debugpy session on port …" line. It now shows the test's `Log` messages, each with its source line, next to Robot's console output; `"outputLog": false` in the launch configuration leaves them out. While a Python child session is paused, Call Stack keeps the Robot session, with the Python session under it. debugpy's frozen-modules warning on Python 3.13 still appears; Robot Companion does not change your environment to hide it.
- In coexistence mode, choosing **Robot Companion** in Run and Debug's debugger list now shows the explanation that its debugging needs owned mode, instead of asking for a `.robot` file. It still starts nothing.
- README: one complete owned-mode JSON example for RobotCode debugging and Test Explorer discovery (checked against the bridge's descriptor by a test), and corrected statements on RobotCode discovery and workspace trust. Trust transitions were checked in a normal VS Code window: Restricted Mode starts no backend process, **Trust** starts it, **Don't Trust** restarts the extension host and the process is gone. `npm run test:trust` repeats that check.
- Owned mode now exposes the language server's hover, completion, signature help, references, rename, and document and workspace symbols in VS Code, each only when the server advertises it; coexistence mode registers none of them. Robot Companion's hover sections and the server's hover appear in one hover, Companion's first with their links; a server paragraph Companion already shows is left out, so a keyword's documentation appears once. A server suggestion repeating a Companion completion is left out. Rename applies the server's edit across the workspace folder's files and shows the server's message when it refuses. With the pinned RobotCode 2.7.0 bridge all of these are on (Robot Companion now declares client support for them); Go to References on `Build Record` never lists the unimported `AShadow.py`. Checked live with actual pointer and keyboard input at 1280x900; gating is checked with a local protocol fixture. Inlay hints are not exposed; code actions, formatting and semantic tokens are exposed as described in the entries above. See [owned hover, completion, references, rename and symbols](README.md#owned-hover-completion-references-rename-and-symbols).
- Owned mode can now use the independent native backend (`robot-companion-backend`, built from this repository's `backend/`, version 0.1.0.dev1) for the language service, for debugging, or both, with the pinned RobotCode 2.7.0 bridge kept as the alternative. `robotCompanion.languageBackend` and `robotCompanion.executionBackend` each select a provider by descriptor (`"id": "robot-companion-native"` with `robot-companion-backend lsp` / `dap`, or `"id": "robotcode"`); all four combinations work and switching either one stops only that side's old processes. The `{}` language status entry shows the active *Language*, *Debug* and *Tests* provider with the number of capabilities it advertises; **Details** lists them in full. A descriptor with another `contractVersion`, an unsupported declared version or a missing executable is refused before anything starts, with both values (or the path) named in an error notification. Native debugging supports the same Robot console, Python child session, Call Stack frame selection and process cleanup as RobotCode through the native debugpy handoff v1, and **Debug Test** uses it. The optional `robotCompanion.discoveryBackend` setting supplies Test Explorer discovery from its own descriptor next to native debugging (RobotCode or native discovery); without a discovery service the CodeLens runner is the fallback. Language shutdown now sends `shutdown` without `params: null`, which the native backend rejects as invalid JSON-RPC. `npm run test:all` builds the native backend offline into its own venv (no RobotCode in it) and runs the live native, RobotCode and mixed cases with actual input, and `npm run test:trust` checks Restricted Mode for both providers. See [choosing the provider](README.md#choosing-the-provider-native-backend-or-robotcode) for the configuration, verified combinations and what remains before full parity.
- Native debugging and **Debug Test** with the native backend now end quietly: the routine *Python session ended: …* line of the **Python:** child session goes to the Debug Console instead of an information notification, and a stack, scopes, variables or console request VS Code still sends after the run continued (*Robot worker is not paused*) no longer shows an error notification. The backend reports an abrupt debugpy exit with the same text, so that case is also only in the Debug Console; a Python session lost to any other reported error is still notified. Checked with actual input at 1280x900.
- Test Explorer can now list tests with the native backend's discovery service (`robot-companion-backend discovery`, the normalized discovery API v1), so native mode needs no RobotCode for Test Explorer items. Add a `discovery` service with `"argv": ["discovery"]` to the native `robotCompanion.executionBackend` (or use it as `robotCompanion.discoveryBackend`); the *Tests* status row names the native backend and the setting its discovery comes from. Suites are the backend's file suites with Robot Framework's names, including `*** Tasks ***` files, names with umlauts or non-BMP characters, and repeated test names as separate items that each report their own result. A test whose name contains a variable (`Login On ${ENVIRONMENT}`, listed as `Login On staging`) is now selected for Run and Debug Test by its written name, because Robot matches `--test` before replacing variables; this applies to every discovery provider. Each result is now matched to its test by the test's name line in `output.xml` (then by occurrence), so a test selected next to another test with the same reported name still gets its own result. Files the backend could not read or parse completely appear as error items next to the tree, and the status row shows a warning. A discovery service that cannot start, crashes or answers with a JSON-RPC error now also shows an error notification, empties the folder's tree instead of keeping it stale, and never stops the language service or debugging; **Refresh Tests** starts it again and also picks up files added, renamed or deleted on disk. A failed rediscovery on save is now reported the same way instead of being ignored. Only a folder's newest discovery request counts: when an older request fails or times out after a newer one has succeeded, the newer tree stays, no notification is shown and the discovery service keeps running, both for rediscovery on save and for **Refresh Tests**. Discovery replies may be up to 64 MiB, as the native service allows. Checked live with actual input at 1280x900 against Robot Framework 7.5 with no RobotCode extension, package or process. See [owned Test Explorer discovery](README.md#experimental-owned-test-explorer-discovery) and the [combination table](README.md#choosing-the-provider-native-backend-or-robotcode).
- In experimental owned mode, the Return Explorer's **Jump to keyword definition** link and the keyword docstring, return and enum details use the language server's single resolved definition, so an imported library keyword no longer resolves to an unimported same-named function. No or several server targets show a notice without a link; a click re-resolves the link and opens nothing if the target no longer matches. Owned documents skip the return-preview cache and prewarm. Coexistence mode is unchanged.

## 1.1.0

- Added running Robot tests from the editor. A **Run Test** CodeLens on every test or task name and a **Run Suite** CodeLens on the `*** Test Cases ***` / `*** Tasks ***` header, plus the commands *Run Test at Cursor* and *Run Suite* (Command Palette, editor and Explorer context menus), run one test or the whole `.robot` file with the configured Robot Framework. The command comes from the new setting `robotCompanion.robotCommand` (default `robot`, also `python3 -m robot` or an absolute path), extra arguments from `robotCompanion.robotArguments`; the process starts without a shell in the file's workspace folder, glob characters in test names are escaped so only that test runs, and unsaved edits are saved first. Output streams into the **Robot Companion Test Run** channel; one notification reports passed, the number of failed tests, or why Robot Framework could not run, with *Open Log*, *Open Report* and *Show Output*. Each run writes its results to its own folder in the extension's workspace storage. `robotCompanion.enableRunCodeLens` hides the CodeLenses.
- Running tests requires a trusted workspace. The extension now declares limited Restricted Mode support: in an untrusted workspace the run commands start nothing and say why, `robotCompanion.robotCommand` and `robotCompanion.robotArguments` are restricted settings, and the read-only features (preview, hovers, Return Explorer, folding), which previously were disabled there, stay available.
- Hardened the Documentation Preview, the Return Explorer and the printable documentation export against workspace-authored HTML. Each page now sets a Content Security Policy that only lets the extension's own script run, so an inline `<script>` or an `onerror` handler in `[Documentation]` no longer executes. `command:` links in the preview run only Robot Companion's own commands (opening a test or keyword, folding, export); a link to any other command, such as one that opens a terminal, does nothing. Both apply in trusted and Restricted Mode. The README and the documentation site no longer claim that arbitrary HTML is rendered as plain text; only malformed color tags are.
- Restricted where documentation links may lead. A `command:` link in the Documentation Preview, the Return Explorer or a Robot Companion hover that opens a location, opens a documentation block, previews or inserts a keyword argument, or exports documentation now acts only on a file inside an open workspace folder or on the document already in view (the active editor, or the one the Documentation Preview or Return Explorer shows). The path is normalised first, so a `..` path cannot leave the workspace folder. Any other target, such as `file:///etc/hostname`, a file outside the workspace, or an `untitled:`, `vscode-userdata:` or `https:` URI, opens, reads and exports nothing; a warning naming the refused command goes to the **Robot Companion** output channel. The extension's own links keep working, including for a single `.robot` file opened without a workspace folder while it is in view; a jump from such a file into another file outside the workspace is now refused.
- The fold commands *Fold Documentation To Headlines*, *Fold Documentation To Steps* and *Unfold Documentation* now follow the same documentation link-target rule when a link passes them a document: they load, open and fold only a file inside an open workspace folder or the document in view, and refuse anything else, such as `file:///etc/hostname`, a `..` path out of the workspace or an `untitled:` or `https:` URI, with a warning naming the command in the **Robot Companion** output channel. The preview's own Headlines / Steps / Unfold links and the commands run without an argument from the Command Palette or a keybinding work as before.
- In Restricted Mode the documentation webviews (Documentation Preview, Return Explorer, PDF/print export, including the copy opened in the browser) no longer load remote images: an `<img src="https://…">` or `![x](https://…)` in documentation stays blank. Images from the webview's own resource source and `data:` images still display, and a trusted workspace is unchanged. When trust is granted, the open views re-render and remote images load.
- Documentation can no longer restyle or cover the controls of the three documentation webviews. Their Content Security Policy now allows only the extension's own stylesheet and the style values it generates itself (custom colors, arrow-line indentation), so a `<style>` element or a `style=` attribute written in documentation, such as a `position:fixed` overlay, is ignored, and a `<link>` element in documentation (which could load a stylesheet from the workspace) is neutralised. Rendered documentation also paints only inside its own area, so an oversized or overflowing element, such as an SVG shape, cannot cover the controls. Color tags, arrow-line indentation and PDF page breaks render as before.
- Documentation now stays inside its own area in the three documentation webviews. Each documentation fragment is rendered self-contained: closing tags without a matching opening tag, such as a stray `</section>` or `</div>`, are dropped and every element it opens is closed inside it, so documentation can no longer close the extension's container and draw an SVG or other content over the controls. In the Return Explorer the docstring has its own area, and the extension's links next to it, such as **Jump to keyword definition**, are outside it and stacked above it. The stylesheet also overrides an SVG's `overflow` attribute. The previous entry's statement that documentation paints only inside its own area held only for documentation without stray closing tags; it now holds for those too.
- Fixed Documentation Preview selection so an undocumented keyword shows no inherited text from a documented neighbor, while saved Robot source edits refresh the selected content.

## 1.0.1

- Fixed Documentation Preview test and keyword selection to open the owning source line, while unresolved targets leave the editor in place.
- Fixed the CodeLens *Open rendered documentation preview* and the hover link *Open full rendered preview* to reveal the Documentation Preview at their block again, including when the sidebar is hidden; the overview selection change above had made them only move the cursor.
- Added `robotCompanion.umlautDecoratorNames` and `robotCompanion.umlautExcludeSymbols`. The decorator that maps ASCII argument spellings onto diacritic ones, and the module-level list of keys it leaves alone, were matched by hardcoded name; both are now settings whose defaults are the names the extension has always looked for, so existing workspaces are unaffected while a project that names them differently can say so. Names are escaped before they reach a regular expression, an empty list falls back to the default, and changing either setting invalidates the index.
- Rewrote two documentation fixtures whose example arithmetic did not add up and whose dates and amounts used a locale the rest of the file did not. The structure the folding and preview tests assert against is unchanged.

## 1.0.0

First stable release. The extension has been in daily use by a team for
several months; this version marks the public surface — the `robotCompanion.`
settings, the twelve palette commands, and the `#>` documentation markers — as
one that will be treated as a compatibility contract from here on.

- Added `robotCompanion.camelCaseAliasBaseNames`, which lists the base class names that mark a Python type whose `snake_case` attributes are also readable in camelCase. This was previously a hardcoded substring test, so `robotCompanion.returnFieldNameStyle` only had an effect in projects whose converter base happened to be named a particular way. The default is `["camelcase"]` — exactly the previous rule — so existing workspaces are unaffected, while a project whose converter base is named differently can now enable the feature, or empty the list to switch aliasing off.
- Published the documentation as a site: an overview and a full reference covering every capability, its limits, and the project prerequisites that decide whether the Python-derived features can work at all.

## 0.4.118

- Removed four command registrations that were unreachable: two fold commands that were byte-identical to `Fold Documentation To Steps` apart from their error text, and two overview fold commands referenced nowhere. None of them appeared in the command palette.
- Removed a dead branch in the Python create/delete handlers that tested a property the value never carries, so it always fell through to a full worker invalidation. Behavior is unchanged; the code no longer claims a precision it did not have.
- Corrected the cache design notes, which still described a workspace-wide index rebuild on Python save (per-file since 0.4.9), named the wrong invalidation call, and described the pre-0.4.68 debug-session pause.
- Listed all twelve palette commands in the release checklist instead of three.

## 0.4.117

- Joined source-wrapped inline bullets, arrow notes, and plain documentation comments into flowing rendered lines.
- Applied the same wrapping behavior to Robot `[Documentation]` continuation rows.
- Preserved explicit `<br>` tags as intentional rendered line breaks, including inside arrow notes.

## 0.4.109

- Added a documentation overview switch to show or hide keyword entries.
- Kept keywords visible by default and stored the switch state only in the current preview webview session.

## 0.4.108

- Replaced unambiguous local `Set Variable` / `VAR` tokens with their values in rendered documentation preview text.
- Kept ambiguous, unknown, and fenced-code documentation variables unchanged.
- Labeled keyword documentation owner jumps as `Jump to keyword` instead of `Jump to testcase`.

## 0.4.107

- Allowed keyword documentation `Insert` actions during active Robot debug sessions while keeping broader editor-manipulation actions, such as folding, protected.

## 0.4.106

- Pinned VSCE packaging and publishing to the local `@vscode/vsce` 3.8.0 dependency to avoid the 3.9.0 credential-store regression.
- Fixed documentation previews that only have keyword-returned variables so their returned-variable section is visible instead of hidden behind a missing toggle.
- Improved conditional variable resolution when a variable has a base value and only one branch overrides it, showing the base and branch values as ambiguous candidates.

## 0.4.105

- Aligned plain continuation lines after custom `->` / `=>` documentation markers under the arrow text, matching normal Markdown list continuation indentation.
- Preserved separate source jump targets for arrow continuation lines while keeping following Markdown list items rendered normally.

## 0.4.104

- Kept fallback argument hovers focused on the variable under the cursor for keyword-return/member variables embedded inside longer strings.
- Added regression coverage for `prefix${variable}${return.member}postfix`, so postfix text no longer causes the hint to fall back to the whole argument value.

## 0.4.103

- Resolved local variable hovers inside named-argument string values when the cursor is on a variable anywhere in the string, including prefix, postfix, and surrounded text cases.
- Kept plain-text argument hover behavior unchanged when the cursor is not on an embedded variable.

## 0.4.102

- Fixed inline `#>> ->` preview lines so source-jump markers are inserted after the visible arrow marker instead of before it, allowing those lines to actually receive the arrow hanging-indent DOM.
- Adjusted custom documentation `->` / `=>` preview lines to render as a fixed marker plus a flexing body column, so wrapped text aligns after the arrow marker reliably in narrow VS Code webviews.
- Kept the existing arrow marker rendering, source jump targets, folding behavior, and Robot source format unchanged.
- Added focused regressions that verify real fixtures render arrow-line surfaces, and verified the existing UI preview-click suite still passes.

## 0.4.91

- Added a real documentation-preview click UI regression that walks every rendered source target in the involved fixtures, clicks it through the managed webview bridge, and verifies the exact source jump in VS Code.
- Fixed preview click binding for blocks that render multiple source-target markers inside the same markdown block, so neighboring lines no longer get grouped onto one later jump target.
- This specifically closes the gap where the old suite only spot-checked a subset of lines and missed grouped later targets in fixtures such as `folding-regression-refund.robot`.

## 0.4.90

- Replaced documentation preview source-jump binding by DOM order with explicit per-item target markers embedded in the rendered markdown.
- This fixes later links drifting to the wrong source lines when the markdown renderer shapes the preview differently than the target list expected.
- Added focused regressions for marker injection and kept the full VS Code UI suite green.

## 0.4.89

- Hardened documentation preview line-click handling against text-node event targets before calling `closest(...)`.
- This targets hosts where documentation lines rendered correctly but clicking plain text inside them did nothing.
- Added a focused regression that locks in the text-node fallback path in the preview webview script.

## 0.4.88

- Fixed documentation preview line clicks by routing them through the managed webview message bridge instead of relying on the older hidden-anchor command trigger.
- This specifically targets hosts where documentation lines rendered with source targets but did not react when clicked.
- Added a focused regression for the documentation-preview click bridge while keeping the full UI suite green.

## 0.4.87

- Switched documentation preview source jumps from the older hidden-anchor trigger to the same managed webview message bridge used by the keyword-doc panel.
- This targets hosts where documentation lines rendered correctly but clicking them did not trigger the jump command.
- Added a focused regression for the managed documentation-preview click bridge and kept the full VS Code UI suite green.

## 0.4.86

- Fixed leaked `[[RDP_INDENT_*]]` placeholders in the documentation preview by expanding arrow indentation into real rendered HTML before the preview is shown.
- This especially fixes scenarios with a structured top `[Documentation]` block that contains bullet continuation arrow lines.
- Added a dedicated fixture for that documentation style and extended both node and VS Code UI regressions to assert that arrow lines render with indentation and no raw placeholder tokens.

## 0.4.85

- Fixed preview jump-target alignment for testcases that combine a structured `[Documentation]` block at the top with later inline `#>` / `#>>` documentation comments.
- `[Documentation]` content now splits into heading, list, and paragraph targets so later inline proof lines no longer drift to the wrong source lines.
- Added both a compact and a more involved mixed-documentation fixture, plus UI coverage for that mixed documentation style.

## 0.4.84

- Promoted the Windows keyword-doc `Args` action fix to a normal release.
- Keyword argument preview and `Insert` in the return explorer now use an explicit webview message bridge instead of relying on platform-dependent link execution.
- Managed argument links in that panel now match the surrounding styling more closely and no longer force underline behavior.

## 0.4.83

- Switched keyword documentation `Args` actions in the return explorer from raw link execution to an explicit webview message bridge.
- This targets the Windows case where clicking argument names or `Insert` in the keyword docs panel did nothing even though normal documentation jumps still worked.
- Styled those managed argument links to match the rest of the companion panel more closely, without forced underlines.

## 0.4.82

- Routed keyword documentation `Args` clicks for argument preview and `Insert` through the preview's managed click handling so they no longer depend on raw markdown `command:` link behavior.
- This specifically targets the Windows case where clicking argument names or `Insert` in the keyword docs view did not trigger anything.

## 0.4.81

- Made the Python keyword indexer decorator-aware for `@convert_umlaut_kwargs`, so Companion now exposes Robot-facing umlaut argument names instead of raw ASCII Python names.
- Keyword docs, argument preview/jump, and missing-argument `Insert` links now use the decorated argument spelling, while lookup still accepts both ASCII and umlaut forms.
- The shared `_exclude_umlaut_kwargs` defaults are read from the workspace module that declares them, with a safe fallback for unsupported dynamic exclude expressions.

## 0.4.80

- Added inline `Insert` links for missing named arguments in the keyword documentation `Args` view.
- Clicking `Insert` now adds an aligned Robot continuation line as `...    argName=`, places the caret after `=`, and opens suggestions immediately.
- Used arguments keep their existing preview/jump behavior, and repeated clicks now focus an already-present argument instead of inserting duplicates.

## 0.4.79

- Made ambiguous values in the documentation preview Variables section individually clickable so each possible value can jump to its own assignment line.
- This now works for branch ambiguity, mixed keyword-return plus local assignment ambiguity, and repeated sequential reassignments.

## 0.4.78

- Updated the documentation preview Variables section to mark a variable as ambiguous whenever the testcase contains multiple distinct assignments for it, not just conditional branch conflicts.
- Mixed cases that combine keyword-return assignments and `Set Variable` assignments now show all distinct values in the Variables section.
- Sequential reassignments like `2025-04-17` and `2025-05-23` now also render as an ambiguous combined row in the testcase-level Variables view.

## 0.4.77

- Fixed the documentation preview Variables section so mixed branch cases can resolve across local `Set Variable` assignments and keyword-return assignments for the same variable.
- Ambiguous rows like `${PdfContent}` now show combined possible values instead of incorrectly collapsing to `${None}` when one branch comes from a keyword return.

## 0.4.76

- Tightened the documentation preview Variables section spacing to restore the denser, easier-to-scan bullet-list presentation.
- Reduced row, heading, and toggle spacing in the variable sections so long lists read more like the earlier preview style.

## 0.4.75

- Restored the documentation preview Variables section to the simpler bullet-list style for easier scanning.
- Moved the returned-variable toggle out of the preview action bar and into the Variables section so it applies only to the currently shown testcase/keyword.
- Returned variables now stay hidden by default and expand only within the current preview block when requested.

## 0.4.74

- Split the documentation preview variable area into a merged local `Variables` section and a separate toggleable `Returned Variables` section.
- The main Variables section now stays focused on `VAR` and `Set Variable`, collapsing duplicate end states and showing compact ambiguity hints for conditional values.
- Added regression coverage for the new preview toggle, local-only summary rendering, and returned-variable history behavior.

## 0.4.73

- Added conditional local-variable resolution for `IF/ELSE/ELSE IF` branches so hover and argument hints no longer collapse to a misleading single branch value like `${None}`.
- Local variable hover and named-argument current-value hints now show multiple candidate values when a variable is assigned in mutually exclusive branches before use.
- Added regression coverage for two-branch, `ELSE IF`, nested branch, and post-`END` overwrite scenarios.

## 0.4.72

- Simplified the documentation view Variables section so entries render as `variable: value` without the visible `(source, line)` annotation text.
- Kept both `VAR` and `Set Variable` definitions in the Variables section, while leaving line navigation available through the clickable entries.
- Added regression coverage for the lighter Variables-section presentation.

## 0.4.71

- Added a Variables section to the documentation view so locally defined `VAR` and `Set Variable` values are shown at the end of the rendered documentation block.
- Each variable entry links back to its defining line for quick navigation from the documentation preview.
- Added regression coverage for documentation rendering and source-target mapping of the new variables section.

## 0.4.70

- Kept hover, the documentation preview, and the documentation views available during Robot debug sessions instead of pausing them completely.
- Continued to block explicit editor-manipulation actions during Robot debugging so fold/reset commands do not interfere with RobotCode sessions.
- Promoted the debug-session behavior update from pre-release to stable release.

## 0.4.69

- Kept hover, the documentation preview, and the documentation views available during Robot debug sessions instead of pausing them completely.
- Continued to block explicit editor-manipulation actions during Robot debugging so fold/reset commands do not interfere with RobotCode sessions.
- Added regression coverage for the refined debug-session policy split.

## 0.4.68

- Relaxed the Robot debug-session pause behavior so passive editor features like hover, completions, and folding remain available.
- Kept active preview syncing and background prewarm paused during Robot debugging to reduce the risk of interfering with RobotCode debug sessions.
- Added regression coverage for the new debug pause policy split.

## 0.4.67

- Fixed local variable hover resolution inside concatenated named-argument values such as `${Prefix}${Result.id}`.
- Hover and return-hint resolution now target the exact variable under the cursor instead of requiring the whole argument value to be a single variable token.
- Added regression coverage for concatenated local `VAR` and typed-variable hover resolution.

## 0.4.66

- Added hover support for Robot Framework 7 local `VAR` assignments such as `VAR    ${name}    value`.
- Added support for typed variable names like `${name: date}` in local variable lookups, including typed `Set Variable` assignments.
- Variable-value hovers and related value-source displays now show whether the resolved value came from `VAR` or `Set Variable`.

## 0.4.65

- Renamed the Documentation Preview fold action from `Level 3` back to `Headlines`.
- Replaced separate `Level 4` and `Level 5` preview actions with one combined `Steps` action that folds both `#>` step markers and nested `#>>` markers together.
- Updated the parser and real VS Code UI regression suites to validate the combined step-fold behavior and the current large adjustment fixture shape.

## 0.4.64

- Fixed the remaining EOF headline folding edge case where the last documentation headline could reopen when its body reached the end of the testcase or keyword.
- The terminal exact-tier fallback now uses a targeted recursive fold on the last marker line instead of the broader range-based fallback, which keeps EOF behavior aligned with the “next testcase exists” case.
- Added and validated a real VS Code UI assertion for the final headline staying folded at EOF while keeping the larger adjustment fixture independent from local trailing-owner edits.

## 0.4.63

- Packaged the exact folding state that passed the clean `38`-test VS Code UI regression run after removing the stale `.vscode-test` Code instance.
- Preview `Level 3/4/5` now keep the exact-tier provider active, refocus the Robot editor during reset and fold application, and use targeted fold lines instead of broad `Fold All`.
- Added repeated preview-click coverage on the large adjustment fixture so the “first click works, later clicks fold everything” path stays under test.

## 0.4.62

- Fixed a repeated-click preview folding regression where the first `Level 3/4/5` action could work but later clicks could fall back to broad section or testcase folding again.
- The exact-tier fold commands now re-focus the target Robot editor immediately before folding and retry provider-range synchronization instead of giving up on a transient mismatch.
- Added a real VS Code UI regression that repeats preview fold clicks on the large adjustment fixture to keep this timing path covered.

## 0.4.61

- Fixed a live-window timing issue where preview `Level 3/4/5` could still fold section or testcase wrappers if VS Code applied `Fold All` before the narrowed documentation-tier ranges were active.
- The preview fold commands now wait for the folding provider to report the expected exact-tier ranges before folding, so the behavior matches the checked-in UI regression suite in normal VS Code windows as well.

## 0.4.60

- Fixed preview `Level 3/4/5` folding by restoring a deterministic provider-driven exact-tier mode, so testcase/owner wrapper folds no longer override documentation headline, first-level, or second-level folds.
- Cleared existing wrapper folds before narrowing the provider tier, and kept blank-line folding behavior aligned with the default provider so cursor jumps stay correct on large fixtures and later documentation sections.
- Expanded the real VS Code UI suite to assert active provider ranges as well as cursor navigation for direct and preview-triggered folding on the checked-in large fixtures.

## 0.4.59

- Replaced the preview `Level 3/4/5` actions with exact documentation-tier folding so wrapper folds and other fold providers no longer change which sections collapse.
- Kept the preview-source jump fixes and restored deterministic folding on the large adjustment fixture in the real VS Code UI suite.

## 0.4.58

- Fixed the remaining headline-fold edge case where the last documentation headline could stay open at end-of-file or just before the next testcase when folding from the preview.
- Added real VS Code regression coverage for terminal headline folding at EOF and before a following owner, including preview-triggered folding from a non-robot editor.

## 0.4.57

- Restored the Documentation Preview to a single continuous markdown render so nested lists and arrow lines keep the cleaner pre-`0.4.56` layout.
- Kept the corrected later `#>> ->` source jumps by moving the precise click-target mapping into the preview DOM instead of splitting the markdown into separate rendered fragments.

## 0.4.56

- Fixed Documentation Preview source jumps for later `#>> ->` lines by rendering arrow lines as their own clickable preview items.
- Added real VS Code regression coverage that executes the later preview source-target commands in the large adjustment fixture and verifies they land on the expected lines.

## 0.4.55

- Added stronger checked-in VS Code folding regressions for the generic large Robot fixtures, including the new adjustment scenario.
- Verified direct-editor and preview-triggered folding jumps in a real Extension Development Host instead of relying only on parser-level range tests.
- Made preview/native fold commands cursor-independent so folding no longer changes behavior based on the current caret position.

## 0.4.54

- Cleaned up folding regression scaffolding after the preview-folding iteration.
- Checked in generic large Robot fixtures so UI folding tests run from the repository itself.
- Kept the preview fold actions aligned with VS Code native `Level 3`, `Level 4`, and `Level 5`.

## 0.4.53

- Restored the underlying documentation folding behavior from `0.4.51`.
- Kept the Documentation Preview fold actions on VS Code's native folding commands:
  - `Level 3` for headlines
  - `Level 4` for first-level markers
  - `Level 5` for second-level markers
- Preview fold actions still run `Unfold All` before applying the requested native fold level.

## 0.4.52

- Switched Documentation Preview `Fold To` actions to VS Code's native folding levels:
  - `Level 3` for headlines
  - `Level 4` for first-level documentation markers
  - `Level 5` for second-level documentation markers
- Preview fold actions now reset the editor with `Unfold All` before applying the requested fold level.

## 0.4.51

- Switched the Documentation Preview fold links from cumulative tiers to exact marker classes, so `Headlines` targets heading docs, `First Level` targets top-level `#>` lines, and `Second Level` targets nested `#>>` lines instead of overlapping one another.
- Updated the fold link labels and command titles to show the marker classes directly, which makes it easier to verify which documentation tier is being folded from the preview.

## 0.4.50

- Isolated the custom Documentation Preview fold tiers from the default documentation folding provider so the body-only fold commands stop competing with the normal headline and `#>` fold ranges.
- Scoped the temporary custom fold mode to the active document, which makes the fold links behave more predictably instead of leaving Robot files in a mixed folding state.

## 0.4.49

- Retuned the Documentation Preview fold links so `Headlines` and `First Level` produce the stronger overview, while `Second Level` leaves the deeper nested `#>>` sections more expanded instead of the other way around.
- Applied the custom documentation fold and unfold actions line by line to make heading-attached bodies fold more reliably instead of being skipped in a bulk command.

## 0.4.48

- Added Robot Companion fold commands for Headlines, First Level, and Second Level that keep `#>` documentation lines visible while collapsing the keyword bodies and non-`#>` comments underneath them.
- Added those fold links directly to the Documentation Preview so the documentation tiers are one click away without using the command palette.

## 0.4.47

- Kept the last owner-ending `#>` fold extended to the end of its testcase or keyword while still trimming nested same-end children only once, so EOF folding behaves less erratically.
- Added a command to set Robot Companion as the default folding provider for Robot files, which makes VS Code fold-level commands follow the documentation heading and `#>` tiers more deterministically instead of merging competing providers.

## 0.4.46

- Flattened markdown documentation headings into a single folding tier, so fold-level commands can treat headings first, plain `#>` markers next, and nested `#>>` markers after that more deterministically.

## 0.4.45

- Normalized nested folds by trimming the inner same-end range instead of the parent, so the last nested heading and the last `#>` peer still get visible fold markers near the end of a testcase or keyword.

## 0.4.44

- Preserved same-end nested inline folds instead of dropping them, so first-level `#>` peers inside headings keep their gutter markers and nested `#>>` children still collapse correctly when both close on the same later sibling.

## 0.4.43

- Added a dedicated `trace` log level and routed documentation folding diagnostics there, so real-file folding traces can be captured without turning normal `debug` logging into noise.

## 0.4.42

- Fixed inline folding edge cases for real Robot files with no-gap nested markers, so top-level `#>` sections and last peer headings keep their own gutter fold markers while nested `#>>` children still collapse independently.

## 0.4.41

- Refined hierarchical inline folding so top-level `#>` sections keep their own gutter markers alongside deeper `#>>` children by avoiding same-end nested fold ranges when VS Code would otherwise suppress the parent marker.

## 0.4.40

- Reworked inline documentation folding to respect `#>` / `#>>` / `#>>>` hierarchy, so peer `#>` sections fold to the next same-depth peer while nested child markers keep their own collapse ranges.

## 0.4.39

- Fixed documentation-driven folding so the last heading in a testcase/keyword also folds to the end of the owner block, while plain `#>` lines inside that section keep their own child collapse ranges.

## 0.4.38

- Refined documentation-driven editor folding so markdown headings now own everything until the next heading of the same or higher level, instead of being interrupted by plain `#>` lines inside the same owner section.

## 0.4.37

- Changed Robot editor folding so documentation lines act as section markers and collapse the testcase/keyword steps that follow them until the next documentation marker or the end of the owner block.

## 0.4.36

- Added Robot editor folding for inline `#>` documentation and classic `[Documentation]` blocks, including heading-based nested folds and fallback folding for plain multi-line documentation runs.

## 0.4.35

- Restored cleaner first-level inline-documentation list flow while keeping nested list items independently clickable by using a lightweight inline click surface instead of a block-style wrapper.

## 0.4.34

- Refined nested inline-documentation highlighting so individually clickable list items only highlight their own row instead of visually lighting up the complete parent list block.

## 0.4.33

- Fixed nested inline-documentation click handling so second-level and deeper list items get their own Robot-source jump targets instead of only the parent list item being clickable.

## 0.4.32

- Added nested inline-documentation markers like `#>>` and `#>>>`, which automatically indent markdown content and keep each nested list item independently clickable in the preview.

## 0.4.31

- Fixed inline-documentation preview source jumps again by attaching click targets through nested markdown wrapper elements, so rendered headings and list blocks reliably jump back to the correct Robot source line.

## 0.4.30

- Fixed inline-documentation preview list rendering so the markdown stays clean and continuous, allowing consecutive numbered and bulleted lines to remain grouped while still keeping Robot-source jump targets.

## 0.4.29

- Changed inline-documentation preview rendering back to a single markdown flow, so numbered lists and bullet lists can continue consistently across multiple `#>` documentation blocks while still keeping Robot-source jump targets.

## 0.4.28

- Fixed clickable inline-documentation preview fragments so they jump back to the Robot source file line again instead of navigating inside the preview itself.

## 0.4.27

- Changed inline-documentation preview navigation so the rendered documentation fragments themselves are clickable, instead of showing separate "Jump to" links beside the content.

## 0.4.26

- Added inline Robot documentation support using `#>` markers inside Test Cases, Tasks, and Keywords, with merged rendering alongside classic `[Documentation]` blocks.
- Documentation preview and hover now understand fragmented docs, and the preview viewer adds source-jump links for inline headings and inline doc blocks.

## 0.4.25

- Removed the remaining second-level access truncation in hover and argument-value return previews, so second-level return paths now show in full by default instead of stopping after the first handful of entries.

## 0.4.24

- Changed `robotCompanion.returnFieldNameStyle=camelcase` to render true lower camelCase aliases such as `statusCode`, `subOrderId`, and `orderKey` instead of PascalCase-like names.
- Kept explicit aliases such as `customerId` unchanged, so already-camelCase property names continue to appear exactly as defined by the Python model.

## 0.4.23

- Fixed return-member/property deduping so explicit Python property aliases remain visible instead of collapsing into the same normalized name.
- Restored explicit property aliases such as `customerId` and `orderNumber` in return hover, Return Explorer access lists, and `${var.}` member completions.

## 0.4.22

- Changed `robotCompanion.returnMaxFieldsPerType` to default to `0` (unlimited), so larger return types no longer hide later properties just because earlier fields filled the first-level access list.

## 0.4.21

- Added configurable `robotCompanion.returnIncludeProperties` (default `true`) so Python `@property` members can be shown or hidden in return hover, Return Explorer access lists, technical return details, argument-value return hints, and `${var.}` member completions.
- Indexed Python `@property` getters as return members and preserved their CamelCase-aware aliases, including already-camelCase property names such as `orderKey -> OrderKey`.

## 0.4.20

- Fixed CamelCase return-member rendering for inherited fields, so CamelCase-capable wrapper responses also expose inherited members like `SubOrder` in the configured `camelcase` mode instead of mixing `snake_case` top-level segments with CamelCase nested members.

## 0.4.19

- Added configurable `robotCompanion.returnFieldNameStyle` with `camelcase` (default), `snake_case`, and `both`.
- Return hover, Return Explorer access paths, argument-value return hints, and `${var.}` member completions now render CamelCase aliases only for return types that support CamelCase access.
- Member lookup still accepts both raw and CamelCase segment forms for CamelCase-capable return types, while the technical developer tree remains on raw source field names.

## 0.4.18

- Fixed Python structured-type indexing for multi-line `class` declarations, so response wrapper models are discovered even when their base classes are listed across several lines.
- This restores return-type resolution for response wrapper models whose base classes are declared across several lines.

## 0.4.17

- Fixed structured inherited-base resolution for imported/aliased Python classes so response wrapper types keep their inherited fields instead of appearing empty.
- Added richer return-resolution trace output (`typeDebug`) to show the selected structured type, chosen qualified name, and inherited base references when suspicious return types are inspected.

## 0.4.16

- Fixed a worker-side return rendering crash (`normalizedTypeName is not defined`) that could break return previews, return technical details, and member completions for otherwise valid types.
- Keeps the dedicated Robot Companion output/logging from `0.4.15`, but removes the noisy false-negative caused by the worker exception.

## 0.4.15

- Added a dedicated `Robot Companion` Output channel plus `Robot Companion: Show Output` command for easier troubleshooting.
- Added configurable `robotCompanion.logLevel` setting with `off`, `error`, `warn`, `info`, and `debug`.
- Return hover/explorer/worker failures now point to Robot Companion output instead of requiring Extension Host logs, and key return-resolution failures are logged with context for debugging.

## 0.4.14

- Fixed a return-type cache invalidation gap after the qualified inherited-base resolution change.
- Return type previews now use a bumped cache schema so stale cached `SubOrder`-style results are recomputed instead of being reused across related response types.

## 0.4.13

- Fixed fully qualified inherited return type resolution for structured types.
- Return previews, technical details, and member completions now follow aliased base classes precisely, so inherited fields remain available even when simple class names collide across modules.
- This fixes cases where a keyword returns a model class that inherits its visible fields from a same-named base class in a different module.

## 0.4.12

- Added `robotCompanion.enumCompletionDisplayMode` with options `name`, `value`, and `both`.
- Default enum completion display mode is now `name`, so named-argument enum completions prefer enum member names unless configured otherwise.
- Readme updated to document the new enum completion display behavior.

## 0.4.11

- Restored enum value completion dropdown in named argument value positions after `=`.
- Completion now suggests enum members and enum literal values (when different from member names) from indexed argument enum mappings.
- Enum completion results are combined with existing typed-variable completions, with enum items ranked first.

## 0.4.10

- Improved Python-save return cache invalidation performance:
  - Python save now invalidates worker return type cache entries by changed file dependency (instead of clearing full workspace return cache).
  - Added dependency-aware worker cache eviction request path (`invalidateTypePreviewByFiles`).
- Worker return type cache now keeps entries across index generation refreshes and evicts only impacted keys when possible.
- Added dependency file tracking to return type cache entries (memory + persisted cache payload), and persisted cache pruning on file-targeted invalidation.

## 0.4.9

- Added true incremental Python indexing in `RobotEnumHintService`:
  - on Python save/create/delete, only the affected `.py` file contribution is updated/removed.
  - removed workspace-wide Python invalidate/rescan behavior from file events.
- Refactored indexing into workspace-local contribution state plus in-memory derived index recompute:
  - per-file contribution maps for Python and Robot keyword/resource sources,
  - serialized per-workspace update queue for race-safe incremental updates.
- `getIndexForDocument()` now waits for in-flight workspace updates and serves the latest derived in-memory index snapshot.
- Kept conservative runtime safety invalidation for worker/runtime caches on Python changes while eliminating full filesystem rescans for index updates.

## 0.4.7

- Added cache-backed `${var.}` return member completion using the existing worker return type cache (memory + disk).
- Added support for member completion with closed-brace typing contexts (for example `${order.}` with RobotCode auto-close).
- Added setting `robotCompanion.returnMemberCompletionMaxDepth` (default `2`) to control member completion depth.
- Added completion-side hot memoization and runtime bucket support for fast repeated keystrokes in the same context.

## 0.4.6

- Changed default `robotCompanion.returnPreviewMaxDepth` from `1` to `2`.
- Default Return Explorer rendering now includes second-level access paths, and prewarm/type cache now populate second-level return access by default.

## 0.4.5

- Added type-scoped return caching in the worker so repeated variables resolving to the same return type reuse one compute result.
- Extended worker cache to include technical return structure lines (not only simple access paths), eliminating repeated technical recompute per variable.
- Added optional persisted worker return-type cache per workspace:
  - new settings: `robotCompanion.enableReturnTypeDiskCache` and `robotCompanion.returnTypeCacheMaxEntries`
  - conservative invalidation via index snapshot fingerprint match.
- Unified worker-backed return reuse across all return surfaces:
  - return hover / Return Explorer
  - return hint for argument values inside enum/argument preview flows.
- Return Explorer cache-first behavior now prefers full (technical-included) cached contexts, and prewarm populates full return contexts to avoid repeated on-demand technical loading for already-warmed types.
- `Robot Companion: Invalidate All Caches` now also clears persisted return-type cache files.

## 0.4.4

- Release-only pre-release refresh on `caching` branch for remote validation of the worker-thread pipeline.
- No functional code changes compared to `0.4.3`.

## 0.4.3

- Added dedicated return-compute worker thread (`src/core/return-worker.js`) for heavy return-access generation:
  - return simple-access and technical-tree computation can now run off the extension host main thread.
  - main-thread fallback remains in place when worker is unavailable.
- Added worker snapshot + generation sync:
  - workspace index snapshots are serialized once per generation and sent to the worker.
  - worker caches are invalidated on Python/index changes and explicit cache invalidation command.
- Integrated worker-backed compute path into hover, Return Explorer, and prewarm flows to reduce UI blocking during large return-resolution workloads.

## 0.4.2

- Improved interactive responsiveness with cache-first hover/completion behavior:
  - enum hover and return hover now read cache first (`cacheOnly`) and avoid blocking full recomputation on cache miss.
  - hover miss paths now schedule background warmup tasks instead of doing heavy foreground resolution.
- Improved return hover performance:
  - return hover resolution now always uses `includeTechnical: false` (no technical tree computation in hover path).
- Improved typed-variable completion responsiveness:
  - completion now serves cached candidates immediately when available.
  - on cache miss, candidates are computed in background and reused on the next completion trigger.
- Added a deduplicated background task scheduler in runtime cache service:
  - interaction-aware idle scheduling for cache fill tasks
  - per-URI timer cleanup on document runtime cache invalidation
- Added caching design notes documenting cache layers, invalidation behavior, prewarm scope, and known gaps.

## 0.4.1

- Improved responsiveness during active typing/hover by prioritizing interaction over background cache work:
  - prewarm now pauses quickly when the user is interacting and resumes only after idle.
  - added interaction-aware runtime scheduling helpers used by low-priority refresh flows.
- Improved Return Explorer latency behavior on return-variable selections:
  - side panel now attempts cache-first return preview resolution.
  - on cache miss, it shows a lightweight loading state and defers heavy resolution to idle time.
  - technical details refresh is now idle-prioritized to reduce UI contention while typing/hovering.
- Added interaction activity signals from hover/completion/selection flows so background prewarm yields sooner.

## 0.3.1

- Added Robot-debug pause mode to avoid interference with RobotCode debugging:
  - Robot Companion hover, completion, and code lens providers are suspended while a Robot debug session is active.
  - Documentation Preview and Return Explorer auto-sync/update loops are paused during Robot debug sessions.
  - Side views show a clear paused message and automatically resume when the debug session ends.

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
- Updated the repository naming in the development notes.

## 0.2.0

- BREAKING: Renamed extension namespace from `robotDocPreview.*` to `robotCompanion.*` for commands, views/container IDs, and settings keys.
- Re-positioned UX to make **Robot Return Explorer** the primary sidebar workflow; **Documentation Preview** remains available in the same container as a secondary capability.
- Updated command palette labels for Robot Companion positioning (including `robotCompanion.toggle` -> focus Return Explorer).
- Introduced `src/*` module layout scaffolding and moved runtime entrypoint to `src/core/extension.js` with root `extension.js` delegating to it.
- Updated README and internal docs for the Robot Companion 0.2.0 naming and workflow model.

## 0.1.34

- Improved nested collection access hints: when a second-level (or deeper) path goes through a collection-typed field, the path now inserts index access on that segment (for example `${order.items[0].name}`).

## 0.1.33

- Collection-like return hints now show indexed access only (for example `${var[0].field}`), removing the duplicate non-indexed variant for those contexts.

## 0.1.32

- Added configurable generic subtype return resolution across return hover, side panel, and argument return hints:
  - `robotCompanion.returnSubtypeResolutionMode` (`always` | `never` | `include` | `exclude`, default `always`)
  - `robotCompanion.returnSubtypeIncludeContainers` (default `[]`)
  - `robotCompanion.returnSubtypeExcludeContainers` (default `[]`)
- Return annotation parsing now resolves nested generic subtypes (for example `list[T]`, `Wrapper[T]`, `Optional[list[T]]`) based on the selected policy.
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
- Restored missing hover/side-panel resolution for named arguments of Python keywords whose signatures contain such inline comments.

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

- Removed the enum index file-count hard cap to support larger repositories.
- Stopped excluding generated-folder Python files from enum indexing so generated enums remain discoverable.

## 0.1.7

- Fixed enum hover resolving to unrelated enums by removing global value-only fallback.
- Fixed keyword signature parsing for long parameter lists, restoring enum mapping for large Robot keywords.
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

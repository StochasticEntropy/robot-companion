# Robot Companion

A non-invasive VS Code extension for [Robot Framework](https://robotframework.org/) that
answers two questions you otherwise have to answer by reading Python source:

- **"What does this keyword actually return, and how do I access it?"**
- **"What is this test case actually doing?"**

It adds a sidebar with a rendered **Documentation Preview** and a **Robot Return Explorer**,
plus hover intelligence for variable values, enum arguments, and keyword return structures.

It is deliberately additive: it does not replace the text editor and does not register
formatter or diagnostic providers, so it coexists with
[RobotCode](https://marketplace.visualstudio.com/items?itemName=d-biehl.robotcode) and
similar extensions.

## Why

In a larger Robot Framework suite, the interesting information tends to live somewhere else
than the line you are looking at. A keyword call returns an object whose fields are declared
in a Python dataclass three imports away; an argument accepts an enum defined in another
module; a test case's intent is documented in a `[Documentation]` block that reads poorly as
plain monospace text.

Robot Companion surfaces that context next to the code instead of making you navigate to it.

## Features

### Documentation Preview

- Renders `[Documentation]` blocks as Markdown in a sidebar webview.
- Supports **inline documentation comments** using `#>` markers inside `*** Test Cases ***`,
  `*** Tasks ***`, and `*** Keywords ***`, including nested `#>>` / `#>>>` levels that indent
  automatically.
- Joins source-wrapped lines into flowing text, while `<br>` is preserved as an intentional
  break.
- Every rendered line is clickable and jumps back to the exact source line.
- Selecting a test or keyword in the preview overview opens its source at the owner line;
  an unavailable documentation target leaves the editor in place and shows an unresolved notice.
- The CodeLens above each documentation block and the hover's *Open full rendered preview* link
  reveal the Documentation Preview at that block, even when the sidebar is hidden.
- Moving to an undocumented test, task, or keyword clears the selected preview instead of showing a neighbor's documentation.
- Substitutes unambiguous local `Set Variable` / `VAR` values into the rendered text, and
  lists the test case's variables in a `Variables` section.
- Exports the current or selected documentation to Markdown or PDF.

### Robot Return Explorer

- Shows the structured return type of the keyword call under the cursor: a copy-ready list of
  Robot access paths such as `${result.field.subfield}`, plus a technical tree for developers.
- Resolves Python dataclass/typed-class fields, inherited base classes (including
  same-named classes in different modules), and generic subtypes such as `list[T]`.
- Renders indexed access for collection-typed fields, for example `${result.items[0].name}`.
- Displays indexed Python `@keyword(...)` docstrings, with `Args` entries that link to the
  matching named argument in the current call, and an `Insert` link that adds a missing
  named argument as an aligned continuation line.

### Hover intelligence

- Local variable values from `Set Variable` and Robot Framework 7 `VAR` assignments,
  including typed names like `${name: date}` and variables embedded in longer strings.
- Conditional values: a variable assigned in mutually exclusive `IF` / `ELSE IF` / `ELSE`
  branches shows all candidate values instead of collapsing to one.
- Enum members accepted by a named argument, and the resolved current value.
- Keyword return structures.

### Running tests

- **Run Test** and **Run Suite** CodeLenses run a single test or the whole `.robot` file with
  your own Robot Framework installation, with live output and a pass/fail notification that
  opens the run's log and report. See [Running tests](#running-tests).

### Folding

Optional documentation-aware folding for Robot files, where documentation markers act as
section boundaries. It can be enabled as the default folding provider for Robot files, with
commands to fold to headlines or to steps.

### Umlaut-aware Python keywords

If your Python keywords use a decorator that converts ASCII argument names to umlaut
spellings (`ue` to `ü` and so on), Robot Companion indexes the Robot-facing spelling. It
reads the shared exclusion defaults from a workspace module that declares them, and accepts
both the ASCII and the umlaut form on lookup. The decorator's name and the name of the
module-level exclusion list are settings — `robotCompanion.umlautDecoratorNames` and
`robotCompanion.umlautExcludeSymbols` — so a project that names them differently can say
so. If several modules declare defaults, `robotCompanion.umlautDecoratorModuleSuffix`
picks one.

## Requirements

- VS Code `^1.85.0`
- Robot Framework projects; Python keyword files are indexed from the workspace.
- Running tests needs Robot Framework installed in the selected environment (or where `robotCompanion.robotCommand` finds it),
  and a trusted workspace.

The extension has no runtime npm dependencies.

## Install

From the Marketplace, or from a packaged build:

```bash
npm install
npm run package          # produces a .vsix
code --install-extension robot-markdown-companion-<version>.vsix
```

## Usage

1. Open a Robot Framework workspace.
2. Open the **Robot Companion** container in the activity bar.
3. Put the cursor on a keyword call to populate the Return Explorer, or on a documented test
   case to see the rendered documentation.

### Documentation color markup

Documentation comments and `[Documentation]` Markdown support explicit color tags in the live
preview and the PDF/Markdown export:

- Semantic tags: `<note>`, `<question>`, `<warning>`, `<error>`, `<success>`
- Color shortcuts: `<red>`, `<orange>`, `<yellow>`, `<green>`, `<blue>`, `<pink>`,
  `<purple>`, `<gray>`
- Custom colors: `<color value="red">...</color>`, `<color value="#0f766e">...</color>`

A color tag with an unsupported color or extra attributes is rendered as plain text. Other HTML
in documentation is passed to the Markdown renderer, but the preview and the printable export
never run script from it, and a `command:` link in documentation only works for Robot
Companion's own commands; links to any other command do nothing. This holds in trusted and
Restricted Mode alike. The Markdown export preserves the author-facing tags.

The preview, the Return Explorer and the printable export also ignore a `<style>` element, a
`style=` attribute or a `<link>` stylesheet written in documentation. Each piece of documentation
is rendered as a self-contained fragment: closing tags without a matching opening tag, such as a
stray `</section>` or `</div>`, are dropped, so documentation stays inside its own area and paints
only there, including an SVG drawn larger than its box. It cannot hide, recolor or cover their
buttons and links, including the links the Return Explorer shows next to a keyword docstring, such
as **Jump to keyword definition**; the color tags above, the arrow-line indentation and the page
breaks of the printable export still render.

Links in documentation, hovers and the preview that open, preview, fold or export a document act
only on a file inside an open workspace folder or on the document already in view (the active editor,
or the one the Documentation Preview or Return Explorer shows). A link to any other file or URI,
including a `..` path that leaves the workspace folder, opens nothing and writes a warning naming
the refused command to the **Robot Companion** output channel. A single `.robot` file opened
without a workspace folder keeps working while it is in view.

Images in documentation load from `data:` URIs and the webview's own resources. Remote images
(`https:`) load only in a trusted workspace; in Restricted Mode they stay blank.

## Running tests

In a `.robot` file, Robot Companion adds a **Run Suite** CodeLens on each
`*** Test Cases ***` / `*** Tasks ***` header and a **Run Test** CodeLens on each test or task
name. The same actions are available as commands:

- **Robot Companion: Run Test at Cursor** runs the test containing the cursor (Command Palette
  and the editor context menu of `.robot` files). Outside a test it runs nothing and says
  *Place the cursor inside a test case to run it.*
- **Robot Companion: Run Suite** runs every test in the current file (Command Palette, editor
  context menu and Explorer context menu of `.robot` files).

`.resource` files and `.robot` files without a test or task section get no run CodeLens, and
the commands say there are no tests in the file. Unsaved edits are saved before the run; a new
file that was never saved is not run until you save it.

### Select an environment

Click **Robot: …** in the status bar of a saved `.robot` file, or run **Robot Companion:
Select Robot Environment**. The native picker shows Python/Robot versions after checking,
and distinguishes missing Robot Framework, unavailable executables, failed checks and timeouts.
The tooltip contains the full executable, folder and effective source. The item hides outside
Robot files. Use typing, arrow keys and Enter to choose; Escape cancels without changing your
choice or editor position. **Enter path…** first asks for a Python interpreter or a Robot
executable, then one absolute executable path, without arguments or surrounding quotes. Spaces,
Unicode and shell-looking characters are literal. Back returns to the previous step.

Choices are saved separately for each workspace folder URI and survive an extension-host/window
restart. A file in another root uses that root's choice. Standalone `.robot` files keep their
existing default/configured runs and status, but saving a picker choice requires an open workspace
folder. Switching the active folder during a picker/path flow cancels tentative input.

Precedence is **explicit `robotCompanion.robotCommand` setting > saved choice > `robot` on PATH**.
User, Workspace and Workspace Folder settings count as explicit, even when set to `robot`.
The picker/tooltip identifies an overriding setting and a masked saved choice; selecting an
alternative saves it for later without rewriting your settings. A broken setting remains an error.
With no explicit setting or saved choice, runs retain the previous PATH behavior.

Sources include `.venv`, `venv` and `env` in the current workspace root, `robot` on PATH, and
custom executables. A small `.venv` text file may point to an absolute external environment root.
This covers conventional in-project Poetry/pipenv environments; external manager locations need
**Enter path…** or the Python source. No dependency-manager command or recursive search runs.
Opening the picker shows it before asynchronous checks; at most two probes run at once, each
bounded to two seconds and 64 KiB output, with an eight-second refresh deadline. **Refresh** clears
short-lived availability caches (30 seconds for success, five for failures).

If the optional Microsoft Python extension exposes the public `environments` API with
`getActiveEnvironmentPath`, `resolveEnvironment`, and `onDidChangeActiveEnvironmentPath`, its
**Python extension** row follows that extension's interpreter for the file, only after you explicitly
select it. Installing the Python extension alone never changes your default. Unsupported API
versions, missing local executable URIs or unavailable interpreters remain unavailable; they
never fall back to PATH. The adapter has synthetic contract/lifecycle coverage; genuine installed
Python-extension integration has not been verified in the offline baseline. Remote executable
translation is not supported by this UI-host extension.

Selected Python runs as the **exact interpreter plus `-m robot`**. This binds Robot's module to
that interpreter and avoids a console script's potentially stale absolute shebang after an
environment move. It cannot repair every moved/broken venv. Explicit Robot executable choices
run that executable directly; configured commands keep their existing parsing. Neither route uses
a shell or changes project import semantics.

A selected Python without Robot Framework offers **Select Environment** and **Install
robotframework**. Installation has a separate confirmation naming the interpreter, folder and
`<python> -m pip install robotframework`; Cancel starts nothing. Confirmed installation uses that
exact interpreter without a shell, with cancellable progress and a 120-second bound. It is
exclusive with test runs and never starts from selection/detection alone. Success is reported
only after a fresh Robot availability check. Executable-only choices have no inferred pip target.

What runs:

```text
<effective executable and leading arguments> <robotArguments...> --outputdir <results folder> [--test <test name>] <suite file>
```

- A single test is selected with `--test`. Robot Framework reads that value as a pattern, so
  `*`, `?` and `[` in the name are escaped (`Sum * Check` becomes `Sum [*] Check`) and only
  that test runs. Robot Framework compares names ignoring case and spaces, so two tests whose
  names differ only in case or spacing are both run.
- The process starts **without a shell**, in the workspace folder that contains the file (or
  the file's own folder if it is outside every workspace folder). Test names and paths are
  passed as single arguments and never interpreted by a shell.
- Only one run at a time: starting another while one is active tells you a run is already in
  progress.

| Setting | Default | Purpose |
| --- | --- | --- |
| `robotCompanion.robotCommand` | `robot` | Command that runs Robot Framework: a plain command (`robot`), an interpreter form (`python3 -m robot`), or an absolute path, quoted if it contains spaces (`"/opt/my tools/.venv/bin/robot"`). |
| `robotCompanion.robotArguments` | `[]` | Extra arguments passed before the selection, one per entry, for example `["--loglevel", "DEBUG"]`. |
| `robotCompanion.enableRunCodeLens` | `true` | Show the Run Suite / Run Test CodeLenses. |

**Output and results.** The output channel **Robot Companion Test Run** opens when a run
starts. It begins with the exact command line, the working directory and the results folder,
then streams Robot Framework's console output live. Each run writes `output.xml`, `log.html`
and `report.html` to its own folder `robot-runs/<YYYYMMDD-HHMMSS-mmm>` in the extension's
workspace storage, or its global storage when no folder is open (both in VS Code's user data,
not in your repository; the `Results:` line shows the exact path). The newest 20 run folders
are kept. When the run ends, one notification states the result:

- *passed* (exit code 0),
- *N tests failed* (exit codes 1 to 250; 250 means 250 or more),
- *could not run*, with the exit code (exit code 251 or higher, or an exit code from 1 to 250
  without any result file written),
- *stopped by signal* when the process was killed, or *could not be started* / *not found*
  when the command itself could not be started.

Passed and failed notifications offer **Open Log** and **Open Report**, which open that run's
files in your default browser; every result notification offers **Show Output**. Robot Companion sets
its own `--outputdir` after `robotArguments`; options such as `--log NONE` in
`robotArguments` still apply, and *Open Log* then says the file was not written.

**Workspace trust.** Running tests starts a program chosen by settings, so it requires a
trusted workspace. In Restricted Mode environment detection, Python API activation, installation,
and the run CodeLenses/commands start nothing and
explain that the workspace must be trusted (*Manage Workspace Trust*). Trust is checked again
immediately before each process or Python API activation, including after confirmation. After
granting trust, explicitly reopen/refresh the picker; tests and installation never auto-start.
`robotCompanion.robotCommand` and `robotCompanion.robotArguments` are restricted settings:
values from an untrusted workspace's settings are ignored. The read-only features
(documentation preview, hovers, Return Explorer, folding) also work in Restricted Mode; there,
documentation webviews do not load remote images.

**Troubleshooting.**

- *Robot Framework command 'robot' was not found.* Robot Framework is not installed or not on
  the `PATH` VS Code was started with. Install it (`pip install robotframework`) or point
  `robotCompanion.robotCommand` at it, for example `"/path/to/project/.venv/bin/robot"` or
  `"/path/to/project/.venv/bin/python" -m robot`.
- *could not run … exit code 1 and no results were written.* Typical for
  `python3 -m robot` when that interpreter has no `robotframework` module; *Show Output*
  shows Python's message.
- *exit code 252 (invalid test data or command line options).* Check `robotArguments` and the
  output; Robot Framework prints the reason there.
- *robotCompanion.robotCommand is empty* or *has an unclosed quote.* Fix the setting; nothing
  was started.
- On Windows, point the setting at `robot.exe` or `python.exe -m robot`; batch files
  (`.bat`/`.cmd`) cannot be started without a shell.

## Commands

All commands are under the **Robot Companion** category:

| Command | ID |
| --- | --- |
| Focus Return Explorer | `robotCompanion.toggle` |
| Open Current Documentation Block | `robotCompanion.openCurrentBlock` |
| Invalidate All Caches | `robotCompanion.invalidateCaches` |
| Show Output | `robotCompanion.showOutput` |
| Export Current Documentation as Markdown | `robotCompanion.exportDocumentationMarkdown` |
| Export Current Documentation as PDF | `robotCompanion.exportDocumentationPdf` |
| Export Selected Documentation as Markdown | `robotCompanion.exportDocumentationSelectedMarkdown` |
| Export Selected Documentation as PDF | `robotCompanion.exportDocumentationSelectedPdf` |
| Use Robot Companion as Default Folding Provider | `robotCompanion.useAsDefaultFoldingProvider` |
| Fold Documentation To Headlines | `robotCompanion.foldDocumentationToHeadlines` |
| Fold Documentation To Steps | `robotCompanion.foldDocumentationToSteps` |
| Unfold Documentation | `robotCompanion.unfoldDocumentation` |
| Select Robot Environment | `robotCompanion.selectRobotEnvironment` |
| Run Test at Cursor | `robotCompanion.runTestAtCursor` |
| Run Suite | `robotCompanion.runSuite` |

## Settings

Robot Companion contributes 42 settings under the `robotCompanion.` prefix, covering feature
toggles, indexing scope, rendering depth, and cache behavior. The full list with descriptions
and defaults is available in the Settings UI (search for "Robot Companion").

The ones most worth knowing:

| Setting | Default | Purpose |
| --- | --- | --- |
| `robotCompanion.indexImportFolderPatterns` | `["**"]` | Which folders to index for Python/Robot definitions. |
| `robotCompanion.indexExcludeFolderPatterns` | `[".git",".venv","venv","__pycache__","node_modules","tests"]` | Folders to skip while indexing. |
| `robotCompanion.returnFieldNameStyle` | `camelcase` | Render return members as camelCase aliases, raw `snake_case`, or both. |
| `robotCompanion.umlautDecoratorNames` | `["convert_umlaut_kwargs"]` | Name(s) of the decorator that maps ASCII argument spellings onto diacritic ones. |
| `robotCompanion.camelCaseAliasBaseNames` | `["camelcase"]` | Base class names marking a type whose `snake_case` attributes are also readable in camelCase. Add your own converter base to make the setting above take effect. |
| `robotCompanion.enumCompletionDisplayMode` | `name` | Show enum `name`, `value`, or `both` in completions. |
| `robotCompanion.enableReturnTypeDiskCache` | `true` | Persist the worker return-type cache per workspace. |
| `robotCompanion.logLevel` | `warn` | Verbosity of the `Robot Companion` output channel. |

Narrowing `indexImportFolderPatterns` to the folders that actually contain your keyword
libraries (for example `["libs/**"]`) is the main lever if indexing feels slow in a large
repository.

## Notes and limitations

- Behavior is non-invasive by default, but explicit actions such as argument insertion and
  documentation export do edit or write files, and Run Test / Run Suite start the configured
  Robot Framework command.
- Return resolution runs in a worker thread with a memory cache, and optionally a per-workspace
  disk cache. `Invalidate All Caches` resets both.
- Keyword-doc rendering is best-effort: ambiguous matches or docstring parse quirks show a
  warning banner, but the content still renders.
- Diagnostics go to the dedicated `Robot Companion` output channel.

## Development

```bash
npm install
npm run test:all         # parser/render/environment checks + UI + environment hosts
npm run package
```

`npm run test:ui` downloads a VS Code build and runs the UI suite in an Extension Development
Host, so it needs network access on first run.

The offline pilot uses preinstalled VS Code, without fetching packages or VS Code:

```bash
mkdir -p .vscode-test
ln -sfn /opt/vscode-test/vscode-linux-arm64-1.141.0 .vscode-test/
xvfb-run -a npm run test:all
```

Set `ROBOT_COMPANION_EVIDENCE_DIR` to retain native CDP screenshots/actions and host invocation
records before owned profiles are removed. The environment host checks cover two identical-named
roots with a synthetic Python public-API provider, and a separate genuine Restricted Mode host.
Extension test hosts keep storage in memory and refuse modal prompts, so restart persistence
(graceful exit and relaunch with the same profile) and the real install confirmation run in normal
VS Code windows driven over CDP (`tests/ui/cdp-host.js`). These checks use custom dialog style; the
native Linux dialog is not exercised. Fixtures simulate Python/Robot and installation without a
network download; they are not proof of a genuine installed Python provider. Windows paths are
covered by deterministic simulation; live process/UI checks run on Linux under Xvfb.

Additional docs:

- Inline documentation marker guide: `docs/INLINE_DOCUMENTATION.md`
- Release verification guide: `docs/RELEASE_CHECKLIST.md`

## License

MIT. See [LICENSE](LICENSE).

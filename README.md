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
- Running tests needs Robot Framework installed where `robotCompanion.robotCommand` finds it,
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

Unsupported colors, attributes, or arbitrary HTML are rendered as plain text. The Markdown
export preserves the author-facing tags.

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
the commands say there are no tests in the file. Unsaved edits are saved before the run.

What runs:

```text
<robotCommand> <robotArguments...> --outputdir <results folder> [--test <test name>] <suite file>
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
workspace storage (in VS Code's user data, not in your repository); the newest 20 run folders
are kept. When the run ends, one notification states the result:

- *passed* (exit code 0),
- *N tests failed* (exit codes 1 to 250; 250 means 250 or more),
- *could not run* (exit code 251 or higher, a signal, or no results written), with the exit
  code.

Passed and failed notifications offer **Open Log** and **Open Report**, which open that run's
files in your default browser; every notification offers **Show Output**. Robot Companion sets
its own `--outputdir` after `robotArguments`; options such as `--log NONE` in
`robotArguments` still apply, and *Open Log* then says the file was not written.

**Workspace trust.** Running tests starts a program chosen by settings, so it requires a
trusted workspace. In Restricted Mode the run CodeLenses and commands start nothing and
explain that the workspace must be trusted (*Manage Workspace Trust*).
`robotCompanion.robotCommand` and `robotCompanion.robotArguments` are restricted settings:
values from an untrusted workspace's settings are ignored. The read-only features
(documentation preview, hovers, Return Explorer, folding) also work in Restricted Mode.

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
npm run test:all         # node parser/render tests + VS Code UI tests
npm run package
```

`npm run test:ui` downloads a VS Code build and runs the UI suite in an Extension Development
Host, so it needs network access on first run.

Additional docs:

- Inline documentation marker guide: `docs/INLINE_DOCUMENTATION.md`
- Release verification guide: `docs/RELEASE_CHECKLIST.md`

## License

MIT. See [LICENSE](LICENSE).

# Robot Companion

A non-invasive VS Code extension for [Robot Framework](https://robotframework.org/) that
answers two questions you otherwise have to answer by reading Python source:

- **"What does this keyword actually return, and how do I access it?"**
- **"What is this test case actually doing?"**

It adds a sidebar with a rendered **Documentation Preview** and a **Robot Return Explorer**,
plus hover intelligence for variable values, enum arguments, and keyword return structures.

By default it is additive: it does not replace the text editor or start a language server,
so it coexists with
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

### Experimental owned language service

The default `robotCompanion.integrationMode: "coexistence"` keeps the existing
documentation, hints, folding and run commands. It registers no owned definition
provider or diagnostic service and starts no language backend. `.robot` and `.resource`
files are registered as Robot Framework even without another language extension.

For adapter development, set `robotCompanion.integrationMode` to `"owned"` and
provide a `robotCompanion.languageBackend` descriptor in each workspace folder's
settings. Disable other Robot language extensions first to avoid duplicate providers.
This experimental mode routes F12, Peek and Ctrl/Cmd-click through the configured
LSP server when it advertises definitions; it also synchronizes documents and displays
its diagnostics. The Return Explorer's **Jump to keyword definition** link, and the
docstring, return and enum details it shows for a keyword, follow the same single
definition target the server returns for F12. When the server returns no target or
several, the Return Explorer says so and offers no link instead of guessing a
same-named function. A click resolves the link again and opens nothing if the
target no longer matches.
Argument names in the docstring still move to the argument in the Robot call; the
argument view they open takes its type details and definition link from the same
target. Other server capabilities are not exposed yet.

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.languageBackend": {
    "id": "your-language-adapter",
    "version": "1.0",
    "contractVersion": 1,
    "workspaceUri": "file:///absolute/workspace",
    "cwd": "/absolute/workspace",
    "env": {},
    "services": {
      "language": {
        "executable": "/absolute/path/to/adapter",
        "argv": ["--stdio"],
        "transport": "stdio"
      }
    }
  }
}
```

Replace the example paths and arguments with a real LSP adapter's explicit launch
descriptor. `workspaceUri` must exactly match the workspace folder URI; `cwd` is
absolute. Arguments are separate strings and launch without a shell. Language
selection does not change `robotCommand` or select a debug backend. No interpreter
picker or automatic package installation is provided.

#### Pinned RobotCode 2.7.0 language bridge

Robot Companion can run the RobotCode 2.7.0 *Python* language server as its owned
backend; the RobotCode VS Code extension is not needed and should be disabled. Prepare
a Python environment with `robotframework` and `robotcode[all]==2.7.0` yourself, then
point the descriptor at that environment's interpreter:

```json
"robotCompanion.languageBackend": {
  "id": "robotcode",
  "version": "2.7.0",
  "contractVersion": 1,
  "workspaceUri": "file:///absolute/workspace",
  "cwd": "/absolute/workspace",
  "env": {},
  "services": {
    "language": {
      "executable": "/absolute/venv/bin/python",
      "argv": ["-m", "robotcode.cli", "language-server", "--stdio"],
      "transport": "stdio"
    }
  }
}
```

A descriptor with `"id": "robotcode"` is pinned. It must declare version `2.7.0`, and
the server must report itself as *RobotCode Language Server 2.7.0* when it starts.
Otherwise the language service stops, registers no providers and names both versions in
the **Robot Companion Language** output channel. Robot Companion answers RobotCode's
configuration requests from your `robotcode.*` settings, if any, but always starts
RobotCode's documentation web server on demand only, so the bridge opens no listening
port. RobotCode keeps its analysis cache in a `.robotcode_cache` folder in the
workspace, as it does with its own extension. F12, Peek, Ctrl/Cmd-click and the
Return Explorer's definition link then use RobotCode's import-aware resolution: in
the audit corpus, `Build Record` opens the imported `AuditLibrary.py` line 12 even
though an unimported `AShadow.py` defines the same keyword.

#### Experimental owned debug type

Owned mode also provides a **Robot Companion** debug type (`robotcompanion`). It is
selected separately from the language service through `robotCompanion.executionBackend`,
a contract-v1 descriptor whose `services.debug` entry names the debug adapter's
executable and argv (stdio, no shell). Add a launch configuration such as
`{ "type": "robotcompanion", "request": "launch", "name": "Robot Companion: Debug current file", "target": "${file}" }`,
or press Run and Debug with a `.robot` file open. Robot Companion starts one owned
adapter process per session on the workspace host. The capabilities it negotiates
are written to the **Robot Companion Debug** output channel. Capabilities the debug
journey needs but the backend does not advertise (terminate, setting variables,
hover evaluation) are named in the Debug Console instead of being emulated. Stopping
the session sends `disconnect`; the process then gets one second to exit before it is
terminated, then killed. Changing the mode or the execution descriptor stops a running
session. Coexistence mode, Restricted Mode, a missing descriptor or a backend without a
debug service start nothing and say why. No debug backend ships with the extension.

To debug with the pinned RobotCode 2.7.0 Python packages, give `executionBackend` the
same `"id": "robotcode"` / `"version": "2.7.0"` header as the language bridge, with
`"services": { "debug": { "executable": "/absolute/venv/bin/python", "argv": ["-m",
"robotcode.cli", "debug-launch", "--stdio"], "transport": "stdio" } }`. The environment
needs `debugpy` for Python debugging. Robot Companion then:

- runs the test with that environment's Robot Framework in the folder, adding
  `robotCompanion.robotArguments` (`robotCommand` keeps applying to **Run Test**), and
  writes each debug run's results to its own folder in the extension's workspace storage;
- stops on Robot breakpoints with stack, scopes and variables. The Debug Console
  runs a Robot keyword in the paused test, for example
  `Catenate    SEPARATOR=-    ${SUITE_VALUE}    console`;
- when Robot code calls into Python, opens a **Python:** child session under the Robot
  session. It stops on Python breakpoints, steps, and evaluates Python locals in the
  Debug Console. Select a Robot frame in Call Stack to send console input to Robot again;
- on stop, ends the Robot run, the Python debugger and every other process the session
  started.

Python breakpoints are available without the Python extension. RobotCode-specific
messages stay inside Robot Companion's adapter.

#### Experimental owned Test Explorer discovery

When the folder's `robotCompanion.executionBackend` also has a `services.discovery`
entry, Robot Companion starts that process and asks it for tests with the
integration's normalized discovery API (`robotCompanion/discoverTests`, version 1; the
backend must advertise `robotCompanionDiscovery.version` 1 when it initializes). Suites
and tests appear in Test Explorer under **Robot Companion**. Their IDs are built from the
file URI and the test name, so they stay stable across backends and restarts. A
click on a test opens its source line, and saving a `.robot` file rediscovers. If discovery
fails or returns a source outside the folder, Test Explorer shows an error item
instead of a partial tree. Without a discovery service, or outside owned mode, no
Robot Companion test controller is registered; navigation, debugging and the CodeLens
runner keep working. Running, debugging and stopping tests from Test Explorer are
described [below](#test-explorer-run-debug-rerun-and-stop).

With the RobotCode bridge, add a discovery service to the same `executionBackend`:
`"discovery": { "executable": "/absolute/venv/bin/python", "argv": ["-m", "robotcode.cli",
"--format", "json", "--no-color", "--no-pager", "discover", "tests"], "transport": "stdio" }`.
Robot Companion runs that command for the folder (it appends the folder path), and on each
save, and converts RobotCode's result to the normalized tree. This was checked live: RobotCode
discovery lists the audit test at its source line, a click opens it, and **Run** with
`robotCompanion.robotCommand` set to that environment's `robot` reports PASS from the
run's output.xml. Other discovery and run checks use a local fixture and a fake `robot`.

#### Test Explorer run, debug, rerun and Stop

In owned mode with a discovery service, Test Explorer runs real Robot Framework:

- **Run** works on one test, a multi-selection (Ctrl/Cmd-click rows, also across
  suites), a suite or everything. Robot Companion starts one Robot run per suite file
  with the folder's `robotCompanion.robotCommand` and `robotCompanion.robotArguments`,
  in the workspace folder, without a shell. Each selected test name becomes a `--test`
  filter (glob characters escaped); a suite selected as a whole runs without filters.
  Each run writes to its own folder in the extension's workspace storage (the newest 40
  are kept), and Robot's console output appears in Test Results.
- Each test's result comes only from its own entry in that run's `output.xml`: Passed,
  Failed with Robot's failure message, or Skipped. A failure message is anchored at the
  test's source line, so it shows in the editor next to the test, and clicking the test
  opens that line. Results from one run never reach another run's tests. If Robot does
  not report a test (for example, Robot could not start), the test is shown as errored
  with the reason; the exit code alone never marks a test Passed. The results file is
  always `output.xml` in the run's folder, even if `robotArguments` set `--output`.
- **Rerun Failed Tests** (on a run in Test Results, or `Ctrl+;` then `E`) runs only the tests that
  failed in the last run and updates their state.
- **Stop** (*Cancel Test Run*) ends the running Robot process and every process it
  started (its whole process group; on Windows only the Robot process itself): first
  with SIGTERM, then with SIGKILL after two seconds. During **Debug Test** it ends the
  debug session. Tests that Robot had already finished keep their result from that run's
  `output.xml`; every other test of the stopped run or debug session, and of runs that
  had not started, is marked **Skipped**. Nothing is left running, and the next run starts normally.
- **Debug Test** is offered when the same `executionBackend` also has a debug service.
  It starts the owned **Robot Companion** debug type for exactly the selected tests (one
  session per suite file), linked to the test run, so breakpoints, stepping and the
  Debug Console work as described [above](#experimental-owned-debug-type). When the
  session ends, the result comes from that debug run's own `output.xml`.

If discovery is unavailable, Test Explorer shows only the error item; F12 navigation,
the **Run Test** CodeLens and Run and Debug launch configurations keep working.

Checked live (Robot Framework 7.5, RobotCode 2.7.0 discovery and debug, VS Code 1.141.0,
1280x900) with actual pointer input on Test Explorer rows, their Run Test and Debug Test
actions, the Test Results **Rerun Failed Tests** action and the Stop button.

Not supported yet: coverage, continuous run (run on save), test tags and filter
profiles (only the Test Explorer text filter), test-level parallel runs within a suite,
and live per-test progress during a suite run (a suite's tests turn from running to
their result when that Robot run ends). Each suite file runs on its own, so a parent
folder's `__init__.robot` setup and teardown do not run (as with the **Run Test** CodeLens). Robot matches `--test` names ignoring case,
spaces and underscores, so two tests in one file whose names differ only in those
both run when one is selected; only the selected one gets a result.

Use **Robot Companion: Show Language Service Status** for process state, negotiated
capabilities and errors in the **Robot Companion Language** output channel. After
fixing configuration or a backend failure, use **Restart Language Service**. Changes
to the descriptor/mode restart the owned process; returning to coexistence removes
owned providers and diagnostics, including when initialization or shutdown stalls.
Nested workspace folders route definitions and watched-file events to their owning
folder's backend. Restricted Mode starts no language processes or
reads executable descriptors. Granting trust starts the configured service; revoking
trust reloads the extension host and stops its processes.

Execution is on the workspace extension host. The current integration checks cover
Linux arm64 / VS Code 1.141.0 with RobotCode's VS Code extension absent. Lifecycle,
error and routing cases use isolated local protocol fixtures. The language bridge is
also checked against the real RobotCode 2.7.0 / Robot Framework 7.5 Python packages
(Python 3.13.7): imported, resource, local and aliased keyword definitions, the
unimported-shadow case, and a clean process exit on stop. The debug bridge is checked
the same way with actual clicks and typing in VS Code (Python and debugpy extensions
absent). Breakpoints are set in the gutter at audit.robot 12/13 and AuditLibrary.py 18.
The Debug Console Robot keyword returns `'from-suite-console'`, the Python step and
`count` give 3, and the selected Robot frame runs `Resource Step`. The run ends 1 PASS
and no session process is left. Test Explorer discovery does not use RobotCode yet. A synthetic saved workspace verifies nested-folder
language routing and removal on this host. Broader multi-root execution/debug,
remote hosts and the declared minimum VS Code 1.85 compatibility are unverified.

Owned mode is not yet full RobotCode-extension parity. Robot Companion exposes the
server's definitions and diagnostics only. It does not yet expose hover, completion,
signature help, references, rename, symbols, formatting, code actions, semantic
highlighting or inlay hints, although RobotCode advertises them. There is also no
Test Explorer coverage or continuous run, coverage profile, REPL/notebook, or
reverse/data/function breakpoint support. Granting
workspace trust starts the configured processes; that transition and revoking trust
(which reloads the extension host) were not exercised against the live RobotCode
backend.

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
trusted workspace. In Restricted Mode the run CodeLenses and commands start nothing and
explain that the workspace must be trusted (*Manage Workspace Trust*).
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

The backend adapter migration is in progress. `npm run test:backend-contract`
checks its internal launch-descriptor and execution-context boundary without starting
Python or VS Code. `npm run test:integration` also checks LSP framing and lifecycle
against a local Node subprocess fixture, and the owned debug adapter lifecycle against a
local DAP fixture; neither proves real Robot backend support.
The UI suite includes an opt-in owned-language fixture test with actual editor clicks,
F12, Linux Peek keyboard input, Ctrl-click, Return Explorer definition-link clicks
(including alias, absent, ambiguous and stale targets), synchronization and process cleanup,
plus an owned-debug fixture test that clicks Run and Debug's start button and the debug
toolbar's stop button and checks the owned process exits, and an owned Test Explorer test
that expands a discovered suite, clicks a test to open its source and clicks its Run action.
A live Test Explorer suite (`ROBOT_COMPANION_UI_SUITE=test-explorer`, skipped when the
prepared Robot environment is absent) clicks multi-selected rows, Run Test, Debug Test,
Rerun Failed Tests and Stop against real Robot Framework runs and checks that each run's
process group is gone.
Use `ROBOT_COMPANION_UI_SUITE=language npm run test:ui` for those focused suites, and
`ROBOT_COMPANION_UI_EVIDENCE_DIR=/absolute/evidence/path` to retain their screenshots
and action transcripts.

For an offline prepared test host, set `ROBOT_COMPANION_VSCODE_EXECUTABLE` to its
VS Code executable before running the UI suite; the runner then skips version lookup
and download.

Additional docs:

- Inline documentation marker guide: `docs/INLINE_DOCUMENTATION.md`
- Release verification guide: `docs/RELEASE_CHECKLIST.md`

## License

MIT. See [LICENSE](LICENSE).

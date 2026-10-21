# Robot Companion — native backend preview

> Preview 1.3.2 combines the accepted native library, formatting and Keyword Explorer work. Install the matching **0.1.0.dev2** backend wheel from this preview; backend installation remains manual. Selecting an environment for Robot test execution does not yet mean every native service adopts that interpreter. Full replacement and Windows editor acceptance remain open.


This prerelease adds an independent Robot Framework backend for keyword navigation,
language features, Test Explorer and mixed Robot/Python debugging. Native services
are the default in this preview; RobotCode and the Python/debugpy VS Code extensions
are not required. The regular release channel stays available.

**Backend setup is required after installing the preview extension.**
The Python backend is distributed separately from the VSIX. Download the
[Windows x64 / Python 3.11 offline bundle](https://github.com/StochasticEntropy/robot-companion/releases/download/v1.3.1-preview.1/robot-companion-1.3.1-windows-preview.zip), unpack it on the machine
where your project runs, and follow the [Windows setup guide](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.1-preview.1/WINDOWS-PREVIEW.md).
Use your project's Python 3.11 + Robot Framework 7.3.2 environment. The bundle
includes the backend wheel, pinned Windows dependencies and an installed-code verifier.

The native executable defaults to `.venv/Scripts/robot-companion-backend.exe` on
Windows (`.venv/bin/robot-companion-backend` elsewhere). Override the restricted
folder setting `robotCompanion.nativeBackendExecutable` for another environment.
Set `robotCompanion.robotCommand` to the same project's Python interpreter for
Run Test and Run Suite; it is independent of the backend executable setting.
Nothing is downloaded or installed automatically. RobotCode remains an optional
explicit fallback. Coexistence mode disables owned language/debug/discovery services.

**Experimental:** complete Windows native debug/discovery/UI qualification is pending.
The release includes targeted portability repairs and Linux runtime validation;
see [release notes](https://github.com/StochasticEntropy/robot-companion/releases/tag/v1.3.1-preview.1) for the tested scope and remaining limits.

A non-invasive VS Code extension for [Robot Framework](https://robotframework.org/) that
answers two questions you otherwise have to answer by reading Python source:

- **"What does this keyword actually return, and how do I access it?"**
- **"What is this test case actually doing?"**

It adds a sidebar with a rendered **Documentation Preview** and a **Robot Return Explorer**,
a **Robot Keywords** view in the Explorer (native backend), plus hover intelligence for variable values, enum arguments, and keyword return structures.

In optional coexistence mode it stays additive and starts no language server,
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
- Running tests needs Robot Framework installed in the selected environment (or where `robotCompanion.robotCommand` finds it),
  and a trusted workspace.

The extension has no runtime npm dependencies.

### Experimental owned language service

Selecting `robotCompanion.integrationMode: "coexistence"` keeps the existing
documentation, hints, folding and run commands. It registers none of the owned
language providers (definitions, diagnostics, hover, completion, signature help,
references, rename, symbols, code actions, formatting, semantic tokens) and starts no language backend. `.robot` and `.resource`
files are registered as Robot Framework even without another language extension.

This preview defaults to `robotCompanion.integrationMode: "owned"`, using
the native backend executable described above. Advanced users can provide a
`robotCompanion.languageBackend` descriptor in each workspace folder's settings. Disable other Robot language extensions first to avoid duplicate providers.
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
target. Hover, completion, signature help, references, rename and symbols are described
[below](#owned-hover-completion-references-rename-and-symbols), code actions and formatting
[after them](#owned-code-actions-and-formatting), semantic highlighting
[after that](#owned-semantic-highlighting); other server capabilities are not exposed.

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

#### Owned hover, completion, references, rename and symbols

In owned mode Robot Companion registers one VS Code provider for each of these server
capabilities, and only when the server advertises it in its `initialize` result:

| Server capability | In VS Code |
| --- | --- |
| `hoverProvider` | Hover over a keyword call, variable or argument |
| `completionProvider` | Suggestions while typing, with the server's trigger characters: keywords at a keyword-call position, variables after `${` |
| `signatureHelpProvider` | Parameter hints that mark the argument being typed |
| `referencesProvider` | **Go to References** (Shift+F12) and **Find All References** |
| `renameProvider` | **Rename Symbol** (F2); with `prepareProvider` the rename box starts with the server's name and range |
| `documentSymbolProvider` | Outline view, breadcrumbs and **Go to Symbol in Editor** (Ctrl/Cmd+Shift+O) |
| `workspaceSymbolProvider` | **Go to Symbol in Workspace** (Ctrl/Cmd+T), including files that are not open |

A capability the server does not advertise registers nothing, so VS Code offers nothing
for it from this server. Coexistence mode registers none of these providers, and in
Restricted Mode no backend process starts.

**One hover, documentation once.** Robot Companion's own hover sections (the
Documentation Preview of the `#>` / `[Documentation]` block with its **Open full rendered
preview** link, the return hint, the enum/argument hint and the variable value) and the
server's hover appear in one hover. Robot Companion's sections come first and keep their
links. The server's hover follows, without each paragraph whose text Robot Companion's
sections already show, and without a heading that has nothing left under it. A keyword's
documentation therefore appears once: in the server part when you hover a keyword call,
in the Documentation Preview part when that block is under the pointer.

**Completions are not repeated.** Robot Companion's typed-variable and enum completions
for a named argument stay as they are; a server suggestion with the same label or
inserted text is left out.

**Rename** applies the server's edit to every file it names, like any VS Code
refactoring: with VS Code's default `files.refactoring.autoSave`, the files it changed
are saved. An edit for a file outside the workspace folder, one that would create,
rename or delete a file, or one computed for an older version of an open file, is
refused as a whole. When the server refuses the new name,
VS Code shows the server's message as a notification, for example RobotCode's
*Variable names cannot contain more then one spaces or tabs* for a name with several
spaces. Where the server cannot rename the element under the cursor at all, *The
element can't be renamed* appears at the cursor.
The native backend sends its rename edits with the version of each open file they were
computed for, so a file edited meanwhile refuses the whole rename. How it renames a Python
library keyword is described [below](#rename-a-python-library-keyword).

References and symbols list only file locations the server returns; malformed ranges
are dropped with a message in the **Robot Companion Language** output. Robot Companion
keeps its own folding, CodeLenses and Documentation Preview outline; the server's
folding ranges are not used.

#### Native library and Run Keyword resolution

The native backend reads class libraries, hybrid and dynamic libraries and the keyword
names passed to `Run Keyword` and its variants, without running workspace code. In a
suite importing a class library, **Go to Definition** on a keyword opens the method Robot
Framework runs (an override, not its base method), and hover shows its signature without
`self`. On a dynamic library's keyword it opens the name in `get_keyword_names`. In
`Run Keyword    Name    arg`, `Run Keyword If    ${x}    Name    ELSE    Other` or
`Run Keywords    A    AND    B`, the keyword names work like calls: F12, hover,
references, rename, highlighting and unknown-keyword or argument diagnostics, and
completion while typing the name. Unsaved changes in an open Python library editor are
used at once; closing it without saving returns to the file on disk. Robot Companion
registers no language features for Python files. A library the suite does not import is
never used. A module name such as `Library    Kits.Tools` means what Python imports from
the suite's folder: a package with `__init__.py`, then `Kits.py`, then a folder `Kits/`
without `__init__.py`.
Names known only at run time, such as `Run Keyword    ${name}`, stay unresolved and are
not reported. The exact rules and limits are in the
[backend README](backend/README.md#library-and-run-keyword-resolution).
Verified on Linux with Python 3.11/Robot Framework 7.3.2 and Python 3.13/Robot Framework 7.5;
not yet on Windows.

#### Rename a Python library keyword

With the native backend, **Rename Symbol** (F2) renames a Python library keyword whose name
is written in its decorator, `@keyword("Build Record")`. Start it on a call, on the
function name or on the decorator's string: the rename box shows the keyword name. One
edit changes the string in the decorator and every call that resolves to that keyword in
the workspace folder (also `Alias.Build Record`, BDD prefixes, setup/teardown settings and
`Run Keyword` arguments). The Python function keeps its name, so Python code calling it
still works. Text that is not a call, such as `Log    Build Record`, is not changed.

Rename changes nothing and tells you why when it could not keep everything working:

| Case | Message starts with |
| --- | --- |
| The name comes from the function name (`def plain_step` is **Plain Step**) | *its name comes from the Python function name plain_step* — add `@keyword("Plain Step")` first, or rename the function yourself |
| A dynamic or hybrid library (its file has `get_keyword_names`) | *it is a keyword of a dynamic or hybrid library* |
| The decorator's name is not one plain string (`"Build " "Record"`, a prefix, an escape, several lines) | *… is not one plain single-line string literal* |
| A workspace Python file names the keyword in a string (`BuiltIn().run_keyword("Build Record")`) | *File.py:N names it in a Python string* |
| The new name is already a keyword or function of the library | *… already has, or may have, a keyword or function of that name* |
| In a file importing the library, the new name already calls another keyword (a resource keyword, `Log`) | *in suite.robot that name already calls …* |
| The new name contains the decorator's quote character or a backslash | *… cannot contain that quote or a backslash* |
| The library is outside the workspace folder; a call is ambiguous | *… outside the workspace folder*; *the call at … is ambiguous* |
| A workspace Python file contains the name but cannot be parsed, so its uses are unknown | *File.py mentions it but cannot be read as Python* |
| The keyword's definition is not a `def` (for example a name assigned at import time) | *its name in File.py:N is not a decorated Python function* |
| The library file cannot be read or parsed when the rename starts | *Python library File.py cannot be read* |

The refusal appears at the cursor when F2 starts, before you type a name, except for checks
of the new name itself, which VS Code shows as a notification. Robot Framework standard
library keywords and keywords with embedded arguments are not renamed.

#### Robot Keywords view and keyword search

The **Robot Keywords** view in VS Code's Explorer sidebar (collapsed until you expand it;
the Robot Companion sidebar keeps its two views) lists the keywords the last active `.robot`
or `.resource` file can call, as the native backend resolves its imports:

- one group for the file's own keywords, then one per imported resource and library in
  the order Robot Framework reads them, including those imported by an imported resource
  (*via shared.resource*), then each imported standard library and BuiltIn;
- a library imported `AS Alias` is listed under its alias, with the import name next to it;
- a library imported both by the file and by an imported resource is one group, as Robot
  Framework uses one library instance; its tooltip lists each import line, the file's own first;
- a resource imported both by the file and by an imported resource is likewise one group,
  without *via*; its tooltip lists the file's own import line first, then the others;
- a library or resource the file does not import never appears, even when it defines a
  keyword of the same name; an import that cannot be resolved is shown as a warning row
  that opens the import line.

Each keyword shows its arguments; its tooltip is its hover text: signature, return type
and the documentation of the definition Robot Framework runs (for a class library, the
overriding method). Clicking a keyword, or Enter on it, opens its definition. **Insert
Keyword Call** (the row's inline button, or its context menu: Shift+F10 then Enter)
inserts a call at the cursor of that Robot file: on an empty line with the body's
indentation, at the end of a line on a new line below it, otherwise at the cursor. The
call is written so that it resolves to that keyword: `Alias.Name` when several imports
have the name, else the plain name. A library imported under two names (`AS X` and `AS Y`,
or `AS X` and none) is two library instances in Robot Framework, so its keywords are
inserted as `X.Name` and `Y.Name`, never as a plain name Robot Framework reports as
ambiguous. When no call text reaches only that keyword (two imports with the same alias, or
aliases that differ only in case), the keyword has no inline insert button, and Insert
Keyword Call in its context menu shows a warning that explains why and inserts nothing. Required
arguments become placeholders you type over; then the Return Explorer shows the keyword
and its **Insert** links add the named arguments, with enum completion.

**Search Keywords in Scope** (the view's search button, or the Command Palette) filters the
same list by keyword, alias, library or resource name. Enter opens the definition; an item's
insert button inserts its call. The view follows unsaved edits of the file's imports and of
the libraries and resources it reads, and the **Refresh Keywords** button asks again.

The view needs owned mode with the native backend (the default). With RobotCode, in
coexistence mode, in Restricted Mode or when the backend is not running, it shows why
instead of a list. Verified on Linux (VS Code 1.141, 1280x900, actual pointer and keyboard
input) with both Python/Robot Framework rows; not yet on Windows.

#### Owned code actions and formatting

In owned mode Robot Companion also registers these providers, each only when the server
advertises the capability:

| Server capability | In VS Code |
| --- | --- |
| `codeActionProvider` | The lightbulb and **Quick Fix** (Ctrl/Cmd+.), **Refactor...** (Ctrl/Cmd+Shift+R) and **Source Action...**; with `resolveProvider` the edit is fetched when you choose the action |
| `documentFormattingProvider` | **Format Document** (Shift+Alt+F; on Linux VS Code binds Ctrl+Shift+I, which VS Code 1.141's Chat takes first) |
| `documentRangeFormattingProvider` | **Format Selection** (Ctrl/Cmd+K Ctrl/Cmd+F) |
| `documentOnTypeFormattingProvider` | Formatting as you type, when VS Code's `editor.formatOnType` setting is on (off by default) |

Diagnostics show the server's code in the Problems view, for example
*Robot Companion(unknown-keyword)*. When you open the quick fixes for a diagnostic, the
server receives that diagnostic as it published it. A code action's edit follows the same
rules as rename: only text edits inside the workspace folder, none computed for an older
version of an open file. A command in an action runs only when Robot Companion knows it
(see RobotCode below); an action that would only run an unknown command is not offered.
Coexistence mode registers none of these providers, and in Restricted Mode no backend
process starts. Robot Companion has no code actions or formatting of its own, so each
action appears once.

**Native backend 0.1.0.dev2** advertises `codeActionProvider` (`quickfix` and
`source.addMissingImports`) and, when its optional `format` extra (Robocop 9.1.0) is
installed, `documentFormattingProvider`, `documentRangeFormattingProvider` and
`documentOnTypeFormattingProvider` (after Enter):

- A keyword call that resolves to nothing is an error (*No keyword with name 'X'
  found.*). When exactly one workspace resource or library file defines the keyword, the
  quick fix **Import resource steps.resource** (or **Import library lib/X.py**) adds the
  import to the `*** Settings ***` section, creating it if needed, and the error
  disappears. A keyword that several files define gets no quick fix.
- **Source Action...** offers **Add all missing imports (N)** when quick fixes would add
  imports: one edit adds each of those files once, after the last import (or in a new
  `*** Settings ***` section), in the order of the first call needing it. Calls that several
  files or a standard library define are left alone. Like every Source Action entry, it
  can be previewed first: with the entry selected, Ctrl/Cmd+Enter opens **Refactor
  Preview**, where **Apply** adds the imports and **Discard** changes nothing. VS Code does
  not apply a preview after the file has changed (*Cannot apply refactoring because ... has
  changed in the meantime*).
- An ambiguous call is a warning naming each source. **Use FirstLibrary.Twin Step
  (FirstLibrary.py)** and one entry per other source qualify the call; the warning disappears.
- Quick fix and source action edits name the document version they were computed for;
  Robot Companion does not offer one computed for an older version.
- **Format Document** applies Robocop 9.1.0's default formatters (workspace Robocop
  configuration is not read). Formatting the result again changes nothing.
- **Format Selection** formats the selected lines with the same formatters, except the
  ones that order settings and sections and set the empty lines between tests and sections
  (OrderSettings, OrderSettingsSection, MergeAndOrderSections, NormalizeNewLines): those
  work on whole tests and sections, so Format Document can still change the order and
  empty lines. Empty lines Robocop would change outside the selection are left as they are.
  The request is declined with a warning, and nothing changes, when Robocop would change
  another line (for example when the selection holds only part of a call continued with
  `...`) or the text of a comment or documentation value in the selection (such as the
  spacing inside `#  a   comment` or a `#>` block).
- With `editor.formatOnType` on, Enter formats the spacing within the line it completes,
  with the Format Selection rules. Nothing happens on a blank line, and the line stays as
  typed when Robocop would change more than its spacing (a setting name, a comment, other
  lines). These refusals are written to the **Robot Companion Language** output instead of
  a notification.

Install the backend wheel with its `format` extra. The [Windows setup guide](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.1-preview.1/WINDOWS-PREVIEW.md) includes the offline, constrained installation command and exact installed-code verification.

**RobotCode 2.7.0** advertises `codeActionProvider` (kinds `quickfix`, `refactor.extract.function`,
`refactor.surround`, `source`, with `resolveProvider`), `documentFormattingProvider` and
`documentRangeFormattingProvider`. Formatting uses Robocop when it is installed in
RobotCode's environment (`robotframework-robocop`; 9.1.0 is verified) and RobotCode reads
the workspace's Robocop configuration. What you get:

- Quick fix **Create Keyword \`X\`** for an unknown keyword: it adds the keyword (with
  `[Arguments]` for the call's arguments and a `Fail    Not Implemented` step) and selects
  that step. RobotCode 2.7.0's source also has **Disable 'code' for this line** for its own analysis
  diagnostics and create local/suite variable and add argument fixes for undefined
  variables; they go through the same path but are not part of the verified checks.
- Refactorings on a selected keyword call: **Extract keyword**, **Surround with
  TRY...EXCEPT**, **Surround with TRY...EXCEPT..FINALLY**, **Surround with TRY...FINALLY**
  and **Assign keyword result to variable**. RobotCode shows them disabled, with its reason,
  where they do not apply.
- **Format Document** and **Format Selection** (only the selected lines change).
- Not offered: RobotCode's **Open Documentation** source action, because it only runs a
  command of the RobotCode VS Code extension and its documentation server. In the verified
  check, **Source Action...** on a keyword call asks RobotCode for source actions and shows
  *No source actions available*.

RobotCode follows each edit with a command of its VS Code extension that shows the edited
file and selects a range (the placeholder step, the new variable name). The bridge turns
that into Robot Companion's own selection; other RobotCode extension commands are not run.

Format on save works through VS Code's `editor.formatOnSave` with either provider; it is
not part of the verified checks.

#### Owned semantic highlighting

In owned mode Robot Companion registers semantic token providers when the server
advertises `semanticTokensProvider`. They use exactly the legend the server advertises
(its token types and modifiers, in its order):

| Server offer | In VS Code |
| --- | --- |
| `full` | Whole-document semantic tokens: the theme colours keyword calls, variables, settings and section headers by their token type. **Developer: Inspect Editor Tokens and Scopes** shows the *semantic token type* and modifiers under the cursor |
| `range` | Tokens for the visible lines while a whole-document result is pending |

Semantic token deltas (`full.delta`) are never requested: after an edit VS Code asks for
the whole document again. The server's `workspace/semanticTokens/refresh` request makes
VS Code ask again. Token data with a type or modifier outside the server's legend is
refused as a whole (a line in the **Robot Companion Language** output) instead of being
shown. Positions are LSP UTF-16 units, so a token after umlauts or characters such as
😀 or 𝔘 covers exactly its own characters. Colours follow the theme; VS Code's default
`editor.semanticHighlighting.enabled: "configuredByTheme"` applies them with the default
themes.

**Native backend 0.1.0.dev2** offers `full` and `range` (no delta). Its legend:
`namespace` (section headers), `property` (setting names), `class` (test and task names),
`function` (keyword names and calls), `variable`, `comment`, `keyword` (control
structures), `macro` (BDD prefixes) and `operator` (`...`); modifiers `declaration`,
`resolved` and `defaultLibrary`. `resolved` marks a call whose definition resolves through
the file's imports, so in `audit.robot` `Build Record` from the imported `AuditLibrary.py`
is `function` with `resolved`; a call that only an unimported library such as
`AShadow.py` defines is not resolved. `${record.name}` is `variable`, `Library` is
`property` and `*** Test Cases ***` is `namespace`; the default themes colour all of them.

**RobotCode 2.7.0** offers `full` only (no range, no delta). Its legend has LSP's
predefined types and RobotCode's own, such as `keywordCall`, `keywordName`,
`testcaseName`, `settingImport`, `setting`, `namedArgument`, `controlFlow` and the section
headers `headerSettings`, `headerVariable`, `headerTestcase`, `headerKeyword`; modifiers
are LSP's plus `builtin` and `embedded`. In `audit.robot` `Build Record` is `keywordCall`,
`${record.name}` is `variable`, `Library` is `settingImport` and `*** Test Cases ***` is
`headerTestcase`. The RobotCode VS Code extension tells VS Code how to colour its own
types; Robot Companion does not, so those tokens keep the editor's text colour, while
LSP-type tokens (`variable`, `namespace` for import names, `comment`, `operator`) are
coloured. You can colour RobotCode's own types in your settings, for example (these
rules are not part of the verified checks):

```json
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "keywordCall:robotframework": "#DCDCAA",
      "keywordName:robotframework": { "foreground": "#DCDCAA", "bold": true },
      "testcaseName:robotframework": "#4EC9B0",
      "settingImport:robotframework": "#C586C0",
      "setting:robotframework": "#9CDCFE",
      "headerTestcase:robotframework": "#569CD6",
      "headerKeyword:robotframework": "#569CD6"
    }
  }
}
```

The same `rules` also change the native backend's colours, for example
`"function.defaultLibrary:robotframework": { "italic": true }` for standard-library calls
(also not part of the verified checks).

**Without a provider** (coexistence mode, Restricted Mode, an owned folder without a
language backend, or a server without `semanticTokensProvider`) no semantic tokens are
registered. Robot Companion contributes no TextMate grammar, so Robot files then have no
syntax colouring from Robot Companion, as before; another extension's Robot grammar still
applies in coexistence mode. The token inspector then says *No grammar or semantic tokens
available.* Folding, CodeLenses, the Documentation Preview and its exports, and the
return, enum and argument hints are Robot Companion's own and work the same in both modes.

Checked live with both providers in VS Code 1.141.0 at 1280x900 with actual pointer and
keyboard input: a click on the token, then **Developer: Inspect Editor Tokens and
Scopes** from the Command Palette shows the token's text and its semantic token type for
`Build Record`, `${record.name}`, `Library` and `*** Test Cases ***` in `audit.robot`, and
for `${GRÜSSE}` and `${wert.name}` on the line `Log    Äöü 😀 ${GRÜSSE} 𝔘 ${wert.name}` and
the test name `Prüfung 😀 Umlaute`. Coexistence mode shows no semantic token. A local
protocol fixture checks the gating: the exact legend, whole-document and range requests,
no delta request although the fixture offers deltas, the refresh request, refused data
outside the legend, and no provider when `semanticTokensProvider` is missing. Inlay hints
and semantic token deltas are not exposed for either provider.

#### Choosing the provider: native backend or RobotCode

Two providers can serve owned mode. `robotCompanion.languageBackend` and
`robotCompanion.executionBackend` each select one of them on their own, so all four
combinations work: native language with native debugging, either mixed, or RobotCode
for both.

| Provider | Descriptor `id` / `version` | Language (`services.language`) | Debug (`services.debug`) | Test Explorer discovery |
| --- | --- | --- | --- | --- |
| Native backend | `robot-companion-native` / `0.1.0.dev2` | `robot-companion-backend lsp` | `robot-companion-backend dap`, Python child sessions with its debugpy handoff v1 | `robot-companion-backend discovery` (normalized discovery API v1) |
| RobotCode bridge | `robotcode` / `2.7.0` | `python -m robotcode.cli language-server --stdio` | `python -m robotcode.cli debug-launch --stdio` | `python -m robotcode.cli … discover tests` |

The native backend is the independent `robot-companion-backend` distribution in this
repository's `backend/` folder (Python 3.13, Robot Framework 7.5, debugpy 1.8.22). It is
not part of the extension package: build and install it into its own virtual environment
as described in [backend/README.md](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.1-preview.1/backend/README.md), without RobotCode in that
environment, and point the descriptor at that environment's `robot-companion-backend`
executable. Robot Companion launches it through the descriptor only; it never imports
the backend's Python code. A complete native folder configuration:

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.robotCommand": "/absolute/native-venv/bin/robot",
  "robotCompanion.languageBackend": {
    "id": "robot-companion-native",
    "version": "0.1.0.dev2",
    "contractVersion": 1,
    "workspaceUri": "file:///absolute/workspace",
    "cwd": "/absolute/workspace",
    "env": {},
    "services": {
      "language": {
        "executable": "/absolute/native-venv/bin/robot-companion-backend",
        "argv": ["lsp"],
        "transport": "stdio"
      }
    }
  },
  "robotCompanion.executionBackend": {
    "id": "robot-companion-native",
    "version": "0.1.0.dev2",
    "contractVersion": 1,
    "workspaceUri": "file:///absolute/workspace",
    "cwd": "/absolute/workspace",
    "env": {},
    "services": {
      "debug": {
        "executable": "/absolute/native-venv/bin/robot-companion-backend",
        "argv": ["dap"],
        "transport": "stdio"
      },
      "discovery": {
        "executable": "/absolute/native-venv/bin/robot-companion-backend",
        "argv": ["discovery"],
        "transport": "stdio"
      }
    }
  }
}
```

With this configuration nothing of RobotCode is involved: Test Explorer lists the tests the
native discovery service finds, **Run** starts the native venv's own `robot` (the venv has
Robot Framework 7.5), and **Debug Test** uses native debugging. Leave out `discovery` for
debugging without Test Explorer items.

A complete RobotCode folder configuration (a Python environment with `robotframework`,
`robotcode[all]==2.7.0` and `debugpy`):

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.robotCommand": "/absolute/venv/bin/robot",
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
  },
  "robotCompanion.executionBackend": {
    "id": "robotcode",
    "version": "2.7.0",
    "contractVersion": 1,
    "workspaceUri": "file:///absolute/workspace",
    "cwd": "/absolute/workspace",
    "env": {},
    "services": {
      "debug": {
        "executable": "/absolute/venv/bin/python",
        "argv": ["-m", "robotcode.cli", "debug-launch", "--stdio"],
        "transport": "stdio"
      },
      "discovery": {
        "executable": "/absolute/venv/bin/python",
        "argv": ["-m", "robotcode.cli", "--format", "json", "--no-color", "--no-pager", "discover", "tests"],
        "transport": "stdio"
      }
    }
  }
}
```

For a mixed combination, take one descriptor from each example. Changing either setting
stops that side's old processes before the new provider starts; the other side keeps
running untouched, and providers, CodeLenses and the test controller are never doubled.

**Which provider is active.** With a Robot file open, the `{}` language status entry in
the status bar lists three rows: *Language*, *Debug* and *Tests*, each with the active
provider and version (or *coexistence*, *Restricted Mode*, *refused*) and the number of
capabilities it advertises. **Details** (or **Robot Companion: Show Language Service
Status**) writes the full lines to the **Robot Companion Language** output: the exposed
language features, the DAP capabilities the debug backend advertised (read from an
`initialize`-only exchange; nothing is launched), and the discovery source. Each debug
session also writes `Robot Companion debug provider: <provider> <version>; advertises …`
as its first Debug Console line.
Each **Details** invocation appends a new status block; older blocks remain in Output.
Scroll or copy the latest block when its wrapped capability lines exceed the panel height.

**Refusals.** Before anything starts, Robot Companion refuses a descriptor whose
`contractVersion` is not 1 (*Unsupported backend contract version: 2. Expected 1.*), a
native descriptor that does not declare `0.1.0.dev2`, a RobotCode descriptor that does
not declare `2.7.0` (both name the supported and the declared version), and a service
whose executable does not exist or is not executable (the path is named). The refusal
appears as an error notification naming the setting and folder, and as *refused* in the
status entry; no process is started. After start, a language server that reports a
different name or version than its descriptor is stopped with both values named.

**Native debugging.** The native debug adapter runs the test in its own Robot worker
and, unless the launch configuration sets `"attachPython": false`, asks for the native
Python handoff v1. Robot Companion starts the **Python:** child session from it exactly as
for RobotCode (the same Call Stack nesting and console routing); the Robot session's
`configurationDone` waits until the child is attached and configured, as the handoff
requires. The Debug Console shows Robot's console output and the worker's stderr
(including debugpy's frozen-modules warning on Python 3.13); Robot `Log` messages stay in
`output.xml`, and `outputLog` applies to RobotCode only. The native adapter also supports conditional breakpoints and logpoints; the Debug Console says that editing variables
and hover evaluation are not supported. Breakpoints cannot be changed after the run has
started; hit-count breakpoints remain unsupported. When the
**Python:** child session closes at the end of a run, *Python session ended: …* is a Debug
Console line, not a notification. The backend reports an abrupt debugpy exit with the same
text, so that case is only in the Debug Console too; a session lost to any other reported
error is still a notification.
A request VS Code sends about a stop after the run has continued (for example the rest of
the call stack after a quick Continue) fails without an error notification. On stop,
Robot Companion ends the backend, its Robot worker and its debugpy adapter, each of which
runs in its own process group.

**Test Explorer discovery per combination.** Both providers have a discovery service: the
native backend's `robot-companion-backend discovery` and RobotCode's `discover tests`.
An explicit `executionBackend.services.discovery` takes precedence, followed by an
optional `robotCompanion.discoveryBackend` descriptor. In this preview an unset
`executionBackend` defaults to native debug plus native discovery; a separate explicit
`discoveryBackend` overrides that default discovery side. An explicit debug-only execution
descriptor with no discovery override has no test controller; CodeLens and Run and Debug
remain available. The *Tests* status row names the provider and which setting its discovery
service comes from. Test Explorer **Run** always starts `robotCompanion.robotCommand`;
**Debug Test** uses the `executionBackend`'s debug service.

| `executionBackend` | `discoveryBackend` | Test Explorer items from | **Debug Test** uses | Checked |
| --- | --- | --- | --- | --- |
| Native (debug + discovery) | any (not used) | native backend (`executionBackend`) | native backend | live: tree, runs, Debug Test, Stop, refresh, failures |
| Native (discovery only) | any (not used) | native backend (`executionBackend`) | none: no debug service in the explicit descriptor | synthetic editor qualification |
| Native (debug only) | native discovery descriptor | native backend (`discoveryBackend`) | native backend | live: tree and Debug Test offered |
| Native (debug only) | RobotCode discovery descriptor | RobotCode 2.7.0 (`discoveryBackend`) | native backend | live: tree and a native Debug Test run |
| Native (debug only) | not set | none: file/run fallback | — (Run and Debug) | live |
| RobotCode (debug + discovery) | any (not used) | RobotCode 2.7.0 (`executionBackend`) | RobotCode | live: tree, runs, Debug Test, Stop |
| RobotCode (debug only) | native discovery descriptor | native backend (`discoveryBackend`) | RobotCode | live: tree and Debug Test offered; a Debug Test run is unverified |
| RobotCode (debug only) | not set | none: file/run fallback | — (Run and Debug) | live |
| not set (preview native default) | native discovery descriptor | native backend (`discoveryBackend`) | native backend | live: tree and Debug Test offered; Windows unverified |
| not set (preview native default) | RobotCode discovery descriptor | RobotCode 2.7.0 (`discoveryBackend`) | native backend | preview default, Windows unverified |
| not set (preview native default) | not set | native backend (project environment) | native backend | preview default, Windows unverified |

**Verified combinations** (Linux arm64, VS Code 1.141.0, Python 3.13.7, Robot Framework
7.5, debugpy 1.8.22, RobotCode 2.7.0, native backend 0.1.0.dev2 built offline from this
checkout; the RobotCode, Python and debugpy VS Code extensions absent): each of the four
combinations starts and shows its providers; F12/Peek/Ctrl-click, the Return Explorer
link, hover, completion, signature help, references, rename and symbols with each language
provider; the full audit debug journey (Robot console keyword, Python child at
AuditLibrary.py 18, step, `count`, Robot frame, resource keyword, 1 PASS, no process left)
with each execution provider; each mixed combination live; **Debug Test** with the native
execution provider; native Test Explorer discovery with native language and debugging (no
RobotCode extension, package or process: the native venv contains no RobotCode, and no
`robotcode` process of the run exists) for the checks listed in the
[Test Explorer section](#test-explorer-run-debug-rerun-and-stop); switching back to
RobotCode; Restricted Mode and coexistence with both providers. The repository's automated UI suites drive these with real pointer and
keyboard input; they are not a human usability session.

**Not yet at parity** (the final parity gate): live per-test progress within a suite run;
native refactorings and source actions other than **Add all missing imports**; native
range and on-type formatting of whole tests and sections (setting order and empty lines);
RobotCode's **Open Documentation** source action;
semantic token deltas, inlay hints and other capabilities Robot Companion does not expose for either provider; representative real-world projects (only the synthetic audit
corpus is verified); other platforms and Python/Robot Framework versions; the minimum
VS Code version (`^1.85.0` is declared, 1.141.0 is verified); multi-root workspaces beyond
the nested-root routing check, and remote/WSL/container hosts.

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
though an unimported `AShadow.py` defines the same keyword. **Go to References** on
`Build Record` lists its call sites in `audit.robot` and `alias.robot` and its
definition in `AuditLibrary.py`, never `AShadow.py`. RobotCode 2.7.0 advertises hover,
completion, signature help, references, rename and symbols once the client declares
support for them, which Robot Companion does; with this bridge all of them are on.

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
same `"id": "robotcode"` / `"version": "2.7.0"` header as the language bridge. This is a
complete owned-mode folder configuration with RobotCode debugging and Test Explorer
discovery (leave out `discovery` for debugging only; `robotCommand` is what **Run Test**
and Test Explorer's **Run** start):

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.robotCommand": "/absolute/venv/bin/robot",
  "robotCompanion.executionBackend": {
    "id": "robotcode",
    "version": "2.7.0",
    "contractVersion": 1,
    "workspaceUri": "file:///absolute/workspace",
    "cwd": "/absolute/workspace",
    "env": {},
    "services": {
      "debug": {
        "executable": "/absolute/venv/bin/python",
        "argv": ["-m", "robotcode.cli", "debug-launch", "--stdio"],
        "transport": "stdio"
      },
      "discovery": {
        "executable": "/absolute/venv/bin/python",
        "argv": ["-m", "robotcode.cli", "--format", "json", "--no-color", "--no-pager", "discover", "tests"],
        "transport": "stdio"
      }
    }
  }
}
```

The `languageBackend` descriptor above is separate and can be added alongside. The
environment needs `debugpy` for Python debugging. Robot Companion then:

- runs the test with that environment's Robot Framework in the folder, adding
  `robotCompanion.robotArguments` (`robotCommand` keeps applying to **Run Test**), and
  writes each debug run's results to its own folder in the extension's workspace storage;
- stops on Robot breakpoints with stack, scopes and variables. The Debug Console
  runs a Robot keyword in the paused test, for example
  `Catenate    SEPARATOR=-    ${SUITE_VALUE}    console`;
- when Robot code calls into Python, opens a **Python:** child session under the Robot
  session. It stops on Python breakpoints, steps, and evaluates Python locals in the
  Debug Console. While Python is paused, Call Stack shows the Robot session (running)
  with the Python session under it. Select a Robot frame in Call Stack to send console
  input to Robot again;
- shows Robot's console output and the test's `Log` messages, each with its source line,
  in the Debug Console. Add `"outputLog": false` to the launch configuration to leave
  `Log` messages out;
- on stop, ends the Robot run, the Python debugger and every other process the session
  started.

Python breakpoints are available without the Python extension. RobotCode-specific
messages stay inside Robot Companion's adapter, including the line in which RobotCode
reports the debugpy port it picked. debugpy's own warning that frozen modules may make
the debugger miss breakpoints still opens the Debug Console on Python 3.13. It names
the interpreter option and environment variable that silence it; Robot Companion does
not change your environment to hide it.

In coexistence mode, VS Code still lists **Robot Companion** among Run and Debug's
debuggers, and picks it without asking when a `.robot` file is open and no other Robot
debugger is installed. Choosing it starts nothing and shows why: Robot Companion
debugging runs only in owned mode, so keep using your existing Robot debugger.

#### Experimental owned Test Explorer discovery

When the folder's `robotCompanion.executionBackend` also has a `services.discovery`
entry (or, when it has none, `robotCompanion.discoveryBackend` does; see
[Test Explorer discovery per combination](#choosing-the-provider-native-backend-or-robotcode)),
Robot Companion starts that process and asks it for tests with the
integration's normalized discovery API (`robotCompanion/discoverTests`, version 1; the
backend must advertise `robotCompanionDiscovery.version` 1 when it initializes). Suites
and tests appear in Test Explorer under **Robot Companion**, one top-level suite per
`.robot` file with its tests and tasks below it, labelled as the backend names them. Their
IDs are built from the file URI and the test name (plus `#2`, `#3` … for a repeated name
in one file), so they stay stable across backends and restarts. A click on a test opens
its source at the test's name line. Saving a `.robot` file rediscovers; after files are
added, renamed or deleted outside the editor, **Refresh Tests** (the Testing view's
refresh button) starts the discovery service again and shows the new tree without a
window reload.

Discovery never shows a partial tree silently:

- When the backend reports files it could not read or parse completely (the native
  backend's `errors`, for example an unknown section header or an empty test), the tree
  shows what Robot Framework would run and, next to it, one error item per problem,
  labelled `<file>: discovery error (line n)` with Robot's message; the *Tests* status row
  turns into a warning with the error count.
- When the discovery service cannot start, exits or crashes, answers with a JSON-RPC
  error, or returns an invalid result (for example a source outside the folder), the
  folder's tree is emptied (never kept stale) and replaced by one error item
  `<folder>: discovery unavailable` with the reason. An error notification names the
  setting and the folder, and the *Tests* status row shows *refused*. **Refresh Tests**
  tries again. The folder's language service and debugging keep running.

Without a discovery service, or outside owned mode, no Robot Companion test controller
is registered; navigation, debugging and the CodeLens runner keep working. Running,
debugging and stopping tests from Test Explorer are described
[below](#test-explorer-run-debug-rerun-and-stop).

With the native backend, discovery works when the `executionBackend` (or a
`discoveryBackend` descriptor) has the `discovery` service of the
[native folder configuration](#choosing-the-provider-native-backend-or-robotcode). The
service reads the folder with Robot Framework's own parser on every request and imports
or runs nothing; its rules (what counts as a suite, labels such as `Login On staging` for
`Login On ${ENVIRONMENT}`, and errors) are in
[backend/README.md](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.1-preview.1/backend/README.md#services).

With the RobotCode bridge, discovery works when the `executionBackend` has the
`discovery` service shown in the [owned debug example](#experimental-owned-debug-type).
Robot Companion runs that command for the folder (it appends the folder path), and on each
save, and converts RobotCode's result to the normalized tree. This was checked live: RobotCode
discovery lists the audit test at its source line, a click opens it, and **Run** with
`robotCompanion.robotCommand` set to that environment's `robot` reports PASS from the
run's output.xml. In the same owned configuration, a click on audit.robot's **Run Test**
CodeLens runs the test with that `robotCommand` and reports it passed. Other discovery and
run checks use a local fixture and a fake `robot`.

#### Test Explorer run, debug, rerun and Stop

In owned mode with a discovery service, Test Explorer runs real Robot Framework:

- **Run** works on one test, a multi-selection (Ctrl/Cmd-click rows, also across
  suites), a suite or everything. Robot Companion starts one Robot run per suite file
  with the folder's `robotCompanion.robotCommand` and `robotCompanion.robotArguments`,
  in the workspace folder, without a shell. Each selected test name becomes a `--test`
  filter (glob characters escaped); a suite selected as a whole runs without filters.
  Robot selects a test by its name as written, while discovery and `output.xml` give the
  name with its variables replaced (`Login On ${ENVIRONMENT}` runs as `Login On staging`),
  so for such a test the filter is the written name read from its name line in the file.
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
  with SIGTERM, then with SIGKILL after two seconds.
- During **Debug Test**, both the Testing **Stop** and the debug toolbar **Stop** end
  the debug session. If the debug backend does not end the session itself (for
  example while Robot waits in a long keyword), Robot Companion ends the debug
  adapter's process group (the RobotCode launcher, Robot and the processes Robot
  started) about two seconds after the debug toolbar Stop, or about five seconds
  after the Testing Stop. The Python debugger then exits with Robot.
- Tests that Robot had already finished keep their result from that run's
  `output.xml`; every other test of the stopped run or debug session, and of runs that
  had not started, is marked **Skipped**. Nothing is left running, and the next Run or
  Debug Test starts normally.
- **Debug Test** is offered when the same `executionBackend` also has a debug service.
  It starts the owned **Robot Companion** debug type for exactly the selected tests (one
  session per suite file), linked to the test run, so breakpoints, stepping and the
  Debug Console work as described [above](#experimental-owned-debug-type). When the
  session ends, the result comes from that debug run's own `output.xml`.

If discovery is unavailable, Test Explorer shows only the error item; F12 navigation,
the **Run Test** CodeLens and Run and Debug launch configurations keep working.

Checked live (Robot Framework 7.5, RobotCode 2.7.0 discovery and debug, VS Code 1.141.0,
1280x900) with actual pointer input on Test Explorer rows, their Run Test and Debug Test
actions, the Test Results **Rerun Failed Tests** action, and the Testing Stop button during
a run, plus both the Testing Stop (while Robot waits in a long keyword) and the debug
toolbar Stop (while the Debug Test is paused at a breakpoint) during a Debug Test. After
each Stop the process list has no Robot, RobotCode, debugpy or child process of that run left.

Checked live the same way with the native backend for language, debugging and discovery
(no RobotCode anywhere; Robot Framework 7.5 from the native venv): the Test Explorer tree
equals the tree a separate `robot-companion-backend discovery` request returns for the
folder (labels, ranges, nesting, a `*** Tasks ***` file, a test named
`Grüße aus Köln 🎉 und 𝄞`, two tests named `Duplicate Name` in one file as two rows, and
the backend's discovery errors as error items); clicking a test row opens its name line,
including the second `Duplicate Name`; a Ctrl-click multi-selection across a test file and a
task file runs exactly those three in two Robot runs; Rerun Failed Tests; Run on a suite
row; each `Duplicate Name` reports its own occurrence's result; `Login On staging` runs by
its written name; Stop ends the Robot process group; Debug Test stops at a gutter
breakpoint and reports PASS from its own `output.xml`; Stop during a Debug Test leaves no
native backend, Robot worker, debugpy or child process. **Refresh Tests** shows a file
added, renamed and deleted on disk, and a file with a parse error as an error item next to
its tests. A killed discovery service, one that fails to start and one that answers with
a JSON-RPC error each show the error item, the error notification (in the notification
center) and the *refused* status; the native language process keeps running and a native
Run and Debug launch still passes. Test names with emoji or other non-BMP characters show
as boxes in this test host's fonts; the labels themselves are exact.

Not supported yet: coverage, continuous run (run on save), test tags and filter
profiles (only the Test Explorer text filter), test-level parallel runs within a suite,
and live per-test progress during a suite run (a suite's tests turn from running to
their result when that Robot run ends). Robot cannot select one of several tests with the
same name in a file, so running one `Duplicate Name` runs all of them in that file; only
the selected one gets a result, from its own entry. Each suite file runs on its own, so a parent
folder's `__init__.robot` setup and teardown do not run (as with the **Run Test** CodeLens). Robot matches `--test` names ignoring case,
spaces and underscores, so two tests in one file whose names differ only in those
both run when one is selected; only the selected one gets a result.

Use **Robot Companion: Show Language Service Status** for process state, negotiated
capabilities and errors in the **Robot Companion Language** output channel. After
fixing configuration or a backend failure, use **Restart Language Service**. Changes
to the descriptor/mode restart the owned process; returning to coexistence removes
owned providers and diagnostics, including when initialization or shutdown stalls.
Nested workspace folders route definitions and watched-file events to their owning
folder's backend. Restricted Mode starts no language processes and
reads no executable descriptors. Granting trust starts the configured service; revoking
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
and no session process is left. Test Explorer discovery and runs are checked live with
RobotCode as its discovery service (see above). A synthetic saved workspace verifies nested-folder
language routing and removal on this host. Broader multi-root execution/debug,
remote hosts and the declared minimum VS Code 1.85 compatibility are unverified.

The owned editor features are checked live against RobotCode 2.7.0 with actual pointer
and keyboard input in a 1280x900 VS Code window: the hovers over `Build Record` and `Local Step`
(one hover, their documentation once), over `${record}` (Companion's return hint, then
RobotCode's part), and over the `#>` block, whose **Open full rendered preview** link is
clicked open; keyword suggestions after
typing `Bui`, variable suggestions after `${` without duplicates, the active parameter
`name: str = Ada`, the Shift+F12 references peek, F2 renaming `Resource Step` in
`audit.robot` and `shared.resource`, the refused rename's notification, the Outline view,
and both symbol pickers. Capability gating is checked with the local protocol fixture: a
server without hover or rename gets no hover or rename provider and receives no such
request.

Owned mode is not yet full RobotCode-extension parity. Robot Companion exposes the
server's definitions, diagnostics, hover, completion, signature help, references, rename,
document/workspace symbols, code actions, document/range/on-type formatting
([details](#owned-code-actions-and-formatting)) and whole-document semantic tokens
([details](#owned-semantic-highlighting)). It does not expose semantic token deltas or
inlay hints, nor RobotCode's document highlights,
implementation, folding and selection ranges, CodeLenses or inline values, although
RobotCode advertises them. There is also no
Test Explorer coverage or continuous run, coverage profile, REPL/notebook, or
reverse/data/function breakpoint support.

Workspace trust transitions were checked with the RobotCode 2.7.0 language bridge in a
normal VS Code window with workspace trust enabled (not the test runner, which disables
trust), with actual clicks: in Restricted Mode no backend process starts; **Trust** in the
Workspace Trust editor starts it; **Don't Trust** restarts the extension host and the
owned process is gone, and none starts again. `npm run test:trust` repeats this check
(it needs a display, for example `xvfb-run -a npm run test:trust`, and the prepared
environment).

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
bounded to two seconds and 64 KiB output, with an eight-second refresh deadline. A cancelled probe
still counts toward the two until its process has exited, at most two seconds. **Refresh** clears
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
exclusive with test runs and never starts from selection/detection alone: starting a run meanwhile
says that robotframework is being installed in that interpreter. A cancelled or timed-out
installation keeps runs blocked until pip has exited; it is force-stopped after 250 ms, and runs
are allowed again at the latest two seconds after the cancel or timeout. Success is reported
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
trusted workspace. In a trusted workspace, opening or switching to a `.robot` file runs an
availability check of that file's effective environment for the status item: it starts the
selected Python or Robot executable with a version probe (and, for the **Python extension**
source, asks that extension for its interpreter), never a test. A recent result is reused for up to
30 seconds, five after a failure. In Restricted Mode environment detection, Python API activation,
installation, and the run CodeLenses/commands start nothing and
explain that the workspace must be trusted (*Manage Workspace Trust*). Trust is checked again
immediately before each process or Python API activation, including after confirmation. After
granting trust the status item reads *Robot: Refresh required*. The check then runs on the next
switch to a `.robot` editor, or on an explicit refresh: opening the picker checks every candidate
(again on its **Refresh**), and the status item is updated when the picker closes. If VS Code
reports a setting change when trust is granted, for example for a workspace
`robotCompanion.robotCommand`, the status refreshes at once, as after any change to that setting.
Tests and installation never auto-start.
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
| Search Keywords in Scope | `robotCompanion.searchKeywords` |
| Refresh Keywords | `robotCompanion.keywordView.refresh` |

**Insert Keyword Call** and **Go to Keyword Definition** are in the Robot Keywords view's
row context menu.

## Settings

Robot Companion contributes 47 settings under the `robotCompanion.` prefix, covering feature
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
process group is gone; it includes the native discovery suite
(`ROBOT_COMPANION_UI_SUITE=native-discovery` runs only that one, skipped when the native
backend venv cannot be built), which does the same with native language, debugging and
discovery and also clicks **Refresh Tests** and checks discovery failures.
`ROBOT_COMPANION_UI_SUITE=keywords` runs only the Robot Keywords view, keyword search and
Python library rename suite (skipped when the native backend venv cannot be built).
Use `ROBOT_COMPANION_UI_SUITE=language npm run test:ui` for those focused suites, and
`ROBOT_COMPANION_UI_EVIDENCE_DIR=/path/to/ui/screenshots` to retain their screenshots
and action transcripts.
The UI suite's synthetic workspace has no project `.venv`, so its saved workspace settings
start in coexistence mode; each owned suite selects the mode and descriptors per folder.
`npm run test:integration` checks the shipped owned default.

For an offline prepared test host, set `ROBOT_COMPANION_VSCODE_EXECUTABLE` to its
VS Code executable before running the UI suite; the runner then skips version lookup
and download.
The Linux editor qualification requires a **CSS viewport** of 1280×900. On the pinned
VS Code 1.141.0/Xvfb host, use `xvfb-run -a -s '-screen 0 1280x901x24' npm run test:all`;
the one extra Xvfb pixel produces the required CSS height. Keep the suite's viewport
assertions enabled. See the [preview UI qualification record](agent/documentation/mis-505-ui-qualification.md)
for baseline findings, fixture/default separation, evidence paths and offline launch details.

The native live cases build `backend/` offline into an owned scratch venv
(`tests/native-backend.js`): `pip --no-index` from `ROBOT_COMPANION_ROBOT_WHEELS`
(default `/opt/robot-wheels`) with `ROBOT_COMPANION_NATIVE_PYTHON` (default `python3.13`,
`python.exe` on Windows; Python 3.11 or 3.13). On Windows the venv's `Scripts\python.exe`
and `Scripts\robot-companion-backend.exe` are used; set both variables to absolute paths
there. `ROBOT_COMPANION_UI_SUITE` accepts `all` (the default), `language`, `test-explorer`,
`native-discovery`, `native-libraries` and `providers` (see `tests/ui/suite/suites.js`);
`native-libraries` runs only the native class, dynamic and Run Keyword resolution suite.
With `ROBOT_COMPANION_UI_REQUIRE_NATIVE=1` the run fails closed: an unavailable native
backend, an undeclared suite value, any failing or skipped test, or zero executed tests in
the run or in one of its test files makes it exit non-zero. Each run writes
`ui-test-counts.json` (passes, failures, pending and total per test file) and the backend
receipt `native-backend-venv.json` to `ROBOT_COMPANION_UI_EVIDENCE_DIR`; a required run
also writes its verdict, with any `ROBOT_COMPANION_UI_GREP` filter, to `ui-run-result.json`.
Without an evidence directory a required run still checks the counts, in its temporary
profile. For example:

```bash
ROBOT_COMPANION_UI_SUITE=native-libraries ROBOT_COMPANION_UI_REQUIRE_NATIVE=1 \
  ROBOT_COMPANION_UI_EVIDENCE_DIR=/tmp/ui-evidence xvfb-run -a node tests/ui/run-ui-tests.js
```

`npm run test:native-backend-layout` checks the Windows and Linux venv layout and these
suite values on any host; it is logic coverage, not a Windows run.

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

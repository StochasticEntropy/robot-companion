# Robot Companion — native backend preview

> Alpha preview 1.3.19 bundles backend 0.1.0.dev18. Queued same-document definition queries may pass recognized passive queries while retaining mutation barriers and fairness; active work is unchanged. Conservative direct-call candidates reduce declaration proof work without weakening selected-candidate validation or full rich metadata. Previous native features remain included. Actual Citrix latency and the repeated platform matrix require separate verification; no instant navigation guarantee is made.


This prerelease adds an independent Robot Framework backend for keyword navigation,
language features, Test Explorer and mixed Robot/Python debugging. Native services
are the default in this preview; RobotCode and the Python/debugpy VS Code extensions
are not required. The regular release channel stays available.

**Setup: install the extension and select your project's Python.** The extension carries
its Python backend. Open the project, choose the project's existing Python interpreter
(Python 3.11 + Robot Framework 7.3.2 or Python 3.13 + Robot Framework 7.5) and, when
Robot Companion reports that its backend is missing or another build, choose **Install
Backend** or **Update Backend** and confirm. See [backend setup and updates](#backend-setup-and-updates).
No wheel download, terminal command or second environment is needed; Robot Framework,
RobotCode and your project's libraries stay as they are. The manual
[Windows setup guide](WINDOWS-PREVIEW.md) remains an advanced, offline alternative.

Choose the project's Python interpreter once per workspace folder with **Robot
Companion: Select Robot Environment** (or the **Robot: …** status item). That one
interpreter then runs the native language, discovery and debug services
(`python -m robot_companion_backend`) and Run Test / Run Suite (`python -m robot`);
see [one environment for every service](#one-environment-for-language-discovery-debug-and-runs).
Without a selected interpreter the native executable defaults to
`.venv/Scripts/robot-companion-backend.exe` on Windows (`.venv/bin/robot-companion-backend`
elsewhere). The restricted folder setting `robotCompanion.nativeBackendExecutable` and
`robotCompanion.robotCommand` remain explicit overrides of the backend and of runs.
Nothing is downloaded, and nothing is installed without your confirmation. RobotCode remains an optional
explicit fallback. Coexistence mode disables owned language/debug/discovery services.

**Experimental:** complete Windows native debug/discovery/UI qualification is pending.
The release includes targeted portability repairs and Linux runtime validation;
see [release notes](https://github.com/StochasticEntropy/robot-companion/releases/tag/v1.3.19-preview.1) for the tested scope and remaining limits.

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

- **Debug Test at Cursor** is available in the editor’s right-click menu for `.robot` files. In owned mode with the native backend, it saves the active suite and asks a separate native discovery service about that file and its ancestor init settings. It selects the exact test source and name line, so a new file can be debugged while workspace discovery is pending or has timed out. Cancellation, changed text or cursor position, an excluded test and unavailable discovery stop the action with a specific message. Other providers use VS Code’s Testing debug action and need a discovered test. The built-in **Test: Debug Test at Cursor** action still uses Test Explorer’s current tree.

- In owned mode, **Run Test**, **Run Test at Cursor** and **Run Suite** use VS Code’s
  Test Explorer and Test Results. Native discovery identifies the saved file’s exact test
  source and name line; **Run Suite** selects only that file. CodeLenses carry the source
  line, so duplicate names and configuration substitutions do not select another test.
  Coexistence keeps the legacy live output and pass/fail notification with log/report links.
  See [Running tests](#running-tests).

The locating progress ends before Run or Debug starts. Informational ignored settings,
including RobotCode tool sections in `robot.toml`, remain visible in output without blocking
selection; invalid configuration and source errors still refuse it.

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

- VS Code 1.141.0 or newer (`^1.141.0`, the version the checks run; see [supported hosts](#several-folders-remote-hosts-and-supported-vs-code))
- Robot Framework projects; Python keyword files are indexed from the workspace.
- Running tests needs Robot Framework installed in the selected environment (or where `robotCompanion.robotCommand` finds it),
  and a trusted workspace.

The extension has no runtime npm dependencies.

### Experimental owned language service

Selecting `robotCompanion.integrationMode: "coexistence"` keeps the existing
documentation, hints, folding and run commands. It registers none of the owned
language providers (definitions, diagnostics, hover, completion, signature help,
references, rename, symbols, code actions, formatting, semantic tokens, inlay hints) and starts no language backend. `.robot` and `.resource`
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
[after that](#owned-semantic-highlighting) and inlay hints [last](#owned-inlay-hints); other
server capabilities are not exposed.

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
selection does not change `robotCommand` or select a debug backend. An explicit descriptor
is used as written: the folder's selected Robot environment does not apply to it. No automatic
package installation is provided.

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

**Named arguments.** With the native backend, type an argument name or press
**Ctrl+Space** in an argument cell to choose `name=` from the current keyword's
signature. Suggestions also open after a cell separator and on `...` continuation
lines. Arguments already supplied by name or position are omitted. Completing a
partially typed name before `=` preserves the existing value. Parameter details
show the declared type and default where available; source-only declarations are
labelled because runtime decorators can change their contract. Unresolved or
ambiguous calls do not invent parameters. Value, variable and enum completion
continue to work after `=`.

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
without `__init__.py`. A name not found there is looked up in the same way on the language
service's own `sys.path`: the selected interpreter's site-packages (see
[one environment for every service](#one-environment-for-language-discovery-debug-and-runs)).
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

**Native backend 0.1.0.dev18** advertises `codeActionProvider` (`quickfix` and
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

**Install Backend** adds the backend without this optional formatter. To get **Format Document**,
add Robocop 9.1.0 to the project environment yourself (the backend's `format` extra); the
[Windows setup guide](WINDOWS-PREVIEW.md) includes the offline, constrained installation command.

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

Dark+ and Dark Modern use Robot Companion's default Robot palette: pale yellow keyword
calls (`#DCDCAA`), blue variable names and named arguments (`#9CDCFE`), yellow variable
delimiters (`#FFD700`), purple control flow (`#C586C0`), green comments (`#6A9955`),
and orange literal arguments (`#CE9178`). These defaults are scoped to Robot tokens;
other languages and the workbench theme are unchanged. Other themes retain their own
palette. User `editor.tokenColorCustomizations` and
`editor.semanticTokenColorCustomizations` can override the defaults. To override a
TextMate color from this dark-theme palette, put that rule inside the matching
`[Default Dark+][Default Dark Modern][Dark+][Dark Modern]` theme block, following VS Code's normal
theme-specific customization precedence. Generic semantic color rules still apply.

The native semantic provider keeps variable names and their declaration/resolution
information. The editor presentation leaves variable delimiters and Robot's `IN`
separators to the bundled grammar, so the colors agree before and after the backend
starts. This presentation does not change the server's tokens or its delta cache.

In owned mode Robot Companion registers semantic token providers when the server
advertises `semanticTokensProvider`. They use exactly the legend the server advertises
(its token types and modifiers, in its order):

| Server offer | In VS Code |
| --- | --- |
| `full` | Whole-document semantic tokens: the theme colours keyword calls, variables, settings and section headers by their token type. **Developer: Inspect Editor Tokens and Scopes** shows the *semantic token type* and modifiers under the cursor |
| `full.delta` | After an edit, only the changes: the server sends edits against its last whole-document result, which Robot Companion applies to that result |
| `range` | Tokens for the visible lines while a whole-document result is pending |

With a `full.delta` offer Robot Companion keeps, per open document, the last whole
result the server sent (dropped when the document closes or the service restarts). After
an edit it sends only that result's ID, applies the server's edits and checks the edited
tokens like a whole result. When VS Code's last result is another one (another request,
such as the token inspector's own, replaced it), the edits are refused or the delta request
fails, it asks once for the whole document instead (a line in the **Robot Companion
Language** output). The server's `workspace/semanticTokens/refresh` request makes
VS Code ask again. Token data with a type or modifier outside the server's legend is
refused as a whole (a line in the **Robot Companion Language** output) instead of being
shown. Positions are LSP UTF-16 units, so a token after umlauts or characters such as
😀 or 𝔘 covers exactly its own characters. Colours follow the theme; VS Code's default
`editor.semanticHighlighting.enabled: "configuredByTheme"` applies them with the default
themes.

**Native backend 0.1.0.dev18** offers `full` with deltas and `range`. A delta is computed
from the same complete token set as a whole result, so it never changes a token's
meaning. The service keeps the last whole result of at most 64 documents (least recently
used out; a closed document's is dropped). An ID that is not a document's last result
(stale, unknown, evicted, or issued by an earlier process before a restart) gets the
whole result. Its legend:
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
registered. Robot Companion also bundles a TextMate grammar for `.robot` and `.resource`
files, so basic syntax colouring remains available without a backend, in Restricted Mode
and in coexistence mode. Semantic tokens add import-aware detail when the owned language
service is ready. The token inspector distinguishes the grammar scopes from semantic tokens. Folding, CodeLenses, the Documentation Preview and its exports, and the
return, enum and argument hints are Robot Companion's own and work the same in both modes.

Checked live with both providers in VS Code 1.141.0 at 1280x900 with actual pointer and
keyboard input: a click on the token, then **Developer: Inspect Editor Tokens and
Scopes** from the Command Palette shows the token's text and its semantic token type for
`Build Record`, `${record.name}`, `Library` and `*** Test Cases ***` in `audit.robot`, and
for `${GRÜSSE}` and `${wert.name}` on the line `Log    Äöü 😀 ${GRÜSSE} 𝔘 ${wert.name}` and
the test name `Prüfung 😀 Umlaute`. Coexistence mode shows no semantic token. A local
protocol fixture checks whole-document, delta and range requests, refresh, invalid data,
and fallback to a whole result after rejected edits, a failed delta request or a stale base.
Inlay hints are described [next](#owned-inlay-hints).

#### Owned inlay hints

In owned mode Robot Companion registers one inlay hint provider when the server advertises
`inlayHintProvider`. VS Code shows the hints inside the line, in its inlay hint style,
and asks again after an edit of the document, of another open Robot file, or of a Robot
or Python file of the folder on disk. A hint is shown as text only: a hint's text edits
and a label part's command or location are not used.

**Native backend 0.1.0.dev18** shows two kinds of hints for a keyword call that resolves,
through the file's imports, to exactly one keyword whose signature it reads statically
(the same resolution as **Go to Definition**):

- **Argument names** before positional values: `Audit.Build Record    name=Ada` shows
  `name=` before `Ada` (`name:` for a positional-only Python argument). A value written as
  `name=value` gets none, and so does everything after it, after a `@{list}` or `&{dict}`
  expansion, or beyond the last named parameter (`*args`): Robot Framework decides those
  only when it runs.
- **Declared return types** after a single, untyped assignment: `${record}=    Build Record    Ada`
  shows `: Record` after `${record}` when the Python keyword declares `-> Record`. A typed
  (`${n: int}=`) or multiple assignment, and a keyword without a declared return type, get none.

Hovering a hint names its keyword and where it comes from, for example *Argument name of
Build Record · Library Audit · AuditLibrary.py*. An ambiguous call (two imported libraries
define it), an unresolved or embedded-argument call (`Greet ${name} Kindly`) and a library
that is not imported get no hint: nothing is guessed. Positions are UTF-16 units, so a
hint after umlauts, 😀 or 𝔘 sits directly before its value.

**RobotCode 2.7.0** shows its own hints: argument names (`message=`) and the library or
resource a call comes from (`BuiltIn.`, `Audit.`).

Three settings, per folder, switch them; changes apply at once without a restart:

| Setting (default) | Effect |
| --- | --- |
| `robotCompanion.inlayHints.enabled` (`true`) | Off: no hints and no inlay hint request. Hover, Return Explorer, CodeLenses, completions and semantic highlighting are unchanged |
| `robotCompanion.inlayHints.parameterNames` (`true`) | Argument-name hints |
| `robotCompanion.inlayHints.returnTypes` (`true`) | Return-type hints |

A hint without a kind (RobotCode's library prefix) follows only `enabled`. VS Code's own
`editor.inlayHints.enabled` also applies. Coexistence mode, Restricted Mode and a server
without `inlayHintProvider` register no provider. Each folder's backend answers only for
its own files, so a nested workspace folder never shows a hint twice.

Checked live in VS Code 1.141.0 at 1280x900 with actual pointer and keyboard input on the
native backend's synthetic corpus (`backend/tests/inlay_fixtures`): every hint is drawn
once, at its position, also on a line with umlauts and non-BMP characters; hovering a hint
shows its tooltip; a typed call, a library changed on disk and an unsaved resource edit
update the hints; the settings, switched in the Settings editor, remove argument names and
then all hints while hover, CodeLenses and semantic tokens stay the same; a nested folder
and a switch to RobotCode and back show each hint once. A local protocol fixture checks the
gating, the settings by kind, the refresh request and that malformed hints are skipped.
Windows has not been checked.

#### Choosing the provider: native backend or RobotCode

Two providers can serve owned mode. `robotCompanion.languageBackend` and
`robotCompanion.executionBackend` each select one of them on their own, so all four
combinations work: native language with native debugging, either mixed, or RobotCode
for both.

| Provider | Descriptor `id` / `version` | Language (`services.language`) | Debug (`services.debug`) | Test Explorer discovery |
| --- | --- | --- | --- | --- |
| Native backend | `robot-companion-native` / `0.1.0.dev18` | `robot-companion-backend lsp` | `robot-companion-backend dap`, Python child sessions with its debugpy handoff v1 | `robot-companion-backend discovery` (normalized discovery API v1) |
| RobotCode bridge | `robotcode` / `2.7.0` | `python -m robotcode.cli language-server --stdio` | `python -m robotcode.cli debug-launch --stdio` | `python -m robotcode.cli … discover tests` |

The VSIX includes the matching `robot-companion-backend` distribution and debugpy 1.8.22.
Normal setup installs them into the selected project's existing Python after confirmation;
no separate backend environment or download is needed. Supported project runtimes are
Python 3.11 / Robot Framework 7.3.2 and Python 3.13 / Robot Framework 7.5. See
[backend setup and updates](#backend-setup-and-updates).

The independently buildable source remains in `backend/`; its
[advanced build guide](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.19-preview.1/backend/README.md)
is optional. The explicit descriptor example below is also an advanced override. Normal
setup selects the project interpreter for every native service without this JSON:

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.robotCommand": "/absolute/native-venv/bin/robot",
  "robotCompanion.languageBackend": {
    "id": "robot-companion-native",
    "version": "0.1.0.dev18",
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
    "version": "0.1.0.dev18",
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
native descriptor that does not declare `0.1.0.dev18`, a RobotCode descriptor that does
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
(including debugpy's frozen-modules warning, observed on Python 3.13.7 and 3.11.17); Robot `Log` messages stay in
`output.xml`, and `outputLog` applies to RobotCode only. The native adapter advertises
`configurationDone`, `terminate`, restart/cancel, conditional breakpoints, logpoints,
hit counts, Robot failure stops and paused scalar editing. Hover evaluation remains unsupported.

**Native breakpoint editing, Pause and Step Out.** Robot breakpoints can be added and
removed in the gutter (or with F9) while the session runs. While Robot is paused the
change takes effect before you continue: **Continue** (F5) stops at an added line and not
at a removed one. While Robot is running, the backend answers that the breakpoint is not yet verified
(*Applies when the running Robot test reaches its next keyword*; VS Code 1.141 still draws
a normal breakpoint glyph) until the test starts its next keyword; then it is verified
and can stop there. **Pause** (the toolbar button or
F6) stops the running test before its next keyword, showing that keyword's line, the
call stack and variables. A library keyword that is blocking — a long `Sleep`, Python
code waiting for something — is not interrupted: the Debug Console says *Pause requested:
Robot stops before its next keyword. Library code that is running now is not
interrupted.*, nothing shows as paused until the keyword returns, and **Stop** ends the
run at once. **Step Out** (Shift+F11) runs the rest of the current Robot user keyword
(the one whose body has the current line) and stops at the next keyword of its caller,
with that frame's current variables. At test or suite level there is no keyword to leave:
a notification says *Step Out is not available here …*, and the session stays paused, so
use Step Over or Continue. Changing a suite's text during a run does not reload it; save
and start a new run.

A breakpoint on a setting line
that calls a keyword stops at that call each time it runs: `Suite Setup`, `Suite Teardown`,
`Test Setup` and `Test Teardown` (also in a directory's `__init__.robot`), and `[Setup]` or
`[Teardown]`. When the setting's keyword is `NONE` or empty, the breakpoint stays
unverified with *No executable Robot keyword call at this line*. A `Test Setup` or
`Test Teardown` line in `__init__.robot` stays unverified too: Robot Framework runs that
default inside each test and reports it in the test's own file, so set the breakpoint in
the keyword it calls. Whether a Robot breakpoint is verified comes from the Robot session
alone, also while the **Python:** child session is attached. When the
**Python:** child session closes at the end of a run, *Python session ended: …* is a Debug
Console line, not a notification. The run still ends with Robot's own exit code (0 when
every test passed) in the **Robot Companion Debug** output line *Robot run ended with exit
code …* and in the result Test Explorer uses. The backend reports an abrupt debugpy exit with the same
text, so that case is only in the Debug Console too; a session lost to any other reported
error is still a notification.
A request VS Code sends about a stop after the run has continued (for example the rest of
the call stack after a quick Continue) fails without an error notification. On stop,
Robot Companion ends the backend, its Robot worker and its debugpy adapter, each of which
runs in its own process group. **Stop** or **Disconnect** ends a paused run at once, whether
Robot or Python is paused, without a warning: Robot records it as *Execution stopped by
user.* and the **Robot Companion Debug** channel shows exit code 253. A run that ends by
itself reports its own exit code (0 when it passed).

**Native restart.** The debug toolbar's **Restart** (Ctrl+Shift+F5) restarts a native
session in place, whether Robot or Python is paused or the test is running; restarting from
the **Python:** child restarts its Robot session. The same Robot session continues: the
backend stops the old Robot worker, its debugpy adapter and the Python child, then starts
new ones with the same target, folder, Robot arguments and Python setting. Robot
breakpoints keep their identity and are verified again. Python breakpoints go to the new
**Python:** child, which replaces the old one under the same Robot session. Variables and
frames of the earlier run become invalid; asking for one gives *Stale Robot handle from an
earlier run of this session*. Each restarted launch writes its results to a new folder, so
the earlier run's `output.xml` is kept and Test Explorer reads the last run. The replaced
run's `output.xml` records *Execution stopped by user.*, whether Robot or Python was
paused. A restart
cannot change the configuration. If you change the target, arguments or `attachPython` in
`launch.json` and then press **Restart**, the restart is declined with *Restart declined:
Restart cannot change …*. The paused session continues unchanged and stays fully usable
(Continue, the Debug Console, Stop), and no output folder is created for it; stop it and
start it again to use the edited configuration. If the restarted run cannot start (for example the Python
child does not attach within 30 seconds), or the restart is cancelled, the session ends
and all of its processes are stopped.

**Attaching to a prepared run (native backend).** Robot Companion attaches only to a Robot
run that the native backend started and owns for this purpose. It cannot attach to an
arbitrary process ID or network address. Prepare the run in a terminal with the project
environment's backend, inside a trusted workspace folder that uses the native execution
backend in owned mode:

```sh
robot-companion-backend dap-prepare --workspace /absolute/workspace --target tests/audit.robot --attach-python -- --variable ENV:dev
```

`--workspace` must be the VS Code workspace folder. `--target` can be repeated, and
`--cwd` sets the run folder (default: the workspace folder). Robot options follow `--`;
leave out `--attach-python` to debug Robot only. The command starts the Robot worker,
which waits before running anything, and prints two lines:

```text
Robot Companion prepared session 5f0c… (digest 3e1a…) waits 30 s for one attach.
preparedSession: /tmp/rcb-prepared-k2x9/session.json
```

Within 30 seconds (`--attach-timeout` can shorten this), start an attach configuration
with that path from Run and Debug or **Debug: Select and Start Debugging**:

```json
{ "type": "robotcompanion", "request": "attach", "name": "Robot Companion: Attach prepared run",
  "preparedSession": "/tmp/rcb-prepared-k2x9/session.json" }
```

Breakpoints, the Debug Console, the **Python:** child and **Restart** then work as for a
launch. A restarted prepared run writes its results to a new folder below the prepared run's
output folder (`restart-1`, `restart-2`, …; the Debug Console names it), so the earlier
`output.xml` is kept. Before the session starts, Robot Companion asks the backend to check the descriptor,
without using it up. A consumed, expired, invalid or unsafe descriptor is refused with
*Cannot attach to the prepared Robot session: …*. No debug session starts, and the next
start works as usual. A descriptor that passes this check but whose `dap-prepare` has ended
fails at the connection instead (for example *Connection refused*): the session ends with
that message, nothing stays behind, and the next start works as usual. The descriptor file is private to your account and can be used once: the first
authenticated connection consumes it, and the file is removed. It contains a one-time
secret, so do not copy it into `launch.json` or share it; the configuration only names its
path. A session that is not attached in time ends, and so does an attached session that is
not configured within 30 seconds. **Disconnect** and **Stop** end the prepared run and its
processes; detaching and leaving the run alive is not supported. A raw DAP client that
sends `disconnect` with `terminateDebuggee: false` gets *Owned native sessions cannot
detach; disconnect ends the owned run*, and the run still ends. Ctrl+C in the terminal also
ends the run. Restricted Mode, coexistence mode and a RobotCode execution backend start
nothing for a prepared attach and say why. An attach configuration with `processId`,
`host`, `port` or a secret is refused with the reason.

**Hit counts, Robot failure stops and changing values (native).** These use VS Code's own
controls; nothing extra is installed.

- *Hit count.* Right-click the breakpoint gutter > **Add Conditional Breakpoint...** (or
  **Edit Breakpoint** on an existing one), choose **Hit Count** and type the count. Accepted:
  `N` or `==N` (only the Nth time the line runs), `>=N` (the Nth time and every later time)
  and `%N` (every Nth time), where N is a whole number from 1 to 2147483647; spaces or tabs
  around the operator and number are allowed. **Hit Count** submitted with nothing typed is
  a plain breakpoint. Anything else, such as `0`, `>2`, `2.0`, a space or
  `02`, is refused with *Invalid hit count (hitCondition) at line …* as an error
  notification. None of that file's breakpoints is then active for the run, although
  the editor may still draw them; fix the count and start again. Every time the line's keyword call runs counts, also
  when a condition is false; the condition is checked only on matching counts, then the
  logpoint is written or the run stops. Calls Robot does not run (NOT RUN), the inner
  keyword of `Run Keyword` and keywords typed into the Debug Console do not count;
  recursive calls do. Counts start at zero for each debug run and continue across tests.
  Breakpoints, including hit counts, are set before the run starts.
- *Robot failure stops.* In **Run and Debug > Breakpoints**, two checkboxes appear once
  a native session has started. Both are off by default. **Robot: failed keyword (includes
  handled failures)** stops after any keyword ends with FAIL, also when `TRY/EXCEPT` or
  `Run Keyword And Ignore Error` handles it. A failure that makes enclosing keywords fail
  stops again for each of them. **Robot: failed test/task (final outcome)** stops when a
  test or task ends with FAIL, after its teardown, at its definition. These are Robot
  Framework results, not Python exceptions: Python exception settings belong to the
  **Python:** child session. VS Code shows the session as *Robot failure: failed keyword*
  (or *… failed test (final outcome)*) and the editor's exception box shows Robot's
  message under VS Code's own *Exception has occurred.* heading. Robot has already recorded
  the failure, so these stops are read-only: values cannot change and Debug Console
  keywords are refused. Ticking or clearing a box while paused applies at once. While
  the test runs, it applies at the next keyword or test start or end, and the Debug
  Console says so (*… is pending*, then *Robot failure stops now (…)*).
- *Changing a Robot value.* While paused at an ordinary breakpoint or step, select the
  current Robot frame in **Call Stack**, then in **Variables** right-click a `${name}` row
  > **Set Value** (or select it and press F2). Type one JSON value: a quoted string such
  as `"after"` (also `""`, or `"${other}"`, which stays literal text), a number, `true`,
  `false` or `null`. Enter applies it; Escape cancels. The change is local to the scope
  that is running: in a test body it lasts until the test ends, and in a keyword until the
  keyword returns. It never changes the suite or global value. Text, numbers,
  true/false and None values can change. Lists, dictionaries, other objects, values set
  by Robot Framework or on the command line (`--variable`), outer frames, failure
  stops and pauses at a suite setup or teardown call are read-only. The last is shown as
  *Robot visible variables (read-only: suite setup or teardown)*, because there the
  running scope is the suite's own, so an edit would reach later tests. An invalid value is refused with *Cannot change this value…*,
  VS Code keeps the editor open, and the old value is unchanged. Values are limited to
  65536 bytes, finite numbers and whole numbers within ±9007199254740991. After
  **Continue** or a step, an earlier value editor fails with *Execution has continued.
  Pause again and select the variable to edit it.* Python values change only in the
  **Python:** child session, with debugpy's own rules.
runs in its own process group. A Stop from the debug toolbar or with Shift+F5 shows no
notification, whether the session is paused or still launching (before or after VS Code has
sent the launch request, also when VS Code sends the Stop before it has initialized the
backend); a backend that refuses the Stop is ended anyway, and the refusal goes to the
*Robot Companion Debug* output. A Python child session that would only start after the Stop
is not started. If the backend exits without a Stop while the session is launching, with
any exit code including a clean exit (0), or later with anything but a clean exit, a
warning names the exit and offers **Show Debug Log**, which opens the *Robot Companion
Debug* output; VS Code's own *Debug backend exited* dialog no longer appears in addition. A
clean exit after a successful launch, when the backend ends its own run, is not reported as
unexpected; the Debug Console names it. A session that ends before its launch succeeded is
released by Robot Companion too (VS Code reports no end for it).

**Test Explorer discovery per combination.** Both providers have a discovery service: the
native backend's `robot-companion-backend discovery` and RobotCode's `discover tests`.
An explicit `executionBackend.services.discovery` takes precedence, followed by an
optional `robotCompanion.discoveryBackend` descriptor. In this preview an unset
`executionBackend` defaults to native debug plus native discovery; a separate explicit
`discoveryBackend` overrides that default discovery side. An explicit debug-only execution
descriptor with no discovery override has no test controller; CodeLens and Run and Debug
remain available. The *Tests* status row names the provider and which setting its discovery
service comes from. Test Explorer **Run** starts the same Robot command as Run Test
(`robotCompanion.robotCommand` when set, else the folder's selected environment, else `robot`
on PATH); **Debug Test** uses the `executionBackend`'s debug service.

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

**Previously verified combinations** (published 1.3.5 baseline: Linux arm64, VS Code
1.141.0, Python 3.13.7, Robot Framework 7.5, debugpy 1.8.22, RobotCode 2.7.0, native
backend 0.1.0.dev4 built offline; the RobotCode, Python and debugpy VS Code extensions absent): each of the four
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
keyboard input; they are not a human usability session. The 1.3.6 readiness and diagnostics
changes receive focused checks recorded in its validation artifact; this baseline is not a
claim that the complete editor matrix was repeated on backend 0.1.0.dev5.

**Remaining qualification:** representative large projects, complete Windows editor
interaction and actual remote/WSL/container servers. Coverage, continuous runs,
directory/tag/profile Test Explorer selection and Markdown/TOML support are implemented;
their full authoring and platform interaction matrices remain open. The accepted Linux interaction checks cover the synthetic audit corpus;
consult this release's validation artifact for the exact integrated-source results.
RobotCode-only capabilities such as document highlights, implementation, folding/selection
ranges and inline values are not exposed by Companion. Reverse/data/function breakpoints
and interrupting a blocking library call with Pause remain unsupported.

#### Project Robot configuration (`robotCompanion.robotArguments`)

One folder setting configures Robot Framework for every owned service: the
`robotCompanion.robotArguments` that **Run Test**, **Run Suite**, Test Explorer **Run** and
the debugger already pass to Robot. With the native backend, the language service and
Test Explorer discovery receive the same arguments and the same run folder (the workspace
folder), so F12, hover, completion, diagnostics and discovered test names agree with the run:

```json
{
  "robotCompanion.robotArguments": ["--pythonpath", "lib", "--variablefile", "config/env.py",
    "--variable", "ENV:staging", "--argumentfile", "robot.args"]
}
```

The arguments are read with Robot Framework's own option parser. Relative paths are
relative to the workspace folder, as for a run. What language and discovery apply:

| Option | Applied as Robot applies it |
| --- | --- |
| `--pythonpath` / `-P` | Module-name imports (`Library    mylib`, `Library    pkg.module`, `Variables    myvars`) are searched in these directories in order, then in the workspace folder. A module next to the suite is **not** found unless one of these lists its folder, as in Robot. Relative `Resource`, library and variable file paths are tried next to the importing file first, then in the same directories. Installed packages (site-packages) are not searched: such a library shows *Library not resolved in this version* (information) and hides no other diagnostic. |
| `--variablefile` / `-V` | Python, JSON and YAML variable files (`file.py:arg` too). Their variables override the suite's own, like `--variable`, in the order given. |
| `--variable` / `-v` | `NAME:value` (and Robot 7.3's `NAME: int:42`) override every suite and imported variable. Hover says *Command-line variable*; F12 has no source location to open. |
| `--argumentfile` / `-A` | Read as Robot reads it, relative to the workspace folder. `STDIN` is refused for language and discovery. |
| `--extension` / `-F` | Test Explorer lists the suite files Robot runs for a directory with these extensions (`robot:robot.md`); without it, Robot's default (Robot Framework 7.5 includes `.robot.md`). |

Other options (`--include`, `--loglevel`, ...) do not change language results. The
**Robot Companion Language** output names the applied python path, variable files and
variables, and each problem (an unknown option, a variable file that is missing or cannot
be read completely); a problem never stops the language service. Changing the setting
restarts the folder's language and discovery services. Test names use the configured
variables, so `Check ${ENV}` with `--variable ENV:staging` is listed as *Check staging*,
which is also the name Robot reports for the run.

**Nothing is run to read the configuration.** The language and discovery services never
import a library, a `--pythonpath` module or a variable file: Python files are read from
their source, JSON and YAML as data (YAML only when PyYAML is installed in the backend
environment). A variable file whose variables are computed (`get_variables`, a class named
like the module, `from x import *`, import-time `globals()`/`setattr`) or that cannot be
read shows an information diagnostic on its `Variables` import; its variables are then
unknown, so no undefined-variable warning is shown for that file, while keyword checks
continue. Run and Debug execute them, as Robot does. `robotArguments` is a restricted
setting: in Restricted Mode a workspace's value is ignored and no backend process starts.

**Imports with variables.** `${CURDIR}` is the importing file's folder, as Robot replaces it
when parsing. Other variables in import names are resolved before the run from, in Robot's
order, `--variable`, `--variablefile`, the file's own `*** Variables ***` section (also a
value built from `${CURDIR}`), variables of resources and variable files imported earlier,
and the built-ins (`${EXECDIR}` is the workspace folder). An import whose name needs a value
known only when Robot runs (`%{ENV_VAR}`, a variable a keyword sets, inline Python) shows
*Import not resolved before the run* (information) instead of an error.

**Library names.** Robot keeps the first library imported under a name and ignores later
imports with that name (Robot 7.5 warns, 7.3.2 logs it at INFO level). The native backend
does the same: `Library    B.py    AS    A` after `Library    A.py    AS    A` gets a
diagnostic (warning on Robot 7.5, information on 7.3.2) and its keywords are not indexed.
One library imported under two names is two libraries, so an unqualified call of its
keyword is ambiguous (*Multiple keywords with name ...*) and `First.Keyword` /
`Second.Keyword` each resolve; F12 opens the one definition.

**Scoped variables.** A variable that a test or keyword sets with `VAR ... scope=TEST`,
`TASK`, `SUITE`, `SUITES` or `GLOBAL`, or with **Set Test/Task/Suite/Global Variable** and
a literal name, counts as defined everywhere for diagnostics. When nothing else defines a
use, F12 and hover go to the step in the suite or its resources that sets it (*Suite
variable set with VAR scope=SUITE in test First*). Rename refuses such variables, and
variables from the command line or a variable file, instead of changing only some uses.

**Branch-sensitive variable diagnostics.** A test's or keyword's own variable is defined
only after a step that may assign it. A use before its first assignment (also in the same
step, as in `${x}=    Set Variable    ${x}`, or in an inline `IF` that assigns it), or a use
whose only assignment is in another branch of the same `IF`/`ELSE IF`/`ELSE` block or in
another `EXCEPT`/`ELSE` branch of the same `TRY`, is a warning (*Variable '${x}' is not
defined here: it is first assigned on line 7.*, *... only assigned in another IF/TRY branch
(line 10).*). Inside a `FOR`/`WHILE` body that assigns it, a use is reached on a later
iteration and is not reported.

**Named unsupported cases.** These are known gaps; no diagnostic is better than a false
one:

- *Possibly undefined after a branch.* A use after an `IF` without `ELSE` (or after a loop
  that may run zero times, or after a `TRY` body that may fail) whose assignment may not
  have run is not reported, although Robot fails there on that path.
- *Installed packages and other `sys.path` entries.* Only `--pythonpath` and the workspace
  folder are searched; the plain `robot` launcher does not put the workspace folder on the
  module path (`python -m robot` and the native debugger do), so prefer
  `--pythonpath .` when you rely on it.
- *Dynamic variable sources.* `get_variables`, class-based variable files, YAML without
  PyYAML in the backend environment, `Import Variables`, `%{ENV}` and inline Python
  (`${{ }}`) values are unknown before the run.
- *Class and dynamic libraries* stay as before: their keywords are not indexed.
- *Breakpoint conditions and logpoint expressions* are Robot expressions (Python) evaluated
  in the paused worker. An expression that calls `sys.exit()` or `exit()` is reported in the
  Debug Console (*Breakpoint 3 condition error at x.robot:7: SystemExit: 3; not stopping*,
  or `<error: SystemExit: 4>` in a logpoint) and the run continues; as an `IF` condition in
  your test, the same call still stops the whole Robot run. Process-ending calls that are no
  exception (`os._exit()`) and expressions that never return are not guarded.
- The RobotCode providers read their own configuration (`robot.toml`); with RobotCode,
  `robotArguments` apply to Run and Debug only, and the output says so. RobotCode 2.7.0
  reads no Markdown Robot sources.

#### robot.toml settings

Robot Framework reads no TOML file; RobotCode's `robot.toml` format is the common place for
project settings. With the native backend, Robot Companion reads it from the workspace
folder, in RobotCode's order: `pyproject.toml` (its `[tool.robot]` table), `robot.toml`,
then `.robot.toml`. A later file's setting replaces an earlier one; an `extend-` setting
adds to it. These settings are applied:

| Setting | Robot option | Example |
| --- | --- | --- |
| `python-path`, `extend-python-path` | `--pythonpath` | `python-path = ["lib", "resources"]` |
| `variables`, `extend-variables` | `--variable` (string values) | `[variables]` / `ENV = "staging"` |
| `variable-files`, `extend-variable-files` | `--variablefile` | `variable-files = ["config/env.py"]` |
| `extensions` | `--extension` | `extensions = "robot:robot.md"` |
| `args`, `extend-args` | any Robot arguments as given | `args = ["--loglevel", "DEBUG"]` |

They become Robot arguments placed **before** `robotCompanion.robotArguments`, so
`robotArguments` wins where Robot keeps the last value (a `--variable` of the same name). The native
language service and Test Explorer discovery apply them as described for `robotArguments`
above; **Run Test**, **Run Suite**, Test Explorer **Run** and **Debug Test** pass them to
Robot. Relative paths are relative to the workspace folder. F12 on a robot.toml variable
opens its line in robot.toml, and hover names it (*Command-line variable · robot.toml
[variables], line 6*). The run transcript, the Debug Console and the **Robot Companion
Language** output name the files applied.

**Validation and help.** Open a robot.toml file: Problems shows, at their line, TOML syntax
errors, wrong value types (errors; the setting is not applied), RobotCode settings Robot
Companion does not apply (`output-dir`, `listeners`, `profiles`, `{ expr = ... }` values,
...; warnings) and unknown keys. Hovering a setting shows what it does and the Robot option
it becomes. The JSON schema `schemas/robot-toml.schema.json` is contributed through
`tomlValidation` for TOML extensions that read it (for example Even Better TOML); Robot
Companion itself needs no TOML extension.

Edits apply when the file is saved (the language service restarts; Test Explorer reads it
again). Nothing in robot.toml is run, and it is read only in a trusted workspace with the
native backend. Not applied: profiles and `default-profiles`, RobotCode expressions, the
user-level default configuration, and in coexistence mode or with only RobotCode providers
(Run Test then says *robot.toml settings ... not applied* and why).

#### Markdown Robot sources

Robot Framework 7.5 reads Robot data from Markdown: only fenced code blocks marked `robot` or
`robotframework` count, and each block is dedented. A `.robot.md` file is a suite (in
Robot's default `--extension`); a `.md` or `.markdown` file is a resource when a Robot file
imports it, and a suite with `--extension md`.

````markdown
# Login checks

```robot
*** Settings ***
Resource    keywords.md

*** Test Cases ***
Valid Login
    Open Login Page
```
````

With the native backend and Robot Framework 7.5, Markdown editors get the same definitions
(F12, Ctrl/Cmd+click), hover, completion, references, rename, symbols,
diagnostics and semantic highlighting in their Robot blocks, at the file's own lines and
columns, also for a block indented in a list item. Prose and other code blocks get none.
Test Explorer lists `.robot.md` suites at their test lines, Run and Debug Test run them, and
breakpoints set in the glyph margin of a `.robot.md` suite or a Markdown resource stop the
debugger at that line; stack frames use the Markdown lines (Robot numbers only the lines of
its blocks). A `.md` file other than a `.robot.md` suite is served only when a Robot file
imports it with `Resource`, found as Robot finds it: next to the importing file, then on the
python path (`--pythonpath`, robot.toml's `python-path`), with `${CURDIR}` and command-line
variables replaced. Another file with the same name is never served, so a root README with an
example block gets no diagnostics when `docs/README.md` is imported. Markdown files get no
quick fixes or formatting.

**Robot Framework 7.3.2 reads no Markdown.** With it, a `.robot.md` file shows one warning
(*Robot Framework 7.3.2 does not read Markdown files ...*), Test Explorer shows it as a
*not discovered* error item, `Resource    keywords.md` shows Robot's own error
(*Invalid resource file extension '.md'*), and a breakpoint in a Markdown file stays
unverified with the message *Robot Framework 7.3.2 does not read Markdown files, so this
line never runs*: Robot 7.3.2 ignores such a suite and fails such an import. Nothing is
treated as Robot Framework 7.5 would.

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
  `Catenate    SEPARATOR=-    ${SUITE_VALUE}    console`. You can also select a keyword
  call together with its `...` argument continuation lines in the editor and choose
  **Evaluate in Debug Console** from the context menu;
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
and tests appear in Test Explorer under **Robot Companion**, one suite per `.robot` file
with its tests and tasks below it, labelled as the backend names them. With the native
backend, each folder that holds suites is a directory suite row with Robot's suite name
(an `__init__.robot` `Name` setting, else the folder name as Robot writes it, for example
`api tests` as `Api Tests`), and its file suites and subfolders are below it; the RobotCode
bridge lists file suites only. Each test carries its Robot tags as Test Explorer tags:
the tags Robot Framework gives it from the folders' and the file's `Test Tags`,
`Default Tags`, its own `[Tags]` and `-tag` removals. Type `@robotCompanion:smoke` in the
Testing view's filter to see only tests tagged `smoke` (the filter suggests the tags).
Test IDs are built from the file URI and the test name (plus `#2`, `#3` … for a repeated
name in one file), so they stay stable across backends and restarts. A click on a test opens
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
[backend/README.md](https://github.com/StochasticEntropy/robot-companion/blob/v1.3.19-preview.1/backend/README.md#services).

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

- **Run** works on one test, a multi-selection (Ctrl/Cmd-click rows, also mixing tests,
  file suites and directory suites), a directory, a suite or everything, and runs exactly
  the selected tests. Robot Companion starts Robot with the folder's
  `robotCompanion.robotCommand` and `robotCompanion.robotArguments`, in the workspace
  folder, without a shell, on the **workspace folder itself**, so every `__init__.robot`
  on a selected test's path applies as in a command-line run of the folder: suite setups
  and teardowns, `Test Tags`, `Default Tags`. Robot parses only the selected files (one
  `--parseinclude` each, init files aside), and a small pre-run modifier that Robot
  Companion copies into the run's folder keeps only the selected tests, identified by
  their file and the line of their name. Test names are not used for selecting, so a name
  with variables (`Login On ${ENVIRONMENT}`), with glob characters, or repeated in a file
  selects exactly that test. Tests and tasks run in separate Robot runs (Robot refuses
  to mix them); otherwise a selection is one Robot run per workspace folder. The run's
  options are in an argument file in its folder (Robot's console output, with the
  command line, appears in Test Results).
- **Profiles**: each entry of the `robotCompanion.testProfiles` setting adds a Run
  profile with its name, a coverage profile named `<name> (Coverage)` and, when Debug
  Test is offered, a Debug profile named `<name> (Debug)`. Choose it with **Execute Using Profile...** in a row's context menu
  (or **Run Using Profile...** / **Debug Using Profile...** in the Testing view). A profile
  passes its `include` and `exclude` tag patterns to Robot as `--include` / `--exclude`
  and its `arguments` after `robotArguments`:

  ```json
  "robotCompanion.testProfiles": [
    { "name": "Smoke", "include": ["smoke"], "exclude": ["slow"] },
    { "name": "API nightly", "include": ["api AND nightly"], "arguments": ["--variable", "ENV:ci"] }
  ]
  ```

  Only the selected tests whose discovered tags the patterns select are started and shown
  running; the run output lists the others. Patterns follow Robot's rules (case, spaces
  and underscores ignored; `*`, `?`, `[...]`; `AND`, `OR`, `NOT`). Robot still decides:
  a test that Robot's own selection leaves out (for example because a tag uses a variable
  only set at run time) is shown **Skipped** with that reason in its output. Robot
  Framework 7.3.2 removes spaces before it looks for `AND`/`OR`/`NOT`, 7.5 does not, so
  a pattern such as `DEMO RUN` (an `OR` once the space is gone) is read the 7.5 way when
  deciding what to start; Robot's own reading decides the run. An entry
  without a name, with a repeated name or with a non-list `include`, `exclude` or
  `arguments` is not offered and is named in the **Robot Companion Tests** output.
  `robotCompanion.testProfiles` is a restricted setting, read only in a trusted workspace.
- Each test's result comes only from its own entry in that run's `output.xml`, matched
  by its file and name line: Passed, Failed with Robot's failure message, or Skipped. A
  failure message is anchored at the test's source line, so it shows in the editor next
  to the test, and clicking the test opens that line. Results from one run never reach
  another run's tests. If Robot does not report a test (for example, Robot could not
  start), the test is shown as errored with the reason; the exit code alone never marks a
  test Passed. A selected test is identified by its file, its name line and its name: if
  the file changed after discovery so that the test no longer starts at that line (also
  when another test now does), it is not run, and no other test runs or reports in its
  place; it is errored with that reason. Save the file or use **Refresh Tests** and run
  it again.
- **Results and logs**: each run writes Robot's `output.xml`, `log.html` and `report.html`
  to its own folder in the extension's workspace storage, with `robot-companion-run.json`
  (profile, Run or Debug, command, exit, and each test's status). In Test Results, each
  test's output names its status and its run's log at the test (`log.html#<Robot id>`).
  A test, file or directory row's context menu has **Open Robot Log** (at the test) and
  **Open Robot Report** for its latest results. The newest 40 run folders are kept, and
  never a folder that holds a listed test's latest results.
- **Rerun Failed Tests** (on a run in Test Results, or `Ctrl+;` then `E`) runs only the
  tests that failed in the last run and updates their state.
- **Stop** (*Cancel Test Run*) ends the running Robot process and every process it
  started. On Linux and macOS: its whole process group, and the processes it started
  outside the group (Robot's `Start Process` starts each process in a new session),
  first with SIGTERM, then with SIGKILL after two seconds. On Windows: `taskkill /T /F`
  ends Robot and its whole process tree at once (a console process cannot be asked to
  stop), so that run writes no `output.xml` and all its tests, finished ones included,
  are Skipped.
- During **Debug Test**, both the Testing **Stop** and the debug toolbar **Stop** end
  the debug session. If the debug backend does not end the session itself (for
  example while Robot waits in a long keyword), Robot Companion ends the debug
  adapter's process group (the RobotCode launcher, Robot and the processes Robot
  started) about two seconds after the debug toolbar Stop, or about five seconds
  after the Testing Stop. The Python debugger then exits with Robot.
- On Linux and macOS, tests that Robot had already finished keep their result from
  that run's `output.xml`; every other test of the stopped run or debug session, and of
  runs that had not started, is marked **Skipped** (on Windows, every test of a stopped
  Run, see above). Nothing is left running, and the next Run or
  Debug Test starts normally.
- **Debug Test** is offered when the same `executionBackend` also has a debug service.
  It starts the owned **Robot Companion** debug type on the workspace folder with the
  same selection as Run (one session per folder and mode), linked to the test run, so
  breakpoints, stepping and the Debug Console work as described
  [above](#experimental-owned-debug-type). When the session ends, each test's result
  comes from that debug run's own `output.xml`.

#### Test Explorer coverage

**Run Test with Coverage** (a row's action, **Run Tests with Coverage** in the Testing
view, or a `<name> (Coverage)` profile) runs the selection like **Run** and measures
which lines of the workspace folder's Python files ran. Coverage is Python line
coverage of your keyword libraries and the modules they import; there is no coverage
of `.robot` or `.resource` files and no branch coverage.

- **How it is measured.** Robot Companion copies a small Robot listener,
  `RobotCompanionCoverage.py`, into the run's folder and passes it with `--listener`.
  Robot creates listeners before it imports any test library, and the listener traces
  Python lines with the standard library only (`sys.settrace` and `threading.settrace`),
  so nothing has to be installed in your project's Python and `robotCompanion.robotCommand`
  stays as it is. A line counts as executable when Python compiles code for it and as
  run when Python reported it to the tracer while Robot ran; both come from the same
  compiled file, on Python 3.11 and 3.13 alike. A statement spread over several lines
  counts each line that holds code of it. The run's folder keeps the result as
  `coverage.json` and `robot-companion-run.json` records the totals.
- **What is shown.** Only measured files appear in the **Test Coverage** view and in the
  editor gutter (covered and missed lines): `.py` files below the workspace folder that
  the run imported, except anything in a `site-packages` or `dist-packages` folder (for
  example a virtual environment inside the workspace). Files the run never imported are
  not listed. **Filter Coverage to Test** shows the lines one test ran. A line counts
  for the test that was running when it ran, by the test's file and name line; lines
  run in suite setups and teardowns count for the run but for no test, and lines that a
  background thread ran during a test count for that test.
- **What is not measured, and says so.** Processes that Robot or a test starts (`Start
  Process`, `Run Process`, `multiprocessing`), threads that were already running when
  Robot started, and code that ran before the listener started (for example a module of
  your own `--prerunmodifier` that a library imports again) are not measured; such a
  file is named in the run output as *imported before Robot Companion's coverage
  started* instead of showing wrong lines. A file that changed during the run is named
  as *changed during the run* and not shown. If another Python tracer is active (Robot
  started under `coverage run` or `python -m trace`, or a debugger that attaches during
  the run), the run shows no coverage at all: its output and a warning notification
  name the reason, and the tests' results are reported as usual. A stopped run shows no
  coverage.
- **Limits.** Coverage runs are slower than **Run**, because every Python call is
  traced. There is no **Debug** with coverage. Test Explorer offers coverage only in a
  VS Code that has the test coverage API (1.88 or later); otherwise the **Robot
  Companion Tests** output says that Run with Coverage is not offered (not checked on
  such a version).

Checked against the synthetic coverage workspace (a keyword library with a helper
module, a thread, a separate process and a `site-packages` folder) on Robot Framework 7.5
with Python 3.13 and Robot Framework 7.3.2 with Python 3.11 by `npm run test:integration`,
with the exact executable, run and per-test lines of each file, and live in VS Code
1.141.0 at 1280x900 with actual input: the row action, the **Test Coverage** rows and
percentages, the gutter after a click on a file row, **Filter Coverage to Test**,
**Execute Using Profile...** → *Smoke (Coverage)*, and a run under `python -m trace` that
shows the notification and no coverage. Not run on Windows yet.

#### Test Explorer continuous run

Continuous run is off until you turn it on: **Turn on Continuous Run** on a row (or
**Start Continuous Run** in the Testing view) watches that item for **Run** or one of
your `robotCompanion.testProfiles` Run profiles (**Start Continous Run Using...**).

- A save of a `.robot`, `.resource` or `.py` file in a discovered workspace folder
  starts a run once no other save has come for `robotCompanion.continuousRunDelay`
  milliseconds (default 1000), so a burst of saves is one run. Saves come from the
  editor (also auto save); changes by other programs (for example `git checkout`) do
  not start a run.
- The run holds the watched tests that the saved files can affect, as discovered after
  the save: a saved test file affects its own tests, a saved `__init__.robot` the tests
  below its folder, and any other saved file (a resource, a library, a variable file)
  every watched test. If none is affected, nothing runs; the **Robot Companion Tests**
  output says so.
- A continuous run starts only once rediscovery after the save has finished and no
  other Test Explorer run is in progress, including another continuous run's and one
  you started yourself (also while that rediscovery was still running); it waits until
  they have ended. A run you start yourself does not wait for a continuous run. Saves
  during a run start exactly one more run after it.
- This waiting does not cover a folder whose discovery is being restarted, for example
  by **Refresh Tests**, adding or removing a workspace folder, or a change of the
  integration mode or a backend setting. Until the folder's discovery backend has
  started again, a save there may be ignored entirely, and a continuous run that starts
  in that time does not wait for the folder's discovery: it runs none of the folder's
  tests, or, with several workspace folders, possibly its tests as listed before the
  restart (when nothing runs, the **Robot Companion Tests** output says the save
  affects none of the continuous run's tests). Save again once the folder's tests are
  back.
- **Turn off Continuous Run** (or stopping it in the Testing view) stops a running
  continuous run like **Stop** (its unfinished tests show **Skipped**) and starts no
  further run; a continuous run still waiting for another run is turned off at once.
  Closing the window or disabling the extension ends continuous runs and their Robot
  processes the same way. When Robot Companion stops offering tests while a continuous
  run is on (for example after switching back to coexistence mode), it stops the running
  continuous run the same way and nothing runs any more, but VS Code may keep its
  *Tests are being watched for changes* badge until you turn continuous run off in the
  Testing view.

Checked live in VS Code 1.141.0 at 1280x900 with actual input (row actions, Quick Open,
typing and Ctrl+S in the editor): two saves 300 ms apart start one run after the delay;
saves during a three-second run start one run after it; a save during a manual
**Run Test** starts its run after that run ended; at most one Robot run is active
throughout; **Turn off Continuous Run** during a 60-second run ends the Robot process
group within a second and later saves start nothing; switching to coexistence mode or
disposing the Test Explorer integration (as deactivation does) during a continuous run
leaves no process. Debouncing, queueing (also behind a run started while rediscovery
after the save was still running) and stopping (also when Robot Companion stops offering
tests) are also checked by `npm run test:integration`.
Not run on Windows yet.

If workspace-wide discovery is unavailable, Test Explorer shows its error item. Owned
native editor Run/Debug actions request focused file discovery independently; if that
discovery is also unavailable, they report the cause and start no legacy substitute.
F12 uses the separate language service. Standalone Run Test CodeLenses in coexistence
mode and explicit Run and Debug launch configurations remain separate paths.

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

Directories, tags, profiles, Open Robot Log / Report, Debug Test on a directory and Stop
of a test that started a worker process were checked live with the native backend (Robot
Framework 7.5, VS Code 1.141.0, 1280x900) with actual pointer and keyboard input: directory
rows expand by click and by the Right arrow key; `@robotCompanion:regression` in the filter
leaves one test; a Ctrl-click selection of a directory, a file and a test runs exactly those
six tests with the folders' suite setups once each; **Execute Using Profile...** → *Smoke*
on a directory runs only its `smoke` tests that are not `duplicate`; Debug Test on a directory
reports Passed and Failed per test; Stop ends Robot and the worker a test started with
`Start Process`. Directory and tag selection, profiles, tasks next to tests, paths with
spaces and brackets, changed files and Stop are also checked against real Robot Framework
7.5 (Python 3.13) and 7.3.2 (Python 3.11) by `npm run test:integration`; the tag patterns
are compared with Robot Framework's own for both versions. Windows: the same synthetic
cases are written to run on Windows, and `taskkill` is exercised with a stand-in; they
have not run on Windows yet (see [Windows](WINDOWS-PREVIEW.md#limits-and-optional-fallback)).

Not supported yet: test-level parallel runs, coverage of `.robot` files, and live
per-test progress during a run (the selected tests turn from running to their
result when that Robot run ends). The RobotCode bridge shows no directory suites. Test
Explorer items have no description (VS Code's Testing view would read it to screen
readers instead of the test name), so tags show through the filter, not next to the name.

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
language routing and removal on this host. Two folders with different runtimes,
the cleanup after a killed extension host and the declared minimum VS Code 1.141.0 are checked
as described in [Several folders, remote hosts and supported VS Code](#several-folders-remote-hosts-and-supported-vs-code);
a real remote server is not.

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

Owned mode is not yet full RobotCode-extension parity. It exposes native navigation,
diagnostics, completion, hover, references, safe rename, symbols, code actions,
document/range/on-type formatting, semantic tokens with deltas, inlay hints,
Test Explorer runs/debugging, prepared attach/restart, live breakpoint controls,
Robot failure stops, scalar editing, REPL, notebooks, Python line coverage and opt-in continuous
runs. See the qualification gaps and coverage limits above.

Workspace trust transitions were checked with the RobotCode 2.7.0 language bridge in a
normal VS Code window with workspace trust enabled (not the test runner, which disables
trust), with actual clicks: in Restricted Mode no backend process starts; **Trust** in the
Workspace Trust editor starts it; **Don't Trust** restarts the extension host and the
owned process is gone, and none starts again. `npm run test:trust` repeats this check
(it needs a display, for example `xvfb-run -a npm run test:trust`, and the prepared
environment).

#### Robot notebooks and the Robot REPL

In owned mode with the native backend (the preview default), Robot Companion runs Robot
Framework keywords interactively, in a **Robot notebook** (`.robotnb` file) or in the
**Robot REPL**:

- **New Robot Notebook** opens an untitled notebook. Any `*.robotnb` file opens as a
  notebook, with the **Robot Companion** kernel already selected. The file saves the cells'
  text only, no outputs.
- **Open Robot REPL** opens an interactive window next to the editor. Type a command in its
  input box and press Enter to run it.

Each notebook and each REPL has its **own Robot session**. The first cell starts one, in the
folder of the notebook (for a new notebook or a REPL: the folder of the active editor, or the
folder you pick):

- **Selected environment.** The session runs the backend's `interactive` service with the
  folder's selected Robot environment, the interpreter its debug and discovery services use
  (see [one environment for every service](#one-environment-for-language-discovery-debug-and-runs)).
  The first cell's output names the interpreter, the Python and Robot Framework versions, and
  the working directory, which is the workspace folder.
- **Owned context.** The session is one Robot test that Robot Framework runs inside an owned
  worker process. Each cell runs as steps of that test: keyword calls with assignments, `VAR`,
  `IF`, `FOR`, `TRY` and the other control structures. Libraries and resources imported with
  `Import Library` or `Import Resource`, and variables set by a cell, stay available to later
  cells. A cell that has `*** Keywords ***`, `*** Variables ***` or `*** Settings ***` sections
  defines them for the session; defining a keyword again replaces the earlier session
  definition. Test cases cannot be defined. `${CURDIR}` in a cell means the workspace folder.
  A failing step fails only its cell, and the steps after it in that cell do not run.
- **Robot arguments.** From `robotCompanion.robotArguments`, the session applies `--variable`,
  `--variablefile`, `--pythonpath`, `--loglevel` and `--language`. It names the other options
  as ignored. No output, log or report file is written.
- **Output.** Each cell shows, in the order it was produced, the messages its keywords log
  (at INFO and above; warnings and errors are prefixed `[ WARN ]` / `[ ERROR ]` and written as
  standard error), what they write to the console, standard output or standard error, the
  returned value of a single keyword call, and the failure message. Consecutive text of one
  stream forms one output block, and a change between standard output and standard error starts
  the next block, so nothing is hidden. Output always belongs to the cell that produced it.
  Robot Framework logs assignments itself, for example `${count} = 42`.
- **Variables.** **Show Robot Session Variables** (notebook toolbar **⋯**, the Command Palette, or
  click the **Robot session** status item) lists the variables set in cells first, then the
  session's and Robot Framework's own. Selecting one copies its value.
- **Interrupt.** The cell's **Stop** button, the notebook's **Interrupt** or **Interrupt Robot
  Session** stops the running keyword. Robot's `TRY`/`EXCEPT`, `Run Keyword And Ignore Error`
  and retry keywords cannot catch it. The session and its variables are kept, and cells
  waiting to run are cancelled. A keyword blocked in native code (one long C call) does not
  notice an interrupt: 5 seconds later the session's worker is ended, the cell says so, and the
  next cell starts a new session.
- **Restart and stop.** **Restart Robot Session** replaces the worker with a new one with the
  same arguments: variables, imports and definitions are gone. **Stop Robot Session** ends the
  session; the next cell starts a new one. Closing the notebook or REPL (its last editor tab), changing the folder's
  Robot environment, its `robotArguments`, `integrationMode`, `executionBackend` or
  `nativeBackendExecutable`, and closing the window end the session.
  Each end stops every process the session started and removes its session directory.
- **Status.** The **Robot session** status item shows the active notebook's session: *not
  started*, *starting*, *idle*, *busy* or *ended*. Its tooltip names the environment. The
  **Robot Companion Sessions** output channel records starts, ends and output that belongs to
  no cell.

Sessions start the folder's interpreter and run workspace libraries, as `robot` does. They
need a trusted workspace and owned mode: in Restricted Mode, coexistence mode, outside a
workspace folder, or with an explicit `executionBackend` descriptor (such as RobotCode) that has
no `interactive` service, a cell starts nothing and says why. Sessions of different notebooks,
REPLs and folders share no variables.

A session is separate from debugging. A paused **Robot Companion** debug session's Debug
Console still runs one keyword call, without an assignment, on the paused test with that
test's variables. The call can span `...` continuation lines, including an indented
editor selection. Multiple calls and control-flow blocks are refused before execution;
the console neither sees nor changes any notebook or REPL session.

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
bounded to two seconds and 64 KiB output, with a twenty-second refresh deadline. A cancelled probe
still counts toward the two until its process has exited, at most two seconds. **Refresh** clears
short-lived availability caches (30 seconds for success, five for failures).

If the optional Microsoft Python extension exposes the public `environments` API with
`getActiveEnvironmentPath`, `resolveEnvironment`, and `onDidChangeActiveEnvironmentPath`, its
**Python extension (follow)** row shows the current interpreter path and follows that extension's
interpreter for the file, only after you explicitly select it. The saved choice remains a follow choice, rather than pinning the displayed executable.
Cold activation, Python readiness and environment lookup share one fifteen-second total budget; a
timeout names the phase that did not finish. Selecting the row again after Python is ready retries
the saved choice and restarts services that previously refused it. Installing the Python extension
alone never changes your default. Unsupported API versions, missing local executable URIs or unavailable interpreters remain unavailable; they
never fall back to PATH. The adapter has synthetic contract/lifecycle coverage; genuine installed
Python-extension integration has not been verified in the offline baseline. In a remote window
Robot Companion runs on the remote extension host (see
[Several folders, remote hosts and supported VS Code](#several-folders-remote-hosts-and-supported-vs-code)),
so an interpreter path is used on that machine as reported; no local-to-remote path translation
is involved. This has not been checked against a real remote server.

Selected Python runs as the **exact interpreter plus `-m robot`**. This binds Robot's module to
that interpreter and avoids a console script's potentially stale absolute shebang after an
environment move. It cannot repair every moved/broken venv. Explicit Robot executable choices
run that executable directly; configured commands keep their existing parsing. Neither route uses
a shell or changes project import semantics.

### One environment for language, discovery, debug and runs

In owned mode a folder's selected **Python interpreter** (a saved choice or the **Python
extension** row) also runs that folder's native services, so one interpreter controls everything:

| What | Runs as |
| --- | --- |
| Language service | `<python> -m robot_companion_backend lsp` |
| Test Explorer discovery | `<python> -m robot_companion_backend discovery` |
| Debugging (the Robot worker runs in the same interpreter) | `<python> -m robot_companion_backend dap` |
| Run Test, Run Suite, Test Explorer **Run** | `<python> -m robot …` |

The working directory is the workspace folder. Precedence, per service:

1. An explicit `robotCompanion.languageBackend`, `executionBackend` or `discoveryBackend`
   descriptor (for example the optional RobotCode fallback) is used as written.
2. `robotCompanion.nativeBackendExecutable` runs that backend executable.
3. The selected Python interpreter, as above.
4. With no interpreter selected (nothing saved, `robot` on PATH or a Robot executable), the
   project's `.venv` backend executable, as in the 1.3.0 preview. Its environment is checked
   against the bundled build like a selected interpreter: another build or version starts
   nothing and is offered **Update Backend** for that `.venv` interpreter.

Because the language service runs in that interpreter, a `Library    module_name` installed
there (in its site-packages, or elsewhere on its `sys.path`) gets hover with its documentation,
**Go to Definition**, completion and the unknown-keyword error for a misspelled call, read from its
source without importing it. Each folder sees only its own interpreter's libraries. A module
beside the importing file comes first; installed libraries cannot be renamed.

`robotCompanion.robotCommand` still overrides only runs: the language, discovery and debug
services keep the selected interpreter. An unavailable **Python extension** interpreter never
falls back to the `.venv` backend; its services stay stopped with the reason.

Before a native service starts, Robot Companion runs one short, owned check with the interpreter
(no shell, 15 seconds at most, never in Restricted Mode). It reads the Python and Robot Framework
versions and the installed `robot-companion-backend` version, without importing the backend or
Robot Framework, and computes a digest of the installed backend files: SHA-256 over the sorted
lines `path NUL sha256(file bytes) LF` of every file under `robot_companion_backend/` that pip
recorded (bytecode excluded). For a backend executable (`nativeBackendExecutable` or the `.venv`
fallback) the interpreter is taken from `robot-companion-backend doctor`. **Robot Companion: Show
Language Service Status** prints one *Environment* line per folder, and the *Language*, *Debug* and
*Tests* rows name it too, for example:

```text
[Projekt] Environment — selected python: /work/.venv/bin/python (Python 3.11.9, Robot Framework 7.3.2);
robot-companion-backend 0.1.0.dev18 (sha256 <build digest>, 32 files) at /work/.venv/lib/python3.11/site-packages/robot_companion_backend;
backend files sha256 12b9476c45fe…
```

The `{}` status rows show the Python version next to the capability count; the **Robot: …**
item's tooltip says which interpreter the native services use and retains the full availability
diagnostic when the status bar shows a short warning. The Debug Console prefixes its environment
line with **Robot Companion environment:** to distinguish it from program output. It and the
`Robot Companion Language`, `Debug` and `Tests` output channels repeat the line when a service
starts. If the selected interpreter cannot run the supported backend, nothing starts and one
notification per folder names the interpreter and its versions, with **Select Robot Environment**
and **Show Status**: the backend is not installed, another version or another build of the same
version is installed (its file digest differs from the build bundled with the extension), a module
in the folder shadows it, its files are incomplete, Robot Framework is missing, the Python/Robot
Framework combination is not a supported row, or the interpreter does not start. When the bundled
build fixes it, the notification offers **Install Backend** or **Update Backend** first (see
[backend setup and updates](#backend-setup-and-updates)). Language and debug in other folders are
not affected. With no interpreter selected and no `.venv` backend, the notification asks you to
select the project's Python interpreter.

Changing a folder's selection (or the Python extension's interpreter for a followed folder, or a
successful **Install robotframework**) restarts that folder's language and discovery services and
stops its running debug sessions; other folders keep their processes. Changing
`nativeBackendExecutable` or a descriptor restarts the services as before. **Restart Language
Service** and **Refresh Tests** repeat the check, for example after installing the backend.
In Restricted Mode no check, interpreter or backend starts; after **Trust** the saved choices apply.

### Backend setup and updates

The extension contains the backend build it supports (`bundled-backend/`: the
`robot-companion-backend` 0.1.0.dev18 wheel, the debugpy 1.8.22 wheel published on PyPI and a
manifest with their SHA-256 and the digest of the installed backend files). The backend is
installed into the folder's **selected project interpreter**, so it reads your project's Robot
Framework and installed libraries directly; there is no separate tooling environment to maintain.

1. Install the extension, open the project and a `.robot` file. If no interpreter is selected yet,
   a notification asks for it: choose **Select Robot Environment** and pick the project's Python.
2. If that interpreter has no backend, another version, another build of the same version or an
   incomplete copy, the notification offers **Install Backend** or **Update Backend**. **Robot
   Companion: Install or Update Backend** in the Command Palette does the same for the active
   folder.
3. A confirmation names the folder and interpreter, what is added or replaced (debugpy only when
   the environment has none), what stays unchanged (Python, Robot Framework, an existing debugpy,
   RobotCode and every other package) and the exact command. **Cancel** changes nothing.
4. After you confirm, Robot Companion runs
   `<python> -m pip install --no-index --no-deps --force-reinstall … <bundled wheels>` with
   `PIP_USER=0`, shows a cancellable progress notification and writes pip's output to the
   **Robot Companion Backend** output channel. Nothing is downloaded and no dependency is
   resolved, so no other package changes.
5. Robot Companion checks the environment again and compares the installed backend files with
   the bundled build. Only a match counts as installed: the folder's services then start.

Cancelling, a failing pip run (for example a read-only site-packages, an environment without pip
or one that refuses installs) or a mismatch after the run is reported with pip's last error and
the state the environment is now in, with **Retry** and **Show Output**. **Retry** asks for
confirmation again and installs the bundled build again, which also repairs a copy that pip left
incomplete. When a later Robot Companion version bundles another backend build, the installed one
no longer matches and **Update Backend** is offered the same way. When pip itself fails halfway
through replacing an older copy, it can leave an empty `robot_companion_backend-<old>.dist-info`
directory behind; Robot Companion ignores it and does not delete it (pip then prints a warning
that it skips that entry).

Robot Companion never installs, upgrades or removes Python, Robot Framework or RobotCode, and it
does not offer an install in an environment without Robot Framework or with an unsupported
Python/Robot Framework combination. RobotCode can stay installed in the same environment. An
existing debugpy of another version is left alone; Python debugging inside Robot runs then needs
debugpy 1.8.22. Without debugpy (or with debugpy files but no metadata, after an interrupted
install) the services still start, the status names the missing debugpy, and **Install Backend**
adds only the bundled debugpy. Installing the backend yourself (the [Windows setup guide](WINDOWS-PREVIEW.md))
remains possible for offline or managed machines; the same checks apply to that copy.

Checked in a normal VS Code window with real input (`npm run test:project-environment`): two
folders, one choosing a Python 3.11 / Robot Framework 7.3.2 interpreter through **Enter path…**, the
other first on the `.venv` fallback and then its `.venv` interpreter (Python 3.13 / Robot Framework
7.5); the language, discovery, debug, Run Test, Run Suite and Test Explorer processes, the
`robotCommand` and `nativeBackendExecutable` overrides, an interpreter without the backend, a Ctrl+Q
restart and Restricted Mode with **Trust**. Windows uses the same paths (`Scripts\python.exe`)
but has not been checked live; the Python extension source is covered only by its synthetic test
provider.

A selected Python without Robot Framework offers **Select Environment** and **Install
robotframework**. Installation has a separate confirmation naming the interpreter, folder and
`<python> -m pip install robotframework`; Cancel starts nothing. Confirmed installation uses that
exact interpreter without a shell, with cancellable progress and a 120-second bound. It is
exclusive with test runs and never starts from selection/detection alone: starting a run meanwhile
says that robotframework is being installed in that interpreter. A cancelled or timed-out
installation keeps runs blocked until pip has exited; it is force-stopped after 250 ms, and runs
are allowed again at the latest two seconds after the cancel or timeout. Success is reported
only after a fresh Robot availability check. Executable-only choices have no inferred pip target.

In **owned mode**, editor Run actions use native Testing and its exact source/name-line
selection, including repeated names. Test Results shows each selected test's status and
output, with log/report actions for that run; **Robot Companion Tests** records service
details. See [Test Explorer](#test-explorer-run-debug-rerun-and-stop).

**Coexistence / standalone command execution.** The remaining command-line and
notification description in this section applies to the standalone runner:

```text
<effective executable and leading arguments> [<robot.toml arguments...>] <robotArguments...> --outputdir <results folder> [--test <test name>] <suite file>
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
| `robotCompanion.robotArguments` | `[]` | Extra arguments passed before the selection, one per entry, for example `["--loglevel", "DEBUG"]`. Debugging uses them too, and the native language and discovery services apply their `--pythonpath`, `--variablefile`, `--variable`, `--extension` and `--argumentfile` (see [Project Robot configuration](#project-robot-configuration-robotcompanionrobotarguments)). In owned mode with the native backend, the folder's [robot.toml settings](#robottoml-settings) come first. |
| `robotCompanion.enableRunCodeLens` | `true` | Show the Run Suite / Run Test CodeLenses. |

**Standalone output and results (coexistence).** The output channel **Robot Companion Test Run** opens when a run
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

### Several folders, remote hosts and supported VS Code

**Several workspace folders.** Each folder has its own selected environment and its own
language, discovery and debug processes, started in that folder. Two folders can use different
supported runtimes side by side, for example Python 3.11 / Robot Framework 7.3.2 and Python 3.13 /
Robot Framework 7.5. The same `Library    shared_lib` then resolves to each folder's own installed
library (hover, F12 and completion use the folder's own language service), a keyword only one
environment provides is an error only in the other folder, and Test Explorer runs each folder's
tests in its own interpreter. With several folders, each suite in Test Explorer is labelled with
its folder's name, for example `Suite (Beta Projekt)`, so its accessible name has both names. A settings change in one folder (for
example `robotCompanion.nativeBackendExecutable` in its `.vscode/settings.json`) restarts only that
folder's services; the other folders keep their processes and their Problems entries. Debug
sessions of different folders can be paused at the same time; stopping one leaves the others
paused.

**Remote, WSL and container hosts.** Robot Companion is a workspace extension
(`extensionKind: ["workspace"]`). In a Remote-SSH, WSL or Dev Containers window it runs on the
remote extension host, so interpreters, `.venv` folders and backend executables are looked up and
started on that machine, never on the local one. Settings that name an executable
(`robotCommand`, `nativeBackendExecutable`, `languageBackend`, `executionBackend`,
`discoveryBackend`) are *machine-overridable*: a value in your local user settings does not
follow a remote window; set it in that host's Remote settings or in the folder's own settings.
They are restricted in an untrusted workspace, and nothing starts until the remote workspace is
trusted.

If the extension host ends without shutting down Robot Companion (a remote window disconnected
for longer than its reconnection grace, or a crashed or killed host), a small helper that Robot
Companion starts with the host's own runtime ends what was still running: Robot runs from Test
Explorer and CodeLens, debug sessions with their Robot workers, the language and discovery
services, and environment checks or installs (these are registered the same way, but the
host-kill check below does not start one). A normal window close stops them as before.

**What is checked, and the limits.**

| Host | Status |
| --- | --- |
| VS Code 1.141.0, Linux (arm64), local window | Checked with real input, in a local window only. `npm run test:multi-root`: two folders on Python 3.11 / RF 7.3.2 and Python 3.13 / RF 7.5, with imports (hover, F12), diagnostics, a scoped restart, Test Explorer suite names and runs, and two concurrent debug sessions; completion is not exercised. `npm run test:host-disconnect`: a killed extension host and a graceful exit leave no process of the language and discovery services, a paused debug session with its Robot worker, a Test Explorer run and a CodeLens run; environment checks and installs are not exercised there |
| Windows x64, Python 3.11 / RF 7.3.2 | Not yet qualified for these multi-folder and host checks; the Windows CI covers its own smoke tests only |
| macOS | Not checked |
| Remote-SSH, WSL, Dev Containers | Not checked: no real remote server is available offline, and every check above ran in a local window. A remote host runs the same code for the workspace extension kind, machine-overridable executable settings, trust and the cleanup after a killed extension host |
| VS Code for the Web, virtual workspaces (`vscode-vfs`, GitHub repositories) | Not supported: the native services and runs need folders on the extension host's file system |
| VS Code older than 1.141.0 | Not supported. 1.141.0 is the only version the checks run, so it is the declared minimum (`engines.vscode: ^1.141.0`) |

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
| Install or Update Backend | `robotCompanion.installBackend` |
| Run Test at Cursor | `robotCompanion.runTestAtCursor` |
| Run Suite | `robotCompanion.runSuite` |
| Search Keywords in Scope | `robotCompanion.searchKeywords` |
| Refresh Keywords | `robotCompanion.keywordView.refresh` |
| New Robot Notebook | `robotCompanion.newRobotNotebook` |
| Open Robot REPL | `robotCompanion.openRobotRepl` |
| Show Robot Session Variables | `robotCompanion.showSessionVariables` |
| Interrupt Robot Session | `robotCompanion.interruptSession` |
| Restart Robot Session | `robotCompanion.restartSession` |
| Stop Robot Session | `robotCompanion.stopSession` |
| Open Robot Log (Test Explorer item menu) | `robotCompanion.openTestLog` |
| Open Robot Report (Test Explorer item menu) | `robotCompanion.openTestReport` |

**Insert Keyword Call** and **Go to Keyword Definition** are in the Robot Keywords view's
row context menu.

## Settings

Robot Companion contributes 49 settings under the `robotCompanion.` prefix, covering feature
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
| `robotCompanion.testProfiles` | `[]` | Owned-mode Test Explorer run, coverage and debug profiles: a `name`, `include`/`exclude` tag patterns and Robot `arguments` ([details](#test-explorer-run-debug-rerun-and-stop)). |
| `robotCompanion.continuousRunDelay` | `1000` | Milliseconds without another save before a Test Explorer continuous run starts ([details](#test-explorer-continuous-run)). |

Narrowing `indexImportFolderPatterns` to the folders that actually contain your keyword
libraries (for example `["libs/**"]`) is the main lever if indexing feels slow in a large
repository.

## Notes and limitations

- Behavior is non-invasive by default, but explicit actions such as argument insertion and
  documentation export do edit or write files, and Run Test / Run Suite start the configured
  Robot Framework command.
- Return resolution runs in a worker thread with a memory cache, and optionally a per-workspace
  disk cache. `Invalidate All Caches` resets both. The separate native source/syntax cache
  checks current file contents on each request and is bounded to 512 files and 32 MiB of
  UTF-8 source per store; this is not a Python heap bound. It clears when the native language
  service restarts, so use **Robot Companion: Restart Language Service** to discard it.
  **Invalidate All Caches** does not evict that native cache. Workspace inventory scans
  and foreground requests remain synchronous; caching does not guarantee Citrix latency.
- Supported literal keyword factories on an explicitly imported class can provide a
  **Source Declaration**: original source navigation, documentation and declared parameters.
  This source reading remains separate from a verified runtime keyword catalog; decorators
  may add or alter parameters. Computed names, unsupported/rebound factories and inherited
  methods from unresolved external bases can still leave navigation or metadata unavailable.
  Source-only declarations do not authorize rename or missing-import edits, or runtime
  argument-count diagnostics.
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
discovery and also clicks **Refresh Tests** and checks discovery failures, plus coverage and continuous runs
(`ROBOT_COMPANION_UI_SUITE=coverage` runs only those cases).
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

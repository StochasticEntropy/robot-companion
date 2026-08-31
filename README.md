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

## Settings

Robot Companion contributes 39 settings under the `robotCompanion.` prefix, covering feature
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
  documentation export do edit or write files.
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

# Changelog

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

- Added stronger checked-in VS Code folding regressions for the anonymized large Robot fixtures, including the new adjustment scenario.
- Verified direct-editor and preview-triggered folding jumps in a real Extension Development Host instead of relying only on parser-level range tests.
- Made preview/native fold commands cursor-independent so folding no longer changes behavior based on the current caret position.

## 0.4.54

- Cleaned up folding regression scaffolding after the preview-folding iteration.
- Checked in anonymized large Robot fixtures so UI folding tests no longer depend on local-only files.
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

- Changed `robotCompanion.returnFieldNameStyle=camelcase` to render true lower camelCase aliases such as `statusCode`, `processInstanceId`, and `businessKey` instead of PascalCase-like names.
- Kept explicit aliases such as `businesspartnerId` unchanged, so already-camelCase property names continue to appear exactly as defined by the Python model.

## 0.4.23

- Fixed return-member/property deduping so explicit Python property aliases remain visible instead of collapsing into the same normalized name.
- Restored Partner-style aliases such as `businesspartnerId`, `arbeitnehmerNummer`, `sozialversicherungsNummer`, and `steuerId` in return hover, Return Explorer access lists, and `${var.}` member completions.

## 0.4.22

- Changed `robotCompanion.returnMaxFieldsPerType` to default to `0` (unlimited), so larger return types like `Partner` no longer hide later properties just because earlier fields filled the first-level access list.

## 0.4.21

- Added configurable `robotCompanion.returnIncludeProperties` (default `true`) so Python `@property` members can be shown or hidden in return hover, Return Explorer access lists, technical return details, argument-value return hints, and `${var.}` member completions.
- Indexed Python `@property` getters as return members and preserved their CamelCase-aware aliases, including already-camelCase property names such as `businessKey -> BusinessKey`.

## 0.4.20

- Fixed CamelCase return-member rendering for inherited fields, so CamelCase-capable wrapper responses also expose inherited members like `ProcessInstance` in the configured `camelcase` mode instead of mixing `snake_case` top-level segments with CamelCase nested members.

## 0.4.19

- Added configurable `robotCompanion.returnFieldNameStyle` with `camelcase` (default), `snake_case`, and `both`.
- Return hover, Return Explorer access paths, argument-value return hints, and `${var.}` member completions now render CamelCaseBase-style aliases only for return types that support CamelCase access.
- Member lookup still accepts both raw and CamelCase segment forms for CamelCase-capable return types, while the technical developer tree remains on raw source field names.

## 0.4.18

- Fixed Python structured-type indexing for multi-line `class` declarations, so response wrapper models are discovered even when their base classes are listed across several lines.
- This restores return-type resolution for cases such as `ResponseKrankenkasseWechselVerarbeiten` used by `BAVL KK-Wechsel-Verarbeiten Ausführen - RestAufruf`.

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
- Return type previews now use a bumped cache schema so stale cached `ProcessInstance`-style results are recomputed instead of being reused across related response types.

## 0.4.13

- Fixed fully qualified inherited return type resolution for structured types.
- Return previews, technical details, and member completions now follow aliased base classes precisely, so inherited fields remain available even when simple class names collide across modules.
- This fixes cases such as `BAVL Zahllauf-Durchführen Ausführen - CamundaTimedProcess`, where `BAVL.Libs.models.process_instance.ProcessInstance` inherits its visible fields from `Common.Libs.entities.camunda_process_instance.ProcessInstance`.

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
- Added support for member completion with closed-brace typing contexts (for example `${bp.}` with RobotCode auto-close).
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
- Added internal caching design notes:
  - new `README.CACHE.INTERNAL.md` documents cache layers, invalidation behavior, prewarm scope, and known gaps.

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
- Updated local `origin` remote recommendation in internal notes to the new repo naming.

## 0.2.0

- BREAKING: Renamed extension namespace from `robotDocPreview.*` to `robotCompanion.*` for commands, views/container IDs, and settings keys.
- Re-positioned UX to make **Robot Return Explorer** the primary sidebar workflow; **Documentation Preview** remains available in the same container as a secondary capability.
- Updated command palette labels for Robot Companion positioning (including `robotCompanion.toggle` -> focus Return Explorer).
- Introduced `src/*` module layout scaffolding and moved runtime entrypoint to `src/core/extension.js` with root `extension.js` delegating to it.
- Updated README and internal docs for the Robot Companion 0.2.0 naming and workflow model.

## 0.1.34

- Improved nested collection access hints: when a second-level (or deeper) path goes through a collection-typed field, the path now inserts index access on that segment (for example `${bp.adresse[0].ort}`).

## 0.1.33

- Collection-like return hints now show indexed access only (for example `${var[0].field}`), removing the duplicate non-indexed variant for those contexts.

## 0.1.32

- Added configurable generic subtype return resolution across return hover, side panel, and argument return hints:
  - `robotCompanion.returnSubtypeResolutionMode` (`always` | `never` | `include` | `exclude`, default `always`)
  - `robotCompanion.returnSubtypeIncludeContainers` (default `[]`)
  - `robotCompanion.returnSubtypeExcludeContainers` (default `[]`)
- Return annotation parsing now resolves nested generic subtypes (for example `list[T]`, `ListWrapper[T]`, `Optional[list[T]]`) based on the selected policy.
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
- Restored missing hover/side-panel resolution for affected named args such as `betriebsnummerKk` and `aktenzeichenKk` in `BAVL ZMV_CONNECT Meldung KK Datei Erzeugen - Mock Funktion`.

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

- Removed enum index hard cap of 4000 Python files to support larger repositories.
- Stopped excluding generated-folder Python files from enum indexing so generated enums remain discoverable.

## 0.1.7

- Fixed enum hover resolving to unrelated enums by removing global value-only fallback.
- Fixed keyword signature parsing for long parameter lists (up to 300 lines), restoring enum mapping for large Robot keywords.
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

# Robot Companion - Cache Design Notes

Last updated: 2026-10-24
Branch baseline: `main` / `v0.4.117`

This document describes the current cache behavior in `src/core/extension.js`:
- what is cached
- how invalidation works
- what is intentionally not cached yet

These are developer notes about the implementation; they are not part of the packaged VSIX.

## Owned language inlay presentation

`src/integration/language-workspace.js` also keeps a bounded in-memory viewport
snapshot for up to 32 open documents, with at most 10,000 hints per snapshot.
Documents over 2,097,152 UTF-16 code units are not retained.
This is separate from the legacy caches below. A current successful answer,
including an empty answer, replaces the snapshot. Its document version and
requested range must match before a fresh snapshot can answer another request.

During an ordinary literal body edit in a Robot test, task or keyword, hints
outside the changed logical statement survive. Editing a continuation also keeps
its unchanged earlier argument rows and header return annotation. The edited row
and later rows of that call are withheld; header edits and joins into the header invalidate the
whole affected call. Appending a newline keeps the original unchanged row. Positions after the edit move by the exact UTF-16 text edit.
The mapped hints can be returned immediately while one native request runs in
the background; another keystroke does not start another concurrent request.
The background response must still pass document-version and dependency checks.

This retention is deliberately conservative. Declaration, settings, variable-definition,
import and ambiguous edits discard the snapshot. Edits in another document,
watched dependency changes, backend refresh, configuration changes, close and
service replacement discard dependent snapshots and abort their background requests too. A late response from
before a dependency edit cannot restore them. Failed requests do not trigger
an immediate retry loop. The snapshot never supplies definition identity,
runtime arguments, diagnostics or executable commands.

Robot argument cells are tokenized as strings. The extension contributes
Robot-language defaults enabling quick suggestions for ordinary keyword tokens
and argument strings. When a separator request is still pending and typing
cancels it before a widget exists, the next letter can start a fresh completion
request even while inline ghost text is present. This avoids depending on an
already returned incomplete list for multiword names or argument prefixes. This is an editor language default,
not a write to user settings; an explicit Robot-language setting can override it.
Completion edit ranges, filter text and `isIncomplete` remain the backend's.

A still-live native completion request may finish after the cursor has appended
letters in the same keyword or argument-name cell. The client accepts that answer
only when the entire document differs by that one insertion, the active empty
selection ends there, the root/configuration and other open dependencies are
unchanged, and no watched source changed. Only plain name items without commands,
additional edits or snippets qualify; RF separators, variable/member syntax and
context changes are refused. Request-time ranges remain unchanged for VS Code's
own completion model to transform and filter. This is not a retained namespace
cache and it starts no retry command. Escape/cancellation, editor switch, close
and disposal still discard the pending result. The comparison is bounded to a
document of at most 4,194,304 UTF-16 code units and a 1,024-code-unit insertion.

## 1) Cache Layers

### A. Robot parse cache (`RobotDocumentationService`)
- Key: `document.uri.toString()`
- Value: parsed object for that exact `document.version`
- Reuse rule: if cached version equals current open document version, parse is reused.
- Reset:
  - `clear(uri)` for one file
  - `clearAll()` for all files
- Scope: open document text (not disk snapshot)

### B. Python/resource index cache (`RobotEnumHintService`)
- Key: workspace folder URI
- Value: promise of built index for workspace
- Includes:
  - enums
  - structured types
  - keyword args/annotations
  - keyword returns/return definitions
  - keyword docs from Python `@keyword(...)` docstrings
  - import alias maps and module info
- Generation tracking:
  - each workspace has a generation counter
  - generation is bumped on invalidation
  - runtime cache states compare their stored generation against current generation

### C. Runtime per-robot-file cache (`RobotRuntimeCacheService`)
- Key: robot document URI
- Value: state object with:
  - `parsedVersion`
  - `indexGeneration`
  - `settingsSignature`
  - fast lookup maps built from parsed Robot assignments
  - bucket maps
  - pending invalidation markers
  - prewarm signature

There is also a special pseudo-state under key `__html__` used for rendered HTML snippets in the side panel.

### D. Worker return-type cache (`RobotReturnComputeWorker` + `return-worker.js`)
- Scope: workspace-level
- Key: case-sensitive root type identity, subtype/type preferences, collection and semantic field/property policy. Presentation depth, technical depth/limits and field-name style share a family.
- Value:
  - simple access template (variable-agnostic)
  - technical structure lines
- The simple-access template now also stores per-field metadata used by member completion:
  - field annotation text
  - resolved nested type names
  - collection-like flag for `[0]` insertion hints
- Rebind: simple templates are rebound to the requested variable token (`${order}`, `${order2}`, etc.) at read time.
- Storage:
  - in-memory LRU in worker process
  - optional persisted cache file under extension global storage (`return-type-cache/*.json`)
- Fingerprint guard:
  - cache files are reused only when index snapshot fingerprint matches.
  - mismatch causes lazy rebuild; stale file content is ignored.

## 2) Runtime Buckets

Buckets are `Map<cacheKey, entry>` where entry stores:
- `value` (resolved value or in-flight promise)
- `metadata.referenceLine` (used for line-based invalidation)

Current buckets:
- `returnPreview`
  - used by return hover and Return Explorer
  - includes both simple view (`includeTechnical: false`) and full technical view (`includeTechnical: true`)
- `returnHint`
  - used for "Return Hint For Argument Value"
- `enumPreview`
  - used for enum hover + enum side panel details
- `typedVariableCompletion`
  - used for type-matched variable completion in named argument values
- `returnMemberCompletion`
  - used for `${var.}` / `${var.}` member completion in named argument values
  - cache-first path through worker type cache; stores candidate lists per owner/assignment/path prefix
- `variableValue`
  - currently defined but not populated by current code paths

HTML cache:
- separate `html` map under pseudo-state `__html__`
- keyed by `contextKind + detailsMarkdown`
- used only for markdown-to-html render reuse in Return Explorer webview

## 3) Invalidation Rules

### A. Explicit command
Command: `Robot Companion: Invalidate All Caches`
- clears parser cache (`parser.clearAll()`)
- clears index cache (`enumHintService.invalidateAll()`)
- clears worker in-memory type cache (`returnComputeWorker.invalidateAll()`)
- clears persisted worker type-cache files (`returnComputeWorker.clearPersistedCaches()`)
- clears runtime cache (`runtimeCacheService.invalidateAll()`)
- refreshes views and attempts immediate index warmup for active robot editor

### B. Configuration changes
On any `robotCompanion.*` setting change:
- runtime cache is fully invalidated
- if `indexImportFolderPatterns` or `indexExcludeFolderPatterns` changed:
  - index cache is fully invalidated
- if `enableReturnTypeDiskCache` or `returnTypeCacheMaxEntries` changed:
  - worker cache is invalidated

### C. Python file lifecycle
On Python save (`onDidSaveTextDocument` for `.py`):
- merges only that file's contribution into the index (`enumHintService.applyPythonDocumentSave`)
- evicts the worker's type-preview entries that depend on that file
  (`returnComputeWorker.invalidateTypePreviewByFileUris([document.uri])`)
- runtime cache fully invalidated (all robot runtime states)

On Python create/delete:
- merges or removes that file's contribution (`applyPythonFileCreate` / `applyPythonFileDelete`)
- full worker invalidation (`returnComputeWorker.invalidateAll`)
- full runtime invalidation

Note: the index rebuild is per-file since v0.4.9 — a save no longer rescans the
workspace. The worker's *in-memory* layer is dependency-tracked per file; the
*disk* layer is still guarded by one fingerprint over the whole index snapshot,
so any Python change invalidates the persisted file for that workspace. Create
and delete deliberately take the full-invalidation path: adding or removing a
module can change how types in other files resolve.

### D. Robot document edits (incremental)
On robot text change:
- `invalidateOnRobotDocumentChange(event)` sets pending invalidation markers in runtime state
- actual bucket invalidation is applied lazily on next `ensureState(...)`

Two invalidation modes:
- Structural change -> full bucket clear for that robot file state
- Non-structural single-line change -> line-threshold invalidation (`referenceLine >= changedLine`)

Structural change detection currently includes:
- inserted/deleted multi-line edit
- text containing section header pattern `*** ... ***`
- text containing setting-like pattern `[Something]`

### E. Robot editor close
On document close:
- remove that file's runtime state (`invalidateForUri`)
- remove pending prewarm queue entries for that URI

## 4) Lazy Revalidation on Access (`ensureState`)

`ensureState(document, parsed)` is the gatekeeper before runtime cache use:
- compares `indexGeneration`; if changed -> clear buckets
- compares `settingsSignature`; if changed -> clear buckets
- applies pending per-file invalidation markers from edit events
- refreshes lookup maps if parsed version changed

Settings signature currently includes:
- enum fallback and enum display limits
- return subtype mode/include/exclude
- return preview/hint/technical depth and field limits
- return member completion max depth

## 5) Prewarm Behavior

Entry point: `schedulePrewarmForOpenDocuments(...)`
- target docs:
  - `prewarmMode = allOpen`: all open robot docs
  - `prewarmMode = active`: active robot doc only
- prioritization:
  - preferred URI first, then active URI, then lexical order

What prewarm computes:
- For each assigned return variable in the parsed Robot file, the shared
  `returnPreview` entry: depth 1 without technical details in owned mode, the
  configured full entry in coexistence mode.
- Owned selection requests then expand their current first-level entry at the
  configured depth; deep expansion does not block the first-level presentation.

What prewarm does not compute:
- enum preview cache
- return-hint cache
- typed-variable completion bucket
- return-member completion bucket

Note:
- Even though completion buckets are not prefilled directly, prewarm populates worker type cache entries.
- `${var.}` member completion then reuses those worker entries and is typically warm after prewarm.

Owned language mode (`robotCompanion.integrationMode: "owned"`):
- Open-file prewarm resolves each assigned return variable through the native
  definition identity and fills the existing `returnPreview` bucket at depth 1,
  without technical expansion. It uses the same index and type worker as hover,
  members and the Explorer; it does not build another variable/type catalog.
- These retained entries are presentation snapshots only. A cache-only probe
  sends no native request. A still-current snapshot can display first-level
  members while an ordinary request rechecks native identity; it never bypasses
  that authoritative request. An edit, close, environment/index/settings change
  invalidates its corresponding identity or cache state.
- Native definition work is shared only while in flight, per document version,
  root and source position. Consumers cancel independently. The next interaction
  checks source identity again, including when a filesystem notification was missed.
- Return-hint and enum resolution still check native identity in their normal
  phase; neither selects a type by its unqualified name alone.

Prewarm replay guard:
- per file `lastPrewarmSignature = parsedVersion|indexGeneration|settingsSignature`
- identical signature skips repeated prewarm for that file

## 6) Interaction Priority (Responsiveness)

Interaction signals:
- hover provider marks activity
- completion provider marks activity
- Return Explorer sync paths mark activity (selection/editor/doc-change flows)

Behavior:
- prewarm pauses while interaction is "hot"
- prewarm resumes after idle window
- low-priority refresh jobs can be deferred via `runWhenInteractiveIdle(...)`

Current idle-deferral use:
- Return Explorer technical details refresh
- deferred non-cached return preview fill after showing lightweight "Loading return details..."

## 7) Cache-First Return Explorer Flow

When cursor is on a return variable:
1. Try cache-only `returnPreview` lookup (`cacheOnly: true`, simple mode).
2. If hit:
   - render immediately
   - schedule technical details load (idle-priority)
3. If miss:
   - render lightweight loading state immediately
   - schedule full simple return resolve on idle
   - once resolved, update panel and optionally schedule technical details load

Selected-target lookup is foreground work: it no longer waits for the interactive
idle timer, which could otherwise abandon it while typing continued. The first
request uses depth 1 without technical expansion; full configured depth and
technical details follow separately. Deep work waits briefly for idle, then runs
at the bounded deadline rather than silently disappearing.

The Explorer sets the selected target header before its first asynchronous lookup.
A different variable, argument, file, binding prefix, source epoch or environment
clears the previous target body and shows the new target's loading state. A
same-target, locally unchanged presentation stays visible with an updating notice;
source lookup failures are distinct from a successful empty result. While typing an indented blank or unfinished continuation, the Explorer uses
the unchanged call header for provisional documentation context. Literal `.` or
`..` keyword rows resolve their own current call during the authoritative refresh
or an explicit selection; they are not permanently treated as continuations.
Its source-prefix identity
keeps the same valid body visible pending a coalesced lookup. Selection events
caused by typing share the edit debounce; an explicit mouse selection starts its
own lookup immediately. A new keyword, variable, named argument, changed header
or dependency still changes or invalidates the target normally. Typing a genuinely new keyword clears the old body once. Further prefix
letters update only the plain-text header in that same pending document; no old
documentation is attributed to the new name. Nonce/revision checks and a single
latest queued header handle late readiness and out-of-order messages. The current
resolved result replaces the pending shell normally. Obsolete
selection/edit/close/disposal responses cannot paint the panel. Status-only updates
use a webview message rather than replacing its document. Same-target return and keyword-documentation content changes patch keyed sections in the existing document. Fresh current-document command payloads replace their generated section while unchanged documentation nodes remain; a changed actual source or header still starts a new document. First-level nodes remain; Deeper access and Technical details have stable disclosure headers already in the shallow view. Expansion, matching focus, horizontal preformatted scrolling and the visible semantic anchor survive filling. Target/source/type changes start a new document. A document nonce prevents late readiness/content from an older view consuming the new queue. An unchanged render performs no HTML write.

Open Python edits update the existing incremental index after debounce, retaining
all changed files when several dependencies change together. Closing an unsaved
Python document restores its on-disk contribution before the active preview refreshes.
Neither operation imports or executes workspace libraries.

## 8) Known Gaps / Current Limits

- `variableValue` runtime bucket exists but variable hover currently resolves directly (no bucket population path).
- HTML cache is global (`__html__` pseudo-state) and only fully cleared on runtime `invalidateAll`.
- Worker disk-cache invalidation for Python changes is workspace-conservative (one fingerprint over the index snapshot). The in-memory layer *is* per-file dependency tracked, and it is the layer exercised on every save.
- Return member completion also has a front-layer in-memory memo (`_memberCompletionMemo`) keyed by document version + context;
  - it is intentionally ephemeral and reset on extension host lifecycle/invalidation flows.

## 9) Quick Debug Checklist

If cache behavior looks wrong:
1. Run command palette: `Robot Companion: Invalidate All Caches`
2. Verify active file language/id is Robot (`.robot`/`.resource`)
3. Note that a Robot debug session no longer pauses passive features: hover, completions, folding ranges, both views and keyword-argument `Insert` stay live. Only editor-manipulating actions (fold/unfold) and background prewarm are suspended (v0.4.68, v0.4.107).
4. Check whether the issue is in:
   - index layer (Python changes not reflected)
   - runtime layer (line-based invalidation boundary)
   - side panel HTML render cache (stale markdown->html view)

## 10) Potential Next Improvements

- Move variable hover to a real `variableValue` runtime bucket path.
- Add a small telemetry/debug command to print cache hit/miss counters per bucket.
- Add explicit HTML cache invalidation by document/context group (not only full clear).

## Robot execution environment availability

The run feature owns a separate in-memory availability cache (`src/features/run/environment-process.js`).
Its key includes executable, argument prefix, kind and working directory; successful checks live for
30 seconds and negative checks for five. It stores no permanent version truth in workspace state.
Selection, command configuration, Python provider changes, trust generation, installation and disposal
invalidate pending work/cache; the picker's Refresh does too. At most two shell-free probe children
run at once, each bounded to two seconds and 64 KiB combined output, with at most eight candidates
and an eight-second picker refresh deadline. Cancellation settles queued checks immediately and
terminates only owned children; a stopped child (cancel, timeout or output cap) gets SIGKILL after
250 ms and keeps its probe slot, or the installation's exclusivity with runs, until it has exited,
at most two seconds after the stop. Editor status uses a separate generation and 100 ms active-editor debounce.
Committed source choices are a versioned workspaceState map keyed by workspace-folder URI, separate
from documentation/index caches. Python-follow stores intent rather than a stale executable path.

## Progressive worker families and snapshot lifetime

The bounded workspace/type-preview LRU uses schema 7. A family shares independent
simple-depth projections and technical coverage. `technicalReady: false` means
technical data has not been built, not an authoritative empty result. Each reply
includes only the positive source contributors for its requested simple depth and,
when requested, technical coverage. The family keeps their union for invalidation;
a large deep result cannot exhaust the source-read budget of a later shallow one.
Hydration merges components without replacing deeper live simple data or completed
technical data with weaker disk coverage. Previous schema keys are not adopted.

An immutable member-fact WeakMap is keyed by the exact hydrated type object and
property policy. Repeated branches/depths reuse copied field facts; a replacement
snapshot provides new keys. It stores no final namespace, native binding or separate
source/type catalog. Python class spelling is case-sensitive in the family key.

Concurrent uploads coalesce only for the same workspace, exact index object,
generation and worker instance. Invalidation, replacement and disposal retire the
load identity. Every asynchronous snapshot/disk-hydration completion checks that
identity before mutating loaded flags or retained disk data. A late old completion
cannot resurrect a cleared worker or overwrite a fresh load. Snapshot fingerprint
changes clear worker entries; identical snapshots may retain valid type families.

A completed visual snapshot is independent of a previous consumer's cancelled
request. It can be shown provisionally while fresh native source/binding checks run;
it is not authoritative metadata or permission to execute a cached command. A
locally changed document, root, environment or index generation rejects it. Fresh
changed binding/type/first-level fields replace the incompatible display immediately.
A running synchronous deep worker operation remains nonpreemptive; this change
reduces repeated work and does not promise a fixed Citrix latency.

## Exact selected-source validation

The existing Python index contributions retain their source SHA-256. Owned
metadata requests read only the selected native definition file and the existing
type worker's positive dependency vector, including selected roots/bases and
referenced indexed annotation types. Enum candidates and canonical typed-variable
contributors use the same check. Open unsaved text takes precedence; closed files
are read exactly, even when size and modification time were restored. A changed
contribution refreshes the existing index and the native binding is checked again
before the result is used. This does not create another metadata catalog.

Validation is bounded to 64 known indexed source files, 32 MiB in total and 8 MiB
per file. Read failures, oversized sources and repeated changes are unavailable,
not a successful empty result or permission to reuse unchecked metadata. Positive
dependency vectors do not prove absence of new modules; the fresh native binding
remains responsible for import resolution. The owned member memo cannot bypass
this check. Retained typed-variable candidates are revalidated against the native
call/candidate definitions and canonical source-qualified types; uncertain or
excess candidates (more than 32) are withheld instead of guessed by bare name.

First-level prewarm also fills the existing HTML cache. Rendering shares in-flight
work in that same bucket. A different target's header/loading body is painted
synchronously before Markdown rendering or native requests; a ready prewarmed
body can then replace it without waiting for an unrelated enum lookup.


Typing stability is covered by `tests/integration/inlay-stability.test.js` and
`return-explorer-stability.test.js`, including pending requests, changed bindings,
late dependency answers and pending-header lifecycle. The isolated actual-editor
`typing-stability` UI suite types newlines, partial continuations, backspaces,
rapid arguments and new multiword prefixes. Its frame sampling checks same-call
and unrelated hints, truthful target changes and stable pending documents; it
uses static synthetic library sources and does not execute workspace code.

# Robot Companion - Internal Cache Notes

Last updated: 2026-04-02  
Branch baseline: `caching` / `v0.4.5`

This document describes the current cache behavior in `src/core/extension.js`:
- what is cached
- how invalidation works
- what is intentionally not cached yet

It is an internal development note and is not part of the packaged VSIX.

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
- Key: normalized return type signature (root types + subtype policy + depth/field settings + type preferences)
- Value:
  - simple access template (variable-agnostic)
  - technical structure lines
- Rebind: simple templates are rebound to the requested variable token (`${bp}`, `${bp2}`, etc.) at read time.
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

### C. Python file lifecycle
On Python save (`onDidSaveTextDocument` for `.py`):
- invalidates index for that workspace (`invalidateForUri`)
- runtime cache fully invalidated (all robot runtime states)

On Python create/delete:
- full index invalidation
- full runtime invalidation

Note: index rebuild is currently workspace-level (no partial merge of only changed Python file data).

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

## 5) Prewarm Behavior

Entry point: `schedulePrewarmForOpenDocuments(...)`
- target docs:
  - `prewarmMode = allOpen`: all open robot docs
  - `prewarmMode = active`: active robot doc only
- prioritization:
  - preferred URI first, then active URI, then lexical order

What prewarm currently computes:
- `returnPreview` simple entries only (`includeTechnical: false`)
- for each keyword assignment return variable in parsed robot file

What prewarm does not compute:
- technical developer return tree (`includeTechnical: true`)
- enum preview cache
- return-hint cache

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

This keeps panel interaction responsive and avoids immediate heavy computation in hot typing/hover periods.

## 8) Known Gaps / Current Limits

- `variableValue` runtime bucket exists but variable hover currently resolves directly (no bucket population path).
- Python index invalidation is still workspace-granular in effect after file events (no per-file incremental index merge yet).
- HTML cache is global (`__html__` pseudo-state) and only fully cleared on runtime `invalidateAll`.
- Worker cache invalidation for Python changes is workspace-conservative (fingerprint / generation), not per-type dependency tracked.
- Prewarm still targets simple return previews; technical details are now cached by type in worker once computed.

## 9) Quick Debug Checklist

If cache behavior looks wrong:
1. Run command palette: `Robot Companion: Invalidate All Caches`
2. Verify active file language/id is Robot (`.robot`/`.resource`)
3. Confirm no Robot debug session is active (extension pauses during Robot debug)
4. Check whether the issue is in:
   - index layer (Python changes not reflected)
   - runtime layer (line-based invalidation boundary)
   - side panel HTML render cache (stale markdown->html view)

## 10) Potential Next Improvements

- Move variable hover to a real `variableValue` runtime bucket path.
- Add incremental per-file Python index update instead of full workspace rebuild on Python save.
- Add a small telemetry/debug command to print cache hit/miss counters per bucket.
- Add explicit HTML cache invalidation by document/context group (not only full clear).

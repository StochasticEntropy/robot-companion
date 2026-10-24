# Native language source and syntax cache

The language workspace shares one bounded source/syntax store across definition,
hover, completion, signature help, semantic tokens and other LSP requests. It
retains Robot models, Python ASTs and selector readings, Markdown views and source
lines, plus bounded facts derived only from the exact source text. Consumers treat
retained syntax as read-only. Standard Robot Framework argument/type metadata is
cloned through its public constructors/copy API, with independent mutable maps,
defaults and nested types; unsupported shapes retain the general deepcopy
fallback. A request must never mutate cached prototypes. Import namespace graphs and
final resolutions are rebuilt using current configuration and import order.

Definition requests build the same import/name graph with `arguments=False`: they
need source locations, not argument specifications. The source-fact key includes
this mode, so a location-only template cannot replace a full-metadata template.
Hover, signature help, diagnostics and documentation continue to use the default
full graph and receive their own argument data.

An LSP dispatch, or a direct Workspace graph/definition/model/library operation,
opens a reentrant request snapshot. A retained file is read once during that
snapshot. The next request reads closed files again and compares exact content
before reusing parsed syntax. Thus changes missed by file watchers, including
same-size edits with restored timestamps, remain visible. Open/change/close
replace a file's snapshot source immediately. Disk read failures discard prior
retained syntax; a later recreated file is checked normally.

The persistent store and request snapshot each have a 512-file and 32-MiB UTF-8
source bound. This is a source-size bound, not a measured Python heap bound.
Oversized files remain supported without retention. Entries used by the current
request are pinned in the retained store: new entries replace unvisited entries,
or bypass retention when every resident entry is already in use. Pins clear at
the outer request boundary, allowing another graph to replace the working set.
The separate bounded request snapshot may evict files, so revisited files can
still be read again in a large request. Each file retains at most 32 Python
selector readings and 128 source-only syntax facts. Dependency, configuration
and path-resolution proofs use a separate bounded request memo that clears at
the request boundary. There is no disk-persisted native cache, retained import
namespace or cached final name resolution.

Canonical paths use a separate request-only memo of at most 512 entries. Missing
module file/folder candidates avoid canonicalization unless actual filesystem,
link/reparse or possible overlay evidence warrants the canonical check. Overlay
names are hints only; exact canonical existence and import precedence still
govern resolution. Outer request completion and overlay mutation clear this
memo. Lexical decorator-reference plans belong to exact source syntax; their
dependency locations, including missing results, remain request-only.

Return Explorer's existing JavaScript documentation and return-type caches keep
their own display/type data. The existing native definition identity (exact URI
and source line) continues to join that metadata to the authoritative native
resolution. Display names or regex-derived keyword catalogs are never used as a
replacement for Robot import resolution.

`backend/tests/test_lsp_source_cache.py` covers parse/read reuse, complex imported
resource fanout, cross-feature non-mutation, external edits, overlay close,
configuration changes, Python source-only inspection, failure/recreation and
cache bounds. `test_navigation_backend_latency.py` and
`test_source_declaration_latency.py` cover source-fact reuse and bounded working
set retention without hiding edits or configuration changes.
`test_python_argument_clones.py` covers independent RF metadata and unsupported
shape fallbacks; `test_location_only_definition.py` covers location/full-graph
parity and avoidance of argument work in definition requests. Existing live
language tests cover resource imports, ambiguity, Markdown, variable scopes and
protocol lifecycle. Foreground requests remain serial, with the existing
cooperative cancellation checkpoints. A single parse or operating-system read
is not preempted, and this store does not cache the workspace file inventory.

The editor **Invalidate All Caches** command resets JavaScript documentation, enum and
return caches; it does not evict this native store. **Restart Language Service** disposes
the native process and creates a fresh store. Exact-content checks make a manual reset
unnecessary for ordinary file edits.

Direct definition calls may pass conservative target names to declaration reading.
The exact-source literal catalog only selects possible methods; every selected
method still needs its current decorator/factory/helper proof. All embedded-name
methods remain eligible. Variable/indirect or unusually large/dotted call cells
retain unfiltered reading; full rich graphs remain unfiltered. The catalog never
persists final definition or dependency proof.

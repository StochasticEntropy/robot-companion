# Native language source and syntax cache

The language workspace shares one bounded source/syntax store across definition,
hover, completion, signature help, semantic tokens and other LSP requests. It
retains Robot models, Python ASTs and selector readings, Markdown views and source
lines. Consumers treat retained syntax as read-only. Import namespace graphs and
final resolutions are rebuilt using current configuration and import order.

An LSP dispatch, or a direct Workspace graph/definition/model/library operation,
opens a reentrant request snapshot. A retained file is read once during that
snapshot. The next request reads closed files again and compares exact content
before reusing parsed syntax. Thus changes missed by file watchers, including
same-size edits with restored timestamps, remain visible. Open/change/close
replace a file's snapshot source immediately. Disk read failures discard prior
retained syntax; a later recreated file is checked normally.

The persistent store and request snapshot each have a 512-file and 32-MiB UTF-8
source bound. This is a source-size bound, not a measured Python heap bound.
Oversized files remain supported without retention. Evicted files may be read
again within a large request. Each file retains at most 32 Python selector
readings. There is no disk-persisted native cache or cached final name resolution.

Return Explorer's existing JavaScript documentation and return-type caches keep
their own display/type data. The existing native definition identity (exact URI
and source line) continues to join that metadata to the authoritative native
resolution. Display names or regex-derived keyword catalogs are never used as a
replacement for Robot import resolution.

`backend/tests/test_lsp_source_cache.py` covers parse/read reuse, complex imported
resource fanout, cross-feature non-mutation, external edits, overlay close,
configuration changes, Python source-only inspection, failure/recreation and
cache bounds. Existing live language tests cover resource imports, ambiguity,
Markdown, variable scopes and protocol lifecycle. Foreground requests remain
synchronous: this cache does not add cancellation or preemption of a workspace
symbol scan, nor cache the workspace file inventory.

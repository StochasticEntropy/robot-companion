# Selected-environment installed libraries (owner-extended repair round)

This continues the original outcome after the Lead's changes request at
`5076646367d0202ba3886a29fc0d0521cbc36a43` (review-verdict revision 13730ddd) and the
owner's one extra bounded repair round of 21 October 2026. It is not acceptance.

## Finding repaired

The native language service reported every module library that was not beside the
importing file as "Library not resolved in this version". That diagnostic kept unknown
keywords open, so a library installed in the folder's selected interpreter had no hover,
definition or completion and a misspelled call was not an error. The previous host check
(zero squiggles in `suite.robot`) could not fail under that suppression.

## Accepted library work consumed

The accepted library line is merged in this worktree only, instead of a parallel rewrite:
MIS-616 `f7756eb` (with MIS-604 `e73fec8` and MIS-482 `2264dff`), MIS-600 `f6bd99c` and
MIS-631 `e39a06f` (with MIS-491 `899886b`). `release/1.3.2-preview` is not available in
this container, so the merges were made here. Conflicts were limited to the changelogs,
package scripts, the UI suite list and test harness files, plus `src/core/extension.js` and
`language-workspace.js`, where both sides were kept (`ProjectEnvironments` and the
`KeywordExplorer`; the environment refusal and the change event).

## Change

`Workspace.graph` keeps MIS-600's lookup in the importing file's directory. Only when that
directory has no package or module of the name's first part does `installed_library` repeat
the same `python_library` lookup on `search_path()`: the backend process's own `sys.path`
directories without the working directory, which is the selected interpreter's
site-packages. The first location with a package or module wins, else namespace portions in
order. Files are read with the existing static readers and never imported. Rename refuses a
keyword whose file lies on that search path. Each folder's language service is its own
process in its own interpreter, so isolation follows from the process.

## Checks added

- `backend/tests/test_lsp_libraries_live.py::InstalledLibraryTests`: a package on the
  service's `sys.path` (a PYTHONPATH entry inside the folder, as a project `.venv` is) gives
  definition, hover with documentation, completion, a submodule import and exactly one
  unknown-keyword error for the misspelling; RF's own run agrees. A module beside the suite
  wins over the installed one, rename is refused, and a service started without that path
  reports the import as unresolved.
- `tests/ui/project-environment-host.js`: the zero-squiggle check is replaced. In each row
  (A: Python 3.11 / RF 7.3.2 selected through Enter path…, B: its `.venv` Python 3.13 /
  RF 7.5) real pointer hover shows the installed keyword's documentation and the
  misspelling's unknown-keyword message, the misspelling is the file's only error, Ctrl+Space
  after `Acme Pro` offers `Acme Project Keyword`, and a click plus F12 opens
  `acme_project_lib/__init__.py` in that interpreter's site-packages. `alpha_only_lib` is
  installed only in A's environment: A's hover shows its documentation; B's import is
  unresolved (information), its hover shows nothing and F12 stays in place.

Exact-SHA commands, exit codes, counts and evidence paths are recorded in the issue's
`artifact-handoff` document. Windows remains unverified here.

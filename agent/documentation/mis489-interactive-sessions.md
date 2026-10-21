# MIS-489: Robot notebooks and the Robot REPL

Base: accepted MIS-476 `0aa14cf12642ed69a8ddfba51d32f380d01c4db6` (a descendant of the
preview baseline `3411d65`). This was merged only in this worktree.

## Design

- **Backend `interactive` service** (`backend/src/robot_companion_backend/interactive.py`).
  It uses DAP framing, protocol `robotCompanion/interactive` v1, and owns one Robot worker
  at a time (`interactive_worker.py`) in a `ProcessTree`, reached over the existing
  authenticated control channel (`control.py`). The worker runs one generated Robot test
  whose single step, `Run Robot Companion Session` (`interactive_session.py`), serves cells
  on RF's execution thread. Cells therefore run as RF body steps in a live context
  (`item.run(parent_result, context)`, the same call as `Keyword.run` in RF 7.3.2 and 7.5).
  Variables, imports and definitions persist across cells.
- **Definition cells** are written to a session-owned resource file and imported. A keyword
  defined again is removed from the earlier session resources.
- **Interrupt** uses `PyThreadState_SetAsyncExc` with `Interrupted` (an `ExecutionFailed`
  with `exit`/`syntax` set, so TRY/EXCEPT, Run Keyword And Ignore Error and retry keywords
  do not catch it). A cell still running after `INTERRUPT_GRACE` (5 s) ends its worker,
  and the answer carries `sessionEnded`.
- **Output attribution:** `sys.stdout`/`sys.stderr`/`sys.__stdout__`/`sys.__stderr__` are
  replaced by streams tagged with the running cell id. A listener forwards `log_message`.
  Startup RF errors (syslog `message`) go into `warnings` of the start answer.
- **Robot arguments:** `--variable`, `--variablefile`, `--pythonpath`, `--loglevel` and
  `--language` apply; the others are reported as `ignored`. No output files are written.
- **Extension** (`src/integration/interactive-workspace.js`): the `.robotnb` serializer,
  a notebook controller and an Interactive Window controller (REPL). There is one
  `RobotSession` per notebook/REPL document, which owns one `interactive` service process
  started from the folder's execution descriptor (`ProjectEnvironments.backend(...,
  "executionBackend")`, the selected interpreter). Trust and owned mode are checked
  before each start. Sessions end on close, on a change of environment or relevant
  settings, and on deactivation.
- **Paused Debug Console:** `dap.py`/`listener.py` are unchanged. The UI suite checks that a
  paused session's console keeps its own variables and its one-call, no-assignment rule
  next to a running notebook session.

## Checks (Linux, this container)

- `backend/tests/test_interactive_live.py`: 10 tests per row, Python 3.11 / RF 7.3.2 and
  3.13 / RF 7.5 (required in `verify_release.py`).
- `ROBOT_COMPANION_UI_SUITE=interactive npm run test:ui`: 6 tests in actual VS Code 1.141.0
  with CDP pointer/keyboard input (Run All, typed cells, the cell Stop button, the toolbar
  More Actions menu, the REPL input, the status item, the Debug Console).
- `npm run test:trust` (native): a notebook Run All in Restricted Mode starts nothing.
  After Trust, it starts the session service and worker. Don't Trust ends them with the
  extension host.

## Limits

- Windows x64 has not been run. The worker uses the existing Windows job-object process
  tree and `PyThreadState_SetAsyncExc`, which RF uses on Windows, but neither is verified
  live there.
- The REPL toolbar contributions (`interactive/toolbar`) are declared but were not checked
  by a UI test. The commands are also available from the Command Palette and the status
  item.
- An explicit non-native `executionBackend` (RobotCode) has no `interactive` service:
  sessions refuse to start and say why.

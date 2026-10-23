# Robot Companion backend 0.1.0.dev3

Independent Python language, discovery, debugging and interactive services for Robot Framework.
This backend accompanies Robot Companion 1.3.3 alpha preview. It runs without Node.js,
VS Code or RobotCode. Complete RobotCode parity and Windows editor qualification remain open.

## Installation

The extension contains the matching backend wheel and debugpy 1.8.22. Select the
project Python with **Robot Companion: Select Robot Environment**, then confirm
**Install Backend** or **Update Backend**. Installation uses that interpreter, no
package index or dependency resolution, and verifies the installed backend bytes.
No extra environment or manual backend download is required.

The project still needs one supported runtime row and its own libraries:

| Python | Robot Framework | debugpy | Optional formatter |
| --- | --- | --- | --- |
| 3.11 | 7.3.2 | 1.8.22 | Robocop 9.1.0 |
| 3.13 | 7.5 | 1.8.22 | Robocop 9.1.0 |

Other Python/Robot combinations are refused. Existing project packages are preserved;
the installer adds debugpy only when absent. An incompatible existing dependency
needs an explicit environment correction. RobotCode may remain installed in the
project; independent qualification environments deliberately exclude it.

The [Windows guide](../WINDOWS-PREVIEW.md) describes the advanced offline installation.
The release verifier checks installed files against the exact wheel; a matching
version alone does not establish that the correct build is installed.

## Services and implemented scope

```sh
python -m robot_companion_backend doctor
python -m robot_companion_backend lsp
python -m robot_companion_backend discovery
python -m robot_companion_backend dap
python -m robot_companion_backend interactive
python -m robot_companion_backend dap-prepare --workspace /project --target tests.robot
python -m robot_companion_backend dap-connect --check
```

Language features include import-aware definition, hover, completion, signature help,
references, safe rename, symbols, diagnostics and quick fixes, Add All Missing Imports,
optional document/range/on-type formatting, full/delta/range semantic tokens, inlay hints
and the import-scoped keyword list. The selected interpreter's libraries and static
project Python paths/variables are indexed without executing workspace library code.
Computed imports and variable files can remain unresolved rather than guessed.

Discovery returns version-1 normalized suites/tests and explicit source errors.
The owned debugger supports Robot/Python mixed sessions, conditional breakpoints,
logpoints, hit counts, failure filters, paused scalar editing, live breakpoint changes,
Pause at keyword boundaries, Step Out, prepared attach and restart. Arbitrary process
attach, reverse/data/function breakpoints and interrupting blocking library code with
Pause are unsupported. Interactive sessions provide REPL/notebook execution, variables,
interrupt/restart and owned cleanup. See the [extension reference](../README.md) for
user-facing semantics and limits.

## Build and verification

The dependency-free in-tree PEP 517 builder writes deterministic wheels and source
archives. Build from a clean committed checkout:

```sh
python3.13 backend/scripts/build_dists.py backend /tmp/robot-companion-dist
python3.13 backend/scripts/bundle_extension.py /path/to/approved/offline-wheels
```

The standalone release harness builds and installs the committed wheel in its own
scratch environment, runs every declared suite, requires zero skips in required suites,
records source identity and raw failures, and verifies process cleanup. Run both rows
with their matching offline wheel directories:
Equivalent module commands are `python -m robot_companion_backend doctor`,
`python -m robot_companion_backend lsp`, `python -m robot_companion_backend discovery`
and `python -m robot_companion_backend dap`. Language, discovery and debug services
speak framed protocol messages over standard input/output; they are intended to
be launched by a client such as Robot Companion, rather than used as interactive
terminal commands. Configure the extension to use the backend executable inside
your project environment. The release's Windows preview guide covers the editor setup.

## Implemented features

- Import-aware keyword and variable definitions, hover, completion, signature
  help, references, rename and document/workspace symbols.
- Parser and static-model diagnostics, import/qualification quick fixes and
  document formatting with the optional Robocop dependency.
- Semantic tokens for full documents and ranges.
- Normalized test discovery for Robot file suites, including source locations,
  their directory suites with Robot's names, each test's tags (from `Test Tags`,
  `Default Tags`, `[Tags]` and `-tag` removals, through every `__init__.robot`),
  whether a file holds tasks, and explicit discovery errors.
- Robot breakpoints, conditions and logpoints; paused stack/scopes/variables;
  continue and stepping; live Robot keyword execution in the debug console.
- A versioned debugpy handoff for Python debugging in the same Robot worker,
  with owned-process cleanup when debugging ends.

Language indexing reads workspace libraries statically and follows imports;
it does not execute arbitrary workspace libraries to discover keywords.

## Current limits

Static class/dynamic libraries, module search paths, variable files and some
runtime-variable scopes are incomplete. Navigation and rename do not model
`Run Keyword` argument calls; Python library keyword rename is unsupported.
Discovery reports directory suite names, tags and the task mode; other `__init__.robot`
settings (setups, teardowns, timeouts) take effect only when Robot runs. A tag or name
that uses a variable set only at run time is reported as discovery can resolve it.

Formatting uses Robocop defaults; range/on-type formatting, refactorings and source
actions are unavailable. Semantic token deltas and inlay hints are unavailable.
Large-workspace performance, remote workspaces and full multi-root behavior remain
unqualified.

Debugging does not support hit-count, function, data or reverse breakpoints,
`setVariable`, exception-breakpoint controls, attach/restart workflows or breakpoint
changes after configuration. Full debugger parity is not claimed.

## Build and validation

The package uses a dependency-free in-tree PEP 517 build backend. From the repository:

```sh
python3.13 backend/scripts/verify_release.py --wheels /opt/robot-wheels \
  --evidence /tmp/robot-companion-evidence-313 --scratch-root /tmp
/opt/python3.11/bin/python3.11 backend/scripts/verify_release.py \
  --wheels /opt/robot-wheels-py311 --evidence /tmp/robot-companion-evidence-311 \
  --scratch-root /tmp
```

On Windows use the selected Python executable and Windows paths. Retain the complete
source-bound receipt; backend conformance is distinct from VS Code UI acceptance.
The release assets record actual results for the integrated source. Accepted results
from individual feature branches do not qualify a different merged artifact.

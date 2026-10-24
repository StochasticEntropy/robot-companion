# Robot Companion backend 0.1.0.dev14

Independent Python language, discovery, debugging and interactive services for Robot Framework.
This backend accompanies Robot Companion 1.3.15 alpha preview. It runs without Node.js,
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

## Source declarations and runtime uncertainty

The native language service can follow supported literal keyword factories on an
explicitly imported class to that class's own method declarations. It reads source
without importing libraries and retains the original URI and line. Return Explorer,
hover and signature help label declared source information and explain that runtime
decorators may change the parameter contract. Computed names, unknown factory shapes,
rebindings, cycles and ambiguous declarations remain unresolved. Source declarations
are excluded from rename, missing-import edits and runtime argument-count diagnostics.

## Services and implemented scope

```sh
python -m robot_companion_backend doctor
python -m robot_companion_backend lsp
python -m robot_companion_backend discovery
python -m robot_companion_backend dap
python -m robot_companion_backend interactive
python -m robot_companion_backend project-config /absolute/project
python -m robot_companion_backend dap-prepare --workspace /project --target tests.robot
python -m robot_companion_backend dap-connect --check
```

Language features include import-aware definition, hover, completion, signature help,
references, safe rename, symbols, diagnostics and quick fixes, Add All Missing Imports,
optional document/range/on-type formatting, full/delta/range semantic tokens, inlay hints
and the import-scoped keyword list. The selected interpreter's libraries and static
project Python paths/variables are indexed without executing workspace library code.
Computed imports and variable files can remain unresolved rather than guessed.

Automatic quick-fix requests without backend diagnostics do not repeat source analysis.
Manual code actions, explicit source actions and fixes for published diagnostics remain
available. Language requests still run serially, while input intake can cancel obsolete
queued work and stop active source/graph work at cooperative checkpoints. A single
parser or operating-system read is not interrupted mid-operation. Admission is bounded
to 64 outstanding requests; excess requests receive an explicit busy error. Pending
notifications and small cancellation/busy replies share a 256-message/16-MiB bound;
exceeding it fails the session rather than losing document changes. Inlay requests only
resolve calls on requested lines, including arguments on continuation lines.

Discovery returns version-1 normalized directory/file suites, tags, task mode and explicit source errors.
For a large workspace, the editor requests bounded discovery pages and shows scan
counts in the Tests provider status. It applies the complete tree only after the
last page; no tests are omitted to meet a request deadline. Each page keeps the
normal request timeout. Superseded or canceled scans release their continuation;
the editor also bounds a full scan to five minutes and 64 MiB. One filesystem read
or Robot parser call remains non-preemptible. Legacy full and focused-file requests
retain their existing response format.
The owned debugger supports Robot/Python mixed sessions, conditional breakpoints,
logpoints, hit counts, failure filters, paused scalar editing, live breakpoint changes,
Pause at keyword boundaries, Step Out, prepared attach and restart. Arbitrary process
attach, reverse/data/function breakpoints and interrupting blocking library code with
Pause are unsupported. Interactive sessions provide REPL/notebook execution, variables,
interrupt/restart and owned cleanup. See the [extension reference](../README.md) for
user-facing semantics and limits.

The folder's Robot configuration can also come from `pyproject.toml` (`[tool.robot]`),
`robot.toml` and `.robot.toml`: `python-path`, `variables`, `variable-files`, `extensions`,
`args` and their `extend-` forms precede explicit Robot arguments. Unsupported settings,
wrong types and TOML syntax errors have diagnostics and setting help. Profiles, RobotCode
expressions and user-level configuration are unsupported.

With Robot Framework 7.5, Markdown `.robot.md` suites and imported `.md`/`.markdown`
resources use Robot's fenced-block rules, retaining file positions for navigation,
diagnostics, discovery and Robot debugging. RF 7.3.2 reports these as unsupported rather
than running them. Markdown sources do not offer quick fixes or formatting.

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

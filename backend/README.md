# Robot Companion backend preview

Independent Python language, test-discovery and debug services for Robot Framework.
The backend runs without Node.js, VS Code or RobotCode. Robot Companion connects
to its services over standard input/output.

This backend accompanies the [Robot Companion 1.3.0 preview](https://github.com/StochasticEntropy/robot-companion/releases/tag/v1.3.0-preview.1).
It is experimental and does not provide complete RobotCode feature parity.

## Runtime requirements

Use one of these exact Python/Robot Framework combinations:

| Python | Robot Framework | debugpy | Optional formatter |
| --- | --- | --- | --- |
| 3.11 | 7.3.2 | 1.8.22 | Robocop 9.1.0 |
| 3.13 | 7.5 | 1.8.22 | Robocop 9.1.0 |

The services refuse other combinations. Python 3.12 is unsupported. The preview's
offline dependency download targets **Python 3.11, Windows x64**; it is not a
Windows ARM or 32-bit package set.

Automated validation of the combined runtime code ran on **Linux aarch64,
Python 3.11.17 and Robot Framework 7.3.2**. The code includes Windows URI handling,
UTF-8 worker output and Windows process-tree ownership, but this combined preview
**has not been qualified on Windows**. Linux tests and Windows-path logic tests
do not establish Windows compatibility. macOS and other architectures are also
unqualified. The Python 3.13/Robot Framework 7.5 combination is supported by the
runtime gate; this combined preview was not rerun on that row.

## Install

Download and unpack the backend wheel, dependency wheels and verification helper
from the preview release. Install into the Python environment that contains your
project's Robot libraries. Check your project's dependency requirements first:
these commands install the exact supported Robot Framework and debugpy versions.

For the supplied offline Windows x64/Python 3.11 download, run PowerShell from the
unpacked directory and replace the interpreter path:

```powershell
$ProjectPython = 'C:\your-project\.venv\Scripts\python.exe'
& $ProjectPython -m pip install --force-reinstall --no-index --find-links .\wheels `
  -c .\wheels\constraints.txt '.\robot_companion_backend-0.1.0.dev1-py3-none-any.whl[format]'
& $ProjectPython .\verify-installed-backend.py
& $ProjectPython -m robot_companion_backend doctor
```

The optional `[format]` extra installs Robocop 9.1.0; omit it if document formatting
is not needed. The bundled wheels support only the Windows/Python row stated above.
For another supported runtime, provide dependency wheels matching its interpreter
and platform, or allow pip to obtain dependencies:

```sh
python -m pip install --force-reinstall './robot_companion_backend-0.1.0.dev1-py3-none-any.whl[format]'
python -m robot_companion_backend doctor
```

Keep `--force-reinstall`: preview builds retain backend version `0.1.0.dev1`, so
an older build can have the same version. The supplied verifier checks installed
package bytes against the exact downloaded wheel; a version check alone cannot
distinguish those builds. It must report `match: true`.

`doctor` reports the interpreter, dependency versions, supported runtime row,
formatter availability and whether RobotCode is present. A successful independent
backend environment reports `supported: true` and `robotcodePresent: false`.
If your project already depends on RobotCode, use a separate compatible environment
rather than removing packages from an existing environment without checking its needs.

## Services

The console entry point and Python module accept the same service argument:

```sh
robot-companion-backend doctor
robot-companion-backend lsp
robot-companion-backend discovery
robot-companion-backend dap
```

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
- Normalized test discovery for Robot file suites, including source locations
  and explicit discovery errors.
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
Discovery does not expose directory suites, tags or all `__init__.robot` settings.

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
SOURCE_DATE_EPOCH=1792368000 python backend/scripts/build_dists.py backend dist
```

The public wheel rebuild changes documentation/metadata only: its 18 Python runtime
modules are byte-identical to the previously validated combined preview. That runtime
completed 15 installed-wheel suites: 152 passed and one documented RF-absent
lifecycle case skipped. Every required live suite had zero skips. Nine frontend
integration tests also passed, including real Robot console execution, Python
stepping and stop cleanup. Artifact verification and offline installation checks
are recorded separately for the public wheel; these do not constitute Windows
qualification.

The backend is MIT licensed. Third-party dependency archives retain their own
licenses and notices; see the release's third-party wheel inventory.

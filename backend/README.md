# Independent Robot backend

This distribution is a work-in-progress native backend for the Robot Companion
replacement program. It has no dependency on Node, VS Code, Companion or RobotCode.
The extension and its RobotCode path remain separate and unchanged.

**Current checkpoint:** bounded stdio transport and LSP source, plus the copied v1
audit corpus and headless tests. Ten dependency-free mechanical checks pass.
Robot parser-backed conformance, installation and package build have not run:
the assigned runtime has no Robot Framework, debugpy or build dependencies.
DAP and live console/debugpy handoff are not implemented at this checkpoint.
This is not the phase-1 acceptance handoff.

## Runtime and installation

The initial target is Python 3.13 and Robot Framework 7.5. The package declares
exact initial dependency versions in `pyproject.toml` and `constraints.txt`.
These are version inputs, not a completed hash-locked runtime manifest; WOL-805
must supply the approved credential-free wheels and measured transitive hashes.
No other Python/RF version or platform has been validated.

From the repository checkout, after that runtime is supplied, use an independent
venv and its read-only wheel directory (substitute the operator-provided path):

```bash
python3.13 -m venv /tmp/rcb-venv
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links "$APPROVED_WHEELS" -c backend/constraints.txt build setuptools wheel
/tmp/rcb-venv/bin/python -m build --no-isolation --outdir /tmp/rcb-dist backend
/tmp/rcb-venv/bin/python -m pip install --no-index --find-links "$APPROVED_WHEELS" /tmp/rcb-dist/*.whl
/tmp/rcb-venv/bin/robot-companion-backend doctor
```

These installation commands are pending verification, not recorded successes.
No frontend dependency directory is needed. Never install RobotCode in this venv.
`doctor` prints JSON versions and returns 2 if a required tool is missing or
RobotCode is present. A successful doctor is a prerequisite probe, not conformance.

## Launch the language service

The proposed v1 descriptor uses explicit executable/argv arrays, without a shell:

```json
{
  "id": "robot-companion-native",
  "version": "0.1.0.dev1",
  "contractVersion": 1,
  "language": {
    "executable": "/tmp/rcb-venv/bin/robot-companion-backend",
    "argv": ["lsp"],
    "transport": "stdio"
  }
}
```

The caller supplies cwd, environment and workspace URI. Protocol stdout contains
only Content-Length-framed UTF-8 JSON. Errors go to stderr or LSP error replies.
Only local file URIs and UTF-16 positions are supported. Initialize fails explicitly
when RF is absent. Full-text synchronization is required; the server rejects
non-increasing document versions and incremental-range changes.

After installation, run `robot-companion-backend lsp`. From source, use
`PYTHONPATH=backend/src python3 -m robot_companion_backend lsp`.

## Headless checks

From the repository root, without npm or VS Code:

```bash
# Mechanical checks: no RF required, not language/debug acceptance.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_transport.py -v

# Required parser-backed checks: fails rather than skipping if RF is missing.
RCB_TRANSCRIPTS=/evidence/mis191/lsp PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p test_lsp_live.py -v
```

Use the independent backend venv's Python for acceptance. Omit `PYTHONPATH` when
checking the installed wheel so the source checkout cannot mask packaging errors.
The client launches actual backend subprocesses with bounded timeouts and drains
stderr. Cleanup terminates/kills only its own subprocess and joins its readers.
The live suite covers audit navigation, unimported shadow exclusion, aliases and
ambiguity, changed library/resource sources and overlays, variables in distinct
owners, embedded keywords, UTF-16 positions and orderly shutdown. It currently
cannot run in the assigned runtime. Full backend conformance also requires the
not-yet-implemented real Robot/debugpy DAP suite.

## Architecture and limits

`protocol.py` bounds headers to 8 KiB and payloads to 8 MiB, handles short byte
reads, serializes writes and rejects malformed frames. `lsp.py` handles lifecycle,
full-text overlays, definition requests and diagnostic publication. Requests run
serially; completed requests may ignore subsequent cancellation notifications.
No asynchronous worker returns an old document result.

`workspace.py` uses Robot Framework's parser/model for Robot syntax and an explicit
resource/library graph rooted at each document. It follows imports rather than
scanning every Python file. Python AST reads decorated module-level functions
without importing or executing a library. Local, resource and library precedence
is explicit; ambiguity returns all matching source locations and a diagnostic,
never an alphabetically chosen path. Imported dependencies are reread per request,
so a saved source change cannot reuse a stale symbol cache. Unsaved text overlays
win until close. Source positions convert code points/Python AST UTF-8 offsets to
LSP UTF-16. Variables resolve within the current owner, then the suite table.

At this checkpoint these parser behaviors are source implementations awaiting
real-runtime verification. Static Python class libraries, dynamic/module search
paths, variable-based imports, complete runtime variable scopes and large-workspace
performance need further outcomes. No library code is executed during indexing.

## Capability inventory and continuation

| Family | Current state | Evidence / next boundary |
| --- | --- | --- |
| Byte framing, malformed input, CLI subprocesses | Mechanical checks pass | `test_transport.py`, 10 tests |
| LSP lifecycle, definition, parser/import graph, diagnostics | Source implemented, runtime unverified | `test_lsp_live.py`; run with RF 7.5 |
| Robot DAP, live Robot console, stepping and handles | Missing | Implement runtime listener, paused-context command loop and DAP suite |
| Versioned debugpy child handoff and cleanup | Missing | Prove audit Python lines 18→19, count=3, return to Robot |
| Standalone wheel/sdist install | Declared, unverified | Build/install offline in prepared backend venv |
| Hover, completion/signature, references/rename, symbols | Missing | Separate bounded language outcomes |
| Full diagnostics, formatting, code actions, discovery/results | Missing | Separate bounded semantic/execution outcomes |
| Multi-root/remote, config, broad compatibility | Unverified | Explicit version/platform matrix later |
| Reverse/data/function breakpoints, setVariable, exceptions | Unsupported | Do not advertise them |
| Notebook/TOML/Markdown, secondary AI/tool integrations | Missing | Program parity inventory; no LLM in this product |

The Lead owns follow-up scheduling under MIS-190. This checkpoint does not claim
full language-server/debugger parity, any UI interaction coverage, or phase-1
acceptance. The supplied `audit-evidence` issue document retains the real baseline
interaction audit (VS Code 1.116.0); this headless source change requires no new
browser/UI flow and does not claim testing in VS Code 1.141.0.

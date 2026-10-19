# Native backend preview validation

This prerelease combines native language tooling, test discovery, Robot debugging
and a Python debugpy handoff. It retains an explicit RobotCode fallback. A folder's
selected Python interpreter (**Select Robot Environment**) runs the native backend
and Run Test / Run Suite; without one, the project's `.venv` backend executable is the
default. `robotCompanion.nativeBackendExecutable` and `robotCompanion.robotCommand`
remain explicit overrides.

## Verified scope

- Linux aarch64, Python 3.11 and Robot Framework 7.3.2: the installed backend wheel
  ran 153 tests across 15 suites, with 152 passes and one optional no-Robot lifecycle
  case skipped. Required live suites had no skips.
- Real native frontend integration: nine tests passed, including language and
  discovery services, a Robot Debug Console keyword call, Python child-session
  stepping/evaluation, return to a Robot frame and process cleanup.
- Local frontend protocol/unit checks: 68 passes, 12 live cases skipped because
  their prepared runtime was unavailable on that host. Native live cases were
  exercised separately as above. Existing return, run and HTML-fragment checks
  passed; all extension JavaScript files passed syntax checks.
- The public backend wheel differs from that runtime-tested wheel only in public
  documentation/metadata. Every runtime module is byte-identical. The public wheel
  was installed offline in Python 3.11; doctor and installed-code verification passed.
  An sdist rebuild produced the same wheel. A further 27 targeted build, navigation
  and Windows URI/junction tests passed.
- Same-version replacement was tested: a normal pip install retained altered older
  bytes, the verifier rejected them, and constrained `--force-reinstall` restored
  exactly the supplied wheel. Keep the force-reinstall and verifier steps in the
  setup guide because the backend version remains `0.1.0.dev1`.

## Limits

Complete native Windows UI, discovery and debugger qualification remains pending.
Windows portability logic tests and Linux runtime tests do not establish a Windows
qualification pass. The offline bundle targets Windows x64 with Python 3.11 and
Robot Framework 7.3.2. The backend also supports Python 3.13 with Robot Framework 7.5,
but dependencies for that alternative platform/runtime are not in this bundle.

The final public composite has not run the complete VS Code UI suite. Broader real
projects, other operating systems, remote extension hosts, full multi-root debugging
and minimum VS Code compatibility remain unverified. Attach/restart, exception and
hit-count breakpoints, inlay hints, coverage and continuous runs remain incomplete
or unverified. This release is a preview for testing, not a full RobotCode parity claim.

Release assets include SHA-256 hashes and a source manifest. Source and artifact
identities are separate from runtime compatibility; use the setup guide's exact
installed-code verifier in addition to the backend's runtime doctor.

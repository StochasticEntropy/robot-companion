# Preview 1.3.2 validation

The extension version is 1.3.2 and its matching native backend is 0.1.0.dev2.
This preview integrates the accepted library resolution, source actions and formatting,
keyword explorer, run-environment picker, editor regression and Windows backend work
listed in [the integration record](../agent/documentation/preview-1.3.2-integration.md).
This prerelease combines native language tooling, test discovery, Robot debugging
and a Python debugpy handoff. It retains an explicit RobotCode fallback. A folder's
selected Python interpreter (**Select Robot Environment**) runs the native backend
and Run Test / Run Suite; without one, the project's `.venv` backend executable is the
default. `robotCompanion.nativeBackendExecutable` and `robotCompanion.robotCommand`
remain explicit overrides.

## Evidence and release gate

The release assets carry the exact source SHA, standalone installed-wheel qualification
receipts and editor test counts. Qualification runs the unchanged backend release harness
on Python 3.11 and 3.13 with their constrained Robot Framework dependencies. All 17
declared backend suites are required; required live suites must have zero skips. The
no-Robot prerequisite case may skip when Robot Framework is installed. A failed check,
source change during a run or missing receipt rejects qualification.

Editor qualification uses a clean VS Code 1.141.0 profile and an offline native backend
built from this checkout. Its complete suite includes the accepted library, keyword
explorer, source-action, semantic-token and environment-picker regression cases. Real
Windows backend checks use the fixed public windows-2022 control workflow and bind
the requested source SHA. Backend qualification does not establish complete Windows
editor, debugger or extension-host qualification. Consult the actual attached receipts
for the platforms and checks that completed.

## Remaining limits

The backend still requires a separate project installation. The one-click managed
backend requirement remains mandatory in MIS-477; selected-environment adoption
for language and debug services remains under repair in MIS-476. This preview's
accepted picker selects the Run Test / Run Suite environment; it does not claim
that unfinished service adoption is implemented.

Complete Windows UI qualification, attach/restart, exception and hit-count breakpoints,
inlay hints, coverage, continuous runs, remote extension hosts and broad multi-root
debugging remain incomplete or unverified. The offline Windows bundle targets
Windows x64 Python 3.11 with Robot Framework 7.3.2. Python 3.13 is supported by
the backend, but its platform dependencies are not included in that bundle.

Install the new backend wheel as well as the extension. Use the setup guide's
installed-code verifier in addition to doctor; runtime compatibility and exact
installed bytes are different checks. Stable installations are not promoted by
this preview release.

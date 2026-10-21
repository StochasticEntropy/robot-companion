# Robot Companion 1.3.2 — Windows preview

**Normal setup needs none of the manual steps below.** Install the extension, open the
project, click **Robot: …** in the status bar (or run **Robot Companion: Select Robot
Environment**) and choose the project's existing Python interpreter. When Robot Companion
reports that its backend is missing or another build, choose **Install Backend** or **Update
Backend** in that notification and confirm: it installs the backend build carried by the
extension into that interpreter without downloading anything and checks the installed files.
Robot Framework, RobotCode and your project's libraries stay as they are. See [backend setup
and updates](README.md#backend-setup-and-updates).

The rest of this guide is the **advanced, offline path** for machines where you install the
backend yourself. For it, download and unpack the [Windows x64 / Python 3.11 offline bundle](https://github.com/StochasticEntropy/robot-companion/releases/download/v1.3.3-preview.1/robot-companion-1.3.3-windows-preview.zip) first.
It contains the backend wheel, dependencies and verifier needed below.

This preview uses **Robot Companion's own backend by default** for navigation,
language features, test discovery and debugging. RobotCode and the Python/debugpy
VS Code extensions are not required. Use this on the Windows machine where your
project and Python environment actually run, including inside the remote desktop.

## 1. Advanced: install the backend in your project environment yourself

Use an existing **64-bit Python 3.11 environment with Robot Framework 7.3.2** and
your project's libraries. Keep that environment selected for your project. This
download includes Windows x64 dependencies, so the following install is offline.
It adds the backend, debugpy 1.8.22 and the optional Robocop 9.1.0 formatter to that
environment. It does not install RobotCode.

In PowerShell, change to the unpacked preview download and replace the project path:

```powershell
$ProjectPython = 'C:\your-project\.venv\Scripts\python.exe'
& $ProjectPython --version
& $ProjectPython -m robot --version
& $ProjectPython -m pip install --force-reinstall --no-index --find-links .\wheels `
  -c .\wheels\constraints.txt '.\robot_companion_backend-0.1.0.dev2-py3-none-any.whl[format]'
& $ProjectPython .\verify-installed-backend.py
& 'C:\your-project\.venv\Scripts\robot-companion-backend.exe' doctor
```

The first commands must show Python 3.11 and Robot Framework 7.3.2. Keep
`--force-reinstall`: this preview retains backend version `0.1.0.dev2`, so an older
build can have the same version. `verify-installed-backend.py` must report
`match: true`; it compares installed backend files against this download's exact wheel,
and rejects a shadowing Python import path. `doctor` must
report `supported: true`. It exits with code 0 only without RobotCode; with RobotCode in
the environment it reports `robotcodePresent: true` and exits with code 2, which only notes
that RobotCode is also installed. The native services run with RobotCode in the same
environment; do not remove it.
The supported alternative runtime is Python 3.13 + RF 7.5; the included dependency
wheels target Python 3.11 Windows x64. Python 3.12, Windows ARM and 32-bit Python
are outside this preview.

## 2. Install the VSIX on the remote machine

In VS Code, choose **Extensions → … → Install from VSIX…** and select
`robot-companion-1.3.2-preview.vsix`. Reload the window. The extension is also available through the Marketplace prerelease channel.
The VSIX updates the existing Robot
Companion extension ID. Disable another Robot language/debug extension in this
workspace while testing owned mode to avoid duplicate providers.

## 3. Open the project folder and configure its environment

Trust the folder only if it is your trusted project. Native services do not start
in Restricted Mode. The preview defaults to owned mode and to the backend installed
at `<workspace>/.venv/Scripts/robot-companion-backend.exe`.

Open a `.robot` file, click **Robot: …** in the status bar (or run **Robot Companion:
Select Robot Environment**) and choose the project's Python 3.11 interpreter: `.venv`
when it is the project's `.venv`, otherwise **Enter path…** → **Python interpreter** →
`C:\your-project\.venv\Scripts\python.exe`. That one interpreter now runs the native
language, discovery and debug services (`python.exe -m robot_companion_backend`) and
Run Test / Run Suite (`python.exe -m robot`). **Robot Companion: Show Language Service
Status** prints the interpreter, its Python and Robot Framework versions and the installed
backend's version and file digest.

Settings remain available as explicit overrides. Open **Preferences: Open Workspace
Settings (JSON)**, preserve existing settings and add only what you need. Forward slashes
avoid JSON escape issues. `nativeBackendExecutable` replaces the selected interpreter for
the backend services; `robotCommand` replaces it for runs only:

```json
{
  "robotCompanion.integrationMode": "owned",
  "robotCompanion.nativeBackendExecutable": "C:/your-project/.venv/Scripts/robot-companion-backend.exe",
  "robotCompanion.robotCommand": "\"C:/your-project/.venv/Scripts/python.exe\" -m robot"
}
```

Remove old `robotCompanion.languageBackend`, `executionBackend` or `discoveryBackend`
descriptors if they select another backend; explicit descriptors override the native
default. No Python-extension selection or RobotCode configuration is needed.

## 4. Try it

- Open a `.robot` file. **Robot Companion: Show Language Service Status** should
  identify Native backend for Language, Debug and Tests.
- Ctrl-click or F12 a keyword. Try hover, completion, references, rename, semantic
  highlighting, Ctrl+. quick fixes and Format Document.
- Open Testing, refresh tests, then Run or Debug a test. Run Test / Run Suite
  CodeLenses also remain available.
- Set Robot and Python gutter breakpoints. Start Robot Companion debugging from
  Run and Debug or the Testing Debug action. While paused in a Robot frame, type a
  Robot keyword call with Robot's cell spacing in the Debug Console, for example
  `Catenate    SEPARATOR=-    hello    preview`. Select the nested Python child
  session to inspect/step Python, and a Robot frame for Robot keyword execution.
- Check documentation preview, Return Explorer, enum hints and exports as usual.

If an executable path is wrong, or the selected interpreter lacks the backend, the
preview reports it with the interpreter and its versions and starts no substitute
provider. Choose **Install Backend** / **Update Backend** in that notification (or run
**Robot Companion: Install or Update Backend**), or select another environment. The
`Robot Companion Backend` Output channel shows pip's output. The `Robot Companion Language`, `Robot Companion Debug` and
`Robot Companion Test Run` Output channels provide details.

## Limits and optional fallback

This is an experimental combined build, not a completed Windows qualification.
It includes targeted Windows portability repairs with source and artifact provenance in
`SOURCE-MANIFEST.json`. Full native Windows debug/discovery/UI qualification is
still pending. Large project performance, remote extension hosts, multi-root
debugging, minimum VS Code compatibility, attach/restart, inlay hints, coverage and
continuous runs remain incomplete or unverified. Robot failure stops, hit counts and
changing paused Robot values are implemented in later source but not Windows-verified.
Do not infer a Windows pass from the accepted Linux branch checks.

RobotCode is retained only as an optional troubleshooting path. If native mode
causes a problem, its existing advanced `languageBackend` / `executionBackend`
descriptors can point at a separately installed RobotCode 2.7.0 environment; the
README contains examples. It is not installed or started by default. To keep using
another Robot extension temporarily, set `robotCompanion.integrationMode` to
`coexistence` and re-enable that extension.

To revert the preview, install your previous stable Robot Companion VSIX or the
regular release, remove the preview's executable setting and restore your former
integration mode/settings. This preview changes no project files automatically.

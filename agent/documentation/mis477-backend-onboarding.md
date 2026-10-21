# MIS-477: install and update the native backend from the editor

Author notes for the original outcome. This is not acceptance; exact-SHA check results
and the hand-in live in the issue's `artifact-handoff` document.

## Baseline and dependency

The branch starts at the published preview `3411d65`. Accepted MIS-476 `0aa14cf`
(gate decision: Operator integration `0aa14cf` after `3411d65`) is merged into this
worktree only (`7d751ab`), because the selected-interpreter services are what this
outcome installs into.

## Design

- **Delivery.** The extension carries `bundled-backend/`: the deterministic backend wheel
  built from `backend/` at the same commit, the debugpy 1.8.22 pure-Python wheel with its
  published SHA-256, and `manifest.json` (hashes, supported rows, and the digest of the
  installed `robot_companion_backend/` files). `backend/scripts/bundle_extension.py`
  regenerates it with fixed timestamps; `tests/integration/backend-bundle.test.js` fails
  while the committed copy differs from a fresh build. `package.json` `files` ships it.
- **Where it is installed.** Into the folder's selected project interpreter, the same one
  that already runs the native services and `python -m robot` (MIS-476). No tooling venv;
  the backend reads the project's own Robot Framework and installed libraries.
- **Detection.** The existing environment probe also reads debugpy, RobotCode and pip
  availability. `assess()` classifies absent, incomplete (including missing version
  metadata), other version, same version with other bytes (digest differs from the
  manifest), shadowed, missing Robot Framework and unsupported Python/RF rows. The first
  four offer **Install Backend** / **Update Backend**; the others offer no install, because
  Robot Companion never installs or changes Python or Robot Framework. A backend whose
  bytes differ from the bundled build is now refused before it starts.
- **Consent.** `src/integration/backend-installer.js`: a modal names the folder, interpreter,
  what is added or replaced, what stays unchanged (Python, RF, an existing debugpy,
  RobotCode, all other packages) and the exact command. The palette command
  **Robot Companion: Install or Update Backend** opens the same flow.
- **Install.** `<python> -m pip install --no-index --no-deps --force-reinstall --no-cache-dir
  --disable-pip-version-check --no-input <bundled wheels>` with `PIP_USER=0`, through the
  owned process helper, in a cancellable progress notification; output goes to the
  **Robot Companion Backend** channel. Wheel bytes are checked against the manifest first.
  debugpy is included only when the environment has none.
- **Verification and recovery.** After pip, the environment is probed again; only a
  digest match with the manifest counts as installed and restarts that interpreter's
  folders. Cancellation, pip failures and mismatches report pip's last error and the state
  the environment is now in, with **Retry** (asks again) and **Show Output**.
- **Fresh folder.** With no interpreter selected and no `.venv` backend, the notice asks
  for the project's Python instead of naming a missing `.venv` executable.

## Found while testing

pip's failed rollback (read-only site-packages, uid without write access) leaves an
empty `robot_companion_backend-<old>.dist-info`. `importlib.metadata.distribution()`
returned that empty copy first, so a successful Retry was still reported incomplete. The
probe now prefers the distribution that has version metadata. The empty directory is left
in place (documented in the README).

## Checks added

- `tests/integration/backend-bundle.test.js`: bundle drift and hashes; plan/command/consent
  text; tampered bundle refused; real venvs: Cancel at the modal changes nothing, install
  adds exactly the backend and debugpy, bytes verified, services restarted; an empty stray
  `.dist-info` does not hide the install; update of another same-version build;
  cancellation; missing pip and Retry after `ensurepip`.
- `tests/ui/backend-onboarding-host.js` (`npm run test:backend-onboarding`): normal VS Code
  windows, fresh profile, real pointer/keyboard input over CDP, synthetic projects with
  offline-built environments:
  - fresh 3.11/RF 7.3.2 project without backend or debugpy: not-set-up notice, Select Robot
    Environment from it, Install Backend, confirmation Cancel, install from the palette,
    independent digest check and package diff, hover and F12 into the project library,
    Test Explorer Run All, Debug Test stopping at an F9 breakpoint and Continue;
  - existing 3.13/RF 7.5 project with RobotCode 2.7.0 and another build of 0.1.0.dev1:
    Update Backend, Cancel in the progress notification while pip runs (a fixture `.pth`
    makes `pip install` wait 30 s only while a flag file exists), Retry, verified update with
    every package version unchanged and RobotCode still installed;
  - existing 3.11/RF 7.3.2 project with backend 0.0.9: update failing on a read-only
    site-packages, the user restoring write access, Retry succeeding.

## Not covered here

- Windows x64 / Python 3.11 / RF 7.3.2 through actual Windows editor input (criteria 3 and
  6, and the Windows part of 7). The approved Windows CI broker offers only the backend
  suite and the fixed UI smoke case; it cannot run this journey. The host test uses
  `/proc`, POSIX permissions and X11 and is Linux-only. Nothing about Windows is inferred
  from Linux.
- No genuine human usability session; these are agent-driven real-input checks.
- Environments without pip (for example some uv-created venvs) get an actionable error, not
  a pip-less install.

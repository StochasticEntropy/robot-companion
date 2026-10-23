"use strict";
// The backend bundled with the extension (bundled-backend/) and Install or Update Backend.
// The committed wheel must be the deterministic build of backend/ at this commit, the
// manifest's digests must describe the committed files, and the installer must add exactly
// those files to a real interpreter: only after confirmation, without an index or dependency
// resolution, leaving Robot Framework and every other package unchanged, then verify the
// installed bytes. Cancellation, a missing pip and a retry are exercised with real processes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const BUNDLE = path.join(ROOT, "bundled-backend");
const manifest = JSON.parse(fs.readFileSync(path.join(BUNDLE, "manifest.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const python313 = process.env.ROBOT_COMPANION_NATIVE_PYTHON ||
  ["/usr/local/bin/python3.13", "/usr/bin/python3.13"].find(file => fs.existsSync(file));
const WHEELS = process.env.ROBOT_COMPANION_ROBOT_WHEELS || "/opt/robot-wheels";
const MINOR = python313 ? childProcess.execFileSync(python313,
  ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).trim() : undefined;
const ROBOT = MINOR === "3.11" ? "7.3.2" : "7.5";
const venvPython = venv => path.join(venv, process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python");
const venvBackend = venv => path.join(venv, process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "robot-companion-backend.exe" : "robot-companion-backend");

// A minimal VS Code surface whose dialogs answer from a script.
const state = { trusted: true, folders: [], config: {}, answers: [], shown: [], progress: [], cancelAfter: undefined };
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Uri { constructor(file) { this.fsPath = file; this.scheme = "file"; } toString() { return pathToFileURL(this.fsPath).href; } }
const dialog = kind => (message, ...rest) => {
  const options = typeof rest[0] === "object" && rest[0] && !Array.isArray(rest[0]) ? rest.shift() : undefined;
  state.shown.push({ kind, message, detail: options?.detail, modal: !!options?.modal, buttons: rest });
  // An answer may be a function: it runs while the dialog is open, then gives the choice.
  const answer = state.answers.length ? state.answers.shift() : undefined;
  return Promise.resolve(typeof answer === "function" ? answer() : answer);
};
const vscode = {
  EventEmitter, Uri,
  ProgressLocation: { Notification: 15 },
  workspace: {
    get isTrusted() { return state.trusted; },
    get workspaceFolders() { return state.folders; },
    getWorkspaceFolder: uri => state.folders.find(folder => uri.fsPath.startsWith(folder.uri.fsPath)),
    getConfiguration: (_section, uri) => ({ get: (key, fallback) => {
      const values = state.config[uri.toString()] || {};
      return Object.hasOwn(values, key) ? values[key] : fallback;
    } })
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: dialog("error"), showWarningMessage: dialog("warning"), showInformationMessage: dialog("information"),
    createOutputChannel: () => ({ lines: [], append(text) { this.lines.push(text); }, appendLine(text) { this.lines.push(`${text}\n`); }, show() {}, dispose() {} }),
    // A cancellable progress: cancelAfter(ms) requests cancellation while the task runs.
    withProgress: (options, task) => {
      state.progress.push(options);
      let listener;
      const token = { isCancellationRequested: false, onCancellationRequested: fn => { listener = fn; return { dispose() { listener = undefined; } }; } };
      if (state.cancelAfter !== undefined) setTimeout(() => { token.isCancellationRequested = true; listener?.(); }, state.cancelAfter);
      return task({ report() {} }, token);
    },
    showWorkspaceFolderPick: () => Promise.resolve(state.folders[0])
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() }
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { ProjectEnvironments, bundledBackend } = require("../../src/integration/project-environment");
const { BackendInstaller, plan, pipArguments, consent, failure } = require("../../src/integration/backend-installer");
const { SUPPORTED_NATIVE_VERSION } = require("../../src/integration/native-backend");
Module._load = load;

test("the bundled wheel is the deterministic build of backend/ and the manifest describes the committed files", () => {
  const python = python313 || "python3";
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-backend-check-"));
  try {
    // A caller's SOURCE_DATE_EPOCH does not change the bundled bytes.
    childProcess.execFileSync(python, ["-B", path.join(ROOT, "backend/scripts/bundle_extension.py"), BUNDLE, scratch], { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1792368000" } });
    const fresh = JSON.parse(fs.readFileSync(path.join(scratch, "manifest.json"), "utf8"));
    assert.deepEqual(fresh, manifest, "bundled-backend/manifest.json is stale: run `python3 backend/scripts/bundle_extension.py <offline wheels>`");
    for (const name of fs.readdirSync(scratch)) assert.equal(sha256(path.join(scratch, name)), sha256(path.join(BUNDLE, name)), `${name} matches a fresh build`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  assert.deepEqual(fs.readdirSync(BUNDLE).sort(), ["manifest.json", manifest.backend.wheel, ...manifest.dependencies.map(item => item.wheel)].sort());
  assert.equal(sha256(path.join(BUNDLE, manifest.backend.wheel)), manifest.backend.sha256);
  for (const item of manifest.dependencies) assert.equal(sha256(path.join(BUNDLE, item.wheel)), item.sha256);
  assert.equal(manifest.backend.version, SUPPORTED_NATIVE_VERSION, "the extension supports exactly the bundled backend version");
  assert.deepEqual(manifest.dependencies.map(item => `${item.distribution}==${item.version}`), ["debugpy==1.8.22"]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert(pkg.files.includes("bundled-backend/**"), "the VSIX includes the bundled backend");
});

test("the install plan checks wheel bytes, adds debugpy only when absent and never resolves dependencies", () => {
  const identity = { python: "3.11.9", executable: "/p/python", robot: "7.3.2", backend: null, debugpy: null, robotcode: "2.7.0" };
  const fresh = plan(identity);
  assert.deepEqual(fresh.map(item => item.wheel), [manifest.backend.wheel, "debugpy-1.8.22-py2.py3-none-any.whl"]);
  assert.deepEqual(plan({ ...identity, debugpy: "1.8.20" }).map(item => item.wheel), [manifest.backend.wheel], "an existing debugpy is never changed");
  const args = pipArguments(fresh);
  assert.deepEqual(args.slice(0, 5), ["-m", "pip", "install", "--no-index", "--no-deps"]);
  assert(!args.some(arg => /robotframework|robotcode/i.test(arg)), args.join(" "));
  const text = consent({ name: "Neues Projekt" }, "/p/python", identity, { action: "install" }, fresh);
  assert.equal(text.title, "Install the Robot Companion backend in this Python environment?");
  for (const part of ["Interpreter: /p/python (Python 3.11.9, Robot Framework 7.3.2)", `Adds: robot-companion-backend 0.1.0.dev8 (bundled build, sha256 ${manifest.backend.installedFiles.sha256.slice(0, 12)}`,
    "Adds: debugpy 1.8.22", "Unchanged: Python 3.11.9, Robot Framework 7.3.2, RobotCode 2.7.0 and every other installed package.", "--no-index --no-deps", "Nothing is downloaded"]) {
    assert(text.detail.includes(part), `${part} in\n${text.detail}`);
  }
  assert.match(failure({ code: 1, output: "/p/python: No module named pip\n" }, "/p/python"), /pip is not available in \/p\/python\. Add pip to that environment/);
  assert.match(failure({ code: 1, output: "Processing x\nERROR: Could not install packages due to an OSError: [Errno 13] Permission denied: '/site'\n" }, "/p/python"),
    /^pip exited with code 1: ERROR: Could not install packages due to an OSError: \[Errno 13\] Permission denied/);
  // A changed bundled file is refused before anything runs.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-backend-tamper-"));
  try {
    for (const name of fs.readdirSync(BUNDLE)) fs.copyFileSync(path.join(BUNDLE, name), path.join(copy, name));
    fs.appendFileSync(path.join(copy, manifest.backend.wheel), "x");
    assert.throws(() => plan(identity, { ...manifest, directory: copy }), /does not match its manifest.*Reinstall the Robot Companion extension/);
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});

// A project environment as a user has it: Python + Robot Framework + an installed project library.
function projectVenv(name, { pip = true } = {}) {
  const venv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backend-install-")), name);
  childProcess.execFileSync(python313, ["-m", "venv", venv]);
  const python = venvPython(venv);
  childProcess.execFileSync(python, ["-m", "pip", "install", "--no-index", "--find-links", WHEELS, "--no-cache-dir", "--disable-pip-version-check", "-q", `robotframework==${ROBOT}`]);
  if (!pip) childProcess.execFileSync(python, ["-m", "pip", "uninstall", "-y", "-q", "pip"]);
  return { venv, python, root: path.dirname(venv) };
}
const freeze = python => childProcess.execFileSync(python, ["-c",
  "import importlib.metadata as m, json; print(json.dumps(sorted(f'{d.metadata[\"Name\"]}=={d.version}' for d in m.distributions())))"], { encoding: "utf8" });

// `selected: false` leaves the folder without a selected interpreter (the default .venv backend applies).
function setup(env, { selected = true } = {}) {
  const folder = { name: path.basename(env.root), uri: new Uri(env.root), index: 0 };
  state.folders = [folder]; state.config = {}; state.shown = []; state.progress = []; state.answers = []; state.cancelAfter = undefined;
  const controller = { onDidChange: () => ({ dispose() {} }), interpreter: async () => selected ?
    { source: "saved", kind: "python", label: "python", executable: env.python } : { source: "none" } };
  const environments = new ProjectEnvironments(controller);
  const restarted = [];
  environments.onDidChange(keys => restarted.push(...keys));
  return { folder, environments, installer: new BackendInstaller(environments), restarted };
}
const pipCommands = installer => installer.channel.lines.filter(line => line.includes("Running ") && line.includes(" -m pip install "));
const purelibOf = python => childProcess.execFileSync(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], { encoding: "utf8" }).trim();
const installBundled = (python, ...wheels) => childProcess.execFileSync(python, ["-m", "pip", "install", "--no-index", "--no-deps", "-q", "--disable-pip-version-check",
  ...wheels.map(name => path.join(BUNDLE, name))]);

const real = !["3.11", "3.13"].includes(MINOR) || !fs.existsSync(WHEELS) ? "needs supported Python and offline wheels" : false;
test("Install Backend: nothing before confirmation, then exactly the bundled files, verified, with services restarted", { skip: real }, async () => {
  const env = projectVenv("project");
  const { folder, environments, installer, restarted } = setup(env);
  const before = freeze(env.python);
  environments.started.set(folder.uri.toString(), "refused");
  // The modal is dismissed: nothing runs.
  assert.equal(await installer.run(folder.uri), false);
  const modal = state.shown.find(item => item.modal);
  assert.equal(modal.message, "Install the Robot Companion backend in this Python environment?");
  assert.deepEqual(modal.buttons, ["Install Backend"]);
  assert(modal.detail.includes(`Interpreter: ${env.python} (Python ${MINOR}.`) && modal.detail.includes(`Robot Framework ${ROBOT}`), modal.detail);
  assert.equal(state.progress.length, 0); assert.equal(freeze(env.python), before);
  // Confirmed: pip installs the bundled backend and debugpy, and nothing else changes.
  state.answers = ["Install Backend"];
  assert.equal(await installer.run(folder.uri), true);
  const added = JSON.parse(freeze(env.python)).filter(item => !JSON.parse(before).includes(item));
  const removed = JSON.parse(before).filter(item => !JSON.parse(freeze(env.python)).includes(item));
  assert.deepEqual(added.sort(), ["debugpy==1.8.22", "robot-companion-backend==0.1.0.dev8"]);
  assert.deepEqual(removed, []);
  const identity = (await environments.inspect(folder)).identity;
  assert.deepEqual({ sha256: identity.backend.sha256, files: identity.backend.files }, manifest.backend.installedFiles);
  assert.match(state.shown.at(-1).message, /^Robot Companion backend 0\.1\.0\.dev8 is installed in .* and matches the bundled build \(sha256 [0-9a-f]{12}, \d+ files\)\. Native services are starting\.$/);
  await environments.queue;
  assert.deepEqual(restarted, [folder.uri.toString()], "the folder's services restart after a verified install");
  // An empty .dist-info that an interrupted pip run left behind does not hide the installed copy.
  const purelib = childProcess.execFileSync(env.python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], { encoding: "utf8" }).trim();
  fs.mkdirSync(path.join(purelib, "robot_companion_backend-0.0.9.dist-info"));
  assert.equal((await environments.inspect(folder)).identity.backend.sha256, manifest.backend.installedFiles.sha256);
  // A second run finds the bundled build and changes nothing.
  state.shown = [];
  assert.equal(await installer.run(folder.uri), true);
  assert.match(state.shown[0].message, /is the bundled build .* Nothing to install\./);
  assert.equal(state.shown.some(item => item.modal), false);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("Update Backend replaces another build of the same version; cancellation and a missing pip are recoverable", { skip: real }, async () => {
  const env = projectVenv("project", { pip: true });
  // Another build of the same version: one changed module, installed the way a user's older copy would be.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backend-other-build-"));
  fs.cpSync(path.join(ROOT, "backend"), path.join(scratch, "backend"), { recursive: true });
  fs.appendFileSync(path.join(scratch, "backend/src/robot_companion_backend/__init__.py"), "# an earlier build\n");
  childProcess.execFileSync(python313, ["-B", path.join(scratch, "backend/scripts/build_dists.py"), path.join(scratch, "backend"), path.join(scratch, "dist")]);
  const otherWheel = path.join(scratch, "dist", manifest.backend.wheel);
  childProcess.execFileSync(env.python, ["-m", "pip", "install", "--no-index", "--no-deps", "-q", "--disable-pip-version-check", otherWheel, path.join(BUNDLE, "debugpy-1.8.22-py2.py3-none-any.whl")]);
  const { folder, environments, installer } = setup(env);
  const old = (await environments.inspect(folder)).identity.backend;
  assert.notEqual(old.sha256, manifest.backend.installedFiles.sha256);
  // Cancelled immediately after confirmation: reported, Retry offered, the environment unchanged.
  state.answers = ["Update Backend"]; state.cancelAfter = 0;
  assert.equal(await installer.run(folder.uri), false);
  const modal = state.shown.find(item => item.modal);
  assert.equal(modal.message, "Update the Robot Companion backend in this Python environment?");
  assert(modal.detail.includes(`Replaces: robot-companion-backend 0.1.0.dev8 (sha256 ${old.sha256.slice(0, 12)}`), modal.detail);
  assert(modal.detail.includes("debugpy 1.8.22") && !modal.detail.includes("Adds: debugpy"), modal.detail);
  const cancelled = state.shown.at(-1);
  assert.match(cancelled.message, /^Robot Companion backend update in .* was cancelled\. Nothing in that environment was changed\.$/);
  assert.deepEqual(cancelled.buttons, ["Retry", "Show Output"]);
  assert.equal((await environments.inspect(folder)).identity.backend.sha256, old.sha256);
  // pip removed from the environment: a failure naming the fix, then Retry after the fix succeeds.
  childProcess.execFileSync(env.python, ["-m", "pip", "uninstall", "-y", "-q", "pip"]);
  state.shown = []; state.cancelAfter = undefined; state.answers = ["Update Backend"];
  assert.equal(await installer.run(folder.uri), false);
  const failed = state.shown.at(-1);
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /^Could not update the Robot Companion backend in .*: pip is not available in .*\. Add pip to that environment .*Retry\. Nothing in that environment was changed\.$/);
  childProcess.execFileSync(env.python, ["-m", "ensurepip"]);
  state.answers = ["Update Backend"];
  assert.equal(await installer.run(folder.uri), true);
  const identity = (await environments.inspect(folder)).identity;
  assert.deepEqual({ sha256: identity.backend.sha256, files: identity.backend.files }, manifest.backend.installedFiles);
  assert.equal(identity.robot, ROBOT);
  fs.rmSync(env.root, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true });
});

test("debugpy is part of readiness: removed, never installed after a cancel, or left as bare files, Install Backend completes it", { skip: real }, async () => {
  const env = projectVenv("project");
  const debugpyWheel = manifest.dependencies[0].wheel;
  // The state a cancel between the two wheels leaves: the bundled backend, no debugpy.
  installBundled(env.python, manifest.backend.wheel);
  const { folder, environments, installer } = setup(env);
  const backend = await environments.backend(folder, "languageBackend");
  assert.equal(backend.refusal, undefined, "the services still start without debugpy");
  assert.match(backend.full, /debugpy, which Python debugging in Robot runs needs, is not installed/);
  state.answers = ["Install Backend"];
  assert.equal(await installer.run(folder.uri), true);
  const modal = state.shown.find(item => item.modal);
  assert(modal.detail.includes("Keeps: robot-companion-backend 0.1.0.dev8 (the bundled build") && modal.detail.includes("Adds: debugpy 1.8.22"), modal.detail);
  assert.equal(pipCommands(installer).length, 1);
  assert(pipCommands(installer)[0].includes(debugpyWheel) && !pipCommands(installer)[0].includes(manifest.backend.wheel), "only debugpy is installed");
  assert.equal((await environments.inspect(folder)).identity.debugpy, "1.8.22");
  // pip uninstall -y debugpy after a complete install: no "Nothing to install".
  childProcess.execFileSync(env.python, ["-m", "pip", "uninstall", "-y", "-q", "debugpy"]);
  state.shown = []; state.answers = ["Install Backend"];
  assert.equal(await installer.run(folder.uri), true);
  assert(!state.shown.some(item => /Nothing to install/.test(item.message)));
  assert.equal((await environments.inspect(folder)).identity.debugpy, "1.8.22");
  // debugpy files without metadata (an interrupted extraction) are replaced by the bundled wheel.
  childProcess.execFileSync(env.python, ["-m", "pip", "uninstall", "-y", "-q", "debugpy"]);
  fs.mkdirSync(path.join(purelibOf(env.python), "debugpy"));
  fs.writeFileSync(path.join(purelibOf(env.python), "debugpy", "__init__.py"), "# partly extracted\n");
  const partial = (await environments.inspect(folder)).identity;
  assert.equal(partial.debugpy, null); assert.equal(partial.debugpyImport, true);
  state.shown = []; state.answers = ["Install Backend"];
  assert.equal(await installer.run(folder.uri), true);
  assert.equal((await environments.inspect(folder)).identity.debugpy, "1.8.22");
  // debugpy installed while the confirmation is open is not reinstalled: nothing is left to install.
  childProcess.execFileSync(env.python, ["-m", "pip", "uninstall", "-y", "-q", "debugpy"]);
  const before = pipCommands(installer).length;
  state.shown = []; state.answers = [() => { installBundled(env.python, debugpyWheel); return "Install Backend"; }];
  assert.equal(await installer.run(folder.uri), true);
  assert.equal(pipCommands(installer).length, before, "no pip run after the plan was derived again");
  assert.match(state.shown.at(-1).message, /is now complete\. Nothing to install\./);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a project's default .venv backend is checked against the bundled build and updated without selecting an interpreter", { skip: real }, async () => {
  const env = projectVenv(".venv");
  // Another build of the same version in the project's .venv, with debugpy, and no interpreter selected.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backend-venv-build-"));
  fs.cpSync(path.join(ROOT, "backend"), path.join(scratch, "backend"), { recursive: true });
  fs.appendFileSync(path.join(scratch, "backend/src/robot_companion_backend/__init__.py"), "# an earlier build\n");
  childProcess.execFileSync(python313, ["-B", path.join(scratch, "backend/scripts/build_dists.py"), path.join(scratch, "backend"), path.join(scratch, "dist")]);
  childProcess.execFileSync(env.python, ["-m", "pip", "install", "--no-index", "--no-deps", "-q", "--disable-pip-version-check",
    path.join(scratch, "dist", manifest.backend.wheel), path.join(BUNDLE, manifest.dependencies[0].wheel)]);
  const { folder, environments, installer } = setup(env, { selected: false });
  const refused = await environments.backend(folder, "languageBackend");
  assert.equal(refused.origin, "default");
  assert.match(refused.refusal, /differs from the build bundled with Robot Companion .* Nothing was started\.$/);
  assert.equal(environments.actions.get(folder.uri.toString()), "update");
  // An older version whose backend executable cannot answer doctor is refused too, with the .venv interpreter named.
  const doctor = venvBackend(env.venv);
  const original = fs.readFileSync(doctor);
  fs.writeFileSync(doctor, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  environments.forget();
  const broken = await environments.backend(folder, "executionBackend");
  assert.match(broken.refusal, /differs from the build bundled/);
  assert(broken.full.includes(venvPython(path.join(env.root, ".venv"))), broken.full);
  fs.writeFileSync(doctor, original, { mode: 0o755 });
  environments.forget();
  state.answers = ["Update Backend"];
  assert.equal(await installer.run(folder.uri), true);
  const modal = state.shown.find(item => item.modal);
  assert(modal.message.startsWith("Update the Robot Companion backend"), modal.message);
  environments.forget();
  const updated = await environments.backend(folder, "languageBackend");
  assert.equal(updated.refusal, undefined, updated.full);
  assert.equal(updated.identity.backend.sha256, manifest.backend.installedFiles.sha256);
  fs.rmSync(env.root, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true });
});

// Uses the backend and universal debugpy carried in the VSIX. Dialogs above are a
// stub; these pip, Python, Robot and debugpy processes are real on both OS layouts.
test("the installed bundled backend and debugpy complete the real mixed Robot/Python suite", { skip: real, timeout: 180000 }, () => {
  const env = projectVenv("bundled-mixed");
  const receipt = path.join(env.root, "mixed-counts.json");
  try {
    installBundled(env.python, manifest.backend.wheel, manifest.dependencies[0].wheel);
    const { buildEnvironment } = require("../native-backend");
    const result = childProcess.spawnSync(env.python, ["-B", path.join(ROOT, "backend/scripts/verify_release.py"),
      "--run-suite", "test_dap_mixed_live.py", "--receipt", receipt],
    { cwd: env.root, encoding: "utf8", timeout: 170000, env: buildEnvironment() });
    const counts = JSON.parse(fs.readFileSync(receipt, "utf8"));
    const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, "bundled-mixed-counts.json"), JSON.stringify({
        platform: process.platform, python: MINOR, robot: ROBOT, wheelSha256: manifest.backend.sha256,
        debugpySha256: manifest.dependencies[0].sha256, exitCode: result.status, counts }, null, 2));
      fs.writeFileSync(path.join(evidence, "bundled-mixed.log"), (result.stdout || "") + (result.stderr || ""));
    }
    assert.equal(result.status, 0, (result.stdout || "") + (result.stderr || ""));
    assert.equal(counts.passed, true);
    assert(counts.run > 0);
    for (const key of ["failures", "errors", "skipped", "expectedFailures", "unexpectedSuccesses"]) assert.equal(counts[key], 0, key);
    assert.equal(counts.run, counts.passedTests);
  } finally { fs.rmSync(env.root, { recursive: true, force: true }); }
});

"use strict";
// The project environment behind native services: which descriptor a folder's
// selected interpreter produces, the precedence of explicit overrides, the
// identity probe (interpreter, Python/RF versions, backend bytes) against the
// real offline native venv, and the refusals that name what would have run.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

// A minimal VS Code surface: configuration, trust and an event emitter.
const state = { trusted: true, folders: [], config: {}, messages: [] };
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
const vscode = {
  EventEmitter,
  workspace: {
    get isTrusted() { return state.trusted; },
    get workspaceFolders() { return state.folders; },
    getConfiguration: (_section, uri) => ({ get: (key, fallback) => {
      const values = state.config[uri.toString()] || {};
      return Object.hasOwn(values, key) ? values[key] : fallback;
    } })
  },
  window: { showErrorMessage: (...args) => { state.messages.push(args); return Promise.resolve(undefined); } },
  commands: { executeCommand: () => Promise.resolve() }
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { ProjectEnvironments, PROBE, parseIdentity, refusal, assess, bundledBackend } = require("../../src/integration/project-environment");
const { backendDescriptor, backendOrigin } = require("../../src/integration/preview-defaults");
const { nativeBackend } = require("../native-backend");
const { RobotEnvironmentController } = require("../../src/features/run/environment");
const { PythonEnvironment } = require("../../src/features/run/python-environment");
Module._load = load;

const folderAt = root => ({ name: path.basename(root), uri: { fsPath: root, toString: () => pathToFileURL(root).href } });
const config = values => ({ get: (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback });
// A stand-in for the Select Robot Environment controller: per-folder interpreter choices.
function controller(choices) {
  const changed = new EventEmitter();
  return { onDidChange: changed.event, fire: event => changed.fire(event), choices,
    interpreter: async uri => choices[uri.toString()] || { source: "none" } };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "Projekt ü $(literal) "));
const rootA = path.join(tmp, "Alpha Projekt"), rootB = path.join(tmp, "Beta");
for (const root of [rootA, rootB]) fs.mkdirSync(root, { recursive: true });
const folderA = folderAt(rootA), folderB = folderAt(rootB);

test("a selected interpreter runs language, debug and discovery as python -m robot_companion_backend", () => {
  const python = path.join(tmp, "env mit Leerzeichen", "bin", "python");
  const language = backendDescriptor(config({}), folderA, "languageBackend", "linux", python);
  const execution = backendDescriptor(config({}), folderA, "executionBackend", "linux", python);
  for (const [service, name] of [[language.services.language, "lsp"], [execution.services.debug, "dap"], [execution.services.discovery, "discovery"]]) {
    assert.equal(service.executable, python);
    assert.deepEqual(service.argv, ["-m", "robot_companion_backend", name]);
  }
  assert.equal(language.id, "robot-companion-native");
  assert.equal(execution.cwd, rootA);
});

test("explicit descriptors and nativeBackendExecutable keep precedence over the selected interpreter", () => {
  const python = "/env/bin/python";
  const robotCode = { id: "robotcode", version: "2.7.0", services: { debug: {} } };
  assert.equal(backendOrigin(config({ executionBackend: robotCode }), "executionBackend", python), "descriptor");
  assert.equal(backendDescriptor(config({ executionBackend: robotCode }), folderA, "executionBackend", "linux", python), robotCode);
  assert.equal(backendOrigin(config({ nativeBackendExecutable: "/x/robot-companion-backend" }), "languageBackend", python), "setting");
  assert.equal(backendDescriptor(config({ nativeBackendExecutable: "/x/robot-companion-backend" }), folderA, "languageBackend", "linux", undefined)
    .services.language.executable, "/x/robot-companion-backend");
  assert.equal(backendOrigin(config({}), "languageBackend", python), "interpreter");
  // No interpreter selected: the .venv backend executable fallback, unchanged.
  assert.equal(backendOrigin(config({}), "languageBackend", undefined), "default");
  assert.deepEqual(backendDescriptor(config({}), folderA, "languageBackend", "win32").services.language,
    { executable: path.join(rootA, ".venv", "Scripts", "robot-companion-backend.exe"), argv: ["lsp"], transport: "stdio" });
});

test("refusals name the interpreter, Python and Robot Framework versions and the backend bytes", () => {
  const base = { python: "3.11.9", executable: "/p/bin/python", robot: "7.3.2", debugpy: "1.8.22" };
  // The bundled build's installed-file digest is the only accepted backend.
  const bundled = bundledBackend().backend.installedFiles;
  const backend = { version: "0.1.0.dev12", sha256: bundled.sha256, files: bundled.files, missing: [], package: "/p/site/robot_companion_backend", shadowedBy: null };
  assert.equal(refusal({ ...base, backend }, "/p/bin/python"), undefined);
  assert.deepEqual(assess({ ...base, backend }, "/p/bin/python"), { state: "ready" });
  // Without debugpy (or with debugpy files but no metadata) the backend is not ready: Install Backend
  // completes it. The services still start, so it is not a refusal.
  const dependency = assess({ ...base, debugpy: null, backend }, "/p/bin/python");
  assert.equal(dependency.state, "dependency"); assert.equal(dependency.action, "install");
  assert.match(dependency.reason, /^debugpy, which Python debugging in Robot runs needs, is not installed \(or has no metadata\) in \/p\/bin\/python/);
  assert.equal(refusal({ ...base, debugpy: null, backend }, "/p/bin/python"), undefined);
  // Same version, other bytes: refused with Update Backend, naming both digests.
  const other = assess({ ...base, backend: { ...backend, sha256: "a".repeat(64), files: 18 } }, "/p/bin/python");
  assert.equal(other.state, "bytes"); assert.equal(other.action, "update");
  assert.equal(other.reason, "The installed robot-companion-backend 0.1.0.dev12 of /p/bin/python (Python 3.11.9, Robot Framework 7.3.2) " +
    `(sha256 aaaaaaaaaaaa, 18 files) differs from the build bundled with Robot Companion (sha256 ${bundled.sha256.slice(0, 12)}, ${bundled.files} files).`);
  assert.deepEqual([assess({ ...base, backend: null }, "/p/bin/python").action, assess({ ...base, backend: { ...backend, version: "0.0.9" } }, "/p/bin/python").action,
    assess({ ...base, backend: { ...backend, missing: ["robot_companion_backend/lsp.py"] } }, "/p/bin/python").action,
    assess({ ...base, backend: { ...backend, shadowedBy: "/w/robot_companion_backend/__init__.py" } }, "/p/bin/python").action], ["install", "update", "update", undefined]);
  // Robot Companion never installs or changes Python or Robot Framework: no install for those environments.
  const unsupported = assess({ ...base, python: "3.12.4", backend: null }, "/p/bin/python");
  assert.equal(unsupported.action, undefined);
  assert.match(unsupported.reason, /^robot-companion-backend is not installed in \/p\/bin\/python \(Python 3\.12\.4, Robot Framework 7\.3\.2\)\. This environment is not a supported runtime: the bundled robot-companion-backend 0\.1\.0\.dev12 supports Python 3\.11 \+ Robot Framework 7\.3\.2 or Python 3\.13 \+ Robot Framework 7\.5, and Robot Companion does not change Python or Robot Framework\.$/);
  assert.equal(assess({ ...base, robot: "7.1", backend }, "/p/bin/python").state, "runtime");
  const noRobot = assess({ ...base, robot: null, backend: null }, "/p/bin/python");
  assert.equal(noRobot.action, undefined);
  assert.match(noRobot.reason, /The backend also needs Robot Framework, which Robot Companion does not install\.$/);
  assert.equal(refusal({ ...base, backend: null }, "/p/bin/python"),
    "robot-companion-backend is not installed in /p/bin/python (Python 3.11.9, Robot Framework 7.3.2).");
  assert.match(refusal({ ...base, backend: { ...backend, version: "0.0.9" } }, "/p/bin/python"),
    new RegExp(`supports robot-companion-backend 0\\.1\\.0\\.dev8; /p/bin/python \\(Python 3\\.11\\.9, Robot Framework 7\\.3\\.2\\) has 0\\.0\\.9 \\(sha256 ${bundled.sha256.slice(0, 12)}, ${bundled.files} files\\)`));
  assert.match(refusal({ ...base, backend: { ...backend, shadowedBy: "/w/robot_companion_backend/__init__.py" } }, "/p/bin/python"), /shadows the installed/);
  assert.match(refusal({ ...base, backend: { ...backend, missing: ["robot_companion_backend/lsp.py"] } }, "/p/bin/python"), /incomplete: robot_companion_backend\/lsp\.py is missing/);
  assert.equal(refusal({ ...base, robot: null, backend }, "/p/bin/python"), "Robot Framework is not installed in /p/bin/python (Python 3.11.9, Robot Framework not installed).");
  assert.equal(parseIdentity({ code: 0, output: "noise\nROBOT_COMPANION_BACKEND:{\"python\":\"3.11.9\",\"executable\":\"/p\"}\n" }).python, "3.11.9");
  assert.equal(parseIdentity({ code: 1, output: "ROBOT_COMPANION_BACKEND:{}" }), undefined);
  assert.equal(parseIdentity({ state: "timedOut", output: "" }), undefined);
});

const native = nativeBackend();
test("the identity probe reports the real interpreter, versions and the installed backend digest", { skip: native.skip }, async () => {
  const python = path.join(path.dirname(native.executable), "python");
  state.folders = [folderA]; state.config = {}; state.trusted = true;
  const environments = new ProjectEnvironments(controller({ [folderA.uri.toString()]: { source: "saved", kind: "python", label: "project", executable: python } }));
  const backend = await environments.backend(folderA, "languageBackend");
  assert.equal(backend.origin, "interpreter");
  assert.equal(backend.refusal, undefined);
  assert.deepEqual(backend.input.services.language.argv, ["-m", "robot_companion_backend", "lsp"]);
  const identity = backend.identity;
  assert.equal(identity.executable, python);
  assert.match(identity.python, /^3\.\d+\.\d+$/);
  assert.match(identity.robot, /^7\./);
  // The digest is reproducible from the installed files alone.
  const lines = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else lines.push(relative);
    }
  };
  walk(identity.backend.package, "robot_companion_backend");
  const hash = crypto.createHash("sha256");
  for (const name of lines.sort()) {
    const file = path.join(identity.backend.package, ...name.split("/").slice(1));
    hash.update(`${name}\0${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}\n`);
  }
  assert.equal(identity.backend.sha256, hash.digest("hex"));
  assert.equal(identity.backend.files, lines.length);
  assert.equal(identity.backend.version, "0.1.0.dev12");
  for (const part of [python, `Python ${identity.python}`, `Robot Framework ${identity.robot}`, identity.backend.sha256, "selected project"]) {
    assert.ok(backend.full.includes(part), `${part} in ${backend.full}`);
  }
  // The backend executable fallback is identified through its doctor report.
  const fallback = new ProjectEnvironments(controller({}));
  state.config = { [folderA.uri.toString()]: { nativeBackendExecutable: native.executable } };
  const configured = await fallback.backend(folderA, "executionBackend");
  assert.equal(configured.origin, "setting");
  assert.equal(configured.identity.executable, python);
  assert.equal(configured.identity.backend.sha256, identity.backend.sha256);
  state.config = {};
});

test("an interpreter without the backend is refused before start, naming it and its versions", async () => {
  const python = fs.existsSync("/usr/local/bin/python3") ? "/usr/local/bin/python3" : undefined;
  if (!python) return;
  state.folders = [folderA]; state.trusted = true; state.config = {};
  const environments = new ProjectEnvironments(controller({ [folderA.uri.toString()]: { source: "saved", kind: "python", label: "system", executable: python } }));
  const backend = await environments.backend(folderA, "executionBackend");
  // Without Robot Framework (or in an unsupported runtime) the refusal also says why no install is offered.
  assert.match(backend.refusal, /^robot-companion-backend is not installed in \/usr\/local\/bin\/python3 \(Python 3\.\d+\.\d+, Robot Framework (not installed|[\d.]+)\)\.( The backend also needs Robot Framework, which Robot Companion does not install\.| This environment is not a supported runtime: [^]+)? Nothing was started\.$/);
  const missing = new ProjectEnvironments(controller({ [folderA.uri.toString()]: { source: "saved", kind: "python", label: "gone", executable: path.join(tmp, "gone", "python") } }));
  assert.match((await missing.backend(folderA, "languageBackend")).refusal, /does not exist or cannot start\. Nothing was started\./);
  // An unavailable Python-extension interpreter never falls back to the .venv backend.
  const extension = new ProjectEnvironments(controller({ [folderA.uri.toString()]: { source: "pythonExtension", kind: "python", label: "Python extension", diagnostic: "Python extension is not installed" } }));
  assert.match((await extension.backend(folderA, "languageBackend")).refusal, /Python extension's interpreter for folder 'Alpha Projekt' is unavailable: Python extension is not installed/);
});

test("Restricted Mode probes nothing and an interpreter change reports only the affected folder", async () => {
  state.folders = [folderA, folderB]; state.config = {};
  const choices = { [folderA.uri.toString()]: { source: "saved", kind: "python", label: "a", executable: "/a/python" },
    [folderB.uri.toString()]: { source: "saved", kind: "python", label: "b", executable: "/b/python" } };
  const control = controller(choices);
  const environments = new ProjectEnvironments(control);
  state.trusted = false;
  await assert.rejects(environments.backend(folderA, "languageBackend"), /trusted workspace/);
  assert.equal(environments.identities.size, 0, "Restricted Mode starts no probe");
  state.trusted = true;
  await environments.backend(folderA, "languageBackend");
  await environments.backend(folderB, "languageBackend");
  const fired = [];
  environments.onDidChange(keys => fired.push([...keys]));
  control.fire({});
  await environments.queue;
  assert.deepEqual(fired, [], "an unrelated change restarts nothing");
  choices[folderA.uri.toString()] = { source: "saved", kind: "python", label: "a2", executable: "/a2/python" };
  control.fire({});
  await environments.queue;
  assert.deepEqual(fired, [[folderA.uri.toString()]]);
  control.fire({ installed: folderB.uri.toString() });
  await environments.queue;
  assert.deepEqual(fired.at(-1), [folderB.uri.toString()]);
  environments.dispose();
});

test("the probe imports nothing from the backend or Robot Framework", () => {
  assert.doesNotMatch(PROBE, /import robot|import robot_companion_backend|__import__/);
  assert.match(PROBE, /find_spec\('robot_companion_backend'\)/);
});


test("reselecting the same saved follow choice restarts refused services after Python becomes available", async () => {
  state.folders = [folderA]; state.trusted = true; state.config = {};
  const selection = { version: 1, kind: "pythonExtension" };
  let saved = { [folderA.uri.toString()]: selection }, warm = false;
  const changed = new EventEmitter();
  const control = Object.create(RobotEnvironmentController.prototype);
  Object.assign(control, {
    version: 0, statusGeneration: 0, disposed: false, trusted: () => true,
    context: { workspaceState: { get: () => saved, update: async (_key, value) => { saved = value; } } },
    scope: () => folderA.uri.toString(), changed, onDidChange: changed.event,
    pool: { invalidate() {} }, refreshStatus: async () => {}, resolve: async () => ({})
  });
  const python = "/env/python311_robot7/bin/python";
  control.python = new PythonEnvironment({ extensions: { getExtension: () => ({ activate: async () => ({
    ready: warm ? Promise.resolve() : new Promise(() => {}),
    environments: {
      getActiveEnvironmentPath: () => ({ path: python }),
      resolveEnvironment: async () => ({ executable: { uri: { scheme: "file", fsPath: python } } }),
      onDidChangeActiveEnvironmentPath: () => ({ dispose() {} })
    }
  }) }) } }, () => true, () => {}, { readinessMs: 30 });
  const environments = new ProjectEnvironments(control);
  try {
    const refused = await environments.backend(folderA, "languageBackend");
    assert.match(refused.refusal, /Python extension.*unavailable.*readiness: timed out/);
    const restarted = [];
    environments.onDidChange(keys => restarted.push([...keys]));
    warm = true;
    await control.save(folderA.uri, selection);
    await environments.queue;
    assert.deepEqual(saved[folderA.uri.toString()], selection, "the successful click retains follow semantics, not a pinned path");
    assert.deepEqual(restarted, [[folderA.uri.toString()]], "real save/invalidate/reconcile requests a restart for the refused folder");
    assert.equal((await control.interpreter(folderA.uri)).executable, python);
  } finally { control.python.dispose(); environments.dispose(); changed.dispose(); }
});

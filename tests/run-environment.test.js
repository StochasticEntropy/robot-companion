"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const core = require("../src/features/run/environment-core");
const { execute, parseProbe, ProbePool, bounded } = require("../src/features/run/environment-process");
const { PythonEnvironment } = require("../src/features/run/python-environment");
const config = (inspection, value = "robot") => ({ inspect: () => inspection, get: () => value });
const selected = { version: 1, kind: "python", path: "/space ü $(literal);/python", label: "Prüfung" };
const target = { kind: "python", executable: "python", args: ["-m", "robot"] };
const ok = { code: 0, output: 'noise\nROBOT_COMPANION_ENV:{"python":"3.13.7","robot":"7.3.2","missing":false}\n' };
function childFixture(result = ok, delay = 1, track = {}) {
  return (executable, args, options) => {
    track.calls ||= []; track.calls.push({ executable, args, options }); track.active = (track.active || 0) + 1; track.max = Math.max(track.max || 0, track.active);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    let finished = false;
    function close(code) { if (finished) return; finished = true; track.active--; child.exitCode = code; child.emit("close", code); }
    child.kill = () => { track.kills = (track.kills || 0) + 1; close(1); };
    if (delay !== Infinity) setTimeout(() => { child.stdout.emit("data", Buffer.from(result.output || "")); close(result.code); }, delay);
    return child;
  };
}
test("explicit User, Workspace and Folder settings, including robot, override saved selections", () => {
  for (const field of ["globalValue", "workspaceValue", "workspaceFolderValue"]) assert.equal(core.effectiveTarget(config({ [field]: "robot" }), selected).source, "setting");
  assert.equal(core.settingScope({ globalValue: "a", workspaceValue: "b", workspaceFolderValue: "c" }), "Workspace Folder");
});
test("invalid explicit settings remain errors rather than falling back", () => {
  for (const value of ["", '"unclosed']) assert.throws(() => core.effectiveTarget(config({ workspaceValue: value }, value), selected));
});
test("default remains PATH and Python selection is an exact literal executable", () => {
  assert.equal(core.effectiveTarget(config({})).executable, "robot");
  const resolved = core.effectiveTarget(config({}), selected);
  assert.equal(resolved.executable, selected.path); assert.deepEqual(resolved.args, ["-m", "robot"]);
  assert.equal(core.selectionTarget({ version: 1, kind: "pythonExtension" }).source, "pythonExtension");
});
test("POSIX/Windows construction and path validation (Windows simulated)", () => {
  assert.equal(core.interpreterPath("/tmp/Prüfung env", "linux"), "/tmp/Prüfung env/bin/python");
  assert.equal(core.interpreterPath("C:\\Prüfung env", "win32"), "C:\\Prüfung env\\Scripts\\python.exe");
  assert.equal(core.pathError(selected.path), undefined);
  for (const p of ["python -m robot", '"/tmp/python"', "", "/a\0b"]) assert(core.pathError(p));
  assert(core.pathError("C:\\a.cmd", "win32"));
});
test("probe distinguishes available, absent module, bad imports, malformed/nonzero", () => {
  assert.equal(parseProbe(target, ok).state, "available");
  assert.equal(parseProbe(target, { code: 0, output: 'ROBOT_COMPANION_ENV:{"python":"3.13","robot":null,"missing":true}' }).state, "missingRobot");
  for (const r of [{ code: 1, output: ok.output }, { code: 0, output: "bad" }, { code: 0, output: 'ROBOT_COMPANION_ENV:{"python":3,"robot":null}' }]) assert.equal(parseProbe(target, r).state, "checkFailed");
});
test("executable probe requires recognizable version with 0/251, never arbitrary success", () => {
  for (const code of [0, 251]) assert.equal(parseProbe({ kind: "executable" }, { code, output: "Robot Framework 7.3.2 (Python 3.13)" }).state, "available");
  assert.equal(parseProbe({ kind: "executable" }, { code: 1, output: "Robot Framework 7.3.2" }).state, "checkFailed");
  assert.equal(parseProbe({ kind: "executable" }, { code: 0, output: "hello" }).state, "checkFailed");
});
test("Restricted Mode execution guard starts zero children", async () => {
  const track = {};
  assert.equal((await execute(target, [], "/tmp", () => false, { spawn: childFixture(ok, 1, track) })).state, "cancelled");
  assert.equal(track.calls, undefined);
});
test("owned probe process has timeout, output cap and shell:false", async () => {
  const track = {};
  assert.equal((await execute(target, [], "/tmp", () => true, { spawn: childFixture(ok, Infinity, track), timeout: 15 })).state, "timedOut");
  assert(track.kills); assert.equal(track.calls[0].options.shell, false);
  assert.equal((await execute(target, [], "/tmp", () => true, { spawn: childFixture({ output: "x".repeat(65537) }) })).state, "checkFailed");
});
test("probe pool globally caps two, deduplicates, caches, bounds eight candidates", async () => {
  const track = {}, pool = new ProbePool(() => true, { spawn: childFixture(ok, 20, track) });
  const first = pool.probe(target, "/tmp"); assert.equal(pool.probe(target, "/tmp"), first);
  const jobs = Array.from({ length: 8 }, (_, i) => pool.probe({ ...target, executable: `p${i}` }, "/tmp"));
  await Promise.all([first, ...jobs]); assert.equal(track.max, 2); assert.equal(track.calls.length, 8);
  await pool.probe(target, "/tmp"); assert.equal(track.calls.length, 8);
  pool.invalidate(); await pool.probe(target, "/tmp"); assert.equal(track.calls.length, 9);
});
test("invalidation cancels running and queued probes and ignores late success", async () => {
  const track = {}, pool = new ProbePool(() => true, { spawn: childFixture(ok, Infinity, track) });
  const jobs = Array.from({ length: 8 }, (_, i) => pool.probe({ ...target, executable: `p${i}` }, "/tmp"));
  pool.invalidate(); assert((await Promise.all(jobs)).every(r => r.state === "cancelled")); assert.equal(track.calls.length, 2);
});
test("API/stat logical timeout settles", async () => { await assert.rejects(bounded(new Promise(() => {}), 10), /Timed out/); });
function providerFixture(overrides = {}) {
  let listener, active = "A", activated = 0;
  const api = { getActiveEnvironmentPath: uri => ({ path: active, resource: uri }), resolveEnvironment: async value => ({ executable: { uri: { scheme: "file", fsPath: `/env/${value.path}/python` } } }), onDidChangeActiveEnvironmentPath: fn => { listener = fn; return { dispose() { listener = undefined; } }; }, ...overrides };
  const extension = { activate: async () => { activated++; return { environments: api }; } };
  return { extension, get activated() { return activated; }, change(value) { active = value; listener?.(); } };
}
test("synthetic public Python provider follows changes, disposes and reacquires", async () => {
  const p = providerFixture(); let changes = 0;
  const adapter = new PythonEnvironment({ extensions: { getExtension: () => p.extension } }, () => true, () => changes++);
  assert.equal((await adapter.resolve("file:///A.robot")).executable, "/env/A/python");
  p.change("B"); assert.equal(changes, 1); assert.equal((await adapter.resolve("file:///A.robot")).executable, "/env/B/python");
  assert.equal(p.activated, 1); adapter.reset(); await adapter.resolve("file:///A.robot"); assert.equal(p.activated, 2); adapter.dispose();
});
test("Python provider absent, rejected, unsupported API and nonlocal executable fail closed", async () => {
  for (const extension of [undefined, { activate: async () => { throw new Error("activation failure"); } }, { activate: async () => ({}) }, providerFixture({ resolveEnvironment: async () => ({ executable: { uri: { scheme: "remote", fsPath: "/python" } } }) }).extension]) {
    const adapter = new PythonEnvironment({ extensions: { getExtension: () => extension } }, () => true, () => {});
    const result = await adapter.resolve("file:///a.robot"); assert.equal(result.availability.state, "unavailable"); assert.equal(result.executable, undefined); adapter.dispose();
  }
});
test("Python provider never activates/calls in Restricted Mode or after trust loss", async () => {
  const p = providerFixture(); const vscode = { extensions: { getExtension: () => p.extension } };
  const adapter = new PythonEnvironment(vscode, () => false, () => {}); await adapter.resolve("x"); assert.equal(p.activated, 0);
  let trusted = true, calls = 0;
  vscode.extensions.getExtension = () => ({ activate: async () => { trusted = false; return { environments: { getActiveEnvironmentPath() { calls++; } } }; } });
  const race = new PythonEnvironment(vscode, () => trusted, () => {}); assert.equal((await race.resolve("x")).availability.state, "unavailable"); assert.equal(calls, 0);
});
test("late API activation cannot publish after reset", async () => {
  let complete; const p = providerFixture();
  p.extension.activate = () => new Promise(resolve => { complete = resolve; });
  const adapter = new PythonEnvironment({ extensions: { getExtension: () => p.extension } }, () => true, () => {});
  const pending = adapter.resolve("file:///a.robot"); adapter.reset(); complete({ environments: {} });
  assert.equal((await pending).availability.state, "unavailable");
});
test("ready timeout reports unavailable (synthetic provider, not genuine integration)", async () => {
  const adapter = new PythonEnvironment({ extensions: { getExtension: () => ({ activate: async () => ({ ready: new Promise(() => {}) }) }) } }, () => true, () => {});
  assert.equal((await adapter.resolve("x")).availability.state, "unavailable"); adapter.dispose();
});
test("live POSIX child preserves spaces, Unicode and shell-looking argv without side effects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-env-"));
  try {
    const executable = path.join(dir, "Prüfung $(literal); python"); fs.symlinkSync(process.execPath, executable);
    const literal = "$(touch sentinel); Prüfung";
    const result = await execute({ executable }, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal], dir, () => true);
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.output), [literal]); assert.equal(fs.existsSync(path.join(dir, "sentinel")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Drive controller boundaries without a VS Code host, while keeping process execution real.
const Module = require("module");
const originalLoad = Module._load;
const fakeVscode = { window: {}, workspace: {}, commands: {}, QuickInputButtons: { Back: {} }, ProgressLocation: { Notification: 1 } };
class TokenSource {
  constructor() { const events = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested(fn) { events.on("cancel", fn); return { dispose() { events.off("cancel", fn); } }; } }; this.events = events; }
  cancel() { this.token.isCancellationRequested = true; this.events.emit("cancel"); }
  dispose() {}
}
fakeVscode.CancellationTokenSource = TokenSource;
Module._load = function (name, ...args) { return name === "vscode" ? fakeVscode : originalLoad.call(this, name, ...args); };
const { RobotEnvironmentController } = require("../src/features/run/environment");
Module._load = originalLoad;
function controllerFixture() {
  const controller = Object.create(RobotEnvironmentController.prototype);
  controller.version = 1; controller.disposed = false; controller.trusted = () => true;
  controller.scope = uri => uri?.scope || "A"; controller.cwd = () => os.tmpdir();
  controller.pool = { invalidate() {} }; controller.runner = { showOutput() {}, _getChannel: () => ({ append() {} }) };
  controller.invalidate = () => { controller.version++; };
  fakeVscode.window.activeTextEditor = { document: { uri: { scope: "A", scheme: "file", fsPath: "/A/sample.robot", toString: () => "file:///A/sample.robot" } } };
  fakeVscode.window.showInformationMessage = async () => undefined;
  fakeVscode.window.showErrorMessage = async () => undefined;
  fakeVscode.window.withProgress = (_, fn) => fn({}, new TokenSource().token);
  return controller;
}
test("workspaceState URI map persists choices independently with no global fallback", async () => {
  const c = controllerFixture(); let map = {};
  c.context = { workspaceState: { get: () => JSON.parse(JSON.stringify(map)), update: async (_, value) => { map = JSON.parse(JSON.stringify(value)); } } };
  c.resolve = async () => ({});
  await c.save({ scope: "file:///one/Same" }, selected);
  await c.save({ scope: "file:///two/Same" }, { version: 1, kind: "pathRobot" });
  assert.deepEqual(c.saved({ scope: "file:///one/Same" }), selected); assert.equal(c.saved({ scope: "file:///two/Same" }).kind, "pathRobot"); assert.equal(c.saved({ scope: "file:///three/Same" }), undefined);
  c.context.workspaceState.update = async () => { throw new Error("disk full"); };
  await assert.rejects(c.save({ scope: "x" }, selected), /disk full/); assert.equal(c.saved({ scope: "x" }), undefined);
});
test("install Cancel, trust loss, changed selection and active run start no process", async () => {
  for (const scenario of ["cancel", "trust", "selection", "busy"]) {
    const c = controllerFixture(), t = { ...target, executable: "/does/not/exist", source: "saved", availability: { state: "missingRobot" } };
    c.resolve = async () => t;
    fakeVscode.window.showWarningMessage = async () => {
      if (scenario === "trust") c.trusted = () => false;
      if (scenario === "selection") c.version++;
      if (scenario === "busy") c.runner._activeRun = {};
      return scenario === "cancel" ? undefined : "Install robotframework";
    };
    // A later path access would throw if any rejection guard were skipped.
    c.validatePath = async () => { throw new Error("must not access target"); };
    assert.equal(await c.install({ scope: "A" }, t), false);
  }
});
test("confirmed fixture install uses exact Python pip argv and refreshes only on success", async () => {
  for (const mode of ["missing", "installFailed"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-confirm-install-"));
    try {
      const executable = path.join(dir, "Prüfung $(literal); python");
      fs.writeFileSync(executable, fs.readFileSync(path.join(__dirname, "fixtures/environment/synthetic-python.js"), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "mode"), mode);
      const c = controllerFixture(), t = { ...target, executable, source: "saved", availability: { state: "missingRobot" } };
      c.resolve = async (_, check) => check ? { ...t, availability: { state: fs.readFileSync(path.join(dir, "mode"), "utf8") === "healthy" ? "available" : "missingRobot" } } : t;
      fakeVscode.window.showWarningMessage = async (message, options) => { assert(options.modal); assert(options.detail.includes(executable)); assert(options.detail.includes("-m pip install robotframework")); return "Install robotframework"; };
      assert.equal(await c.install({ scope: "A" }, t), mode === "missing");
      const call = JSON.parse(fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim()); assert.equal(call.executable, executable); assert.deepEqual(call.argv, ["-m", "pip", "install", "robotframework"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
test("picker is shown synchronously before candidate/API work, Escape commits nothing", async () => {
  const c = controllerFixture(), events = new EventEmitter(); let shown = false, discoveryStarted = false, writes = 0;
  fakeVscode.workspace.getWorkspaceFolder = () => ({ name: "A" });
  fakeVscode.window.createQuickPick = () => ({
    items: [], activeItems: [],
    onDidHide(fn) { events.on("hide", fn); return { dispose() { events.off("hide", fn); } }; },
    onDidAccept() { return { dispose() {} }; },
    show() { shown = true; }, hide() { events.emit("hide"); }, dispose() {}
  });
  fakeVscode.commands.executeCommand = async () => {};
  c.refreshStatus = async () => {};
  c.save = async () => { writes++; };
  c.candidates = async () => { assert(shown); discoveryStarted = true; return new Promise(() => {}); };
  const start = performance.now(); const promise = c.pick(); assert(shown); assert(discoveryStarted); assert(performance.now() - start < 250);
  events.emit("hide"); await promise; assert.equal(writes, 0);
});

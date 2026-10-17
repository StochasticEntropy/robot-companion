"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const cp = require("child_process");
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
  // Installation streams pip output without the probe cap.
  assert.deepStrictEqual((await execute(target, [], "/tmp", () => true, { spawn: childFixture({ code: 0, output: "x".repeat(65537) }), outputLimit: Infinity })).code, 0);
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
const { RobotTestRunner, getLastRunNotificationForTest } = require("../src/features/run/index").__test__;
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

// A child that ignores SIGTERM (as a busy pip or a hung interpreter can) and exits only on the listed signals.
function stubbornFixture(track, obeys = ["SIGKILL"]) {
  return () => {
    track.spawned = (track.spawned || 0) + 1; track.active = (track.active || 0) + 1; track.max = Math.max(track.max || 0, track.active);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.signals = [];
    let gone = false;
    child.exit = () => { if (gone) return; gone = true; track.active--; child.emit("exit", null); child.emit("close", null); };
    child.kill = (signal = "SIGTERM") => { child.signals.push(signal); if (obeys.includes(signal)) child.exit(); return true; };
    (track.children ||= []).push(child);
    return child;
  };
}
const flush = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
test("a stopped child is settled only after it exits or the release deadline passes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const scenario of ["cancel", "timeout", "unkillable"]) {
    const track = {}, source = new TokenSource(); let settled;
    const options = { spawn: stubbornFixture(track, scenario === "unkillable" ? [] : ["SIGKILL"]), timeout: 1000, token: source.token };
    void execute(target, [], "/tmp", () => true, options).then(result => { settled = result; });
    if (scenario === "cancel") source.cancel(); else t.mock.timers.tick(1000);
    await flush(); assert.equal(settled, undefined); assert.deepEqual(track.children[0].signals, ["SIGTERM"]);
    t.mock.timers.tick(249); await flush(); assert.equal(settled, undefined, `${scenario}: settled before the forced kill`);
    t.mock.timers.tick(1); await flush(); assert.deepEqual(track.children[0].signals, ["SIGTERM", "SIGKILL"]);
    if (scenario === "unkillable") {
      t.mock.timers.tick(1749); await flush(); assert.equal(settled, undefined, "settled before the release deadline");
      t.mock.timers.tick(1); await flush();
    }
    assert.equal(settled?.state, scenario === "cancel" ? "cancelled" : "timedOut", scenario);
  }
});
test("after install cancel or timeout a run cannot claim until pip has exited or the release deadline passed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realSpawn = cp.spawn;
  try {
    for (const scenario of ["cancel", "timeout", "unkillable"]) {
      const track = {}; cp.spawn = stubbornFixture(track, scenario === "unkillable" ? [] : ["SIGKILL"]);
      const c = controllerFixture(), t2 = { ...target, executable: "/env/Prüfung/python", source: "saved", availability: { state: "missingRobot" } };
      c.resolve = async () => t2; c.validatePath = async () => undefined;
      fakeVscode.window.showWarningMessage = async () => "Install robotframework";
      const runner = new RobotTestRunner({}); runner.environment = c;
      runner._runClaimed = async () => ({ status: "claimed" });
      const uri = { scheme: "file", fsPath: "/A/sample.robot" };
      let installed;
      void c.install({ scope: "A" }, t2).then(value => { installed = value; });
      for (let i = 0; !track.spawned && i < 50; i++) await flush(1);
      assert.equal(track.spawned, 1);
      // The busy notice names the installation, never a suite.
      assert.equal((await runner.run(uri)).status, "busy");
      assert.equal(getLastRunNotificationForTest().message, "robotframework is being installed in /env/Prüfung/python. Wait for the installation to finish before starting a run.");
      if (scenario === "cancel") c.installCancellation.cancel(); else t.mock.timers.tick(120000);
      await flush(); assert.equal((await runner.run(uri)).status, "busy", `${scenario}: run claimed while pip was exiting`);
      t.mock.timers.tick(249); await flush(); assert.equal((await runner.run(uri)).status, "busy", `${scenario}: run claimed before the forced kill`);
      t.mock.timers.tick(1); await flush();
      if (scenario === "unkillable") {
        assert.equal((await runner.run(uri)).status, "busy", "run claimed before the release deadline");
        t.mock.timers.tick(1749); await flush(); assert.equal((await runner.run(uri)).status, "busy");
        t.mock.timers.tick(1); await flush();
      } else assert.equal(track.active, 0);
      assert.equal(installed, false); assert.equal(c.installing, undefined);
      assert.equal((await runner.run(uri)).status, "claimed", scenario);
    }
  } finally { cp.spawn = realSpawn; }
});
test("live probe children never exceed two while invalidated probes are still exiting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const track = {}, pool = new ProbePool(() => true, { spawn: stubbornFixture(track) });
  const first = Array.from({ length: 4 }, (_, i) => pool.probe({ ...target, executable: `old${i}` }, "/tmp"));
  await flush(); assert.equal(track.spawned, 2);
  pool.invalidate();
  const second = Array.from({ length: 4 }, (_, i) => pool.probe({ ...target, executable: `new${i}` }, "/tmp"));
  await flush(); assert.equal(track.spawned, 2, "a new probe started while invalidated children were still running"); assert.equal(track.active, 2);
  t.mock.timers.tick(250); await flush();
  assert(track.children.slice(0, 2).every(child => child.signals.join() === "SIGTERM,SIGKILL"));
  assert.equal(track.spawned, 4); assert.equal(track.max, 2);
  assert((await Promise.all(first)).every(r => r.state === "cancelled"));
  for (const child of track.children.slice(2)) child.stdout.emit("data", Buffer.from(ok.output)), child.exit();
  await flush(); assert.equal(track.spawned, 6); assert.equal(track.max, 2);
  for (const child of track.children.slice(4)) child.stdout.emit("data", Buffer.from(ok.output)), child.exit();
  await flush(); assert.equal(track.max, 2); assert.equal(track.spawned, 6);
  assert.equal((await Promise.all(second)).length, 4);
});
test("probes still exiting after invalidation do not use up the eight candidate places", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const track = {}, pool = new ProbePool(() => true, { spawn: stubbornFixture(track) });
  void Promise.all(Array.from({ length: 2 }, (_, i) => pool.probe({ ...target, executable: `old${i}` }, "/tmp")));
  await flush(); pool.invalidate();
  const refreshed = Array.from({ length: 8 }, (_, i) => pool.probe({ ...target, executable: `new${i}` }, "/tmp"));
  t.mock.timers.tick(250); await flush();
  for (let round = 0; round < 4; round++) { for (const child of track.children.filter(c => c.signals.length === 0)) child.stdout.emit("data", Buffer.from(ok.output)), child.exit(); await flush(); }
  for (const child of track.children.slice(2)) assert.equal(child.signals.length, 0);
  assert(!(await Promise.all(refreshed)).some(r => r.diagnostic === "Candidate limit")); assert.equal(track.spawned, 10); assert.equal(track.max, 2);
});

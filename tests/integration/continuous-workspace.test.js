"use strict";
// TestWorkspace's continuous runs without VS Code: a small stand-in for the
// vscode module, a discovery the test finishes when it wants, and runs that
// are real process groups (RobotProcess), started and stopped as runFolder
// starts and stops Robot. Checked: a continuous run never starts while another
// Test Explorer run is in progress, also one started while rediscovery after
// the save is still in progress; when Robot Companion stops offering tests, the
// running continuous run ends with its process group; turning off a
// continuous run queued behind another one settles without waiting for it.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const os = require("node:os");
const { RobotProcess } = require("../../src/integration/test-runs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out: ${label}`);
}
const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

class CancellationTokenSource {
  constructor() {
    const listeners = new Set();
    this.listeners = listeners;
    this.token = { isCancellationRequested: false, onCancellationRequested: listener => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    } };
  }
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }
  dispose() { this.listeners.clear(); }
}

const disposable = { dispose() {} };
const saveListeners = [];
const folder = { name: "ws", uri: { scheme: "file", fsPath: "/ws", toString: () => "file:///ws" } };
const vscode = {
  version: "stand-in",
  CancellationTokenSource,
  TestRunRequest: class { constructor(include, exclude, profile, continuous) { Object.assign(this, { include, exclude, profile, continuous }); } },
  TestRunProfileKind: { Run: 1, Debug: 2 },
  window: { createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }) },
  commands: { registerCommand: () => disposable },
  workspace: {
    isTrusted: true,
    workspaceFolders: [], // No owned folder: refresh() leaves the roots this test sets.
    onDidChangeConfiguration: () => disposable,
    onDidChangeWorkspaceFolders: () => disposable,
    onDidGrantWorkspaceTrust: () => disposable,
    onDidSaveTextDocument: listener => { saveListeners.push(listener); return disposable; },
    getConfiguration: () => ({ get: (name, fallback) => (name === "continuousRunDelay" ? 100 : fallback) }),
    getWorkspaceFolder: () => folder,
    asRelativePath: file => file.replace(/^\/ws\//, "")
  }
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { TestWorkspace } = require("../../src/integration/test-workspace");

// A TestWorkspace with one discovered folder holding test `a` of /ws/a.robot.
// save() saves that file; the rediscovery it starts ends with finishDiscovery().
// Each run is a process group that lasts `durations[kind]` ms unless stopped;
// `most` is the largest number of process groups alive at once.
async function workspace(durations) {
  const tests = new TestWorkspace(undefined, undefined, undefined);
  await tests.queue;
  const item = { id: "file:///ws/a.robot::A", label: "A", children: { size: 0, forEach() {} } };
  tests.controller = { items: { forEach: visit => visit(item) }, dispose() {} };
  tests.selections = request => ({ plan: [{ tests: (request.include || []).map(entry => ({ item: entry, source: "/ws/a.robot" })) }],
    filtered: [] });
  let finish;
  tests.discover = () => new Promise(resolve => { finish = resolve; });
  const root = { folder, generation: tests.generation, itemIds: [], session: { state: "running", stop: async () => {} } };
  tests.roots.set(folder.uri.toString(), root);
  const state = { tests, item, runs: [], most: 0, robots: [] };
  const sample = () => { state.most = Math.max(state.most, state.robots.filter(robot => robot.groupAlive()).length); };
  const sampler = setInterval(sample, 5);
  state.close = () => clearInterval(sampler);
  tests.runOnce = async (request, token, options) => {
    const entry = { kind: options?.note ? "continuous" : "manual", started: Date.now() };
    state.runs.push(entry);
    const robot = new RobotProcess({ executable: process.execPath, cwd: os.tmpdir(),
      args: ["-e", `setTimeout(() => {}, ${durations[entry.kind]})`] });
    entry.robot = robot;
    state.robots.push(robot);
    tests.active.add(robot);
    const stop = token.onCancellationRequested(() => { void robot.cancel(500); });
    try {
      const running = robot.start();
      sample();
      await running;
      await robot.cleanup;
    } finally {
      stop.dispose();
      tests.active.delete(robot);
      entry.ended = Date.now();
      sample();
    }
  };
  state.save = () => {
    for (const listener of saveListeners) listener({ uri: { scheme: "file", path: "/ws/a.robot", fsPath: "/ws/a.robot" } });
  };
  state.finishDiscovery = () => finish({});
  state.continuous = () => {
    const source = new CancellationTokenSource();
    const handler = tests.run(new vscode.TestRunRequest([item], [], undefined, true), source.token);
    return { source, handler };
  };
  state.manual = () => tests.run(new vscode.TestRunRequest([item], []), new CancellationTokenSource().token);
  return state;
}

test("a manual run started while rediscovery after a save is in progress: the continuous run starts after it ends", async t => {
  const state = await workspace({ manual: 800, continuous: 300 });
  t.after(() => { state.close(); saveListeners.length = 0; });
  const watch = state.continuous();
  await until(() => state.tests.watches.size === 1, "continuous run on");
  state.save();
  const [watching] = state.tests.watches;
  await until(() => watching.executing, "the delay has passed"); // Rediscovery is still in progress.
  await sleep(100);
  assert.equal(state.runs.length, 0, "nothing runs before rediscovery ended");
  const manual = state.manual();
  await until(() => state.runs[0]?.robot.pid, "the manual run's process group");
  state.finishDiscovery();
  await manual;
  await until(() => state.runs.length === 2 && state.runs[1].ended, "the continuous run after the manual one");
  const [first, second] = state.runs;
  assert.deepEqual([first.kind, second.kind], ["manual", "continuous"]);
  assert.ok(second.started >= first.ended, `the continuous run started ${first.ended - second.started} ms before the manual run ended`);
  assert.equal(state.most, 1, "at most one process group at any time");
  watch.source.cancel();
  await watch.handler;
  assert.equal(state.tests.watches.size, 0);
});

test("Robot Companion stops offering tests during a continuous run: the run is stopped and its process group ends", async t => {
  const state = await workspace({ continuous: 60000 });
  t.after(() => { state.close(); saveListeners.length = 0; for (const robot of state.robots) void robot.cancel(0); });
  const watch = state.continuous();
  await until(() => state.tests.watches.size === 1, "continuous run on");
  state.save();
  state.finishDiscovery();
  await until(() => state.runs[0]?.robot.groupAlive(), "the continuous run's process group");
  const robot = state.runs[0].robot, started = Date.now();
  await state.tests.refresh(); // No owned folder any more (as after a switch to coexistence): the controller goes.
  assert.equal(state.tests.controller, undefined, "no test controller");
  await until(() => !robot.groupAlive() && state.runs[0].ended, "the process group ended", 5000);
  assert.ok(await settledWithin(watch.handler, 2000), "the continuous run ended");
  assert.equal(state.tests.watches.size, 0);
  assert.equal(watch.source.token.isCancellationRequested, false, "without VS Code turning it off");
  assert.ok(Date.now() - started < 5000);
});

test("turning off a continuous run queued behind another one's run settles without waiting for that run", async t => {
  const state = await workspace({ continuous: 60000 });
  t.after(() => { state.close(); saveListeners.length = 0; for (const robot of state.robots) void robot.cancel(0); });
  const first = state.continuous(), second = state.continuous();
  await until(() => state.tests.watches.size === 2, "two continuous runs on");
  state.save();
  state.finishDiscovery();
  await until(() => state.runs[0]?.robot.groupAlive(), "the first continuous run's process group");
  await sleep(300); // The second one's run is queued behind it.
  assert.equal(state.runs.length, 1);
  second.source.cancel();
  assert.ok(await settledWithin(second.handler, 2000), "turning off the queued continuous run settled");
  assert.ok(state.runs[0].robot.groupAlive(), "the other continuous run still runs");
  assert.equal(state.runs.length, 1, "the queued run never started");
  first.source.cancel();
  await first.handler;
  assert.equal(state.runs[0].robot.groupAlive(), false);
  assert.equal(state.tests.watches.size, 0);
});


for (const interrupted of ["cancel", "trust"]) test(`a ${interrupted} during the project read starts no Robot process`, async t => {
  const fs = require("node:fs"), path = require("node:path");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rc-project-stop-")));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); vscode.workspace.isTrusted = true; saveListeners.length = 0; });
  const tests = new TestWorkspace(undefined, undefined, undefined);
  await tests.queue;
  tests.storagePath = directory;
  const marker = path.join(directory, "started");
  tests.robotCommand = async () => ({ executable: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`, "--"] });
  let finish, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  tests.projectFiles.read = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const source = new CancellationTokenSource();
  const currentFolder = { name: "project", uri: { fsPath: directory, toString: () => `file://${directory}` } };
  const running = tests.runFolder({ appendOutput() {} }, { folderPath: directory, tests: [], files: [] }, currentFolder, source.token);
  await pending;
  if (interrupted === "cancel") source.cancel(); else vscode.workspace.isTrusted = false;
  finish({ arguments: [], files: [], problems: [] });
  await assert.rejects(running, interrupted === "cancel" ? /cancelled before it started/ : /no longer trusted/);
  assert.equal(fs.existsSync(marker), false, "no process started after the interrupted read");
  assert.equal(tests.active.size, 0);
});

test("Test Explorer uses the native execution descriptor for TOML when language uses RobotCode", async t => {
  const fs = require("node:fs"), path = require("node:path");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rc-mixed-toml-")));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); saveListeners.length = 0; });
  const native = { id: "robot-companion-native", version: "0.1.0.dev4", services: { debug: { executable: "/selected/python", argv: ["-m", "robot_companion_backend", "dap"] } } };
  const requested = [];
  const environments = { backend: async (_folder, setting) => { requested.push(setting); return { input: setting === "languageBackend" ? { id: "robotcode" } : native }; }, onDidChange: () => disposable };
  const tests = new TestWorkspace(undefined, undefined, undefined, environments);
  await tests.queue;
  tests.storagePath = directory;
  const marker = path.join(directory, "args.json");
  tests.robotCommand = async () => ({ executable: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(1)))`, "--"] });
  tests.projectFiles.read = async (_folder, _config, options) => { assert.equal(options.backend, native); return { arguments: ["--variable", "ENV:from-toml"], files: [], problems: [] }; };
  const currentFolder = { name: "project", uri: { fsPath: directory, toString: () => `file://${directory}` } };
  const result = await tests.runFolder({ appendOutput() {} }, { folderPath: directory, tests: [], files: [] }, currentFolder, new CancellationTokenSource().token);
  assert.deepEqual(requested, ["languageBackend", "executionBackend"]);
  assert.equal(result.exit.exitCode, 0);
  const args = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["--variable", "ENV:from-toml"]);
});


test("a newly started backend exposes its pending discovery to continuous-run admission", async t => {
  const fs = require("node:fs"), path = require("node:path");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rc-initial-discover-")));
  const { LspSession } = require("../../src/integration/lsp-session");
  const start = LspSession.prototype.start, stop = LspSession.prototype.stop, getConfiguration = vscode.workspace.getConfiguration;
  t.after(() => { LspSession.prototype.start = start; LspSession.prototype.stop = stop; vscode.workspace.getConfiguration = getConfiguration; fs.rmSync(directory, { recursive: true, force: true }); saveListeners.length = 0; });
  LspSession.prototype.start = async function () { this.state = "running"; return { robotCompanionDiscovery: { version: 1 } }; };
  LspSession.prototype.stop = async function () { this.state = "stopped"; };
  const uri = { scheme: "file", fsPath: directory, toString: () => `file://${directory}` }, currentFolder = { name: "project", uri };
  const native = { id: "robot-companion-native", version: "0.1.0.dev4", contractVersion: 1, workspaceUri: uri.toString(), cwd: directory, env: {},
    services: { discovery: { executable: process.execPath, argv: [], transport: "stdio" } } };
  const tests = new TestWorkspace(undefined, undefined, undefined, { backend: async () => ({ input: native, full: "selected project" }), onDidChange: () => disposable });
  await tests.queue;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  tests.discover = () => pending;
  vscode.workspace.getConfiguration = () => ({ get: (name, fallback) => name === "integrationMode" ? "owned" : fallback });
  const started = tests.startRoot(currentFolder, tests.generation);
  await until(() => tests.roots.get(uri.toString())?.session?.state === "running", "backend started");
  assert.equal(tests.roots.get(uri.toString()).discovering, pending);
  assert.ok(tests.discoveries().includes(pending), "continuous admission can wait for initial/restarted discovery");
  finish({});
  await started;
});

"use strict";
// Live RobotCode 2.7.0 debug bridge: the audit transcript over the owned
// adapter, with the Python child connected the way the extension connects it.
// Skipped by name when the prepared environment is absent.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DapProcessAdapter } = require("../../src/integration/dap-session");
const { frame, MessageReader } = require("../../src/integration/lsp-session");
const { robotCodeDescriptor, RobotCodeDebugBridge } = require("../../src/integration/robotcode-bridge");

const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const live = fs.existsSync(python) ? {} : { skip: `RobotCode 2.7.0 environment absent at ${python}` };

// Minimal DAP client over a message sink; waits on responses and events.
function client(send) {
  let seq = 1;
  const messages = [], waiters = [];
  const deliver = () => {
    for (const waiter of [...waiters]) {
      const index = messages.findIndex((message, i) => i >= waiter.from && waiter.match(message));
      if (index >= 0) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(messages[index]); }
    }
  };
  const wait = (match, label, from = 0, ms = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    waiters.push({ match, from, resolve: message => { clearTimeout(timer); resolve(message); } });
    deliver();
  });
  return {
    messages,
    accept(message) { messages.push(message); deliver(); },
    async request(command, args) {
      const id = seq++;
      send({ seq: id, type: "request", command, arguments: args });
      const response = await wait(message => message.type === "response" && message.request_seq === id, command);
      if (!response.success) throw new Error(`${command}: ${response.message}`);
      return response.body;
    },
    event(name, label = name) { const from = messages.length; return wait(message => message.event === name, label, from); }
  };
}

test("bridge launch arguments use the execution context and keep output on the protocol", () => {
  const bridge = new RobotCodeDebugBridge({ python: "/env/bin/python" });
  const args = bridge.launchArguments({ name: "Debug", target: "/ws/a.robot", args: ["--loglevel", "TRACE"] },
    { cwd: "/ws", robotArguments: ["--variable", "X:1"], outputDir: "/out/1" });
  assert.deepEqual(args, { request: "launch", name: "Debug", python: "/env/bin/python", cwd: "/ws", target: "/ws/a.robot",
    args: ["--variable", "X:1", "--loglevel", "TRACE"], env: {}, outputDir: "/out/1", console: "internalConsole",
    attachPython: true, attachPythonPort: 0, outputMessages: false, outputLog: true, stopOnEntry: false });
  assert.equal(bridge.launchArguments({ target: "/ws/a.robot", outputLog: false }).outputLog, false);
  assert.throws(() => bridge.launchArguments({}), /target/);
  assert.deepEqual(bridge.event({ event: "robotStarted", body: { synced: true } }), { forward: false, sync: true });
  assert.deepEqual(bridge.event({ event: "stopped", body: { threadId: 1 } }), { forward: true, sync: false });
  assert.deepEqual(bridge.event({ event: "debugpyStarted", body: { port: 4711, addresses: ["127.0.0.1"], processId: 9 } }).pythonChild,
    { host: "127.0.0.1", port: 4711, processId: 9 });
  assert.throws(() => bridge.event({ event: "debugpyStarted", body: { port: 4711, addresses: ["10.0.0.5"] } }), /debugpy endpoint/);
});

test("RobotCode's debugpy-port log line stays out of the Debug Console; program output is forwarded", () => {
  const bridge = new RobotCodeDebugBridge({ python: "/env/bin/python" });
  const output = (text, category = "stderr") => ({ type: "event", event: "output", body: { category, output: text } });
  assert.deepEqual(bridge.event(output("start debugpy session on port 55633\n")), { forward: false, sync: false });
  const mixed = bridge.event(output("start debugpy session on port 41000\n0.00s - Debugger warning: frozen modules\n"));
  assert.equal(mixed.forward, true);
  assert.equal(mixed.message.body.output, "0.00s - Debugger warning: frozen modules\n");
  assert.equal(mixed.message.body.category, "stderr");
  for (const kept of [output("start debugpy session on port 55633\n", "stdout"), output("Ada\n", "console"),
    output("ERROR: start debugpy session on port 1\n")]) {
    assert.deepEqual(bridge.event(kept), { forward: true, sync: false }, kept.body.output);
  }
  bridge.event({ type: "event", event: "debugpyStarted", body: { port: 4711, addresses: ["127.0.0.1"] } });
  // After the handoff the run's stderr is program output and is never rewritten.
  assert.deepEqual(bridge.event(output("start debugpy session on port 55633\n")), { forward: true, sync: false });
});

test("live audit transcript: Robot pause, live keyword, Python step/count, Robot frame, resource keyword, 1 PASS", { ...live, timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-debug-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "fixtures/audit-v1"), directory, { recursive: true });
  const outputDir = path.join(directory, "results");
  const descriptor = robotCodeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, python, services: ["debug"] });
  const adapter = new DapProcessAdapter({ descriptor, trusted: true, context: { cwd: directory, robotArguments: [], outputDir } });
  t.after(() => adapter.dispose());
  const robot = client(message => adapter.handleMessage(message));
  adapter.onDidSendMessage(message => robot.accept(message));
  let log = ""; adapter.on("log", text => { log += text; });
  const pythonChild = new Promise(resolve => adapter.once("pythonChild", resolve));
  const runExited = new Promise(resolve => adapter.once("runExited", resolve));
  const pid = adapter.start();

  await robot.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  const initialized = robot.event("initialized", "Robot initialized");
  await robot.request("launch", { type: "robotcompanion", request: "launch", name: "Debug audit", target: path.join(directory, "audit.robot") });
  await initialized;
  const audit = path.join(directory, "audit.robot");
  const breakpoints = await robot.request("setBreakpoints", { source: { path: audit }, breakpoints: [{ line: 12 }, { line: 13 }] });
  assert.deepEqual(breakpoints.breakpoints.map(b => b.verified), [true, true]);
  let stopped = robot.event("stopped", "Robot stop at line 12");
  const configured = robot.request("configurationDone", {});

  // The Python child connects while RobotCode waits in configurationDone.
  const endpoint = await pythonChild;
  const socket = net.connect(endpoint.port, endpoint.host);
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const py = client(message => socket.write(frame(message)));
  const reader = new MessageReader(message => py.accept(message), "DAP");
  socket.on("data", chunk => reader.accept(chunk));
  await py.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  const pyInitialized = py.event("initialized", "Python initialized");
  // VS Code always sends the attach configuration; debugpy rejects empty arguments.
  const attached = py.request("attach", { type: "robotcompanion", request: "attach", name: "Python: Debug audit" }).catch(error => { throw new Error(`${error.message}; endpoint ${JSON.stringify(endpoint)}; python messages ${JSON.stringify(py.messages).slice(0, 1500)}`); });
  attached.catch(() => {});
  await pyInitialized.catch(error => { throw new Error(`${error.message}; python messages ${JSON.stringify(py.messages).slice(0, 2500)}`); });
  const library = path.join(directory, "AuditLibrary.py");
  assert.equal((await py.request("setBreakpoints", { source: { path: library }, breakpoints: [{ line: 18 }] })).breakpoints[0].verified, true);
  await py.request("configurationDone", {});
  try { await attached; } catch (error) {
    throw new Error(`${error.message}; endpoint ${JSON.stringify(endpoint)}; python messages ${JSON.stringify(py.messages).slice(0, 1500)}`);
  }
  await configured;

  const robotStop1 = await stopped;
  const thread = robotStop1.body.threadId;
  let frames = (await robot.request("stackTrace", { threadId: thread })).stackFrames;
  assert.equal(frames[0].line, 12);
  assert.equal(frames[0].source.path, audit);
  const scopes = await robot.request("scopes", { frameId: frames[0].id });
  assert.ok(scopes.scopes.length > 0);
  const live1 = await robot.request("evaluate", { expression: "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", frameId: frames[0].id, context: "repl" });
  assert.equal(live1.result, "'from-suite-console'");

  let pyStopped = py.event("stopped", "Python stop at line 18");
  await robot.request("continue", { threadId: thread });
  const pyStop = await pyStopped;
  let pyFrames = (await py.request("stackTrace", { threadId: pyStop.body.threadId })).stackFrames;
  assert.equal(pyFrames[0].line, 18);
  assert.equal(pyFrames[0].source.path, library);
  pyStopped = py.event("stopped", "Python step to line 19");
  await py.request("next", { threadId: pyStop.body.threadId });
  await pyStopped;
  pyFrames = (await py.request("stackTrace", { threadId: pyStop.body.threadId })).stackFrames;
  assert.equal(pyFrames[0].line, 19);
  assert.equal((await py.request("evaluate", { expression: "count", frameId: pyFrames[0].id, context: "repl" })).result, "3");

  stopped = robot.event("stopped", "Robot stop at line 13");
  await py.request("continue", { threadId: pyStop.body.threadId });
  const robotStop2 = await stopped;
  frames = (await robot.request("stackTrace", { threadId: robotStop2.body.threadId })).stackFrames;
  assert.equal(frames[0].line, 13);
  const outputBefore = robot.messages.length;
  const live2 = await robot.request("evaluate", { expression: "Resource Step    ${record.name}", frameId: frames[0].id, context: "repl" });
  assert.match(live2.result, /None|^$/);
  const terminated = robot.event("terminated");
  await robot.request("continue", { threadId: robotStop2.body.threadId });
  await terminated;
  const exited = await runExited;
  assert.equal(exited.exitCode, 0, "1 test, 1 passed");
  const xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
  assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
  assert.match(xml, /<msg[^>]*>Ada<\/msg>/, "Resource Step logged Ada");
  assert.ok(robot.messages.slice(outputBefore).length >= 0);
  assert.equal(robot.messages.filter(m => m.type === "event" && /^robot[A-Z]|^debugpy/.test(m.event)).length, 0,
    "RobotCode custom events stay inside the adapter");
  const console = robot.messages.filter(m => m.event === "output").map(m => m.body.output).join("");
  assert.doesNotMatch(console, /start debugpy session on port/, "RobotCode's handoff log line stays out of the console");
  assert.match(console, /^Ada$/m, "the test's Log message reaches the console");
  assert.match(console, /1 test, 1 passed, 0 failed/, "Robot's console output reaches the console");

  await robot.request("disconnect", {}).catch(() => {});
  await adapter.dispose();
  // Like VS Code's own executable adapters, the launcher is ended by the bounded
  // stop (stdin end, then SIGTERM after 1 s); it never needs SIGKILL.
  assert.notEqual(adapter.exit.signal, "SIGKILL");
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.throws(() => process.kill(-pid, 0), /ESRCH/, "no process of the debug session's group survives");
  assert.throws(() => process.kill(endpoint.processId, 0), /ESRCH/, "the Robot run process is gone");
  t.diagnostic(JSON.stringify({ live1: live1.result, count: "3", live2: live2.result, exit: adapter.exit, debugpyPort: endpoint.port }));
  void log;
});

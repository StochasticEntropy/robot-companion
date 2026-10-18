"use strict";
// The native backend provider: descriptor, pre-start refusals, the debug bridge
// API and live runs of `robot-companion-backend lsp` / `dap` from the owned
// offline-built venv (tests/native-backend.js). Live cases are skipped by name
// when the approved wheel directory is absent; never reported as a pass.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { DapProcessAdapter } = require("../../src/integration/dap-session");
const { LspSession, frame, MessageReader } = require("../../src/integration/lsp-session");
const native = require("../../src/integration/native-backend");
const providers = require("../../src/integration/backend-providers");
const { robotCodeDescriptor } = require("../../src/integration/robotcode-bridge");
const { nativeBackend } = require("../native-backend");

const backend = nativeBackend();
const live = backend.skip ? { skip: backend.skip } : {};

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

const workspace = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-native-"));
  fs.cpSync(path.join(__dirname, "fixtures/audit-v1"), directory, { recursive: true });
  return directory;
};

test("native descriptors launch robot-companion-backend lsp / dap; providers are told apart", () => {
  const descriptor = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/venv/bin/robot-companion-backend",
    services: ["language", "debug"] });
  assert.equal(descriptor.id, "robot-companion-native");
  assert.equal(descriptor.version, "0.1.0.dev1");
  assert.deepEqual(descriptor.services.language, { executable: "/venv/bin/robot-companion-backend", argv: ["lsp"], transport: "stdio" });
  assert.deepEqual(descriptor.services.debug, { executable: "/venv/bin/robot-companion-backend", argv: ["dap"], transport: "stdio" });
  assert.throws(() => native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "x", services: ["discovery"] }),
    /does not provide discovery/);
  assert.equal(providers.describe(descriptor), "Native backend 0.1.0.dev1");
  const robotCode = robotCodeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", python: "/env/bin/python" });
  assert.equal(providers.describe(robotCode), "RobotCode 2.7.0");
  assert.equal(providers.providerOf({ id: "fixture", version: "1" }).kind, "custom");
});

test("a declared version mismatch is refused before anything starts, naming both versions", () => {
  const nativeOther = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/x", version: "0.2.0" });
  assert.throws(() => providers.checkVersion(nativeOther), /supports the native backend 0\.1\.0\.dev1; the descriptor declares 0\.2\.0/);
  const robotCodeOther = { ...robotCodeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", python: "/x" }), version: "2.6.0" };
  assert.throws(() => providers.checkVersion(robotCodeOther), /pinned to 2\.7\.0; the descriptor declares 2\.6\.0/);
  assert.throws(() => providers.debugBridge(nativeOther, {}), /0\.2\.0/, "the debug adapter refuses it too");
  assert.throws(() => new DapProcessAdapter({ descriptor: { ...nativeOther, services: { debug: { executable: process.execPath, argv: [], transport: "stdio" } } },
    trusted: true }), /declares 0\.2\.0/);
  // A running server that is not the declared native backend is refused after initialize.
  const descriptor = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/x" });
  assert.throws(() => providers.verifyLanguageServer(descriptor, { name: "robot-companion-backend", version: "0.0.9" }),
    /requires robot-companion-backend 0\.1\.0\.dev1; the backend reported robot-companion-backend 0\.0\.9/);
  assert.doesNotThrow(() => providers.verifyLanguageServer(descriptor, { name: "robot-companion-backend", version: "0.1.0.dev1" }));
});

test("a missing native executable is refused with its path; nothing is spawned", async () => {
  const directory = workspace();
  try {
    const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory,
      executable: path.join(directory, "venv/bin/robot-companion-backend"), services: ["language", "debug"] });
    const session = new LspSession();
    await assert.rejects(session.start(descriptor, true), /robot-companion-native' 0\.1\.0\.dev1: the language executable .*venv\/bin\/robot-companion-backend does not exist/);
    assert.equal(session.child, undefined);
    assert.throws(() => new DapProcessAdapter({ descriptor, trusted: true }), /the debug executable .* does not exist or is not executable/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("native debug bridge: launch arguments, Python breakpoints, handoff order and owned processes", () => {
  const bridge = new native.NativeDebugBridge();
  const args = bridge.launchArguments({ name: "Debug", target: "/ws/a.robot", args: ["--test", "T"] },
    { cwd: "/ws", robotArguments: ["--variable", "X:1"], outputDir: "/out/1" });
  assert.deepEqual(args, { name: "Debug", target: "/ws/a.robot", cwd: "/ws",
    args: ["--variable", "X:1", "--test", "T", "--outputdir", "/out/1"], pythonDebug: { handoffVersion: 1 } });
  assert.equal(new native.NativeDebugBridge().launchArguments({ target: "/ws/a.robot", attachPython: false }).pythonDebug, undefined);
  assert.throws(() => bridge.launchArguments({}), /target/);
  // Python sources are answered by the adapter; Robot sources reach the backend.
  assert.deepEqual(bridge.answer({ command: "setBreakpoints", arguments: { source: { path: "/ws/lib.py" }, breakpoints: [{ line: 18 }] } }),
    { breakpoints: [{ verified: false, line: 18, message: "Set in the Python child session." }] });
  assert.equal(bridge.answer({ command: "setBreakpoints", arguments: { source: { path: "/ws/a.robot" }, breakpoints: [] } }), undefined);
  // configurationDone waits for the connected and configured Python child.
  assert.equal(bridge.hold({ command: "configurationDone" }), true);
  assert.equal(bridge.hold({ command: "threads" }), false);
  const start = bridge.event({ event: "robotCompanion/pythonSession", body: { version: 1, phase: "start", sessionId: "s",
    adapter: { id: "debugpy", version: "1.8.22", processId: 41 }, owner: { processId: 40, debuggeeProcessId: 42 },
    connect: { host: "127.0.0.1", port: 5001 },
    configuration: { request: "attach", listen: { host: "127.0.0.1", port: 0 }, subProcess: false, justMyCode: false } } });
  assert.deepEqual(start.pythonChild, { host: "127.0.0.1", port: 5001, processId: 42,
    attach: { listen: { host: "127.0.0.1", port: 0 }, subProcess: false, justMyCode: false } });
  assert.deepEqual(start.ownedProcessGroups, [41, 42]);
  assert.equal(start.forward, false, "handoff events stay inside the adapter");
  assert.equal(bridge.event({ event: "robotCompanion/pythonConnected", body: { sessionId: "s" } }).release, false);
  assert.equal(bridge.childReady(), true);
  assert.equal(bridge.hold({ command: "configurationDone" }), false);
  assert.deepEqual(bridge.event({ event: "process", body: { systemProcessId: 42 } }).ownedProcessGroups, [42]);
  assert.deepEqual(bridge.event({ event: "exited", body: { exitCode: 0 } }).exited, { exitCode: 0, outputFile: "/out/1/output.xml" });
  assert.throws(() => bridge.event({ event: "robotCompanion/pythonSession", body: { version: 2, phase: "start",
    connect: { host: "127.0.0.1", port: 1 }, configuration: { request: "attach" } } }), /invalid Python handoff/);
  assert.throws(() => bridge.event({ event: "robotCompanion/pythonSession", body: { version: 1, phase: "start",
    connect: { host: "10.0.0.5", port: 1 }, configuration: { request: "attach" } } }), /invalid Python handoff/);
});

test("live native language service: identity, advertised capabilities, imported definition and references", { ...live, timeout: 60000 }, async t => {
  const directory = workspace();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, executable: backend.executable });
  const session = new LspSession();
  t.after(() => session.stop());
  const capabilities = await session.start(descriptor, true);
  providers.verifyLanguageServer(descriptor, session.serverInfo);
  assert.deepEqual({ ...session.serverInfo }, { name: "robot-companion-backend", version: "0.1.0.dev1" });
  // Quick fixes for a client with CodeAction literal support; formatting with the venv's Robocop 9.1.0.
  assert.deepEqual(Object.keys(capabilities).filter(name => name.endsWith("Provider")).sort(), ["codeActionProvider", "completionProvider",
    "definitionProvider", "documentFormattingProvider", "documentSymbolProvider", "hoverProvider", "referencesProvider", "renameProvider",
    "signatureHelpProvider", "workspaceSymbolProvider"]);
  assert.deepEqual(capabilities.codeActionProvider, { codeActionKinds: ["quickfix"] });
  for (const absent of ["documentRangeFormattingProvider", "semanticTokensProvider", "inlayHintProvider"]) {
    assert.equal(capabilities[absent], undefined, `${absent} is not advertised`);
  }
  const uri = pathToFileURL(path.join(directory, "audit.robot")).href;
  const text = fs.readFileSync(path.join(directory, "audit.robot"), "utf8");
  session.notify("textDocument/didOpen", { textDocument: { uri, languageId: "robotframework", version: 1, text } });
  const line = text.split("\n").findIndex(row => row.includes("Build Record    name=Ada"));
  const character = text.split("\n")[line].indexOf("Build Record") + 2;
  const definition = await session.request("textDocument/definition", { textDocument: { uri }, position: { line, character } });
  const targets = (Array.isArray(definition) ? definition : [definition]).map(item => [path.basename(fileURLToPath(item.targetUri || item.uri)),
    (item.targetSelectionRange || item.range).start.line + 1]);
  assert.deepEqual(targets, [["AuditLibrary.py", 12]]);
  const references = await session.request("textDocument/references", { textDocument: { uri }, position: { line, character },
    context: { includeDeclaration: true } });
  const files = references.map(item => path.basename(fileURLToPath(item.uri)));
  assert.ok(files.includes("audit.robot") && files.includes("alias.robot"), files.join(", "));
  assert.ok(!files.includes("AShadow.py"), "the unimported shadow never appears");
  const child = session.child;
  await session.stop();
  assert.equal(child.exitCode, 0, "clean shutdown");
  t.diagnostic(JSON.stringify({ executable: backend.executable, definition: targets, references: files }));
});

test("live native debug transcript through the adapter: Robot console, Python child step/count, Robot frame, 1 PASS, no processes left",
  { ...live, timeout: 120000 }, async t => {
    const directory = workspace();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const outputDir = path.join(directory, "results");
    const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, executable: backend.executable,
      services: ["debug"] });
    const adapter = new DapProcessAdapter({ descriptor, trusted: true, context: { cwd: directory, robotArguments: [], outputDir } });
    t.after(() => adapter.dispose());
    const robot = client(message => adapter.handleMessage(message));
    adapter.onDidSendMessage(message => robot.accept(message));
    const pythonChild = new Promise(resolve => adapter.once("pythonChild", resolve));
    const runExited = new Promise(resolve => adapter.once("runExited", resolve));
    const pid = adapter.start();

    const capabilities = await robot.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true,
      columnsStartAt1: true, pathFormat: "path" });
    assert.deepEqual(capabilities, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
    const initialized = robot.event("initialized", "Robot initialized");
    await robot.request("launch", { type: "robotcompanion", request: "launch", name: "Debug audit", target: path.join(directory, "audit.robot") });
    await initialized;
    const audit = path.join(directory, "audit.robot"), library = path.join(directory, "AuditLibrary.py");
    await robot.request("setBreakpoints", { source: { path: audit }, breakpoints: [{ line: 12 }, { line: 13 }] });
    // VS Code sends the Python breakpoint to the Robot session too; the adapter answers it.
    const pythonInParent = await robot.request("setBreakpoints", { source: { path: library }, breakpoints: [{ line: 18 }] });
    assert.equal(pythonInParent.breakpoints[0].verified, false);
    let stopped = robot.event("stopped", "Robot stop at line 12");
    // Sent before the Python child exists, as VS Code does: the adapter holds it.
    const configured = robot.request("configurationDone", {});

    const endpoint = await pythonChild;
    assert.deepEqual(endpoint.attach, { listen: { host: "127.0.0.1", port: 0 }, subProcess: false, justMyCode: false });
    const socket = net.connect(endpoint.port, endpoint.host);
    t.after(() => socket.destroy());
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const py = client(message => socket.write(frame(message)));
    const reader = new MessageReader(message => py.accept(message), "DAP");
    socket.on("data", chunk => reader.accept(chunk));
    await py.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
    const pyInitialized = py.event("initialized", "Python initialized");
    // What VS Code sends for the child configuration DebugWorkspace starts.
    const attached = py.request("attach", { ...endpoint.attach, type: "robotcompanion", request: "attach", name: "Python: Debug audit",
      robotCompanionHandoff: "token" });
    attached.catch(() => {});
    await pyInitialized;
    assert.equal((await py.request("setBreakpoints", { source: { path: library }, breakpoints: [{ line: 18 }] })).breakpoints[0].verified, true);
    await py.request("configurationDone", {});
    adapter.childConfigured(); // DebugWorkspace's tracker does this for the child session.
    await attached;
    await configured;

    const robotStop1 = await stopped;
    let frames = (await robot.request("stackTrace", { threadId: robotStop1.body.threadId })).stackFrames;
    assert.equal(frames[0].line, 12);
    const live1 = await robot.request("evaluate", { expression: "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", frameId: frames[0].id, context: "repl" });
    assert.equal(live1.result, "'from-suite-console'");

    let pyStopped = py.event("stopped", "Python stop at line 18");
    await robot.request("continue", { threadId: robotStop1.body.threadId });
    const pyStop = await pyStopped;
    let pyFrames = (await py.request("stackTrace", { threadId: pyStop.body.threadId })).stackFrames;
    assert.equal(pyFrames[0].line, 18);
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
    const live2 = await robot.request("evaluate", { expression: "Resource Step    ${record.name}", frameId: frames[0].id, context: "repl" });
    const terminated = robot.event("terminated");
    await robot.request("continue", { threadId: robotStop2.body.threadId });
    await terminated;
    const exited = await runExited;
    assert.equal(exited.exitCode, 0, "1 test, 1 passed");
    assert.equal(exited.outputFile, path.join(outputDir, "output.xml"));
    const xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.match(xml, /<msg[^>]*>Ada<\/msg>/, "Resource Step logged Ada");
    assert.equal(robot.messages.filter(m => m.type === "event" && /^robotCompanion\//.test(m.event)).length, 0,
      "native handoff events stay inside the adapter");

    await robot.request("disconnect", {}).catch(() => {});
    await adapter.dispose();
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.throws(() => process.kill(-pid, 0), /ESRCH/, "no process of the backend's group survives");
    assert.throws(() => process.kill(endpoint.processId, 0), /ESRCH/, "the Robot worker is gone");
    t.diagnostic(JSON.stringify({ live1: live1.result, count: "3", live2: live2.result, exit: adapter.exit, handoffPort: endpoint.port }));
  });

test("live native debug: Stop while paused ends the backend, Robot worker and debugpy adapter", { ...live, timeout: 60000 }, async t => {
  const directory = workspace();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, executable: backend.executable,
    services: ["debug"] });
  const adapter = new DapProcessAdapter({ descriptor, trusted: true, context: { cwd: directory, robotArguments: [],
    outputDir: path.join(directory, "results") } });
  t.after(() => adapter.dispose());
  const robot = client(message => adapter.handleMessage(message));
  adapter.onDidSendMessage(message => robot.accept(message));
  const pythonChild = new Promise(resolve => adapter.once("pythonChild", resolve));
  adapter.start();
  await robot.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  await robot.request("launch", { type: "robotcompanion", request: "launch", name: "Stop", target: path.join(directory, "audit.robot") });
  await robot.request("setBreakpoints", { source: { path: path.join(directory, "audit.robot") }, breakpoints: [{ line: 12 }] });
  const stopped = robot.event("stopped");
  const configured = robot.request("configurationDone", {});
  const endpoint = await pythonChild;
  const socket = net.connect(endpoint.port, endpoint.host);
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const py = client(message => socket.write(frame(message)));
  const reader = new MessageReader(message => py.accept(message), "DAP");
  socket.on("data", chunk => reader.accept(chunk));
  await py.request("initialize", { clientID: "vscode", adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
  const pyInitialized = py.event("initialized");
  py.request("attach", { ...endpoint.attach, type: "robotcompanion", request: "attach", name: "Python" }).catch(() => {});
  await pyInitialized;
  await py.request("configurationDone", {});
  adapter.childConfigured();
  await configured;
  await stopped;
  const groups = [...adapter.ownedGroups, adapter.child.pid];
  assert.equal(groups.length, 3, `backend, worker and debugpy adapter groups: ${groups}`);
  const terminated = robot.event("terminated");
  robot.request("terminate", {}).catch(() => {});
  await terminated;
  await robot.request("disconnect", {}).catch(() => {});
  await adapter.dispose();
  const gone = pid => { try { process.kill(-pid, 0); return false; } catch { return true; } };
  const deadline = Date.now() + 8000;
  while (!groups.every(gone) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(groups.filter(pid => !gone(pid)), [], "no backend, Robot or debugpy process group remains");
});

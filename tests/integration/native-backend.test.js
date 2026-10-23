"use strict";
// The native backend provider: descriptor, pre-start refusals, the debug bridge
// API and live runs of `robot-companion-backend lsp` / `dap` / `discovery` from the owned
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
const { DISCOVERY_METHOD, normalizeDiscovery, normalizeDiscoveryErrors } = require("../../src/integration/test-discovery");
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

test("native descriptors launch robot-companion-backend lsp / dap / discovery; providers are told apart", () => {
  const descriptor = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/venv/bin/robot-companion-backend",
    services: ["language", "debug"] });
  assert.equal(descriptor.id, "robot-companion-native");
  assert.equal(descriptor.version, "0.1.0.dev5");
  assert.deepEqual(descriptor.services.language, { executable: "/venv/bin/robot-companion-backend", argv: ["lsp"], transport: "stdio" });
  assert.deepEqual(descriptor.services.debug, { executable: "/venv/bin/robot-companion-backend", argv: ["dap"], transport: "stdio" });
  assert.deepEqual(native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/venv/bin/robot-companion-backend",
    services: ["discovery"] }).services.discovery, { executable: "/venv/bin/robot-companion-backend", argv: ["discovery"], transport: "stdio" });
  assert.throws(() => native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "x", services: ["format"] }),
    /does not provide format/);
  assert.equal(providers.describe(descriptor), "Native backend 0.1.0.dev5");
  const robotCode = robotCodeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", python: "/env/bin/python" });
  assert.equal(providers.describe(robotCode), "RobotCode 2.7.0");
  assert.equal(providers.providerOf({ id: "fixture", version: "1" }).kind, "custom");
});

test("a declared version mismatch is refused before anything starts, naming both versions", () => {
  const nativeOther = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/x", version: "0.2.0" });
  assert.throws(() => providers.checkVersion(nativeOther), /supports the native backend 0\.1\.0\.dev5; the descriptor declares 0\.2\.0/);
  const robotCodeOther = { ...robotCodeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", python: "/x" }), version: "2.6.0" };
  assert.throws(() => providers.checkVersion(robotCodeOther), /pinned to 2\.7\.0; the descriptor declares 2\.6\.0/);
  assert.throws(() => providers.debugBridge(nativeOther, {}), /0\.2\.0/, "the debug adapter refuses it too");
  assert.throws(() => new DapProcessAdapter({ descriptor: { ...nativeOther, services: { debug: { executable: process.execPath, argv: [], transport: "stdio" } } },
    trusted: true }), /declares 0\.2\.0/);
  // A running server that is not the declared native backend is refused after initialize.
  const descriptor = native.nativeDescriptor({ workspaceUri: "file:///ws", cwd: "/ws", executable: "/x" });
  assert.throws(() => providers.verifyLanguageServer(descriptor, { name: "robot-companion-backend", version: "0.0.9" }),
    /requires robot-companion-backend 0\.1\.0\.dev5; the backend reported robot-companion-backend 0\.0\.9/);
  assert.doesNotThrow(() => providers.verifyLanguageServer(descriptor, { name: "robot-companion-backend", version: "0.1.0.dev5" }));
});

test("a missing native executable is refused with its path; nothing is spawned", async () => {
  const directory = workspace();
  try {
    const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory,
      executable: path.join(directory, "venv/bin/robot-companion-backend"), services: ["language", "debug"] });
    const session = new LspSession();
    await assert.rejects(session.start(descriptor, true), /robot-companion-native' 0\.1\.0\.dev5: the language executable .*venv\/bin\/robot-companion-backend does not exist/);
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
  // Markdown Robot sources (RF 7.5 suites and resources) reach the backend too, which verifies them per release.
  for (const file of ["/ws/login.robot.md", "/ws/keywords.md", "/ws/KEYWORDS.MD", "/ws/notes.markdown", "/ws/b.resource"]) {
    assert.equal(bridge.answer({ command: "setBreakpoints", arguments: { source: { path: file }, breakpoints: [{ line: 3 }] } }),
      undefined, `${file} is forwarded to the Robot backend`);
  }
  for (const file of ["/ws/lib.PY", "/ws/robot.md.py", "/ws/notes.txt"]) {
    assert.equal(bridge.answer({ command: "setBreakpoints", arguments: { source: { path: file }, breakpoints: [{ line: 3 }] } })
      ?.breakpoints[0].message, "Set in the Python child session.", `${file} stays with the Python child`);
  }
  // configurationDone waits for the connected and configured Python child.
  assert.equal(bridge.hold({ command: "configurationDone" }), true);
  assert.equal(bridge.hold({ command: "threads" }), false);
  const start = bridge.event({ event: "robotCompanion/pythonSession", body: { version: 1, phase: "start", sessionId: "s",
    adapter: { id: "debugpy", version: "1.8.22", processId: 41 }, owner: { processId: 40, debuggeeProcessId: 42 },
    connect: { host: "127.0.0.1", port: 5001 },
    configuration: { request: "attach", listen: { host: "127.0.0.1", port: 0 }, subProcess: false, justMyCode: false } } });
  assert.deepEqual(start.pythonChild, { host: "127.0.0.1", port: 5001, processId: 42, generation: 1,
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

test("native debug bridge: restart keeps the run inputs, takes a new output folder and retires a generation", () => {
  const bridge = new native.NativeDebugBridge();
  const config = { type: "robotcompanion", request: "launch", name: "Debug", target: "/ws/a.robot", args: ["-v", "X:1"] };
  bridge.launchArguments(config, { cwd: "/ws", robotArguments: ["--loglevel", "DEBUG"], outputDir: "/out/1" });
  assert.deepEqual(bridge.restartArguments(undefined, () => "/out/2"), { arguments: { name: "Debug", target: "/ws/a.robot",
    cwd: "/ws", args: ["--loglevel", "DEBUG", "-v", "X:1", "--outputdir", "/out/2"],
    pythonDebug: { handoffVersion: 1 } } });
  // VS Code echoes the resolved configuration (with its own internal fields): unchanged inputs pass.
  assert.equal(bridge.restartArguments({ arguments: { ...config, __sessionId: "x" } }, () => "/out/3").arguments.args.at(-1), "/out/3");
  assert.equal(bridge.outputDir, "/out/3");
  let created = 0;
  for (const changed of [{ target: "/ws/b.robot" }, { args: [] }, { attachPython: false }, { cwd: "/elsewhere" }]) {
    assert.throws(() => bridge.restartArguments({ arguments: { ...config, ...changed } }, () => `/out/${++created}`),
      /Restart declined: Restart cannot change/);
  }
  assert.equal(created, 0, "a declined restart creates no output folder");
  bridge.event({ event: "robotCompanion/pythonConnected", body: {} });
  bridge.childReady();
  assert.equal(bridge.ready(), true);
  const retired = bridge.event({ event: "robotCompanion/generation", body: { version: 1, retired: 1 } });
  assert.deepEqual([retired.retired, retired.forward, bridge.generation, bridge.ready()], [true, false, 2, false]);
  const start = bridge.event({ event: "robotCompanion/pythonSession", body: { version: 1, phase: "start", sessionId: "t",
    adapter: { processId: 51 }, owner: { debuggeeProcessId: 52 }, connect: { host: "127.0.0.1", port: 5002 },
    configuration: { request: "attach" } } });
  assert.equal(start.pythonChild.generation, 2);
  assert.deepEqual(start.ownedProcessGroups, [51, 52]);
});

test("native debug bridge: a prepared session uses its connector and never claims the owner's processes", () => {
  const bridge = new native.NativeDebugBridge();
  const connector = bridge.preparedConnector({ preparedSession: "/tmp/rcb-prepared-x/session.json", workspace: "/ws" });
  assert.deepEqual(connector.argv, ["dap-connect"]);
  assert.ok(connector.startup.endsWith("\n") && !connector.startup.slice(0, -1).includes("\n"));
  assert.deepEqual(JSON.parse(connector.startup), { version: 1, preparedSession: "/tmp/rcb-prepared-x/session.json",
    workspace: "/ws", backend: { id: "robot-companion-native", version: "0.1.0.dev5" } });
  assert.deepEqual(bridge.attachArguments({ type: "robotcompanion", request: "attach", name: "Attach",
    preparedSession: "/tmp/rcb-prepared-x/session.json" }), { name: "Attach" });
  assert.equal(bridge.event({ event: "process", body: { systemProcessId: 77 } }).ownedProcessGroups, undefined);
  const start = bridge.event({ event: "robotCompanion/pythonSession", body: { version: 1, phase: "start", sessionId: "p",
    adapter: { processId: 78 }, owner: { debuggeeProcessId: 79 }, connect: { host: "127.0.0.1", port: 5003 },
    configuration: { request: "attach" } } });
  assert.equal(start.ownedProcessGroups, undefined);
  assert.equal(bridge.hold({ command: "configurationDone" }), true, "the Robot run waits for the Python child");
  assert.deepEqual(bridge.restartArguments({ arguments: { preparedSession: "/tmp/rcb-prepared-x/session.json" } }), {});
  assert.throws(() => bridge.restartArguments({ arguments: { preparedSession: "/tmp/other.json" } }), /Restart declined: Restart cannot change/);
});

test("native debug bridge: a late 'not paused' refusal and the routine Python end are not notifications", () => {
  const bridge = new native.NativeDebugBridge();
  const refusal = command => ({ type: "response", request_seq: 7, command, success: false, message: "Robot worker is not paused",
    body: { error: { id: 1, format: "Robot worker is not paused", showUser: true } } });
  for (const command of ["stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn", "stepOut"]) {
    assert.deepEqual(bridge.response(refusal(command)), { ...refusal(command),
      body: { error: { id: 1, format: "Robot worker is not paused", showUser: false } } }, `${command} still fails, without a toast`);
  }
  // Other refusals and successes reach VS Code unchanged.
  assert.equal(bridge.response(refusal("launch")), undefined);
  assert.equal(bridge.response({ ...refusal("evaluate"), message: "Enter one Robot keyword call on a single line",
    body: { error: { id: 1, format: "Enter one Robot keyword call on a single line", showUser: true } } }), undefined);
  assert.equal(bridge.response({ type: "response", request_seq: 8, command: "stackTrace", success: true, body: { stackFrames: [] } }), undefined);
  // A Step Out refusal at the outermost frame and a Pause refusal are substantive: still shown.
  for (const [command, message] of [["stepOut", "Step Out is not available here: the current line is not inside a Robot user keyword " +
    "(test or suite level). Use Step Over or Continue."], ["pause", "Robot worker is already paused"]]) {
    assert.equal(bridge.response({ ...refusal(command), message, body: { error: { id: 1, format: message, showUser: true } } }), undefined);
  }
  const ended = detail => ({ type: "event", event: "output", body: { category: "important", output: `Python session ended: ${detail}\n` } });
  for (const detail of ["Python DAP client disconnected", "Python adapter closed its DAP stream"]) {
    const handled = bridge.event(ended(detail));
    assert.equal(handled.forward, true);
    assert.deepEqual(handled.message, { ...ended(detail), body: { category: "console", output: `Python session ended: ${detail}\n` } });
  }
  // A Python session lost to an error stays a notification.
  assert.equal(bridge.event(ended("Python child session attaches only to its owned Robot worker")).message, undefined);
});

test("live native language service: identity, advertised capabilities, imported definition and references", { ...live, timeout: 60000 }, async t => {
  const directory = workspace();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const descriptor = native.nativeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, executable: backend.executable });
  const session = new LspSession();
  t.after(() => session.stop());
  const capabilities = await session.start(descriptor, true);
  providers.verifyLanguageServer(descriptor, session.serverInfo);
  assert.deepEqual({ ...session.serverInfo }, { name: "robot-companion-backend", version: "0.1.0.dev5" });
  // Quick fixes and the add-missing-imports source action for a client with CodeAction literal support listing
  // `source`; document, range and on-type (Enter) formatting with the venv's Robocop 9.1.0.
  assert.deepEqual(Object.keys(capabilities).filter(name => name.endsWith("Provider")).sort(), ["codeActionProvider", "completionProvider",
    "definitionProvider", "documentFormattingProvider", "documentOnTypeFormattingProvider", "documentRangeFormattingProvider",
    "documentSymbolProvider", "hoverProvider", "inlayHintProvider", "referencesProvider", "renameProvider", "semanticTokensProvider", "signatureHelpProvider",
    "workspaceSymbolProvider"]);
  assert.deepEqual(capabilities.codeActionProvider, { codeActionKinds: ["quickfix", "source.addMissingImports"] });
  assert.deepEqual(capabilities.documentOnTypeFormattingProvider, { firstTriggerCharacter: "\n" });
  // Whole-document and range semantic tokens, deltas enabled (MIS-427's legend).
  assert.deepEqual(capabilities.semanticTokensProvider, { full: { delta: true }, range: true, legend: {
    tokenTypes: ["namespace", "property", "class", "function", "variable", "comment", "keyword", "macro", "operator"],
    tokenModifiers: ["declaration", "resolved", "defaultLibrary"] } });
  assert.deepEqual(capabilities.inlayHintProvider, { resolveProvider: false });
  for (const absent of ["documentHighlightProvider", "implementationProvider", "inlineValueProvider"]) {
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

test("live native discovery service: API v1 tree with tasks, non-BMP and duplicate names, explicit errors, refusals and a crash",
  { ...live, timeout: 60000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-native-discovery-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, "fixtures/native-discovery"), directory, { recursive: true });
    const workspaceUri = pathToFileURL(directory).href;
    const uri = name => pathToFileURL(path.join(directory, name)).href;
    const descriptor = native.nativeDescriptor({ workspaceUri, cwd: directory, executable: backend.executable, services: ["discovery"] });
    const session = new LspSession({ service: "discovery" });
    t.after(() => session.stop());
    const failures = [];
    session.on("failure", error => failures.push(error.message));
    assert.deepEqual({ ...await session.start(descriptor, true) }, { robotCompanionDiscovery: { version: 1, document: true } });
    const tree = normalizeDiscovery(await session.request(DISCOVERY_METHOD, { workspaceUri }), workspaceUri);
    const names = uri("nested/native_names.robot");
    assert.deepEqual(tree.map(suite => [suite.label, suite.uri, suite.children.map(test => [test.id, test.label, test.range.start.line])]), [
      ["Native Tasks", uri("native_tasks.robot"), [[`${uri("native_tasks.robot")}::Archive Reports`, "Archive Reports", 5],
        [`${uri("native_tasks.robot")}::Notify Team ✉`, "Notify Team ✉", 6]]],
      ["Native Waits", uri("native_waits.robot"), [[`${uri("native_waits.robot")}::Waits For Stop`, "Waits For Stop", 5]]],
      ["Native Names", names, [[`${names}::Grüße aus Köln 🎉 und 𝄞`, "Grüße aus Köln 🎉 und 𝄞", 8],
        [`${names}::Duplicate Name`, "Duplicate Name", 11], [`${names}::Duplicate Name#2`, "Duplicate Name", 14],
        [`${names}::Needs Ready Flag`, "Needs Ready Flag", 17], [`${names}::Login On staging`, "Login On staging", 20]]]
    ]);
    // UTF-16 columns: the non-BMP name's range ends after its surrogate pairs.
    const nonBmp = tree[2].children[0];
    assert.deepEqual(nonBmp.range.end, { line: 9, character: "    Log    Ümlaut 🎉 und 𝄞".length });
    // A file with a parse error still lists RF's tests and reports the error; nothing is cached between requests.
    fs.writeFileSync(path.join(directory, "broken.robot"), "*** Test Cases ***\nStill Listed\n    Log    x\n\n*** Not A Section ***\nx\n");
    const result = await session.request(DISCOVERY_METHOD, { workspaceUri });
    assert.deepEqual(normalizeDiscovery(result, workspaceUri)[0].children.map(test => test.label), ["Still Listed"]);
    const errors = normalizeDiscoveryErrors(result, workspaceUri);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].uri, uri("broken.robot"));
    assert.equal(errors[0].range.start.line, 4);
    assert.match(errors[0].message, /Unrecognized section header '\*\*\* Not A Section \*\*\*'/);
    // A JSON-RPC error is a rejected request, not a tree.
    await assert.rejects(session.request(DISCOVERY_METHOD, { workspaceUri: pathToFileURL(path.join(directory, "missing")).href }),
      error => error.code === -32602);
    await assert.rejects(session.request("robotCompanion/unknown", {}), error => error.code === -32601);
    // A crash fails the session and any pending request.
    const pending = session.request(DISCOVERY_METHOD, { workspaceUri });
    session.child.kill("SIGKILL");
    await assert.rejects(pending, /Discovery backend exited \(SIGKILL\)/);
    assert.deepEqual(failures, ["Discovery backend exited (SIGKILL)."]);
    // A service that cannot start fails its initialize.
    const broken = new LspSession({ service: "discovery" });
    t.after(() => broken.stop());
    await assert.rejects(broken.start({ ...descriptor, services: { discovery: { ...descriptor.services.discovery, argv: ["discovery-typo"] } } },
      true), /Discovery backend exited \(2\)/);
    t.diagnostic(JSON.stringify({ executable: backend.executable, suites: tree.map(suite => suite.label), errors: errors.map(e => e.message) }));
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
    assert.deepEqual(capabilities, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true,
      supportsConditionalBreakpoints: true, supportsLogPoints: true, supportsHitConditionalBreakpoints: true,
      supportsSetVariable: true, supportsRestartRequest: true, supportsCancelRequest: true, exceptionBreakpointFilters: [
      { filter: "robot-failed-keyword", label: "Robot: failed keyword (includes handled failures)",
        description: "Stop after a Robot keyword ends with FAIL, also when TRY/EXCEPT or Run Keyword And Ignore Error handles it; a failure stops again for each keyword it fails. Read-only inspection. Not Python exceptions.",
        default: false },
      { filter: "robot-failed-test", label: "Robot: failed test/task (final outcome)",
        description: "Stop when a Robot test or task ends with FAIL, after its teardown, at its definition. Read-only inspection. Not Python exceptions.",
        default: false }] });
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
    // A Robot edit goes to the Robot endpoint's current scope and is what the console then sees.
    const robotScope = (await robot.request("scopes", { frameId: frames[0].id })).scopes[0];
    assert.equal(robotScope.name, "Robot visible variables (edit current scope)");
    const robotEdit = await robot.request("setVariable", { variablesReference: robotScope.variablesReference,
      name: "${SUITE_VALUE}", value: '"edited-suite"' });
    assert.deepEqual(robotEdit, { value: "'edited-suite'", type: "str", variablesReference: 0 });
    const edited = await robot.request("evaluate", { expression: "Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", frameId: frames[0].id, context: "repl" });
    assert.equal(edited.result, "'edited-suite-console'");

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
    // Python values change only through the Python child endpoint, with debugpy's own rules.
    const pyLocals = (await py.request("scopes", { frameId: pyFrames[0].id })).scopes.find(scope => scope.name === "Locals");
    assert.equal((await py.request("setVariable", { variablesReference: pyLocals.variablesReference, name: "count", value: "5" })).value, "5");
    assert.equal((await py.request("evaluate", { expression: "count", frameId: pyFrames[0].id, context: "repl" })).result, "5");
    // The Robot endpoint is not paused while Python is: neither its old scope handle nor the
    // Python handle's number edits anything there, and nothing is redirected to Python.
    for (const variablesReference of [robotScope.variablesReference, pyLocals.variablesReference]) {
      await assert.rejects(robot.request("setVariable", { variablesReference, name: "${SUITE_VALUE}", value: '"late"' }),
        /^Error: setVariable: Execution has continued\. Pause again and select the variable to edit it\.$/);
    }
    assert.equal((await py.request("evaluate", { expression: "count", frameId: pyFrames[0].id, context: "repl" })).result, "5");

    stopped = robot.event("stopped", "Robot stop at line 13");
    await py.request("continue", { threadId: pyStop.body.threadId });
    const robotStop2 = await stopped;
    frames = (await robot.request("stackTrace", { threadId: robotStop2.body.threadId })).stackFrames;
    assert.equal(frames[0].line, 13);
    const live2 = await robot.request("evaluate", { expression: "Resource Step    ${record.name}", frameId: frames[0].id, context: "repl" });
    const terminated = robot.event("terminated");
    await robot.request("continue", { threadId: robotStop2.body.threadId });
    // As VS Code does for the rest of the call stack after a quick Continue.
    const late = await robot.request("stackTrace", { threadId: robotStop2.body.threadId, startFrame: 1, levels: 19 })
      .then(() => undefined, error => error.message);
    await terminated;
    const lateResponse = robot.messages.find(m => m.type === "response" && m.command === "stackTrace" && m.success === false);
    if (late === "stackTrace: Robot worker is not paused") {
      assert.equal(lateResponse.body.error.showUser, false, "the late refusal is not shown as a notification");
    } else assert.match(late, /^stackTrace: Debug backend (exited|stopped)/, `the late stack request still fails: ${late}`);
    assert.deepEqual(robot.messages.filter(m => m.event === "output" && m.body.category === "important"), [],
      "no Robot output is a notification in a normal run");
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
    t.diagnostic(JSON.stringify({ live1: live1.result, edited: edited.result, count: "3", pythonEdit: "5", live2: live2.result,
      exit: adapter.exit, handoffPort: endpoint.port }));
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

test("live native language and discovery apply the folder's robotArguments as Run Test and Debug do", { ...live, timeout: 60000 }, async t => {
  const { robotConfiguration, ExecutionContexts } = require("../../src/integration/backend-contract");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-native-config-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), text);
  };
  write("lib/projectlib.py", "def project_step():\n    return 1\n");
  write("vars/env.py", "TARGET = 'staging'\n");
  write("suites/configured.robot", "*** Settings ***\nLibrary    projectlib\n*** Variables ***\n${ENV}    local\n" +
    "*** Test Cases ***\nCheck ${ENV} on ${TARGET}\n    Project Step\n    Log    ${TARGET}\n");
  const workspaceUri = pathToFileURL(directory).href;
  const setting = ["--pythonpath", "lib", "--variablefile", "vars/env.py", "--variable", "ENV:prod"];
  const configuration = robotConfiguration(workspaceUri, setting, true);
  assert.throws(() => robotConfiguration(workspaceUri, setting, false), /trusted workspace/);
  // Run Test and Debug take their cwd and robotArguments from the same function.
  const context = new ExecutionContexts().forRoot(workspaceUri, { robotCommand: "robot", robotArguments: setting }, true);
  assert.deepEqual([context.cwd, [...context.robotArguments]], [configuration.cwd, [...configuration.robotArguments]]);
  const launch = new native.NativeDebugBridge().launchArguments({ target: "suites/configured.robot", attachPython: false }, context);
  assert.deepEqual([launch.cwd, launch.args], [directory, setting]);

  const language = native.nativeDescriptor({ workspaceUri, cwd: directory, executable: backend.executable });
  const session = new LspSession();
  t.after(() => session.stop());
  await session.start(language, true, { initializationOptions: { robotConfiguration: configuration } });
  assert.deepEqual(session.robotConfiguration, { version: 1, cwd: directory, pythonPath: [path.join(directory, "lib")],
    variableFiles: [path.join(directory, "vars/env.py")], variables: ["${ENV}"], errors: [], projectFiles: [] });
  const uri = pathToFileURL(path.join(directory, "suites/configured.robot")).href;
  const text = fs.readFileSync(path.join(directory, "suites/configured.robot"), "utf8");
  const diagnostics = new Promise(resolve => session.on("notification", (method, params) => {
    if (method === "textDocument/publishDiagnostics" && params.uri === uri) resolve(params.diagnostics);
  }));
  session.notify("textDocument/didOpen", { textDocument: { uri, languageId: "robotframework", version: 1, text } });
  assert.deepEqual(await diagnostics, [], "the library on --pythonpath and the variable file's variable are known");
  const lines = text.split("\n");
  const at = needle => { const line = lines.findIndex(row => row.includes(needle)); return { line, character: lines[line].indexOf(needle) + 2 }; };
  const definition = await session.request("textDocument/definition", { textDocument: { uri }, position: at("Project Step") });
  assert.deepEqual(definition.map(item => path.relative(directory, fileURLToPath(item.uri))), [path.join("lib", "projectlib.py")]);
  const variable = await session.request("textDocument/definition", { textDocument: { uri }, position: at("${TARGET}") });
  assert.deepEqual(variable.map(item => [path.relative(directory, fileURLToPath(item.uri)), item.range.start.line]),
    [[path.join("vars", "env.py"), 0]]);

  const discovery = new LspSession({ service: "discovery" });
  t.after(() => discovery.stop());
  await discovery.start(native.nativeDescriptor({ workspaceUri, cwd: directory, executable: backend.executable, services: ["discovery"] }), true);
  const configured = normalizeDiscovery(await discovery.request(DISCOVERY_METHOD, { workspaceUri, robotConfiguration: configuration }), workspaceUri);
  const plain = normalizeDiscovery(await discovery.request(DISCOVERY_METHOD, { workspaceUri }), workspaceUri);
  assert.deepEqual(configured[0].children.map(test => test.label), ["Check prod on staging"]);
  assert.deepEqual(plain[0].children.map(test => test.label), ["Check local on ${TARGET}"]);
  t.diagnostic(JSON.stringify({ executable: backend.executable, reported: session.robotConfiguration, configured: configured[0].children[0].label }));
});


test("prepared attach retains the selected Python module launcher", () => {
  const bridge = new native.NativeDebugBridge({ argv: ["-m", "robot_companion_backend", "dap"] });
  const connector = bridge.preparedConnector({ preparedSession: "/tmp/session.json", workspace: "/ws" });
  assert.deepEqual(connector.argv, ["-m", "robot_companion_backend", "dap-connect"]);
});

test("live robot.toml settings reach native language and discovery in-process and Run/Debug through project-config", { ...live, timeout: 60000 }, async t => {
  const { robotConfiguration, ExecutionContexts } = require("../../src/integration/backend-contract");
  const { ProjectFiles, describeProjectFiles } = require("../../src/integration/project-files");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-native-toml-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), text);
  };
  write("lib/tomllib_step.py", "def toml_step():\n    return 1\n");
  write("robot.toml", 'python-path = ["lib"]\nbogus = 1\n\n[variables]\nENV = "staging"\n');
  write("suites/configured.robot", "*** Settings ***\nLibrary    tomllib_step\n*** Variables ***\n${ENV}    local\n" +
    "*** Test Cases ***\nCheck ${ENV}\n    Toml Step\n");
  const workspaceUri = pathToFileURL(directory).href;
  const folder = { uri: { fsPath: directory, toString: () => workspaceUri }, name: "toml" };
  const config = { get: (key, fallback) => key === "nativeBackendExecutable" ? backend.executable : fallback };
  const setting = ["--loglevel", "DEBUG"];
  const files = new ProjectFiles();
  const project = await files.read(folder, config, { owned: true });
  assert.deepEqual([...project.arguments], ["--pythonpath", "lib", "--variable", "ENV:staging"]);
  assert.deepEqual([...project.files], [path.join(directory, "robot.toml")]);
  assert.deepEqual(describeProjectFiles(project), ["robot.toml settings from robot.toml: --pythonpath lib --variable ENV:staging",
    "robot.toml problem: robot.toml:2: Unknown robot.toml setting 'bogus'; it is not applied."]);
  assert.equal(await files.read(folder, config, { owned: true }), project, "unchanged files are not read again");
  // Run Test and Debug: robot.toml's arguments, then robotArguments.
  const context = new ExecutionContexts().forRoot(workspaceUri, { robotCommand: "robot", robotArguments: setting,
    projectArguments: project.arguments }, true);
  assert.deepEqual([...context.robotArguments], ["--pythonpath", "lib", "--variable", "ENV:staging", "--loglevel", "DEBUG"]);
  const launch = new native.NativeDebugBridge().launchArguments({ target: "suites/configured.robot", attachPython: false }, context);
  assert.deepEqual(launch.args, [...context.robotArguments]);
  // The language and discovery services read the same file themselves.
  const configuration = robotConfiguration(workspaceUri, setting, true);
  const session = new LspSession();
  t.after(() => session.stop());
  await session.start(native.nativeDescriptor({ workspaceUri, cwd: directory, executable: backend.executable }), true,
    { initializationOptions: { robotConfiguration: configuration } });
  assert.deepEqual(session.robotConfiguration, { version: 1, cwd: directory, pythonPath: [path.join(directory, "lib")],
    variableFiles: [], variables: ["${ENV}"], errors: ["robot.toml:2: Unknown robot.toml setting 'bogus'; it is not applied."],
    projectFiles: [path.join(directory, "robot.toml")] });
  const uri = pathToFileURL(path.join(directory, "suites/configured.robot")).href;
  const text = fs.readFileSync(path.join(directory, "suites/configured.robot"), "utf8");
  const diagnostics = new Promise(resolve => session.on("notification", (method, params) => {
    if (method === "textDocument/publishDiagnostics" && params.uri === uri) resolve(params.diagnostics);
  }));
  session.notify("textDocument/didOpen", { textDocument: { uri, languageId: "robotframework", version: 1, text } });
  assert.deepEqual(await diagnostics, [], "the library on robot.toml's python-path is known");
  const discovery = new LspSession({ service: "discovery" });
  t.after(() => discovery.stop());
  await discovery.start(native.nativeDescriptor({ workspaceUri, cwd: directory, executable: backend.executable, services: ["discovery"] }), true);
  const found = normalizeDiscovery(await discovery.request(DISCOVERY_METHOD, { workspaceUri, robotConfiguration: configuration }), workspaceUri);
  assert.deepEqual(found[0].children.map(test => test.label), ["Check staging"]);
  t.diagnostic(JSON.stringify({ executable: backend.executable, project, reported: session.robotConfiguration }));
});

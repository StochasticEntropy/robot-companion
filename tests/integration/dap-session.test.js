"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DapProcessAdapter, CancelledDebugAdapter } = require("../../src/integration/dap-session");

const descriptor = (mode = "full", services) => ({
  id: "dap-fixture", version: "1", contractVersion: 1,
  workspaceUri: pathToFileURL(process.cwd()).href, cwd: process.cwd(), env: {},
  services: services || { debug: { executable: process.execPath,
    argv: [path.join(__dirname, "fixtures/dap/server.js"), mode], transport: "stdio" } }
});

function session(mode, options = {}) {
  const adapter = new DapProcessAdapter({ descriptor: descriptor(mode), trusted: true, ...options });
  const messages = [];
  const subscription = adapter.onDidSendMessage(message => messages.push(message));
  let seq = 1;
  const request = (command, args) => adapter.handleMessage({ seq: seq++, type: "request", command, arguments: args });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out: ${label}`);
  };
  return { adapter, messages, request, until, subscription };
}

test("descriptor errors and untrusted workspaces spawn nothing", () => {
  assert.throws(() => new DapProcessAdapter({ descriptor: descriptor(), trusted: false }), /trusted workspace/);
  assert.throws(() => new DapProcessAdapter({ descriptor: { ...descriptor(), contractVersion: 2 }, trusted: true }),
    /contract version/);
  assert.throws(() => new DapProcessAdapter({ descriptor: descriptor("full", {
    language: { executable: process.execPath, argv: [], transport: "stdio" } }), trusted: true }),
  /does not support debug/);
  assert.throws(() => new DapProcessAdapter({ descriptor: descriptor("full", {
    debug: { executable: process.execPath, argv: [], transport: "tcp" } }), trusted: true }), /only stdio/);
});

test("owned stdio process negotiates capabilities, keeps logs off protocol and disconnects cleanly", async () => {
  const { adapter, messages, request, until } = session("full");
  let logs = ""; adapter.on("log", text => { logs += text; });
  adapter.start();
  const child = adapter.child;
  request("initialize", { adapterID: "robotcompanion", linesStartAt1: true, columnsStartAt1: true });
  const init = await until(message => message.command === "initialize", "initialize response");
  assert.equal(init.success, true);
  assert.deepEqual(adapter.unsupported, []);
  await until(message => message.event === "initialized", "initialized event");
  request("launch", { target: "/ws/audit.robot" });
  await until(message => message.event === "output" && /launched target \/ws\/audit.robot/.test(message.body.output), "launch output");
  assert.match(logs, /log only/);
  assert.ok(messages.every(message => !JSON.stringify(message).includes("log only")), "stderr never reaches DAP");
  request("disconnect", { terminateDebuggee: true });
  await until(message => message.command === "disconnect" && message.success, "disconnect response");
  await adapter.dispose();
  assert.equal(child.exitCode, 0);
  assert.equal(adapter.state, "stopped");
  assert.equal(messages.some(message => message.body?.category === "stderr"), false, "expected exit is not reported as failure");
});

test("missing journey capabilities are reported in the Debug Console, not emulated", async () => {
  const { adapter, request, until } = session("minimal");
  let reported;
  adapter.on("capabilities", (capabilities, unsupported) => { reported = unsupported; });
  adapter.start();
  request("initialize", {});
  const output = await until(message => message.event === "output" && /does not support/.test(message.body.output), "unsupported output");
  assert.deepEqual(reported, ["supportsTerminateRequest", "supportsSetVariable", "supportsEvaluateForHovers"]);
  assert.match(output.body.output, /'dap-fixture' does not support: graceful terminate, editing variables, hover evaluation/);
  await adapter.dispose();
});

test("a backend ignoring disconnect and SIGTERM is killed within the bounded stop", async () => {
  const { adapter, request, until } = session("hang-disconnect", { stopTimeoutMs: 200 });
  adapter.start();
  const child = adapter.child;
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("disconnect", {});
  const started = Date.now();
  await adapter.dispose();
  assert.ok(Date.now() - started < 2000, "bounded stop");
  assert.equal(child.signalCode, "SIGKILL");
});

test("an unanswered disconnect ends the backend's process group and the session without dispose", async () => {
  // Like RobotCode busy in a long keyword: the Stop's disconnect gets no answer.
  const { adapter, messages, request, until } = session("hang-disconnect", { disconnectTimeoutMs: 300 });
  let unexpected = 0; adapter.on("unexpectedExit", () => unexpected++);
  adapter.start();
  const child = adapter.child;
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  const started = Date.now();
  request("disconnect", {});
  await until(message => message.event === "terminated", "terminated event after the forced stop");
  assert.ok(Date.now() - started < 3000, `bounded (${Date.now() - started} ms)`);
  assert.equal(child.signalCode, "SIGKILL", "a SIGTERM-ignoring backend is killed");
  assert.throws(() => process.kill(-child.pid, 0), /ESRCH/, "no process of the group remains");
  // The user's Stop ended the session as asked: no failure for VS Code to show.
  assert.equal(messages.find(message => message.command === "disconnect").success, true);
  assert.equal(messages.some(message => message.body?.category === "stderr"), false);
  assert.equal(unexpected, 0, "a requested end is not an unexpected exit");
  request("disconnect", {});
  await until(message => message.command === "disconnect" && message.request_seq === 3, "disconnect after the end");
  assert.equal(messages.filter(message => message.command === "disconnect").every(message => message.success), true);
});

// The response VS Code takes as a cancellation: neither a notification nor the launch dialog.
const isCancelled = message => message?.type === "response" && message.success === false &&
  message.command === "canceled" && message.message === "canceled";

test("a Stop while the launch is still pending cancels it and every later request, without an error", async t => {
  const { adapter, messages, request, until } = session("slow-launch");
  t.after(() => adapter.dispose());
  let unexpected = 0; adapter.on("unexpectedExit", () => unexpected++);
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { target: "x.robot" }); // seq 2, unanswered by the backend
  assert.equal(adapter.ending, false);
  request("disconnect", {}); // seq 3: the user's Stop
  assert.equal(adapter.ending, true, "nothing new may start once the Stop is sent");
  await until(message => message.event === "terminated", "terminated after the Stop");
  assert.ok(isCancelled(messages.find(message => message.request_seq === 2)), "the pending launch is cancelled");
  assert.equal(messages.find(message => message.request_seq === 3).success, true, "the Stop itself succeeded");
  // What VS Code still sends after the backend is gone (configurationDone after initialized).
  request("configurationDone", {}); // seq 4
  await until(message => message.request_seq === 4, "configurationDone after the end");
  assert.ok(isCancelled(messages.find(message => message.request_seq === 4)), "a later request is cancelled too");
  assert.equal(messages.some(message => message.body?.category === "stderr"), false, "no error output");
  assert.equal(messages.some(message => message.type === "response" && message.success === false && !isCancelled(message)), false,
    "no failed response for VS Code to show");
  assert.equal(unexpected, 0, "a Stop is not an unexpected exit");
  assert.equal(adapter.launched, undefined, "the launch never succeeded");
});

test("an external kill while launching is reported once and cancels the launch instead of failing it", async t => {
  const { adapter, messages, request, until } = session("slow-launch");
  t.after(() => adapter.dispose());
  const unexpected = []; adapter.on("unexpectedExit", exit => unexpected.push(exit));
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { target: "x.robot" }); // seq 2
  process.kill(adapter.child.pid, "SIGKILL");
  await until(message => message.event === "terminated", "terminated after the kill");
  assert.deepEqual(unexpected, [{ code: null, signal: "SIGKILL" }], "the user is told once, by the unexpected-exit warning");
  assert.ok(isCancelled(messages.find(message => message.request_seq === 2)), "the pending launch is cancelled");
  request("configurationDone", {}); // seq 3
  await until(message => message.request_seq === 3, "configurationDone after the kill");
  assert.ok(isCancelled(messages.find(message => message.request_seq === 3)));
  // The Debug Console still names the exit.
  assert.ok(messages.some(message => message.body?.category === "stderr" && /exited \(SIGKILL\)/.test(message.body.output)));
});

test("a Stop before initialize ends the session without an error, even with a backend refusing it before initialize", async t => {
  // VS Code sends the Stop's disconnect (or terminate) before initialize when the user
  // stops while it is still starting the session; the native backend refuses any request
  // before initialize ("Debug adapter not initialized"), which VS Code would show.
  for (const command of ["disconnect", "terminate"]) {
    const { adapter, messages, request, until } = session("strict-initialize");
    t.after(() => adapter.dispose());
    let unexpected = 0; adapter.on("unexpectedExit", () => unexpected++);
    adapter.start();
    const child = adapter.child;
    request(command, {}); // seq 1: the user's Stop
    assert.equal(adapter.ending, true, `${command}: nothing new may start once the Stop is sent`);
    await until(message => message.event === "terminated", `${command}: terminated after the Stop`);
    assert.equal(messages.find(message => message.request_seq === 1).success, true, `${command}: the Stop itself succeeded`);
    // What VS Code may still send for this session.
    request("initialize", {}); // seq 2
    request("disconnect", {}); // seq 3
    await until(message => message.request_seq === 3, `${command}: disconnect after the Stop`);
    assert.ok(isCancelled(messages.find(message => message.request_seq === 2)), `${command}: a later initialize is cancelled`);
    assert.equal(messages.find(message => message.request_seq === 3).success, true);
    assert.equal(messages.some(message => message.type === "response" && message.success === false && !isCancelled(message)), false,
      `${command}: no failed response for VS Code to show: ${JSON.stringify(messages)}`);
    assert.equal(messages.some(message => message.body?.category === "stderr"), false, `${command}: no error output`);
    assert.equal(messages.filter(message => message.event === "terminated").length, 1, `${command}: one terminated event`);
    await adapter.dispose();
    assert.notEqual(child.exitCode ?? child.signalCode, null, `${command}: the backend process has ended`);
    assert.throws(() => process.kill(-child.pid, 0), /ESRCH/, `${command}: no process of the group remains`);
    assert.equal(unexpected, 0, `${command}: a Stop is not an unexpected exit`);
  }
});

test("a backend refusing the Stop still ends, and the refusal is logged instead of shown", async t => {
  const { adapter, messages, request, until } = session("refuse-stop", { disconnectTimeoutMs: 300 });
  t.after(() => adapter.dispose());
  let unexpected = 0; adapter.on("unexpectedExit", () => unexpected++);
  let logs = ""; adapter.on("log", text => { logs += text; });
  adapter.start();
  const child = adapter.child;
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("terminate", {}); // seq 2: the user's Stop, refused by the backend
  await until(message => message.request_seq === 2, "terminate answered");
  request("disconnect", {}); // seq 3, refused too
  await until(message => message.event === "terminated", "terminated after the forced stop");
  assert.equal(messages.find(message => message.request_seq === 2).success, true, "the Stop succeeded for VS Code");
  assert.equal(messages.find(message => message.request_seq === 3).success, true);
  assert.equal(messages.some(message => message.type === "response" && message.success === false), false,
    "no failed response for VS Code to show");
  assert.equal(messages.some(message => message.body?.category === "stderr"), false, "no error output");
  assert.match(logs, /terminate refused by the debug backend: DAP fixture refuses terminate/);
  assert.equal(unexpected, 0, "a Stop is not an unexpected exit");
  await adapter.dispose();
  assert.throws(() => process.kill(-child.pid, 0), /ESRCH/, "no process of the group remains");
});

test("a clean exit while launching is reported once and cancels the launch; a clean exit after the launch stays quiet", async t => {
  {
    const { adapter, messages, request, until } = session("exit-while-launching");
    t.after(() => adapter.dispose());
    const unexpected = []; adapter.on("unexpectedExit", exit => unexpected.push(exit));
    adapter.start();
    request("initialize", {});
    await until(message => message.command === "initialize", "initialize");
    request("launch", { target: "x.robot" }); // seq 2: the backend exits with code 0 instead of answering
    await until(message => message.event === "terminated", "terminated after the exit");
    assert.deepEqual(unexpected, [{ code: 0, signal: null }], "the user is told once, by the unexpected-exit warning");
    assert.ok(isCancelled(messages.find(message => message.request_seq === 2)), "the pending launch is cancelled, not failed");
    request("configurationDone", {}); // seq 3
    await until(message => message.request_seq === 3, "configurationDone after the exit");
    assert.ok(isCancelled(messages.find(message => message.request_seq === 3)));
    assert.equal(messages.some(message => message.type === "response" && message.success === false && !isCancelled(message)), false,
      "no failed response for VS Code to show");
    // The Debug Console still names the exit.
    assert.ok(messages.some(message => message.body?.category === "stderr" && /exited \(0\)/.test(message.body.output)));
  }
  {
    // A backend ending its own run after a successful launch is no unexpected exit.
    const { adapter, request, until } = session("exit-after-launch");
    t.after(() => adapter.dispose());
    let unexpected = 0; adapter.on("unexpectedExit", () => unexpected++);
    adapter.start();
    request("initialize", {});
    await until(message => message.command === "initialize", "initialize");
    request("launch", { target: "x.robot" });
    await until(message => message.event === "terminated", "terminated after the exit");
    assert.equal(adapter.launched, true);
    assert.equal(unexpected, 0, "an exit after a successful launch is not reported as unexpected");
  }
});

test("a request held for the Python handoff is cancelled by the Stop, not sent to the backend", async t => {
  const { adapter, messages, request, until } = session("full");
  t.after(() => adapter.dispose());
  const received = [];
  // A bridge holding configurationDone, as the native handoff does until the Python child is configured.
  adapter.bridge = { launchArguments: args => args, event: () => ({ forward: true }), hold: message => message.command === "configurationDone" };
  const write = adapter.write.bind(adapter);
  adapter.write = message => { received.push(message.command); write(message); };
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { target: "x.robot" });
  await until(message => message.command === "launch", "launch");
  request("configurationDone", {}); // seq 3, held
  request("terminate", {}); // seq 4: the user's Stop
  const done = messages.filter(message => message.request_seq === 3);
  assert.equal(done.length, 1);
  assert.ok(isCancelled(done[0]), "the held configurationDone is cancelled at once");
  assert.equal(received.includes("configurationDone"), false, "the backend never receives it");
  await until(message => message.command === "terminate", "terminate");
  request("disconnect", {});
  await until(message => message.event === "terminated" && messages.some(m => m.command === "disconnect"), "disconnect");
  assert.equal(messages.filter(message => message.request_seq === 3).length, 1, "answered once");
});

test("a backend failing after the Stop (write EPIPE) ends quietly; without a Stop it fails the requests", async t => {
  for (const stopped of [true, false]) {
    const { adapter, messages, request, until } = session("slow-launch");
    t.after(() => adapter.dispose());
    adapter.start();
    request("initialize", {});
    await until(message => message.command === "initialize", "initialize");
    request("launch", { target: "x.robot" }); // seq 2
    if (stopped) adapter.disconnectRequested();
    adapter.fail(new Error("write EPIPE"));
    await until(message => message.event === "terminated", "terminated after the failure");
    const launch = messages.find(message => message.request_seq === 2);
    if (stopped) {
      assert.ok(isCancelled(launch), "after the Stop the launch is cancelled");
      assert.equal(messages.some(message => message.body?.category === "stderr"), false);
    } else {
      assert.equal(launch.success, false);
      assert.equal(launch.command, "launch");
      assert.match(launch.message, /Debug backend failed: write EPIPE/, "an unrequested failure keeps its reason");
    }
    await adapter.dispose();
  }
});

test("the stand-in for a session that can no longer start cancels every request", () => {
  const adapter = new CancelledDebugAdapter();
  const messages = [];
  const subscription = adapter.onDidSendMessage(message => messages.push(message));
  adapter.handleMessage({ seq: 1, type: "request", command: "initialize", arguments: {} });
  adapter.handleMessage({ seq: 2, type: "request", command: "attach", arguments: {} });
  assert.deepEqual(messages.map(message => [message.request_seq, isCancelled(message)]), [[1, true], [2, true]]);
  subscription.dispose();
  adapter.dispose();
});

test("stop() reports the session terminated once the backend is gone", async () => {
  const { adapter, messages, until } = session("full", { stopTimeoutMs: 100 });
  adapter.start();
  await adapter.stop();
  await until(message => message.event === "terminated", "terminated event after stop");
  assert.equal(messages.filter(message => message.event === "terminated").length, 1);
  assert.equal(messages.some(message => message.body?.category === "stderr"), false, "an owner stop is not an error");
});

test("a crash ends the session with explicit failures and an output line", async () => {
  const { adapter, request, until, messages } = session("crash-after-launch");
  const unexpected = [];
  adapter.on("unexpectedExit", exit => unexpected.push(exit));
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { target: "x.robot" });
  request("threads");
  await until(message => message.event === "terminated", "terminated event");
  const threads = messages.find(message => message.command === "threads");
  if (threads) assert.equal(typeof threads.success, "boolean");
  assert.ok(messages.some(message => message.body?.category === "stderr" && /exited \(3\)/.test(message.body.output)));
  assert.deepEqual(unexpected, [{ code: 3, signal: null }], "a crash is reported as an unexpected exit once");
  await adapter.dispose();
  assert.equal(adapter.state, "stopped");
});

test("a missing executable is refused before anything starts", () => {
  const input = descriptor();
  input.services.debug.executable = path.join(__dirname, "no-such-debug-backend");
  assert.throws(() => new DapProcessAdapter({ descriptor: input, trusted: true }),
    /dap-fixture' 1: the debug executable .*no-such-debug-backend does not exist or is not executable\. Nothing was started/);
});

test("an executable removed after the check fails pending requests instead of hanging", async () => {
  // Checked when the adapter is created, gone when it spawns.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "companion-dap-"));
  const executable = path.join(directory, "debug-backend");
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  const input = descriptor();
  input.services.debug.executable = executable;
  const adapter = new DapProcessAdapter({ descriptor: input, trusted: true });
  fs.rmSync(directory, { recursive: true, force: true });
  const messages = [];
  adapter.onDidSendMessage(message => messages.push(message));
  adapter.start();
  adapter.handleMessage({ seq: 1, type: "request", command: "initialize", arguments: {} });
  const deadline = Date.now() + 5000;
  while (!messages.some(message => message.event === "terminated") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const response = messages.find(message => message.command === "initialize");
  assert.equal(response?.success, false);
  assert.match(response.message, /ENOENT|failed|exited/);
  assert.ok(messages.some(message => message.event === "terminated"));
  await adapter.dispose();
});

// The native bridge with the protocol fixture as its executable (no Robot Framework).
const nativeFixture = mode => ({ ...descriptor(mode), id: "robot-companion-native", version: "0.1.0.dev15" });

test("a declined native restart answers without restarting and creates no output folder", async () => {
  let created = 0;
  const { adapter, messages, request, until } = session("full", { descriptor: nativeFixture("full"), context: {},
    nextOutputDir: () => `/out/${++created}` });
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { type: "robotcompanion", request: "launch", name: "Run", target: "/ws/a.robot" });
  await until(message => message.command === "launch", "launch");
  request("restart", { arguments: { type: "robotcompanion", request: "launch", name: "Run", target: "/ws/a.robot", attachPython: false } });
  const reply = await until(message => message.command === "restart", "restart response");
  assert.equal(reply.success, true, "the paused session stays usable");
  await until(message => message.event === "output" && /^Restart declined: /.test(message.body.output), "named reason");
  assert.equal(created, 0, "no output folder for a declined restart");
  await adapter.stop();
});

test("a failed prepared attach ends its connector even without VS Code's disconnect", { skip: process.platform === "win32" }, async t => {
  // The prepared session's argv is the connector's (`dap-connect`): run the fixture through a wrapper.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rcb-connector-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "backend");
  fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, "fixtures/dap/server.js")}" "$@"\n`, { mode: 0o755 });
  const { adapter, messages, request, until } = session("dap-connect", { descriptor: { ...nativeFixture("full"), services: {
    debug: { executable, argv: ["dap"], transport: "stdio" } } },
  prepared: { preparedSession: "/tmp/rcb-prepared-x/session.json", workspace: "/ws" }, disconnectTimeoutMs: 200 });
  const closed = new Promise(resolve => adapter.once("closed", resolve));
  adapter.start();
  request("initialize", {});
  await until(message => message.event === "terminated", "terminated after the refused initialize");
  assert.match(messages.find(message => message.event === "output").body.output, /Connection refused/);
  const exit = await closed;
  assert.ok(adapter.failedStart, "the adapter records the failed start its owner releases");
  assert.deepEqual(exit, { code: 0, signal: null }, "the connector ended at end of input");
});


test("a late native launch cancellation after Stop is quiet in VS Code", async t => {
  const { adapter, messages, request, until } = session("cancel-launch-on-stop");
  t.after(() => adapter.dispose());
  adapter.start();
  request("initialize", {});
  await until(m => m.request_seq === 1, "initialized");
  request("launch", { target: "audit.robot" });
  request("terminate", {});
  const reply = await until(m => m.request_seq === 2, "cancelled launch");
  assert.equal(reply.command, "canceled");
  assert.equal(reply.message, "canceled");
  assert.equal(reply.success, false);
  await until(m => m.request_seq === 3, "Stop response");
  assert.equal(messages.find(m => m.request_seq === 3).success, true);
});

// The Python child session (both providers' handoff) over a fake debugpy endpoint that,
// like debugpy 1.8.22, verifies a breakpoint in any file.
test("the Python child session claims Python breakpoints only; other sources never reach debugpy", async t => {
  const net = require("node:net");
  const { frame, MessageReader } = require("../../src/integration/lsp-session");
  const { PythonChildProxy, isPythonSource } = require("../../src/integration/dap-session");
  const received = [];
  const server = net.createServer(socket => {
    const reader = new MessageReader(message => {
      received.push(message);
      const body = message.command === "setBreakpoints"
        ? { breakpoints: message.arguments.breakpoints.map(item => ({ verified: true, line: item.line })) } : {};
      socket.write(frame({ seq: received.length, type: "response", request_seq: message.seq, command: message.command,
        success: true, body }));
    }, "DAP");
    socket.on("data", chunk => reader.accept(chunk));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const proxy = new PythonChildProxy({ host: "127.0.0.1", port: server.address().port });
  t.after(() => proxy.dispose());
  const answers = new Map();
  proxy.onDidSendMessage(message => { if (message.type === "response") answers.set(message.request_seq, message); });
  const request = (seq, command, args) => proxy.handleMessage({ seq, type: "request", command, arguments: args });
  const sources = ["/ws/login.robot.md", "/ws/keywords.md", "/ws/notes.MARKDOWN", "/ws/a.robot", "/ws/b.resource", "/ws/vars.yaml"];
  sources.forEach((file, index) => request(index + 1, "setBreakpoints", { source: { path: file }, breakpoints: [{ line: 6 }, { line: 13 }] }));
  request(20, "setBreakpoints", { source: { path: "/ws/lib/tomlkw.py" }, breakpoints: [{ line: 2 }] });
  request(21, "setBreakpoints", { source: { path: "/ws/gui.PYW" }, breakpoints: [{ line: 1 }] });
  request(22, "threads", {});
  const deadline = Date.now() + 5000;
  while (answers.size < sources.length + 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  // Non-Python sources: answered locally, unverified and without a message, so the Robot session's reason shows.
  sources.forEach((file, index) => assert.deepEqual(answers.get(index + 1)?.body,
    { breakpoints: [{ verified: false, line: 6 }, { verified: false, line: 13 }] }, file));
  // Python sources and other requests reach debugpy unchanged.
  assert.deepEqual(answers.get(20)?.body, { breakpoints: [{ verified: true, line: 2 }] });
  assert.deepEqual(answers.get(21)?.body, { breakpoints: [{ verified: true, line: 1 }] });
  assert.equal(answers.get(22)?.success, true);
  assert.deepEqual(received.map(message => [message.command, message.arguments?.source?.path]),
    [["setBreakpoints", "/ws/lib/tomlkw.py"], ["setBreakpoints", "/ws/gui.PYW"], ["threads", undefined]]);
  assert.deepEqual([isPythonSource({ path: "x.py" }), isPythonSource({ path: "x.robot.md" }), isPythonSource({})], [true, false, false]);
  // The endpoint closing ends the child session.
  const terminated = new Promise(resolve => proxy.onDidSendMessage(message => { if (message.event === "terminated") resolve(); }));
  proxy.socket.destroy();
  await terminated;
  assert.equal(proxy.ended, true);
});

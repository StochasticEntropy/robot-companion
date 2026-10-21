"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DapProcessAdapter } = require("../../src/integration/dap-session");

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
  // The Stop did what it asked for: no failed response that VS Code would show as an error.
  const reply = messages.find(message => message.type === "response" && message.command === "disconnect");
  assert.deepEqual([reply.success, reply.message], [true, undefined]);
  assert.equal(messages.some(message => message.body?.category === "stderr"), false, "an asked-for end is not an error");
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
  adapter.start();
  request("initialize", {});
  await until(message => message.command === "initialize", "initialize");
  request("launch", { target: "x.robot" });
  request("threads");
  await until(message => message.event === "terminated", "terminated event");
  const threads = messages.find(message => message.command === "threads");
  if (threads) assert.equal(typeof threads.success, "boolean");
  assert.ok(messages.some(message => message.body?.category === "stderr" && /exited \(3\)/.test(message.body.output)));
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
const nativeFixture = mode => ({ ...descriptor(mode), id: "robot-companion-native", version: "0.1.0.dev1" });

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

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

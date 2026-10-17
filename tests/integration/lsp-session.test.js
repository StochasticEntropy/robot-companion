"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { frame, MessageReader, LspSession } = require("../../src/integration/lsp-session");
const descriptor = encoding => ({
  id: "protocol-fixture", version: "1", contractVersion: 1,
  workspaceUri: pathToFileURL(process.cwd()).href, cwd: process.cwd(), env: {},
  services: { language: { executable: process.execPath,
    argv: [path.join(__dirname, "fixtures/protocol/server.js"), ...(encoding ? [encoding] : [])], transport: "stdio" } }
});

test("LSP byte framing tolerates arbitrary chunks and adjacent Unicode messages", () => {
  const messages = [{ jsonrpc: "2.0", method: "test", params: "Ä😀" }, { jsonrpc: "2.0", id: 1, result: null }];
  const received = [];
  const reader = new MessageReader(message => received.push(message));
  const bytes = Buffer.concat(messages.map(frame));
  for (const byte of bytes) reader.accept(Buffer.from([byte]));
  assert.deepEqual(received, messages);
});

test("invalid and oversized LSP framing fails explicitly", () => {
  for (const header of ["Content-Length: -1", "Content-Length: 0", "Content-Length: 999999999", "Content-Length: 1\r\nContent-Length: 1", "Unknown: 1"]) {
    assert.throws(() => new MessageReader(() => {}).accept(Buffer.from(header + "\r\n\r\n")), /LSP/);
  }
  assert.throws(() => new MessageReader(() => {}).accept(Buffer.alloc(9000, 65)), /limit/);
});

test("real local subprocess negotiates capabilities, preserves Unicode and stops/restarts", async t => {
  const session = new LspSession(); t.after(() => session.stop());
  let failures = 0; session.on("failure", () => { failures++; });
  let logs = ""; session.on("log", text => { logs += text; });
  const capabilities = await session.start(descriptor(), true);
  assert.equal(capabilities.definitionProvider, true);
  assert.equal(capabilities.hoverProvider, undefined);
  assert.deepEqual(await session.request("fixture/echo", { text: "Ä😀", character: 3 }), { text: "Ä😀", character: 3 });
  assert.match(logs, /fixture log/);
  const child = session.child;
  await session.stop();
  assert.equal(session.state, "stopped");
  assert.notEqual(child.exitCode, null);
  assert.equal(session.pending.size, 0);
  assert.equal(failures, 0);
  await session.start(descriptor(), true);
  assert.equal(session.state, "running");
});

test("request failures, cancellation and timeout reject without leaking pending handles", async t => {
  const session = new LspSession(); t.after(() => session.stop());
  await session.start(descriptor(), true);
  await assert.rejects(session.request("fixture/error", {}), error => error.code === -32601);
  const controller = new AbortController();
  const request = session.request("fixture/hang", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /cancelled/);
  await assert.rejects(session.request("fixture/hang", {}, { timeoutMs: 30 }), /timed out/);
  assert.equal(session.pending.size, 0);
  assert.equal(await session.request("fixture/echo", "still live"), "still live");
});

test("invalid position negotiation and missing executable clean up startup", async () => {
  const session = new LspSession();
  await assert.rejects(session.start(descriptor("utf-8"), true), /UTF-16/);
  assert.equal(session.state, "stopped");
  const missing = descriptor(); missing.services.language.executable = "/nonexistent/companion-fixture";
  await assert.rejects(session.start(missing, true), /ENOENT/);
  assert.equal(session.state, "stopped");
});

test("backend crash and malformed stdout reject outstanding work and close owned process", async () => {
  for (const method of ["fixture/crash", "fixture/malformed"]) {
    const session = new LspSession();
    try {
      await session.start(descriptor(), true);
      await assert.rejects(session.request(method, {}), /exited|Content-Length/);
      await session.closed;
      assert.equal(session.pending.size, 0);
      assert.deepEqual(session.capabilities, {});
    } finally { await session.stop(); }
  }
});

test("untrusted launch performs no spawn", async () => {
  const session = new LspSession();
  await assert.rejects(session.start(descriptor(), false), /trusted/);
  assert.equal(session.child, undefined);
  assert.equal(session.state, "stopped");
});

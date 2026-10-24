"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
class CancellationTokenSource {
  constructor() { this.listeners = new Set(); this.token = { isCancellationRequested: false,
    onCancellationRequested: fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; } }; }
  cancel() { this.token.isCancellationRequested = true; for (const fn of [...this.listeners]) fn(); }
  dispose() { this.listeners.clear(); }
}
const source = fs.readFileSync(path.resolve(__dirname, "../../src/integration/shared-definition-requests.js"), "utf8");
const context = { require: () => ({ CancellationTokenSource }), module: { exports: {} } };
vm.runInNewContext(source, context);
const { SharedDefinitionRequests } = context.module.exports;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("concurrent legacy consumers share only in-flight exact document/context/position work", async () => {
  const shared = new SharedDefinitionRequests(), doc = { version: 1 }, root = {}, pending = deferred(); let calls = 0;
  const load = () => { calls += 1; return pending.promise; };
  const a = shared.request(doc, root, { line: 4, character: 8 }, undefined, load);
  const b = shared.request(doc, root, { line: 4, character: 8 }, undefined, load);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve("exact"); assert.deepEqual(await Promise.all([a, b]), ["exact", "exact"]);
  await shared.request(doc, root, { line: 4, character: 8 }, undefined, load);
  assert.equal(calls, 2, "Next interaction must check source again, including missed filesystem notifications");
});

test("one cancelled consumer cannot cancel another, final consumer aborts owned work", async () => {
  const shared = new SharedDefinitionRequests(), doc = { version: 1 }, root = {}, pending = deferred(); let nativeToken;
  const load = token => { nativeToken = token; return pending.promise; };
  const first = new CancellationTokenSource(), second = new CancellationTokenSource();
  const a = shared.request(doc, root, { line: 0, character: 0 }, first.token, load);
  const b = shared.request(doc, root, { line: 0, character: 0 }, second.token, load);
  await Promise.resolve(); first.cancel(); assert.equal(await a, undefined);
  assert.equal(nativeToken.isCancellationRequested, false);
  second.cancel(); assert.equal(await b, undefined); assert.equal(nativeToken.isCancellationRequested, true);
  pending.resolve("late");
});

test("edits, other document, root restart and position changes never join the old operation", async () => {
  const shared = new SharedDefinitionRequests(), doc = { version: 1 }, root = {}, pending = deferred(); let calls = 0;
  const load = () => { calls += 1; return pending.promise; };
  const all = [shared.request(doc, root, { line: 0, character: 0 }, undefined, load)];
  doc.version = 2; all.push(shared.request(doc, root, { line: 0, character: 0 }, undefined, load));
  all.push(shared.request(doc, {}, { line: 0, character: 0 }, undefined, load));
  all.push(shared.request({ version: 2 }, root, { line: 0, character: 0 }, undefined, load));
  all.push(shared.request(doc, root, { line: 1, character: 0 }, undefined, load));
  await Promise.resolve(); assert.equal(calls, 5); pending.resolve("done"); await Promise.all(all);
});

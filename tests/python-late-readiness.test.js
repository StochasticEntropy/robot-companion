"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PythonEnvironment } = require("../src/features/run/python-environment");
const URI = "file:///synthetic/example.robot";
const local = { executable: { uri: { scheme: "file", fsPath: "/synthetic/selected/bin/python" } } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate() && Date.now() < deadline) await pause(1);
  assert.ok(predicate(), "expected the one late-readiness change");
}
function fixture(phase) {
  const pending = deferred();
  const calls = { activation: 0, active: 0, resolution: 0, subscriptions: 0, changes: 0 };
  let trusted = true, listener;
  const api = {
    getActiveEnvironmentPath() { calls.active++; return phase === "active" ? pending.promise : { path: "/synthetic/selected" }; },
    resolveEnvironment() { calls.resolution++; return phase === "resolution" ? pending.promise : local; },
    onDidChangeActiveEnvironmentPath(callback) { calls.subscriptions++; listener = callback; return { dispose() {} }; }
  };
  const exports = { environments: api, ...(phase === "ready" ? { ready: pending.promise } : {}) };
  const extension = { activate() { calls.activation++; return phase === "activation" ? pending.promise : exports; } };
  const adapter = new PythonEnvironment({ extensions: { getExtension: () => extension } }, () => trusted,
    () => { calls.changes++; }, { readinessMs: 20 });
  const complete = value => pending.resolve(value ?? (phase === "activation" ? exports : phase === "active" ? { path: "/synthetic/selected" } : phase === "resolution" ? local : undefined));
  return { adapter, calls, pending, api, exports, complete, distrust() { trusted = false; }, listener: () => listener };
}
for (const phase of ["activation", "ready", "active", "resolution"]) {
  test(`a successful late ${phase} signals one fresh bounded resolution, never a late interpreter`, async () => {
    const f = fixture(phase);
    const failed = await f.adapter.resolve(URI);
    assert.equal(failed.availability.state, "unavailable");
    assert.equal(failed.executable, undefined);
    const before = { ...f.calls };
    f.complete();
    await until(() => f.calls.changes === 1);
    assert.deepEqual({ ...f.calls, changes: 0 }, { ...before, changes: 0 }, "observing old work must not issue another API call");
    assert.equal(failed.executable, undefined, "the unavailable answer is never mutated");
    assert.equal((await f.adapter.resolve(URI)).executable, local.executable.uri.fsPath);
    await pause(25);
    assert.equal(f.calls.changes, 1, "a warm resolution does not rearm a late-startup loop");
    f.adapter.dispose();
  });
  test(`a never-ready ${phase} stays bounded and does not rearm itself`, async () => {
    const f = fixture(phase), start = Date.now();
    const value = await f.adapter.resolve(URI);
    assert.equal(value.availability.state, "unavailable");
    assert.ok(Date.now() - start < 300);
    await pause(35);
    assert.equal(f.calls.changes, 0);
    assert.equal(f.calls.activation, 1);
    assert.ok(f.calls.active <= 1 && f.calls.resolution <= 1);
    f.adapter.dispose();
  });
}
test("late activation waits for its original ready promise and a supported API before rechecking", async () => {
  const f = fixture("activation"), ready = deferred();
  await f.adapter.resolve(URI);
  f.pending.resolve({ ready: ready.promise, environments: f.api });
  await pause(25);
  assert.equal(f.calls.changes, 0);
  ready.resolve();
  await until(() => f.calls.changes === 1);
  assert.equal(f.calls.active, 0);
  assert.equal(f.calls.resolution, 0);
  f.adapter.dispose();
});
for (const scenario of ["reset", "disposed", "trust revoked", "changed after completion before notification"]) {
  test(`late startup cannot publish after ${scenario}`, async () => {
    const f = fixture("activation");
    await f.adapter.resolve(URI);
    if (scenario === "reset") f.adapter.reset();
    if (scenario === "disposed") f.adapter.dispose();
    if (scenario === "trust revoked") f.distrust();
    f.complete();
    if (scenario === "changed after completion before notification") {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      f.adapter.reset();
    }
    await pause(35);
    assert.equal(f.calls.changes, 0);
    assert.equal(f.adapter.api, undefined);
    f.adapter.dispose();
  });
}
for (const phase of ["activation", "ready", "active", "resolution"]) {
  test(`late failed ${phase} is handled without another change or retry`, async () => {
    const f = fixture(phase);
    await f.adapter.resolve(URI);
    f.pending.reject(new Error("Synthetic late API failure"));
    await pause(30);
    assert.equal(f.calls.changes, 0);
    assert.equal(f.calls.activation, 1);
    f.adapter.dispose();
  });
}
test("unsupported late API and nonlocal late environment never announce readiness", async () => {
  for (const [phase, value] of [["activation", {}], ["resolution", { executable: { uri: { scheme: "remote", fsPath: "/python" } } }]]) {
    const f = fixture(phase);
    await f.adapter.resolve(URI);
    f.pending.resolve(value);
    await pause(30);
    assert.equal(f.calls.changes, 0);
    f.adapter.dispose();
  }
});
test("concurrent timed-out callers coalesce one late-startup invalidation per generation", async () => {
  const f = fixture("activation");
  const results = await Promise.all([f.adapter.resolve(URI), f.adapter.resolve(URI), f.adapter.resolve(URI)]);
  assert.ok(results.every(value => value.availability.state === "unavailable"));
  f.complete();
  await until(() => f.calls.changes === 1);
  await pause(25);
  assert.equal(f.calls.changes, 1);
  assert.equal(f.calls.active, 0);
  assert.equal(f.calls.resolution, 0);
  f.adapter.dispose();
});
test("queued old Python change callbacks cannot invalidate a reset or disposed generation", async () => {
  for (const action of ["reset", "dispose"]) {
    const f = fixture("warm");
    assert.equal((await f.adapter.resolve(URI)).executable, local.executable.uri.fsPath);
    const oldListener = f.listener();
    f.adapter[action]();
    oldListener();
    assert.equal(f.calls.changes, 0);
  }
});

for (const phase of ["activation", "ready", "active", "resolution"]) {
  test(`a cancelled or switched ${phase} request cannot rearm an unavailable selection`, async () => {
    const f = fixture(phase);
    let current = true;
    await f.adapter.resolve(URI, { isCurrent: () => current });
    current = false;
    f.complete();
    await pause(35);
    assert.equal(f.calls.changes, 0);
    f.adapter.dispose();
  });
}
test("request cancellation does not poison the shared live Python change subscription", async () => {
  const f = fixture("active");
  let current = true;
  const pending = f.adapter.resolve(URI, { isCurrent: () => current });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  current = false;
  f.complete();
  const result = await pending;
  assert.equal(result.executable, undefined);
  assert.equal(result.availability?.state, "unavailable");
  f.listener()();
  assert.equal(f.calls.changes, 1, "a real current Python environment event remains valid after its first caller was cancelled");
  f.adapter.dispose();
});
test("a disposed adapter starts no new Python work even when its outer guard stays true", async () => {
  const f = fixture("warm");
  f.adapter.dispose();
  const result = await f.adapter.resolve(URI);
  assert.equal(result.executable, undefined);
  assert.equal(result.availability?.state, "unavailable");
  assert.equal(f.calls.activation, 0);
});

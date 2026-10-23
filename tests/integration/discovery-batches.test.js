"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collectDiscovery, CANCEL_DISCOVERY_METHOD, normalizeDiscovery } = require("../../src/integration/test-discovery");

const workspaceUri = "file:///workspace";
const range = { start: { line: 1, character: 0 }, end: { line: 3, character: 12 } };
function suite(name) {
  const uri = `${workspaceUri}/${name}.robot`;
  return { kind: "suite", label: name, uri, range, children: [
    { kind: "test", label: "Duplicate 😀", uri, range, tags: ["smoke"] },
    { kind: "test", label: "Duplicate 😀", uri, range: { start: { line: 5, character: 0 }, end: { line: 7, character: 12 } } }
  ] };
}
const page = (items, continuation, scanned, files, suites, tests) => ({ version: 1, items,
  batch: { continuation, scanned, files, suites, tests } });
function session(reply, batch = 1) {
  const requests = [], notifications = [];
  return { capabilities: { robotCompanionDiscovery: { version: 1, batch } }, timeoutMs: 10000,
    requests, notifications, request: async (...args) => { requests.push(args); return reply(...args); },
    notify: (...args) => notifications.push(args) };
}

test("all pages retain raw tests/diagnostics and use one configured scan with rotating continuations", async () => {
  let count = 0;
  const error = { uri: workspaceUri, message: "Ignored tool setting", severity: "information" };
  const backend = session(() => ++count === 1 ? { ...page([suite("a")], "next", 2, 1, 1, 2), errors: [error] }
    : page([suite("b")], null, 4, 2, 2, 4));
  const progress = [], robotConfiguration = { version: 1, cwd: "/workspace", robotArguments: ["--variable", "ENV:stage"] };
  const result = await collectDiscovery(backend, { workspaceUri, robotConfiguration }, { progress: value => progress.push(value) });
  assert.deepEqual(result, { version: 1, items: [suite("a"), suite("b")], errors: [error] });
  const normalized = normalizeDiscovery(result, workspaceUri);
  assert.equal(normalized.length, 2);
  assert.match(normalized[0].children[1].id, /#2$/);
  assert.equal(backend.requests.length, 2);
  assert.equal(backend.requests[0][1].continuation, undefined);
  assert.equal(backend.requests[1][1].continuation, "next");
  assert.equal(backend.requests[0][1].scanId, backend.requests[1][1].scanId);
  assert.equal(backend.requests[1][1].robotConfiguration, robotConfiguration);
  assert.deepEqual(progress.map(value => [value.tests, value.complete]), [[2, false], [4, true]]);
  assert.deepEqual(backend.notifications, []);
  assert.equal(backend.requests[0][2].timeoutMs, 10000, "Per-request timeout was not increased");
});

test("old providers retain the single full request and no batch/cancel protocol", async () => {
  const expected = { version: 1, items: [suite("a")] }, backend = session(() => expected, undefined);
  delete backend.capabilities.robotCompanionDiscovery.batch;
  assert.equal(await collectDiscovery(backend, { workspaceUri }), expected);
  assert.deepEqual(backend.requests[0][1], { workspaceUri });
  assert.deepEqual(backend.notifications, []);
});

test("abort, superseded roots and failed pages discard collected data and cancel only their own scan", async () => {
  for (const reason of ["abort", "superseded", "error"]) {
    const abort = new AbortController(); let current = true;
    const backend = session(async () => {
      if (backend.requests.length === 1) return page([suite("a")], "next", 1, 1, 1, 2);
      if (reason === "error") throw new Error("second page failed");
      if (reason === "abort") abort.abort(); else current = false;
      return page([suite("b")], null, 2, 2, 2, 4);
    });
    const pending = collectDiscovery(backend, { workspaceUri }, { signal: abort.signal, current: () => current });
    if (reason === "error") await assert.rejects(pending, /second page failed/);
    else assert.equal(await pending, undefined);
    assert.deepEqual(backend.notifications, [[CANCEL_DISCOVERY_METHOD,
      { workspaceUri, scanId: backend.requests[0][1].scanId }]]);
  }
});

test("malformed progress, repeated tokens, foreign suites and invalid diagnostics cannot complete a scan", async () => {
  const malformed = [
    page([suite("a")], "repeat", 1, 1, 1, 2), // repeated token on second page
    page([], "different", 0, 0, 0, 0), // no forward progress
    page([suite("b")], null, 2, 2, 2, 99),
    { ...page([suite("b")], null, 2, 2, 2, 4), version: 2 },
    { ...page([suite("b")], null, 2, 2, 2, 4), errors: [{ uri: "file:///outside", message: "bad" }] },
    { ...page([{ ...suite("b"), uri: "file:///outside.robot" }], null, 2, 2, 2, 4) }
  ];
  for (const bad of malformed) {
    let count = 0;
    const backend = session(() => ++count === 1 ? page([suite("a")], "repeat", 1, 1, 1, 2) : bad);
    await assert.rejects(collectDiscovery(backend, { workspaceUri }));
    assert.equal(backend.notifications.length, 1);
    assert.equal(backend.requests.length, 2);
  }
});

test("healthy progress does not extend the total deadline or the remaining per-request budget", async () => {
  let clock = 0;
  const backend = session(() => {
    clock += 60;
    return backend.requests.length === 1 ? page([suite("a")], "next", 1, 1, 1, 2)
      : page([suite("b")], null, 2, 2, 2, 4);
  });
  await assert.rejects(collectDiscovery(backend, { workspaceUri }, { now: () => clock, budgetMs: 100 }), /overall deadline/);
  assert.deepEqual(backend.requests.map(request => request[2].timeoutMs), [100, 40]);
  assert.equal(backend.notifications.length, 1);
});

// Exercise the real TestWorkspace commit boundary, not just page collection.
const Module = require("node:module"), { fileURLToPath } = require("node:url");
const vscode = {
  Uri: { parse: value => ({ scheme: "file", fsPath: fileURLToPath(value), path: fileURLToPath(value), toString: () => value }) },
  Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
  TestTag: class { constructor(id) { this.id = id; } },
  workspace: { isTrusted: true, workspaceFolders: [] }, LanguageStatusSeverity: { Warning: 1 }
};
const load = Module._load;
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const { TestWorkspace } = require("../../src/integration/test-workspace");
Module._load = load;
class Items extends Map {
  add(item) { this.set(item.id, item); }
  replace(items) { this.clear(); for (const item of items) this.add(item); }
}
function manager(reply) {
  const backend = session(reply); backend.state = "running"; backend.stop = async () => { backend.state = "stopped"; };
  const folder = { name: "workspace", uri: vscode.Uri.parse(workspaceUri) };
  const root = { folder, generation: 1, itemIds: ["old"], session: backend, provider: "Native", setting: "executionBackend" };
  const controller = { items: new Items([["old", { id: "old" }]]),
    createTestItem: (id, label, uri) => ({ id, label, uri, children: new Items() }) };
  const states = [], workspace = Object.create(TestWorkspace.prototype);
  Object.assign(workspace, { disposed: false, generation: 1, roots: new Map([[workspaceUri, root]]), testInfo: new WeakMap(),
    channel: { appendLine() {} }, status: { set: (_kind, _folder, state) => states.push(state), delete() {} },
    controller, controllerFor: () => controller });
  return { workspace, root, backend, controller, states };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Test Explorer retains its old tree until every page validates, then commits all exact test identities", async () => {
  let finish;
  const state = manager(() => state.backend.requests.length === 1 ? page([suite("a")], "next", 1, 1, 1, 2)
    : new Promise(resolve => { finish = resolve; }));
  state.root.failure = "An earlier scan timed out";
  const pending = state.workspace.discover(state.root);
  await tick();
  assert.deepEqual([...state.controller.items.keys()], ["old"]);
  assert.equal(state.states[0].state, "starting");
  assert.equal(state.root.failure, undefined, "A recovering scan must allow its own failure to be reported");
  finish(page([suite("b")], null, 2, 2, 2, 4));
  await pending;
  assert.deepEqual([...state.controller.items.keys()], [`${workspaceUri}/a.robot`, `${workspaceUri}/b.robot`]);
  const selected = [...state.controller.items.get(`${workspaceUri}/a.robot`).children.values()][1];
  assert.match(selected.id, /#2$/);
  assert.deepEqual(state.workspace.testInfo.get(selected), { source: "/workspace/a.robot", line: 6, tags: [], occurrence: 2,
    folderPath: "/workspace", rpa: undefined });
  assert.equal(state.states.at(-1).state, "running");
  assert.equal(state.root.discoveryAbort, undefined);
});

test("folder removal and trust loss during a page cannot publish any partial tree", async () => {
  for (const reason of ["folder", "trust"]) {
    let finish;
    const state = manager(() => state.backend.requests.length === 1 ? page([suite("a")], "next", 1, 1, 1, 2)
      : new Promise(resolve => { finish = resolve; }));
    const pending = state.workspace.discover(state.root);
    await tick();
    if (reason === "folder") state.workspace.roots.delete(workspaceUri);
    else vscode.workspace.isTrusted = false;
    finish(page([suite("b")], null, 2, 2, 2, 4));
    try {
      await pending;
      assert.deepEqual([...state.controller.items.keys()], ["old"]);
      assert.equal(state.backend.notifications.length, 1);
      assert.equal(state.states.some(value => value.state === "running"), false);
    } finally { vscode.workspace.isTrusted = true; }
  }
});

test("a superseding save/settings scan aborts its old scan without canceling or replacing the new results", async () => {
  let oldId, finishOld;
  const state = manager((_method, params) => {
    oldId ||= params.scanId;
    if (params.scanId !== oldId) return page([suite("fresh")], null, 1, 1, 1, 2);
    return params.continuation ? new Promise(resolve => { finishOld = resolve; }) : page([suite("old")], "next", 1, 1, 1, 2);
  });
  const old = state.workspace.discover(state.root);
  await tick();
  await state.workspace.discover(state.root);
  finishOld(page([suite("outdated")], null, 2, 2, 2, 4));
  await old;
  assert.deepEqual([...state.controller.items.keys()], [`${workspaceUri}/fresh.robot`]);
  assert.deepEqual(state.backend.notifications, [[CANCEL_DISCOVERY_METHOD, { workspaceUri, scanId: oldId }]]);
});

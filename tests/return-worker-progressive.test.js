const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {Worker} = require("node:worker_threads");
const {createHash} = require("node:crypto");
const api = require("../src/core/return-worker.js").__test__;

const filename = path.join(__dirname, "../src/core/return-worker.js");
const fingerprint = snapshot => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const payload = (extra = {}) => ({
  variableToken: "${record}", rootTypeNames: ["Record"], maxDepth: 1,
  maxFieldsPerType: 0, technicalMaxDepth: 4, technicalMaxFieldsPerType: 20,
  includeTechnical: false, ...extra
});
function snapshot(rootField = "child", deepField = "value") {
  const types = [
    {name: "Record", filePath: "/workspace/record.py", modulePath: "record", qualifiedName: "record.Record",
      isDataclass: true, fields: [{name: rootField, annotation: "Deep"}]},
    {name: "Deep", filePath: "/workspace/deep.py", modulePath: "deep", qualifiedName: "deep.Deep",
      isDataclass: true, fields: [{name: deepField, annotation: "str"}]}
  ];
  return {
    structuredTypesByName: types.map(type => [type.name, [type]]),
    structuredTypesByQualifiedNameKeys: types.map(type => type.qualifiedName),
    moduleInfoByFile: types.map(type => [type.filePath, {modulePath: type.modulePath, packagePath: ""}]),
    localStructuredTypeNamesByFile: types.map(type => [type.filePath, [type.name]])
  };
}
function entry(source = snapshot()) {
  return {index: api.hydrateReturnWorkerIndexSnapshot(source), maxTypeCacheEntries: 50,
    typePreviewCache: new Map(), typePreviewCacheKeysByFilePath: new Map()};
}
function client(t) {
  const worker = new Worker(filename);
  const pending = new Map();
  let id = 0;
  worker.on("message", response => {
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);clearTimeout(request.timer);
    if (response.error) request.reject(Error(response.error));
    else request.resolve(response.result);
  });
  worker.on("error", error => {
    for (const request of pending.values()) {clearTimeout(request.timer);request.reject(error);}
    pending.clear();
  });
  t.after(async () => {
    for (const request of pending.values()) {clearTimeout(request.timer);request.reject(Error("worker disposed"));}
    pending.clear();await worker.terminate();
  });
  return {
    request(type, data) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {pending.delete(requestId);reject(Error("worker response timed out"));}, 5000);
        pending.set(requestId, {resolve, reject, timer});worker.postMessage({id: requestId, type, payload: data});
      });
    },
    set(source, generation = 1, workspaceKey = "file:///workspace") {
      return this.request("setWorkspaceIndex", {workspaceKey, generation, snapshot: source,
        cacheFingerprint: fingerprint(source), maxTypeCacheEntries: 50});
    },
    preview(options = {}, generation = 1, workspaceKey = "file:///workspace") {
      return this.request("computeReturnPreview", {workspaceKey, generation, payload: payload(options)});
    }
  };
}

test("first-level preview and members do not inspect an unavailable deeper structure", () => {
  const workspace = entry();
  const deep = workspace.index.structuredTypesByName.get("Deep")[0];
  let reads = 0;
  Object.defineProperty(deep, "fields", {get() {reads++;throw Error("deep structure is not ready");}});
  const first = api.computeReturnPreviewFromSnapshot(workspace, payload());
  assert.deepEqual(first.simpleAccess.firstLevel, ["${record.child}"]);
  assert.deepEqual(first.technicalStructureLines, []);
  assert.equal(reads, 0, "a shallow display must not wait for deeper fields");
  const members = api.computeReturnMemberCompletionsFromSnapshot(workspace, payload({completionMaxDepth: 1}));
  assert.ok(members.members.some(member => member.label === "child" || member.name === "child"));
  assert.equal(reads, 0);
  assert.throws(() => api.computeReturnPreviewFromSnapshot(workspace, payload({includeTechnical: true})), /not ready/);
  assert.ok(reads > 0);
  const again = api.computeReturnPreviewFromSnapshot(workspace, payload({variableToken: "${other}"}));
  assert.deepEqual(again.simpleAccess.firstLevel, ["${other.child}"]);
  assert.equal(workspace.typePreviewCache.size, 1, "failed deeper work must preserve the shared shallow entry");
});

test("real worker fills the same entry lazily and shares it with return-member completion", async t => {
  const worker = client(t);await worker.set(snapshot());
  const first = await worker.preview();
  assert.deepEqual(first.simpleAccess.firstLevel, ["${record.child}"]);
  assert.deepEqual(first.cacheWrite.entry.technicalStructureLines, []);
  assert.equal(first.cacheWrite.entry.technicalReady, false);
  assert.ok(first.dependencyFilePaths.includes("/workspace/deep.py"),
    "the declared child type identity is a dependency without expanding its fields");
  const full = await worker.preview({includeTechnical: true});
  assert.equal(full.cacheWrite.key, first.cacheWrite.key);
  assert.equal(full.cacheWrite.entry.technicalReady, true);
  assert.ok(full.technicalStructureLines.some(line => line.includes(".value")));
  assert.ok(full.cacheWrite.entry.dependencyFilePaths.includes("/workspace/deep.py"));
  const members = await worker.request("computeReturnMemberCompletions", {
    workspaceKey: "file:///workspace", generation: 1,
    payload: payload({completionMaxDepth: 1})
  });
  assert.equal(members.cacheWrite, undefined);
  const again = await worker.preview({includeTechnical: true, variableToken: "${other}"});
  assert.equal(again.cacheWrite, undefined);
  assert.deepEqual(again.simpleAccess.firstLevel, ["${other.child}"]);
  assert.deepEqual(again.technicalStructureLines, full.technicalStructureLines);
});

test("persisted shallow and completed technical entries retain their distinct readiness", async t => {
  const source = snapshot(),firstClient = client(t);await firstClient.set(source);
  const shallow = await firstClient.preview();
  const second = client(t);await second.set(source);
  await second.request("hydrateTypePreviewCache", {workspaceKey: "file:///workspace", generation: 1,
    cacheFingerprint: fingerprint(source), entries: [shallow.cacheWrite]});
  const resumed = await second.preview({includeTechnical: true});
  assert.ok(resumed.technicalStructureLines.some(line => line.includes(".value")));
  assert.equal(resumed.cacheWrite.entry.technicalReady, true);
  await second.request("hydrateTypePreviewCache", {workspaceKey: "file:///workspace", generation: 1,
    cacheFingerprint: fingerprint(source), entries: [shallow.cacheWrite]});
  assert.equal((await second.preview({includeTechnical: true})).cacheWrite, undefined,
    "a late shallow disk entry must not downgrade completed live technical work");
  const third = client(t);await third.set(source);
  await third.preview(); // An already-live shallow entry may be upgraded.
  await third.request("hydrateTypePreviewCache", {workspaceKey: "file:///workspace", generation: 1,
    cacheFingerprint: fingerprint(source), entries: [resumed.cacheWrite]});
  const ready = await third.preview({includeTechnical: true});
  assert.equal(ready.cacheWrite, undefined);
  assert.deepEqual(ready.technicalStructureLines, resumed.technicalStructureLines);
});

test("changed source fingerprint invalidates warm simple and deep data without a file notification", async t => {
  const worker = client(t),old = snapshot();await worker.set(old);
  await worker.preview({includeTechnical: true});
  const changed = snapshot("updated", "fresh");await worker.set(changed, 2);
  const next = await worker.preview({includeTechnical: true}, 2);
  assert.deepEqual(next.simpleAccess.firstLevel, ["${record.updated}"]);
  assert.ok(next.technicalStructureLines.some(line => line.includes(".fresh")));
  assert.ok(!next.technicalStructureLines.some(line => line.includes(".value")));
  assert.ok(next.cacheWrite, "new content cannot reuse old cached presentation");
  assert.equal(await worker.preview({}, 1), undefined, "old generations cannot receive current metadata");
});

test("out-of-order snapshots cannot roll back a newer generation and workspaces stay isolated", async t => {
  const worker = client(t),old = snapshot(),current = snapshot("newest");
  await worker.set(current, 3);assert.equal(await worker.set(old, 2), false);
  assert.deepEqual((await worker.preview({}, 3)).simpleAccess.firstLevel, ["${record.newest}"]);
  await worker.set(snapshot("other"), 3, "file:///other");
  assert.deepEqual((await worker.preview({}, 3, "file:///other")).simpleAccess.firstLevel, ["${record.other}"]);
  assert.deepEqual((await worker.preview({}, 3)).simpleAccess.firstLevel, ["${record.newest}"]);
  await worker.request("clearWorkspace", {workspaceKey: "file:///workspace"});
  assert.equal(await worker.preview({}, 3), undefined);
  assert.ok(await worker.preview({}, 3, "file:///other"));
});

test("delayed persisted data cannot replace a current source fingerprint", async t => {
  const worker = client(t),old = snapshot();await worker.set(old);
  const cached = await worker.preview({includeTechnical: true});
  const current = snapshot("current");await worker.set(current, 2);
  const fresh = await worker.preview({}, 2);
  assert.equal(await worker.request("hydrateTypePreviewCache", {
    workspaceKey: "file:///workspace", generation: 2,
    cacheFingerprint: fingerprint(old), maxTypeCacheEntries: 5000, entries: [cached.cacheWrite]
  }), false);
  const after = await worker.preview({}, 2);
  assert.deepEqual(after.simpleAccess.firstLevel, ["${record.current}"]);
  assert.equal(after.cacheWrite, undefined, "rejected old persistence must leave current cache untouched");
  assert.deepEqual(after.simpleAccess, fresh.simpleAccess);
  for (let index = 0; index < 65; index++) {
    await worker.preview({technicalMaxDepth: index + 10}, 2);
  }
  assert.ok((await worker.preview({}, 2)).cacheWrite,
    "rejected hydration cannot expand the current 50-entry cache limit");
});

test("same fingerprint reuses completed work while per-file invalidation evicts dependency-linked entries", async t => {
  const worker = client(t),source = snapshot();await worker.set(source);
  await worker.preview({includeTechnical: true});await worker.set(source, 2);
  assert.equal((await worker.preview({includeTechnical: true}, 2)).cacheWrite, undefined);
  assert.equal(await worker.request("invalidateTypePreviewByFiles", {
    workspaceKey: "file:///workspace", filePaths: ["/workspace/unrelated.py"]}), false);
  assert.equal((await worker.preview({}, 2)).cacheWrite, undefined);
  assert.equal(await worker.request("invalidateTypePreviewByFiles", {
    workspaceKey: "file:///workspace", filePaths: ["/workspace/deep.py"]}), true);
  assert.ok((await worker.preview({}, 2)).cacheWrite);
});

test("first-level work does not expand a broad nested tree and the shared store remains bounded", () => {
  const workspace = entry();
  const root = workspace.index.structuredTypesByName.get("Record")[0];
  root.fields = Array.from({length: 40}, (_, i) => ({name: "child" + i, annotation: "Deep"}));
  const deep = workspace.index.structuredTypesByName.get("Deep")[0];
  let reads = 0;
  const fields = deep.fields;
  Object.defineProperty(deep, "fields", {get() {reads++;return fields;}});
  const first = api.computeReturnPreviewFromSnapshot(workspace, payload());
  assert.equal(first.simpleAccess.firstLevel.length, 40);
  assert.equal(reads, 0);
  for (let index = 0; index < 65; index++) {
    api.computeReturnPreviewFromSnapshot(workspace, payload({technicalMaxDepth: index + 1}));
  }
  assert.equal(workspace.typePreviewCache.size, 50);
  const keys = new Set(workspace.typePreviewCache.keys());
  for (const dependencyKeys of workspace.typePreviewCacheKeysByFilePath.values()) {
    assert.ok([...dependencyKeys].every(key => keys.has(key)), "eviction must also clear dependency back-references");
  }
});

test("warm shallow, technical and member responses expose independent dependency vectors", async t => {
  const worker = client(t);await worker.set(snapshot());
  const first = await worker.preview();
  assert.deepEqual(first.dependencyFilePaths.sort(), ["/workspace/deep.py", "/workspace/record.py"]);
  const warm = await worker.preview();assert.equal(warm.cacheWrite, undefined);
  assert.deepEqual(warm.dependencyFilePaths.sort(), first.dependencyFilePaths);
  const full = await worker.preview({includeTechnical: true});
  assert.deepEqual(full.dependencyFilePaths.sort(), first.dependencyFilePaths);
  const fullWarm = await worker.preview({includeTechnical: true});assert.equal(fullWarm.cacheWrite, undefined);
  assert.deepEqual(fullWarm.dependencyFilePaths.sort(), first.dependencyFilePaths);
  const members = await worker.request("computeReturnMemberCompletions", {
    workspaceKey: "file:///workspace", generation: 1, payload: payload({completionMaxDepth: 1})
  });
  assert.equal(members.cacheWrite, undefined);
  assert.deepEqual(members.dependencyFilePaths.sort(), first.dependencyFilePaths);
  const shared = entry();
  const returned = api.computeReturnPreviewFromSnapshot(shared, payload());
  returned.dependencyFilePaths.push("/not-a-dependency.py");
  assert.ok(!api.computeReturnPreviewFromSnapshot(shared, payload()).dependencyFilePaths.includes("/not-a-dependency.py"));
  const memberReply = api.computeReturnMemberCompletionsFromSnapshot(shared, payload({completionMaxDepth: 1}));
  memberReply.dependencyFilePaths.length = 0;
  assert.ok(api.computeReturnPreviewFromSnapshot(shared, payload()).dependencyFilePaths.length > 0);
});

test("selected roots and bases remain dependencies when they emit no own fields", () => {
  const source = snapshot();
  const root = source.structuredTypesByName[0][1][0];root.fields = [];root.baseTypeNames = ["Deep"];
  const workspace = entry(source);
  const inherited = api.computeReturnPreviewFromSnapshot(workspace, payload());
  assert.deepEqual(inherited.simpleAccess.firstLevel, ["${record.value}"]);
  assert.deepEqual(inherited.dependencyFilePaths.sort(), ["/workspace/deep.py", "/workspace/record.py"]);
  root.baseTypeNames = [];
  const empty = api.computeReturnPreviewFromSnapshot(entry(source), payload());
  assert.deepEqual(empty.simpleAccess.firstLevel, []);
  assert.deepEqual(empty.dependencyFilePaths, ["/workspace/record.py"]);
});

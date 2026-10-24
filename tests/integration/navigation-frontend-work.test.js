"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const sourceRoot = process.env.RCB_NAV_SOURCE || path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(sourceRoot, "src/core/extension.js"), "utf8");
function production(begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `Production source boundaries: ${begin}`);
  return source.slice(start, finish);
}

function snapshotFixture(initialGeneration) {
  const calls = { serialized: 0, hashed: 0, uploaded: [], hydrated: [] };
  let generation = initialGeneration;
  const context = {
    vscode: { workspace: { getWorkspaceFolder: () => ({ uri: { toString: () => "file:///workspace" } }) } },
    serializeReturnWorkerIndexSnapshot: value => { calls.serialized++; return { marker: value.marker }; },
    computeReturnWorkerSnapshotFingerprint: value => { calls.hashed++; return `fingerprint-${value.marker}`; },
    getReturnTypeCacheMaxEntries: () => 400,
    isReturnTypeDiskCacheEnabled: () => true
  };
  const method = production("  async _ensureWorkspaceSnapshot(document, index) {", "  async _hydrateWorkspaceTypeCacheFromDisk(");
  vm.runInNewContext(`class Subject { ${method} }; globalThis.Subject = Subject;`, context);
  const worker = new context.Subject();
  Object.assign(worker, { _isAvailable: true, _worker: {},
    _enumHintService: { getGenerationForDocument: () => generation },
    _snapshotGenerationByWorkspace: new Map(), _snapshotFingerprintByWorkspace: new Map(),
    _postRequest: async (method, payload) => calls.uploaded.push({ method, payload }),
    _hydrateWorkspaceTypeCacheFromDisk: async (...args) => calls.hydrated.push(args) });
  const document = { uri: { toString: () => "file:///workspace/sample.robot" } };
  return { calls, worker, document, setGeneration: value => { generation = value; } };
}

for (const generation of [0, 1]) {
  test(`workspace snapshot generation ${generation} serializes/hashes/uploads once, then refreshes exactly once on change`, async () => {
    const f = snapshotFixture(generation);
    const first = await f.worker._ensureWorkspaceSnapshot(f.document, { marker: "original" });
    for (let count = 0; count < 20; count++) {
      const warm = await f.worker._ensureWorkspaceSnapshot(f.document, { marker: "original" });
      assert.equal(warm.cacheFingerprint, first.cacheFingerprint);
    }
    assert.equal(f.calls.serialized, 1, "Warm requests must not serialize the entire index again");
    assert.equal(f.calls.hashed, 1);
    assert.equal(f.calls.uploaded.length, 1);
    assert.equal(f.calls.hydrated.length, 1);
    assert.equal(f.calls.uploaded[0].method, "setWorkspaceIndex");
    f.setGeneration(generation + 1);
    const changed = await f.worker._ensureWorkspaceSnapshot(f.document, { marker: "changed" });
    assert.equal(changed.generation, generation + 1);
    assert.equal(changed.cacheFingerprint, "fingerprint-changed");
    assert.equal(f.calls.serialized, 2);
    assert.equal(f.calls.hashed, 2);
    assert.equal(f.calls.uploaded.length, 2);
    assert.equal(f.calls.hydrated.length, 2);
  });
}

function enumFixture({ owned = true, cacheValue } = {}) {
  const calls = { index: 0, definitions: 0, cache: 0, normal: 0 };
  const target = { owned, returnDefinition: { parameters: new Map([["mode", "AuthoritativeMode"]]),
    localEnumNames: new Set(), enumImportAliases: new Map() } };
  const index = { keywordArgAnnotations: new Map([["step", new Map([["mode", ["WrongLegacyMode"]]])]]),
    keywordArgs: new Map(), enumsByName: new Map() };
  const context = {
    isHoverCancellationRequested: token => Boolean(token?.isCancellationRequested),
    usesOwnedLanguage: () => owned,
    buildEnumPreviewContextCacheKey: () => "fixture-key",
    resolveNamedArgumentCurrentValueFromSetVariable: () => ({ kind: "single", value: "CURRENT", candidates: [] }),
    resolveReturnHintForArgumentValue: async () => undefined,
    normalizeKeywordName: () => "step", normalizeArgumentName: value => value,
    resolveOwnedKeywordSource: async () => { calls.definitions++; return target; },
    resolveEnumNamesFromAnnotation: () => [], isEnumArgumentFallbackEnabled: () => false,
    uniqueStrings: values => [...new Set(values)], getEnumHoverMaxEnums: () => 4, getEnumHoverMaxMembers: () => 20
  };
  const code = production("async function resolveEnumValuePreviewFromContext(", "function doesEnumContainValue(");
  vm.runInNewContext(`${code}; globalThis.resolve = resolveEnumValuePreviewFromContext;`, context);
  const document = { uri: { toString: () => "file:///workspace/sample.robot" } };
  const hints = { getIndexForDocument: async () => { calls.index++; return index; } };
  const runtimeCache = { ensureState: () => ({}), getCachedValue: () => { calls.cache++; return cacheValue; },
    getOrCompute: async (_state, _bucket, _key, compute) => { calls.normal++; return compute(); } };
  const argument = { keywordName: "Step", argumentName: "mode", argumentValue: "CURRENT" };
  const resolve = options => context.resolve(document, hints, argument, { parsed: {}, referenceLine: 2, runtimeCache,
    ...options });
  return { resolve, calls };
}

test("owned cache-only enum phase sends zero native definitions; normal phase retains the authoritative argument type", async () => {
  const f = enumFixture();
  assert.equal(await f.resolve({ cacheOnly: true }), undefined);
  assert.equal(f.calls.index, 0);
  assert.equal(f.calls.definitions, 0, "Passive cache probe cannot put a source request ahead of F12");
  const normal = await f.resolve({ cacheOnly: false });
  assert.deepEqual([...normal.annotationHints], ["AuthoritativeMode"]);
  assert.equal(normal.currentValue, "CURRENT");
  assert.equal(normal.definitionSource.owned, true);
  assert.equal(f.calls.index, 1);
  assert.equal(f.calls.definitions, 1, "Only the authoritative normal phase requests the native source");
  assert.equal(await f.resolve({ cacheOnly: true }), undefined, "Owned source information is never served from the legacy cache");
  assert.equal(f.calls.definitions, 1);
});

test("legacy cache-only hits remain available, and an uncached probe never reads the source index", async () => {
  const hit = { annotationHints: ["CachedMode"] }, cached = enumFixture({ owned: false, cacheValue: hit });
  assert.equal(await cached.resolve({ cacheOnly: true }), hit);
  assert.equal(cached.calls.cache, 1);
  assert.equal(cached.calls.index, 0);
  const miss = enumFixture({ owned: false });
  assert.equal(await miss.resolve({ cacheOnly: true }), undefined);
  assert.equal(miss.calls.index, 0);
  const normal = await miss.resolve({ cacheOnly: false });
  assert.deepEqual([...normal.annotationHints], ["WrongLegacyMode"], "Legacy normal lookup is preserved");
  assert.equal(miss.calls.normal, 1);
  assert.equal(miss.calls.index, 1);
  const withoutState = enumFixture({ owned: false });
  assert.equal(await withoutState.resolve({ cacheOnly: true, runtimeCache: undefined }), undefined);
  assert.equal(withoutState.calls.index, 0, "Cache-only without a cache cannot start normal source work");
});

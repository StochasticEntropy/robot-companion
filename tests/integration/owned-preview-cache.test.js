"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../src/core/extension.js"), "utf8");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const key = (context, depth, fields, technical) => JSON.stringify([context.variableToken.token, context.assignment.startLine, depth, fields, technical]);
function fixture() {
  let calls = 0;
  const document = { version: 1, uri: { toString: () => "file:///example.robot" } };
  const assignments = ["${alpha}", "${beta}", "${gamma}"].map((token, line) => ({ ownerId: "example", startLine: line,
    keywordName: "Build Result", returnVariables: [token] }));
  const parsed = { uri: document.uri.toString(), version: 1, keywordCallAssignments: assignments };
  const owner = { id: "example", name: "Example" };
  const state = { parsedVersion: 1, indexGeneration: 1, settingsSignature: "settings", buckets: {},
    lookups: { ownerById: new Map([[owner.id, owner]]) }, lastPrewarmSignature: "" };
  const context = { Map, console, setTimeout, clearTimeout, Date,
    RUNTIME_CACHE_MAX_ENTRIES_PER_BUCKET: 100, RUNTIME_HTML_CACHE_MAX_ENTRIES: 100,
    buildReturnPreviewMarkdown: value => `Members for ${value.variableToken.token}`,
    buildReturnPreviewSegments: value => [{ lines: [`Members for ${value.variableToken.token}`] }],
    getReturnExplorerDetailsSegments: state => [{ documentation: false, markdown: state.detailsMarkdown }],
    renderReturnExplorerDetailsSegmentsHtml: async segments => `<p>${segments[0].markdown}</p>`, PREWARM_RESUME_CHECK_MS: 1,
    INTERACTIVE_IDLE_WAIT_MS: 1, BACKGROUND_TASK_MAX_WAIT_MS: 1,
    usesOwnedLanguage: () => true, getReturnPreviewMaxDepth: () => 4, getReturnMaxFieldsPerType: () => 20,
    buildReturnContextCacheKey: key, delay: () => Promise.resolve(),
    isHoverCancellationRequested: token => token?.isCancellationRequested,
    getKeywordReturnVariableContextAtPosition: (_document, _parsed, position) => ({ owner,
      variableToken: { token: assignments[position.line].returnVariables[0] }, assignment: assignments[position.line] }),
    resolveKeywordReturnPreviewFromVariableContext: async (_document, _parsed, variable, _service, options) => {
      calls += 1; const version = document.version;
      return { ...variable, options, definitionSource: { identity: { status: "resolved", current: () => document.version === version } } };
    } };
  const a = source.indexOf("class RobotRuntimeCacheService {");
  const b = source.indexOf("class RobotDocCodeLensProvider {", a);
  const c = source.indexOf("async function resolveKeywordReturnPreview(");
  const d = source.indexOf("async function resolveKeywordReturnPreviewFromVariableContext(", c);
  vm.runInNewContext(`${source.slice(a, b)}\n${source.slice(c, d)};globalThis.Cache=RobotRuntimeCacheService;globalThis.resolve=resolveKeywordReturnPreview;`, context);
  const cache = new context.Cache({ getIndexForDocument: async () => ({}) }, {});
  cache.ensureState = () => state; cache._shouldPausePrewarm = () => false;
  return { context, cache, document, parsed, state, calls: () => calls };
}

test("owned prewarm fills every variable's first-level shared bucket without technical expansion", async () => {
  const { cache, document, parsed, state, calls } = fixture();
  assert.equal(await cache._prewarmDocument(document, { getParsed: () => parsed }), true);
  assert.equal(calls(), 3);
  assert.equal(state.buckets.returnPreview.size, 3);
  for (const { value } of state.buckets.returnPreview.values()) {
    assert.equal(value.options.maxDepth, 1);
    assert.equal(value.options.includeTechnical, false);
  }
  await cache._prewarmDocument(document, { getParsed: () => parsed });
  assert.equal(calls(), 3, "Same prewarm signature must not repeat the work");
});

test("owned cache-only is a genuine no-RPC pending snapshot, normal access always revalidates current source", async () => {
  const { cache, document, parsed, context, calls } = fixture();
  const options = { runtimeCache: cache, maxDepth: 1, maxFieldsPerType: 20, includeTechnical: false };
  assert.equal(await context.resolve(document, parsed, { line: 0 }, {}, { ...options, cacheOnly: true }), undefined);
  assert.equal(calls(), 0);
  await cache._prewarmDocument(document, { getParsed: () => parsed });
  const snapshot = await context.resolve(document, parsed, { line: 0 }, {}, { ...options, cacheOnly: true });
  assert.equal(snapshot.presentationSnapshot, true); assert.equal(calls(), 3);
  await context.resolve(document, parsed, { line: 0 }, {}, options);
  assert.equal(calls(), 4, "A retained presentation must not bypass fresh authoritative resolution");
  document.version += 1;
  assert.equal(await context.resolve(document, parsed, { line: 0 }, {}, { ...options, cacheOnly: true }), undefined);
  assert.equal(calls(), 4, "Stale identity must never be presented as a valid cache hit");
});

test("invalidated old in-flight fills cannot resurrect or delete a replacement cache entry", async () => {
  for (const reject of [false, true]) {
    const { cache, state } = fixture(); const first = deferred();
    const old = cache.getOrCompute(state, "returnPreview", "binding", () => first.promise, { referenceLine: 2 });
    await Promise.resolve(); cache._invalidateStateBucketsFromLine(state, 2);
    await cache.getOrCompute(state, "returnPreview", "binding", () => "current", { referenceLine: 2 });
    if (reject) first.reject(new Error("obsolete failure")); else first.resolve("obsolete");
    await old.catch(() => undefined);
    assert.equal(cache.getCachedValue(state, "returnPreview", "binding"), "current");
  }
});

test("mandatory deferred deep work executes after its idle deadline instead of silently disappearing", async () => {
  const { cache } = fixture(); cache._isInteractiveHot = () => true;
  let calls = 0;
  await cache.runWhenInteractiveIdle(() => { calls += 1; }, 0, true);
  assert.equal(calls, 1);
  await cache.runWhenInteractiveIdle(() => { calls += 1; }, 0, false);
  assert.equal(calls, 1, "Other optional background jobs keep their existing idle policy");
});

test("a completed full presentation survives its old consumer cancellation but not a changed source context", async () => {
 const {cache,document,parsed,state,context,calls}=fixture();
 const variable={variableToken:{token:"${alpha}"},assignment:parsed.keywordCallAssignments[0]};
 let valid=true;
 const full={...variable,technicalPending:false,technicalStructureLines:["complete"],
   definitionSource:{identity:{status:"resolved",current:()=>false},presentationCurrent:()=>valid}};
 cache.storeValue(state,"returnPreview",key(variable,4,20,true),full,{});
 const options={runtimeCache:cache,maxDepth:1,maxFieldsPerType:20,includeTechnical:false,cacheOnly:true};
 const warm=await context.resolve(document,parsed,{line:0},{},options);
 assert.equal(warm.presentationSnapshot,true);assert.equal(warm.technicalPending,false);assert.deepEqual(warm.technicalStructureLines,["complete"]);
 assert.equal(calls(),0,"Warm presentation must not fetch just because the old consumer cancelled");
 valid=false;
 assert.equal(await context.resolve(document,parsed,{line:0},{},options),undefined,"Root/environment/document invalidation still clears provisional metadata");
});

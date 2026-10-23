"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, ...rest) {
  return name === "vscode" ? { SemanticTokens: class { constructor(data, resultId) { Object.assign(this, { data, resultId }); } } }
    : load.call(this, name, ...rest);
};
const { LanguageWorkspace } = require("../../src/integration/language-workspace");
Module._load = load;

const DELTA = "textDocument/semanticTokens/full/delta", FULL = "textDocument/semanticTokens/full";
const legend = { tokenTypes: ["function"], tokenModifiers: [] };
const uri = "file:///workspace/suite.robot";
const initial = { resultId: "previous", data: Uint32Array.from([0, 0, 3, 0, 0]) };
function fixture(request) {
  const state = { methods: [], logs: [], available: true };
  const root = { native: false, documents: new Map([[uri, 1]]), semanticResults: new Map([[uri, initial]]),
    session: { capabilities: { semanticTokensProvider: {} }, request: async (method, params, options) => {
      state.methods.push(method);
      return request(method, params, options, state);
    } } };
  const workspace = Object.create(LanguageWorkspace.prototype);
  Object.assign(workspace, { rootFor: () => root, usable: () => state.available, open() {},
    channel: { appendLine: text => state.logs.push(text) } });
  const document = { uri: { toString: () => uri }, version: 1, isClosed: false, isDirty: false, getText: () => "Log" };
  return { workspace, root, document, state };
}

test("each timed-out delta ends without a second full request or an invented result", async () => {
  const { workspace, root, document, state } = fixture(async method => {
    if (method === DELTA) throw new Error(`LSP request '${method}' timed out.`);
    return { resultId: "unexpected-retry", data: [0, 0, 3, 0, 0] };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await workspace.semanticTokens(document, undefined, legend, undefined, "previous"), undefined);
  }
  assert.deepEqual(state.methods, [DELTA, DELTA, DELTA], "one failed request must not immediately enqueue another expensive analysis");
  assert.equal(root.semanticResults.get(uri), initial, "no failed request replaces the last validated base");
  assert.equal(state.logs.filter(text => text.includes("timed out")).length, 3);
});

test("backend unavailability or a server refusal does not trigger a full request", async () => {
  for (const message of ["Language backend is not running.", "Server stopped.", "Analysis request failed."]) {
    const { workspace, document, state } = fixture(async () => { throw new Error(message); });
    assert.equal(await workspace.semanticTokens(document, undefined, legend, undefined, "previous"), undefined);
    assert.deepEqual(state.methods, [DELTA], message);
    assert.ok(state.logs[0].includes(message));
  }
});

test("cancellation during a delta and a reply from an unusable root enqueue no fallback", async () => {
  let cancel;
  const token = { isCancellationRequested: false, onCancellationRequested: callback => {
    cancel = () => { token.isCancellationRequested = true; callback(); };
    return { dispose() {} };
  } };
  const { workspace, document, state } = fixture(async (_method, _params, { signal }) => {
    cancel();
    assert.equal(signal.aborted, true);
    throw new Error("LSP request cancelled.");
  });
  assert.equal(await workspace.semanticTokens(document, undefined, legend, token, "previous"), undefined);
  assert.deepEqual(state.methods, [DELTA]);
  assert.deepEqual(state.logs, [], "expected cancellation is not reported as a backend failure");
  const stale = fixture(async (_method, _params, _options, state) => {
    state.available = false;
    return { resultId: "late", edits: [] };
  });
  assert.equal(await stale.workspace.semanticTokens(stale.document, undefined, legend, undefined, "previous"), undefined);
  assert.deepEqual(stale.state.methods, [DELTA]);
});

test("an invalid delta payload still falls back once to a validated whole result", async () => {
  const { workspace, root, document, state } = fixture(async method => method === DELTA
    ? { resultId: "bad", edits: [{ start: 10, deleteCount: 0, data: [] }] }
    : { resultId: "fresh", data: [0, 0, 3, 0, 0] });
  const result = await workspace.semanticTokens(document, undefined, legend, undefined, "previous");
  assert.equal(result.resultId, "fresh");
  assert.deepEqual(state.methods, [DELTA, FULL]);
  assert.equal(root.semanticResults.get(uri).resultId, "fresh");
  assert.match(state.logs[0], /Semantic token edits refused, requesting all tokens/);
});

test("a different editor result ID requests a whole result without attempting an incompatible delta", async () => {
  const { workspace, document, state } = fixture(async () => ({ resultId: "fresh", data: [0, 0, 3, 0, 0] }));
  const result = await workspace.semanticTokens(document, undefined, legend, undefined, "editor-older-result");
  assert.equal(result.resultId, "fresh");
  assert.deepEqual(state.methods, [FULL]);
});

test("valid edits and a server whole-result response to a delta need no extra request", async () => {
  for (const reply of [{ resultId: "edited", edits: [] }, { resultId: "whole", data: [0, 0, 3, 0, 0] }]) {
    const { workspace, root, document, state } = fixture(async () => reply);
    const result = await workspace.semanticTokens(document, undefined, legend, undefined, "previous");
    assert.equal(result.resultId, reply.resultId);
    assert.deepEqual(state.methods, [DELTA]);
    assert.equal(root.semanticResults.get(uri).resultId, reply.resultId);
  }
});

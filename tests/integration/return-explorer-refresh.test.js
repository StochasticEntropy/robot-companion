"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sourceRoot = process.env.RCB_REFRESH_SOURCE || path.resolve(__dirname, "../..");
const disposable = () => ({ dispose() {} });
const tokenSources = new WeakMap();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
class CancellationTokenSource {
  constructor() {
    this.disposed = false;
    this.listeners = [];
    this.token = { isCancellationRequested: false,
      onCancellationRequested: callback => { this.listeners.push(callback); return disposable(); } };
    tokenSources.set(this.token, this);
  }
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    for (const listener of this.listeners) listener();
  }
  dispose() { this.disposed = true; }
}

function controllerFixture({ enumEnabled = false, returnResolver, docResolver } = {}) {
  const source = fs.readFileSync(path.join(sourceRoot, "src/core/extension.js"), "utf8");
  const begin = source.indexOf("class RobotReturnExplorerController {");
  const end = source.indexOf("function buildReturnPreviewMarkdown", begin);
  assert.ok(begin >= 0 && end > begin, "Extract the actual production controller");
  const calls = { enum: [], returns: [], docs: [], applied: [], updates: [] };
  const vscode = {
    CancellationTokenSource,
    window: { activeTextEditor: undefined, onDidChangeActiveTextEditor: disposable,
      onDidChangeTextEditorSelection: disposable },
    workspace: { onDidChangeTextDocument: disposable, onDidOpenTextDocument: disposable,
      onDidCloseTextDocument: disposable }
  };
  const context = {
    vscode, console, setTimeout, clearTimeout, Date,
    shouldPauseRobotCompanionInteractiveUiForDebug: () => false,
    isReturnExplorerEnabled: () => true,
    isRobotDocument: document => document.languageId === "robotframework",
    createEmptyReturnPreviewState: infoMessage => ({ infoMessage }),
    isEnumValueHoverEnabled: () => enumEnabled,
    getEnumHoverMaxEnums: () => 10, getEnumHoverMaxMembers: () => 20,
    getReturnPreviewMaxDepth: () => 3, getReturnMaxFieldsPerType: () => 20,
    getKeywordReturnVariableContextAtPosition: () => undefined,
    resolveEnumValuePreview: async (...args) => { calls.enum.push(args); },
    resolveKeywordReturnPreview: async (...args) => {
      calls.returns.push(args);
      return returnResolver?.(...args);
    },
    resolveKeywordDocumentationPreview: async (...args) => {
      calls.docs.push(args);
      return docResolver?.(...args);
    },
    buildKeywordDocPreviewSegments: () => [], joinKeywordDocPreviewSegments: () => "",
    logRobotCompanionError() {}
  };
  vm.runInNewContext(`${source.slice(begin, end)}; globalThis.Controller = RobotReturnExplorerController;`, context);
  const controller = new context.Controller({ getParsed: document => ({ uri: document.uri.toString(),
    fileName: "example.robot", owners: [] }) }, {}, { update: state => calls.updates.push(state) },
  { markInteractiveActivity() {}, ensureState: () => ({}) }, {});
  controller._applyReturnPreviewContext = (_parsed, result) => calls.applied.push(result);
  calls.updates.length = 0;
  const editor = line => ({ document: { uri: { toString: () => "file:///example.robot" },
    languageId: "robotframework" }, selection: { active: { line, character: 4 } } });
  return { controller, calls, editor };
}

test("new selection cancels the obsolete native refresh and old return results cannot replace current", async () => {
  const old = deferred();
  const fixture = controllerFixture({ returnResolver: (_document, _parsed, position) =>
    position.line === 1 ? old.promise : { name: "current" } });
  const { controller, calls, editor } = fixture;
  try {
    const pending = controller._syncFromActiveEditor(editor(1));
    await Promise.resolve();
    const token = calls.returns[0][4].cancellationToken;
    assert.ok(token, "Native return resolution must receive the refresh token");
    await controller._syncFromActiveEditor(editor(2));
    assert.equal(token.isCancellationRequested, true);
    assert.equal(tokenSources.get(token).disposed, true);
    old.resolve({ name: "obsolete" });
    await pending;
    assert.deepEqual(calls.applied.map(value => value.name), ["current"]);
  } finally { old.resolve(undefined); controller.dispose(); }
});

test("moving away and disposal cancel pending native work and suppress late preview updates", async () => {
  for (const action of ["away", "dispose"]) {
    const old = deferred();
    const { controller, calls, editor } = controllerFixture({ returnResolver: () => old.promise });
    try {
      const pending = controller._syncFromActiveEditor(editor(1));
      await Promise.resolve();
      const token = calls.returns[0][4].cancellationToken;
      assert.ok(token, `${action} refresh has a native cancellation token`);
      if (action === "away") await controller._syncFromActiveEditor(undefined);
      else controller.dispose();
      assert.equal(token.isCancellationRequested, true, action);
      assert.equal(tokenSources.get(token).disposed, true, action);
      const updates = calls.updates.length;
      old.resolve({ name: "obsolete" });
      await pending;
      assert.deepEqual(calls.applied, [], action);
      assert.equal(calls.updates.length, updates, action);
    } finally { old.resolve(undefined); controller.dispose(); }
  }
});

test("one refresh token reaches enum, return and keyword documentation resolution", async () => {
  const { controller, calls, editor } = controllerFixture({ enumEnabled: true });
  try {
    await controller._syncFromActiveEditor(editor(1));
    const token = calls.enum[0][3].cancellationToken;
    assert.ok(token);
    assert.equal(calls.returns[0][4].cancellationToken, token);
    assert.equal(calls.docs[0][4], token);
  } finally { controller.dispose(); }
});

const vscode = {
  Uri: { parse: value => ({ scheme: "file", toString: () => value }) },
  Range: class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  Location: class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
};
const originalLoad = Module._load;
let LanguageWorkspace;
try {
  Module._load = function (name, ...rest) {
    return name === "vscode" ? vscode : originalLoad.call(this, name, ...rest);
  };
  ({ LanguageWorkspace } = require(path.join(sourceRoot, "src/integration/language-workspace")));
} finally { Module._load = originalLoad; }

test("native definition timeout is unavailable, true empty is unresolved, and fresh retry resolves", async () => {
  const manager = Object.create(LanguageWorkspace.prototype);
  const root = {};
  const document = { uri: { toString: () => "file:///example.robot" }, version: 1, isClosed: false };
  const calls = [];
  manager.generation = 1;
  manager.mode = () => "owned";
  manager.rootFor = () => root;
  manager.usable = value => value === root;
  manager.documentRequest = async (_document, method, params, token, options) => {
    calls.push({ method, params, token, options });
    if (calls.length === 1) {
      if (options?.raise) throw new Error("Native definition request timed out");
      return undefined; // documentRequest's normal provider path logs and suppresses failures.
    }
    return { root, result: calls.length === 2 ? [] : [{ uri: "file:///ExampleLibrary.py",
      range: { start: { line: 7, character: 4 }, end: { line: 7, character: 20 } } }] };
  };
  const position = { line: 4, character: 8 };
  const first = await manager.definitionIdentity(document, position);
  assert.equal(first.status, "unavailable");
  assert.match(first.message, /timed out/i);
  assert.equal(first.current(), true);
  const empty = await manager.definitionIdentity(document, position);
  assert.equal(empty.status, "unresolved");
  const resolved = await manager.definitionIdentity(document, position);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.uri, "file:///ExampleLibrary.py");
  assert.equal(resolved.range.start.line, 7);
  assert.equal(calls.length, 3, "Transient failure must not become a negative cache entry");
  for (const call of calls) {
    assert.equal(call.method, "textDocument/definition");
    assert.equal(call.options.raise, true);
  }
});

test("owned unavailable or unresolved definitions preserve native warnings without claiming absent indexed docs", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/core/extension.js"), "utf8");
  const begin = source.indexOf("function usesOwnedLanguage(document)");
  const end = source.indexOf("function dedupeKeywordDocCandidates", begin);
  assert.ok(begin >= 0 && end > begin);
  let status = "unavailable";
  const tokens = [];
  const context = {
    vscode: { Position: class Position { constructor(line, character) { this.line = line; this.character = character; } } },
    ownedDefinitionRequests: { request: (_document, _context, _position, token, load) => load(token) },
    languageWorkspace: { mode: () => "owned", definitionIdentity: async (_document, _position, token) => {
      tokens.push(token);
      return { status, message: "Native definition request timed out", current: () => true };
    } },
    findKeywordCallHeaderLine: (_document, line) => line,
    extractKeywordTokenFromRobotCallLine: () => ({ start: 4 }),
    getKeywordTokenContextAtPosition: (_document, position) => ({ keywordName: "Example Step", line: position.line }),
    isHoverCancellationRequested: token => Boolean(token?.isCancellationRequested),
    findOwnerForLine: () => undefined, normalizeKeywordName: () => "examplestep",
    dedupeKeywordDocCandidates: values => values, sortKeywordDocCandidates: values => values,
    buildNamedArgumentNavigationMapForKeywordCall: () => new Map(),
    getLeadingWhitespacePrefix: () => "    ", uniqueStrings: values => [...new Set(values)]
  };
  vm.runInNewContext(`${source.slice(begin, end)}; globalThis.resolveDocs = resolveKeywordDocumentationPreview;`, context);
  const document = { uri: { toString: () => "file:///example.robot" }, version: 1,
    lineAt: () => ({ text: "    Example Step" }) };
  const parsed = { uri: document.uri.toString(), owners: [] };
  const index = { keywordDocsByName: new Map(), keywordReturnDefinitions: new Map() };
  const service = { getIndexForDocument: async () => index };
  const token = { isCancellationRequested: false };
  for (const nextStatus of ["unavailable", "unresolved", "ambiguous"]) {
    status = nextStatus;
    const result = await context.resolveDocs(document, parsed, { line: 4, character: 6 }, service, token);
    assert.equal(result.primaryCandidate, undefined);
    assert.equal(result.candidates.length, 0);
    assert.doesNotMatch(result.warningMessage, /No indexed @keyword docstring/i);
    assert.match(result.warningMessage, status === "unavailable" ? /could not be checked.*timed out/i :
      status === "ambiguous" ? /ambiguous/i : /definition is unavailable/i);
    assert.equal(tokens.at(-1), token);
  }
  token.isCancellationRequested = true;
  assert.equal(await context.resolveDocs(document, parsed, { line: 4, character: 6 }, service, token), undefined);
  assert.equal(tokens.length, 3, "Cancelled previews must not send another native definition request");
});

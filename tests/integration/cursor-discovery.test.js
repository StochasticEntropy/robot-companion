"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const { fileURLToPath } = require("node:url");
const { LspSession } = require("../../src/integration/lsp-session");
const { nativeDescriptor } = require("../../src/integration/native-backend");
class Range {
  constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  contains(p) { return (p.line > this.start.line || p.line === this.start.line && p.character >= this.start.character) &&
    (p.line < this.end.line || p.line === this.end.line && p.character <= this.end.character); }
}
const uri = value => ({ scheme: "file", path: fileURLToPath(value), fsPath: fileURLToPath(value), toString: () => value });
const folder = { name: "Project", uri: uri("file:///workspace") };
let editor, warnings, token;
const vscode = { Range, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } }, Uri: { parse: uri }, TestTag: class { constructor(id) { this.id = id; } },
  TestRunRequest: class { constructor(include, exclude, profile) { Object.assign(this, { include, exclude, profile }); } },
  ProgressLocation: { Notification: 1 },
  window: { get activeTextEditor() { return editor; }, showWarningMessage: text => { warnings.push(text); }, withProgress: (_options, run) => run({}, token) },
  commands: { executeCommand() { throw new Error("Native cursor discovery must not delegate to the stale Test Explorer tree."); } },
  workspace: { isTrusted: true, getWorkspaceFolder: () => folder,
    getConfiguration: () => ({ get: (key, fallback) => key === "integrationMode" ? "owned" : fallback }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { TestWorkspace } = require("../../src/integration/test-workspace");
Module._load = load;
function fixture(t, options = {}) {
  warnings = []; vscode.workspace.isTrusted = true;
  const document = { uri: uri("file:///workspace/fresh.robot"), version: 1, isDirty: false };
  editor = { document, selection: { active: { line: 8, character: 4 } } };
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const state = { starts: 0, stops: 0, requests: [], runs: [] };
  t.mock.method(LspSession.prototype, "start", async () => { state.starts++; options.starting?.(); if (options.startFailure) throw new Error(options.startFailure); return { robotCompanionDiscovery: { version: 1, document: options.capability !== false } }; });
  t.mock.method(LspSession.prototype, "stop", async () => { state.stops++; });
  t.mock.method(LspSession.prototype, "request", async (_method, params) => {
    state.requests.push(params); options.changed?.(document, editor);
    if (options.failure) throw new Error(options.failure);
    if (options.empty) return { version: 1, items: [] };
    const source = options.otherFile ? "file:///workspace/another.robot" : document.uri.toString();
    const at = (start, end) => ({ start: { line: start, character: 0 }, end: { line: end, character: 30 } });
    return { version: 1, items: [{ kind: "suite", label: "Fresh", uri: source, range: at(0, 12), children: [
      { kind: "test", label: "Same * name [literal]", uri: source, range: at(1, 3) },
      { kind: "test", label: "Same * name [literal]", uri: source, range: at(7, 10) } ] }] };
  });
  const workspace = Object.create(TestWorkspace.prototype);
  Object.assign(workspace, { disposed: false, cursorOperations: new Set(), testInfo: new WeakMap(),
    roots: new Map([[folder.uri.toString(), { folder, failure: "LSP request 'robotCompanion/discoverTests' timed out.", session: { state: "stopped", stop: async () => {} } }]]),
    // The failed or pending full scan must never hold focused cursor discovery.
    queue: new Promise(() => {}), debugWorkspace: {}, channel: { appendLine() {}, append() {} },
    environments: { backend: async () => ({ input: nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
      executable: "/python", services: ["debug", "discovery"] }) }) },
    controllerFor: () => ({ createTestItem: (id, label, source) => ({ id, label, uri: source }) }),
    run: async (request, _token, debug) => state.runs.push({ request, debug }) });
  return { workspace, state, document };
}
test("fresh-file cursor discovery recovers from initial workspace timeout with exact source, line and duplicate occurrence", async t => {
  const { workspace, state, document } = fixture(t);
  await workspace.debugAtCursor();
  assert.deepEqual([state.starts, state.stops, state.requests.length, state.runs.length], [1, 1, 1, 1]);
  assert.equal(state.requests[0].documentUri, document.uri.toString());
  const [selected] = state.runs[0].request.include;
  assert.deepEqual(workspace.testInfo.get(selected), { source: document.uri.fsPath, line: 8, tags: [], occurrence: 2,
    folderPath: folder.uri.fsPath, rpa: undefined });
  assert.equal(selected.label, "Same * name [literal]"); assert.equal(state.runs[0].debug, true);
  assert.deepEqual(warnings, []); assert.equal(workspace.cursorOperations.size, 0);
});
test("an older backend cannot silently ignore the focused filter", async t => {
  const { workspace, state } = fixture(t, { capability: false }); await workspace.debugAtCursor();
  assert.equal(state.requests.length, 0); assert.equal(state.runs.length, 0); assert.equal(state.stops, 1);
  assert.match(warnings[0], /does not support focused file discovery.*bundled backend/);
});
test("backend discovery failure names its cause instead of claiming no tests exist", async t => {
  const { workspace, state } = fixture(t, { failure: "focused parser timed out" }); await workspace.debugAtCursor();
  assert.equal(state.runs.length, 0); assert.equal(state.stops, 1); assert.match(warnings[0], /could not start.*focused parser timed out/);
});
test("a focused reply containing another file cannot launch it", async t => {
  const { workspace, state } = fixture(t, { otherFile: true }); await workspace.debugAtCursor();
  assert.equal(state.runs.length, 0); assert.match(warnings[0], /returned another file/);
});
test("a document edit or cursor move during discovery cannot launch a stale selection", async t => {
  const { workspace, state } = fixture(t, { changed: document => { document.version++; } }); await workspace.debugAtCursor();
  assert.equal(state.runs.length, 0); assert.equal(state.stops, 1); assert.match(warnings[0], /document or cursor changed/);
});
test("trust refusal, failed save and pre-cancellation start no discovery or debugger", async t => {
  const { workspace, state, document } = fixture(t);
  vscode.workspace.isTrusted = false; await workspace.debugAtCursor(); assert.match(warnings.at(-1), /trusted workspace/);
  vscode.workspace.isTrusted = true; document.isDirty = true; document.save = async () => false;
  await workspace.debugAtCursor(); assert.match(warnings.at(-1), /could not be saved/);
  document.isDirty = false; token.isCancellationRequested = true; await workspace.debugAtCursor(); assert.match(warnings.at(-1), /cancelled/);
  assert.equal(state.starts, 0); assert.equal(state.runs.length, 0);
});
test("environment/settings restarts and folder refreshes cancel pending cursor discovery", async t => {
  const options = {}, { workspace, state } = fixture(t, options);
  options.changed = () => { void workspace.restartFolders(new Set([folder.uri.toString()])); };
  await workspace.debugAtCursor();
  assert.equal(state.runs.length, 0); assert.match(warnings.at(-1), /cancelled/);
  assert.ok(state.stops >= 1);
  options.changed = () => { void workspace.refresh(); };
  await workspace.debugAtCursor();
  assert.equal(state.runs.length, 0); assert.match(warnings.at(-1), /cancelled/);
  assert.equal(workspace.cursorOperations.size, 0);
});
test("startup failure and startup cancellation both stop the owned discovery session", async t => {
  const options = { startFailure: "initialize failed" }, { workspace, state } = fixture(t, options);
  await workspace.debugAtCursor(); assert.equal(state.stops, 1); assert.equal(state.runs.length, 0);
  assert.match(warnings.at(-1), /initialize failed/);
  options.startFailure = undefined; options.starting = () => workspace.cancelCursorDiscovery();
  await workspace.debugAtCursor(); assert.ok(state.stops >= 2); assert.equal(state.runs.length, 0);
  assert.match(warnings.at(-1), /cancelled/);
});
test("an excluded test or cursor outside a test launches nothing", async t => {
  const options = { empty: true }, { workspace, state } = fixture(t, options);
  await workspace.debugAtCursor(); assert.match(warnings.at(-1), /no single test at this cursor/);
  options.empty = false; editor.selection.active.line = 11;
  await workspace.debugAtCursor(); assert.match(warnings.at(-1), /no single test at this cursor/);
  assert.equal(state.runs.length, 0);
});
test("dirty text is saved before discovery and a later cursor move is refused", async t => {
  const options = {}, { workspace, state, document } = fixture(t, options);
  let saves = 0; document.isDirty = true; document.save = async () => { saves++; document.version++; document.isDirty = false; return true; };
  await workspace.debugAtCursor(); assert.equal(saves, 1); assert.equal(state.runs.length, 1);
  options.changed = (_document, currentEditor) => { currentEditor.selection.active.character++; };
  await workspace.debugAtCursor(); assert.equal(state.runs.length, 1); assert.match(warnings.at(-1), /document or cursor changed/);
});

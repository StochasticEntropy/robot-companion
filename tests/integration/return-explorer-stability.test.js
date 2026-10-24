"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../src/core/extension.js"), "utf8");
const disposable = () => ({ dispose() {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class CancellationTokenSource {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
const empty = infoMessage => ({ detailsMarkdown: "", infoMessage });

function provider() {
  const start = source.indexOf("class RobotReturnPreviewViewProvider {");
  const end = source.indexOf("class RobotReturnExplorerController {", start);
  const context = { createEmptyReturnPreviewState: empty,
    getReturnExplorerDetailsSegments: state => [state.detailsMarkdown],
    renderReturnExplorerDetailsSegmentsHtml: async segments => segments.join(""),
    createWebviewNonce: () => "nonce", PREVIEW_COMMAND_URI_ALLOWLIST: [], console };
  vm.runInNewContext(`${source.slice(start, end)};globalThis.Provider=RobotReturnPreviewViewProvider;`, context);
  return new context.Provider();
}

function controller({ preview = provider(), variable = false, resolveReturn = async () => undefined,
  resolveDocs = async () => undefined, enumResolve = async () => undefined,
  argumentResolve = () => undefined, explicitEnumResolve = async () => undefined, workspace, realCallContext = false, debounceMs = 10000 } = {}) {
  const start = source.indexOf("class RobotReturnExplorerController {");
  const end = source.indexOf("function buildReturnPreviewMarkdown", start);
  const tasks = [];
  const vscode = { CancellationTokenSource, window: { onDidChangeActiveTextEditor: disposable,
    onDidChangeTextEditorSelection: disposable }, workspace: { onDidChangeTextDocument: disposable,
    onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable } };
  const variableContext = (document, parsed, position) => variable ? { owner: { id: "test", name: "Example" },
    variableToken: { token: document.lineAt(position.line).text.trim() },
    assignment: { startLine: position.line, keywordName: "Build Value" } } : undefined;
  const context = { vscode, console, setTimeout, clearTimeout, Date,
    shouldPauseRobotCompanionInteractiveUiForDebug: () => false, isReturnExplorerEnabled: () => true,
    isRobotDocument: document => document.languageId === "robotframework", createEmptyReturnPreviewState: empty,
    isAutoSyncSelectionEnabled: () => true, isEnumValueHoverEnabled: () => true, getEnumHoverMaxEnums: () => 10, getEnumHoverMaxMembers: () => 20,
    getReturnPreviewMaxDepth: () => 3, getReturnMaxFieldsPerType: () => 20,
    getKeywordReturnVariableContextAtPosition: variableContext,
    getKeywordTokenContextAtPosition: (document, position) => ({ keywordName: document.lineAt(position.line).text.trim() }),
    getNamedArgumentValueContextAtPosition: argumentResolve, findKeywordCallHeaderLine: (_document, line) => line,
    findOwnerForLine: () => ({ id: "test", name: "Example" }),
    resolveEnumValuePreview: enumResolve, resolveEnumValuePreviewFromContext: explicitEnumResolve,
    buildEnumPreviewMarkdown: value => `Argument ${value.argumentName}: ${value.currentValue}`,
    resolveKeywordReturnPreview: resolveReturn,
    resolveKeywordDocumentationPreview: resolveDocs, buildKeywordDocPreviewSegments: value => [value.name],
    joinKeywordDocPreviewSegments: segments => segments.join(""), logRobotCompanionError() {},
    BACKGROUND_TASK_MAX_WAIT_MS: 10000, getDebounceMs: () => debounceMs };
  if (realCallContext) {
    const names = ["getExplorerKeywordContextAtPosition", "getKeywordTokenContextAtPosition", "findKeywordCallHeaderLine",
      "extractKeywordTokenFromRobotCallLine", "splitRobotCellsWithRanges"];
    context.ROBOT_CONTROL_CELLS = new Set(["if", "end", "for"]);
    for (const name of names) {
      const from = source.indexOf(`function ${name}(`), to = source.indexOf("\nfunction ", from + 1);
      if (from >= 0) vm.runInNewContext(source.slice(from, to), context);
    }
  }
  if (workspace) context.languageWorkspace = workspace;
  vm.runInNewContext(`${source.slice(start, end)};globalThis.Controller=RobotReturnExplorerController;`, context);
  const runtime = { markInteractiveActivity() {}, ensureState: () => ({ indexGeneration: 1, settingsSignature: "same" }),
    invalidateOnRobotDocumentChange() {}, invalidateForUri() {}, schedulePrewarmForOpenDocuments() {}, scheduleBackgroundTask: (_key, task) => tasks.push(task) };
  const value = new context.Controller({ getParsed: document => ({ uri: document.uri.toString(), fileName: "example.robot", owners: [] }) },
    {}, preview, runtime, {});
  return { value, tasks, vscode, preview, context };
}
function editor(name, uri = "file:///example.robot") {
  const document = { uri: { toString: () => uri }, languageId: "robotframework", version: 1,
    getText: () => document.text, lineAt: line => ({ text: document.text.split("\n")[line] }) };
  document.text = name;
  return { document, selection: { active: { line: 0, character: 4 } } };
}

// The backend can remain pending for arbitrarily long: assertions below happen
// before resolving it, rather than sleeping and assuming that loading is fast.
test("cross-target header switches before a pending backend; old body is never labelled as the new variable", async () => {
  const old = deferred();
  const fixture = controller({ variable: true, enumResolve: () => old.promise });
  const { value, preview } = fixture;
  const a = editor("${first}");
  value._beginSelection(a, { uri: a.document.uri.toString(), fileName: "example.robot" }, {});
  preview.update({ ...preview._state, detailsMarkdown: "First members", refreshState: "ready" });
  const b = editor("${second}");
  const pending = value._syncFromActiveEditor(b);
  assert.equal(preview._state.variableToken, "${second}");
  assert.equal(preview._state.refreshState, "loading");
  assert.doesNotMatch(preview._state.detailsMarkdown, /First members/);
  value.dispose(); old.resolve(undefined); await pending;
});

test("same-target valid refresh preserves members and annotation; changed binding or document clears them", () => {
  const p = provider();
  const state = { previewTarget: "same", previewValidity: "source-v1", contextKind: "return", variableToken: "${result}",
    detailsMarkdown: "Root members", returnAnnotation: "Result", refreshState: "ready" };
  p.update(state);
  p.beginRefresh({ previewTarget: "same", previewValidity: "source-v1", variableToken: "${result}" });
  assert.equal(p._state.detailsMarkdown, "Root members");
  assert.equal(p._state.returnAnnotation, "Result");
  assert.equal(p._state.refreshState, "refreshing");
  for (const change of [{ previewTarget: "same", previewValidity: "source-v2" },
    { previewTarget: "another-document", previewValidity: "source-v1" }]) {
    p.update(state); p.beginRefresh(change);
    assert.equal(p._state.refreshState, "loading");
    assert.doesNotMatch(p._state.detailsMarkdown, /Root members/);
  }
});

test("A to B to A out-of-order replies cannot paint B or first A over final A", async () => {
  const requests = [deferred(), deferred(), deferred()];
  const fixture = controller({ resolveReturn: () => requests.shift().promise });
  const { value, preview } = fixture;
  const all = [...requests];
  const first = value._syncFromActiveEditor(editor("A")); await new Promise(setImmediate);
  const second = value._syncFromActiveEditor(editor("B")); await new Promise(setImmediate);
  const final = value._syncFromActiveEditor(editor("A")); await new Promise(setImmediate);
  const results = [];
  value._applyReturnPreviewContext = (_parsed, result) => results.push(result.name);
  all[2].resolve({ name: "final A" }); await final;
  all[1].resolve({ name: "old B" }); await second;
  all[0].resolve({ name: "old A" }); await first;
  assert.deepEqual(results, ["final A"]);
  assert.equal(preview._state.keywordName, "A"); value.dispose();
});

test("document edit cancels immediately during debounce and suppresses a late result", async () => {
  const pending = deferred(); let token;
  const fixture = controller({ resolveReturn: (_doc, _parsed, _position, _service, options) => {
    token = options.cancellationToken; return pending.promise;
  } });
  const { value, vscode } = fixture;
  const current = editor("Original"); vscode.window.activeTextEditor = current;
  const request = value._syncFromActiveEditor(current); await new Promise(setImmediate);
  current.document.version += 1; current.document.text = "Changed";
  value._onDocumentChanged({ document: current.document, contentChanges: [{ text: "Changed" }] });
  assert.equal(token.isCancellationRequested, true);
  const painted = []; value._applyReturnPreviewContext = (_parsed, result) => painted.push(result);
  pending.resolve({ name: "old source" }); await request;
  assert.deepEqual(painted, []); value.dispose();
});

test("first-level result paints before the unresolved deep request", async () => {
  const deep = deferred(); const calls = [];
  const fixture = controller({ resolveReturn: (_document, _parsed, _position, _service, options) => {
    calls.push(options);
    return options.includeTechnical ? deep.promise : Promise.resolve({ name: "first-level", technicalPending: true });
  } });
  const { value, tasks } = fixture;
  const painted = []; value._applyReturnPreviewContext = (_parsed, result) => painted.push(result.name);
  const e = editor("${result}");
  const request = value._resolveReturnPreviewWhenIdle(e, { uri: e.document.uri.toString() }, value._syncSequence);
  await request;
  assert.deepEqual(painted, ["first-level"]);
  assert.equal(calls[0].maxDepth, 1); assert.equal(calls[0].includeTechnical, false);
  const pendingDeep = tasks.shift()(); await new Promise(setImmediate);
  assert.deepEqual(painted, ["first-level"], "Pending deep expansion must leave root members visible");
  deep.resolve({ name: "full-depth" }); await pendingDeep;
  assert.deepEqual(painted, ["first-level", "full-depth"]); value.dispose();
});

test("identical webview state does not rebuild HTML; same-target content refresh restores its own scroll only", async () => {
  const p = provider(); let writes = 0;
  p._view = { webview: { cspSource: "test", set html(value) { writes += 1; } } };
  p._buildHtml = () => "html";
  p.update({ previewTarget: "A", detailsMarkdown: "Members" }); await p.render();
  const before = writes; p.update({ previewTarget: "A", detailsMarkdown: "Members" }); await p.render();
  assert.equal(writes, before);
  assert.match(source.slice(source.indexOf("class RobotReturnPreviewViewProvider"), source.indexOf("class RobotReturnExplorerController")),
    /saved\?\.target === target/);
  p.dispose();
});

test("real sync presents a prewarmed variable before any pending enum or fresh-source lookup", async () => {
  const fresh = deferred(); let enumCalls = 0; const painted = [];
  const fixture = controller({ variable: true, enumResolve: () => { enumCalls += 1; return new Promise(() => {}); },
    resolveReturn: (_document, _parsed, _position, _service, options) => options.cacheOnly
      ? { name: "prewarmed members", presentationSnapshot: true } : fresh.promise });
  const { value } = fixture;
  value._applyReturnPreviewContext = (_parsed, result) => painted.push(result.name);
  await value._syncFromActiveEditor(editor("${second}"));
  assert.deepEqual(painted, ["prewarmed members"]);
  assert.equal(enumCalls, 0, "A known return-variable selection must not wait in an unrelated enum branch");
  value.dispose(); fresh.resolve(undefined);
});

test("explicit argument preview switches header immediately and its cancelled late reply cannot overwrite a newer target", async () => {
  const old = deferred();
  const { value, preview } = controller({ explicitEnumResolve: () => old.promise });
  const e = editor("Build Value    mode=first");
  const pending = value.previewKeywordArgument({ documentUri: e.document.uri.toString(), argumentName: "mode",
    keywordName: "Build Value", argumentValue: "first", line: 0 }, { skipOpen: true, editor: e });
  assert.equal(preview._state.variableToken, "mode");
  assert.equal(preview._state.refreshState, "loading");
  await value._syncFromActiveEditor(editor("Other Target"));
  old.resolve({ argumentName: "mode", keywordName: "Build Value", currentValue: "old first" });
  await pending;
  assert.doesNotMatch(preview._state.detailsMarkdown || "", /old first/);
  value.dispose();
});

test("continuation argument value and restarted native root invalidate same-target presentation", () => {
  let root = {};
  const { value, preview } = controller({ argumentResolve: document => ({ argumentName: "mode", argumentValue: document.value,
    keywordName: "Build Value" }), workspace: { rootFor: () => root } });
  const e = editor("Build Value"); e.document.value = "first";
  const parsed = { uri: e.document.uri.toString(), fileName: "example.robot", owners: [] };
  value._beginSelection(e, parsed, {});
  preview.update({ ...preview._state, detailsMarkdown: "First enum", refreshState: "ready" });
  e.document.value = "second"; value._beginSelection(e, parsed, {});
  assert.equal(preview._state.refreshState, "loading");
  assert.doesNotMatch(preview._state.detailsMarkdown, /First enum/);
  preview.update({ ...preview._state, detailsMarkdown: "Second enum", refreshState: "ready" });
  root = {}; value._beginSelection(e, parsed, {});
  assert.equal(preview._state.refreshState, "loading");
  assert.doesNotMatch(preview._state.detailsMarkdown, /Second enum/); value.dispose();
});

test("closing a pending selected document cancels and never resurrects its panel", async () => {
  const old = deferred(); let token;
  const { value, preview, vscode } = controller({ resolveReturn: (_doc, _parsed, _position, _service, options) => {
    token = options.cancellationToken; return old.promise;
  } });
  const e = editor("Pending Target"); vscode.window.activeTextEditor = e;
  const pending = value._syncFromActiveEditor(e); await new Promise(setImmediate);
  e.document.isClosed = true; value._onDocumentClosed(e.document);
  assert.equal(token.isCancellationRequested, true);
  const afterClose = { ...preview._state };
  old.resolve({ name: "closed target" }); await pending;
  assert.equal(JSON.stringify(preview._state), JSON.stringify(afterClose)); value.dispose();
});

test("refresh status alone never reloads the webview or discards its valid body", async () => {
  const p = provider(); let writes = 0; const messages = [];
  p._view = { webview: { cspSource: "test", set html(value) { writes += 1; },
    postMessage: async message => { messages.push(message); return true; } } };
  p._buildHtml = () => "html";
  p.update({ previewTarget: "A", previewValidity: "source", detailsMarkdown: "Members", refreshState: "ready" }); await p.render();
  const before = writes;
  p.beginRefresh({ previewTarget: "A", previewValidity: "source", detailsMarkdown: "" }); await p.render();
  assert.equal(writes, before); assert.equal(p._state.detailsMarkdown, "Members");
  assert.equal(messages.at(-1).type, "returnPreviewStatus"); assert.match(messages.at(-1).text, /Updating/);
  p.failRefresh("Source lookup timed out"); await p.render();
  assert.equal(writes, before); assert.equal(p._state.refreshState, "unavailable");
  assert.match(messages.at(-1).text, /timed out/); p.dispose();
});

test("editing another Robot dependency cancels and schedules replacement for the ACTIVE preview", async () => {
  const pending = deferred(); let token;
  const { value, vscode, preview } = controller({ resolveReturn: (_doc, _parsed, _position, _service, options) => {
    token = options.cancellationToken; return pending.promise;
  } });
  const active = editor("Active Target"); vscode.window.activeTextEditor = active;
  const request = value._syncFromActiveEditor(active); await new Promise(setImmediate);
  const dependency = editor("Changed Resource", "file:///helper.resource");
  value._onDocumentChanged({ document: dependency.document, contentChanges: [{ text: "changed" }] });
  assert.equal(token.isCancellationRequested, true);
  assert.equal(value._debounceTimers.has(active.document.uri.toString()), true);
  assert.equal(value._debounceTimers.has(dependency.document.uri.toString()), false);
  assert.equal(preview._state.keywordName, "Active Target");
  assert.equal(preview._state.refreshState, "loading"); value.dispose(); pending.resolve(undefined); await request;
});

test("debounce retains every changed Python dependency and close restores disk without post-dispose refresh", async () => {
  const { value, vscode, context } = controller();
  context.isPythonDocument = document => document.languageId === "python";
  const updated = [], restored = []; const disk = deferred();
  value._enumHintService.applyPythonDocumentSave = async document => updated.push([document.uri.toString(), document.getText()]);
  value._enumHintService.applyPythonFileCreate = async uri => { restored.push(uri.toString()); await disk.promise; };
  const active = editor("Active Target"); vscode.window.activeTextEditor = active;
  const first = editor("first-source", "file:///First.py").document; first.languageId = "python";
  const second = editor("second-source", "file:///Second.py").document; second.languageId = "python";
  value._onDocumentChanged({ document: first, contentChanges: [{ text: "first-source" }] });
  value._onDocumentChanged({ document: second, contentChanges: [{ text: "second-source" }] });
  assert.equal(value._debounceTimers.size, 1);
  await value._refreshPythonIndex();
  assert.deepEqual(updated, [["file:///First.py", "first-source"], ["file:///Second.py", "second-source"]]);
  first.text = "unsaved"; value._onDocumentChanged({ document: first, contentChanges: [{ text: "unsaved" }] });
  first.isClosed = true; value._onDocumentClosed(first);
  assert.equal(value._pendingPythonDocuments.has(first.uri.toString()), false);
  value.dispose(); const sequence = value._syncSequence;
  disk.resolve(); await new Promise(setImmediate);
  assert.deepEqual(restored, ["file:///First.py"]);
  assert.equal(value._syncSequence, sequence, "Late disk-index completion must not start a fresh controller request after disposal");
});

test("enum and documentation source failures are unavailable, not authoritative empty ready previews", async () => {
  for (const kind of ["enum", "documentation"]) {
    const fixture = controller(kind === "enum" ? { enumResolve: async () => { throw new Error("Argument source read failed"); } }
      : { resolveDocs: async () => ({ definitionSource: { identity: { status: "unavailable" } }, warningMessage: "Keyword source read failed" }) });
    await fixture.value._syncFromActiveEditor(editor("Selected Target"));
    assert.equal(fixture.preview._state.refreshState, "unavailable", kind);
    assert.match(fixture.preview._state.infoMessage, /source read failed/);
    assert.doesNotMatch(fixture.preview._state.infoMessage, /Place cursor/); fixture.value.dispose();
  }
});

test("real mouse selection during argument navigation suppression immediately selects B and cancels A", async () => {
  const pending = deferred();
  const { value, preview } = controller({ explicitEnumResolve: () => pending.promise });
  const a = editor("Build Value    mode=first");
  const first = value.previewKeywordArgument({ documentUri: a.document.uri.toString(), argumentName: "mode",
    keywordName: "Build Value", argumentValue: "first", line: 0 }, { skipOpen: true, editor: a });
  assert.equal(preview._state.variableToken, "mode");
  value._onSelectionChanged({ textEditor: editor("New Target"), kind: 2 });
  assert.equal(preview._state.keywordName, "New Target");
  pending.resolve({ argumentName: "mode", keywordName: "Build Value", currentValue: "obsolete" });
  await first; await new Promise(setImmediate);
  assert.doesNotMatch(preview._state.detailsMarkdown || "", /obsolete/); value.dispose();
});

test("same-return progressive content patches the live document; changed source identity starts a new document", async()=>{
 const p=provider(),messages=[];let writes=0;
 p._view={webview:{cspSource:"test",set html(value){writes++;},postMessage:async message=>{messages.push(message);return true;}}};p._buildHtml=()=>"html";
 const state={previewTarget:"A",previewValidity:"v1",contextKind:"return",variableToken:"${a}",returnAnnotation:"Result",bindingSignature:"exact-source",detailsMarkdown:"first",refreshState:"expanding"};
 p.update(state);await p.render();const first=writes;p._webviewReadyTarget="A";
 p.update({...state,detailsMarkdown:"first + deeper",hasFullReturnDetails:true,refreshState:"ready"});await p.render();
 assert.equal(writes,first,"Deeper content must never reload the webview");
 assert.equal(messages.at(-1).type,"returnPreviewContent");assert.equal(messages.at(-1).target,"A");assert.equal(messages.at(-1).html,"first + deeper");
 p.update({...state,detailsMarkdown:"other source",bindingSignature:"different-source"});await p.render();
 assert.equal(writes,first+1,"A different actual binding must not retain the old DOM under its new metadata");p.dispose();
});


test("return document readiness is instance-bound across binding changes, reopening and disposal", async () => {
  const p = provider();
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function view() {
    let receive;
    const writes = [], messages = [];
    return { visible: true, writes, messages, receive: message => receive(message), webview: {
      cspSource: "test", set html(value) { writes.push(value); },
      postMessage: async message => { messages.push(message); return true; },
      onDidReceiveMessage: handler => { receive = handler; return disposable(); }
    } };
  }
  let serial = 0;
  p._buildHtml = function () { this._webviewDocumentId = `document-${++serial}`; return `html-${serial}`; };
  const state = { contextKind: "return", previewTarget: "A", previewValidity: "same-file",
    bindingSignature: "source-one", detailsMarkdown: "first", refreshState: "ready" };
  p._state = state;
  const first = view(); p.resolveWebviewView(first); await tick();
  assert.equal(first.writes.length, 1);
  const oldDocument = p._webviewDocumentId;
  await first.receive({ type: "returnPreviewReady", target: "A", documentId: oldDocument });
  p.update({ ...state, bindingSignature: "source-two" }); await tick();
  assert.equal(first.writes.length, 2);
  const currentDocument = p._webviewDocumentId;
  assert.notEqual(currentDocument, oldDocument);
  p.update({ ...state, bindingSignature: "source-two", detailsMarkdown: "first and deep" }); await tick();
  assert.ok(p._pendingReturnContent);
  await first.receive({ type: "returnPreviewReady", target: "A", documentId: oldDocument });
  assert.equal(first.messages.length, 0);
  assert.ok(p._pendingReturnContent, "Old document must not consume the current content queue");
  await first.receive({ type: "returnPreviewReady", target: "A", documentId: currentDocument });
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].html, "first and deep");
  assert.equal(first.messages[0].documentId, currentDocument);
  assert.equal(p._pendingReturnContent, undefined);
  const reopened = view(); p.resolveWebviewView(reopened); await tick();
  assert.equal(reopened.writes.length, 1, "A new webview needs its own initial script, not a content message");
  assert.equal(reopened.messages.length, 0);
  assert.notEqual(p._webviewDocumentId, currentDocument);
  p.dispose();
  await first.receive({ type: "returnPreviewReady", target: "A", documentId: oldDocument });
  assert.equal(p._view, undefined);
  for (const key of ["_renderedReturnHeaderKey", "_pendingReturnContent", "_webviewReadyTarget", "_webviewDocumentId"]) {
    assert.equal(p[key], undefined, key);
  }
});


test("typing blank and partial continuation keeps one docs target and coalesces edit selections", async () => {
  const queries = [];
  const f = controller({ realCallContext: true, debounceMs: 15,
    resolveDocs: async (_document, _parsed, position) => {
      queries.push(position);
      return { name: "Stable declaration docs", keywordToken: { keywordName: "Collect Example" } };
    } });
  const e = editor("*** Test Cases ***\nExample\n    Collect Example    first");
  e.selection.active = { line: 2, character: 12 }; f.vscode.window.activeTextEditor = e;
  await f.value._syncFromActiveEditor(e);
  assert.equal(f.preview._state.detailsMarkdown, "Stable declaration docs");
  const identity = f.preview._state.previewTarget;
  const edit = value => {
    const lines = e.document.text.split("\n"), line = lines.length - 1, end = lines[line].length;
    e.document.text += value; e.document.version++;
    const after = e.document.text.split("\n");
    e.selection.active = { line: after.length - 1, character: after.at(-1).length };
    f.value._onDocumentChanged({ document: e.document, contentChanges: [{ range: {
      start: { line, character: end }, end: { line, character: end } }, text: value }] });
    f.value._onSelectionChanged({ textEditor: e, kind: 1 });
    assert.equal(f.preview._state.previewTarget, identity, value);
    assert.equal(f.preview._state.detailsMarkdown, "Stable declaration docs", value);
  };
  edit("\n    "); for (const character of "...    antw") edit(character);
  assert.equal(queries.length, 1, "caret movement after typing must not bypass the edit debounce");
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(queries.length, 2, "one authoritative refresh for the final version");
  assert.equal(queries[1].line, 2); assert.equal(queries[1].character, 4);
  assert.equal(f.preview._state.detailsMarkdown, "Stable declaration docs");
  e.document.text = e.document.text.replace("...    antw", "Another Keyword"); e.document.version++;
  f.value._onDocumentChanged({ document: e.document, contentChanges: [{}] });
  assert.equal(f.preview._state.keywordName, "Another Keyword");
  assert.doesNotMatch(f.preview._state.detailsMarkdown, /Stable declaration docs/);
  f.value.dispose();
});


test("three-dot-prefixed real keyword names are not continuation targets", () => {
  const f = controller({ realCallContext: true });
  for (const name of ["...Another Keyword", "...Library.Keyword", "....", "... value", "...\u00a0value", "Another Keyword"]) {
    const e = editor(`*** Test Cases ***\nExample\n    Collect Example    first\n    ${name}`);
    e.selection.active = { line: 3, character: 4 + name.length };
    f.value._beginSelection(e, { uri: e.document.uri.toString(), owners: [] }, {});
    assert.equal(f.preview._state.keywordName, name);
    assert.equal(f.context.getExplorerKeywordContextAtPosition(e.document, e.selection.active).line, 3);
    assert.equal(f.context.getExplorerKeywordContextAtPosition(e.document, { line: 3, character: 5 }).keywordName, name);
  }
  f.value.dispose();
});


test("the same pending target is not rebuilt for both edit and caret events", () => {
  const p = provider(); let writes = 0;
  p._view = { webview: { cspSource: "test", set html(value) { writes++; } } };
  p._buildHtml = () => "pending html";
  const state = { previewTarget: "current partial", previewValidity: "source-prefix", contextKind: "keyword-doc", keywordName: "Partial" };
  p.beginRefresh(state); p.beginRefresh(state); p.beginRefresh({ ...state });
  assert.equal(writes, 1);
  p.beginRefresh({ ...state, previewValidity: "dependency changed" });
  assert.equal(writes, 2, "a changed source must not inherit the pending presentation");
  p.dispose();
});


test("a genuinely new keyword prefix updates only a truthful pending header until current docs resolve", async () => {
  const p = provider(), writes = [], messages = []; let receive, serial = 0;
  p._buildHtml = function () { this._webviewDocumentId = `document-${++serial}`;
    this._webviewInitialTarget = this._state.previewTarget; return this._state.detailsMarkdown; };
  p.resolveWebviewView({ visible: true, webview: { cspSource: "test",
    set html(value) { writes.push(value); }, postMessage: async message => { messages.push(message); return true; },
    onDidReceiveMessage: handler => { receive = handler; return disposable(); } } });
  await new Promise(setImmediate);
  const oldDocument = p._webviewDocumentId;
  p.update({ contextKind: "keyword-doc", documentUri: "file:///example.robot", ownerName: "Example", detailsMarkdown: "Old exact declaration" });
  await new Promise(setImmediate);
  const state = keywordName => ({ contextKind: "keyword-doc", documentUri: "file:///example.robot", ownerName: "Example",
    keywordName, previewTarget: `target-${keywordName}`, previewValidity: `prefix-${keywordName}` });
  p.beginRefresh(state("C"), { typing: true });
  const loadingDocument = p._webviewDocumentId, count = writes.length;
  for (const name of ["Co", "Col", "Coll", "Colle", "Collec", "Collect", "Collect ", "Collect E"]) {
    p.beginRefresh(state(name), { typing: true });
    assert.equal(p._webviewDocumentId, loadingDocument);
    assert.equal(p._state.keywordName, name);
    assert.doesNotMatch(p._state.detailsMarkdown, /Old exact declaration/);
  }
  assert.equal(writes.length, count, "all prefix letters reuse one loading document");
  assert.equal(messages.length, 0, "latest header waits for this loading document's ready message");
  await receive({ type: "returnPreviewReady", documentId: oldDocument, target: "target-C" });
  assert.equal(messages.length, 0, "an old document cannot flush a new pending header");
  await receive({ type: "returnPreviewReady", documentId: loadingDocument, target: "target-C" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "returnPreviewKeyword");
  assert.equal(messages[0].keywordName, "Collect E");
  assert.equal(messages[0].documentId, loadingDocument);
  await receive({ type: "returnPreviewReady", documentId: loadingDocument, target: "target-Collect E" });
  assert.equal(p._pendingKeywordHeader, undefined);
  p.update({ ...state("Collect E"), refreshState: "ready", detailsMarkdown: "Current exact declaration" });
  await new Promise(setImmediate);
  assert.equal(writes.length, count + 1, "one resolved document replaces the loading shell");
  assert.equal(writes.at(-1), "Current exact declaration");
  p.dispose();
  assert.equal(p._pendingKeywordHeader, undefined);
});


test("literal dot keyword calls take authoritative and explicit-selection priority over provisional typing", async () => {
  const queries = [];
  const f = controller({ realCallContext: true, debounceMs: 10,
    resolveDocs: async (_document, _parsed, position) => {
      queries.push(position); return { name: "Literal dot documentation", keywordToken: { keywordName: "." } };
    } });
  const e = editor("*** Test Cases ***\nExample\n    Collect Example    first\n    .");
  e.selection.active = { line: 3, character: 5 }; f.vscode.window.activeTextEditor = e;
  for (const token of [".", ".."]) {
    e.document.text = e.document.text.replace(/\.{1,2}$/, token);
    assert.equal(f.context.getExplorerKeywordContextAtPosition(e.document, e.selection.active).keywordName, token);
    assert.equal(f.context.getExplorerKeywordContextAtPosition(e.document, e.selection.active, { typing: true }).keywordName, "Collect Example");
  }
  await f.value._syncFromActiveEditor(e);
  assert.equal(queries.at(-1).line, 3, "final source lookup must use the actual current dot call");
  f.value._beginSelection(e, { uri: e.document.uri.toString(), owners: [] }, {}, { typing: true });
  assert.equal(f.preview._state.keywordName, "Collect Example", "typing-only presentation may keep the prior call");
  f.value._onSelectionChanged({ textEditor: e, kind: 2 });
  await new Promise(setImmediate);
  assert.equal(queries.at(-1).line, 3, "an explicit selection never queries the earlier call instead");
  f.value.dispose();
});

"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const load = Module._load;
const vscode = { window: {}, CompletionTriggerKind: { TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
  CompletionItemKind: { Function: 2, Variable: 5 },
  CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
  CompletionList: class { constructor(items, isIncomplete) { Object.assign(this, { items, isIncomplete }); } },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } } };
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const { LanguageWorkspace } = require("../../src/integration/language-workspace");
Module._load = load;
const { CompletionDiagnostics } = require("../../src/integration/completion-diagnostics");
const PREFIX = "Completion boundary: ";

function fixture(enabled = true, sink) {
  let finish, reject, cancel;
  const request = new Promise((yes, no) => { finish = yes; reject = no; });
  const lines = [], calls = [], uri = "file:///synthetic/private-path-must-not-be-recorded.robot";
  const text = "*** Test Cases ***\nExample\n    Example Collect Data\n    ...    ";
  const point = { line: 3, character: 11 };
  const document = { uri: { scheme: "file", path: "/synthetic/private-path-must-not-be-recorded.robot", toString: () => uri },
    version: 1, isClosed: false, isDirty: false, text, getText() { return this.text; } };
  const token = { isCancellationRequested: false, onCancellationRequested(handler) { cancel = handler; return { dispose() {} }; } };
  const editor = { document, selection: { isEmpty: true, active: { ...point } } };
  vscode.window.activeTextEditor = editor;
  const root = { native: true, documents: new Map([[uri, 1]]), completionSourceRevision: 1,
    session: { capabilities: { completionProvider: { triggerCharacters: [" "] } }, request(...args) { calls.push(args); return request; } } };
  const manager = Object.create(LanguageWorkspace.prototype);
  const channel = { appendLine(line) { lines.push(line); sink?.(line); } };
  Object.assign(manager, { generation: 1, disposed: false, companion: {}, rootFor: () => root, open() {},
    usable: () => !manager.disposed, syncOptions: () => ({ change: 2 }), channel,
    completionDiagnostics: new CompletionDiagnostics(channel) });
  if (enabled) manager.completionDiagnostics.toggle();
  const result = { isIncomplete: true, items: ["count=", "context="].map(label => ({ label, kind: 6, insertTextFormat: 1,
    textEdit: { range: { start: { ...point }, end: { ...point } }, newText: label } })) };
  return { manager, document, root, token, calls, lines, result,
    rows: () => lines.filter(line => line.startsWith(PREFIX)).map(line => JSON.parse(line.slice(PREFIX.length))),
    start: context => manager.completion(document, point, token, context),
    append(value) { document.text += value; document.version++; editor.selection.active.character += value.length; },
    cancel() { token.isCancellationRequested = true; cancel?.(); }, finish: () => finish(result), reject };
}

test("diagnostics are off by default and do not inspect an untraced document", () => {
  const lines = [], trace = new CompletionDiagnostics({ appendLine: value => lines.push(value) });
  assert.equal(trace.begin({ get version() { throw new Error("must not read"); } }), undefined);
  assert.deepEqual(lines, []);
});

test("real completion and native boundaries preserve the same result and request with tracing off or on", async () => {
  const outcomes = [];
  for (const enabled of [false, true]) {
    const f = fixture(enabled), pending = f.start(); f.finish();
    const answer = await pending;
    outcomes.push({ items: answer.items.map(item => ({ label: item.label, range: item.range })),
      incomplete: answer.isIncomplete, params: f.calls[0][1], callCount: f.calls.length });
    assert.equal(f.calls[0][2].signal.aborted, false);
    if (enabled) {
      assert.deepEqual(f.rows().map(row => row.stage), ["enabled", "provider-enter", "native-request", "native-reply", "provider-return"]);
      assert.deepEqual(f.rows().slice(1).map(row => row.sequence), [1, 1, 1, 1]);
      assert.equal(f.rows().at(-1).count, 2);
      const output = JSON.stringify(f.rows());
      for (const secret of ["file:", "private-path", "Example", "count=", "context=", "position", "textDocument"]) assert(!output.includes(secret), secret);
    } else assert.deepEqual(f.rows(), []);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test("provider admission without a matching trigger records no fictitious native request", async () => {
  const f = fixture();
  assert.equal(await f.start({ triggerKind: 1, triggerCharacter: "!" }), undefined);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows().map(row => row.stage), ["enabled", "provider-enter", "provider-return"]);
  assert.equal(f.rows().at(-1).count, 0);
});

test("late cancelled replies remain discarded and their trace reports cancellation without leaking items", async () => {
  const f = fixture(), pending = f.start(); f.cancel(); f.finish();
  assert.equal(await pending, undefined);
  assert.equal(f.calls[0][2].signal.aborted, true);
  assert.deepEqual(f.rows().slice(-2).map(row => [row.stage, row.count, row.cancelled]),
    [["native-reply", 2, true], ["provider-return", 0, true]]);
});

test("unchanged cancellation state cannot rescue a reply after unrelated source edits", async () => {
  const f = fixture(), pending = f.start(); f.append("co");
  f.document.text = f.document.text.replace("Example\n", "Changed\n"); f.finish();
  assert.equal(await pending, undefined);
  assert.deepEqual(f.rows().slice(-2).map(row => [row.count, row.cancelled, row.documentCurrent]), [[2, false, false], [0, false, false]]);
});

test("a proven same-cell append still returns original edits while recording the version transition", async () => {
  const f = fixture(), pending = f.start(); f.append("co"); f.finish();
  const answer = await pending;
  assert.equal(answer.items.length, 2);
  assert.deepEqual(answer.items[0].range.end, { line: 3, character: 11 });
  assert.deepEqual(f.rows().at(-1), { sequence: 1, stage: "provider-return", elapsedMs: f.rows().at(-1).elapsedMs,
    cancelled: false, documentCurrent: false, documentVersion: 1, currentVersion: 2, count: 2 });
});

test("native rejection and a failed diagnostic sink do not change provider failure handling", async () => {
  const f = fixture(true, line => { if (line.startsWith(PREFIX)) throw new Error("diagnostic sink unavailable"); }), pending = f.start();
  f.reject(new Error("synthetic request failure"));
  assert.equal(await pending, undefined);
  assert.deepEqual(f.rows().slice(-2).map(row => row.stage), ["native-rejected", "provider-return"]);
  assert.equal(f.rows().at(-1).count, 0);
});

test("row/request/deadline bounds, stage allowlisting and stop/disposal reject late diagnostic writes", () => {
  let now = 100; const lines = [], document = { version: 1 };
  const trace = new CompletionDiagnostics({ appendLine: value => lines.push(value) }, () => now);
  trace.toggle(); const first = trace.begin(document);
  first.record("private arbitrary text", 3);
  for (let i = 0; i < 1000; i++) first.record("native-reply", 2);
  assert.equal(lines.length, 512); assert.equal(trace.active, undefined);
  trace.toggle();
  for (let i = 0; i < 128; i++) assert(trace.begin(document));
  assert.equal(trace.begin(document), undefined); assert.equal(trace.active, undefined);
  trace.toggle(); const pending = trace.begin(document);
  now += 120000; pending.record("native-reply", 2);
  assert.equal(trace.active, undefined);
  const count = lines.length; pending.record("provider-return", 2); assert.equal(lines.length, count);
  trace.toggle(); const disposed = trace.begin(document); trace.dispose();
  const beforeDispose = lines.length; disposed.record("provider-return", 2); assert.equal(lines.length, beforeDispose);
  trace.toggle(); const stopped = trace.begin(document); trace.stop();
  const beforeStop = lines.length; stopped.record("provider-return", 2); assert.equal(lines.length, beforeStop);
  assert(!lines.join("\n").includes("private arbitrary text"));
});


test("a synchronous Companion failure preserves the exact thrown object and records rejection instead of an empty return", async () => {
  const f = fixture(), failure = new Error("synthetic provider failure must not be recorded");
  f.manager.companion.completion = { provider: { provideCompletionItems() { throw failure; } } };
  await assert.rejects(f.start(), error => error === failure);
  assert.deepEqual(f.rows().map(row => row.stage), ["enabled", "provider-enter", "provider-rejected"]);
  assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(f.rows()).includes(failure.message));
});


test("the actual registered provider records an ownership refusal before native dispatch", async () => {
  const f = fixture(); let registered;
  const disposable = () => ({ dispose() {} });
  vscode.RelativePattern = class {};
  vscode.languages = { registerCompletionItemProvider(_selector, provider) { registered = provider; return disposable(); } };
  vscode.workspace = { createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }) };
  Object.assign(f.root, { folder: {}, features: new Set(), registrations: [] });
  f.manager.register(f.root);
  f.manager.rootFor = () => undefined;
  assert.equal(registered.provideCompletionItems(f.document, { line: 3, character: 11 }, f.token, {}), undefined);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.rows().map(row => row.stage), ["enabled", "provider-enter", "provider-return"]);
  assert.equal(f.rows().at(-1).count, 0);
});

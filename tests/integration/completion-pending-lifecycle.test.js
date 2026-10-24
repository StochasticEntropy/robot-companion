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
function fixture() {
  let finish;
  const request = new Promise(resolve => finish = resolve);
  const uri = "file:///workspace/suite.robot", old = "*** Test Cases ***\nExample\n    BAVL ";
  const document = { uri: { scheme: "file", path: "/workspace/suite.robot", toString: () => uri },
    version: 1, isClosed: false, isDirty: false, text: old, getText() { return this.text; } };
  const editor = { document, selection: { isEmpty: true, active: { line: 2, character: 9 } } };
  vscode.window.activeTextEditor = editor;
  const root = { native: true, documents: new Map([[uri, 1], ["file:///workspace/library.py", 1]]),
    completionSourceRevision: 4, session: { capabilities: { completionProvider: { triggerCharacters: [" "] } }, request: () => request } };
  const manager = Object.create(LanguageWorkspace.prototype);
  Object.assign(manager, { generation: 7, disposed: false, companion: {}, rootFor: () => root,
    usable: () => !manager.disposed, open() {}, channel: { appendLine() {} } });
  let cancellation;
  const token = { isCancellationRequested: false, onCancellationRequested(handler) { cancellation = handler; return { dispose() {} }; } };
  const cancel = () => { token.isCancellationRequested = true; cancellation?.(); };
  const pending = manager.completion(document, { line: 2, character: 9 }, token,
    { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: " " });
  const result = { isIncomplete: true, items: [{ label: "BAVL Antworten Kinder", kind: 3, insertTextFormat: 1,
    textEdit: { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, newText: "BAVL Antworten Kinder" } }] };
  const append = text => { document.text += text; document.version++; editor.selection.active.character += text.length; };
  return { manager, document, editor, root, token, cancel, pending, append, finish: () => finish(result) };
}

test("a live pending SPACE answer remains usable after exact same-cell typing without a retry command", async () => {
  const f = fixture(); f.append("Antw"); f.finish();
  const result = await f.pending;
  assert.deepEqual(result.items.map(item => item.label), ["BAVL Antworten Kinder"]);
  assert.deepEqual(result.items[0].range.end, { line: 2, character: 9 }, "The editor transforms request-time ranges");
});

test("Escape or explicit cancellation never resurrects an edited pending completion", async () => {
  const f = fixture(); f.append("Antw"); f.cancel(); f.finish();
  assert.equal(await f.pending, undefined);
});

test("editor blur, selection, close, disposal and root changes reject the pending edited result", async () => {
  const changes = [f => { vscode.window.activeTextEditor = { document: {} }; },
    f => { f.editor.selection.isEmpty = false; }, f => { f.editor.selection.active.line++; },
    f => { f.document.isClosed = true; }, f => { f.manager.disposed = true; },
    f => { f.manager.generation++; }];
  for (const change of changes) { const f = fixture(); f.append("Antw"); change(f); f.finish(); assert.equal(await f.pending, undefined); }
});

test("other open source changes, watched source changes and actual Robot cell changes are not prefix reuse", async () => {
  const changes = [f => { f.root.documents.set("file:///workspace/library.py", 2); },
    f => { f.root.documents.delete("file:///workspace/library.py"); },
    f => { f.root.documents.set("file:///workspace/new.py", 1); },
    f => { f.root.completionSourceRevision++; },
    f => { f.append("  argument"); }, f => { f.append("\targument"); },
    f => { f.document.text = f.document.text.replace("Example", "Another"); }];
  for (const change of changes) { const f = fixture(); f.append("Antw"); change(f); f.finish(); assert.equal(await f.pending, undefined); }
});

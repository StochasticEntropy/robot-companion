"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const load = Module._load;
const folder = { uri: { toString: () => "file:///synthetic" } };
const vscode = { workspace: { getWorkspaceFolder: () => folder }, window: {},
  CompletionTriggerKind: { TriggerCharacter: 1 }, CompletionItemKind: { Variable: 5 },
  CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
  CompletionList: class { constructor(items, isIncomplete) { Object.assign(this, { items, isIncomplete }); } },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } } };
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const { LanguageWorkspace } = require("../../src/integration/language-workspace");
Module._load = load;
const { completionSourcesCurrent } = require("../../src/integration/completion-source");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "completion-save-"));
  const file = path.join(directory, "example.robot"), uri = { scheme: "file", path: file, fsPath: file, toString: () => "file:///synthetic/example.robot" };
  const document = { uri, version: 1, isClosed: false, isDirty: true,
    text: "*** Test Cases ***\nExample\n    Example Keyword\n    ...    ", getText() { return this.text; } };
  const point = { line: 3, character: 11 }, selection = { isEmpty: true, active: { ...point } };
  vscode.window.activeTextEditor = { document, selection };
  let finish, cancel;
  const request = new Promise(resolve => finish = resolve);
  const token = { isCancellationRequested: false, onCancellationRequested(callback) { cancel = callback; return { dispose() {} }; } };
  const root = { native: true, folder, documents: new Map([[uri.toString(), 1]]), published: new Map(),
    session: { capabilities: { completionProvider: {} }, request: () => request } };
  const manager = Object.create(LanguageWorkspace.prototype);
  Object.assign(manager, { generation: 1, disposed: false, companion: {}, rootFor: () => root, syncRootFor: () => root,
    usable: () => !manager.disposed, open() {}, send() {}, syncOptions: () => ({ change: 2, save: true }),
    diagnostics: { delete() {} }, channel: { appendLine() {} } });
  const result = { isIncomplete: true, items: [{ label: "count=", kind: 6, insertTextFormat: 1,
    textEdit: { range: { start: point, end: point }, newText: "count=" } }] };
  const pending = manager.completion(document, point, token, {});
  return { directory, file, uri, root, manager, document, pending, token,
    append(text) { document.text += text; document.version++; selection.active.character += text.length; },
    async save() { await fs.writeFile(file, document.text); document.isDirty = false; manager.save(document); },
    watch(type = 2, target = uri) { manager.watched(root, target, type); },
    async settle() {
      for (let n = 0; (root.completionSaveChecks || 0) && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(root.completionSaveChecks || 0, 0);
    },
    cancel() { token.isCancellationRequested = true; cancel?.(); },
    finish: () => finish(result), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("actual save and matching disk witness retain an uncancelled same-cell completion across its own watcher", async () => {
  const f = await fixture();
  try {
    f.append("co"); await f.save(); f.watch(); await f.settle();
    assert.equal(f.root.completionSourceRevision, 1, "global invalidation is retained");
    f.finish(); const answer = await f.pending;
    assert.equal(answer?.items.length, 1);
    assert.deepEqual(answer.items[0].range.end, { line: 3, character: 11 });
  } finally { await f.cleanup(); }
});

test("foreign dependency watches before or after an own save, and create/delete watches, remain invalidating", async () => {
  for (const order of ["foreign-first", "foreign-last", "created", "deleted"]) {
    const f = await fixture();
    try {
      f.append("co"); await f.save();
      const foreign = { fsPath: path.join(f.directory, "library.py"), toString: () => "file:///synthetic/library.py" };
      if (order === "foreign-first") f.watch(2, foreign);
      f.watch(order === "created" ? 1 : order === "deleted" ? 3 : 2);
      if (order === "foreign-last") f.watch(2, foreign);
      await f.settle(); f.finish(); assert.equal(await f.pending, undefined, order);
    } finally { await f.cleanup(); }
  }
});

test("unwitnessed, externally changed and oversized disk contents cannot masquerade as an editor save", async () => {
  for (const mode of ["no-save", "external-change", "oversized"]) {
    const f = await fixture();
    try {
      f.append("co");
      if (mode !== "no-save") await f.save();
      if (mode === "external-change") await fs.writeFile(f.file, f.document.text.replace("Example\n", "External\n"));
      if (mode === "oversized") await fs.writeFile(f.file, "x".repeat(4 * 1024 * 1024 + 4));
      f.watch(); await f.settle(); f.finish(); assert.equal(await f.pending, undefined, mode);
    } finally { await f.cleanup(); }
  }
});

test("verified own saves do not bypass cancellation, changed context, close/reopen or root disposal", async () => {
  for (const mode of ["cancelled", "changed-context", "close-reopen", "disposed"]) {
    const f = await fixture();
    try {
      f.append("co"); await f.save(); f.watch(); await f.settle();
      if (mode === "cancelled") f.cancel();
      if (mode === "changed-context") f.document.text = f.document.text.replace("Example\n", "Another\n");
      if (mode === "close-reopen") { f.manager.close(f.document); f.document.isClosed = true; f.root.documents.set(f.uri.toString(), 1); }
      if (mode === "disposed") f.manager.disposed = true;
      f.finish(); assert.equal(await f.pending, undefined, mode);
    } finally { await f.cleanup(); }
  }
});

test("repeated witnessed saves are allowed while journal gaps and proof-work limits fail closed", async () => {
  const f = await fixture();
  try {
    f.append("c"); await f.save(); f.watch(); await f.settle();
    f.append("o"); await f.save(); f.watch(); await f.settle();
    assert.equal(completionSourcesCurrent(f.root, 0, f.document), true);
    f.root.completionOwnSaveEvents.shift();
    assert.equal(completionSourcesCurrent(f.root, 0, f.document), false);
    f.root.completionSaveChecks = 4;
    const count = f.root.completionOwnSaveEvents.length;
    f.watch(); assert.equal(f.root.completionOwnSaveEvents.length, count);
    f.root.completionSaveChecks = 0;
    assert.equal(completionSourcesCurrent(f.root, 1, f.document), false);
    f.finish(); assert.equal(await f.pending, undefined);
  } finally { await f.cleanup(); }
});


test("unfinished disk proofs and closed-document saves fail closed without scheduling a completion retry", async () => {
  const f = await fixture();
  try {
    f.append("co"); await f.save(); f.watch();
    assert.equal(completionSourcesCurrent(f.root, 0, f.document), false, "no acceptance before disk proof completes");
    f.finish(); assert.equal(await f.pending, undefined);
    await f.settle();
    f.root.documents.delete(f.uri.toString()); f.manager.save(f.document);
    assert.equal(f.root.completionSaves.has(f.uri.toString()), false, "save map remains bounded by synchronized open documents");
  } finally { await f.cleanup(); }
});

test("an async proof cannot authorize a watcher after the root is disposed", async () => {
  const f = await fixture();
  try {
    f.append("co"); await f.save(); f.watch(); f.manager.disposed = true;
    await f.settle();
    assert.equal(f.root.completionOwnSaveEvents[0].verified, false);
    f.finish(); assert.equal(await f.pending, undefined);
  } finally { await f.cleanup(); }
});


test("nonregular disk sources fail closed without keeping a proof worker blocked", { skip: process.platform === "win32" }, async () => {
  for (const mode of ["fifo", "symlink"]) {
    const f = await fixture();
    try {
      f.append("co"); await f.save(); await fs.unlink(f.file);
      if (mode === "fifo") execFileSync("mkfifo", [f.file]);
      else { const other = path.join(f.directory, "other.robot"); await fs.writeFile(other, f.document.text); await fs.symlink(other, f.file); }
      f.watch(); await f.settle();
      assert.equal(f.root.completionOwnSaveEvents[0].verified, false);
      f.finish(); assert.equal(await f.pending, undefined, mode);
    } finally { await f.cleanup(); }
  }
});

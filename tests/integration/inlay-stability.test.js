"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const load = Module._load;
const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  InlayHintKind: { Type: 1, Parameter: 2 },
  InlayHint: class { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } },
  Range: class { constructor(line, character, last, end) { this.start = { line, character }; this.end = { line: last, character: end }; } },
  MarkdownString: class { constructor(value) { this.value = value; } }
};
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const { LanguageWorkspace } = require("../../src/integration/language-workspace");
const { changedSnapshot } = require("../../src/integration/inlay-snapshot");
Module._load = load;

const original = "*** Test Cases ***\nExample\n    Log    alpha\n    Log    beta\n    Log    gamma\n";
const range = { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } };
const raw = () => [2, 3, 4].map(line => ({ position: { line, character: 11 }, label: "message=", kind: 2 }));
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
function fixture(initial = original) {
  let text = initial;
  const state = { requests: [], events: 0, available: true };
  const root = { native: true, documents: new Map([["file:///workspace/example.robot", 1]]),
    inlayHintsChanged: { fire: () => state.events++ }, session: { capabilities: { inlayHintProvider: true },
      request: (_method, _params, { signal }) => { const request = deferred(); request.signal = signal;
        state.requests.push(request); return request.promise; } } };
  const workspace = Object.create(LanguageWorkspace.prototype);
  Object.assign(workspace, { rootFor: () => root, syncRootFor: () => root, usable: () => state.available,
    open() {}, syncOptions: () => ({ change: 1 }), send() {}, deleteDiagnostics() {},
    channel: { appendLine() {} } });
  const document = { uri: { scheme: "file", path: "/workspace/example.robot", toString: () => "file:///workspace/example.robot" },
    version: 1, isClosed: false, isDirty: true, getText: () => text,
    lineAt: line => ({ text: text.split("\n")[line] }), get lineCount() { return text.split("\n").length; } };
  const edit = (line, start, end, value) => {
    const lines = text.split("\n");
    lines[line] = lines[line].slice(0, start) + value + lines[line].slice(end);
    text = lines.join("\n"); document.version++;
    workspace.change({ document, contentChanges: [{ range: { start: { line, character: start }, end: { line, character: end } }, text: value }] });
  };
  return { workspace, root, document, state, edit };
}
async function warm(f) {
  const result = f.workspace.inlayHints(f.document, range);
  f.state.requests.at(-1).resolve(raw());
  assert.equal((await result).length, 3);
}
const labels = hints => hints?.map(hint => [hint.position.line, hint.label]);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("typing a partial call retains unrelated hints before the delayed new answer", async () => {
  const f = fixture(); await warm(f);
  f.edit(3, 4, 7, "Lo");
  let timer;
  const hints = await Promise.race([f.workspace.inlayHints(f.document, range), new Promise(resolve => {
    timer = setTimeout(() => resolve(undefined), 100);
  })]).finally(() => clearTimeout(timer));
  assert.deepEqual(labels(hints), [[2, "message="], [4, "message="]], "the provider must return safe hints before the delayed answer");
  assert.equal(f.state.requests.length, 2, "one background refresh, rather than an empty provider result");
  assert.deepEqual(labels(await f.workspace.inlayHints(f.document, range)), [[2, "message="], [4, "message="]]);
  assert.equal(f.state.requests.length, 2, "concurrent viewport requests share the refresh");
  f.state.requests[1].resolve([]); await settle();
  assert.deepEqual(await f.workspace.inlayHints(f.document, range), [], "successful empty response replaces, rather than merges, the old annotations");
});

test("a continuation insertion remaps later hints and discards the whole changed logical call", async () => {
  const f = fixture(); await warm(f);
  f.edit(3, 15, 15, "\n    ...    partial");
  assert.deepEqual(labels(await f.workspace.inlayHints(f.document, range)), [[2, "message="], [5, "message="]]);
  f.state.requests[1].resolve([]); await settle();
});

test("continued typing cannot accept an earlier version or issue a request for every key", async () => {
  const f = fixture(); await warm(f);
  f.edit(3, 4, 7, "L");
  await f.workspace.inlayHints(f.document, range);
  f.edit(3, 5, 5, "o");
  assert.deepEqual(labels(await f.workspace.inlayHints(f.document, range)), [[2, "message="], [4, "message="]]);
  assert.equal(f.state.requests.length, 2);
  f.state.requests[1].resolve([{ position: { line: 3, character: 11 }, label: "stale=" }]); await settle();
  assert.equal(f.root.inlaySnapshots.get(f.document.uri.toString()).dirty, true);
  await f.workspace.inlayHints(f.document, range);
  assert.equal(f.state.requests.length, 3, "the next refresh asks for the latest text");
  f.state.requests[2].resolve([]); await settle();
});

test("another document edit prevents an outstanding answer from reviving old dependency hints", async () => {
  const f = fixture(); await warm(f);
  f.edit(3, 4, 7, "L");
  await f.workspace.inlayHints(f.document, range);
  const library = { ...f.document, uri: { scheme: "file", path: "/workspace/library.py", toString: () => "file:///workspace/library.py" }, version: 2 };
  f.root.documents.set(library.uri.toString(), 1);
  f.workspace.change({ document: library, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "#" }] });
  f.state.requests[1].resolve(raw()); await settle();
  assert.equal(f.root.inlaySnapshots.size, 0);
});

test("library/import, declaration, variable and unknown version changes cannot retain a snapshot", () => {
  const cases = [
    ["*** Settings ***\nLibrary    Old\n", 1, 11, "New"],
    ["*** Keywords ***\nExample\n    Log    old\n", 1, 7, "New"],
    ["*** Variables ***\n${value}    old\n", 1, 12, "x"],
    ["*** Test Cases ***\nExample\n    Import Library    Old\n", 2, 22, "New"],
    ["*** Test Cases ***\nExample\n    Set Suite Variable    ${value}\n", 2, 30, "x"],
    ["*** Test Cases ***\nExample\n    VAR    ${value}    old\n", 2, 24, "x"],
    ["*** Test Cases ***\nExample\n    *** Keywords ***\n", 2, 4, "x"],
    ["*** Test Cases ***\nExample\n    [Template]    Old\n", 2, 18, "New"]
  ];
  for (const [text, line, character, inserted] of cases) {
    const lines = text.split("\n"); lines[line] = lines[line].slice(0, character) + inserted + lines[line].slice(character);
    const change = { range: { start: { line, character }, end: { line, character } }, text: inserted };
    assert.equal(changedSnapshot({ text, version: 1, items: [] }, { version: 2, getText: () => lines.join("\n") }, [change]), undefined, text);
  }
  assert.equal(changedSnapshot({ text: original, version: 1, items: raw() }, { version: 3 }, [{}]), undefined);
});

test("a failure does not cause an immediate retry loop, and closing clears the retained document", async () => {
  const f = fixture(); await warm(f);
  f.edit(3, 4, 7, "Lo");
  await f.workspace.inlayHints(f.document, range);
  const before = f.state.events;
  f.state.requests[1].resolve(null); await settle();
  assert.equal(f.state.events, before, "a refused background answer does not recursively refresh");
  f.workspace.close(f.document);
  assert.equal(f.root.inlaySnapshots.size, 0);
  assert.equal(f.root.inlayPending.size, 0);
});

test("ordinary variable arguments and return assignments retain unrelated call hints while a continuation is typed", async () => {
  const call = "    ${result}=    Build    input=${value}";
  const f = fixture(original.replace("    Log    beta", call)); await warm(f);
  f.edit(3, call.length, call.length, "\n    ...    option=${other}");
  assert.deepEqual(labels(await f.workspace.inlayHints(f.document, range)), [[2, "message="], [5, "message="]]);
  f.state.requests[1].resolve([]); await settle();
});

test("closing a document or invalidating a dependency aborts its document-owned background request", async () => {
  for (const invalidate of [f => f.workspace.close(f.document), f => f.workspace.serverRequest(f.root, "workspace/inlayHint/refresh")]) {
    const f = fixture(); await warm(f);
    f.edit(3, 4, 7, "Lo"); await f.workspace.inlayHints(f.document, range);
    assert.equal(f.state.requests[1].signal.aborted, false);
    invalidate(f);
    assert.equal(f.state.requests[1].signal.aborted, true);
    f.state.requests[1].resolve(raw()); await settle();
    assert.equal(f.root.inlaySnapshots.size, 0, "aborted late results never revive a snapshot");
  }
});

test("opening an unsaved dependency and an explicit backend refresh discard cached hints", async () => {
  const f = fixture(); await warm(f);
  const dependency = { ...f.document, uri: { toString: () => "file:///workspace/keywords.resource" } };
  LanguageWorkspace.prototype.open.call(f.workspace, dependency);
  assert.equal(f.root.inlaySnapshots.size, 0, "didOpen can change which dependency text the backend resolves");
  await warm(f);
  f.workspace.serverRequest(f.root, "workspace/inlayHint/refresh");
  assert.equal(f.root.inlaySnapshots.size, 0);
});

test("CRLF and non-BMP text edits preserve exact UTF-16 positions outside the changed statement", () => {
  const text = "*** Test Cases ***\r\nExample\r\n    Log    😀 alpha\r\n    Log    𝔘 beta\r\n";
  const lines = text.split("\r\n");
  lines[2] += "\r\n    Partial";
  const result = changedSnapshot({ text, version: 1, items: [{ position: { line: 3, character: 11 }, label: "message=" }] },
    { version: 2, getText: () => lines.join("\r\n") }, [{ range: {
      start: { line: 2, character: 19 }, end: { line: 2, character: 19 } }, text: "\r\n    Partial" }]);
  assert.deepEqual(result.items[0].position, { line: 4, character: 11 });
});

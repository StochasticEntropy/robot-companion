"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const vscode = { CodeActionTriggerKind: { Automatic: 2, Invoke: 1 } };
const load = Module._load;
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const { LanguageWorkspace } = require("../../src/integration/language-workspace");
Module._load = load;

function fixture(id = "robot-companion-native") {
  const manager = Object.create(LanguageWorkspace.prototype);
  const root = { descriptor: { id, version: "0.1.0.dev15" }, published: new Map() };
  const requests = [];
  manager.rootFor = () => root;
  manager.documentRequest = async (_document, method, params) => {
    requests.push({ method, params });
    return { root, result: [] };
  };
  return { manager, root, requests };
}
const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 }, isEqual(other) { return this === other; } };
const document = { uri: { toString: () => "file:///fixture.resource" }, version: 1 };

test("native automatic lightbulbs skip requests without this backend's published diagnostics", async () => {
  const { manager, requests } = fixture();
  for (const only of [undefined, { value: "quickfix" }]) {
    assert.deepEqual(await manager.codeActions(document, range,
      { triggerKind: 2, diagnostics: [], only }), []);
    assert.deepEqual(await manager.codeActions(document, range,
      { triggerKind: 2, diagnostics: [{ message: "Another provider's warning", range }], only }), []);
  }
  assert.deepEqual(requests, []);
});

test("automatic fixes with backend diagnostics, manual actions and explicit source actions still reach the service", async () => {
  const { manager, root, requests } = fixture();
  const diagnostic = { range, message: "Unknown keyword", severity: 0, source: "Robot Companion" };
  const item = { range, message: "Unknown keyword", severity: 1, source: "Robot Companion", code: "unknown-keyword" };
  root.published.set(document.uri.toString(), [{ diagnostic, item }]);
  await manager.codeActions(document, range, { triggerKind: 2, diagnostics: [diagnostic] });
  await manager.codeActions(document, range, { triggerKind: 1, diagnostics: [] });
  await manager.codeActions(document, range, { triggerKind: 2, diagnostics: [], only: { value: "source.addMissingImports" } });
  await manager.codeActions(document, range, { triggerKind: 2, diagnostics: [], only: { value: "" } });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0].params.context.diagnostics, [item]);
  assert.deepEqual(requests[2].params.context.only, ["source.addMissingImports"]);
});

test("other providers retain their automatic action behavior", async () => {
  for (const id of ["robotcode", "local-protocol-fixture"]) {
    const { manager, requests } = fixture(id);
    await manager.codeActions(document, range, { triggerKind: 2, diagnostics: [] });
    assert.equal(requests.length, 1);
  }
});

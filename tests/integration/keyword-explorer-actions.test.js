"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../src/integration/keyword-explorer.js"), "utf8");

function explorer() {
  const document = { version: 1, uri: { scheme: "file", path: "/suite.robot" } };
  const opened = [];
  const inserted = [];
  const editor = { document, selection: { active: { line: 0, character: 0 } },
    insertSnippet: snippet => inserted.push(snippet.text) };
  document.lineAt = () => ({ text: "", isEmptyOrWhitespace: true, range: {} });
  const vscode = { window: { activeTextEditor: editor, showTextDocument: (uri, options) => opened.push(options.selection.start.line),
    showWarningMessage() {} }, Range: class { constructor(start) { this.start = start; } },
    EndOfLine: { CRLF: 2 }, SnippetString: class { constructor() { this.text = ""; } appendText(text) { this.text += text; } } };
  const context = { module: { exports: {} }, require: name => name === "vscode" ? vscode : require(name) };
  vm.runInNewContext(source, context);
  const view = Object.create(context.module.exports.KeywordExplorer.prototype);
  const group = { namespace: "Steps", kind: "resource", uri: "steps.resource" };
  const location = line => ({ uri: "steps.resource", range: { start: { line } } });
  const keyword = (line, call) => ({ type: "keyword", document, group, keyword: { name: "Step", call, location: location(line) } });
  const missing = line => ({ type: "unresolved", document, entry: { message: "Missing.py", location: location(line) } });
  const listing = { document, version: 1, revision: 1, groups: [{ children: [keyword(12, "Steps.Step")] }], unresolved: [missing(5)] };
  Object.assign(view, { document, revision: 1, load: () => listing });
  return { view, keyword, missing, opened, inserted, vscode, listing };
}

test("keyword and import rows open the current source line and insert the current call spelling", async () => {
  const { view, keyword, missing, opened, inserted } = explorer();
  const old = keyword(8, "Step");
  await view.openDefinition(old);
  await view.openDefinition(missing(2));
  await view.insert(old);
  assert.deepEqual(opened, [12, 5]);
  assert.deepEqual(inserted, ["    Steps.Step"]);
});

test("switching editor during lookup discards pending navigation and insertion", async () => {
  const { view, keyword, opened, inserted, vscode, listing } = explorer();
  const old = keyword(8, "Step");
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  view.load = () => pending;
  const actions = [view.openDefinition(old), view.insert(old)];
  vscode.window.activeTextEditor = { document: { version: 1, uri: { scheme: "file", path: "/other.robot" } } };
  finish(listing);
  await Promise.all(actions);
  await view.openDefinition(old);
  await view.insert(old);
  assert.deepEqual(opened, []);
  assert.deepEqual(inserted, []);
});

test("an open Python definition keeps the suite's keyword and unresolved import navigation available", async () => {
  const { view, keyword, missing, opened, inserted, vscode } = explorer();
  vscode.window.activeTextEditor = { document: { uri: { scheme: "file", path: "/library.py" } } };
  await view.openDefinition(keyword(8, "Step"));
  await view.openDefinition(missing(2));
  await view.insert(keyword(8, "Step"));
  assert.deepEqual(opened, [12, 5]);
  assert.deepEqual(inserted, []);
});

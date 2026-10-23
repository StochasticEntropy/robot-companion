"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const { fileURLToPath } = require("node:url");
class Uri {
  constructor(value) { this.value = value; this.scheme = "file"; this.fsPath = this.path = fileURLToPath(value); }
  toString() { return this.value; }
  static parse(value) { return new Uri(value); }
}
let mode = "owned";
const source = Uri.parse("file:///workspace/suite.robot");
const vscode = { Uri, Range: class {}, CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } dispose() {} },
  window: { activeTextEditor: { document: { uri: source } } },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => key === "integrationMode" ? mode : fallback }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { RobotTestRunner, RobotRunCodeLensProvider } = require("../../src/features/run").__test__;
Module._load = load;

test("owned Run Test, Run at Cursor and Run Suite route once to TestWorkspace even when it returns undefined", async () => {
  mode = "owned";
  const native = [], legacy = [], runner = new RobotTestRunner({});
  runner.testWorkspace = { runFromEditor: async request => { native.push(request); } };
  runner.run = async (...args) => { legacy.push(args); };
  await runner.runTest(source, "Same", 8); await runner.runTestAtCursor(); await runner.runSuite(source);
  assert.deepEqual(native, [{ kind: "test", uri: source, testName: "Same", line: 8 }, { kind: "cursor" }, { kind: "suite", uri: source }]);
  assert.deepEqual(legacy, []);
  runner.testWorkspace.runFromEditor = async () => { throw new Error("native refused"); };
  await assert.rejects(runner.runTest(source, "Same", 8), /native refused/);
  assert.deepEqual(legacy, [], "a native refusal must never run the legacy command afterwards");
});
test("coexistence retains the legacy commands and explicit target file", async () => {
  mode = "coexistence";
  const legacy = [], runner = new RobotTestRunner({});
  runner.testWorkspace = { runFromEditor() { throw new Error("native must not be called in coexistence"); } };
  runner.run = async (...args) => { legacy.push(args); };
  runner._readTests = () => ({ tests: [{ line: 1, endLine: 3, name: "At Cursor" }] });
  vscode.window.activeTextEditor.selection = { active: { line: 2 } };
  await runner.runTest(source, "Named", 8); await runner.runTestAtCursor(); await runner.runSuite(source);
  assert.deepEqual(legacy, [[source, "Named"], [source, "At Cursor"], [source, undefined]]);
});
test("CodeLens duplicate names carry distinct positive one-based source lines", () => {
  const provider = new RobotRunCodeLensProvider();
  const text = "*** Test Cases ***\nSame ${ENV}\n    No Operation\n\nSame ${ENV}\n    No Operation\n";
  const lenses = provider.provideCodeLenses({ uri: source, getText: () => text });
  assert.deepEqual(lenses.filter(lens => lens.command.title === "Run Test").map(lens => lens.command.arguments),
    [[source.toString(), "Same ${ENV}", 2], [source.toString(), "Same ${ENV}", 5]]);
  provider.dispose();
});

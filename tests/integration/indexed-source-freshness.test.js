"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");
const test = require("node:test");
const uri = value => ({ scheme: "file", fsPath: fileURLToPath(value), path: fileURLToPath(value), toString: () => value });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-metadata-freshness-"));
const folder = { uri: uri(pathToFileURL(directory).href) };
class CancellationTokenSource {
  constructor() { this.listeners = new Set(); this.token = { isCancellationRequested: false,
    onCancellationRequested: fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; } }; }
  cancel() { this.token.isCancellationRequested = true; for (const fn of [...this.listeners]) fn(); }
  dispose() { this.listeners.clear(); }
}
const vscode = { CancellationTokenSource, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  workspace: { workspaceFolders: [folder], textDocuments: [], getWorkspaceFolder: () => folder,
  getConfiguration: () => ({ get: (_key, fallback) => fallback }) }, window: {}, debug: {},
  Uri: { file: value => uri(pathToFileURL(value).href), parse: uri } };
const filename = path.resolve(__dirname, "../../src/core/extension.js");
const subject = new Module(filename, module); subject.filename = filename; subject.paths = Module._nodeModulePaths(path.dirname(filename));
const original = Module._load;
let Reader;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : original.call(this, name, ...args); };
  subject._compile(fs.readFileSync(filename, "utf8") + `
module.exports.SourceFreshnessTest = { RobotEnumHintService, RobotReturnComputeWorker,
  resolveKeywordReturnPreviewFromVariableContext, setLanguageWorkspace: value => { languageWorkspace = value; } };`, filename);
  Reader = require("../../src/integration/indexed-source-reader");
} finally { Module._load = original; }
const api = subject.exports.SourceFreshnessTest;
const Service = api.RobotEnumHintService;
const PYTHON = "from dataclasses import dataclass\nfrom robot.api.deco import keyword\n@dataclass\nclass Record:\n    old_field: str\n@keyword('Make Record')\ndef make_record() -> Record:\n    pass\n";
function fixture(t, name = "Library.py") {
  const service = new Service(), state = service._getOrCreateWorkspaceState(folder);
  const file = vscode.Uri.file(path.join(directory, name)); fs.writeFileSync(file.fsPath, PYTHON);
  state.pythonFileContribByPath.set(file.fsPath, service._parsePythonFileContribution(folder, file, PYTHON));
  service._recomputeDerivedIndexFromContributions(state); state.initialized = true;
  t.after(() => { service.dispose(); fs.rmSync(file.fsPath, { force: true }); vscode.workspace.textDocuments = []; });
  return { service, state, file, index: state.derivedIndex };
}
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("external same-size/same-mtime write refreshes only the selected existing index contribution", async t => {
  const { service, file, index } = fixture(t);
  const calls = []; service._readIndexedSource = async (...args) => { calls.push(args[0].fsPath); return Reader.readIndexedSource(...args); };
  const before = fs.statSync(file.fsPath);
  fs.writeFileSync(file.fsPath, PYTHON.replace("old_field", "new_field")); fs.utimesSync(file.fsPath, before.atime, before.mtime);
  assert.equal(fs.statSync(file.fsPath).size, before.size);
  const fresh = await index.ensureSourcesCurrent([file.fsPath]);
  assert.equal(fresh.changed, true);
  assert.notEqual(fresh.index, index);
  assert.equal(fresh.index.structuredTypesByName.get("Record")[0].fields[0].name, "new_field");
  assert.equal(index.structuredTypesByName.get("Record")[0].fields[0].name, "old_field", "Old snapshots remain immutable");
  assert.deepEqual(calls, [file.fsPath], "No workspace content scan accompanies selected-source validation");
  const again = await fresh.index.ensureSourcesCurrent([file.fsPath]); assert.equal(again.changed, false);
  const oldCaller = await index.ensureSourcesCurrent([file.fsPath]); assert.equal(oldCaller.changed, true);
});

test("exact source validation follows the open overlay, then disk after close", async t => {
  const { file, index } = fixture(t, "Overlay.py");
  const document = { uri: file, getText: () => PYTHON.replace("old_field", "live_field"), isClosed: false };
  vscode.workspace.textDocuments = [document];
  const overlay = await index.ensureSourcesCurrent([file.fsPath]);
  assert.equal(overlay.index.structuredTypesByName.get("Record")[0].fields[0].name, "live_field");
  document.isClosed = true;
  const disk = await overlay.index.ensureSourcesCurrent([file.fsPath]);
  assert.equal(disk.index.structuredTypesByName.get("Record")[0].fields[0].name, "old_field");
});

test("missing or over-budget selected files refuse validation rather than bless old metadata", async t => {
  const { file, index } = fixture(t, "Missing.py");
  fs.unlinkSync(file.fsPath);
  await assert.rejects(index.ensureSourcesCurrent([file.fsPath]), /ENOENT/);
  fs.writeFileSync(file.fsPath, PYTHON); fs.truncateSync(file.fsPath, Reader.MAX_FILE_BYTES + 1);
  await assert.rejects(index.ensureSourcesCurrent([file.fsPath]), /bounded regular file/);
  assert.equal(index.structuredTypesByName.get("Record")[0].fields[0].name, "old_field");
});

test("dependency count is bounded before any read and unrelated files are not inspected", async t => {
  const { service, state, file, index } = fixture(t, "Budget.py"); let reads = 0;
  service._readIndexedSource = async () => { reads += 1; return PYTHON; };
  for (let i = 0; i < 65; i++) state.pythonFileContribByPath.set(`${file.fsPath}.${i}`, { sourceDigest: "none" });
  await assert.rejects(index.ensureSourcesCurrent(Array.from(state.pythonFileContribByPath.keys())), /64-file/);
  assert.equal(reads, 0);
  await index.ensureSourcesCurrent([file.fsPath, "/not/an/indexed/source.py"]);
  assert.equal(reads, 1);
});

test("warm actual type-worker dependency detects an external helper edit and rechecks native identity before showing new fields", async t => {
  const service = new Service(), state = service._getOrCreateWorkspaceState(folder);
  const library = vscode.Uri.file(path.join(directory, "CrossLibrary.py")), types = vscode.Uri.file(path.join(directory, "CrossTypes.py"));
  const libraryText = "from CrossTypes import Record\nfrom robot.api.deco import keyword\n@keyword('Make Record')\ndef make_record() -> Record:\n    pass\n";
  const typeText = "from dataclasses import dataclass\n@dataclass\nclass Record:\n    old_field: str\n";
  for (const [file, content] of [[library, libraryText], [types, typeText]]) {
    fs.writeFileSync(file.fsPath, content);
    state.pythonFileContribByPath.set(file.fsPath, service._parsePythonFileContribution(folder, file, content));
  }
  service._recomputeDerivedIndexFromContributions(state); state.initialized = true;
  const worker = new api.RobotReturnComputeWorker(service);
  const nativeRoot = {}; let definitions = 0;
  api.setLanguageWorkspace({ mode: () => "owned", rootFor: () => nativeRoot,
    definitionIdentity: async () => { definitions += 1; return { status: "resolved", uri: library.toString(), current: () => true,
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 15 } } }; } });
  t.after(async () => { const child = worker._worker; worker.dispose(); if (child) await child.terminate();
    service.dispose(); api.setLanguageWorkspace(undefined); fs.rmSync(library.fsPath, { force: true }); fs.rmSync(types.fsPath, { force: true }); });
  const document = { uri: vscode.Uri.file(path.join(directory, "suite.robot")), version: 1,
    lineAt: () => ({ text: "    ${record}=    Make Record" }) };
  const variable = { owner: { id: "test", name: "Example" }, variableToken: { token: "${record}" },
    assignment: { startLine: 0, keywordName: "Make Record" } };
  const options = { maxDepth: 1, maxFieldsPerType: 20, includeTechnical: false, returnComputeWorker: worker };
  const first = await api.resolveKeywordReturnPreviewFromVariableContext(document, {}, variable, service, options);
  assert.ok(first.simpleAccess.firstLevel.some(value => value.includes("old_field")), JSON.stringify(first.simpleAccess));
  const originalStat = fs.statSync(types.fsPath);
  fs.writeFileSync(types.fsPath, typeText.replace("old_field", "new_field")); fs.utimesSync(types.fsPath, originalStat.atime, originalStat.mtime);
  const second = await api.resolveKeywordReturnPreviewFromVariableContext(document, {}, variable, service, options);
  assert.ok(second.simpleAccess.firstLevel.some(value => value.includes("new_field")), "A warm type cache must not hide a changed source dependency");
  assert.equal(second.simpleAccess.firstLevel.some(value => value.includes("old_field")), false);
  assert.ok(definitions >= 3, "The changed helper triggers fresh native binding before recomputing metadata");
});

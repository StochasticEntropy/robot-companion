"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const test = require("node:test");

const disposable = () => ({ dispose() {} });
const uri = value => ({ scheme: "file", fsPath: fileURLToPath(value), path: fileURLToPath(value), toString: () => value });
const folder = { name: "Public completion fixture", uri: uri("file:///workspace") };
const vscode = {
  workspace: { getConfiguration: () => ({ get: (key, fallback) => key === "enableEnumValueHover" ? false : fallback }),
    getWorkspaceFolder: () => folder, workspaceFolders: [folder], textDocuments: [],
    onDidChangeConfiguration: disposable, onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable,
    onDidChangeTextDocument: disposable, onDidSaveTextDocument: disposable },
  window: { activeTextEditor: undefined, visibleTextEditors: [], createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  debug: { activeDebugSession: undefined, sessions: [] },
  commands: { executeCommand: async () => undefined },
  EventEmitter: class { constructor() { this.event = disposable; } fire() {} dispose() {} },
  Range: class { constructor(line, character, endLine, endCharacter) {
    this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
  } },
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
  CompletionList: class { constructor(items, isIncomplete) { Object.assign(this, { items, isIncomplete }); } },
  CompletionItemKind: { Field: 5, Variable: 6, Value: 12, EnumMember: 20 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  MarkdownString: class { constructor(value = "") { this.value = value; }
    appendMarkdown(value) { this.value += value; } appendText(value) { this.value += value; } },
  Uri: { parse: uri, file: value => uri(pathToFileURL(value).href) }
};

// Compile the complete production module unchanged, then expose private classes
// only in this test's module instance. No provider/helper implementation is copied.
const filename = path.resolve(__dirname, "../../src/core/extension.js");
const subject = new Module(filename, module);
subject.filename = filename;
subject.paths = Module._nodeModulePaths(path.dirname(filename));
const originalLoad = Module._load;
let api, LanguageWorkspace;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  subject._compile(fs.readFileSync(filename, "utf8") + `\nmodule.exports.completionTest = {
    RobotTypedVariableCompletionProvider, RobotRuntimeCacheService, RobotEnumHintService,
    COMPANION_COMPLETION_TRIGGERS, setLanguageWorkspace: value => { languageWorkspace = value; }
  };`, filename);
  api = subject.exports.completionTest;
  ({ LanguageWorkspace } = require("../../src/integration/language-workspace"));
} finally { Module._load = originalLoad; }

const PYTHON = `from dataclasses import dataclass
from robot.api.deco import keyword

@dataclass
class Detail:
    name: str
    count: int

@dataclass
class Payload:
    detail: Detail

@dataclass
class Other:
    value: int

@keyword("Make Payload")
def make_payload() -> Payload:
    pass

@keyword("Make Other")
def make_other() -> Other:
    pass

@keyword("Consume")
def consume(payload: Payload, note: str = ""):
    pass
`;
const ROBOT = "*** Test Cases ***\nCompletion\n" +
  "    ${record}=    Make Payload\n" +
  "    ${wrong}=    Make Other\n" +
  "    Consume    payload=stale    note=keep\n" +
  "    Consume    payload=${record.detail.na}    note=keep\n" +
  "    ${future}=    Make Payload\n" +
  "Other Owner\n    ${other}=    Make Payload\n";

function document(text = ROBOT) {
  return { uri: uri("file:///workspace/completion.robot"), languageId: "robotframework", version: 1,
    getText: () => text, lineAt: line => ({ text: text.split("\n")[line] || "" }), lineCount: text.split("\n").length };
}
function apply(document, edit) {
  assert.equal(edit.range.start.line, edit.range.end.line, "Completion replaces one value on one line");
  const line = document.lineAt(edit.range.start.line).text;
  return line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
}
function fixture(t) {
  const doc = document(), parser = new subject.exports.__test__.RobotDocumentationService();
  const hints = new api.RobotEnumHintService(), state = hints._getOrCreateWorkspaceState(folder);
  const library = vscode.Uri.file("/workspace/CompletionLibrary.py");
  const install = source => {
    const contribution = hints._parsePythonFileContribution(folder, library, source);
    state.pythonFileContribByPath.set(library.fsPath, contribution);
    hints._recomputeDerivedIndexFromContributions(state);
    state.initialized = true;
  };
  install(PYTHON);
  let indexReads = 0;
  const readIndex = hints.getIndexForDocument.bind(hints);
  hints.getIndexForDocument = async (...args) => { indexReads++; return readIndex(...args); };
  const cache = new api.RobotRuntimeCacheService(hints);
  const provider = new api.RobotTypedVariableCompletionProvider(parser, hints, cache);
  const definitions = [];
  const manager = Object.create(LanguageWorkspace.prototype);
  const root = { native: true, descriptor: { id: "robot-companion-native" },
    session: { capabilities: { completionProvider: { triggerCharacters: [".", "!"] } } } };
  manager.rootFor = () => root;
  manager.mode = () => "owned";
  manager.channel = { appendLine() {} };
  manager.companion = { completion: { provider, triggerCharacters: api.COMPANION_COMPLETION_TRIGGERS } };
  // A controlled native source identity/response boundary: actual backend/UI
  // conformance is separate; parser, index, cache, provider and merger are real.
  manager.definitionIdentity = async (_document, position) => {
    definitions.push(position);
    const target = state.derivedIndex.keywordReturnDefinitions.get("makepayload")[0];
    return { status: "resolved", uri: target.sourceUri,
      range: { start: { line: target.sourceLine, character: 0 }, end: { line: target.sourceLine, character: 10 } },
      current: () => true };
  };
  api.setLanguageWorkspace(manager);
  t.after(() => { api.setLanguageWorkspace(undefined); provider.dispose(); cache.dispose(); hints.dispose(); parser.dispose(); });
  return { doc, parser, hints, state, cache, provider, manager, root, definitions,
    indexReads: () => indexReads, install,
    typed: { line: 4, character: doc.lineAt(4).text.indexOf("stale") + 2 },
    nested: { line: 5, character: doc.lineAt(5).text.indexOf("na}") + 2 } };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Completion background work did not settle")), 3000);
  })]); } finally { clearTimeout(timer); }
}

async function warmTyped(f) {
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const schedule = f.cache.scheduleBackgroundTask.bind(f.cache);
  let scheduled = 0;
  f.cache.scheduleBackgroundTask = (key, task, options) => {
    scheduled++;
    return schedule(key, async () => { try { return await task(); } finally { done(); } }, options);
  };
  assert.equal(await f.provider.provideCompletionItems(f.doc, f.typed), undefined, "Cold request queues real background work");
  await bounded(completed);
  return () => scheduled;
}

test("production typed-variable provider warms from real local assignments and replaces only the named value", async t => {
  const f = fixture(t), scheduled = await warmTyped(f);
  const beforeReads = f.indexReads();
  const result = await f.provider.provideCompletionItems(f.doc, f.typed);
  assert.deepEqual(result.items.map(item => item.label), ["${record}"], "Reject wrong type, future and other-owner assignments");
  const item = result.items[0];
  assert.equal(item.kind, vscode.CompletionItemKind.Variable);
  assert.equal(item.detail, "Type-matched variable for payload");
  assert.match(item.documentation.value, /Make Payload.*line 3/);
  assert.equal(apply(f.doc, item.textEdit), "    Consume    payload=${record}    note=keep");
  assert.equal(item.textEdit.range.start.character, f.doc.lineAt(4).text.indexOf("stale"));
  assert.equal(item.textEdit.range.end.character, f.doc.lineAt(4).text.indexOf("stale") + 5);
  assert.deepEqual((await f.provider.provideCompletionItems(f.doc, f.typed)).items, result.items);
  assert.equal(scheduled(), 1, "Warm requests schedule no additional scan");
  assert.equal(f.indexReads(), beforeReads, "Warm cache reuses type matches");
});

test("production nested-member completion preserves the surrounding variable and brace, then reuses its memo", async t => {
  const f = fixture(t);
  const result = await f.provider.provideCompletionItems(f.doc, f.nested);
  assert.deepEqual(result.items.map(item => item.label), ["name"]);
  const item = result.items[0];
  assert.equal(item.kind, vscode.CompletionItemKind.Field);
  assert.equal(apply(f.doc, item.textEdit), "    Consume    payload=${record.detail.name}    note=keep");
  assert.equal(item.textEdit.range.start.character, f.doc.lineAt(5).text.indexOf("na}"));
  assert.equal(item.textEdit.range.end.character, f.nested.character);
  assert.equal(f.definitions.length, 1, "Nested type comes from the owned source identity");
  assert.equal(f.definitions[0].line, 2, "Resolve the assigning keyword, not the consuming call");
  const reads = f.indexReads();
  assert.deepEqual((await f.provider.provideCompletionItems(f.doc, f.nested)).items, result.items);
  assert.equal(f.indexReads(), reads);
  assert.equal(f.definitions.length, 1);
});

test("owned native completion merges real Companion TextEdits, deduplicates backend items and routes triggers", async t => {
  const f = fixture(t), requests = [], providerCalls = [];
  const provide = f.provider.provideCompletionItems.bind(f.provider);
  f.provider.provideCompletionItems = (...args) => { providerCalls.push(args); return provide(...args); };
  f.manager.documentRequest = async (_document, method, params) => {
    requests.push({ method, params });
    return { root: f.root, result: [{ label: "name", insertText: "name" }, { label: "nativeOnly" }] };
  };
  const result = await f.manager.completion(f.doc, f.nested, undefined,
    { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: "." });
  assert.deepEqual(result.items.map(item => item.label), ["name", "nativeOnly"]);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0][3].triggerCharacter, ".");
  assert.equal(result.items[0].kind, vscode.CompletionItemKind.Field, "Companion edit wins the duplicate");
  assert.equal(apply(f.doc, result.items[0].textEdit), "    Consume    payload=${record.detail.name}    note=keep");
  assert.deepEqual(requests[0], { method: "textDocument/completion", params: { position: f.nested,
    context: { triggerKind: 2, triggerCharacter: "." } } });
  const reads = f.indexReads();
  await f.manager.completion(f.doc, f.nested, undefined,
    { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: "!" });
  assert.equal(providerCalls.length, 1, "Backend-only trigger must not invoke even a warm Companion provider");
  assert.equal(f.indexReads(), reads);
  assert.equal(requests.length, 2);
  await warmTyped(f);
  assert.equal(providerCalls.length, 2, "Cold typed warmup invokes the real provider once");
  const companionOnly = await f.manager.completion(f.doc, f.typed, undefined,
    { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: "=" });
  assert.deepEqual(companionOnly.items.map(item => item.label), ["${record}"]);
  assert.equal(providerCalls.length, 3);
  assert.equal(providerCalls[2][3].triggerCharacter, "=");
  assert.deepEqual(providerCalls[2][1], f.typed);
  assert.equal(requests.length, 2, "Companion-only trigger never asks native completion");
});

test("a changed Python index invalidates warm nested members instead of returning the old field", async t => {
  const f = fixture(t);
  assert.equal((await f.provider.provideCompletionItems(f.doc, f.nested)).items[0].label, "name");
  f.install(PYTHON.replace("name: str", "nickname: str"));
  f.hints._bumpWorkspaceGeneration(folder.uri.toString());
  const result = await f.provider.provideCompletionItems(f.doc, f.nested);
  assert.equal(result, undefined, "The old 'na' prefix must not retain name from the previous index");
  const fresh = document(ROBOT.replace("detail.na}", "detail.ni}"));
  fresh.version = 2;
  const position = { line: 5, character: fresh.lineAt(5).text.indexOf("ni}") + 2 };
  const updated = await f.provider.provideCompletionItems(fresh, position);
  assert.deepEqual(updated.items.map(item => item.label), ["nickname"]);
  assert.equal(apply(fresh, updated.items[0].textEdit), "    Consume    payload=${record.detail.nickname}    note=keep");
});

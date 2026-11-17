"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fileURLToPath, pathToFileURL } = require("node:url");

const uri = value => ({ fsPath: fileURLToPath(value), scheme: "file", toString: () => value });
const fileUri = file => uri(pathToFileURL(file).href);
const vscode = {
  Uri: { file: fileUri, parse: uri },
  Range: class {
    constructor(line, character, endLine, endCharacter) {
      this.start = { line, character };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  WorkspaceEdit: class {
    constructor() { this.targets = []; }
    replace(target) { this.targets.push(target.fsPath); }
  },
  workspace: {
    workspaceFolders: [],
    textDocuments: [],
    getWorkspaceFolder(target) {
      return this.workspaceFolders.find(folder =>
        target.fsPath.startsWith(folder.uri.fsPath + path.sep));
    }
  }
};
const load = Module._load;
Module._load = function (name, ...args) { return name === "vscode" ? vscode : load.call(this, name, ...args); };
let protocol;
try { protocol = require("../../src/integration/language-protocol"); }
finally { Module._load = load; }

const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" };
const changes = (...files) => ({ changes: Object.fromEntries(files.map(file => [fileUri(file).toString(), [edit]])) });
const folder = file => ({ name: path.basename(file), uri: fileUri(file) });

test("workspace edits map canonical files to the owning editor URI and protect other roots", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rc-workspace-edit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owned = path.join(root, "owned");
  const nested = path.join(owned, "nested");
  const sibling = path.join(root, "owned-sibling");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(sibling);
  const alias = path.join(root, "alias");
  const nestedAlias = path.join(root, "nested-alias");
  fs.symlinkSync(owned, alias, "junction");
  fs.symlinkSync(nested, nestedAlias, "junction");
  fs.symlinkSync(sibling, path.join(owned, "escape"), "junction");
  fs.symlinkSync(path.join(root, "no-such-folder"), path.join(owned, "dangling"), "junction");

  const suite = path.join(owned, "suite.robot");
  const nestedSuite = path.join(nested, "suite.robot");
  const siblingSuite = path.join(sibling, "suite.robot");
  for (const file of [suite, nestedSuite, siblingSuite]) fs.writeFileSync(file, "");
  const editorSuite = path.join(alias, "suite.robot");
  const rootFolder = folder(alias);
  const nestedFolder = folder(nestedAlias);
  const siblingFolder = folder(sibling);
  vscode.workspace.workspaceFolders = [nestedFolder, rootFolder, siblingFolder];

  assert.deepEqual(protocol.workspaceEdit(changes(suite), rootFolder).targets, [editorSuite]);
  assert.deepEqual(protocol.workspaceEdit(changes(nestedSuite), nestedFolder).targets,
    [path.join(nestedAlias, "suite.robot")]);
  for (const refused of [nestedSuite, siblingSuite, path.join(alias, "escape", "suite.robot"),
    path.join(alias, "dangling", "suite.robot")]) {
    assert.throws(() => protocol.workspaceEdit(changes(suite, refused), rootFolder), /outside/);
  }
  const unsaved = path.join(owned, "new", "untitled.robot");
  assert.deepEqual(protocol.workspaceEdit(changes(unsaved), rootFolder).targets,
    [path.join(alias, "new", "untitled.robot")]);

  vscode.workspace.textDocuments = [{ uri: fileUri(editorSuite), version: 2 }];
  assert.throws(() => protocol.workspaceEdit({ documentChanges: [
    { textDocument: { uri: fileUri(suite).toString(), version: 1 }, edits: [edit] }
  ] }, rootFolder), /older version/);
});

test("workspace rename edits the existing buffers across aliases and refuses stale or competing versions", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rc-open-edits-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = path.join(root, "canonical");
  const alias = path.join(root, "alias");
  fs.mkdirSync(canonical);
  fs.symlinkSync(canonical, alias, "junction");
  const rootFolder = folder(alias);
  vscode.workspace.workspaceFolders = [rootFolder];

  const suite = path.join(canonical, "suite.robot");
  const library = path.join(canonical, "Library.py");
  const aliasLibrary = path.join(alias, "Library.py");
  fs.writeFileSync(suite, "");
  fs.writeFileSync(library, "");
  const suiteBuffer = { uri: fileUri(path.join(alias, "suite.robot")), version: 4, isDirty: true };
  const libraryBuffer = { uri: fileUri(library), version: 1, isDirty: false };
  const openBuffers = [suiteBuffer, libraryBuffer];
  vscode.workspace.textDocuments = openBuffers;
  const previousVersions = new Map(openBuffers.map(buffer => [buffer.uri.toString(), buffer.version]));
  const synchronizedVersions = new Map([[suiteBuffer.uri.toString(), suiteBuffer.version]]);
  const context = { previousVersions, synchronizedVersions };
  const rename = changes(suite, library);
  assert.deepEqual(protocol.workspaceEdit(rename, rootFolder, context).targets,
    [suiteBuffer.uri.fsPath, library]);

  libraryBuffer.isDirty = true;
  assert.throws(() => protocol.workspaceEdit(rename, rootFolder, context), /backend does not have the current buffer/);
  libraryBuffer.isDirty = false;
  libraryBuffer.version += 1;
  assert.throws(() => protocol.workspaceEdit(rename, rootFolder, context), /older version/);
  libraryBuffer.version -= 1;
  vscode.workspace.textDocuments = [...openBuffers, { uri: fileUri(aliasLibrary), version: 1 }];
  assert.throws(() => protocol.workspaceEdit(rename, rootFolder, context), /duplicate editor/);
  vscode.workspace.textDocuments.at(-1).isClosed = true;
  assert.deepEqual(protocol.workspaceEdit(rename, rootFolder, context).targets,
    [suiteBuffer.uri.fsPath, library]);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { definitionIdentity, indexedSourcePath, metadataAtDefinition } = require("../../src/integration/definition-identity");
const range = (line, character = 4) => ({ start: { line, character }, end: { line, character: character + 12 } });
const link = (uri, line) => ({ targetUri: uri, targetSelectionRange: range(line) });

test("source identity handles Location/DefinitionLink and deduplicates the same resolved target", () => {
  assert.deepEqual(definitionIdentity([link("file:///AuditLibrary.py", 11),
    { uri: "file:///AuditLibrary.py", range: range(11) }]),
  { status: "resolved", uri: "file:///AuditLibrary.py", range: range(11) });
});

test("absent and ambiguous definitions never choose a global first candidate", () => {
  assert.equal(definitionIdentity(undefined).status, "unresolved");
  assert.equal(definitionIdentity([link("file:///AuditLibrary.py", 11), link("file:///AShadow.py", 4)]).status, "ambiguous");
  assert.equal(definitionIdentity([link("file:///AuditLibrary.py", 11), link("file:///AuditLibrary.py", 20)]).status, "ambiguous");
});

test("metadata joins by resolved URI and line across returned aliases without name guessing", () => {
  const shadow = { sourceUri: "file:///AShadow.py", sourceLine: 4 };
  const imported = { sourceUri: "file:///AuditLibrary.py", sourceLine: 11, normalizedDocstring: "Imported" };
  const index = new Map([["buildrecord", [shadow]], ["returnedalias", [imported]]]);
  assert.equal(metadataAtDefinition(index, definitionIdentity([link(imported.sourceUri, 11)])), imported);
  assert.equal(metadataAtDefinition(index, definitionIdentity([link(imported.sourceUri, 12)])), undefined);
  assert.equal(metadataAtDefinition(index, { status: "ambiguous" }), undefined);
});

test("canonical definitions find indexed metadata and freshness through a workspace symlink", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rc-definition-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "real workspace");
  const alias = path.join(root, "workspace alias");
  const file = path.join(workspace, "Library.py");
  const indexedFile = path.join(alias, "Library.py");
  const shadowFile = path.join(root, "Library.py");
  fs.mkdirSync(workspace);
  fs.writeFileSync(file, "");
  fs.writeFileSync(shadowFile, "");
  fs.symlinkSync(workspace, alias, "junction");

  const imported = { sourceUri: pathToFileURL(indexedFile).href, sourceLine: 11 };
  const shadow = { sourceUri: pathToFileURL(shadowFile).href, sourceLine: 11 };
  const index = new Map([["keyword", [shadow, imported]]]);
  const identity = definitionIdentity([link(pathToFileURL(file).href, 11)]);
  assert.equal(metadataAtDefinition(index, identity), imported);
  assert.equal(metadataAtDefinition(index, definitionIdentity([link(pathToFileURL(file).href, 12)])), undefined);
  assert.equal(metadataAtDefinition(new Map([["keyword", [shadow]]]), identity), undefined);

  const paths = new Map([[indexedFile, imported], [shadowFile, shadow]]);
  assert.equal(indexedSourcePath(paths, file, alias), indexedFile);
  assert.equal(indexedSourcePath(paths, path.join(root, "missing", "Library.py"), alias), undefined);
});

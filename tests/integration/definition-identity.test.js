"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { definitionIdentity, metadataAtDefinition } = require("../../src/integration/definition-identity");
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

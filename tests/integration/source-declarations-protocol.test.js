"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const vscode = {
  Uri: { parse(value) { return { scheme: value.split(":")[0], toString: () => value }; } },
  Range: class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } },
  Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
  MarkdownString: class { constructor() { this.value = ""; } appendMarkdown(value) { this.value += value; } appendText(value) { this.value += value; } }
};
const load = Module._load;
Module._load = function (name, ...rest) { return name === "vscode" ? vscode : load.call(this, name, ...rest); };
const protocol = require("../../src/integration/language-protocol");
Module._load = load;
const { definitionIdentity, metadataAtDefinition } = require("../../src/integration/definition-identity");
const range = { start: { line: 8, character: 4 }, end: { line: 8, character: 10 } };
const uri = "file:///ExampleProject/api.py";

test("source declarations retain exact identity and cannot be upgraded by a duplicate ordinary location", () => {
  const declaration = { uri, range, sourceKind: "declaration" };
  for (const locations of [[declaration, { uri, range }], [{ uri, range }, declaration]]) {
    const identity = definitionIdentity(protocol.normalizeDefinitions(locations));
    assert.equal(identity.sourceKind, "declaration");
    assert.equal(identity.status, "resolved");
    const candidate = { sourceUri: uri, sourceLine: 8, normalizedDocstring: "Declared source docs" };
    assert.equal(metadataAtDefinition(new Map([["alias", [candidate]]]), identity), candidate);
    assert.equal(metadataAtDefinition(new Map([["same name", [{ ...candidate, sourceUri: "file:///Unimported.py" }]]]), identity), undefined);
  }
  assert.equal(definitionIdentity(protocol.normalizeDefinitions([{ targetUri: uri, targetRange: range,
    targetSelectionRange: range, sourceKind: "declaration" }])).sourceKind, "declaration");
});

test("unknown source markers and non-file declaration locations are refused", () => {
  assert.throws(() => protocol.normalizeDefinitions([{ uri, range, sourceKind: "runtime-verified" }]), /source kind/);
  assert.throws(() => protocol.normalizeDefinitions([{ uri: "https://example.test/library.py", range, sourceKind: "declaration" }]), /file/);
});

function keywords(sourceKind = "declaration", runtimeSignatureKnown = false) {
  return { imports: [{ kind: "library", name: "ExampleProject.api.Api", namespace: "Selected", uri,
    keywords: [{ name: "Submit Example Request", namespace: "Selected", kind: "library", sourceKind,
      runtimeSignatureKnown, signature: ["partner: str"], required: [{ name: "partner", named: false }],
      documentation: "Declared source docs", location: { uri, range, sourceKind } }] }] };
}

test("keyword lists validate and preserve declared parameters with runtime-unknown markers", () => {
  const keyword = protocol.documentKeywords(keywords()).imports[0].keywords[0];
  assert.equal(keyword.sourceKind, "declaration");
  assert.equal(keyword.runtimeSignatureKnown, false);
  assert.equal(keyword.location.sourceKind, "declaration");
  assert.deepEqual(keyword.signature, ["partner: str"]);
  assert.deepEqual(keyword.required, [{ name: "partner", named: false }]);
  assert.throws(() => protocol.documentKeywords(keywords("declaration", true)), /runtime signature/);
  assert.throws(() => protocol.documentKeywords(keywords("runtime-verified", false)), /source kind/);
  const unpaired = keywords(); delete unpaired.imports[0].keywords[0].sourceKind;
  assert.throws(() => protocol.documentKeywords(unpaired), /runtime signature/);
  const mismatch = keywords(); delete mismatch.imports[0].keywords[0].location.sourceKind;
  assert.throws(() => protocol.documentKeywords(mismatch), /different source kinds/);
});

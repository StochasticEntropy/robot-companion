"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const { presentSemanticTokenData } = require("../../src/integration/semantic-presentation");
const load = Module._load;
Module._load = function (name, ...rest) {
  return name === "vscode" ? { SemanticTokens: class { constructor(data, resultId) { Object.assign(this, { data, resultId }); } } } :
    load.call(this, name, ...rest);
};
const protocol = require("../../src/integration/language-protocol");
Module._load = load;
const legend = { tokenTypes: ["function", "variable", "keyword", "operator"], tokenModifiers: ["declaration", "resolved", "defaultLibrary"] };
const project = (data, lines) => [...presentSemanticTokenData(data, legend, lines)];

test("whole and delta results retain raw bases and IDs while displayed identifiers keep type and modifiers", () => {
  const first = protocol.semanticTokens({ resultId: "raw-1", data: [0, 0, 3, 0, 2, 0, 7, 6, 1, 1] }, legend);
  const before = [...first.data];
  assert.deepEqual(project(first.data, ["Log    ${old}"]), [0, 0, 3, 0, 2, 0, 9, 3, 1, 1]);
  const next = protocol.editedSemanticTokens({ resultId: "raw-2", edits: [{ start: 5, deleteCount: 5, data: [0, 7, 7, 1, 1] }] }, first.data, legend);
  assert.deepEqual(project(next.data, ["Log    ${next}"]), [0, 0, 3, 0, 2, 0, 9, 4, 1, 1]);
  assert.deepEqual([...first.data], before);
  assert.deepEqual([...next.data], [0, 0, 3, 0, 2, 0, 7, 7, 1, 1]);
  assert.equal(first.resultId, "raw-1");
  assert.equal(next.resultId, "raw-2");
  const ranged = protocol.semanticTokens({ data: [1, 7, 7, 1, 0] }, legend);
  assert.deepEqual(project(ranged.data, ["unrelated", "Log    ${next}"]), [1, 9, 4, 1, 0]);
  assert.deepEqual([...ranged.data], [1, 7, 7, 1, 0]);
});

test("nested and indexed variable names preserve their exact UTF-16 ranges and every modifier", () => {
  assert.deepEqual(project([0, 0, 17, 1, 7], ["${outer_${inner}}"]), [0, 2, 6, 1, 7, 0, 8, 5, 1, 7]);
  assert.deepEqual(project([0, 0, 7, 1, 1, 0, 8, 8, 1, 0], ["${data}[${index}]"]), [0, 2, 4, 1, 1, 0, 8, 5, 1, 0]);
  assert.deepEqual(project([0, 3, 8, 1, 0], ["😀 ${Grüße}"]), [0, 5, 5, 1, 0]);
});

test("escaped references, incomplete spans and unrelated tokens gain no invented semantic ranges", () => {
  assert.deepEqual(project([0, 15, 7, 1, 0], ["\\${escaped}    ${real}"]), [0, 17, 4, 1, 0]);
  assert.deepEqual(project([0, 1, 10, 1, 0], ["\\${escaped}"]), [0, 1, 10, 1, 0]);
  assert.deepEqual(project([0, 0, 5, 1, 0], ["${bad"]), [0, 0, 5, 1, 0]);
  assert.deepEqual(project([0, 0, 3, 0, 6], ["Log"]), [0, 0, 3, 0, 6]);
});

test("FOR separators defer to lexical styling without changing control or keyword-call types", () => {
  assert.deepEqual(project([0, 0, 2, 2, 0, 0, 6, 8, 2, 0, 0, 12, 3, 0, 2], ["IF    IN RANGE    Log"]),
    [0, 0, 2, 2, 0, 0, 18, 3, 0, 2]);
  assert.deepEqual(project([0, 0, 8, 0, 2], ["IN RANGE"]), [0, 0, 8, 0, 2]);
});

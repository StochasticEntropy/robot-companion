"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { safeCompletionAppend } = require("../../src/integration/completion-edit");
const original = "*** Test Cases ***\r\nExample\r\n    BAVL \r\n    Log    unchanged\r\n";
const position = { line: 2, character: 9 };
const range = { start: { line: 2, character: 4 }, end: position };
const result = () => ({ isIncomplete: true, items: ["BAVL Antworten Kinder", "BAVL Antworten Eltern"].map(label => ({
  label, kind: 3, insertTextFormat: 1, textEdit: { range, newText: label }
})) });
const append = text => original.replace("    BAVL \r\n", `    BAVL ${text}\r\n`);
const cursor = text => ({ line: 2, character: position.character + text.length });

test("a still-live direct keyword reply survives only an exact prefix append with original ranges intact", () => {
  const value = result(), before = JSON.stringify(value);
  assert.equal(safeCompletionAppend(value, original, position, append("Antw"), cursor("Antw")), true);
  assert.equal(JSON.stringify(value), before, "VS Code receives request-time ranges, not guessed rebased edits");
  assert.equal(safeCompletionAppend(value, original, position, append("Äntworten Kinder"), cursor("Äntworten Kinder")), true);
});

test("RF cell separators, variable/member syntax and source changes cannot reuse an old keyword list", () => {
  for (const inserted of [" Antw", "\tAntw", "Antw\n", "Antw|", "Antw=", "${antw}", "Antw.member", "Antw  Kinder"]) {
    assert.equal(safeCompletionAppend(result(), original, position, append(inserted), cursor(inserted)), false, inserted);
  }
  for (const changed of [append("Antw").replace("unchanged", "modified"), append("Antw").replace("Example", "Changed"),
    append("Antw").replace("BAVL", "BAVX")]) {
    assert.equal(safeCompletionAppend(result(), original, position, changed, cursor("Antw")), false);
  }
  assert.equal(safeCompletionAppend(result(), original, position, append("Antw"), { line: 3, character: 13 }), false);
  assert.equal(safeCompletionAppend(result(), original, position, append("Antw"), { line: 2, character: 12 }), false);
});

test("continuation argument-name replies survive letters but not a value assignment or a new cell", () => {
  const text = "*** Test Cases ***\nExample\n    BAVL Antworten Kinder\n    ...    ";
  const point = { line: 3, character: 11 };
  const data = { isIncomplete: true, items: [{ kind: 6, label: "antwortKinder=", insertTextFormat: 1,
    textEdit: { range: { start: point, end: point }, newText: "antwortKinder=" } }] };
  assert.equal(safeCompletionAppend(data, text, point, text + "antw", { line: 3, character: 15 }), true);
  for (const inserted of ["antw=", "antw x", "antw\t", "antw  "]) {
    assert.equal(safeCompletionAppend(data, text, point, text + inserted, { line: 3, character: 11 + inserted.length }), false);
  }
});

test("unproved items, side effects, insert/replace ranges and oversized inputs are refused", () => {
  const variants = [value => value.items[0].command = { command: "anything" },
    value => value.items[0].additionalTextEdits = [{}], value => value.items[0].commitCharacters = ["."],
    value => value.items[0].insertTextFormat = 2, value => value.items[0].kind = 1,
    value => value.items[0].textEdit.range = { insert: range, replace: range },
    value => value.items[1].textEdit = { range: { start: { line: 2, character: 5 }, end: position }, newText: "Other" },
    value => value.isIncomplete = false];
  for (const mutate of variants) { const value = result(); mutate(value); assert.equal(safeCompletionAppend(value, original, position, append("Antw"), cursor("Antw")), false); }
  assert.equal(safeCompletionAppend(result(), "x".repeat(4 * 1024 * 1024 + 1), position, append("Antw"), cursor("Antw")), false);
});

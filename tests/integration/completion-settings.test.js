"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { completionSettings } = require("../../src/integration/completion-settings");
test("status captures effective Robot suggestion settings and competing defaults without mutating preferences", () => {
  const document = { languageId: "robotframework", uri: "file:///private/source.robot" };
  const inspect = { defaultValue: { other: "on" }, globalValue: { other: "offWhenInlineCompletions" },
    defaultLanguageValue: { other: "off" }, workspaceLanguageValue: false, secret: "unrelated-private-value" };
  let reads = 0;
  const vscode = { version: "1.141.0", workspace: { getConfiguration(section, scope) {
    assert.equal(section, "editor"); assert.equal(scope, document);
    return { get(key) { reads++; return key === "quickSuggestions" ? false : 10; }, inspect: () => inspect,
      update() { assert.fail("diagnostics must never write preferences"); } };
  } }, extensions: { all: [
    { id: "example.companion", packageJSON: { version: "1.0", contributes: { configurationDefaults: {
      "[robotframework]": { "editor.quickSuggestions": { other: "on" }, "private.token": "excluded" } } } } },
    { id: "example.other", packageJSON: { version: "2.0", contributes: { configurationDefaults: {
      "[python][robotframework]": { "editor.quickSuggestions": false } } } } },
    { id: "example.unrelated", packageJSON: { version: "3.0", contributes: { configurationDefaults: {
      "[python]": { "editor.quickSuggestions": false } } } } }
  ] } };
  const result = completionSettings(vscode, document, "1.3.23");
  assert.equal(result.settings.quickSuggestions.effective, false);
  assert.equal(result.settings.quickSuggestions.scopes.workspaceLanguageValue, false);
  assert.deepEqual(result.contributors.map(row => row.id), ["example.companion", "example.other"]);
  assert.equal(reads, 6);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|token|source\.robot/);
});
test("non-Robot documents do not trigger configuration or extension enumeration", () => {
  assert.equal(completionSettings({}, { languageId: "python" }, "test"), undefined);
  assert.equal(completionSettings({}, undefined, "test"), undefined);
});

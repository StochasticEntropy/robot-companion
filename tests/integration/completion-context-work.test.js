"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.resolve(__dirname, "../../src/core/extension.js"), "utf8");
const start = source.indexOf("class RobotTypedVariableCompletionProvider {");
const end = source.indexOf("\nclass ", start + 1);

function fixture(context) {
  let parses = 0;
  const sandbox = { isRobotDocument: () => true,
    shouldPauseRobotCompanionPassiveEditorFeaturesForDebug: () => false,
    isHoverCancellationRequested: token => token?.isCancellationRequested === true,
    getNamedArgumentValueContextAtPosition: () => context,
    findOwnerForLine: () => undefined };
  vm.runInNewContext(source.slice(start, end) + ";globalThis.Provider=RobotTypedVariableCompletionProvider;", sandbox);
  const provider = new sandbox.Provider({ getParsed() { parses++; return { owners: [] }; } }, {}, { markInteractiveActivity() {} }, {});
  return { provider, parses: () => parses };
}

test("native keyword and argument-name suggestions never wait for an irrelevant whole-document legacy parse", async () => {
  const document = { version: 1 };
  for (const context of [undefined, { valueStart: 20, valueEnd: 25 }]) {
    const f = fixture(context);
    assert.equal(await f.provider.provideCompletionItems(document, { line: 20000, character: 12 }), undefined);
    assert.equal(f.parses(), 0, "A non-value cursor cannot receive this provider's rich items");
    f.provider.dispose();
  }
});

test("real named argument values retain the existing parser path; cancellation starts no work", async () => {
  const f = fixture({ valueStart: 20, valueEnd: 25 });
  assert.equal(await f.provider.provideCompletionItems({ version: 1 }, { line: 20, character: 22 }), undefined);
  assert.equal(f.parses(), 1);
  await f.provider.provideCompletionItems({ version: 1 }, { line: 20, character: 22 }, { isCancellationRequested: true });
  assert.equal(f.parses(), 1);
  f.provider.dispose();
});

const assert = require("assert");
const path = require("path");
const vscode = require("vscode");

const INSERT_COMMAND = "robotCompanion.insertKeywordArgument";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openFixtureDocument(fixtureName) {
  const [fixtureUri] = await vscode.workspace.findFiles(fixtureName);
  assert(fixtureUri, `Expected fixture ${fixtureName} to be present in the test workspace.`);
  const document = await vscode.workspace.openTextDocument(fixtureUri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
  await sleep(100);
  return editor;
}

function findLine(document, needle) {
  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
    if (String(document.lineAt(lineIndex).text || "").includes(needle)) {
      return lineIndex;
    }
  }
  throw new Error(`Could not find line containing '${needle}' in ${path.basename(document.uri.fsPath)}.`);
}

function buildInsertPayload(document, headerLine, argumentName) {
  const headerText = document.lineAt(headerLine).text;
  return {
    documentUri: document.uri.toString(),
    keywordLine: headerLine,
    keywordCharacter: Math.max(0, headerText.indexOf("Demo Keyword")),
    keywordName: "Demo Keyword",
    argumentName,
    documentedArgumentNames: ["first", "second", "third", "fourth"],
    headerIndent: "    "
  };
}

async function runInsertCommand(payload) {
  const originalExecuteCommand = vscode.commands.executeCommand;
  const executedCommands = [];
  vscode.commands.executeCommand = async function patchedExecuteCommand(command, ...args) {
    executedCommands.push(command);
    return originalExecuteCommand.call(this, command, ...args);
  };

  try {
    await originalExecuteCommand.call(vscode.commands, INSERT_COMMAND, payload);
    await sleep(250);
  } finally {
    vscode.commands.executeCommand = originalExecuteCommand;
  }

  return executedCommands;
}

suite("Robot Companion keyword argument insertion UI", function () {
  this.timeout(90000);

  test("inserts a missing named argument before the next continuation-line argument in documented order", async () => {
    const editor = await openFixtureDocument("keyword-argument-insert-multiline.robot");
    const headerLine = findLine(editor.document, "Demo Keyword    first=1");
    const executedCommands = await runInsertCommand(buildInsertPayload(editor.document, headerLine, "second"));
    const updatedEditor = vscode.window.activeTextEditor || editor;

    assert.strictEqual(updatedEditor.document.lineAt(headerLine + 1).text, "    ...    second=");
    assert.strictEqual(updatedEditor.document.lineAt(headerLine + 2).text, "    ...    third=3");
    assert.strictEqual(updatedEditor.selection.active.line, headerLine + 1);
    assert.strictEqual(updatedEditor.selection.active.character, "    ...    second=".length);
    assert(
      executedCommands.includes("editor.action.triggerSuggest"),
      "inserting a missing argument should trigger suggestions after placing the caret"
    );
  });

  test("falls back to inserting after the header when later documented arguments are still on the header line", async () => {
    const editor = await openFixtureDocument("keyword-argument-insert-header-fallback.robot");
    const headerLine = findLine(editor.document, "Demo Keyword    first=1    third=3");
    const executedCommands = await runInsertCommand(buildInsertPayload(editor.document, headerLine, "second"));
    const updatedEditor = vscode.window.activeTextEditor || editor;

    assert.strictEqual(updatedEditor.document.lineAt(headerLine).text, "    Demo Keyword    first=1    third=3");
    assert.strictEqual(updatedEditor.document.lineAt(headerLine + 1).text, "    ...    second=");
    assert.strictEqual(updatedEditor.document.lineAt(headerLine + 2).text, "    ...    fourth=4");
    assert.strictEqual(updatedEditor.selection.active.line, headerLine + 1);
    assert.strictEqual(updatedEditor.selection.active.character, "    ...    second=".length);
    assert(
      executedCommands.includes("editor.action.triggerSuggest"),
      "best-effort fallback insertion should still trigger suggestions"
    );
  });

  test("focuses an already-used named argument instead of inserting a duplicate", async () => {
    const editor = await openFixtureDocument("keyword-argument-insert-existing.robot");
    const headerLine = findLine(editor.document, "Demo Keyword    first=1");
    const beforeText = editor.document.getText();
    const executedCommands = await runInsertCommand(buildInsertPayload(editor.document, headerLine, "second"));
    const updatedEditor = vscode.window.activeTextEditor || editor;
    const existingLine = findLine(updatedEditor.document, "...    second=2");

    assert.strictEqual(updatedEditor.document.getText(), beforeText);
    assert.strictEqual(updatedEditor.selection.active.line, existingLine);
    assert.strictEqual(updatedEditor.selection.active.character, updatedEditor.document.lineAt(existingLine).text.indexOf("second="));
    assert(
      !executedCommands.includes("editor.action.triggerSuggest"),
      "focusing an existing argument should not trigger insert suggestions"
    );
  });
});

const assert = require("assert");
const vscode = require("vscode");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const FIXTURE_GLOB = "folding-regression.robot";
const HEADLINE_RANGES = [
  { start: 3, end: 9 },
  { start: 10, end: 13 }
];
const FIRST_LEVEL_RANGES = [
  { start: 4, end: 7 },
  { start: 8, end: 9 },
  { start: 11, end: 13 }
];
const SECOND_LEVEL_RANGES = [{ start: 6, end: 7 }];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError = undefined;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function normalizeFoldingRanges(ranges) {
  return (Array.isArray(ranges) ? ranges : []).map((range) => ({
    start: Number(range?.start) || 0,
    end: Number(range?.end) || 0
  }));
}

async function getFoldingRanges(document) {
  const ranges = await vscode.commands.executeCommand("_executeFoldingRangeProvider", document.uri);
  return normalizeFoldingRanges(ranges);
}

async function waitForFoldingRanges(document, expectedRanges, label) {
  const expectedSerialized = JSON.stringify(expectedRanges);
  let lastRanges = [];
  try {
    await waitFor(async () => {
      lastRanges = await getFoldingRanges(document);
      return JSON.stringify(lastRanges) === expectedSerialized;
    }, label);
  } catch (error) {
    const detail = `Expected ${expectedSerialized}, last actual ${JSON.stringify(lastRanges)}.`;
    throw new Error(`${error.message} ${detail}`);
  }
}

async function setCursor(editor, line, character = 0) {
  const position = new vscode.Position(line, character);
  const selection = new vscode.Selection(position, position);
  editor.selection = selection;
  editor.revealRange(new vscode.Range(position, position));
  await sleep(75);
}

async function waitForCursorDownResult(editor, startLine, expectedLine, label) {
  await waitFor(async () => {
    await setCursor(editor, startLine);
    await vscode.commands.executeCommand("cursorDown");
    return editor.selection.active.line === expectedLine;
  }, label);
}

suite("Robot Companion documentation folding UI", function () {
  this.timeout(90000);

  let document;
  let editor;

  async function resetEditorState() {
    editor = await vscode.window.showTextDocument(document, {
      preview: false
    });
    await vscode.commands.executeCommand("robotCompanion.unfoldDocumentation");
    await vscode.commands.executeCommand("editor.unfoldAll");
    await sleep(250);
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();

    const fixtureUris = await vscode.workspace.findFiles(FIXTURE_GLOB);
    assert.strictEqual(fixtureUris.length, 1, "Expected exactly one folding regression fixture in the workspace.");

    document = await vscode.workspace.openTextDocument(fixtureUris[0]);
    editor = await vscode.window.showTextDocument(document, {
      preview: false
    });

    await vscode.commands.executeCommand("robotCompanion.useAsDefaultFoldingProvider");
    await resetEditorState();
  });

  setup(async () => {
    await resetEditorState();
  });

  test("stores the workspace override for the Robot Companion folding provider", async () => {
    const override = vscode.workspace.getConfiguration().get("[robotframework]");
    assert.strictEqual(
      override["editor.defaultFoldingRangeProvider"],
      EXTENSION_ID,
      "workspace robotframework override should point at this extension"
    );
    assert.strictEqual(
      override["editor.foldingStrategy"],
      "auto",
      "workspace robotframework override should keep automatic folding"
    );
  });

  test("foldDocumentationToHeadlines exposes only headline ranges and skips nested bodies in the editor", async () => {
    await vscode.commands.executeCommand("robotCompanion.foldDocumentationToHeadlines");
    await waitForFoldingRanges(document, HEADLINE_RANGES, "headline folding ranges");
    await waitForCursorDownResult(editor, 2, 9, "headline fold should jump from the first headline to the next headline");
  });

  test("foldDocumentationToFirstLevel exposes only first-level ranges and keeps the testcase visible", async () => {
    await vscode.commands.executeCommand("robotCompanion.foldDocumentationToFirstLevel");
    await waitForFoldingRanges(document, FIRST_LEVEL_RANGES, "first-level folding ranges");
    await waitForCursorDownResult(
      editor,
      3,
      7,
      "first-level fold should jump from the first top-level marker to the next top-level peer"
    );
  });

  test("foldDocumentationToSecondLevel exposes only nested ranges and skips only the nested body", async () => {
    await vscode.commands.executeCommand("robotCompanion.foldDocumentationToSecondLevel");
    await waitForFoldingRanges(document, SECOND_LEVEL_RANGES, "second-level folding ranges");
    await waitForCursorDownResult(
      editor,
      5,
      7,
      "second-level fold should jump from the nested marker to the next visible top-level marker"
    );
  });

  test("unfoldDocumentation restores line-by-line cursor movement", async () => {
    await vscode.commands.executeCommand("robotCompanion.foldDocumentationToHeadlines");
    await waitForFoldingRanges(document, HEADLINE_RANGES, "headline folding ranges before unfolding");

    await vscode.commands.executeCommand("robotCompanion.unfoldDocumentation");
    await sleep(250);

    await waitForCursorDownResult(editor, 2, 3, "headline marker should move to the next line after unfold");
    await waitForCursorDownResult(editor, 3, 4, "first-level marker should move to the next line after unfold");
    await waitForCursorDownResult(editor, 5, 6, "second-level marker should move to the next line after unfold");
  });
});

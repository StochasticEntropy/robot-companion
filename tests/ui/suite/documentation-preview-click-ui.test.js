const assert = require("assert");
const path = require("path");
const vscode = require("vscode");
const { JSDOM } = require("jsdom");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const FULL_TARGET_SCENARIOS = [
  "folding-regression-refund.robot",
  "documentation-inline-mixed-simple.robot",
  "documentation-inline-mixed-involved.robot",
  "documentation-arrow-indent-shipping.robot"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

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

function parseCommandUri(commandUri) {
  const rawCommandUri = String(commandUri || "");
  const match = rawCommandUri.match(/^command:([^?]+)(?:\?(.*))?$/);
  assert(match, `expected a VS Code command URI but got ${rawCommandUri}`);
  const command = decodeURIComponent(match[1]);
  const args = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
  return {
    command,
    args: Array.isArray(args) ? args : [args]
  };
}

async function executeCommandUri(commandUri) {
  const parsed = parseCommandUri(commandUri);
  return vscode.commands.executeCommand(parsed.command, ...parsed.args);
}

async function openNonRobotEditor(extensionPath) {
  const packageDocument = await vscode.workspace.openTextDocument(path.join(extensionPath, "package.json"));
  await vscode.window.showTextDocument(packageDocument, {
    preview: false,
    preserveFocus: false
  });
  await sleep(75);
}

async function renderDocumentationPreviewDom(extensionTestApi, document) {
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  assert(parsed.blocks.length > 0, `Expected parsed documentation blocks for ${path.basename(document.uri.fsPath)}.`);

  const renderedMarkdownHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), parsed.blocks[0]);
  const previewHtml = extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
    { documentUri: document.uri.toString() },
    parsed.blocks[0],
    renderedMarkdownHtml
  );

  const postedMessages = [];
  const dom = new JSDOM(previewHtml, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          postedMessages.push(message);
        }
      });
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
      window.cancelAnimationFrame = (handle) => clearTimeout(handle);
    }
  });

  await sleep(25);

  return {
    dom,
    postedMessages,
    flow: dom.window.document.querySelector(".doc-render-flow"),
    parsed
  };
}

function collectFlowTargets(flow) {
  assert(flow, "expected rendered documentation preview flow");
  const encodedTargets = String(flow.getAttribute("data-doc-render-targets") || "").trim();
  assert(encodedTargets, "expected rendered preview flow to expose encoded source targets");
  return JSON.parse(decodeURIComponent(encodedTargets));
}

function resolveBoundSurfaceForMarker(marker, flow) {
  let current = marker instanceof flow.ownerDocument.defaultView.HTMLElement ? marker : marker?.parentElement;
  while (current && current !== flow) {
    if (current instanceof flow.ownerDocument.defaultView.HTMLElement && current.hasAttribute("data-source-command")) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

suite("Robot Companion documentation preview click bridge", function () {
  this.timeout(90000);

  const documentsByFixtureName = new Map();
  let extensionPath = "";
  let extensionTestApi;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();
    extensionPath = extension.extensionPath;
    extensionTestApi = require(path.join(extensionPath, "src/core/extension.js")).__test__;

    const fixtureUris = await vscode.workspace.findFiles("*.robot");
    for (const fixtureUri of fixtureUris) {
      documentsByFixtureName.set(path.basename(fixtureUri.fsPath), await vscode.workspace.openTextDocument(fixtureUri));
    }

    for (const fixtureName of FULL_TARGET_SCENARIOS) {
      assert(documentsByFixtureName.has(fixtureName), `Expected fixture ${fixtureName} to be present in the workspace.`);
    }
  });

  for (const fixtureName of FULL_TARGET_SCENARIOS) {
    test(`${fixtureName} binds every rendered preview target to its own jump command`, async () => {
      const document = documentsByFixtureName.get(fixtureName);
      assert(document, `Expected document for fixture ${fixtureName}.`);

      const { dom, postedMessages, flow } = await renderDocumentationPreviewDom(extensionTestApi, document);
      const targets = collectFlowTargets(flow);
      const targetMarkers = Array.from(flow.querySelectorAll(".doc-target-marker[data-doc-target-index]"));

      assert.strictEqual(
        targetMarkers.length,
        targets.length,
        `${fixtureName} should render exactly one explicit target marker per preview source target`
      );

      for (let index = 0; index < targets.length; index += 1) {
        const marker = flow.querySelector(`.doc-target-marker[data-doc-target-index="${index}"]`);
        assert(marker, `Expected target marker ${index} in ${fixtureName}.`);

        const clickableSurface = resolveBoundSurfaceForMarker(marker, flow);
        assert(clickableSurface, `Expected target marker ${index} in ${fixtureName} to resolve to a clickable surface.`);

        const expectedCommandUri = String(targets[index]?.commandUri || "");
        assert.strictEqual(
          String(clickableSurface.getAttribute("data-source-command") || ""),
          expectedCommandUri,
          `${fixtureName} target marker ${index} should keep its own bound source command`
        );

        postedMessages.length = 0;
        clickableSurface.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true
          })
        );

        assert.strictEqual(
          postedMessages.length,
          1,
          `${fixtureName} target marker ${index} should post exactly one managed click message`
        );
        assert.strictEqual(
          String(postedMessages[0]?.type || ""),
          "executeCommandUri",
          `${fixtureName} target marker ${index} should post an executeCommandUri message`
        );
        assert.strictEqual(
          String(postedMessages[0]?.commandUri || ""),
          expectedCommandUri,
          `${fixtureName} target marker ${index} should post exactly its own command URI on click`
        );
      }

      for (const target of targets) {
        const parsedTargetCommand = parseCommandUri(target.commandUri);
        assert.strictEqual(
          parsedTargetCommand.command,
          "robotCompanion.openLocation",
          `${fixtureName} should expose openLocation jumps for each rendered preview line`
        );
        const expectedLine = Number(parsedTargetCommand.args[1]);
        assert(Number.isInteger(expectedLine), `${fixtureName} target should encode a numeric source line`);

        await openNonRobotEditor(extensionPath);
        await executeCommandUri(target.commandUri);
        await waitFor(
          async () =>
            vscode.window.activeTextEditor?.document?.uri.toString() === document.uri.toString() &&
            vscode.window.activeTextEditor.selection.active.line === expectedLine,
          `${fixtureName} preview target for line ${expectedLine + 1}`
        );
      }
    });
  }
});

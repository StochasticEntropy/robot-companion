const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

// MIS-138: documentation from a .robot file and from a Python keyword docstring goes through the real
// render path into the real Documentation Preview, PDF export panel and Return Explorer. The test then
// reads the webviews over the DevTools protocol: every documentation element must be inside its
// container (D1), every control must be the element hit at its centre, both inside the webview and on
// the VS Code page, and a trusted click on it must perform its action (D2). Generated colours, arrow
// indentation and page breaks must still render (D3).

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const ROBOT_FIXTURE = "documentation-hostile-fragments.robot";
const PYTHON_FIXTURE = "hostile_docstrings.py";
const ROBOT_VECTORS = [
  "Hostile Plain Svg",
  "Hostile Svg After Section",
  "Hostile Svg After Section And Divs",
  "Hostile Raw Style",
  "Hostile Style Attribute",
  "Hostile Fixed Overlay"
];
const PYTHON_VECTORS = [
  { keyword: "Hostile Svg First Line", functionName: "hostile_svg_first_line" },
  { keyword: "Hostile Svg After Section Docstring", functionName: "hostile_svg_after_section_docstring" },
  { keyword: "Hostile Svg After Section And Divs Docstring", functionName: "hostile_svg_after_section_and_divs_docstring" },
  { keyword: "Hostile Raw Style Docstring", functionName: "hostile_raw_style_docstring" },
  { keyword: "Hostile Style Attribute Docstring", functionName: "hostile_style_attribute_docstring" },
  { keyword: "Hostile Fixed Overlay Docstring", functionName: "hostile_fixed_overlay_docstring" }
];
const PREVIEW_TOOLBAR_LINKS = ["Headlines", "Steps", "Unfold", "Current MD", "Current PDF", "Selected MD", "Selected PDF"];
const CUSTOM_COLOUR = "rgb(15, 118, 110)";
const PREVIEW_CONTROLS = "a[href], button, input";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

// A webview re-renders when the extension updates it, which replaces its frame. Steps that read a
// webview are repeated when the frame went away meanwhile; assertion failures are not repeated.
async function retryWhenFrameReplaced(step) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      const replaced = /No execution context|Cannot find context|Could not compute box model|No frame|Frame with the given id/i.test(
        String(error && error.message)
      );
      if (!replaced || attempt >= 5 || error instanceof assert.AssertionError) {
        throw error;
      }
      await sleep(300);
    }
  }
}

function findLine(document, text) {
  for (let line = 0; line < document.lineCount; line += 1) {
    if (document.lineAt(line).text === text) {
      return line;
    }
  }
  throw new Error(`Line ${JSON.stringify(text)} not found in ${path.basename(document.uri.fsPath)}.`);
}

// Runs in the webview: lists documentation that is outside its container, and collects the extension's
// controls (outside the documentation) in window.__rcControls.
function inspectWebviewInFrame(controlSelector) {
  const containers = Array.from(document.querySelectorAll(".doc-render-flow"));
  const insideDocumentation = (node) => containers.some((container) => container.contains(node));
  const describe = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      parts.unshift(`${current.tagName.toLowerCase()}${current.className && typeof current.className === "string" ? `.${current.className.split(" ")[0]}` : ""}`);
      current = current.parentElement;
    }
    return `${parts.join(">")} "${String(element.textContent || "").trim().slice(0, 40)}"`;
  };
  const documentationElements = Array.from(document.querySelectorAll("[data-rc-hostile], svg, rect, body style"));
  const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const documentationTexts = [];
  for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
    if (node.nodeValue.includes("rc-doc-text")) {
      documentationTexts.push(node);
    }
  }
  const controls = Array.from(document.querySelectorAll(controlSelector)).filter((element) => !insideDocumentation(element));
  window.__rcControls = controls;
  return {
    containers: containers.map((container) => (container.parentElement ? container.parentElement.className : "")),
    documentationElements: documentationElements.length,
    hostileElements: Array.from(document.querySelectorAll("[data-rc-hostile]")).map((element) => element.getAttribute("data-rc-hostile")),
    documentationTexts: documentationTexts.length,
    escaped: documentationElements
      .filter((element) => !insideDocumentation(element))
      .map(describe)
      .concat(documentationTexts.filter((node) => !insideDocumentation(node)).map((node) => `text "${node.nodeValue.trim()}"`)),
    controls: controls.map((element) => ({
      key: describe(element),
      text: String(element.textContent || "").trim(),
      insideDocumentation: insideDocumentation(element)
    })),
    customColours: Array.from(document.querySelectorAll(".doc-color-custom")).map((element) => getComputedStyle(element).color),
    arrowIndents: Array.from(document.querySelectorAll(".robot-arrow-line")).map((element) => parseFloat(getComputedStyle(element).paddingLeft)),
    pageBreaks: Array.from(document.querySelectorAll(".documentation-export-page-break")).map((element) => getComputedStyle(element).breakBefore)
  };
}

// Runs in the webview: brings control `index` into view and hit-tests its centre.
function measureControlInFrame(index) {
  const element = window.__rcControls[index];
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const box = element.getClientRects()[0] || element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const target = box.width > 0 && box.height > 0 ? document.elementFromPoint(x, y) : null;
  return {
    width: box.width,
    height: box.height,
    x,
    y,
    hit: Boolean(target && (target === element || element.contains(target))),
    hitTag: target ? `${target.tagName.toLowerCase()} ${String(target.textContent || "").trim().slice(0, 40)}` : ""
  };
}

suite("Robot Companion documentation stays inside its container and below the controls", function () {
  this.timeout(300000);

  let extensionTestApi;
  let cdp;
  let robotDocument;
  let pythonDocument;
  let blocksByOwner;

  async function inspect(frame, controlSelector) {
    return cdp.evaluate(frame.frameId, `(${inspectWebviewInFrame.toString()})(${JSON.stringify(controlSelector)})`);
  }

  async function controlCentre(frame, index) {
    return cdp.evaluate(frame.frameId, `(${measureControlInFrame.toString()})(${index})`);
  }

  // D1: the documentation is complete and all of it is inside its container.
  function assertContained(name, inspection, expected) {
    assert.deepStrictEqual(inspection.escaped, [], `${name}: documentation outside its container`);
    assert(inspection.containers.length >= expected.containers, `${name}: expected ${expected.containers} documentation container(s)`);
    for (const parent of inspection.containers) {
      assert(
        parent.split(" ").includes(expected.parent),
        `${name}: the documentation container must stay in .${expected.parent}, found in .${parent}`
      );
    }
    assert(inspection.documentationTexts >= expected.containers, `${name}: expected the documentation text after the hostile part`);
    assert(inspection.hostileElements.length >= expected.containers, `${name}: expected the hostile element to be rendered`);
  }

  // D2: every control is visible and is what the browser hits at its centre, in the webview and on the
  // VS Code page.
  async function assertControlsOnTop(name, frame, inspection, expectedTexts) {
    for (const text of expectedTexts) {
      assert(
        inspection.controls.some((control) => control.text === text),
        `${name}: expected the control "${text}", got ${JSON.stringify(inspection.controls.map((control) => control.text))}`
      );
    }
    for (let index = 0; index < inspection.controls.length; index += 1) {
      const control = inspection.controls[index];
      const centre = await controlCentre(frame, index);
      assert(centre.width > 0 && centre.height > 0, `${name}: ${control.key} must stay visible`);
      assert(centre.hit, `${name}: elementFromPoint at the centre of ${control.key} returned ${centre.hitTag}`);
      assert(
        await cdp.hitsElement(frame, centre.x, centre.y, `window.__rcControls[${index}]`),
        `${name}: on the VS Code page, the centre of ${control.key} is covered`
      );
    }
  }

  // Clicks the control with this text (and, when given, whose key contains `keyPart`). The webview may
  // have been re-rendered, so its frame and controls are looked up again first.
  async function clickControl(findFrame, controlSelector, text, keyPart = "") {
    return retryWhenFrameReplaced(() => clickControlOnce(findFrame, controlSelector, text, keyPart));
  }

  async function clickControlOnce(findFrame, controlSelector, text, keyPart) {
    const frame = await findFrame();
    const controls = (await inspect(frame, controlSelector)).controls;
    const index = controls.findIndex((control) => control.text === text && control.key.includes(keyPart));
    assert(index >= 0, `expected the control "${text}" to click, got ${JSON.stringify(controls.map((control) => control.key))}`);
    const centre = await controlCentre(frame, index);
    assert(await cdp.hitsElement(frame, centre.x, centre.y, `window.__rcControls[${index}]`), `"${text}" must be clickable`);
    await cdp.click(frame, centre.x, centre.y);
  }

  // D3: the extension's generated styles still apply.
  function assertGeneratedRendering(name, inspection, expectedColours) {
    assert(inspection.customColours.length >= expectedColours, `${name}: expected the custom colour spans`);
    for (const colour of inspection.customColours) {
      assert.strictEqual(colour, CUSTOM_COLOUR, `${name}: custom colour span`);
    }
    assert(inspection.arrowIndents.length >= 2, `${name}: expected arrow lines`);
    assert(inspection.arrowIndents[1] > inspection.arrowIndents[0], `${name}: the deeper arrow line must be indented further`);
  }

  function assertStylePolicy(name, html) {
    const policy = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || "";
    const styleSources = (policy.split(";").find((part) => part.trim().startsWith("style-src")) || "").trim();
    assert(styleSources.startsWith("style-src"), `${name}: expected a style-src directive`);
    assert(!styleSources.includes("'unsafe-inline'"), `${name}: style-src must not allow 'unsafe-inline'`);
  }

  async function showRobotDocument() {
    return vscode.window.showTextDocument(robotDocument, { preview: false, preserveFocus: false });
  }

  async function showPreviewOf(owner) {
    await vscode.commands.executeCommand("robotCompanion.view.focus");
    await showRobotDocument();
    const block = blocksByOwner.get(owner);
    await vscode.commands.executeCommand("robotCompanion.openBlockAt", robotDocument.uri.toString(), block.id);
    await waitFor(() => {
      const snapshot = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      const webview = extensionTestApi.getDocumentationPreviewWebviewForTest();
      return snapshot.visible && snapshot.selectedBlockId === block.id && webview.html.includes("data-rc-hostile");
    }, `the Documentation Preview to show ${owner}`);
    const frame = await findPreviewFrame(owner);
    return { block, frame, html: extensionTestApi.getDocumentationPreviewWebviewForTest().html };
  }

  function findPreviewFrame(owner) {
    return cdp.findWebviewFrame(
      `const title = document.querySelector(".preview-title"); return Boolean(document.querySelector(".preview-actions") && title && title.textContent === ${JSON.stringify(owner)} && document.querySelector("[data-rc-hostile]"));`,
      `the Documentation Preview of ${owner}`
    );
  }

  async function findPdfFrame(description, owners) {
    return cdp.findWebviewFrame(
      `const titles = Array.from(document.querySelectorAll(".documentation-export-page > h1")).map((title) => title.textContent); return Boolean(document.querySelector(".export-toolbar") && JSON.stringify(titles) === ${JSON.stringify(JSON.stringify(owners))} && document.querySelector("[data-rc-hostile]"));`,
      description
    );
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();
    extensionTestApi = require(path.join(extension.extensionPath, "src/core/extension.js")).__test__;
    const [robotUri] = await vscode.workspace.findFiles(ROBOT_FIXTURE);
    const [pythonUri] = await vscode.workspace.findFiles(PYTHON_FIXTURE);
    assert(robotUri && pythonUri, "expected the hostile documentation fixtures in the workspace");
    robotDocument = await vscode.workspace.openTextDocument(robotUri);
    pythonDocument = await vscode.workspace.openTextDocument(pythonUri);
    const parsed = new extensionTestApi.RobotDocumentationService().parse(robotDocument);
    blocksByOwner = new Map(parsed.blocks.map((block) => [block.ownerName, block]));
    for (const owner of ROBOT_VECTORS) {
      assert(blocksByOwner.has(owner), `expected the documentation block of ${owner}`);
    }
    cdp = await WebviewCdp.connect();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("notifications.clearAll");
  });

  suiteTeardown(async () => {
    cdp?.close();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("Documentation Preview and PDF export: hostile .robot documentation stays inside its container; the controls stay on top and work", async () => {
    for (const owner of ROBOT_VECTORS) {
      const name = `Documentation Preview (${owner})`;
      const { block, html } = await showPreviewOf(owner);
      assertStylePolicy(name, html);
      await retryWhenFrameReplaced(async () => {
        const frame = await findPreviewFrame(owner);
        const preview = await inspect(frame, PREVIEW_CONTROLS);
        assertContained(name, preview, { containers: 1, parent: "preview" });
        assertGeneratedRendering(name, preview, 1);
        await assertControlsOnTop(name, frame, preview, [...PREVIEW_TOOLBAR_LINKS, "Hostile Plain Svg", "Hostile Fixed Overlay"]);
      });

      // A trusted click on the subtitle link opens the test case in the editor.
      const editor = await showRobotDocument();
      const documentationLine = Number(block.endLine);
      editor.selection = new vscode.Selection(documentationLine, 0, documentationLine, 0);
      assert.notStrictEqual(robotDocument.lineAt(documentationLine).text, owner);
      await vscode.commands.executeCommand("notifications.clearAll");
      await clickControl(() => findPreviewFrame(owner), PREVIEW_CONTROLS, "Jump to testcase", "div.preview-subtitle");
      await waitFor(() => {
        const active = vscode.window.activeTextEditor;
        return (
          active &&
          active.document.uri.toString() === robotDocument.uri.toString() &&
          active.document.lineAt(active.selection.active.line).text === owner
        );
      }, `${name}: the subtitle link to open ${owner}`);

      // A trusted click on the "Current PDF" toolbar link opens the PDF export of this block.
      const pdfHtmlBefore = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
      await clickControl(() => findPreviewFrame(owner), PREVIEW_CONTROLS, "Current PDF");
      await waitFor(() => {
        const pdfHtml = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
        return pdfHtml !== pdfHtmlBefore && pdfHtml.includes(`<h1>${owner}</h1>`);
      }, `${name}: the Current PDF link to open the PDF export`);
      await checkPdfExport(`PDF/print export (${owner})`, [owner]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");

      // A trusted click on another block in the overview selects it.
      const next = ROBOT_VECTORS[(ROBOT_VECTORS.indexOf(owner) + 1) % ROBOT_VECTORS.length];
      await showPreviewOf(owner);
      await clickControl(() => findPreviewFrame(owner), PREVIEW_CONTROLS, next);
      await waitFor(
        () => extensionTestApi.getDocumentationPreviewSnapshotForTest().selectedBlockId === blocksByOwner.get(next).id,
        `${name}: the overview link to select ${next}`
      );
      assert.notStrictEqual(block.id, blocksByOwner.get(next).id);
    }
  });

  async function checkPdfExport(name, owners) {
    const pageCount = owners.length;
    const html = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
    assertStylePolicy(name, html);
    const frame = await retryWhenFrameReplaced(async () => {
      const found = await findPdfFrame(name, owners);
      const pdf = await inspect(found, "button");
      assertContained(name, pdf, { containers: pageCount, parent: "documentation-export-page" });
      assertGeneratedRendering(name, pdf, pageCount);
      assert.deepStrictEqual(pdf.pageBreaks, new Array(pageCount - 1).fill("page"), `${name}: every page after the first starts on a new page`);
      await assertControlsOnTop(name, found, pdf, ["Open in Browser / Save as PDF", "Try VS Code Print"]);
      return found;
    });

    // "Try VS Code Print" calls window.print(); count the calls instead of opening the print dialog.
    await retryWhenFrameReplaced(async () => {
      const current = await findPdfFrame(name, owners);
      await cdp.evaluate(
        current.frameId,
        "(() => { window.__rcPrintCalls = 0; window.__rcInput = []; window.print = () => { window.__rcPrintCalls += 1; }; for (const type of ['mousedown', 'click']) { document.addEventListener(type, (event) => window.__rcInput.push(type + ':' + event.isTrusted + ':' + event.target.tagName), true); } })()"
      );
      await clickControlOnce(async () => current, "button", "Try VS Code Print", "");
      try {
        await waitFor(async () => (await cdp.evaluate(current.frameId, "window.__rcPrintCalls")) === 1, `${name}: Try VS Code Print to print`, 5000);
      } catch (error) {
        throw new Error(`${error.message} Input seen: ${JSON.stringify(await cdp.evaluate(current.frameId, "window.__rcInput"))}`);
      }
    });

    // "Open in Browser / Save as PDF" writes the browser version and opens it; record the open instead.
    const openExternal = vscode.env.openExternal;
    const opened = [];
    vscode.env.openExternal = async (uri) => {
      opened.push(uri);
      return true;
    };
    try {
      await clickControl(async () => frame, "button", "Open in Browser / Save as PDF");
      await waitFor(() => opened.length === 1, `${name}: Open in Browser to open the browser version`);
    } finally {
      vscode.env.openExternal = openExternal;
    }
    const browserFile = opened[0].fsPath;
    try {
      const browserHtml = fs.readFileSync(browserFile, "utf8");
      assert(browserHtml.includes("data-rc-hostile"), `${name}: the browser version must contain the documentation`);
    } finally {
      fs.rmSync(browserFile, { force: true });
    }
  }

  test("PDF export of several blocks: every page keeps its documentation inside its container and starts on a new page", async () => {
    await showPreviewOf(ROBOT_VECTORS[0]);
    const pdfHtmlBefore = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
    await clickControl(() => findPreviewFrame(ROBOT_VECTORS[0]), PREVIEW_CONTROLS, "Selected PDF");
    // Every test case is preselected in the quick pick; accept it.
    await sleep(500);
    await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await waitFor(() => {
      const pdfHtml = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
      return pdfHtml !== pdfHtmlBefore && ROBOT_VECTORS.every((owner) => pdfHtml.includes(`<h1>${owner}</h1>`));
    }, "the Selected PDF export of every hostile test case");
    await checkPdfExport("PDF/print export (all hostile test cases)", ROBOT_VECTORS);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("Return Explorer: hostile Python docstrings stay inside their container; Jump to keyword definition stays on top and works", async () => {
    const callerLine = (keyword) => findLine(robotDocument, `    ${keyword}`);
    // The docstrings come from the workspace's indexed @keyword functions, which coexistence mode shows. The
    // preview defaults to owned mode, where the Return Explorer shows only the language server's single
    // definition (owned-mode resolution is checked in language-workspace-ui.test.js); select coexistence here.
    const languageWorkspace = extensionTestApi.getLanguageWorkspaceForTest();
    const folderConfig = vscode.workspace.getConfiguration("robotCompanion", robotDocument.uri);
    assert.equal(folderConfig.inspect("integrationMode").defaultValue, "owned");
    await folderConfig.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await waitFor(() => languageWorkspace.roots.size === 0, "coexistence to remove every owned language root");
    await languageWorkspace.queue;
    try {
      await checkReturnExplorerVectors(callerLine);
    } finally {
      await folderConfig.update("integrationMode", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await waitFor(() => languageWorkspace.roots.size > 0, "the owned default to return");
      await languageWorkspace.queue;
    }
  });

  async function checkReturnExplorerVectors(callerLine) {
    for (const { keyword, functionName } of PYTHON_VECTORS) {
      const name = `Return Explorer (${keyword})`;
      await vscode.commands.executeCommand("robotCompanion.returnView.focus");
      const editor = await showRobotDocument();
      const line = callerLine(keyword);
      editor.selection = new vscode.Selection(line, 6, line, 6);
      await waitFor(() => {
        const html = extensionTestApi.getReturnExplorerWebviewHtmlForTest();
        return html.includes(`> ${keyword}</div>`) && html.includes("Jump to keyword definition") && html.includes("data-rc-hostile");
      }, `${name}: the Return Explorer to show the docstring`);
      const html = extensionTestApi.getReturnExplorerWebviewHtmlForTest();
      assertStylePolicy(name, html);
      const findExplorerFrame = () =>
        cdp.findWebviewFrame(
          `return Boolean(document.querySelector(".details") && document.querySelector(".meta") && document.querySelector(".meta").textContent.includes(${JSON.stringify(keyword)}) && document.querySelector("[data-rc-hostile]"));`,
          name
        );
      await retryWhenFrameReplaced(async () => {
        const frame = await findExplorerFrame();
        const explorer = await inspect(frame, "a[href], button");
        assertContained(name, explorer, { containers: 1, parent: "details" });
        const jump = explorer.controls.find((control) => control.text === "Jump to keyword definition");
        assert(jump && !jump.insideDocumentation, `${name}: Jump to keyword definition must be outside the documentation container`);
        await assertControlsOnTop(name, frame, explorer, ["Jump to keyword definition"]);
      });

      await vscode.commands.executeCommand("notifications.clearAll");
      await clickControl(findExplorerFrame, "a[href], button", "Jump to keyword definition");
      await waitFor(() => {
        const active = vscode.window.activeTextEditor;
        return (
          active &&
          active.document.uri.toString() === pythonDocument.uri.toString() &&
          active.document.lineAt(active.selection.active.line).text.startsWith(`def ${functionName}(`)
        );
      }, `${name}: Jump to keyword definition to open ${functionName}`);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  }
});

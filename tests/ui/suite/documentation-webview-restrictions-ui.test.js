const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const PROBE_FIXTURE = "documentation-webview-restrictions-probe.robot";
const PROBE_OWNER = "Webview Restrictions Probe";
const NAVIGATION_ALPHA_FIXTURE = "navigation-alpha.robot";
const NAVIGATION_BETA_FIXTURE = "navigation-beta.robot";
const REMOTE_IMAGE_URLS = [
  "https://robot-companion.invalid/remote-html.png",
  "https://robot-companion.invalid/remote-markdown.png"
];
const OUTSIDE_OWNER = "Outside Workspace Probe";
const OUTSIDE_ROBOT_SOURCE = [
  "*** Test Cases ***",
  OUTSIDE_OWNER,
  "    [Documentation]    A single .robot file opened without a workspace folder.",
  "    ...",
  "    ...    Outside body text.",
  "    Log    outside",
  ""
].join("\n");
const OPEN_COMMANDS = ["robotCompanion.openLocation", "robotCompanion.openBlockAt"];
const FOLD_COMMANDS = [
  "robotCompanion.foldDocumentationToHeadlines",
  "robotCompanion.foldDocumentationToSteps",
  "robotCompanion.unfoldDocumentation"
];
const EXPORT_COMMANDS = [
  "robotCompanion.exportDocumentationMarkdown",
  "robotCompanion.exportDocumentationPdf",
  "robotCompanion.exportDocumentationSelectedMarkdown",
  "robotCompanion.exportDocumentationSelectedPdf"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function decodeHtmlAttribute(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readContentSecurityPolicy(html) {
  const metas = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g) || [];
  assert.strictEqual(metas.length, 1, "expected exactly one Content-Security-Policy meta element");
  const content = decodeHtmlAttribute(metas[0].match(/content="([^"]*)"/)[1]);
  const directives = new Map();
  for (const part of content.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name, sources);
    }
  }
  return directives;
}

function assertImageSources(html, cspSource, { trusted }) {
  const imageSources = readContentSecurityPolicy(html).get("img-src") || [];
  for (const source of String(cspSource || "").split(/\s+/).filter(Boolean)) {
    assert(imageSources.includes(source), `img-src should name the webview source ${source}, got ${imageSources.join(" ")}`);
  }
  assert(imageSources.includes("data:"), `img-src should allow data: images, got ${imageSources.join(" ")}`);
  assert(!imageSources.includes("*"), "img-src must not allow every source");
  assert(!imageSources.includes("http:"), "img-src must never allow http:");
  if (trusted) {
    assert(imageSources.includes("https:"), `a trusted workspace keeps https: images, got ${imageSources.join(" ")}`);
  } else {
    const webviewSources = String(cspSource || "").split(/\s+/);
    const remote = imageSources.filter((source) => /^(https?:|\*)/i.test(source) && !webviewSources.includes(source));
    assert.deepStrictEqual(remote, [], `Restricted Mode must not allow remote images, got ${imageSources.join(" ")}`);
  }
}

function openTabKeys() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => (tab.input && tab.input.uri ? tab.input.uri.toString() : `label:${tab.label}`))
    .sort();
}

function openDocumentKeys() {
  return vscode.workspace.textDocuments.map((document) => document.uri.toString()).sort();
}

function parseLinkArgs(commandUri) {
  const query = String(commandUri).split("?")[1] || "";
  return query ? JSON.parse(decodeURIComponent(query)) : [];
}

function buildCommandUri(commandId, args) {
  return `command:${commandId}?${encodeURIComponent(JSON.stringify(args))}`;
}

// A probe script loaded into a test-owned webview panel with the extension's HTML. It records CSP
// violations from the start and reports, after load, how the extension's controls and its own
// generated styles actually render.
const WEBVIEW_PROBE_SCRIPT = `
(() => {
  const api = acquireVsCodeApi();
  globalThis.acquireVsCodeApi = () => api;
  // The same scrollbar on every page, so control sizes do not depend on the documentation's length.
  document.documentElement.style.overflowY = 'scroll';
  const violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push({ directive: event.effectiveDirective || event.violatedDirective, blockedURI: event.blockedURI });
  });
  const describe = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      const siblings = current.parentElement ? Array.from(current.parentElement.children) : [];
      parts.unshift(current.tagName.toLowerCase() + ':' + siblings.indexOf(current));
      current = current.parentElement;
    }
    return parts.join('>') + ' ' + String(element.textContent || '').trim().slice(0, 30);
  };
  const measure = () => {
    const documentationRoots = Array.from(document.querySelectorAll('.doc-render-flow, .details, main.preview'));
    const controls = Array.from(
      document.querySelectorAll('a, button, input, .file, .meta, .preview-title, .preview-actions, .export-toolbar')
    ).filter((element) => !documentationRoots.some((root) => root.contains(element)));
    const controlResults = controls.map((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = element.getClientRects()[0] || element.getBoundingClientRect();
      const style = getComputedStyle(element);
      let hit = false;
      if (box.width > 0 && box.height > 0) {
        const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        hit = Boolean(target && (target === element || element.contains(target)));
      }
      return {
        key: describe(element),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        color: style.color,
        backgroundColor: style.backgroundColor,
        top: Math.round(box.top + window.scrollY),
        left: Math.round(box.left + window.scrollX),
        width: Math.round(box.width),
        height: Math.round(box.height),
        hit
      };
    });
    const overlay = document.getElementById('rcProbeOverlay');
    api.postMessage({
      type: 'rcWebviewProbe',
      result: {
        violations,
        controls: controlResults,
        overlayPosition: overlay ? getComputedStyle(overlay).position : '',
        customColors: Array.from(document.querySelectorAll('.doc-color-custom')).map((element) => getComputedStyle(element).color),
        arrowLines: Array.from(document.querySelectorAll('.robot-arrow-line')).map((element) => ({
          indent: getComputedStyle(element).getPropertyValue('--robot-arrow-indent').trim(),
          paddingLeft: getComputedStyle(element).paddingLeft
        })),
        pageBreaks: Array.from(document.querySelectorAll('.documentation-export-page-break')).map(
          (element) => getComputedStyle(element).breakBefore
        ),
        images: Array.from(document.images).map((image) => ({
          src: String(image.getAttribute('src') || '').slice(0, 60),
          naturalWidth: image.naturalWidth
        }))
      }
    });
  };
  let measured = false;
  const measureOnce = () => {
    if (measured) {
      return;
    }
    measured = true;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(measure, 150)));
  };
  window.addEventListener('load', measureOnce);
  setTimeout(measureOnce, 4000);
})();
`;

async function probeWebviewHtml(buildHtml) {
  const panel = vscode.window.createWebviewPanel(
    "robotCompanionTest.webviewProbe",
    "Robot Companion webview probe",
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableScripts: true }
  );
  try {
    const html = await buildHtml(panel.webview.cspSource, panel.webview);
    const nonceMatch = html.match(/script-src 'nonce-([0-9a-f]+)'/);
    assert(nonceMatch, "expected a nonce script source in the extension's CSP");
    const probedHtml = html.replace(
      /(<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>)/,
      (meta) => `${meta}\n  <script nonce="${nonceMatch[1]}">${WEBVIEW_PROBE_SCRIPT}</script>`
    );
    assert.notStrictEqual(probedHtml, html, "expected to insert the probe after the CSP meta element");
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the webview probe.")), 20000);
      panel.webview.onDidReceiveMessage((message) => {
        if (message && message.type === "rcWebviewProbe") {
          clearTimeout(timer);
          resolve(message.result);
        }
      });
    });
    panel.webview.html = probedHtml;
    return { html, result: await result };
  } finally {
    panel.dispose();
  }
}

function assertControlsUnaffected(name, benign, hostile) {
  assert(benign.controls.length > 0, `${name}: expected controls to probe`);
  assert.deepStrictEqual(
    hostile.controls.map((control) => control.key),
    benign.controls.map((control) => control.key),
    `${name}: documentation must not add, remove or reorder the extension's controls`
  );
  let visibleControls = 0;
  hostile.controls.forEach((control, index) => {
    const expected = benign.controls[index];
    for (const property of ["display", "visibility", "opacity", "color", "backgroundColor", "top", "left", "width", "height"]) {
      assert.strictEqual(
        control[property],
        expected[property],
        `${name}: ${control.key} ${property} changed from ${expected[property]} to ${control[property]}`
      );
    }
    if (expected.hit) {
      visibleControls += 1;
      assert(control.hit, `${name}: ${control.key} is covered by documentation content`);
    }
  });
  assert(visibleControls > 0, `${name}: expected at least one clickable control`);
}

suite("Robot Companion documentation webview restrictions", function () {
  this.timeout(120000);

  let extensionTestApi;
  let probeDocument;
  let probeBlock;
  let alphaDocument;
  let betaDocument;
  let workspaceFolderUri;
  let outsideDirectory;
  let outsideFileUri;

  async function showEditor(document) {
    return vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  }

  async function showProbeInPreview() {
    // Move the preview away first, so the wait below sees a fresh render.
    await showEditor(alphaDocument);
    await waitFor(
      () => extensionTestApi.getDocumentationPreviewSnapshotForTest().documentUri === alphaDocument.uri.toString(),
      "the preview to follow navigation-alpha.robot"
    );
    await showEditor(probeDocument);
    await vscode.commands.executeCommand("robotCompanion.openBlockAt", probeDocument.uri.toString(), probeBlock.id, {
      revealPreview: true
    });
    let webview;
    await waitFor(() => {
      const snapshot = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      webview = extensionTestApi.getDocumentationPreviewWebviewForTest();
      return (
        snapshot.visible &&
        snapshot.selectedBlockId === probeBlock.id &&
        webview.html.includes("rcProbeRemoteHtmlImage")
      );
    }, "the Documentation Preview to show the restrictions probe");
    return webview;
  }

  async function renderProbeHtml() {
    return extensionTestApi.renderDocumentationBlockHtml(probeDocument.uri.toString(), probeBlock);
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available in the test host.`);
    await extension.activate();
    extensionTestApi = require(path.join(extension.extensionPath, "src/core/extension.js")).__test__;

    workspaceFolderUri = vscode.workspace.workspaceFolders[0].uri;
    const findFixture = async (name) => {
      const [uri] = await vscode.workspace.findFiles(name);
      assert(uri, `Expected fixture ${name} in the workspace.`);
      return vscode.workspace.openTextDocument(uri);
    };
    probeDocument = await findFixture(PROBE_FIXTURE);
    alphaDocument = await findFixture(NAVIGATION_ALPHA_FIXTURE);
    betaDocument = await findFixture(NAVIGATION_BETA_FIXTURE);
    probeBlock = new extensionTestApi.RobotDocumentationService()
      .parse(probeDocument)
      .blocks.find((candidate) => candidate.ownerName === PROBE_OWNER);
    assert(probeBlock, "expected the restrictions probe documentation block");

    // A real .robot file outside every workspace folder, next to the workspace directory.
    outsideDirectory = fs.mkdtempSync(path.join(path.dirname(workspaceFolderUri.fsPath), "robot-companion-outside-"));
    const outsidePath = path.join(outsideDirectory, "outside.robot");
    fs.writeFileSync(outsidePath, OUTSIDE_ROBOT_SOURCE, "utf8");
    outsideFileUri = vscode.Uri.file(outsidePath);
  });

  suiteTeardown(async () => {
    extensionTestApi?.setWebviewWorkspaceTrustOverrideForTest(undefined);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (outsideDirectory) {
      fs.rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  test("link targets outside the workspace that are not in view open, read and export nothing", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showEditor(alphaDocument);
    await waitFor(
      () => extensionTestApi.getDocumentationPreviewSnapshotForTest().documentUri !== outsideFileUri.toString(),
      "the preview to show a workspace document"
    );

    const workspaceFolder = workspaceFolderUri.toString();
    const outsideName = path.basename(outsideDirectory);
    const refusedTargets = [
      { label: "/etc/hostname", uri: "file:///etc/hostname", fsPath: "/etc/hostname" },
      { label: "file outside the workspace", uri: outsideFileUri.toString(), fsPath: outsideFileUri.fsPath },
      {
        label: "..-escape to /etc/hostname",
        uri: `${workspaceFolder}/../../../../../../../../etc/hostname`,
        fsPath: "/etc/hostname"
      },
      {
        label: "..-escape to an existing .robot file",
        uri: `${workspaceFolder}/../${outsideName}/outside.robot`,
        fsPath: outsideFileUri.fsPath
      },
      { label: "untitled:", uri: "untitled:Robot-Companion-Probe.robot" },
      { label: "vscode-userdata:", uri: "vscode-userdata:/etc/hostname" },
      { label: "https:", uri: "https://robot-companion.invalid/remote.robot" }
    ];
    assert(fs.existsSync("/etc/hostname"), "the test expects /etc/hostname to exist");

    const tabsBefore = openTabKeys();
    const documentsBefore = openDocumentKeys();
    const previewBefore = extensionTestApi.getDocumentationPreviewSnapshotForTest();
    const foldTierOf = (uri) => extensionTestApi.getActiveDocumentationBodyFoldTier(uri);
    const invocations = [];
    for (const target of refusedTargets) {
      invocations.push(
        // Webview link (managed bridge) and hover link (VS Code runs the command directly).
        { commandId: "robotCompanion.openLocation", via: "webview", target, args: [target.uri, 0, 0] },
        { commandId: "robotCompanion.openLocation", via: "hover", target, args: [target.uri, 0, 0] },
        {
          commandId: "robotCompanion.openLocation",
          via: "webview",
          target,
          label: "keyword-argument preview metadata",
          args: [
            alphaDocument.uri.toString(),
            0,
            0,
            { kind: "keywordArgumentPreview", payload: { documentUri: target.uri, keywordName: "Log", argumentName: "message" } }
          ]
        },
        { commandId: "robotCompanion.openBlockAt", via: "webview", target, args: [target.uri, probeBlock.id, { revealPreview: true }] },
        { commandId: "robotCompanion.openBlockAt", via: "hover", target, args: [target.uri, probeBlock.id] }
      );
      for (const commandId of FOLD_COMMANDS) {
        // Preview fold link (managed bridge) and a direct call with a URI argument.
        invocations.push(
          { commandId, via: "webview", target, args: [target.uri] },
          { commandId, via: "hover", target, args: [target.uri] }
        );
      }
      if (target.fsPath) {
        for (const commandId of EXPORT_COMMANDS) {
          const args = commandId.includes("Selected") ? [target.uri] : [target.uri, probeBlock.id];
          invocations.push({ commandId, via: "webview", target, args });
        }
      }
    }

    for (const invocation of invocations) {
      const description = `${invocation.commandId} (${invocation.via}) to ${invocation.target.label}${
        invocation.label ? ` via ${invocation.label}` : ""
      }`;
      const outputBefore = extensionTestApi.getRobotCompanionOutputLineCountForTest();
      if (invocation.via === "webview") {
        assert.strictEqual(
          await extensionTestApi.executeManagedCommandUri(buildCommandUri(invocation.commandId, invocation.args)),
          true,
          `${description}: the managed bridge still dispatches allowlisted commands`
        );
      } else {
        await vscode.commands.executeCommand(invocation.commandId, ...invocation.args);
      }
      await sleep(150);

      assert.deepStrictEqual(openTabKeys(), tabsBefore, `${description}: editor tabs must not change`);
      assert.deepStrictEqual(openDocumentKeys(), documentsBefore, `${description}: no document may be opened`);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), alphaDocument.uri.toString());
      const previewAfter = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      assert.strictEqual(previewAfter.documentUri, previewBefore.documentUri, `${description}: preview must not change`);
      assert.strictEqual(previewAfter.selectedBlockId, previewBefore.selectedBlockId);
      assert.strictEqual(foldTierOf(invocation.target.uri), null, `${description}: nothing may be folded`);

      const newOutput = extensionTestApi.getRobotCompanionOutputSinceForTest(outputBefore);
      const warningIndex = newOutput.findIndex((line) => line.includes("[WARN]") && line.includes(`Refused ${invocation.commandId}`));
      assert(warningIndex >= 0, `${description}: expected a warning naming the refused command, got ${newOutput.join("\n")}`);
      assert(
        newOutput.slice(warningIndex).some((line) => line.includes(invocation.target.uri)),
        `${description}: the warning should name the refused target`
      );
    }
    assert(
      !vscode.workspace.textDocuments.some((document) => document.uri.fsPath === "/etc/hostname"),
      "/etc/hostname must never be read"
    );
  });

  test("target checks normalise the path before comparing it with the workspace folder", () => {
    const workspaceFolder = workspaceFolderUri.toString();
    const workspaceName = path.basename(workspaceFolderUri.fsPath);
    const allowed = (uri) => extensionTestApi.isDocumentationLinkTargetAllowed(uri, []);
    assert.strictEqual(allowed(alphaDocument.uri.toString()), true);
    assert.strictEqual(allowed(`${workspaceFolder}/sub/../${NAVIGATION_ALPHA_FIXTURE}`), true);
    assert.strictEqual(allowed(`${workspaceFolder}/../${workspaceName}/${NAVIGATION_ALPHA_FIXTURE}`), true);
    assert.strictEqual(allowed(`${workspaceFolder}/%2e%2e/%2e%2e/etc/hostname`), false);
    assert.strictEqual(allowed(`${workspaceFolder}-sibling/outside.robot`), false);
    assert.strictEqual(allowed("/etc/hostname"), false, "a URI without a scheme is refused");
    assert.strictEqual(allowed(""), false);
    assert.strictEqual(allowed("untitled:Untitled-1"), false);
    assert.strictEqual(extensionTestApi.isDocumentationLinkTargetAllowed("untitled:Untitled-1", ["untitled:Untitled-1"]), true);
  });

  test("links inside the workspace and to the document in view keep working", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // A workspace file that is not the active document.
    await showEditor(alphaDocument);
    await extensionTestApi.executeManagedCommandUri(
      buildCommandUri("robotCompanion.openLocation", [betaDocument.uri.toString(), 2, 4])
    );
    await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === betaDocument.uri.toString() && editor.selection.active.line === 2;
    }, "a workspace link to open navigation-beta.robot at line 3");

    // A single .robot file outside every workspace folder, shown in the active editor.
    const outsideDocument = await vscode.workspace.openTextDocument(outsideFileUri);
    await showEditor(outsideDocument);
    const outsideBlock = new extensionTestApi.RobotDocumentationService()
      .parse(outsideDocument)
      .blocks.find((candidate) => candidate.ownerName === OUTSIDE_OWNER);
    assert(outsideBlock, "expected the outside documentation block");

    const robotCompanionConfig = vscode.workspace.getConfiguration("robotCompanion");
    await robotCompanionConfig.update("enableDocumentationHoverPreview", true, vscode.ConfigurationTarget.Workspace);
    let hovers;
    try {
      hovers = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        outsideDocument.uri,
        new vscode.Position(outsideBlock.startLine, outsideDocument.lineAt(outsideBlock.startLine).firstNonWhitespaceCharacterIndex)
      );
    } finally {
      await robotCompanionConfig.update("enableDocumentationHoverPreview", undefined, vscode.ConfigurationTarget.Workspace);
    }
    const hoverLink = (hovers || [])
      .flatMap((hover) => hover.contents)
      .map((content) => String(content?.value || content || ""))
      .map((value) => value.match(/\[Open full rendered preview\]\((command:[^)]+)\)/))
      .find(Boolean);
    assert(hoverLink, "Expected the hover of the outside file to offer Open full rendered preview.");
    const hoverMatch = hoverLink[1].match(/^command:([^?]+)\?(.*)$/);
    await vscode.commands.executeCommand(hoverMatch[1], ...JSON.parse(decodeURIComponent(hoverMatch[2])));
    await waitFor(() => {
      const snapshot = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      return (
        snapshot.visible &&
        snapshot.documentUri === outsideDocument.uri.toString() &&
        snapshot.selectedBlockId === outsideBlock.id
      );
    }, "the hover link of the active outside document to reveal its preview");

    // The preview's own jump link back to the active outside document.
    const encodedOutsideUri = encodeURIComponent(JSON.stringify([outsideDocument.uri.toString()])).slice(0, -3);
    let webview;
    await waitFor(() => {
      webview = extensionTestApi.getDocumentationPreviewWebviewForTest();
      return webview.html.includes(`command:robotCompanion.openLocation?${encodedOutsideUri}`);
    }, "the preview to render the jump link of the outside document");
    const ownerJump = (webview.html.match(/href="(command:robotCompanion\.openLocation\?[^"]*)"/) || [])[1];
    assert(ownerJump, "expected the preview's jump-to-source link for the outside document");
    await showEditor(outsideDocument);
    await vscode.window.activeTextEditor.revealRange(new vscode.Range(4, 0, 4, 0));
    vscode.window.activeTextEditor.selection = new vscode.Selection(4, 0, 4, 0);
    await webview.handleMessage({ type: "executeCommandUri", commandUri: decodeHtmlAttribute(ownerJump) });
    await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      return (
        editor &&
        editor.document.uri.toString() === outsideDocument.uri.toString() &&
        editor.document.lineAt(editor.selection.active.line).text === OUTSIDE_OWNER
      );
    }, "the preview jump link to open the outside document at its test");

    // Export of the active outside document.
    const pdfHtmlBefore = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
    await extensionTestApi.executeManagedCommandUri(
      buildCommandUri("robotCompanion.exportDocumentationPdf", [outsideDocument.uri.toString(), outsideBlock.id])
    );
    await waitFor(() => {
      const pdfHtml = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
      return pdfHtml !== pdfHtmlBefore && pdfHtml.includes("Outside body text.");
    }, "the PDF export link to export the active outside document");

    // Once another document is in view, the outside file is refused again.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showEditor(alphaDocument);
    await waitFor(
      () => extensionTestApi.getDocumentationPreviewSnapshotForTest().documentUri === alphaDocument.uri.toString(),
      "the preview to follow navigation-alpha.robot"
    );
    const outputBefore = extensionTestApi.getRobotCompanionOutputLineCountForTest();
    await extensionTestApi.executeManagedCommandUri(
      buildCommandUri("robotCompanion.openLocation", [outsideDocument.uri.toString(), 0, 0])
    );
    await sleep(150);
    assert.strictEqual(vscode.window.activeTextEditor.document.uri.toString(), alphaDocument.uri.toString());
    assert(
      extensionTestApi
        .getRobotCompanionOutputSinceForTest(outputBefore)
        .some((line) => line.includes("Refused robotCompanion.openLocation"))
    );
  });

  test("the preview's fold links fold the document in view, inside the workspace and without a workspace folder", async () => {
    const foldSteps = [
      { commandId: "robotCompanion.foldDocumentationToHeadlines", tier: 1 },
      { commandId: "robotCompanion.foldDocumentationToSteps", tier: 4 },
      { commandId: "robotCompanion.unfoldDocumentation", tier: null }
    ];
    const clickFoldLinks = async (document, webview, label) => {
      for (const step of foldSteps) {
        const pattern = new RegExp(`href="(command:${step.commandId.replace(/\./g, "\\.")}\\?[^"]*)"`);
        const href = (webview.html.match(pattern) || [])[1];
        assert(href, `${label}: expected the preview's ${step.commandId} link`);
        assert(
          parseLinkArgs(decodeHtmlAttribute(href))[0] === document.uri.toString(),
          `${label}: the ${step.commandId} link should name the document in view`
        );
        const outputBefore = extensionTestApi.getRobotCompanionOutputLineCountForTest();
        await webview.handleMessage({ type: "executeCommandUri", commandUri: decodeHtmlAttribute(href) });
        await waitFor(
          () => extensionTestApi.getActiveDocumentationBodyFoldTier(document.uri.toString()) === step.tier,
          `${label}: ${step.commandId} to set the fold state of ${path.basename(document.uri.fsPath)}`
        );
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString());
        assert(
          !extensionTestApi
            .getRobotCompanionOutputSinceForTest(outputBefore)
            .some((line) => line.includes(`Refused ${step.commandId}`)),
          `${label}: ${step.commandId} must not be refused`
        );
      }
    };

    // A document inside the workspace folder.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const probeWebview = await showProbeInPreview();
    await clickFoldLinks(probeDocument, probeWebview, "workspace document");

    // A single .robot file outside every workspace folder, in view in the editor and the preview.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const outsideDocument = await vscode.workspace.openTextDocument(outsideFileUri);
    await showEditor(outsideDocument);
    const outsideBlock = new extensionTestApi.RobotDocumentationService()
      .parse(outsideDocument)
      .blocks.find((candidate) => candidate.ownerName === OUTSIDE_OWNER);
    assert(outsideBlock, "expected the outside documentation block");
    await vscode.commands.executeCommand("robotCompanion.openBlockAt", outsideDocument.uri.toString(), outsideBlock.id, {
      revealPreview: true
    });
    let outsideWebview;
    await waitFor(() => {
      const snapshot = extensionTestApi.getDocumentationPreviewSnapshotForTest();
      outsideWebview = extensionTestApi.getDocumentationPreviewWebviewForTest();
      return (
        snapshot.visible &&
        snapshot.documentUri === outsideDocument.uri.toString() &&
        outsideWebview.html.includes("command:robotCompanion.foldDocumentationToHeadlines")
      );
    }, "the Documentation Preview to show the outside document");
    await clickFoldLinks(outsideDocument, outsideWebview, "folder-less document in view");
  });

  test("Restricted Mode allows no remote images in any documentation webview", async () => {
    try {
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(false);
      const webview = await showProbeInPreview();
      for (const url of REMOTE_IMAGE_URLS) {
        assert(webview.html.includes(`src="${url}"`), `expected the preview to contain the remote image ${url}`);
      }
      assertImageSources(webview.html, webview.cspSource, { trusted: false });

      const renderedHtml = await renderProbeHtml();
      const returnHtml = extensionTestApi.buildReturnExplorerWebviewHtmlForTest(
        { fileName: PROBE_FIXTURE, contextKind: "keyword-doc", keywordName: "Probe Keyword" },
        renderedHtml,
        "vscode-webview://return-explorer"
      );
      assert(returnHtml.includes(REMOTE_IMAGE_URLS[0]) && returnHtml.includes(REMOTE_IMAGE_URLS[1]));
      assertImageSources(returnHtml, "vscode-webview://return-explorer", { trusted: false });

      const pdfHtmlBefore = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
      await vscode.commands.executeCommand("robotCompanion.exportDocumentationPdf", probeDocument.uri.toString(), probeBlock.id);
      await waitFor(() => {
        const pdfHtml = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
        return pdfHtml !== pdfHtmlBefore && pdfHtml.includes("rcProbeRemoteHtmlImage");
      }, "the PDF export webview to show the probe");
      const pdfHtml = extensionTestApi.getLastDocumentationPdfExportHtmlForTest();
      assertImageSources(pdfHtml, webview.cspSource, { trusted: false });
      const browserHtml = extensionTestApi.buildDocumentationPdfExportHtml(probeDocument, {
        title: PROBE_OWNER,
        bodyHtml: renderedHtml,
        browserMode: true
      });
      assertImageSources(browserHtml, "file:", { trusted: false });

      // The effective policy in a real webview: remote images are blocked, the data: image displays.
      const { result } = await probeWebviewHtml((cspSource) =>
        extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
          { documentUri: probeDocument.uri.toString(), fileName: PROBE_FIXTURE, blocks: [probeBlock] },
          probeBlock,
          renderedHtml,
          cspSource
        )
      );
      for (const url of REMOTE_IMAGE_URLS) {
        assert(
          result.violations.some((violation) => violation.directive === "img-src" && violation.blockedURI === url),
          `expected the webview to block ${url}, violations: ${JSON.stringify(result.violations)}`
        );
      }
      const dataImage = result.images.find((image) => image.src.startsWith("data:image/png"));
      assert(dataImage, `expected the data: image in the probe, got ${JSON.stringify(result.images)}`);
      assert.strictEqual(dataImage.naturalWidth, 2, "the data: image must still display in Restricted Mode");

      // Granting trust allows remote images on the next render; withdrawing it never keeps them.
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(true);
      assertImageSources((await showProbeInPreview()).html, webview.cspSource, { trusted: true });
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(false);
      assertImageSources((await showProbeInPreview()).html, webview.cspSource, { trusted: false });
    } finally {
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(undefined);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("a trusted workspace keeps remote images", async () => {
    try {
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(true);
      const renderedHtml = await renderProbeHtml();
      const { result } = await probeWebviewHtml((cspSource) =>
        extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
          { documentUri: probeDocument.uri.toString(), fileName: PROBE_FIXTURE, blocks: [probeBlock] },
          probeBlock,
          renderedHtml,
          cspSource
        )
      );
      assert(
        !result.violations.some((violation) => violation.directive === "img-src"),
        `a trusted workspace must not block images, violations: ${JSON.stringify(result.violations)}`
      );
    } finally {
      extensionTestApi.setWebviewWorkspaceTrustOverrideForTest(undefined);
    }
  });

  test("documentation cannot restyle or cover the controls of the three webviews; generated styles still render", async () => {
    const probeHtml = await renderProbeHtml();
    // A workspace stylesheet linked from documentation: style-src names the webview resource source.
    const stylesheetUri = vscode.Uri.joinPath(workspaceFolderUri, "robot-companion-probe-hostile.css");
    fs.writeFileSync(
      stylesheetUri.fsPath,
      "body * { display: none !important; } a, button { color: rgb(255, 0, 0) !important; }\n",
      "utf8"
    );
    // Added inside the rendered documentation, where documentation HTML always ends up: a plain <link>,
    // two split tags that a one-pass tag removal would rebuild, a link hidden in an attribute next to an
    // indent token (which the preview script re-parses), and SVG shapes that overflow their box and are
    // not governed by style-src.
    const withLinkedStylesheet = (webview) => {
      const href = webview.asWebviewUri(stylesheetUri).toString();
      const hostileHtml = [
        `<link rel="stylesheet" href="${href}">`,
        `<li<link>nk rel="stylesheet" href="${href}">`,
        `<<LINK>link rel="stylesheet" href="${href}">`,
        `<p>[[RDP_INDENT_2]]-> split <span title="<br><link rel=stylesheet href=${href}>">here</span></p>`,
        '<svg width="1" height="1" overflow="visible"><rect x="-4000" y="-4000" width="8000" height="8000" fill="red"/></svg>',
        '<svg width="1" height="1" overflow="visible" transform="translate(0,-3000)"><rect x="-4000" y="0" width="8000" height="8000" fill="red"/></svg>'
      ].join("\n");
      const sectionEnd = probeHtml.indexOf("</section>");
      assert(sectionEnd > 0, "expected the rendered documentation section");
      return `${probeHtml.slice(0, sectionEnd)}${hostileHtml}${probeHtml.slice(sectionEnd)}`;
    };
    const benignBlock = { ...probeBlock };
    const pages = [
      {
        name: "Documentation Preview",
        arrowLines: true,
        build: (body) => (cspSource, webview) =>
          extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
            { documentUri: probeDocument.uri.toString(), fileName: PROBE_FIXTURE, blocks: [probeBlock] },
            benignBlock,
            body(webview),
            cspSource
          )
      },
      {
        name: "Return Explorer",
        build: (body) => (cspSource, webview) =>
          extensionTestApi.buildReturnExplorerWebviewHtmlForTest(
            {
              fileName: PROBE_FIXTURE,
              ownerName: PROBE_OWNER,
              contextKind: "keyword-doc",
              keywordName: "Probe Keyword"
            },
            body(webview),
            cspSource
          )
      },
      {
        name: "PDF/print export",
        arrowLines: true,
        build: (body) => (cspSource, webview) =>
          extensionTestApi.buildDocumentationPdfExportHtml(probeDocument, {
            title: PROBE_OWNER,
            bodyHtml: [
              extensionTestApi.buildDocumentationPdfExportPageHtml(PROBE_OWNER, body(webview), 0),
              extensionTestApi.buildDocumentationPdfExportPageHtml(PROBE_OWNER, body(webview), 1)
            ].join("\n"),
            cspSource
          })
      }
    ];

    try {
      for (const page of pages) {
        const benignBody = () => '<section class="doc-render-flow"><p>Plain text.</p></section>';
        const benign = (await probeWebviewHtml(page.build(benignBody))).result;
        const { html, result: hostile } = await probeWebviewHtml(page.build(withLinkedStylesheet));
        assert(!/<link\b/i.test(html.slice(html.indexOf("</head>"))), `${page.name}: documentation <link> must be removed`);

        assertControlsUnaffected(page.name, benign, hostile);
        assert.strictEqual(hostile.overlayPosition, "static", `${page.name}: the position:fixed overlay must not apply`);
        const styleSources = readContentSecurityPolicy(html).get("style-src") || [];
        assert(!styleSources.includes("'unsafe-inline'"), `${page.name}: style-src must not allow 'unsafe-inline'`);
        assert(
          hostile.violations.some((violation) => violation.directive === "style-src-elem"),
          `${page.name}: the documentation <style> element must be blocked, got ${JSON.stringify(hostile.violations)}`
        );
        assert(
          hostile.violations.some((violation) => violation.directive === "style-src-attr"),
          `${page.name}: the documentation style attribute must be blocked`
        );
        assert(
          !benign.violations.some((violation) => /^style-src/.test(violation.directive)),
          `${page.name}: the extension's own styles must not be blocked, got ${JSON.stringify(benign.violations)}`
        );

        // The extension's own generated styles still apply.
        assert(hostile.customColors.length > 0, `${page.name}: expected the custom colour span`);
        for (const color of hostile.customColors) {
          assert.strictEqual(color, "rgb(15, 118, 110)", `${page.name}: custom colour span`);
        }
        if (!page.arrowLines) {
          continue;
        }
        assert(hostile.arrowLines.length >= 2, `${page.name}: expected arrow lines, got ${JSON.stringify(hostile.arrowLines)}`);
        for (const arrowLine of hostile.arrowLines) {
          assert(/^\d+ch$/.test(arrowLine.indent), `${page.name}: arrow indent ${JSON.stringify(arrowLine)}`);
          if (arrowLine.indent !== "0ch") {
            assert.notStrictEqual(arrowLine.paddingLeft, "0px", `${page.name}: arrow-line indentation must apply`);
          }
        }
        const indents = hostile.arrowLines.map((arrowLine) => parseFloat(arrowLine.paddingLeft));
        assert(indents[1] > indents[0], `${page.name}: the deeper arrow line must be indented further, got ${indents}`);
        if (page.name === "PDF/print export") {
          assert.deepStrictEqual(hostile.pageBreaks, ["page"], "the second export page must start on a new page");
        }
      }
    } finally {
      fs.rmSync(stylesheetUri.fsPath, { force: true });
    }
  });
});

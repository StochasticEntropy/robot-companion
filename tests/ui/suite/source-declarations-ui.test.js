"use strict";

// Actual editor and Return Explorer acceptance against the owned native backend.
// The synthetic custom decorators and external base are read, never imported or run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const required = process.env.ROBOT_COMPANION_UI_REQUIRE_NATIVE === "1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NAME = "Submit Example Request";
const DOC = "Submit the selected synthetic request.";
const SHADOW_DOC = "Unimported shadow documentation must not be selected.";
const HELPER = [
  "from ExampleProject import metadata", "",
  "def keyword(*args, extra_flag=True, **kwargs):",
  "    return metadata.keyword(*args, **kwargs, extra_flag=extra_flag)", ""
].join("\n");
const API = [
  "from ExampleProject.base import Parent", "from ExampleProject.helpers import keyword",
  "from ExampleProject.wrappers import preserve", "from pathlib import Path", "",
  "class Api(Parent):", `    @keyword(${JSON.stringify(NAME)}, extra_flag=True)`, "    @preserve",
  "    def submit_request(self, partner: str, count: int = 1) -> str:",
  `        \"\"\"${DOC}`, "",
  "        Args:", "            partner: The selected example partner.", "            count: The declared number of requests.",
  "        \"\"\"", "        Path(__file__).with_name('keyword-executed.txt').write_text(partner, encoding='utf-8')",
  "        return partner", ""
].join("\n");
const FILES = {
  "ExampleProject/__init__.py": "",
  "ExampleProject/base.py": "class Parent:\n    pass\n",
  "ExampleProject/helpers.py": HELPER,
  "ExampleProject/metadata.py": [
    "from robot.api.deco import keyword as robot_keyword", "from functools import wraps", "from pathlib import Path", "",
    "def keyword(name=None, tags=(), types=(), extra_flag=False):", "    def decorate(function):",
    "        @robot_keyword(name, tags, types)", "        @wraps(function)", "        def wrapped(*args, **kwargs):",
    "            return function(*args, **kwargs)", "        return wrapped", "    return decorate", "",
    "Path(__file__).with_name('module-executed.txt').write_text('executed', encoding='utf-8')", ""
  ].join("\n"),
  "ExampleProject/wrappers.py": ["from functools import wraps", "def preserve(function):", "    @wraps(function)",
    "    def wrapped(*args, **kwargs):", "        return function(*args, **kwargs)", "    return wrapped", ""].join("\n"),
  "ExampleProject/api.py": API,
  "UnimportedShadow.py": ["from robot.api.deco import keyword", `@keyword(${JSON.stringify(NAME)})`,
    "def unrelated(unrelated):", `    \"\"\"${SHADOW_DOC}\"\"\"`, "    return unrelated", ""].join("\n"),
  "selected.robot": ["*** Settings ***", "Library    ExampleProject.api.Api    AS    ExampleApi", "",
    "*** Test Cases ***", "Selected", `    ExampleApi.${NAME}    partner=sample    count=2`, ""].join("\n")
};
const CALL_LINE = 5;
const METHOD_LINE = API.split("\n").findIndex(line => line.includes("def submit_request("));

async function until(predicate, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(75);
  }
  throw new Error(`Timed out: ${label}`);
}

suite("Native source declarations: actual Return Explorer and editor navigation", function () {
  let extension, api, manager, config, folder, directory, cdp, root, suiteDocument;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(directory, ...name.split("/"));
  const explorerHtml = () => api.getReturnExplorerWebviewHtmlForTest();
  async function page(expression) {
    const answer = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(answer.exceptionDetails, undefined, JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `source-declarations-${name}.png`), Buffer.from(data, "base64"));
  }
  function assertNotExecuted() {
    for (const name of ["module-executed.txt", "keyword-executed.txt"]) {
      assert.equal(fs.existsSync(file(`ExampleProject/${name}`).fsPath), false, `Native inspection executed ${name}`);
    }
  }
  async function openSuite() {
    suiteDocument = await vscode.workspace.openTextDocument(file("selected.robot"));
    const editor = await vscode.window.showTextDocument(suiteDocument, { preview: false });
    editor.revealRange(new vscode.Range(CALL_LINE, 0, CALL_LINE, 75), vscode.TextEditorRevealType.InCenter);
    return editor;
  }
  async function clickCall() {
    // Native CodeLens inserts a view zone above the call after the editor first
    // paints. Wait for that actual zone before measuring the pointer target.
    await until(() => page(`(() => {
      const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')]
        .find(element => element.getAttribute('data-uri') === ${JSON.stringify(file("selected.robot").toString())});
      return Boolean(editor && [...editor.querySelectorAll('.codelens-decoration a')]
        .some(link => link.textContent.trim() === 'Run Test' && link.getClientRects().length));
    })()`), "selected suite CodeLens painted before pointer measurement");
    const samplePoint = () => page(`(() => {
        const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')]
          .find(element => element.getAttribute('data-uri') === ${JSON.stringify(file("selected.robot").toString())});
        const row = [...(editor?.querySelectorAll('.view-line') || [])]
          .find(element => element.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(NAME)}));
        if (!row) return;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          const offset = node.textContent.indexOf('Submit');
          if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset + 1); range.setEnd(node, offset + 3);
          const rect = range.getBoundingClientRect();
          if (!rect.width || rect.top < 0 || rect.bottom > innerHeight) return;
          const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          return row.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
        }
      })()`);
    let point, previous, stableSince = Date.now();
    await until(async () => {
      point = await samplePoint();
      if (!point || !previous || point.x !== previous.x || point.y !== previous.y) stableSince = Date.now();
      previous = point;
      return point && Date.now() - stableSince >= 400;
    }, "visible keyword call stable after CodeLens layout");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    await sleep(150);
    // Re-read and hit-test after hover settling, immediately before pressing.
    // A changed layout is an explicit harness failure, never a click on an old row.
    const pressedPoint = await samplePoint();
    assert.deepEqual(pressedPoint, point, "Keyword target moved after CodeLens/hover settling");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...pressedPoint,
        button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cdp.pageSession);
    }
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === suiteDocument.uri.toString() &&
      vscode.window.activeTextEditor.selection.active.line === CALL_LINE, "cursor on selected keyword");
    evidence.push({ action: "pointer click keyword", point: pressedPoint, line: CALL_LINE,
      layout: "painted CodeLens; 400ms stable; post-hover target hit-tested immediately before press" });
  }
  async function key(key, code, virtualKeyCode) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode
    }, cdp.pageSession);
    evidence.push({ action: "key", key });
  }
  async function expectTarget() {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === file("ExampleProject/api.py").toString() &&
        editor.selection.active.line === METHOD_LINE && editor.selection.active.character === 8;
    }, "original own method source and exact selection");
    evidence.push({ result: "source target", uri: vscode.window.activeTextEditor.document.uri.toString(),
      line: METHOD_LINE, character: 8 });
    assertNotExecuted();
  }
  async function expectExplorer() {
    await until(() => explorerHtml().includes("Source Declaration") && explorerHtml().includes(DOC), "source declaration documentation in Return Explorer");
    const html = explorerHtml();
    assert.match(html, /runtime decorators may add or alter parameters/);
    assert.match(html, /selected example partner/);
    assert.match(html, /declared number of requests/);
    assert.match(html, /Open source declaration/);
    assert.doesNotMatch(html, /No indexed|Keyword definition is unavailable|Unimported shadow documentation/);
    assertNotExecuted();
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "source-declarations-explorer.html"), html);
  }
  async function showExplorer() {
    await vscode.commands.executeCommand("robotCompanion.returnView.focus");
    await openSuite();
    await clickCall();
    await expectExplorer();
  }
  async function clickSourceLink() {
    let html, since = Date.now();
    await until(() => {
      const current = explorerHtml();
      if (current !== html) { html = current; since = Date.now(); }
      return Date.now() - since >= 400;
    }, "Return Explorer layout settled");
    const frame = await cdp.findWebviewFrame('return Boolean(document.querySelector(".details") && document.querySelector(".meta"));', "Return Explorer");
    const element = `Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'Open source declaration')`;
    let rect;
    for (let attempt = 0; attempt < 10; attempt++) {
      rect = await cdp.evaluate(frame.frameId, `(() => { const a = ${element}; if (!a) return; const r = a.getClientRects()[0];
        return { x: r.x + r.width/2, y: r.y + r.height/2, h: innerHeight }; })()`);
      assert.ok(rect, "Source declaration link exists");
      if (rect.y > 0 && rect.y < rect.h) break;
      const origin = await cdp.frameOrigin(frame);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: origin.pageX + 100, y: origin.pageY + 250,
        deltaX: 0, deltaY: rect.y < 0 ? -250 : 250 }, cdp.pageSession);
      await sleep(100);
    }
    assert.ok(await cdp.hitsElement(frame, rect.x, rect.y, element), "Source declaration link hit test");
    await cdp.click(frame, rect.x, rect.y);
    evidence.push({ action: "trusted Return Explorer source link", point: { x: rect.x, y: rect.y } });
  }

  suiteSetup(async function () {
    this.timeout(180000);
    if (!nativeExecutable) {
      if (required) throw new Error(`Native backend required but unavailable: ${process.env.ROBOT_COMPANION_NATIVE_SKIP || "no executable"}`);
      this.skip(); return;
    }
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    api = activatedExtensionApi(extension.extensionPath);
    manager = api.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    directory = vscode.Uri.joinPath(folder.uri, "integration-source-declarations");
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const [name, text] of Object.entries(FILES)) {
      const uri = file(name);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined);
    assert.equal(vscode.extensions.getExtension("robocorp.robotframework-lsp"), undefined);
    cdp = await WebviewCdp.connect();
    await vscode.commands.executeCommand("notifications.clearAll");
    const { nativeDescriptor } = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const descriptor = nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable });
    await config.update("robotArguments", ["--pythonpath", directory.fsPath], vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "owned native backend running", 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.equal(root.session.serverInfo.name, "robot-companion-backend");
    evidence.push({ setup: "native owned mode; source-only synthetic class/decorators", backend: { ...root.session.serverInfo },
      executable: nativeExecutable, pid: root.session.child.pid, files: Object.keys(FILES),
      viewport: await page("({width: innerWidth, height: innerHeight})") });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await screenshot("failed");
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "source-declarations-failed-explorer.html"), explorerHtml());
    }
  });
  suiteTeardown(async () => {
    if (!extension) return;
    try {
      assertNotExecuted();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const child = root?.session?.child;
      await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("robotArguments", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
      if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "owned native process exited");
      await vscode.workspace.fs.delete(directory, { recursive: true });
      evidence.push({ cleanup: "coexistence; native stopped; synthetic files removed", exitCode: child?.exitCode, signalCode: child?.signalCode });
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "source-declarations-ui-actions.json"), JSON.stringify(evidence, null, 2));
    } finally { cdp?.close(); }
  });

  test("typed source declaration restores documentation and parameters; actual F12 opens the original method", async function () {
    this.timeout(120000);
    await showExplorer();
    await screenshot("explorer");
    const identity = await manager.definitionIdentity(suiteDocument, new vscode.Position(CALL_LINE, 8));
    assert.equal(identity.status, "resolved");
    assert.equal(identity.sourceKind, "declaration");
    assert.equal(identity.uri, file("ExampleProject/api.py").toString());
    evidence.push({ result: "typed identity", uri: identity.uri, sourceKind: identity.sourceKind });
    await key("F12", "F12", 123);
    await expectTarget();
    await screenshot("f12");
  });

  test("source link revalidates its imported declaration and refuses stale helper metadata", async function () {
    this.timeout(120000);
    await showExplorer();
    await clickSourceLink();
    await expectTarget();
    await showExplorer();
    // Disk edit does not move the editor selection. The old rendered link must re-query its source.
    await vscode.workspace.fs.writeFile(file("ExampleProject/helpers.py"), Buffer.from("def keyword(*args, **kwargs):\n    return lambda function: function\n"));
    await until(async () => (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", suiteDocument.uri,
      new vscode.Position(CALL_LINE, 8))).length === 0, "helper edit invalidates native declaration");
    if (explorerHtml().includes("Open source declaration")) {
      await clickSourceLink();
      evidence.push({ result: "stale source link revalidated before opening" });
    } else evidence.push({ result: "stale source link already removed by refreshed view" });
    await until(() => explorerHtml().includes("Keyword definition is unavailable") && !explorerHtml().includes(DOC),
      "unavailable source removes stale documentation");
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), suiteDocument.uri.toString());
    assert.doesNotMatch(explorerHtml(), new RegExp(SHADOW_DOC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assertNotExecuted();
    await screenshot("helper-invalidated");
    await vscode.workspace.fs.writeFile(file("ExampleProject/helpers.py"), Buffer.from(HELPER));
  });
});

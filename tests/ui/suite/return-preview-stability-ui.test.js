"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fields = prefix => Array.from({ length: 35 }, (_, i) => `    ${prefix}_field_${i}: str`).join("\n");
const PYTHON = `from dataclasses import dataclass
from robot.api.deco import keyword
@dataclass
class First:
${fields("first")}
@dataclass
class Second:
${fields("second")}
@keyword("Build First")
def build_first() -> First:
    return None
@keyword("Build Second")
def build_second() -> Second:
    return None
raise RuntimeError("This source-only fixture must never be imported")
`;
const ROBOT = "*** Settings ***\nLibrary    StableLibrary.py\n*** Test Cases ***\nStable Selection\n" +
  "    ${first}=    Build First\n    ${second}=    Build Second\n    Log    ${first}\n    Log    ${second}\n";
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(30); }
  throw new Error(`Timed out: ${label}`);
}
suite("Native Return Explorer selection stability", function () {
  let api, manager, config, directory, document, cdp, root, originalDefinition;
  const evidence = [], releases = [];
  const evidenceDir = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(directory, name);
  const state = () => api.getReturnExplorerSnapshotForTest();
  async function page(expression) {
    const answer = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, cdp.pageSession);
    assert.equal(answer.exceptionDetails, undefined); return answer.result.value;
  }
  async function clickVariable(token) {
    const name = token.slice(2, -1);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, cdp.pageSession);
    let point, prior, since = Date.now();
    await until(async () => {
      point = await page(`(() => {
        const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')].find(e => e.getAttribute('data-uri') === ${JSON.stringify(document.uri.toString())});
        const row = [...(editor?.querySelectorAll('.view-line') || [])].find(e => e.innerText.includes('Log') && e.innerText.includes(${JSON.stringify(token)}));
        if (!row) return;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let node;
        while (node = walker.nextNode()) { const offset = node.textContent.indexOf(${JSON.stringify(name)}); if (offset < 0) continue;
          const r = document.createRange(); r.setStart(node, offset + 1); r.setEnd(node, offset + 3); const b = r.getBoundingClientRect();
          const x = b.x + b.width / 2, y = b.y + b.height / 2;
          if (b.width && row.contains(document.elementFromPoint(x,y))) return {x,y};
        }
      })()`);
      if (!point || !prior || point.x !== prior.x || point.y !== prior.y) since = Date.now();
      prior = point; return point && Date.now() - since >= 300;
    }, `stable hit-tested ${token} token`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
      type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cdp.pageSession);
    const selectedAt = Date.now();
    evidence.push({ action: "actual pointer selection", token, point, selectedAt });
    return selectedAt;
  }
  async function screenshot(name) {
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(data, "base64"));
  }
  suiteSetup(async function () {
    this.timeout(180000);
    assert.ok(process.env.ROBOT_COMPANION_NATIVE_BACKEND, "This suite requires the owned native backend");
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion"); await extension.activate();
    api = activatedExtensionApi(extension.extensionPath); manager = api.getLanguageWorkspaceForTest();
    const folder = vscode.workspace.workspaceFolders[0]; directory = vscode.Uri.joinPath(folder.uri, "stable-preview");
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(file("StableLibrary.py"), Buffer.from(PYTHON));
    await vscode.workspace.fs.writeFile(file("stable.robot"), Buffer.from(ROBOT));
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const { nativeDescriptor } = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    await config.update("languageBackend", JSON.parse(JSON.stringify(nativeDescriptor({ workspaceUri: folder.uri.toString(),
      cwd: folder.uri.fsPath, executable: process.env.ROBOT_COMPANION_NATIVE_BACKEND }))), vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal(config.get("prewarmMode", "allOpen"), "allOpen", "Use the shipped all-open prewarm policy");
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder); await manager.queue;
    root = manager.roots.get(folder.uri.toString()); assert.equal(root.session.state, "running");
    document = await vscode.workspace.openTextDocument(file("stable.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("robotCompanion.returnView.focus");
    await vscode.window.showTextDocument(document, { preview: false });
    cdp = await WebviewCdp.connect();
    await until(() => {
      const prewarm = api.getReturnPrewarmSnapshotForTest(document.uri.toString());
      return prewarm.ready === 2 && typeof prewarm.signature === "string" && prewarm.signature.length > 0;
    }, "both variables and their first-level markup genuinely prewarmed", 60000);
    evidence.push({ prewarm: api.getReturnPrewarmSnapshotForTest(document.uri.toString()), backend: root.session.serverInfo });
  });
  suiteTeardown(async () => {
    for (const release of releases) release();
    if (originalDefinition) manager.definitionIdentity = originalDefinition;
    if (config) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
      await vscode.workspace.fs.delete(directory, { recursive: true });
    }
    if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, "return-preview-stability-actions.json"), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });
  test("cached new target paints before a ten-second native refresh and same-target updating does not reload its webview", async function () {
    this.timeout(90000);
    await clickVariable("${first}");
    await until(() => state().variableToken === "${first}" && state().detailsMarkdown.includes("first_field_0"), "first variable members");
    const gate = deferred(), entered = deferred(); releases.push(gate.resolve);
    const original = manager.definitionIdentity;
    originalDefinition = original;
    manager.definitionIdentity = async function (...args) { entered.resolve(); await gate.promise; return original.apply(this, args); };
    const selectedAt = await clickVariable("${second}"); await entered.promise;
    await until(() => state().variableToken === "${second}" && state().detailsMarkdown.includes("second_field_0"), "cached second variable shown while request pending", 1000);
    assert.doesNotMatch(state().detailsMarkdown, /first_field_/);
    assert.equal(state().refreshState, "refreshing");
    const firstFrame = await cdp.findWebviewFrame("return document.querySelector('.meta')?.innerText.includes('${second}') && document.querySelector('.details')?.innerText.includes('second_field_0');", "cached second-variable Return Explorer", Math.max(1, 1000 - (Date.now() - selectedAt)));
    const paintElapsedMs = Date.now() - selectedAt;
    assert.ok(paintElapsedMs <= 1000, `cached new target painted after ${paintElapsedMs} ms`);
    const painted = JSON.parse(await cdp.evaluate(firstFrame.frameId, "JSON.stringify({ header: document.querySelector('.meta').innerText, details: document.querySelector('.details').innerText })"));
    assert.ok(painted.header.includes("${second}"), "the actual panel header shows the new variable while the native refresh waits");
    assert.match(painted.details, /second_field_0/);
    assert.doesNotMatch(painted.details, /first_field_/);
    evidence.push({ result: "painted cached second variable", paintElapsedMs, header: painted.header, details: painted.details });
    await screenshot("cached-new-target-pending");
    await cdp.evaluate(firstFrame.frameId, "window.__stableDocument = 'same-document'; window.scrollTo(0,100); true");
    // A real right/left key pair changes selection inside the same variable.
    for (const key of ["ArrowRight", "ArrowLeft"]) for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code: key, windowsVirtualKeyCode: key === "ArrowRight" ? 39 : 37 }, cdp.pageSession);
    await sleep(10000);
    const frame = await cdp.findWebviewFrame("return Boolean(document.querySelector('.details') && document.querySelector('.meta'));", "Return Explorer");
    assert.equal(await cdp.evaluate(frame.frameId, "window.__stableDocument"), "same-document");
    assert.ok((await cdp.evaluate(frame.frameId, "window.scrollY")) > 0);
    assert.equal(state().variableToken, "${second}"); assert.match(state().detailsMarkdown, /second_field_0/);
    evidence.push({ result: "ten seconds pending", variable: state().variableToken, refreshState: state().refreshState,
      sameDocument: true, scrollY: await cdp.evaluate(frame.frameId, "window.scrollY") });
    gate.resolve(); manager.definitionIdentity = originalDefinition; originalDefinition = undefined;
    await until(() => state().variableToken === "${second}" && state().refreshState === "ready", "second variable fully refreshed");
    await screenshot("new-target-ready");
  });
});

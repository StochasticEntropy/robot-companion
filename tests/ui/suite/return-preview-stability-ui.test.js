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
const LONG_FIELD = "extremely_long_collection_field_for_horizontal_scroll_in_return_explorer";
const COMPLEX_PYTHON = `from dataclasses import dataclass
from typing import Optional, Union
from robot.api.deco import keyword
@dataclass
class SharedLeaf:
${fields("leaf")}
@dataclass
class SharedBundle:
    ${LONG_FIELD}: list[SharedLeaf]
    mapping: dict[str, SharedLeaf]
    optional_leaf: Optional[SharedLeaf]
    pair: tuple[SharedLeaf, SharedLeaf]
    choice: Union[SharedLeaf, str]
    direct_leaf: SharedLeaf
    label: str
    serial: int
@keyword("Build Complex")
def build_complex() -> SharedBundle:
    """Source-only complex return cache journey."""
    return None
raise RuntimeError("This source-only fixture must never be imported")
`;
const COMPLEX_ROBOT = "*** Settings ***\nLibrary    ComplexLibrary.py\n*** Test Cases ***\nComplex Cache Selection\n" +
  "    ${complex}=    Build Complex\n    ${sibling}=    Build Complex\n    Log    ${complex}\n    Log    ${sibling}\n";
const FIRST_SECTION = `[...document.querySelectorAll('.details > [data-return-section]')].find(node => node.dataset.returnSection === '#### First-level access')`;
const TECHNICAL_SECTION = `[...document.querySelectorAll('.details > [data-return-section]')].find(node => node.dataset.returnSection === '### Technical Details (Developer)')`;
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
  async function clickVariable(token, rowIncludes = "Log", name = token.slice(2, -1)) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, cdp.pageSession);
    if (token.includes(" ")) evidence.push({ action: "keyword pointer lookup", token, rows: await page(`(() => {
      const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')].find(e => e.getAttribute('data-uri') === ${JSON.stringify(document.uri.toString())});
      return [...(editor?.querySelectorAll('.view-line') || [])].map(e => e.innerText);
    })()`) });
    let point, prior, since = Date.now();
    await until(async () => {
      point = await page(`(() => {
        const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')].find(e => e.getAttribute('data-uri') === ${JSON.stringify(document.uri.toString())});
        const row = [...(editor?.querySelectorAll('.view-line') || [])].find(e => {
          const text = e.innerText.replace(/\\u00a0/g, ' ');
          return text.includes(${JSON.stringify(rowIncludes)}) && text.includes(${JSON.stringify(token)});
        });
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
  async function pointerInFrame(frame, expression, label) {
    const point = await cdp.evaluate(frame.frameId, `(() => { const node = ${expression};
      const rect = node?.getBoundingClientRect(); if (!rect?.width || rect.top >= innerHeight || rect.bottom <= 0) return;
      const x = Math.max(2, Math.min(innerWidth - 2, rect.x + rect.width / 2));
      const y = Math.max(2, Math.min(innerHeight - 2, Math.max(rect.top, 0) + Math.min(rect.height, innerHeight - Math.max(rect.top, 0)) / 2));
      const hit = document.elementFromPoint(x, y); return hit && (node === hit || node.contains(hit)) ? { x, y } : undefined;
    })()`);
    assert.ok(point, `actual visible hit-tested ${label}`);
    const origin = await cdp.frameOrigin(frame);
    return { x: origin.pageX + point.x, y: origin.pageY + point.y };
  }
  async function wheelInFrame(frame, expression, deltaX, deltaY, label) {
    const point = await pointerInFrame(frame, expression, label);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY }, cdp.pageSession);
    evidence.push({ action: "actual wheel", label, deltaX, deltaY, point });
    await sleep(100);
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
    await vscode.workspace.fs.writeFile(file("ComplexLibrary.py"), Buffer.from(COMPLEX_PYTHON));
    await vscode.workspace.fs.writeFile(file("complex.robot"), Buffer.from(COMPLEX_ROBOT));
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

  test("complex full details preserve the live view and are reused after keyword navigation and by another variable of the same type", async function () {
    this.timeout(120000);
    document = await vscode.workspace.openTextDocument(file("complex.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    await until(() => {
      const prewarm = api.getReturnPrewarmSnapshotForTest(document.uri.toString());
      return prewarm.ready === 2 && prewarm.signature.length > 0;
    }, "both complex variables first-level prewarmed", 60000);
    const worker = api.getReturnComputeWorkerForTest();
    assert.ok(worker && typeof worker._postRequest === "function", "observe the real return worker");
    const requests = [], post = worker._postRequest;
    worker._postRequest = async function (type, payload) {
      const result = await post.call(this, type, payload);
      requests.push({ type, variableToken: payload?.payload?.variableToken,
        includeTechnical: payload?.payload?.includeTechnical, cacheWrite: Boolean(result?.cacheWrite),
        technicalLines: result?.technicalStructureLines?.length || 0 });
      return result;
    };
    const original = manager.definitionIdentity;
    const gate = deferred(), entered = deferred(); releases.push(gate.resolve);
    originalDefinition = original;
    manager.definitionIdentity = async function (...args) { entered.resolve(); await gate.promise; return original.apply(this, args); };
    try {
      const selectedAt = await clickVariable("${complex}"); await entered.promise;
      const frame = await cdp.findWebviewFrame(`return document.querySelector('.meta')?.innerText.includes('$' + '{complex}') && document.querySelector('.details')?.innerText.includes(${JSON.stringify(LONG_FIELD)});`, "complex first-level view", 1000);
      assert.ok(Date.now() - selectedAt <= 1000, "cached complex first-level view is immediate");
      assert.equal(state().hasFullReturnDetails, false);
      await wheelInFrame(frame, `(${FIRST_SECTION}).querySelector('pre')`, 180, 0, "first-level horizontal code scroll");
      assert.ok(await cdp.evaluate(frame.frameId, `(${FIRST_SECTION}).querySelector('pre').scrollLeft > 0`));
      // Scroll with real input until the genuine technical disclosure is visible.
      for (let turn = 0; turn < 12; turn++) {
        if (await cdp.evaluate(frame.frameId, `(() => { const r = (${TECHNICAL_SECTION})?.querySelector('summary')?.getBoundingClientRect(); return Boolean(r && r.top >= 0 && r.bottom < innerHeight); })()`)) break;
        await wheelInFrame(frame, "document.body", 0, 160, "technical disclosure into view");
      }
      const summaryPoint = await pointerInFrame(frame, `(${TECHNICAL_SECTION}).querySelector('summary')`, "technical disclosure");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
        type, ...summaryPoint, ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 })
      }, cdp.pageSession);
      await until(() => cdp.evaluate(frame.frameId, `(${TECHNICAL_SECTION}).querySelector('details').open`), "technical disclosure opened by pointer");
      const before = await cdp.evaluate(frame.frameId, `(() => {
        const first = ${FIRST_SECTION}, technical = ${TECHNICAL_SECTION};
        window.__complexView = { document, first, anchor: first.querySelector('h4'), pre: first.querySelector('pre'),
          focusLabel: document.activeElement.textContent, focusTag: document.activeElement.tagName,
          anchorTop: first.querySelector('h4').getBoundingClientRect().top, scrollY, scrollLeft: first.querySelector('pre').scrollLeft };
        return { scrollY, scrollLeft: window.__complexView.scrollLeft, anchorTop: window.__complexView.anchorTop,
          focusTag: window.__complexView.focusTag, focusLabel: window.__complexView.focusLabel,
          focusSection: document.activeElement.closest('[data-return-section]')?.dataset.returnSection,
          open: technical.querySelector('details').open };
      })()`);
      assert.ok(before.scrollY > 0 && before.scrollLeft > 0 && before.open);
      assert.equal(before.focusTag, "SUMMARY", "the real disclosure keeps keyboard focus");
      assert.equal(before.focusSection, "### Technical Details (Developer)");
      await sleep(10000);
      assert.equal(state().hasFullReturnDetails, false, "native revalidation is genuinely held");
      gate.resolve(); manager.definitionIdentity = original; originalDefinition = undefined;
      await until(() => state().hasFullReturnDetails && state().refreshState === "ready", "full complex details computed");
      await until(() => cdp.evaluate(frame.frameId, `(${TECHNICAL_SECTION}).querySelector('pre')?.textContent.includes('leaf_field_0')`), "actual deep technical structure painted");
      const after = await cdp.evaluate(frame.frameId, `(() => { const saved = window.__complexView, first = ${FIRST_SECTION}, technical = ${TECHNICAL_SECTION};
        return { sameDocument: saved?.document === document, sameFirstNode: saved?.first === first,
          sameAnchorNode: saved?.anchor === first.querySelector('h4'), samePreNode: saved?.pre === first.querySelector('pre'),
          anchorTop: first.querySelector('h4').getBoundingClientRect().top, scrollY, scrollLeft: first.querySelector('pre').scrollLeft,
          open: technical.querySelector('details').open, focusTag: document.activeElement.tagName,
          focusLabel: document.activeElement.textContent,
          focusSection: document.activeElement.closest('[data-return-section]')?.dataset.returnSection };
      })()`);
      evidence.push({ observation: "complex full-detail arrival", before, after, requests: requests.slice() });
      await screenshot("complex-full-arrival-observation");
      assert.ok(after.sameDocument && after.sameFirstNode && after.sameAnchorNode && after.samePreNode);
      assert.ok(after.open); assert.equal(after.focusTag, before.focusTag);
      assert.equal(after.focusLabel, before.focusLabel); assert.equal(after.focusSection, before.focusSection);
      assert.equal(after.scrollY, before.scrollY); assert.equal(after.scrollLeft, before.scrollLeft);
      assert.ok(Math.abs(after.anchorTop - before.anchorTop) <= 1, "first-level semantic anchor does not jump after full detail arrival");
      evidence.push({ result: "complex full details preserve view", before, after, requests: requests.slice() });
      await screenshot("complex-full-preserved");

      await clickVariable("Build Complex", "${complex}=", "Build");
      await until(() => state().contextKind === "keyword-doc" && state().keywordName === "Build Complex", "actual keyword navigation");
      const revisit = deferred(), revisitEntered = deferred(); releases.push(revisit.resolve);
      originalDefinition = original;
      manager.definitionIdentity = async function (...args) { revisitEntered.resolve(); await revisit.promise; return original.apply(this, args); };
      const revisitAt = await clickVariable("${complex}"); await revisitEntered.promise;
      const revisitedFrame = await cdp.findWebviewFrame(`return document.querySelector('.meta')?.innerText.includes('$' + '{complex}') && (${TECHNICAL_SECTION})?.querySelector('pre')?.textContent.includes('leaf_field_0');`, "immediate cached full complex view", 1000);
      assert.ok(Date.now() - revisitAt <= 1000);
      assert.equal(state().refreshState, "refreshing"); assert.equal(state().hasFullReturnDetails, true);
      const revisitStatus = await cdp.evaluate(revisitedFrame.frameId, "document.querySelector('#return-preview-status').textContent");
      assert.match(revisitStatus, /updat|checking current source/i);
      assert.doesNotMatch(await cdp.evaluate(revisitedFrame.frameId, "document.querySelector('.details').innerText"), /Loading technical details|No return structure selected/);
      evidence.push({ result: "cached full view after keyword navigation", elapsedMs: Date.now() - revisitAt, status: revisitStatus });
      revisit.resolve(); manager.definitionIdentity = original; originalDefinition = undefined;
      await until(() => state().refreshState === "ready", "cached full selection revalidated");

      const siblingStart = requests.length;
      await clickVariable("${sibling}");
      await until(() => state().variableToken === "${sibling}" && state().hasFullReturnDetails && state().refreshState === "ready", "same-type sibling full preview");
      const siblingRequests = requests.slice(siblingStart).filter(request => request.type === "computeReturnPreview" && request.variableToken === "${sibling}");
      assert.ok(siblingRequests.some(request => request.technicalLines > 0), "real worker returns the already warm technical shape for another variable");
      assert.ok(siblingRequests.every(request => !request.cacheWrite), "another variable of the same type does not rebuild the deep type cache");
      assert.equal(requests.filter(request => request.type === "setWorkspaceIndex").length, 0, "unchanged navigation does not repost the workspace index");
      evidence.push({ result: "same return type warm worker reuse", siblingRequests, requests });
      await screenshot("complex-same-type-sibling");
    } finally {
      gate.resolve(); for (const release of releases) release();
      manager.definitionIdentity = original; originalDefinition = undefined; worker._postRequest = post;
    }
  });
});

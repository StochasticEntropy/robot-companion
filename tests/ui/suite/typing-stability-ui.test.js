"use strict";

// Actual typing and rendered-frame evidence, not synthetic document edits.
// Delaying only inlay replies exposes the retained-cache path deterministically.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const COLLECT_DOC = "Collect one synthetic example while its continuation is edited.";
const ANCHOR_DOC = "Keep an independent synthetic anchor visible.";
const HEADER = "    ${record}=    Collect Example    initial";
const CONTINUATION = "    ...    2";
const BEFORE = "    Keep Anchor    before";
const AFTER = "    Keep Anchor    after";
const ROBOT = ["*** Settings ***", "Library    TypingLibrary.py", "", "*** Test Cases ***", "Typing Stability",
  BEFORE, HEADER, CONTINUATION, AFTER, ""].join("\n");
const PYTHON = ["from robot.api.deco import keyword", "from pathlib import Path", "",
  "@keyword('Collect Example')", "def collect_example(item: str, count: int = 1, antwort: str = '') -> str:",
  `    \"\"\"${COLLECT_DOC}`, "", "    Args:", "        item: The original example value.",
  "        count: The existing continuation argument.", "        antwort: The newly typed named argument.", "    \"\"\"", "    return item", "",
  "@keyword('Keep Anchor')", "def keep_anchor(value: str):", `    \"\"\"${ANCHOR_DOC}\"\"\"`, "    return value", "",
  "Path(__file__).with_name('module-executed.txt').write_text('executed', encoding='utf-8')", ""].join("\n");
const ROWS = `(() => {
  const editor = [...document.querySelectorAll('.editor-group-container.active .editor-instance .monaco-editor')]
    .find(e => e.getClientRects().length && e.getBoundingClientRect().width > 0);
  return [...(editor?.querySelectorAll('.lines-content .view-line') || [])].map(line => {
    let source = ''; const hints = [];
    for (const span of line.querySelectorAll(':scope > span > span')) {
      const text = span.textContent.replaceAll('\\u00a0', ' ');
      if (/\\bdyn-rule-/.test(span.className)) {
        const rect = span.getBoundingClientRect(), style = getComputedStyle(span);
        hints.push({label: text, color: style.color, background: style.backgroundColor,
          rendered: rect.width > 0 && rect.height > 0});
      } else source += text;
    }
    return {source, hints, top: line.getBoundingClientRect().top};
  }).filter(line => line.top >= 0 && line.top < innerHeight);
})()`;
async function until(predicate, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return; await sleep(40); }
  throw Error(`Timed out: ${label}`);
}

suite("Native typing stability: retained inlays and logical keyword context", function () {
  let api, manager, root, config, directory, document, cdp, frame, originalRequest, releaseInlays;
  let initialInlaySetting, explorerListener, explorerContext;
  const explorerSamples = [];
  let explorerOverflow = false;
  const evidence = [];
  const evidenceDir = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const uri = name => vscode.Uri.joinPath(directory, name);
  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDir) return;
    const {data} = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDir, `typing-stability-${name}.png`), Buffer.from(data, "base64"));
  }
  function contextEvidence() {
    const view = api?.getReturnExplorerSnapshotForTest();
    return {at: Date.now(), contextKind: view?.contextKind, keywordName: view?.keywordName,
      variableToken: view?.variableToken, hasKeywordDoc: Boolean(view?.detailsMarkdown?.includes(COLLECT_DOC)),
      originalFrameAvailable: frame ? cdp.contexts.has(frame.frameId) : undefined};
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers,
      ...(type === "keyDown" && key === "Enter" ? {text: "\r"} : {})
    }, cdp.pageSession);
    evidence.push({action: "actual key", key, modifiers, version: document.version, context: contextEvidence()});
  }
  async function type(text) {
    await cdp.send("Input.insertText", {text}, cdp.pageSession);
    evidence.push({action: "actual input", text, version: document.version, context: contextEvidence()});
  }
  async function frames(count = 2) {
    await page(`new Promise(resolve => { let left = ${count}; const tick = () => --left <= 0 ? resolve(true) : requestAnimationFrame(tick); requestAnimationFrame(tick); })`);
  }
  async function clickText(source, token) {
    await key("Escape", "Escape", 27);
    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5}, cdp.pageSession);
    let point, previous, stableSince = Date.now();
    const locate = () => page(`(() => {
      const editor = [...document.querySelectorAll('.editor-group-container.active .editor-instance .monaco-editor')]
        .find(e => e.getClientRects().length && e.getBoundingClientRect().width > 0);
      const row = [...(editor?.querySelectorAll('.view-line') || [])].find(row => {
        const spans = [...row.querySelectorAll(':scope > span > span')].filter(s => !/\\bdyn-rule-/.test(s.className));
        return spans.map(s => s.textContent.replaceAll('\\u00a0', ' ')).join('') === ${JSON.stringify(source)};
      });
      if (!row) return;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        if (node.parentElement?.closest('[class*="dyn-rule-"]')) continue;
        const offset = node.textContent.indexOf(${JSON.stringify(token)}); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset + 1); range.setEnd(node, offset + 2);
        const r = range.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (r.width && row.contains(document.elementFromPoint(x, y))) return {x, y};
      }
    })()`);
    await until(async () => {
      point = await locate();
      if (!point || !previous || point.x !== previous.x || point.y !== previous.y) stableSince = Date.now();
      previous = point; return point && Date.now() - stableSince >= 400;
    }, `stable actual keyword target ${token}`);
    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...point}, cdp.pageSession);
    assert.deepEqual(await locate(), point, "hit target remains exact immediately before press");
    for (const event of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
      type: event, ...point, button: "left", buttons: event === "mousePressed" ? 1 : 0, clickCount: 1
    }, cdp.pageSession);
    const line = document.getText().split("\n").indexOf(source);
    await until(() => vscode.window.activeTextEditor?.document === document &&
      vscode.window.activeTextEditor.selection.active.line === line, "actual pointer selects intended call");
    evidence.push({action: "actual pointer", token, source, point, line});
  }
  async function stopTraces() {
    const editor = await page(`(() => {const t=window.__typingInlayTrace;if(!t)return; t.active=false;return t;})()`);
    const currentContext = frame && cdp.contexts.get(frame.frameId);
    const frameRetained = Boolean(currentContext && explorerContext &&
      currentContext.contextId === explorerContext.contextId && currentContext.sessionId === explorerContext.sessionId);
    if (frameRetained) await cdp.evaluate(frame.frameId,
      `(() => {const t=window.__typingExplorerTrace;if(t)t.active=false;return true;})()`);
    if (explorerListener) {cdp.socket.removeEventListener("message", explorerListener); explorerListener = undefined;}
    const explorer = {samples: explorerSamples.slice(), overflow: explorerOverflow, originalFrameRetained: frameRetained};
    if (evidenceDir) {
      fs.writeFileSync(path.join(evidenceDir, "typing-stability-editor-frames.json"), JSON.stringify(editor, null, 2));
      fs.writeFileSync(path.join(evidenceDir, "typing-stability-explorer-frames.json"), JSON.stringify(explorer, null, 2));
    }
    return {editor, explorer};
  }

  suiteSetup(async function () {
    this.timeout(180000);
    assert.ok(process.env.ROBOT_COMPANION_NATIVE_BACKEND, "required owned native backend");
    if (evidenceDir) fs.mkdirSync(evidenceDir, {recursive: true});
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion"); await extension.activate();
    api = activatedExtensionApi(extension.extensionPath); manager = api.getLanguageWorkspaceForTest();
    const folder = vscode.workspace.workspaceFolders[0]; directory = vscode.Uri.joinPath(folder.uri, "typing-stability");
    await vscode.workspace.fs.createDirectory(directory);
    for (const [name, text] of [["TypingLibrary.py", PYTHON], ["typing.robot", ROBOT]])
      await vscode.workspace.fs.writeFile(uri(name), Buffer.from(text));
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    initialInlaySetting = vscode.workspace.getConfiguration("editor").inspect("inlayHints.enabled").globalValue;
    await vscode.workspace.getConfiguration("editor").update("inlayHints.enabled", "on", vscode.ConfigurationTarget.Global);
    const {nativeDescriptor} = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    await config.update("languageBackend", JSON.parse(JSON.stringify(nativeDescriptor({workspaceUri: folder.uri.toString(),
      cwd: folder.uri.fsPath, executable: process.env.ROBOT_COMPANION_NATIVE_BACKEND}))), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder); await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "native language backend running", 60000);
    root = manager.roots.get(folder.uri.toString()); assert.equal(root.session.serverInfo.name, "robot-companion-backend");
    cdp = await WebviewCdp.connect();
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("robotCompanion.returnView.focus");
    document = await vscode.workspace.openTextDocument(uri("typing.robot"));
    await vscode.window.showTextDocument(document, {preview: false});
    evidence.push({setup: "synthetic source-only fixture; actual native editor", backend: {...root.session.serverInfo},
      viewport: await page("({width: innerWidth, height: innerHeight})")});
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await screenshot("failed");
      await stopTraces().catch(error => evidence.push({traceReadError: error.message}));
      evidence.push({failure: this.currentTest.title, document: document.getText(),
        selection: vscode.window.activeTextEditor?.selection.active, view: api.getReturnExplorerSnapshotForTest()});
    }
  });
  suiteTeardown(async () => {
    releaseInlays?.();
    if (root && originalRequest) root.session.request = originalRequest;
    try {
      if (directory) assert.equal(fs.existsSync(uri("module-executed.txt").fsPath), false, "fixture was never imported");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      if (config) {
        const child = root?.session?.child;
        await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
        await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder); await manager.queue;
        if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "owned native process cleanup");
        await vscode.workspace.fs.delete(directory, {recursive: true});
        evidence.push({cleanup: "native stopped, synthetic fixture removed", exitCode: child?.exitCode, signal: child?.signalCode});
      }
      await vscode.workspace.getConfiguration("editor").update("inlayHints.enabled", initialInlaySetting, vscode.ConfigurationTarget.Global);
    } finally {
      if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, "typing-stability-actions.json"), JSON.stringify(evidence, null, 2));
      cdp?.close();
    }
  });

  test("every sampled rendered frame retains unrelated and prior-call hints while blank/partial continuations preserve the same Explorer document", async function () {
    this.timeout(120000);
    await clickText(HEADER, "Collect");
    const sources = [BEFORE, HEADER, CONTINUATION, AFTER];
    await until(async () => {
      const rows = await page(ROWS);
      return sources.every(source => rows.find(r => r.source === source)?.hints.some(h => h.rendered));
    }, "all unrelated and prior-call baseline hints painted");
    const baseline = (await page(ROWS)).filter(row => sources.includes(row.source));
    assert.deepEqual(baseline.find(row => row.source === BEFORE).hints.map(h => h.label), ["value="]);
    assert.deepEqual(baseline.find(row => row.source === AFTER).hints.map(h => h.label), ["value="]);
    assert.ok(baseline.find(row => row.source === HEADER).hints.some(h => h.label === "item="));
    assert.ok(baseline.find(row => row.source === HEADER).hints.some(h => h.label === ": str"));
    assert.ok(baseline.find(row => row.source === CONTINUATION).hints.some(h => h.label === "count="));
    frame = await cdp.findWebviewFrame(`return document.querySelector('.meta')?.textContent.includes('Collect Example') &&
      document.querySelector('.details')?.textContent.includes(${JSON.stringify(COLLECT_DOC)});`, "logical call keyword docs");
    await key("ArrowDown", "ArrowDown", 40); await key("End", "End", 35);
    assert.equal(vscode.window.activeTextEditor.selection.active.line, ROBOT.split("\n").indexOf(CONTINUATION));
    const expected = baseline.map(row => ({source: row.source, labels: row.hints.map(h => h.label)}));
    await page(`(() => {
      const expected=${JSON.stringify(expected)}, read=()=>${ROWS};
      const trace=window.__typingInlayTrace={active:true,expected,samples:[],overflow:false};
      const sample=()=>{if(!trace.active)return;const rows=read();
        if(trace.samples.length>=6000){trace.overflow=true;trace.active=false;return;}
        trace.samples.push({t:performance.now(),anchors:expected.map(e=>{const row=rows.find(r=>r.source===e.source);
          return {source:e.source,found:Boolean(row),labels:row?.hints.filter(h=>h.rendered).map(h=>h.label)||[]};})});
        requestAnimationFrame(sample);};requestAnimationFrame(sample);return true;
    })()`);
    explorerListener = event => {
      const message = JSON.parse(event.data);
      if (message.method !== "Runtime.bindingCalled" || message.params?.name !== "__typingStabilitySample") return;
      if (explorerSamples.length >= 6000) {explorerOverflow = true;return;}
      explorerSamples.push(JSON.parse(message.params.payload));
    };
    cdp.socket.addEventListener("message", explorerListener);
    explorerContext = {...cdp.contexts.get(frame.frameId)};
    await cdp.send("Runtime.addBinding", {name: "__typingStabilitySample", executionContextId: explorerContext.contextId}, explorerContext.sessionId);
    await cdp.evaluate(frame.frameId, `(() => {
      const originalDocument=document,originalBody=document.querySelector('.details');
      const trace=window.__typingExplorerTrace={active:true,samples:[],overflow:false};
      const sample=()=>{if(!trace.active)return;if(trace.samples.length>=6000){trace.overflow=true;trace.active=false;return;}
        const body=document.querySelector('.details'),header=document.querySelector('.meta')?.textContent||'';
        const entry={t:performance.now(),at:Date.now(),sameDocument:document===originalDocument,sameBody:body===originalBody,
          bodyConnected:Boolean(body?.isConnected),hasDocumentation:Boolean(body?.textContent.includes(${JSON.stringify(COLLECT_DOC)})),
          correctKeyword:header.includes('Collect Example'),bodyLength:body?.textContent.length||0};
        trace.samples.push(entry);window.__typingStabilitySample(JSON.stringify(entry));
        requestAnimationFrame(sample);};requestAnimationFrame(sample);return true;
    })()`);
    let held = 0; const pending = new Promise(resolve => {releaseInlays = resolve;}); originalRequest = root.session.request;
    root.session.request = async function (method, ...args) {
      if (method === "textDocument/inlayHint") {held++; await pending;}
      return originalRequest.call(this, method, ...args);
    };
    try {
      await key("Enter", "Enter", 13); await frames(3);
      for (const character of "...    antw") {await type(character); await frames(2);}
      for (let i=0;i<4;i++) {await key("Backspace", "Backspace", 8); await frames(2);}
      for (const character of "antw") await type(character);
      await key("Backspace", "Backspace", 8); await key("Backspace", "Backspace", 8);
      for (const character of "tw") await type(character);
      await until(() => held > 0, "native inlay transport is genuinely pending");
      await frames(12);
      await until(() => {
        const view = api.getReturnExplorerSnapshotForTest();
        return view.contextKind === "keyword-doc" && view.keywordName === "Collect Example" && view.refreshState === "ready";
      }, "same-call documentation finishes its fresh native refresh before frame capture stops");
      await frames(2);
      const traces = await stopTraces();
      assert.ok(traces.editor?.samples.length >= 15 && traces.explorer?.samples.length >= 15, "both real renderers sampled throughout typing");
      assert.equal(traces.editor.overflow, false); assert.equal(traces.explorer.overflow, false);
      assert.equal(traces.explorer.originalFrameRetained, true, "same logical keyword keeps the actual Explorer document");
      for (const sample of traces.editor.samples) for (const target of traces.editor.expected) {
        const anchor = sample.anchors.find(a => a.source === target.source);
        assert.ok(anchor.found, `unchanged anchor remains rendered at ${sample.t}: ${target.source}`);
        assert.deepEqual(anchor.labels, target.labels, `painted hints retained on every sampled frame at ${sample.t}: ${target.source}`);
      }
      for (const sample of traces.explorer.samples) {
        assert.ok(sample.sameDocument && sample.sameBody && sample.bodyConnected && sample.hasDocumentation &&
          sample.correctKeyword && sample.bodyLength > 0, `same logical call documentation retained at ${sample.t}: ${JSON.stringify(sample)}`);
      }
      evidence.push({result: "per-render-frame typing stability", editorFrames: traces.editor.samples.length,
        explorerFrames: traces.explorer.samples.length, heldNativeInlayRequests: held, baseline,
        finalDocument: document.getText(), explorer: api.getReturnExplorerSnapshotForTest()});
      await screenshot("continuation-pending");
    } finally {
      releaseInlays(); root.session.request = originalRequest;
      await Promise.allSettled([...(root.inlayPending?.values() || [])].map(item => item.promise));
    }
    // Completing a real named argument is a new target, not a partial keyword
    // continuation: its type/value view must replace keyword documentation.
    await type("ort=sample");
    await until(() => {
      const view=api.getReturnExplorerSnapshotForTest();
      return view.contextKind === "enum" && view.variableToken === "antwort" && view.keywordName === "Collect Example" &&
        view.detailsMarkdown.includes("sample");
    }, "complete named argument selects its real type/value context");
    evidence.push({result: "real named argument target", context: contextEvidence()});
    // A genuinely new call must replace the retained context; retaining old docs
    // is permitted only for the same logical continuation, not another keyword.
    await key("Escape", "Escape", 27); await key("Home", "Home", 36); await key("Home", "Home", 36);
    assert.equal(vscode.window.activeTextEditor.selection.active.character, 0);
    await key("End", "End", 35, 8); await type("    Keep Anchor    replacement");
    await until(() => api.getReturnExplorerSnapshotForTest().detailsMarkdown.includes(ANCHOR_DOC) &&
      !api.getReturnExplorerSnapshotForTest().detailsMarkdown.includes(COLLECT_DOC), "genuine new keyword replaces retained logical context");
    const changed = await cdp.findWebviewFrame(`return document.querySelector('.meta')?.textContent.includes('Keep Anchor') &&
      document.querySelector('.details')?.textContent.includes(${JSON.stringify(ANCHOR_DOC)});`, "new keyword documentation");
    assert.ok(changed); await screenshot("new-call");

    // A genuinely new keyword prefix clears the old documentation once, then
    // updates its visible header without reloading the loading document per key.
    await until(() => api.getReturnExplorerSnapshotForTest().refreshState === "ready", "new call finishes before prefix typing");
    let releaseDefinitions, heldDefinitions = 0, pendingFrame, pendingListener;
    const pendingDefinitions = new Promise(resolve => {releaseDefinitions = resolve;});
    const requestBeforePrefix = root.session.request;
    root.session.request = async function (method, ...args) {
      if (method === "textDocument/definition") {heldDefinitions++; await pendingDefinitions;}
      return requestBeforePrefix.call(this, method, ...args);
    };
    const pendingSamples = [], prefixReadbacks = [];
    let pendingOverflow = false;
    try {
      await key("Home", "Home", 36); await key("Home", "Home", 36);
      assert.equal(vscode.window.activeTextEditor.selection.active.character, 0);
      await key("End", "End", 35, 8); await type("    C");
      pendingFrame = await cdp.findWebviewFrame(`return [...document.querySelectorAll('.meta-row')].some(row =>
        row.textContent.trim() === 'Keyword: C') && document.querySelector('.details')?.textContent.includes('Loading details');`,
      "first genuinely new keyword loading document");
      const initialHtml = api.getReturnExplorerWebviewHtmlForTest();
      pendingListener = event => {
        const message = JSON.parse(event.data);
        if (message.method === "Runtime.bindingCalled" && message.params?.name === "__typingPrefixSample") {
          if (pendingSamples.length >= 6000) pendingOverflow = true;
          else pendingSamples.push(JSON.parse(message.params.payload));
        }
      };
      cdp.socket.addEventListener("message", pendingListener);
      const pendingContext = cdp.contexts.get(pendingFrame.frameId);
      const samePendingContext = () => {
        const current = cdp.contexts.get(pendingFrame.frameId);
        return current?.contextId === pendingContext.contextId && current?.sessionId === pendingContext.sessionId;
      };
      await cdp.send("Runtime.addBinding", {name: "__typingPrefixSample", executionContextId: pendingContext.contextId}, pendingContext.sessionId);
      await cdp.evaluate(pendingFrame.frameId, `(() => {
        const originalBody=document.querySelector('.details');window.__typingPrefixActive=true;
        const sample=()=>{if(!window.__typingPrefixActive)return;const body=document.querySelector('.details');
          window.__typingPrefixSample(JSON.stringify({t:performance.now(),sameBody:body===originalBody,
            bodyConnected:Boolean(body?.isConnected),bodyLength:body?.textContent.length||0,
            hasOldDoc:Boolean(body?.textContent.includes(${JSON.stringify(COLLECT_DOC)})||body?.textContent.includes(${JSON.stringify(ANCHOR_DOC)})),
            header:[...document.querySelectorAll('.meta-row')].find(row=>row.querySelector('.meta-label')?.textContent==='Keyword:')?.textContent.trim()}));
          requestAnimationFrame(sample);};requestAnimationFrame(sample);return true;
      })()`);
      let prefix = "C";
      for (const character of "ollect E") {
        prefix += character; await type(character);
        const keywordName = prefix.trimEnd();
        await until(async () => {
          assert.ok(samePendingContext(), "new keyword prefixes keep the same actual loading execution context");
          const readback = await cdp.evaluate(pendingFrame.frameId, `(() => ({
            keyword:[...document.querySelectorAll('.meta-row')].find(row=>row.querySelector('.meta-label')?.textContent==='Keyword:')?.textContent.trim(),
            body:document.querySelector('.details')?.textContent||''}))()`);
          return readback.keyword === `Keyword: ${keywordName}`;
        }, `visible loading header follows actual prefix ${prefix}`);
        const view = api.getReturnExplorerSnapshotForTest();
        assert.equal(view.keywordName, keywordName); assert.equal(view.refreshState, "loading");
        assert.equal(api.getReturnExplorerWebviewHtmlForTest(), initialHtml, "typing a prefix does not assign whole webview HTML again");
        prefixReadbacks.push({prefix, keywordName, at: Date.now(), refreshState: view.refreshState});
        await frames(2);
      }
      await until(() => heldDefinitions > 0, "native definition request genuinely pending for new prefix");
      await frames(6);
      await cdp.evaluate(pendingFrame.frameId, "window.__typingPrefixActive=false;true");
      assert.ok(samePendingContext(), "same prefix loading execution context retained through pending definition");
      assert.ok(pendingSamples.length >= 15, "actual loading renderer sampled across typed prefix");
      assert.equal(pendingOverflow, false, "prefix frame capture remained bounded and complete");
      const allowedHeaders = new Set(["Keyword: C", ...prefixReadbacks.map(item => `Keyword: ${item.keywordName}`)]);
      for (const sample of pendingSamples) assert.ok(sample.sameBody && sample.bodyConnected && sample.bodyLength > 0 &&
        !sample.hasOldDoc && allowedHeaders.has(sample.header), `truthful stable loading frame: ${JSON.stringify(sample)}`);
      evidence.push({result: "genuine new keyword prefix keeps one loading document", heldDefinitions,
        sampledFrames: pendingSamples.length, wholeHtmlAssignmentsAfterInitial: 0, prefixReadbacks});
      await screenshot("new-prefix-pending");
    } finally {
      if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, "typing-stability-prefix-frames.json"),
        JSON.stringify({samples: pendingSamples, overflow: pendingOverflow, prefixReadbacks}, null, 2));
      if (pendingFrame && cdp.contexts.has(pendingFrame.frameId))
        await cdp.evaluate(pendingFrame.frameId, "window.__typingPrefixActive=false;true");
      if (pendingListener) cdp.socket.removeEventListener("message", pendingListener);
      releaseDefinitions(); root.session.request = requestBeforePrefix;
    }
    await type("xample    new");
    await until(() => {
      const view=api.getReturnExplorerSnapshotForTest();
      return view.keywordName === "Collect Example" && view.refreshState === "ready" && view.detailsMarkdown.includes(COLLECT_DOC);
    }, "completed new keyword receives its own fresh resolved documentation");
  });
});

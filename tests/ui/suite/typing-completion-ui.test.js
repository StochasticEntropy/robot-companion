"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEYWORD = "BAVL Antworten Kinder";
const PYTHON = `from robot.api.deco import keyword
@keyword("BAVL Antworten Kinder")
def antworten_kinder(antwortKinder="", antwortEltern=""):
    return None
@keyword("BAVL Antworten Eltern")
def antworten_eltern(antwortEltern=""):
    return None
raise RuntimeError("This source-only completion fixture must never be imported")
`;
const ROBOT = "*** Settings ***\nLibrary    TypingLibrary.py\n*** Test Cases ***\nTyping Journey\n" +
  "    No Operation    prefix-marker\n    BAVL Antworten Kinder\n    BAVL Antworten Kinder\n" +
  "    BAVL Antworten Kinder\n    ...    \n    No Operation    continuation-marker\n" +
  "    BAVL Antworten Kinder\n    ...    \n    No Operation    override-marker\n";
async function until(predicate, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(30); }
  throw new Error(`Timed out: ${label}`);
}
suite("Automatic Robot completion during real typing", function () {
  let api, manager, folder, directory, document, cdp, root, nativeRequest;
  let editorConfig, languageConfig, slowSpace;
  const evidence = [], requests = [];
  const evidenceDir = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(directory, name);
  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined); return result.result.value;
  }
  const rows = () => page(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].map(row => row.textContent)`);
  async function screenshot(name) {
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(data, "base64"));
  }
  async function key(name, code, virtualKeyCode, text) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key: name, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
      ...(type === "keyDown" && text !== undefined ? { text, unmodifiedText: text } : {})
    }, cdp.pageSession);
    evidence.push({ action: "actual key", key: name, text, at: Date.now() });
  }
  async function letters(text) {
    for (const character of text) {
      await key(character, character === " " ? "Space" : `Key${character.toUpperCase()}`,
        character === " " ? 32 : character.toUpperCase().charCodeAt(0), character);
      await sleep(35);
    }
  }
  async function acceptSuggestion(label) {
    assert.ok((await rows()).length > 0, `The real widget must remain open before accepting ${label}`);
    for (let index = 0; index < 30; index++) {
      const focused = await page(`document.querySelector('.suggest-widget.visible .monaco-list-row.focused')?.textContent`);
      if (focused?.includes(label)) { await key("Enter", "Enter", 13, "\r"); return; }
      await key("ArrowDown", "ArrowDown", 40);
    }
    assert.fail(`No real widget selection for ${label}`);
  }
  async function clickLine(lineNumber, token) {
    await key("Escape", "Escape", 27);
    const locate = () => page(`(() => {
      const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')].find(e => e.getAttribute('data-uri') === ${JSON.stringify(document.uri.toString())});
      const wanted = ${JSON.stringify(document.lineAt(lineNumber).text)};
      const row = [...(editor?.querySelectorAll('.view-line') || [])].find(e => e.innerText.replace(/\\u00a0/g, ' ') === wanted);
      if (!row) return;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        const offset = node.textContent.indexOf(${JSON.stringify(token)}); if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset + 1); range.setEnd(node, offset + 2);
        const r = range.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (r.width && row.contains(document.elementFromPoint(x, y))) return { x, y };
      }
    })()`);
    let point, previous, stableSince = Date.now();
    await until(async () => {
      point = await locate();
      if (!point || !previous || point.x !== previous.x || point.y !== previous.y) stableSince = Date.now();
      previous = point; if (!point || Date.now() - stableSince <= 300) return false;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
      await sleep(150);
      const settled = await locate();
      if (!settled || point.x !== settled.x || point.y !== settled.y) { stableSince = Date.now(); return false; }
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
        type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1
      }, cdp.pageSession);
      await sleep(50);
      const selected = vscode.window.activeTextEditor?.document === document && vscode.window.activeTextEditor.selection.active.line === lineNumber;
      evidence.push({ action: "actual pointer readback", lineNumber, point, selected, selection: vscode.window.activeTextEditor?.selection.active });
      return selected;
    }, `settled actual pointer row ${lineNumber + 1}`);
    await key("End", "End", 35);
  }
  async function observe(label, action) {
    const start = requests.length;
    try { await action(); }
    catch (error) {
      evidence.push({ failure: label, error: String(error), text: document.getText(), selection: vscode.window.activeTextEditor.selection.active,
        widget: await rows(), requests: requests.slice(start), effective: vscode.workspace.getConfiguration("editor", document).get("quickSuggestions") });
      await screenshot(`${label}-failure`); throw error;
    } finally { evidence.push({ case: label, requests: requests.slice(start) }); }
  }
  suiteSetup(async function () {
    this.timeout(120000);
    assert.ok(process.env.ROBOT_COMPANION_NATIVE_BACKEND);
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion"); await extension.activate();
    api = activatedExtensionApi(extension.extensionPath); manager = api.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0]; directory = vscode.Uri.joinPath(folder.uri, "typing-completion");
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(file("TypingLibrary.py"), Buffer.from(PYTHON));
    await vscode.workspace.fs.writeFile(file("typing.robot"), Buffer.from(ROBOT));
    await vscode.workspace.fs.writeFile(file("other.robot"), Buffer.from("*** Test Cases ***\nOther Editor\n    Log    other\n"));
    editorConfig = vscode.workspace.getConfiguration("editor", folder.uri);
    await editorConfig.update("quickSuggestions", { other: "offWhenInlineCompletions", comments: "off", strings: "off" }, vscode.ConfigurationTarget.WorkspaceFolder);
    await editorConfig.update("wordBasedSuggestions", "off", vscode.ConfigurationTarget.WorkspaceFolder);
    await editorConfig.update("insertSpaces", false, vscode.ConfigurationTarget.WorkspaceFolder);
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const { nativeDescriptor } = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    await config.update("languageBackend", JSON.parse(JSON.stringify(nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
      executable: process.env.ROBOT_COMPANION_NATIVE_BACKEND }))), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder); await manager.queue;
    root = manager.roots.get(folder.uri.toString()); assert.equal(root.session.state, "running");
    const other = await vscode.workspace.openTextDocument(file("other.robot"));
    await vscode.window.showTextDocument(other, { preview: false });
    document = await vscode.workspace.openTextDocument(file("typing.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.activeTextEditor.options = { ...vscode.window.activeTextEditor.options, insertSpaces: false };
    cdp = await WebviewCdp.connect();
    nativeRequest = root.session.request;
    root.session.request = async function (method, params, ...rest) {
      if (method !== "textDocument/completion") return nativeRequest.call(this, method, params, ...rest);
      const receipt = { method, params, at: Date.now(), version: document.version, text: document.getText(),
        signalAbortedAtCall: Boolean(rest[0]?.signal?.aborted) }; requests.push(receipt);
      const noteAbort = () => { receipt.signalAbortedAt = Date.now(); };
      rest[0]?.signal?.addEventListener("abort", noteAbort, { once: true });
      const delay = slowSpace && !slowSpace.used && params.context?.triggerCharacter === " " ? slowSpace : undefined;
      if (delay) { delay.used = true; delay.receipt = receipt; receipt.deliveryDelayMs = delay.duration; }
      try {
        const result = await nativeRequest.call(this, method, params, ...rest);
        receipt.nativeReceivedAt = Date.now(); receipt.result = result;
        if (delay) { receipt.heldUntil = Date.now() + delay.duration; await sleep(delay.duration); }
        receipt.finishedAt = Date.now(); receipt.cancelledAtDelivery = Boolean(rest[0]?.signal?.aborted);
        return result;
      }
      catch (error) { receipt.finishedAt = Date.now(); receipt.error = String(error); throw error; }
      finally { rest[0]?.signal?.removeEventListener("abort", noteAbort); }
    };
    evidence.push({ effectiveRobotQuickSuggestions: vscode.workspace.getConfiguration("editor", document).get("quickSuggestions"),
      globalLikeWorkspaceQuickSuggestions: editorConfig.get("quickSuggestions"), backend: root.session.serverInfo });
  });
  setup(async () => {
    await vscode.window.showTextDocument(document, { preview: false });
    await key("Escape", "Escape", 27);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    vscode.window.activeTextEditor.options = { ...vscode.window.activeTextEditor.options, insertSpaces: false };
  });
  suiteTeardown(async () => {
    if (root?.session && nativeRequest) root.session.request = nativeRequest;
    if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, "typing-completion-actions.json"), JSON.stringify({ evidence, requests }, null, 2));
    await languageConfig?.update("[robotframework]", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    for (const setting of ["quickSuggestions", "wordBasedSuggestions", "insertSpaces"]) await editorConfig?.update(setting, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder); await manager.queue;
    await vscode.workspace.fs.delete(directory, { recursive: true }); cdp?.close();
  });
  test("automatic keyword suggestions remain available while a real inline provider offers ghost text", async function () {
    this.timeout(30000);
    const inlineCalls = [];
    const provider = vscode.languages.registerInlineCompletionItemProvider({ language: "robotframework", pattern: "**/typing.robot" }, {
      provideInlineCompletionItems(owner, position, context) {
        const line = owner.lineAt(position.line).text;
        const indent = line.match(/^\s*/)[0].length;
        const prefix = line.slice(indent, position.character);
        inlineCalls.push({ prefix, position, indent, at: Date.now(), triggerKind: context.triggerKind });
        if (!KEYWORD.startsWith(prefix) || position.character < indent) return [];
        return [new vscode.InlineCompletionItem(KEYWORD, new vscode.Range(position.line, indent, position.line, position.character))];
      }
    });
    try {
      await observe("inline-competition", async () => {
        await clickLine(4, "prefix-marker"); await key("Enter", "Enter", 13, "\r");
        const typedLine = vscode.window.activeTextEditor.selection.active.line;
        // Activate the real inline provider; this is not the suggestion widget's
        // manual Trigger Suggest command. All completion assertions use typing.
        await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        const ghost = () => page(`[...document.querySelectorAll('.ghost-text, .ghost-text-decoration')].map(node => node.textContent).join('')`);
        await until(async () => Boolean(await ghost()), "real inline ghost text painted");
        evidence.push({ inlineGhostBeforeTyping: await ghost(), inlineCalls,
          inlineSuggest: vscode.workspace.getConfiguration("editor", document).get("inlineSuggest"),
          effective: vscode.workspace.getConfiguration("editor", document).get("quickSuggestions") });
        await screenshot("inline-ghost-before-typing");
        await letters("BAVL Antw");
        await until(async () => (await rows()).some(row => row.includes(KEYWORD)), "automatic keyword widget after fast single-space typing with inline ghost");
        evidence.push({ inlineCompetitionWidget: await rows(), inlineGhost: await ghost(), inlineCalls });
        await screenshot("inline-competition-widget");
        await acceptSuggestion(KEYWORD);
        await until(() => document.lineAt(typedLine).text.trimStart() === KEYWORD, "actual keyword widget acceptance while inline provider is present");
      });
    } finally { evidence.push({ inlineProviderCalls: inlineCalls }); provider.dispose(); await key("Escape", "Escape", 27); }
  });
  test("automatic keyword suggestions recover when first SPACE reply is slow and the next word is already typed", async function () {
    this.timeout(30000);
    const inlineCalls = [];
    const provider = vscode.languages.registerInlineCompletionItemProvider({ language: "robotframework", pattern: "**/typing.robot" }, {
      provideInlineCompletionItems(owner, position, context) {
        const line = owner.lineAt(position.line).text;
        const indent = line.match(/^\s*/)[0].length;
        const prefix = line.slice(indent, position.character);
        inlineCalls.push({ prefix, position, indent, at: Date.now(), triggerKind: context.triggerKind });
        if (!KEYWORD.startsWith(prefix) || position.character < indent) return [];
        return [new vscode.InlineCompletionItem(KEYWORD, new vscode.Range(position.line, indent, position.line, position.character))];
      }
    });
    try {
      await observe("slow-space-inline", async () => {
        await clickLine(4, "prefix-marker"); await key("Enter", "Enter", 13, "\r");
        const typedLine = vscode.window.activeTextEditor.selection.active.line;
        // Activate the real inline provider; this is not the suggestion widget's
        // manual Trigger Suggest command. All completion assertions use typing.
        await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        const ghost = () => page(`[...document.querySelectorAll('.ghost-text, .ghost-text-decoration')].map(node => node.textContent).join('')`);
        await until(async () => Boolean(await ghost()), "real inline ghost text painted");
        evidence.push({ inlineGhostBeforeTyping: await ghost(), inlineCalls,
          inlineSuggest: vscode.workspace.getConfiguration("editor", document).get("inlineSuggest"),
          effective: vscode.workspace.getConfiguration("editor", document).get("quickSuggestions") });
        await screenshot("slow-space-inline-ghost");
        slowSpace = { used: false, duration: 1000 };
        await letters("BAVL ");
        await until(() => Boolean(slowSpace.receipt), "first SPACE native request is genuinely in flight");
        const beforeLetters = { at: Date.now(), ghost: await ghost(), widget: await rows() };
        evidence.push({ slowSpaceBeforeNextLetters: beforeLetters });
        assert.ok((beforeLetters.ghost && beforeLetters.widget.length === 0) || beforeLetters.widget.some(row => row.includes(KEYWORD)),
          "while SPACE is held, either real ghost remains or correct native keyword suggestions are already visible");
        await letters("Antw");
        evidence.push({ slowSpaceBeforeNextLetters: beforeLetters, nextLettersFinishedAt: Date.now(), control: slowSpace.receipt });
        assert.ok(!slowSpace.receipt.finishedAt, "next word is typed before the delayed first SPACE reply");
        await until(async () => (await rows()).some(row => row.includes(KEYWORD)), "automatic keyword widget after fast single-space typing with inline ghost");
        await until(() => Boolean(slowSpace.receipt.finishedAt), "the real first SPACE reply is delivered");
        await sleep(150);
        const currentQuery = requests.some(receipt => receipt.at > beforeLetters.at && receipt.version === document.version &&
          receipt.text.split("\n")[receipt.params.position.line].trimStart() === "BAVL Antw");
        const originalReply = slowSpace.receipt;
        assert.equal(originalReply.cancelledAtDelivery, false, "only an uncancelled reply may remain usable");
        assert.ok(originalReply.result.items.some(item => item.label === KEYWORD));
        const currentRows = await rows();
        assert.ok(currentRows.some(row => row.includes(KEYWORD)), "correct native keyword widget remains after held reply delivery");
        assert.ok(currentRows.every(row => row.startsWith("BAVL Antworten")), "no argument names or unrelated catalog noise appears for the current keyword prefix");
        evidence.push({ lateReplyMode: currentQuery ? "fresh current query" : "original same-cell reply with editor refiltering",
          originalVersion: originalReply.version, currentVersion: document.version, text: document.lineAt(typedLine).text,
          currentRows, originalRange: originalReply.result.items.find(item => item.label === KEYWORD).textEdit.range });
        evidence.push({ inlineCompetitionWidget: await rows(), inlineGhost: await ghost(), inlineCalls });
        await screenshot("slow-space-inline-widget");
        evidence.push({ slowSpaceAfterCurrentRequestWait: { widget: await rows(), ghost: await ghost(),
          at: Date.now(), currentRequestObserved: currentQuery,
          text: document.lineAt(typedLine).text, version: document.version, delayFinishedAt: slowSpace.receipt.finishedAt } });
        await acceptSuggestion(KEYWORD);
        await until(() => document.lineAt(typedLine).text.trimStart() === KEYWORD, "actual keyword widget acceptance while inline provider is present");
        evidence.push({ delayedCaseAcceptedText: document.lineAt(typedLine).text, currentRequestObserved: currentQuery,
          acceptedAt: Date.now(), delayFinishedAt: slowSpace.receipt.finishedAt });
        await sleep(200);
        assert.equal(document.lineAt(typedLine).text.trimStart(), KEYWORD, "the late reply cannot corrupt the accepted keyword range");
      });
    } finally { evidence.push({ slowSpaceControl: slowSpace, inlineProviderCalls: inlineCalls }); slowSpace = undefined; provider.dispose(); await key("Escape", "Escape", 27); }
  });
  for (const interruption of ["Escape", "editor switch"]) test(`a held completion cannot resurrect after actual ${interruption}`, async function () {
    this.timeout(20000);
    await observe(`cancel-${interruption.replace(" ", "-")}`, async () => {
      slowSpace = { used: false, duration: 1000 };
      try {
        await clickLine(4, "prefix-marker"); await key("Enter", "Enter", 13, "\r");
        await letters("BAVL ");
        await until(() => Boolean(slowSpace.receipt?.heldUntil), "real completion reply is held before interruption");
        if (interruption === "Escape") await key("Escape", "Escape", 27);
        else {
          evidence.push({ switchTabDom: await page(`[...document.querySelectorAll('[role="tab"], .tab')].map(node => ({ text: node.textContent, role: node.getAttribute('role'), className: node.className, width: node.getBoundingClientRect().width }))`) });
          const point = await page(`(() => {
            const tab = [...document.querySelectorAll('[role="tab"], .tab')].find(node => node.textContent.includes('other.robot'));
            const r = tab?.getBoundingClientRect();
            if (!r?.width) return;
            const x = r.x + r.width / 2, y = r.y + r.height / 2;
            return tab.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
          })()`);
          assert.ok(point, "other editor tab is visible and hit-tested");
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
            type, ...point, ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 })
          }, cdp.pageSession);
          await until(() => vscode.window.activeTextEditor?.document.uri.toString() === file("other.robot").toString(), "actual pointer switched the active editor");
          evidence.push({ action: "actual tab pointer", point, activeUri: vscode.window.activeTextEditor.document.uri.toString() });
        }
        const requestsAtInterruption = requests.length;
        await until(() => Boolean(slowSpace.receipt.finishedAt), "held reply settles after interruption"); await sleep(250);
        assert.deepEqual(await rows(), [], "late native result cannot reopen the widget after interruption");
        assert.equal(requests.length, requestsAtInterruption, "interruption does not schedule another completion request");
        assert.equal(slowSpace.receipt.cancelledAtDelivery, true, "actual editor cancellation reaches the native AbortSignal");
        evidence.push({ interruption, heldReply: slowSpace.receipt, requestsAtInterruption });
        await screenshot(`cancel-${interruption.replace(" ", "-")}`);
      } finally { slowSpace = undefined; }
    });
  });
  test("a single internal space retains keyword suggestions and true separators switch to named arguments", async function () {
    this.timeout(60000);
    await observe("keyword-space", async () => {
      await clickLine(4, "prefix-marker"); await key("Enter", "Enter", 13, "\r");
      const typedLine = vscode.window.activeTextEditor.selection.active.line;
      for (const char of "BAVL") await letters(char);
      await until(async () => (await rows()).some(row => row.includes(KEYWORD)), "automatic BAVL keyword widget");
      await letters(" ");
      await until(async () => (await rows()).some(row => row.includes(KEYWORD)), "keyword widget survives one internal SPACE");
      assert.ok(!(await rows()).some(row => row.startsWith("antwortKinder=")));
      await letters("Antw");
      await until(async () => (await rows()).some(row => row.includes(KEYWORD)), "second keyword word is automatically refiltered");
      await screenshot("keyword-single-space"); await acceptSuggestion(KEYWORD);
      await until(() => document.lineAt(typedLine).text.trimStart() === KEYWORD, "actual widget inserts complete multiword keyword");
      await key("Escape", "Escape", 27); await letters("  a");
      await until(async () => (await rows()).some(row => row.includes("antwortKinder=")), "two spaces switches to named arguments");
      await screenshot("two-space-argument");
      await key("Escape", "Escape", 27);
      for (let index = 0; index < 3; index++) await key("Backspace", "Backspace", 8);
      await key("Tab", "Tab", 9); await letters("a");
      assert.ok(document.lineAt(typedLine).text.endsWith("\ta"), "the actual Tab gesture inserts a real tab separator");
      await until(async () => (await rows()).some(row => row.includes("antwortKinder=")), "tab switches to named arguments");
      await screenshot("tab-argument");
    });
  });
  test("continuation argument letters automatically offer and accept antwortKinder without manual completion", async function () {
    this.timeout(30000);
    await observe("continuation", async () => {
      await clickLine(8, "...");
      for (const char of "antw") {
        await letters(char);
        await until(async () => (await rows()).some(row => row.includes("antwortKinder=")), `automatic continuation completion after ${char}`);
      }
      await screenshot("continuation-automatic"); await acceptSuggestion("antwortKinder=");
      await until(() => document.lineAt(8).text === "    ...    antwortKinder=", "actual widget inserts named argument only");
    });
  });
  test("an explicit Robot-language quickSuggestions false remains respected", async function () {
    this.timeout(30000);
    await observe("explicit-off", async () => {
      languageConfig = vscode.workspace.getConfiguration(undefined, folder.uri);
      await languageConfig.update("[robotframework]", { "editor.quickSuggestions": false }, vscode.ConfigurationTarget.WorkspaceFolder);
      assert.equal(vscode.workspace.getConfiguration("editor", document).get("quickSuggestions"), false);
      await clickLine(8, "..."); const start = requests.length; await letters("antw"); await sleep(500);
      assert.deepEqual(await rows(), [], "explicit language override keeps automatic widget closed");
      assert.equal(requests.length, start, "explicit language override does not request automatic completion");
      await screenshot("explicit-language-off");
      await languageConfig.update("[robotframework]", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    });
  });
});

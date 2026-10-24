"use strict";

// The native backend's class, dynamic and Run Keyword resolution in VS Code, driven by actual
// pointer and keyboard input at 1280x900: F12 on keyword name arguments of Run Keyword and
// Run Keyword If, on a class library's overriding method and on a dynamic library's keyword,
// the merged hover, the references peek and typed completion in a Run Keyword argument.
// Skipped (pending) without the prepared native venv; never reported as a pass. With
// ROBOT_COMPANION_UI_REQUIRE_NATIVE=1 a missing native venv fails the suite instead.
// Where the window is smaller than 1280x900 (a 1024x768 Windows CI display), the workbench page
// is emulated at 1280x900 and that is recorded in the action transcript.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const nativeRequired = process.env.ROBOT_COMPANION_UI_REQUIRE_NATIVE === "1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

// Synthetic project files, written into the test workspace for this suite only.
const FILES = {
  "ShapesLib.py": [
    "class Base:",
    "    def shared_step(self):",
    "        \"\"\"Base implementation, overridden.\"\"\"",
    "",
    "",
    "class ShapesLib(Base):",
    "    def shared_step(self):",
    "        \"\"\"Child implementation used by the suite.\"\"\"",
    "        return \"child\"",
    ""].join("\n"),
  "DynLib.py": [
    "class DynLib:",
    "    def get_keyword_names(self):",
    "        return [\"Dyn Step\"]",
    "",
    "    def run_keyword(self, name, args):",
    "        return name",
    ""].join("\n"),
  "libraries.robot": [
    "*** Settings ***",
    "Library    ShapesLib.py",
    "Library    DynLib.py",
    "",
    "*** Test Cases ***",
    "Indirect Calls",
    "    Run Keyword    Indirect Target    x",
    "    ${ok}=    Run Keyword And Return Status    Indirect Target    y",
    "    Run Keyword If    False    Fail    no    ELSE    Shared Step",
    "    Dyn Step    1",
    "    Log    completion-anchor",
    "",
    "*** Keywords ***",
    "Indirect Target",
    "    [Arguments]    ${value}",
    "    Log    ${value}",
    ""].join("\n")
};

suite("Native backend: class, dynamic and Run Keyword resolution (live, actual input)", function () {
  let extension, manager, folder, config, cdp, root, directory, emulated = false;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(directory, name);

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `native-libraries-${name}.png`), Buffer.from(data, "base64"));
  }
  async function key(key, code, virtualKeyCode, modifiers = 0, text) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers,
      ...(type === "keyDown" && text ? { text } : {})
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }
  async function type(text) {
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
  }
  async function move(point, label) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, cdp.pageSession);
    await sleep(100);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    evidence.push({ action: "pointer over", target: label, point });
  }
  async function click(point, label) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  // A layout-stable point inside `token` on the visible editor line containing `line`.
  async function textPoint(line, token, offset = 2) {
    let point, previous;
    await until(async () => {
      point = await page(`(() => {
        const row = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
          .find(el => el.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(line)}));
        if (!row) return;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          const start = node.textContent.replaceAll('\\u00a0', ' ').indexOf(${JSON.stringify(token)});
          if (start < 0) continue;
          const range = document.createRange(); range.setStart(node, start + ${offset}); range.setEnd(node, start + ${offset} + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width || rect.top < 0 || rect.bottom > innerHeight) return;
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      })()`);
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
    }, `visible ${token} on "${line}"`);
    return point;
  }
  async function clickText(line, token, offset) {
    for (let attempt = 1; ; attempt++) {
      await click(await textPoint(line, token, offset), `${token} on "${line}"`);
      try {
        await until(() => vscode.window.activeTextEditor?.document.lineAt(
          vscode.window.activeTextEditor.selection.active.line).text.includes(line), `cursor on "${line}"`, 2000);
        return;
      } catch (error) { if (attempt === 3) throw error; }
    }
  }
  async function openSuite() {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument(file("libraries.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(document.languageId, "robotframework");
    return document;
  }
  async function assertTarget(name, line, character) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith(`/integration-libraries/${name}`) && editor.selection.active.line === line &&
        editor.selection.active.character === character;
    }, `source ${name}:${line + 1}:${character + 1}`);
    evidence.push({ result: "source target", uri: vscode.window.activeTextEditor.document.uri.toString(), line, character });
  }
  const visibleText = selector => page(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); return el ? el.innerText : undefined; })()`);
  const rows = selector => page(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(e => e.getClientRects().length).map(e => (e.getAttribute('aria-label') || e.innerText).replaceAll('\\u00a0', ' '))`);
  async function hoverAt(line, token, expected) {
    let text;
    for (let attempt = 1; ; attempt++) {
      await move(await textPoint(line, token), `hover ${token}`);
      try {
        await until(async () => (text = await visibleText(".monaco-hover:not(.hidden) .monaco-hover-content")) && expected.test(text),
          `hover over ${token}`, 8000);
        return text;
      } catch (error) { if (attempt === 3) throw new Error(`${error.message}; last hover text: ${text}`); }
    }
  }
  async function hideHover() {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 450 }, cdp.pageSession);
    await key("Escape", "Escape", 27);
    await until(async () => !await visibleText(".monaco-hover:not(.hidden) .monaco-hover-content"), "hover closed", 5000)
      .catch(() => {});
  }
  async function revertAll() {
    for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }

  suiteSetup(async function () {
    if (!nativeExecutable) {
      if (nativeRequired) throw new Error(`Native backend required but unavailable: ${process.env.ROBOT_COMPANION_NATIVE_SKIP || "no executable"}`);
      this.skip(); return;
    }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    manager = activatedExtensionApi(extension.extensionPath).getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    directory = vscode.Uri.joinPath(folder.uri, "integration-libraries");
    await vscode.workspace.fs.createDirectory(directory);
    for (const [name, text] of Object.entries(FILES)) await vscode.workspace.fs.writeFile(file(name), Buffer.from(text));
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    const { nativeDescriptor } = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const descriptor = nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable });
    await config.update("languageBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "native running", 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.deepEqual({ ...root.session.serverInfo }, { name: "robot-companion-backend", version: "0.1.0.dev19" });
    let viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    if (viewport.width !== 1280 || viewport.height !== 900) {
      evidence.push({ windowViewport: viewport, emulated: "1280x900" });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 0, mobile: false },
        cdp.pageSession);
      emulated = true;
      await until(async () => (await page("innerWidth")) === 1280 && (await page("innerHeight")) === 900, "1280x900 viewport");
      viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    }
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "editor checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: descriptor.services.language.executable, pid: root.session.child.pid, exposed: [...root.features], viewport,
      files: Object.keys(FILES) });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") await screenshot(`failed-${this.currentTest.title.split(":")[0].replace(/\W+/g, "-")}`);
    await hideHover().catch(() => {});
    await revertAll();
  });
  suiteTeardown(async () => {
    if (!extension) return;
    try {
      await revertAll();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const child = root?.session?.child;
      await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
      if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "native process exit");
      await vscode.workspace.fs.delete(directory, { recursive: true });
      evidence.push({ cleanup: "coexistence; synthetic files removed", roots: manager.roots.size, exitCode: child?.exitCode });
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-libraries-ui-actions.json"), JSON.stringify(evidence, null, 2));
    } finally {
      // The following suites of a language or full run see the window's own size again.
      if (emulated) await cdp.send("Emulation.clearDeviceMetricsOverride", {}, cdp.pageSession).catch(() => {});
      cdp?.close();
    }
  });

  test("F12 on Run Keyword arguments, an overriding class method and a dynamic keyword", async function () {
    this.timeout(120000);
    await openSuite();
    await clickText("    Run Keyword    Indirect Target    x", "Indirect Target");
    await key("F12", "F12", 123);
    await assertTarget("libraries.robot", 13, 0);
    await screenshot("f12-run-keyword");
    await openSuite();
    await clickText("ELSE    Shared Step", "Shared Step");
    await key("F12", "F12", 123);
    await assertTarget("ShapesLib.py", 6, 8); // the subclass's method, not Base's
    await screenshot("f12-class-override");
    await openSuite();
    await clickText("    Dyn Step    1", "Dyn Step");
    await key("F12", "F12", 123);
    await assertTarget("DynLib.py", 2, 17); // the listed name in get_keyword_names
    await screenshot("f12-dynamic");
  });

  test("hover on a Run Keyword If branch keyword shows the overriding method's documentation", async function () {
    this.timeout(120000);
    await openSuite();
    const hover = await hoverAt("ELSE    Shared Step", "Shared Step", /Shared Step · Library ShapesLib · ShapesLib\.py/);
    assert.match(hover, /Child implementation used by the suite/);
    assert.doesNotMatch(hover, /Base implementation/);
    evidence.push({ result: "hover Shared Step in Run Keyword If", text: hover });
    await screenshot("hover-run-keyword-if");
  });

  test("references: Shift+F12 on a Run Keyword argument lists the other run and the definition", async function () {
    this.timeout(120000);
    await openSuite();
    await clickText("    Run Keyword    Indirect Target    x", "Indirect Target");
    await key("F12", "F12", 123, 8); // Shift+F12: Go to References (peek)
    // The definition and both runs, one by Run Keyword And Return Status.
    let text;
    await until(async () => (text = await visibleText(".peekview-widget")) && /libraries\.robot/.test(text),
      "references peek", 30000);
    const title = await visibleText(".peekview-widget .peekview-title");
    assert.match(title, /References \(3\)|3 references/, title);
    const tree = await rows(".peekview-widget .monaco-list-row");
    for (const place of ["Indirect Target    x in libraries.robot on line 7 at column 20",
      "Indirect Target    y in libraries.robot on line 8 at column 48", "Indirect Target in libraries.robot on line 14 at column 1"]) {
      assert.ok(tree.some(row => row.includes(place)), `${place}: ${tree}`);
    }
    evidence.push({ result: "references peek", title, rows: tree });
    await screenshot("references-run-keyword");
    await key("Escape", "Escape", 27);
    await until(async () => !await visibleText(".peekview-widget"), "peek closed");
  });

  test("unsaved edits of an open library are used at once; closing without saving returns to the file", async function () {
    this.timeout(120000);
    const suite = await openSuite();
    const missing = () => vscode.languages.getDiagnostics(suite.uri).some(item => item.message === "No keyword with name 'Dyn Step' found.");
    assert.equal(missing(), false, "Dyn Step resolves before the edit");
    // Rename the dynamic keyword in the library editor with the keyboard, without saving.
    const library = await vscode.workspace.openTextDocument(file("DynLib.py"));
    await vscode.window.showTextDocument(library, { preview: false });
    await clickText("        return [\"Dyn Step\"]", "Dyn Step");
    await key("End", "End", 35);
    for (let i = 0; i < 2; i++) await key("ArrowLeft", "ArrowLeft", 37);
    for (let i = 0; i < 4; i++) await key("Backspace", "Backspace", 8);
    await type("Walk");
    await until(() => library.lineAt(2).text === "        return [\"Dyn Walk\"]" && library.isDirty, "unsaved rename in DynLib.py");
    await screenshot("unsaved-library-edit");
    await vscode.window.showTextDocument(suite, { preview: false });
    await until(missing, "unknown-keyword diagnostic for the old name from the unsaved library text");
    evidence.push({ result: "diagnostics after unsaved library edit",
      messages: vscode.languages.getDiagnostics(suite.uri).map(item => item.message) });
    await screenshot("unsaved-library-diagnostic");
    await clickText("    Dyn Step    1", "Dyn Step");
    await key("F12", "F12", 123);
    await sleep(1500);
    assert.ok(vscode.window.activeTextEditor.document.uri.path.endsWith("/libraries.robot"), "F12 finds no definition for the old name");
    await clickText("    Log    completion-anchor", "Log");
    await key("End", "End", 35);
    await key("Enter", "Enter", 13, 0, "\r");
    await until(() => suite.lineAt(vscode.window.activeTextEditor.selection.active.line).text.trim() === "", "new empty line");
    await type("Run Keyword    Dyn");
    let suggestions;
    const suggest = async (label, timeout = 20000) => until(async () =>
      (suggestions = await rows(".suggest-widget.visible .monaco-list-row")).some(row => row.includes(label)), `suggestion ${label}`, timeout);
    try { await suggest("Dyn Walk", 5000); }
    catch { await key(" ", "Space", 32, 2); await suggest("Dyn Walk"); } // Ctrl+Space: Trigger Suggest
    assert.ok(!suggestions.some(row => row.includes("Dyn Step")), `old name offered: ${suggestions}`);
    evidence.push({ result: "suggestions after unsaved library edit", rows: suggestions });
    await screenshot("unsaved-library-completion");
    await key("Escape", "Escape", 27);
    await vscode.commands.executeCommand("workbench.action.files.revert");  // the suite's typed line
    // Close the library editor without saving ("Don't Save"): the file on disk applies again.
    await vscode.window.showTextDocument(library, { preview: false });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    assert.equal(fs.readFileSync(file("DynLib.py").fsPath, "utf8").includes("\"Dyn Step\""), true, "nothing was saved");
    await vscode.window.showTextDocument(suite, { preview: false });
    await until(() => !missing(), "diagnostic gone after closing the unsaved library");
    await clickText("    Dyn Step    1", "Dyn Step");
    await key("F12", "F12", 123);
    await assertTarget("DynLib.py", 2, 17);
    evidence.push({ result: "closed without saving: disk text used again" });
  });

  test("typed completion in a Run Keyword argument offers the suite's keywords", async function () {
    this.timeout(120000);
    const document = await openSuite();
    await clickText("    Log    completion-anchor", "Log");
    await key("End", "End", 35);
    await key("Enter", "Enter", 13, 0, "\r");
    await until(() => document.lineAt(vscode.window.activeTextEditor.selection.active.line).text.trim() === "", "new empty line");
    await type("Run Keyword    Indi");
    let suggestions;
    const suggest = async (label, timeout = 20000) => until(async () =>
      (suggestions = await rows(".suggest-widget.visible .monaco-list-row")).some(row => row.includes(label)), `suggestion ${label}`, timeout);
    try { await suggest("Indirect Target", 5000); }
    catch { await key(" ", "Space", 32, 2); await suggest("Indirect Target"); } // Ctrl+Space: Trigger Suggest
    evidence.push({ result: "Run Keyword argument suggestions", rows: suggestions });
    await screenshot("completion-run-keyword");
    await key("Enter", "Enter", 13);
    await until(() => document.getText().split("\n").some(line => line.trimEnd() === "    Run Keyword    Indirect Target"),
      "Indirect Target inserted as the Run Keyword argument");
    evidence.push({ result: "accepted", line: document.lineAt(vscode.window.activeTextEditor.selection.active.line).text });
  });
});

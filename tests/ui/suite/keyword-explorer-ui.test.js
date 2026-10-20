"use strict";

// The Robot Keywords view, Search Keywords in Scope and Python library keyword rename with the
// native backend, driven by actual pointer and keyboard input at 1280x900: the view lists the
// suite's imports with their alias and never the unimported shadow library; a keyword row opens
// its definition; its keyboard context menu (Shift+F10) inserts the alias-qualified call, after which the Return Explorer
// shows that keyword's docstring and return fields, its Insert argument link adds `mode=` and
// Robot Companion's enum completion offers the enum's members; search filters by alias and
// opens the resource definition; an unsaved import edit changes the list; F2 renames the
// decorator literal and every call, and refuses a function-named keyword with its reason.
// Skipped (pending) without the prepared native venv; never reported as a pass.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
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
const REPORTS = [
  "\"\"\"Reports for the keyword explorer.\"\"\"",
  "from dataclasses import dataclass",
  "from enum import Enum",
  "",
  "from robot.api.deco import keyword",
  "",
  "",
  "class Mode(Enum):",
  "    FAST = \"fast\"",
  "    SLOW = \"slow\"",
  "",
  "",
  "@dataclass",
  "class Report:",
  "    title: str",
  "    count: int",
  "",
  "",
  "@keyword(\"Make Report\")",
  "def make_report(title: str, mode: Mode = Mode.FAST, count: int = 1) -> Report:",
  "    \"\"\"Make a report for the keyword explorer.",
  "",
  "    Args:",
  "        title: The report title.",
  "        mode: How fast to make it.",
  "        count: How many entries.",
  "    \"\"\"",
  "    return Report(title, count)",
  "",
  "",
  "def helper_step(value):",
  "    \"\"\"A plain module function keyword.\"\"\"",
  "    return value",
  ""].join("\n");
const FILES = {
  "KwReports.py": REPORTS,
  // Imported too: its Make Report makes the unqualified name ambiguous.
  "KwOther.py": "from robot.api.deco import keyword\n\n\n@keyword(\"Make Report\")\ndef other_report():\n    \"\"\"Other report.\"\"\"\n",
  // Never imported: nothing of it may be listed.
  "KwShadow.py": "from robot.api.deco import keyword\n\n\n@keyword(\"Shadow Report\")\ndef shadow_report():\n    \"\"\"Shadow docs.\"\"\"\n",
  "kw-steps.resource": [
    "*** Settings ***",
    "Documentation    Steps for the keyword explorer.",
    "",
    "*** Keywords ***",
    "Resource Walk",
    "    [Arguments]    ${where}",
    "    [Documentation]    Walks somewhere.",
    "    Log    ${where}",
    ""].join("\n"),
  "kw-explorer.robot": [
    "*** Settings ***",
    "Library    KwReports.py    AS    Reports",
    "Library    KwOther.py",
    "Resource    kw-steps.resource",
    "",
    "*** Test Cases ***",
    "Explore",
    "    Log    start",
    "    Helper Step    1",
    "",
    "*** Keywords ***",
    "Own Step",
    "    [Documentation]    The suite's own step.",
    "    No Operation",
    ""].join("\n")
};

suite("Robot Keywords view, keyword search and Python library rename (live, actual input)", function () {
  let extension, manager, folder, config, cdp, root, directory, exported;
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
    fs.writeFileSync(path.join(evidenceDirectory, `keyword-explorer-${name}.png`), Buffer.from(data, "base64"));
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
  async function click(point, label) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  // The center of the first visible element matching `selector` whose text/aria-label passes `test`.
  async function elementPoint(selector, test, label, timeoutMs = 20000) {
    let point;
    await until(async () => {
      point = await page(`(() => {
        const test = ${test};
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => {
          const r = e.getBoundingClientRect();
          return r.width && r.height && r.top >= 0 && r.bottom <= innerHeight &&
            test((e.getAttribute('aria-label') || e.innerText || '').replaceAll('\\u00a0', ' '));
        });
        if (!el) return;
        const r = el.getBoundingClientRect();
        const x = r.x + Math.min(r.width / 2, 60), y = r.y + r.height / 2;
        return document.elementFromPoint(x, y) && el.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
      })()`);
      return Boolean(point);
    }, label, timeoutMs);
    return point;
  }
  const VIEW = '[id="workbench.view.extension.robotCompanionContainer"] .pane:has(.pane-header[aria-label*="Robot Keywords"])';
  const rows = () => page(`[...document.querySelectorAll(${JSON.stringify(`${VIEW} .monaco-list-row`)})]
    .filter(e => e.getClientRects().length).map(e => (e.getAttribute('aria-label') || e.innerText).replaceAll('\\u00a0', ' '))`);
  const visibleText = selector => page(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); return el ? el.innerText : undefined; })()`);
  // Expand a collapsed group row with the pointer; an expanded one stays as it is.
  async function expandRow(startsWith) {
    const expanded = () => page(`[...document.querySelectorAll(${JSON.stringify(`${VIEW} .monaco-list-row`)})]
      .find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(startsWith)}))?.getAttribute('aria-expanded')`);
    if (await expanded() !== "true") await clickRow(startsWith);
    await until(async () => await expanded() === "true", `${startsWith} expanded`);
  }
  async function clickRow(startsWith) {
    await click(await elementPoint(`${VIEW} .monaco-list-row`, `t => t.startsWith(${JSON.stringify(startsWith)})`,
      `Robot Keywords row ${startsWith}`), `Robot Keywords row ${startsWith}`);
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
    const document = await vscode.workspace.openTextDocument(file("kw-explorer.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }
  async function assertTarget(name, line, character) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith(`/integration-keywords/${name}`) && editor.selection.active.line === line &&
        editor.selection.active.character === character;
    }, `source ${name}:${line + 1}:${character + 1}`);
    evidence.push({ result: "source target", uri: vscode.window.activeTextEditor.document.uri.toString(), line, character });
  }
  // Activity bar: open the Robot Companion container with the pointer; expand Robot Keywords if collapsed.
  async function showView() {
    const container = await elementPoint(".activitybar .action-item a, .activitybar .action-item .action-label",
      `t => t.startsWith("Robot Companion")`, "Robot Companion activity bar item");
    if (!await page(`Boolean(document.querySelector(${JSON.stringify(VIEW)}))`)) await click(container, "Robot Companion activity bar item");
    await until(() => page(`Boolean(document.querySelector(${JSON.stringify(VIEW)}))`), "Robot Keywords pane");
    if (!await page(`document.querySelector(${JSON.stringify(`${VIEW} .pane-header`)}).classList.contains('expanded')`)) {
      await click(await elementPoint(`${VIEW} .pane-header`, "() => true", "Robot Keywords header"), "Robot Keywords header");
    }
    await until(async () => (await rows()).length > 0, "Robot Keywords rows");
  }
  function explorerHtml() {
    return exported.getReturnExplorerWebviewHtmlForTest();
  }
  async function settledExplorer() {
    let last, stableSince = Date.now();
    await until(() => {
      const html = explorerHtml();
      if (html !== last) { last = html; stableSince = Date.now(); }
      return Date.now() - stableSince >= 400;
    }, "Return Explorer settled");
  }
  async function clickExplorerLink(text, title) {
    for (let attempt = 1; ; attempt++) {
      await settledExplorer();
      try {
        const frame = await cdp.findWebviewFrame('return Boolean(document.querySelector(".details") && document.querySelector(".meta"));', "Return Explorer");
        const expression = `Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === ${JSON.stringify(text)}` +
          `${title ? ` && a.title === ${JSON.stringify(title)}` : ""})`;
        let rect;
        for (let i = 0; i < 8; i++) {
          rect = await cdp.evaluate(frame.frameId, `(()=>{const a=${expression};if(!a)return;const r=a.getClientRects()[0];return {x:r.x+r.width/2,y:r.y+r.height/2,h:innerHeight};})()`);
          assert.ok(rect, `visible link ${text}`);
          if (rect.y > 30 && rect.y < rect.h - 30) break;  // well inside the small pane, not at its edge
          const origin = await cdp.frameOrigin(frame);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: origin.pageX + 100,
            y: origin.pageY + 50, deltaX: 0, deltaY: rect.y <= 30 ? -120 : 120 }, cdp.pageSession);
          await sleep(100);
        }
        assert.ok(await cdp.hitsElement(frame, rect.x, rect.y, expression), `link hit test ${text}`);
        await cdp.click(frame, rect.x, rect.y);
        evidence.push({ action: "Return Explorer pointer", link: text, title, point: { x: rect.x, y: rect.y } });
        return;
      } catch (error) {
        if (attempt === 3 || !/execution context|box model|Cannot find context|link hit test/.test(error.message)) throw error;
      }
    }
  }
  async function revertAll() {
    for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }
  async function resetFiles() {
    await revertAll();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const [name, text] of Object.entries(FILES)) await vscode.workspace.fs.writeFile(file(name), Buffer.from(text));
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    exported = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    manager = exported.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    directory = vscode.Uri.joinPath(folder.uri, "integration-keywords");
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
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "editor checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: descriptor.services.language.executable, pid: root.session.child.pid, exposed: [...root.features], viewport,
      files: Object.keys(FILES) });
  });
  setup(async () => { if (extension) await resetFiles(); });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await screenshot(`failed-${this.currentTest.title.split(":")[0].replace(/\W+/g, "-")}`);
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `keyword-explorer-failed-${Date.now()}.html`), explorerHtml() || "");
    }
    await key("Escape", "Escape", 27).catch(() => {});
    await revertAll();
  });
  suiteTeardown(async () => {
    if (!extension) return;
    await revertAll();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const child = root?.session?.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "native process exit");
    await vscode.workspace.fs.delete(directory, { recursive: true });
    evidence.push({ cleanup: "coexistence; synthetic files removed", roots: manager.roots.size, exitCode: child?.exitCode });
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "keyword-explorer-ui-actions.json"), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("the view lists the imported scope with its alias, never the shadow library; a row opens the definition", async function () {
    this.timeout(120000);
    await openSuite();
    await showView();
    let shown;
    await until(async () => (shown = await rows()).some(row => row.startsWith("Reports, Library · KwReports.py")), "Reports group", 30000);
    for (const expected of ["kw-explorer.robot, This file", "Reports, Library · KwReports.py, 2 keywords",
      "KwOther, Library · KwOther.py, 1 keywords", "kw-steps, Resource · kw-steps.resource, 1 keywords", "BuiltIn, Standard library"]) {
      assert.ok(shown.some(row => row.startsWith(expected)), `${expected}: ${shown}`);
    }
    assert.ok(shown.some(row => row.startsWith("Own Step, keyword of this file")), shown.join("\n"));
    assert.ok(!shown.some(row => /Shadow/.test(row)), `shadow listed: ${shown}`);
    const description = await visibleText(`${VIEW} .pane-header`);
    assert.match(description, /kw-explorer\.robot/);
    evidence.push({ result: "view rows", rows: shown, header: description });
    await screenshot("view-scope");
    await expandRow("Reports, Library");
    await until(async () => (shown = await rows()).some(row => row.startsWith("Make Report, keyword of library Reports")), "Make Report row");
    assert.ok(shown.some(row => row.startsWith("Make Report, keyword of library Reports, arguments title: str, mode: Mode = Mode.FAST, count: int = 1")),
      shown.join("\n"));
    assert.ok(shown.some(row => row.startsWith("Helper Step, keyword of library Reports, arguments value")), shown.join("\n"));
    // Hovering the row shows the docstring of the definition RF uses.
    const point = await elementPoint(`${VIEW} .monaco-list-row`, `t => t.startsWith("Make Report, keyword of library Reports")`, "Make Report row");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    let tooltip;
    await until(async () => (tooltip = await visibleText(".monaco-hover:not(.hidden) .monaco-hover-content, .workbench-hover"))
      && /Make a report for the keyword explorer/.test(tooltip), "Make Report tooltip", 15000);
    assert.match(tooltip, /Library Reports · KwReports\.py/);
    assert.doesNotMatch(tooltip, /Other report/);
    evidence.push({ result: "row tooltip", text: tooltip });
    await screenshot("row-tooltip");
    await clickRow("Make Report, keyword of library Reports");
    await assertTarget("KwReports.py", 19, 4);
    assert.ok(shown.length, "the view keeps listing the suite while the library is active");
    assert.match(await visibleText(`${VIEW} .pane-header`), /kw-explorer\.robot/);
    await screenshot("row-definition");
    // Keyboard: the resource group with the pointer, ArrowDown to its keyword, Enter opens it.
    await clickRow("kw-steps, Resource");
    await expandRow("kw-steps, Resource");
    await key("ArrowDown", "ArrowDown", 40);
    await until(async () => (await page(`(() => { const list = document.activeElement?.closest(${JSON.stringify(VIEW)});
      return list ? list.querySelector('.monaco-list-row.focused')?.getAttribute('aria-label') || '' : ''; })()`))
      .startsWith("Resource Walk"), "Resource Walk focused");
    await key("Enter", "Enter", 13);
    await assertTarget("kw-steps.resource", 4, 0);
  });

  test("The keyboard context menu inserts the alias-qualified call; Return Explorer, argument Insert and enum completion follow it", async function () {
    this.timeout(180000);
    const suite = await openSuite();
    await showView();
    await clickText("    Log    start", "start");
    await key("End", "End", 35);
    await until(() => vscode.window.activeTextEditor.selection.active.character === "    Log    start".length, "caret at line end");
    // Selecting the group row with the pointer puts the keyboard focus in the view.
    await clickRow("Reports, Library");
    await expandRow("Reports, Library");
    await until(async () => (await rows()).some(row => row.startsWith("Make Report, keyword of library Reports")), "Make Report row");
    await key("ArrowDown", "ArrowDown", 40);  // focus moves from the group to its first keyword, nothing opens
    // The list keeps DOM focus and marks its focused row.
    await until(async () => (await page(`(() => { const list = document.activeElement?.closest(${JSON.stringify(VIEW)});
      return list ? list.querySelector('.monaco-list-row.focused')?.getAttribute('aria-label') || '' : ''; })()`))
      .startsWith("Make Report"), "Make Report focused in the Robot Keywords view");
    await key("F10", "F10", 121, 8);  // Shift+F10: the focused row's context menu
    let menu;
    await until(async () => (menu = await visibleText(".context-view .monaco-menu")) && /Insert Keyword Call/.test(menu),
      "context menu with Insert Keyword Call");
    assert.match(menu, /Insert Keyword Call[\s\S]*Go to Keyword Definition/);
    evidence.push({ result: "keyboard context menu", text: menu });
    await screenshot("context-menu");
    await key("ArrowDown", "ArrowDown", 40);  // the menu's first entry: Insert Keyword Call
    await until(async () => /Insert Keyword Call/.test(await visibleText(".context-view .monaco-menu .action-item.focused") || ""),
      "Insert Keyword Call focused");
    await key("Enter", "Enter", 13);
    await until(() => suite.lineAt(8).text === "    Reports.Make Report    title", "inserted call with its required argument");
    // The required argument is a selected placeholder: typing replaces it.
    await type("Q3");
    await until(() => suite.lineAt(8).text === "    Reports.Make Report    Q3", "placeholder replaced");
    evidence.push({ result: "inserted", line: suite.lineAt(8).text, focused: await page("document.activeElement?.className") });
    await screenshot("inserted-call");
    await key("Escape", "Escape", 27);
    // The Return Explorer follows the cursor onto the inserted call: the docstring and return fields of KwReports.
    await clickText("    Reports.Make Report    Q3", "Make Report");
    await until(() => /Make a report for the keyword explorer/.test(explorerHtml()), "Return Explorer docstring", 30000);
    const html = explorerHtml();
    assert.doesNotMatch(html, /Other report/);
    assert.match(html, /title/);
    assert.match(html, /count/);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "keyword-explorer-return-explorer.html"), html);
    await screenshot("return-explorer");
    // Its argument link inserts `mode=` below the call; Robot Companion's enum completion offers the members.
    await clickExplorerLink("Insert", "Insert named argument mode");
    await until(() => suite.lineAt(9).text === "    ...    mode=", "mode= inserted", 15000);
    let suggestions;
    await until(async () => (suggestions = await page(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
      .map(e => (e.getAttribute('aria-label') || e.innerText).replaceAll('\\u00a0', ' '))`)).some(row => /FAST/.test(row)) &&
      suggestions.some(row => /SLOW/.test(row)), "enum completion FAST/SLOW", 20000);
    evidence.push({ result: "enum completion after argument insert", rows: suggestions });
    await screenshot("enum-completion");
    await key("Enter", "Enter", 13);
    await until(() => /^ {4}\.\.\. {4}mode=(Mode\.)?FAST$/.test(suite.lineAt(9).text) ||
      /^ {4}\.\.\. {4}mode=(Mode\.)?SLOW$/.test(suite.lineAt(9).text), "enum member accepted");
    // F12 on the inserted call reaches the definition the view listed.
    await clickText("    Reports.Make Report    Q3", "Make Report");
    await key("F12", "F12", 123);
    await assertTarget("KwReports.py", 19, 4);
  });

  test("search filters the scope by alias and opens the resource definition; an unsaved import edit updates the view", async function () {
    this.timeout(120000);
    const suite = await openSuite();
    await showView();
    // The view's title actions show while the pointer is over its header.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved",
      ...await elementPoint(`${VIEW} .pane-header`, "() => true", "Robot Keywords header") }, cdp.pageSession);
    await click(await elementPoint(`${VIEW} .action-label`, `t => t.startsWith("Search Keywords in Scope")`, "search button"), "search button");
    await until(() => page(`Boolean(document.querySelector('.quick-input-widget:not([style*="display: none"]) input'))`), "search input");
    await type("Reports");
    let items;
    const picks = () => page(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(e => e.getClientRects().length)
      .map(e => (e.getAttribute('aria-label') || e.innerText).replaceAll('\\u00a0', ' '))`);
    await until(async () => (items = await picks()).length === 2, "two keywords of the alias Reports");
    assert.ok(items.some(item => item.startsWith("Make Report")) && items.some(item => item.startsWith("Helper Step")), items.join("\n"));
    evidence.push({ result: "search Reports", items });
    await screenshot("search-alias");
    await key("a", "KeyA", 65, 2);  // Ctrl+A, then a new query
    await type("shadow");
    await until(async () => (items = await picks()).length === 0, "nothing of the shadow library");
    await key("a", "KeyA", 65, 2);
    await type("resource walk");
    await until(async () => (items = await picks()).length === 1 && items[0].startsWith("Resource Walk"), "Resource Walk");
    await key("Enter", "Enter", 13);
    await assertTarget("kw-steps.resource", 4, 0);
    // Deleting the KwOther import with the keyboard (unsaved) removes its group from the view.
    await vscode.window.showTextDocument(suite, { preview: false });
    await clickText("Library    KwOther.py", "KwOther");
    await key("k", "KeyK", 75, 10);  // Ctrl+Shift+K: delete line
    await until(() => !suite.getText().includes("KwOther") && suite.isDirty, "import deleted, unsaved");
    await until(async () => !(await rows()).some(row => row.startsWith("KwOther")), "KwOther group gone", 15000);
    evidence.push({ result: "after unsaved import delete", rows: await rows() });
    await screenshot("import-deleted");
  });

  test("F2 renames the decorator literal and every call; a function-named keyword is refused with its reason", async function () {
    this.timeout(120000);
    const suite = await openSuite();
    await clickText("    Helper Step    1", "Helper Step");
    await key("F2", "F2", 113);
    let message;
    await until(async () => (message = await visibleText(".monaco-editor-overlaymessage, .notification-toast .notification-list-item-message")) &&
      /comes from the Python function name helper_step/.test(message), "refusal message", 15000);
    evidence.push({ result: "rename refused", message });
    await screenshot("rename-refused");
    await key("Escape", "Escape", 27);
    assert.equal(suite.isDirty, false);
    // Make the call first, then rename it through the call.
    await clickText("    Log    start", "start");
    await key("End", "End", 35);
    await key("Enter", "Enter", 13, 0, "\r");
    await type("Reports.Make Report    Q4");
    await until(() => suite.getText().includes("Reports.Make Report    Q4"), "typed call");
    await clickText("Reports.Make Report    Q4", "Make Report");
    await key("F2", "F2", 113);
    // The rename box opens focused with the keyword's name, not the call's `Reports.` prefix.
    await until(async () => (await page(`(() => { const input = document.activeElement;
      return input?.closest('.rename-box') && input.getClientRects().length ? input.value : undefined; })()`)) === "Make Report",
    "rename box Make Report");
    await screenshot("rename-box");
    await key("a", "KeyA", 65, 2);
    await type("Compile Report");
    await key("Enter", "Enter", 13);
    const library = () => fs.readFileSync(file("KwReports.py").fsPath, "utf8");
    await until(() => suite.getText().includes("Reports.Compile Report    Q4") &&
      (vscode.workspace.textDocuments.find(d => d.uri.path.endsWith("/KwReports.py"))?.getText() ?? library())
        .includes("@keyword(\"Compile Report\")"), "renamed call and decorator", 20000);
    const renamedLibrary = vscode.workspace.textDocuments.find(d => d.uri.path.endsWith("/KwReports.py"))?.getText() ?? library();
    assert.ok(renamedLibrary.includes("def make_report("), "the Python function keeps its name");
    assert.equal(fs.readFileSync(file("KwOther.py").fsPath, "utf8"), FILES["KwOther.py"], "the other library is unchanged");
    evidence.push({ result: "renamed", call: suite.getText().split("\n").find(l => l.includes("Compile Report")) });
    await screenshot("rename-applied");
  });

  test("without an owned native backend the view says why instead of listing keywords", async function () {
    this.timeout(120000);
    await openSuite();
    await showView();
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    let text;
    try {
      await until(async () => /integrationMode "owned" with the native backend/.test(text = await visibleText(`${VIEW} .pane-body`) || ""),
        "coexistence message", 20000);
      assert.equal((await rows()).length, 0, "no keyword rows");
      evidence.push({ result: "coexistence view message", text });
      await screenshot("coexistence-message");
    } finally {
      await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
      await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "native running again", 60000);
      root = manager.roots.get(folder.uri.toString());
    }
    await until(async () => (await rows()).some(row => row.startsWith("Reports, Library")), "list back in owned mode", 30000);
  });
});

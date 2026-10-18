"use strict";

// Owned-mode editor features from the pinned RobotCode 2.7.0 language bridge,
// driven by actual pointer and keyboard input at 1280x900 and asserted on what
// VS Code renders: hover, suggestions, parameter hints, the references peek,
// rename, the Outline view and both symbol pickers. Skipped by name (pending)
// when the prepared RobotCode environment is absent; never reported as a pass.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const occurrences = (text, part) => text.split(part).length - 1;

suite("Owned editor features with the pinned RobotCode 2.7.0 language bridge (live, actual input)", function () {
  let extension, manager, folder, config, cdp, root;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", name);

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `robotcode-language-${name}.png`), Buffer.from(data, "base64"));
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
  async function openAudit() {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument(file("audit.robot"));
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }
  const visibleText = selector => page(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); return el ? el.innerText : undefined; })()`);
  async function hoverAt(line, token, expected, offset) {
    let text;
    for (let attempt = 1; ; attempt++) {
      await move(await textPoint(line, token, offset), `hover ${token}`);
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
  const rows = selector => page(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(e => e.getClientRects().length).map(e => (e.getAttribute('aria-label') || e.innerText).replaceAll('\\u00a0', ' '))`);
  // The rename box that F2 opened: visible, focused and showing the server's name.
  const renameBox = name => until(async () => (await page(`(() => { const input = document.activeElement;
    return input?.closest('.rename-box') && input.getClientRects().length ? input.value : undefined; })()`)) === name, `rename box ${name}`);
  async function revertAll() {
    for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }

  suiteSetup(async function () {
    if (!fs.existsSync(python)) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const descriptor = robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python });
    // Companion's documentation hover is opt-in; enable it so both hovers meet.
    await vscode.workspace.getConfiguration("robotCompanion").update("enableDocumentationHoverPreview", true, vscode.ConfigurationTarget.Workspace);
    await config.update("languageBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "RobotCode running", 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.deepEqual({ ...root.session.serverInfo }, { name: "RobotCode Language Server", version: "2.7.0" });
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "editor feature checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: descriptor.services.language.executable, argv: descriptor.services.language.argv, pid: root.session.child.pid,
      exposed: [...root.features], viewport });
  });
  // On failure: what VS Code showed, before any cleanup changes it.
  async function failureSnapshot(title) {
    if (!evidenceDirectory) return;
    {
      const name = title.split(":")[0].replace(/\W+/g, "-");
      await screenshot(`failed-${name}`);
      fs.writeFileSync(path.join(evidenceDirectory, `robotcode-language-failed-${name}.json`), JSON.stringify(await page(`(() => {
        const texts = selector => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length)
          .map(e => (e.getAttribute('aria-label') || '') + ' | ' + e.innerText.slice(0, 300));
        return { hover: texts('.monaco-hover'), suggest: texts('.suggest-widget .monaco-list-row'), hints: texts('.parameter-hints-widget'),
          message: texts('.monaco-editor-overlaymessage'), rename: texts('.rename-box'), peek: texts('.peekview-widget .monaco-list-row'),
          panes: texts('.pane-header'), outline: texts('.outline-pane .monaco-list-row, .pane-body .monaco-list-row'),
          quick: texts('.quick-input-widget .monaco-list-row'), toasts: texts('.notification-toast'), active: document.activeElement?.className };
      })()`), null, 2));
      evidence.push({ failed: title, editor: vscode.window.activeTextEditor?.document.uri.toString(),
        line: vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.lineAt(vscode.window.activeTextEditor.selection.active.line).text,
        backend: { state: root?.session?.state, error: root?.error, features: root && [...root.features] } });
    }
  }
  teardown(async function () {
    if (this.currentTest?.state === "failed" && !this.currentTest.snapshotTaken) await failureSnapshot(this.currentTest.title);
    await hideHover().catch(() => {});
    await revertAll();
  });
  suiteTeardown(async () => {
    if (!extension) return;
    await revertAll();
    const child = root?.session?.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("robotCompanion").update("enableDocumentationHoverPreview", undefined, vscode.ConfigurationTarget.Workspace);
    await manager.queue;
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "RobotCode process exit");
    evidence.push({ cleanup: "coexistence", roots: manager.roots.size, exitCode: child?.exitCode });
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "robotcode-language-ui-actions.json"), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("hover: one hover per position, keyword documentation once, Companion's sections and preview link kept", async function () {
    this.timeout(120000);
    await openAudit();
    // A keyword call: the server's keyword hover, its documentation once.
    const call = await hoverAt("${record}=    Build Record", "Build Record", /Build a record for the isolated editor audit/);
    assert.equal(occurrences(call, "Build a record for the isolated editor audit"), 1, call);
    assert.match(call, /Keyword Build Record/);
    assert.equal(await page(`document.querySelectorAll('.monaco-hover:not(.hidden)').length`), 1, "one hover widget");
    evidence.push({ result: "hover Build Record call", text: call });
    await screenshot("hover-build-record");
    await hideHover();
    const localCall = await hoverAt("    Local Step", "Local Step", /A local keyword used to verify/);
    assert.equal(occurrences(localCall, "A local keyword used to verify native definition navigation"), 1, localCall);
    evidence.push({ result: "hover Local Step call", text: localCall });
    await hideHover();

    // A return variable: Companion's return hint first, then the server's part, in one hover.
    const variable = await hoverAt("${record}=    Build Record", "${record}", /Robot Return Hint[\s\S]*Local Variable/, 3);
    assert.ok(variable.indexOf("Robot Return Hint") < variable.indexOf("Local Variable"), variable);
    assert.equal(await page(`document.querySelectorAll('.monaco-hover:not(.hidden)').length`), 1, "one hover widget");
    evidence.push({ result: "hover ${record}", text: variable });
    await screenshot("hover-return-variable");
    await hideHover();

    // The keyword's own [Documentation]: Companion's preview shows it; it is not repeated.
    const documentation = await hoverAt("    [Documentation]    A local keyword", "local keyword", /A local keyword used to verify/);
    assert.equal(occurrences(documentation, "A local keyword used to verify native definition navigation"), 1, documentation);
    evidence.push({ result: "hover Local Step [Documentation]", text: documentation });
    await hideHover();

    // Companion's own link in the owned-mode hover, clicked with the pointer.
    const preview = await hoverAt("#> Build a typed record", "typed record", /Robot Documentation Preview[\s\S]*Open full rendered preview/);
    evidence.push({ result: "hover #> block", text: preview });
    await screenshot("hover-documentation-block");
    const link = await page(`(() => { const a = [...document.querySelectorAll('.monaco-hover:not(.hidden) a')]
      .find(e => e.textContent.trim() === 'Open full rendered preview'); if (!a) return;
      const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.ok(link, "Open full rendered preview link rendered in the hover");
    const api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    await click(link, "hover link Open full rendered preview");
    await until(() => {
      const snapshot = api.getDocumentationPreviewSnapshotForTest();
      return snapshot.visible && snapshot.documentUri === file("audit.robot").toString() && snapshot.selectedBlockId;
    }, "Documentation Preview revealed at the hovered block");
    evidence.push({ result: "hover link", preview: api.getDocumentationPreviewSnapshotForTest() });
    await screenshot("hover-link-preview");
  });

  test("symbols: Outline, Go to Symbol in Editor and in Workspace list the backend's tests and keywords", async function () {
    this.timeout(120000);
    await openAudit();
    await clickText("Debug Smoke", "Debug Smoke");
    // Outline view in the Explorer, opened with the pointer.
    await vscode.commands.executeCommand("workbench.view.explorer");
    const header = await page(`(() => { const h = [...document.querySelectorAll('.pane-header')].find(e => /^Outline/i.test(e.innerText.trim()));
      if (!h) return; const r = h.getBoundingClientRect(); return { x: r.x + 60, y: r.y + r.height / 2, expanded: h.getAttribute('aria-expanded') }; })()`);
    assert.ok(header, "Outline section header");
    // Collapse the folders section with the pointer so the Outline gets the room for all rows.
    const paneHeader = pattern => page(`(() => { const h = [...document.querySelectorAll('.pane-header')]
      .find(e => ${pattern}.test(e.getAttribute('aria-label') || e.innerText.trim())); if (!h) return;
      const r = h.getBoundingClientRect(); return { x: r.x + 60, y: r.y + r.height / 2, expanded: h.getAttribute('aria-expanded') }; })()`);
    const folders = await paneHeader("/^Explorer Section/");
    if (folders?.expanded === "true") {
      await click(folders, "Explorer folders section header (collapse)");
      await until(async () => (await paneHeader("/^Explorer Section/")).expanded === "false", "folders collapsed");
      await sleep(400); // Pane layout settles before the next pointer target is measured.
    }
    let outlineHeader = await paneHeader("/^Outline/");
    if (outlineHeader.expanded !== "true") {
      await click(outlineHeader, "Outline section header");
      await until(async () => (outlineHeader = await paneHeader("/^Outline/")).expanded === "true", "Outline expanded");
    }
    let outline;
    const outlineRows = `[...document.querySelectorAll('.pane')].find(p => /^Outline/.test(p.querySelector('.pane-header')?.innerText.trim() || ''))
      ?.querySelectorAll('.pane-body .monaco-list-row') || []`;
    await until(async () => (outline = await page(`[...${outlineRows}].map(e => e.innerText.replaceAll('\\u00a0', ' '))`))
      .some(row => /Local Step/.test(row)),
      "Outline lists the backend symbols", 30000);
    for (const name of ["Test Cases", "Debug Smoke", "Keywords", "Local Step"]) {
      assert.ok(outline.some(row => row.includes(name)), `Outline row ${name}: ${outline}`);
    }
    evidence.push({ result: "Outline", rows: outline });
    await screenshot("outline");
    if (folders?.expanded === "true") {
      const again = await page(`(() => { const r = [...document.querySelectorAll('.pane-header')].find(e => /^Explorer Section/.test(e.getAttribute('aria-label') || '')).getBoundingClientRect();
        return { x: r.x + 60, y: r.y + r.height / 2 }; })()`);
      await click(again, "Explorer folders section header (expand)");
    }

    await clickText("Debug Smoke", "Debug Smoke");
    await key("O", "KeyO", 79, 10); // Linux Ctrl+Shift+O: Go to Symbol in Editor
    let picker;
    await until(async () => (picker = await rows(".quick-input-widget .monaco-list-row")).some(row => /Local Step/.test(row)),
      "Go to Symbol in Editor entries");
    assert.ok(picker.some(row => row.includes("Debug Smoke")), `editor symbols: ${picker}`);
    assert.ok(picker.some(row => row.includes("${SUITE_VALUE}")), `editor symbols: ${picker}`);
    evidence.push({ result: "Go to Symbol in Editor", rows: picker });
    await screenshot("editor-symbols");
    await key("Escape", "Escape", 27);

    assert.ok(!vscode.window.visibleTextEditors.some(editor => editor.document.uri.path.endsWith("shared.resource")),
      "shared.resource is not open");
    await key("t", "KeyT", 84, 2); // Linux Ctrl+T: Go to Symbol in Workspace
    await until(() => visibleText(".quick-input-widget .quick-input-box input").then(value => value !== undefined), "workspace symbol picker");
    await type("Resource Step");
    await until(async () => (picker = await rows(".quick-input-widget .monaco-list-row")).some(row => /Resource Step/.test(row)),
      "Go to Symbol in Workspace finds Resource Step", 30000);
    evidence.push({ result: "Go to Symbol in Workspace", rows: picker });
    await screenshot("workspace-symbols");
    await key("Enter", "Enter", 13);
    await until(() => vscode.window.activeTextEditor?.document.uri.path.endsWith("shared.resource") &&
      vscode.window.activeTextEditor.selection.active.line === 1, "workspace symbol opens shared.resource line 2");
    evidence.push({ result: "workspace symbol opened", uri: vscode.window.activeTextEditor.document.uri.toString(),
      line: vscode.window.activeTextEditor.selection.active.line });
  });

  test("references: Shift+F12 on Build Record lists the resolved sites and never AShadow.py", async function () {
    this.timeout(120000);
    await openAudit();
    await clickText("${record}=    Build Record", "Build Record");
    await key("F12", "F12", 123, 8); // Shift+F12: Go to References (peek)
    let text;
    await until(async () => (text = await visibleText(".peekview-widget")) && /alias\.robot/.test(text) && /AuditLibrary\.py/.test(text),
      "references peek with every site", 30000);
    const title = await visibleText(".peekview-widget .peekview-title");
    const tree = await rows(".peekview-widget .monaco-list-row");
    assert.match(title, /References \(3\)|3 references/, title);
    for (const name of ["audit.robot", "alias.robot", "AuditLibrary.py"]) assert.ok(tree.some(row => row.includes(name)), `${name}: ${tree}`);
    assert.doesNotMatch(text, /AShadow/);
    assert.ok(tree.every(row => !row.includes("AShadow")));
    evidence.push({ result: "references peek", title, rows: tree });
    await screenshot("references");
    await key("Escape", "Escape", 27);
    await until(async () => !await visibleText(".peekview-widget"), "peek closed");
  });

  test("completion and signature help: keyword suggestions, ${ variables without duplicates, active parameter", async function () {
    this.timeout(120000);
    const audit = await openAudit();
    await clickText("    Log    ${record.name}", "Log");
    await key("End", "End", 35);
    await key("Enter", "Enter", 13, 0, "\r");
    await until(() => audit.lineAt(vscode.window.activeTextEditor.selection.active.line).text.trim() === "", "new empty line");
    await type("Bui");
    let suggestions;
    const suggest = async (label, timeout = 20000) => until(async () =>
      (suggestions = await rows(".suggest-widget.visible .monaco-list-row")).some(row => row.includes(label)), `suggestion ${label}`, timeout);
    try { await suggest("Build Record", 5000); }
    catch { await key(" ", "Space", 32, 2); await suggest("Build Record"); } // Ctrl+Space: Trigger Suggest
    evidence.push({ result: "keyword suggestions", rows: suggestions });
    await screenshot("completion-keyword");
    await key("Enter", "Enter", 13);
    await until(() => audit.getText().split("\n").some(line => line === "    Build Record"), "Build Record inserted");

    // Space is the backend's trigger: the active parameter shows while typing the argument.
    await type("    ");
    let hint;
    const parameterHint = async (timeout = 20000) => until(async () =>
      (hint = await visibleText(".parameter-hints-widget.visible")) && /name: str = Ada/.test(hint), "parameter hints", timeout);
    try { await parameterHint(5000); }
    catch { await key(" ", "Space", 32, 10); await parameterHint(); } // Ctrl+Shift+Space: Trigger Parameter Hints
    const active = await visibleText(".parameter-hints-widget.visible .parameter.active");
    assert.equal(active, "name: str = Ada");
    evidence.push({ result: "signature help", text: hint, activeParameter: active });
    await screenshot("signature-help");
    await key("Escape", "Escape", 27);

    await type("name=");
    await type("$");
    await type("{");
    await suggest("${");
    await type("SUITE_V");
    await suggest("${SUITE_VALUE}");
    const labels = suggestions.map(row => row.split(/,|\n/)[0].trim());
    assert.equal(new Set(labels).size, labels.length, `no duplicated suggestion: ${labels}`);
    evidence.push({ result: "variable suggestions", rows: suggestions });
    await screenshot("completion-variable");
    await key("Escape", "Escape", 27);
  });

  test("rename: F2 applies the backend's edit across files; a refused rename shows the backend's message", async function () {
    this.timeout(120000);
    // VS Code's default files.refactoring.autoSave saves what a rename changed:
    // restore the shared fixture files for the suites that follow.
    const originals = ["audit.robot", "shared.resource"].map(name => [file(name).fsPath, fs.readFileSync(file(name).fsPath, "utf8")]);
    try { await renameChecks(); }
    catch (error) { this.test.snapshotTaken = true; await failureSnapshot(this.test.title); throw error; }
    finally {
      await revertAll();
      for (const [fsPath, text] of originals) fs.writeFileSync(fsPath, text);
      await until(() => vscode.workspace.textDocuments.every(document => !originals.some(([fsPath, text]) =>
        document.uri.fsPath === fsPath && document.getText() !== text)), "fixture files restored");
    }
  });

  async function renameChecks() {
    const audit = await openAudit();
    // Refused first, on the untouched fixture: the server's own message, nothing changed.
    await clickText("    Resource Step    ${record.name}", "Resource Step");
    await key("F2", "F2", 113);
    await renameBox("Resource Step");
    await screenshot("rename-box");
    await key("a", "KeyA", 65, 2);
    await type("Bad    Name");
    await key("Enter", "Enter", 13);
    // VS Code shows a refused rename edit as a notification (a refused
    // prepare-rename as a message at the cursor); accept either place.
    let message;
    await sleep(700);
    await screenshot("rename-refused-after-enter");
    await until(async () => (message = await page(`[...document.querySelectorAll('.notifications-toasts .notification-toast, .monaco-editor-overlaymessage')]
      .filter(e => e.getClientRects().length).map(e => e.innerText).join('\\n')`)) && /more then one spaces/.test(message),
      "the backend's refusal message", 30000);
    assert.match(message, /Variable names cannot contain more then one spaces or tabs/);
    assert.ok(audit.getText().includes("    Resource Step    ${record.name}"), "refused rename changes nothing");
    assert.equal(audit.isDirty, false);
    evidence.push({ result: "refused rename", message });
    await screenshot("rename-refused");
    await key("Escape", "Escape", 27);

    await clickText("    Resource Step    ${record.name}", "Resource Step");
    await key("F2", "F2", 113);
    await renameBox("Resource Step");
    await key("a", "KeyA", 65, 2);
    await type("Shared Step");
    await key("Enter", "Enter", 13);
    await until(() => audit.getText().includes("    Shared Step    ${record.name}"), "audit.robot renamed call", 30000);
    // shared.resource is not open in an editor: read what the edit made of it.
    const resourceText = () => vscode.workspace.textDocuments.find(document => document.uri.toString() === file("shared.resource").toString())
      ?.getText() ?? fs.readFileSync(file("shared.resource").fsPath, "utf8");
    await until(() => resourceText().split("\n")[1] === "Shared Step", "the backend's edit reached shared.resource");
    assert.equal(audit.getText().includes("Resource Step"), false);
    assert.equal(resourceText().includes("Resource Step"), false);
    evidence.push({ result: "rename across files", audit: audit.getText().split("\n").find(line => line.includes("Shared Step")),
      resource: resourceText().split("\n").slice(0, 3), savedByVsCode: !audit.isDirty });
    await screenshot("rename-applied");
  }

});

"use strict";

// Owned-mode semantic highlighting from each language provider (the native
// backend and the pinned RobotCode 2.7.0 bridge), checked with actual keyboard
// and pointer input at 1280x900: a click on the token, then the Command Palette
// (Ctrl+Shift+P) runs "Developer: Inspect Editor Tokens and Scopes", and the
// inspector shows the token's text and semantic token type. Every click point
// is hit-tested first, so nothing is clicked through a hover or another widget.
// Skipped by name (pending) when a provider's prepared environment is absent;
// never reported as a pass.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
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

const INSPECT = "Developer: Inspect Editor Tokens and Scopes";
// This suite's own folder: a line with umlauts and non-BMP characters before its tokens.
const FOLDER = "integration-semantic-tokens";
const UNICODE = [
  "*** Settings ***", "Library    AuditLibrary.py", "",
  "*** Variables ***", "${GRÜSSE}    Grüße 😀", "",
  "*** Test Cases ***", "Prüfung 😀 Umlaute", "    ${wert}=    Build Record    name=Jürgen 😀",
  "    Log    Äöü 😀 ${GRÜSSE} 𝔘 ${wert.name}", ""
].join("\n");
const UNICODE_LINE = "    Log    Äöü 😀 ${GRÜSSE} 𝔘 ${wert.name}";

// Each target: the line, the token text clicked (and expected in the inspector) and its type per provider.
const AUDIT_TARGETS = [
  { name: "keyword call", line: "    ${record}=    Build Record    name=Ada", token: "Build Record",
    native: "function", robotcode: "keywordCall" },
  { name: "variable", line: "    Resource Step    ${record.name}", token: "${record.name}", native: "variable", robotcode: "variable" },
  { name: "setting", line: "Library    AuditLibrary.py", token: "Library", native: "property", robotcode: "settingImport" },
  { name: "section header", line: "*** Test Cases ***", token: "*** Test Cases ***", click: "Test Cases",
    native: "namespace", robotcode: "headerTestcase" }
];
const UNICODE_TARGETS = [
  { name: "variable after an umlaut and an emoji", line: UNICODE_LINE, token: "${GRÜSSE}", native: "variable", robotcode: "variable" },
  { name: "variable after a non-BMP letter", line: UNICODE_LINE, token: "${wert.name}", native: "variable", robotcode: "variable" },
  { name: "test name containing an emoji", line: "Prüfung 😀 Umlaute", token: "Prüfung 😀 Umlaute", click: "Umlaute",
    native: "class", robotcode: "testcaseName" }
];

const PROVIDERS = [
  {
    key: "native", title: "the native backend", available: () => Boolean(nativeExecutable),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/native-backend"))
      .nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable }),
    serverInfo: { name: "robot-companion-backend", version: "0.1.0.dev1" },
    // Whole document and range; no delta.
    offer: { full: true, range: true },
    semanticFeatures: ["semantic token ranges", "semantic tokens"]
  },
  {
    key: "robotcode", title: "the pinned RobotCode 2.7.0 language bridge", available: () => fs.existsSync(python),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"))
      .robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python }),
    serverInfo: { name: "RobotCode Language Server", version: "2.7.0" },
    // RobotCode 2.7.0 offers whole-document tokens only.
    offer: { full: true },
    semanticFeatures: ["semantic tokens"]
  }
];

for (const provider of PROVIDERS) defineSuite(provider);
defineCoexistenceSuite();

// Actual-input helpers shared by the suites: one CDP session on the workbench page.
function inputHelpers(state) {
  const { evidence } = state;
  async function page(expression) {
    const result = await state.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, state.cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!state.evidenceDirectory) return;
    const { data } = await state.cdp.send("Page.captureScreenshot", {}, state.cdp.pageSession);
    fs.writeFileSync(path.join(state.evidenceDirectory, `${state.key}-semantic-tokens-${name}.png`), Buffer.from(data, "base64"));
  }
  async function key(key, code, virtualKeyCode, modifiers = 0, label) {
    for (const type of ["keyDown", "keyUp"]) await state.cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, state.cdp.pageSession);
    evidence.push({ action: "key", key: label || key, modifiers });
  }
  async function type(text) {
    await state.cdp.send("Input.insertText", { text }, state.cdp.pageSession);
    evidence.push({ action: "type", text });
  }
  async function click(point, label) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await state.cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, state.cdp.pageSession);
      if (type === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  // The pointer leaves the editor (to the empty middle of the title bar), so no hover opens over a later target.
  async function pointerAway() {
    const point = await page(`(() => { const bar = document.querySelector('.part.titlebar'); const r = bar?.getBoundingClientRect();
      return r?.height ? { x: Math.round(r.x + r.width * 0.75), y: Math.round(r.y + r.height / 2) } : { x: 1000, y: 4 }; })()`);
    await state.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, state.cdp.pageSession);
  }
  // A layout-stable point inside `token` on the visible editor line containing `line`.
  async function textPoint(line, token, offset = 2) {
    let point, previous, blocked;
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
          const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          // Not under sticky scroll, a hover, the token inspector, another widget or another part of the window.
          // The caret and the editor's hidden input element sit at the caret position: they belong to the same editor.
          const hit = document.elementFromPoint(x, y);
          const editor = row.closest('.monaco-editor');
          const free = hit && (row.contains(hit) || (hit.closest('.monaco-editor') === editor &&
            !hit.closest('.sticky-widget, .contentWidgets, .overlayWidgets, .overflowingContentWidgets, .margin')));
          return free ? { x, y } : { blocked: hit ? hit.tagName + '.' + String(hit.className).replaceAll(' ', '.') : 'nothing' };
        }
      })()`);
      if (point?.blocked) { blocked = point.blocked; point = undefined; }
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
    }, `visible ${token} on "${line}"`).catch(error => { throw new Error(`${error.message}; last point ${JSON.stringify(previous)}, covered by ${blocked}`); });
    return point;
  }
  // Click inside `token` and check that the caret is inside it in the document (its current text).
  async function clickToken(document, target) {
    const lineOf = () => document.getText().split("\n").indexOf(target.line);
    assert.ok(lineOf() >= 0, `line "${target.line}" in ${path.basename(document.uri.fsPath)}`);
    const clicked = target.click || target.token;
    const start = target.line.indexOf(target.token), clickStart = target.line.indexOf(clicked, start);
    let lineNumber;
    for (let attempt = 1; ; attempt++) {
      await click(await textPoint(target.line, clicked), `${clicked} on "${target.line}"`);
      const inside = () => {
        const active = vscode.window.activeTextEditor?.selection.active;
        lineNumber = lineOf();
        return active?.line === lineNumber && active.character > clickStart && active.character < start + target.token.length;
      };
      try { await until(inside, `caret inside ${target.token}`, 2000); break; }
      catch (error) {
        if (attempt < 3) continue;
        const editor = vscode.window.activeTextEditor;
        throw new Error(`${error.message}; active editor ${editor?.document.uri.toString()} at ${JSON.stringify(editor?.selection.active)}, ` +
          `expected line ${lineNumber}; visible ${JSON.stringify(vscode.window.visibleTextEditors.map(item => item.document.uri.toString()))}; ` +
          `focus ${await page("String(document.activeElement?.className || document.activeElement?.tagName)")}`);
      }
    }
    await pointerAway();
    return { line: lineNumber, character: vscode.window.activeTextEditor.selection.active.character };
  }
  const visibleRows = selector => page(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(e => e.getClientRects().length).map(e => (e.innerText || e.getAttribute('aria-label') || '').replaceAll('\\u00a0', ' ').trim())`);
  // What the token inspector shows: the token's text (spaces are drawn as middle dots), its length and its table rows.
  const inspector = () => page(`(() => {
    const widget = document.querySelector('.token-inspect-widget');
    if (!widget || !widget.getClientRects().length) return;
    const heading = widget.querySelector('h2.tiw-token');
    const rows = {};
    for (const row of widget.querySelectorAll('tr')) {
      const name = row.querySelector('.tiw-metadata-key')?.innerText.trim();
      if (name) rows[name] = row.querySelector('.tiw-metadata-value')?.innerText.trim();
    }
    return { text: heading ? [...heading.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('')
      .replaceAll('\\u00b7', ' ') : undefined, length: heading?.querySelector('.tiw-token-length')?.innerText.trim(), rows,
      shown: widget.innerText.replaceAll('\\u00a0', ' ').trim() };
  })()`);
  // Ctrl+Shift+P, the command's title, Enter: the inspector opens at the caret.
  async function openInspector(ready) {
    await key("P", "KeyP", 80, 10, "Ctrl+Shift+P");
    await until(() => page(`Boolean(document.querySelector('.quick-input-widget .quick-input-box input')?.getClientRects().length)`), "Command Palette");
    await type(INSPECT);
    await until(async () => (await visibleRows(".quick-input-widget .monaco-list-row.focused")).some(row => row.includes(INSPECT)),
      `${INSPECT} is the focused command`);
    await key("Enter", "Enter", 13);
    let shown;
    await until(async () => ready(shown = await inspector()), "token inspector shows its result")
      .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(shown)}`); });
    return shown;
  }
  // Escape (on key up) closes the inspector; the next click point is free again.
  async function closeInspector() {
    await key("Escape", "Escape", 27);
    await until(async () => !(await inspector()), "token inspector closed");
  }
  return { page, screenshot, key, click, clickToken, inspector, openInspector, closeInspector };
}

// After a file is written on disk: every open document of it shows the new text.
async function settled(uri, text) {
  await until(() => vscode.workspace.textDocuments.every(document => document.uri.toString() !== uri.toString() ||
    document.getText() === text), `${path.basename(uri.fsPath)} reloaded`);
}

async function open(uri) {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

// [line, character, text, type, modifiers] of each token in VS Code's relative encoding.
function decode(tokens, legend, lines) {
  const result = [];
  let line = 0, character = 0;
  const data = tokens?.data || [];
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] ? data[index + 1] : character + data[index + 1];
    result.push([line, character, lines[line].slice(character, character + data[index + 2]), legend.tokenTypes[data[index + 3]],
      legend.tokenModifiers.filter((_, bit) => data[index + 4] & (1 << bit)).join(" ")]);
  }
  return result;
}

function defineSuite(provider) {
suite(`Owned semantic highlighting with ${provider.title} (live, actual input)`, function () {
  const state = { key: provider.key, evidence: [], evidenceDirectory: process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR };
  const ui = inputHelpers(state);
  let extension, manager, folder, config, root, originalAudit, pristineAudit;
  const auditFile = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot");
  const unicodeFile = () => vscode.Uri.joinPath(folder.uri, FOLDER, "unicode.robot");

  suiteSetup(async function () {
    if (!provider.available()) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (state.evidenceDirectory) fs.mkdirSync(state.evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    // The pristine audit corpus (an earlier suite may have saved an edit); restored afterwards.
    originalAudit = fs.readFileSync(auditFile().fsPath, "utf8");
    pristineAudit = fs.readFileSync(path.join(extension.extensionPath, "tests/integration/fixtures/audit-v1/audit.robot"), "utf8");
    fs.writeFileSync(auditFile().fsPath, pristineAudit);
    await settled(auditFile(), pristineAudit);
    await vscode.workspace.fs.writeFile(unicodeFile(), Buffer.from(UNICODE));
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "AuditLibrary.py"),
      vscode.Uri.joinPath(folder.uri, FOLDER, "AuditLibrary.py"), { overwrite: true });
    state.cdp = await WebviewCdp.connect();
    const descriptor = provider.descriptor(extension, folder);
    await config.update("languageBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", `${provider.key} running`, 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.deepEqual({ ...root.session.serverInfo }, provider.serverInfo);
    const viewport = await ui.page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "semantic highlighting checks run at 1280x900");
    // Exactly what the server advertises: its legend, whole document and/or range, never a delta.
    const advertised = root.session.capabilities.semanticTokensProvider;
    const { legend, ...offer } = advertised;
    assert.deepEqual(offer, provider.offer);
    assert.deepEqual([...root.features].filter(feature => feature.startsWith("semantic")).sort(), provider.semanticFeatures);
    const audit = await open(auditFile());
    const exposed = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri);
    assert.deepEqual([exposed.tokenTypes, exposed.tokenModifiers], [legend.tokenTypes, legend.tokenModifiers], "the backend's own legend");
    state.evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: descriptor.services.language.executable, argv: descriptor.services.language.argv, pid: root.session.child.pid,
      exposed: [...root.features], semanticTokensProvider: advertised, viewport });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await ui.screenshot(`failed-${this.currentTest.title.split(":")[0].replace(/\W+/g, "-")}`);
      state.evidence.push({ failed: this.currentTest.title, inspector: await ui.inspector().catch(() => undefined),
        backend: { state: root?.session?.state, error: root?.error, features: root && [...root.features] } });
    }
    if (await ui.inspector().catch(() => undefined)) await ui.closeInspector().catch(() => {});
  });
  suiteTeardown(async () => {
    if (!extension) return;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const child = root?.session?.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null, `${provider.key} process exit`);
    fs.writeFileSync(auditFile().fsPath, originalAudit);
    await settled(auditFile(), originalAudit);
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, FOLDER), { recursive: true });
    state.evidence.push({ cleanup: "coexistence", roots: manager.roots.size, exitCode: child?.exitCode });
    if (state.evidenceDirectory) fs.writeFileSync(path.join(state.evidenceDirectory, `${provider.key}-semantic-tokens-ui-actions.json`),
      JSON.stringify(state.evidence, null, 2));
    state.cdp?.close();
  });

  // Click the target, open the inspector from the Command Palette, read the type; the backend's own token agrees.
  async function inspect(document, target, tokens, legend) {
    const caret = await ui.clickToken(document, target);
    const shown = await ui.openInspector(value => value?.rows?.["semantic token type"]);
    const expected = target[provider.key];
    assert.equal(shown.rows["semantic token type"], expected, `${target.name}: semantic token type`);
    assert.equal(shown.text, target.token, `${target.name}: the inspector's token is exactly "${target.token}"`);
    const backend = decode(tokens, legend, document.getText().split("\n"))
      .find(([line, character, text]) => line === caret.line && character <= caret.character && caret.character < character + text.length);
    assert.equal(backend?.[2], target.token, `${target.name}: the backend's token at the caret`);
    assert.equal(backend[3], expected);
    state.evidence.push({ result: target.name, caret, inspector: shown, backendToken: backend });
    await ui.screenshot(`${target.name.replace(/\W+/g, "-")}`);
    await ui.closeInspector();
  }

  test("the token inspector shows the semantic token type of a keyword call, a variable, a setting and a section header in audit.robot", async function () {
    this.timeout(120000);
    const audit = await open(auditFile());
    assert.equal(audit.getText(), pristineAudit, "the pristine audit corpus");
    const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri);
    const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", audit.uri);
    for (const target of AUDIT_TARGETS) await inspect(audit, target, tokens, legend);
    if (provider.key === "native") {
      // The native backend's `resolved` modifier: the imported library keyword resolves (AShadow.py is not imported).
      const call = decode(tokens, legend, audit.getText().split("\n")).find(token => token[2] === "Build Record");
      assert.equal(call[4], "resolved");
    }
  });

  test("on a line with umlauts and non-BMP characters each token lands on its own characters", async function () {
    this.timeout(120000);
    const document = await open(unicodeFile());
    const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", document.uri);
    const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", document.uri);
    const lines = document.getText().split("\n");
    const onLine = decode(tokens, legend, lines).filter(([line]) => lines[line] === UNICODE_LINE).map(([, character, text, kind]) => [character, text, kind]);
    // UTF-16 columns: 😀 and 𝔘 are two code units each.
    assert.deepEqual(onLine.filter(([, , kind]) => kind === "variable"),
      [[18, "${GRÜSSE}", "variable"], [31, "${wert.name}", "variable"]]);
    for (const target of UNICODE_TARGETS) await inspect(document, target, tokens, legend);
  });
});
}

function defineCoexistenceSuite() {
suite("Coexistence: no semantic tokens provider, the editor's existing highlighting is unchanged (actual input)", function () {
  const state = { key: "coexistence", evidence: [], evidenceDirectory: process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR };
  const ui = inputHelpers(state);
  let extension, folder;

  suiteSetup(async function () {
    this.timeout(60000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    folder = vscode.workspace.workspaceFolders[0];
    state.cdp = await WebviewCdp.connect();
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await ui.screenshot("failed-coexistence");
      state.evidence.push({ failed: this.currentTest.title, inspector: await ui.inspector().catch(() => undefined) });
    }
  });
  suiteTeardown(async () => {
    if (await ui.inspector().catch(() => undefined)) await ui.closeInspector().catch(() => {});
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (state.evidenceDirectory) fs.writeFileSync(path.join(state.evidenceDirectory, "coexistence-semantic-tokens-ui-actions.json"),
      JSON.stringify(state.evidence, null, 2));
    state.cdp?.close();
  });

  test("the token inspector finds no semantic token on Build Record; Robot Companion contributes no TextMate grammar", async function () {
    this.timeout(60000);
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(config.get("integrationMode"), "coexistence");
    const manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
    assert.equal(manager.roots.size, 0, "no owned language process");
    const audit = await open(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot"));
    assert.equal(audit.languageId, "robotframework");
    assert.equal(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri), undefined,
      "no semantic tokens provider");
    assert.equal(extension.packageJSON.contributes.grammars, undefined, "Robot Companion contributes no TextMate grammar");
    await ui.clickToken(audit, AUDIT_TARGETS[0]);
    const shown = await ui.openInspector(value => value?.shown);
    assert.equal(shown.shown, "No grammar or semantic tokens available.");
    state.evidence.push({ result: "coexistence inspector", inspector: shown });
    await ui.screenshot("no-provider");
    await ui.closeInspector();
  });
});
}

"use strict";

// Owned-mode code actions and formatting from each language provider (the
// native backend and the pinned RobotCode 2.7.0 bridge), driven by actual
// keyboard and pointer input at 1280x900: the diagnostic in the Problems view
// and as a squiggle, the lightbulb and Ctrl+., choosing an entry of the
// quick-fix/refactor menu, Shift+Alt+F, the Command Palette and Format Selection.
// Assertions are on what VS Code shows and on the resulting file text. Skipped
// by name (pending) when a provider's prepared environment is absent; never
// reported as a pass.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
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

// Fixture folder of this suite. Its keyword names exist nowhere else in the
// workspace, so "the only workspace file defining it" is unambiguous.
const FOLDER = "integration-code-actions";
const FIXTURE = {
  "steps.resource": "*** Keywords ***\nQuick Fix Step\n    [Arguments]    ${value}\n    Log    ${value}\n",
  "quickfix.robot": "*** Test Cases ***\nQuick Fix Import\n    Quick Fix Step    from-quick-fix\n",
  "FirstLibrary.py": "from robot.api.deco import keyword\n\n\n@keyword(\"Twin Step\")\ndef first_twin():\n    return \"first\"\n",
  "SecondLibrary.py": "from robot.api.deco import keyword\n\n\n@keyword(\"Twin Step\")\ndef second_twin():\n    return \"second\"\n",
  "ambiguous.robot": "*** Settings ***\nLibrary    FirstLibrary.py\nLibrary    SecondLibrary.py\n\n*** Test Cases ***\nAmbiguous Call\n    Twin Step\n",
  "refactor.robot": "*** Test Cases ***\nRefactor Me\n    Log    first\n    Log    second\n",
  "messy.robot": "*** Test Cases ***\nMessy Lines\n  Log   one\n  Log   two\n",
  // Native source action: two imports for three unresolved calls, in a CRLF file with non-ASCII text.
  "source-steps.resource": "*** Keywords ***\nImported Step 😀\n    [Arguments]    ${value}\n    Log    ${value}\n",
  "SourceLib.py": "def source_lib_step(value):\n    return value\n",
  "imports.robot": ["*** Settings ***", "Documentation    Söurce actions 😀: documentation kept as written.",
    "# A comment kept   as written.", "", "*** Test Cases ***", "Imports Needed 😀", "    Imported Step 😀    from-source-action",
    "    ${value}=    Source Lib Step    ünïcode-😀", "    Imported Step 😀    ${value}", "    Should Be Equal    ${value}    ünïcode-😀", ""].join("\r\n"),
  // Native Format Selection and on-type formatting.
  "selection.robot": "*** Test Cases ***\nSelection Lines\n    [Tags]    b    a\n    [Documentation]    Döc 😀  kept\n  Log   one 😀\n" +
    "  Log   two   # keep   spacing\n  Log Many   three\n  ...   four\n",
  "typing.robot": "*** Test Cases ***\nTyped Steps\n    Log    first\n",
  // The hover of the call on line 4 opens over the line above it.
  "hover.robot": "*** Test Cases ***\nHover Cover\n    Log    hover-target\n    Hover Step\n\n*** Keywords ***\nHover Step\n" +
    "    [Documentation]    Short documentation shown in the hover.\n    No Operation\n"
};
// imports.robot after Add all missing imports: both imports after the Settings header, CRLF kept.
const IMPORTED = FIXTURE["imports.robot"].replace("*** Settings ***\r\n",
  "*** Settings ***\r\nResource    source-steps.resource\r\nLibrary    SourceLib.py\r\n");
// audit.robot after Robocop 9.1.0's default formatters (both providers use them).
const FORMATTED_AUDIT = [
  "*** Settings ***", "Library     AuditLibrary.py", "Resource    shared.resource", "", "",
  "*** Variables ***", "${SUITE_VALUE}    from-suite", "", "",
  "*** Test Cases ***", "Debug Smoke",
  "    [Documentation]    Robot Companion replacement audit: navigation and debugging.",
  "    #> Build a typed record and inspect it in the debugger.",
  "    ${record}=    Build Record    name=Ada", "    Resource Step    ${record.name}", "    Local Step", "    Log    ${record.name}",
  "", "", "*** Keywords ***", "Local Step",
  "    [Documentation]    A local keyword used to verify native definition navigation.", "    Log    local-step", ""
].join("\n");

const PROVIDERS = [
  {
    key: "native", title: "the native backend", available: () => Boolean(nativeExecutable),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/native-backend"))
      .nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable }),
    robot: () => path.join(path.dirname(nativeExecutable), "robot"),
    serverInfo: { name: "robot-companion-backend", version: "0.1.0.dev13" },
    features: ["code actions", "completion", "definitions", "document symbols", "formatting", "hover", "inlay hints", "on-type formatting",
      "range formatting", "references", "rename", "semantic token ranges", "semantic tokens", "signature help", "workspace symbols"],
    unknownSeverity: "error"
  },
  {
    key: "robotcode", title: "the pinned RobotCode 2.7.0 language bridge", available: () => fs.existsSync(python),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"))
      .robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python }),
    robot: () => path.join(path.dirname(python), "robot"),
    serverInfo: { name: "RobotCode Language Server", version: "2.7.0" },
    features: ["code actions", "completion", "definitions", "document symbols", "formatting", "hover", "inlay hints", "range formatting",
      "references", "rename", "semantic tokens", "signature help", "workspace symbols"],
    unknownSeverity: "error"
  }
];

for (const provider of PROVIDERS) defineSuite(provider);

function defineSuite(provider) {
suite(`Owned code actions and formatting with ${provider.title} (live, actual input)`, function () {
  let extension, manager, folder, config, cdp, root, api;
  const evidence = [];
  const requests = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => vscode.Uri.joinPath(folder.uri, FOLDER, name);
  const auditFile = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot");

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `${provider.key}-code-actions-${name}.png`), Buffer.from(data, "base64"));
  }
  // `text`: the character the key types (Enter in an editor types "\r").
  async function key(key, code, virtualKeyCode, modifiers = 0, label, text) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers,
      ...(text && type === "keyDown" ? { text, unmodifiedText: text } : {})
    }, cdp.pageSession);
    evidence.push({ action: "key", key: label || key, modifiers });
  }
  const typeEnter = () => key("Enter", "Enter", 13, 0, "Enter (typed)", "\r");
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
  // One hit test of the point inside `token` on the visible editor line containing `line`: { x, y } when a click
  // there reaches that line, else { x, y, blocked } naming the element on top (from its editor layer down).
  // Allowed: the line itself and this editor's caret and hidden input element, which sit at the caret position.
  // Anything else covers the point: hover/suggest/parameter hints (.overflowingContentWidgets), other widgets,
  // sticky scroll, the margin, another editor or another part of the window.
  const hitTest = (line, token, offset = 2) => page(`(() => {
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
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      const editor = row.closest('.monaco-editor');
      if (hit && (row.contains(hit) || (hit.closest('.monaco-editor') === editor &&
        hit.matches('.cursors-layer .cursor, textarea.inputarea, .native-edit-context')))) return { x, y };
      if (!hit) return { x, y, blocked: 'nothing' };
      const hitEditor = hit.closest('.monaco-editor'), chain = [];
      for (let el = hit; el && el !== hitEditor && el !== document.body && chain.length < (hitEditor ? 40 : 6); el = el.parentElement) {
        chain.unshift(el.tagName + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : ''));
      }
      return { x, y, blocked: chain.join(' > ') + (hitEditor === editor ? '' : hitEditor ? ' (in another editor)' : ' (outside any editor)') };
    }
  })()`);
  // A layout-stable point inside `token` on the visible editor line containing `line`, free for a click.
  async function textPoint(line, token, offset = 2) {
    let point, previous, blocked;
    await until(async () => {
      point = await hitTest(line, token, offset);
      if (point?.blocked) { blocked = point.blocked; point = undefined; }
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
    }, `visible ${token} on "${line}"`).catch(error => { throw new Error(`${error.message}; last point ${JSON.stringify(previous)}, covered by ${blocked}`); });
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
  async function open(uri) {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }
  // The squiggle VS Code draws under `token` on the editor line containing `line`.
  const squiggle = (line, token, kind) => page(`(() => {
    const row = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
      .find(el => el.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(line)}));
    if (!row) return false;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node, word;
    while (node = walker.nextNode()) {
      const start = node.textContent.replaceAll('\\u00a0', ' ').indexOf(${JSON.stringify(token)});
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + ${token.length});
      word = range.getBoundingClientRect();
      break;
    }
    if (!word) return false;
    return [...document.querySelectorAll('.editor-instance .monaco-editor .squiggly-${kind}')].some(el => {
      const r = el.getBoundingClientRect();
      return r.width && Math.abs(r.top - row.getBoundingClientRect().top) < 3 && r.left < word.right && r.right > word.left;
    });
  })()`);
  const visibleRows = selector => page(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(e => e.getClientRects().length).map(e => (e.innerText || e.getAttribute('aria-label') || '').replaceAll('\\u00a0', ' ').trim())`);
  // A menu row is exactly its title (rows have no other text).
  const count = (rows, title) => rows.filter(row => row === title).length;
  // Entries of the open code action menu (quick fix / refactor), headers included.
  const menuRows = () => visibleRows(".action-widget .monaco-list-row");
  async function menu(expected, label, timeoutMs = 30000) {
    let rows;
    await until(async () => count(rows = await menuRows(), expected) > 0, `${label}: ${expected}`, timeoutMs)
      .catch(error => { throw new Error(`${error.message}; menu rows: ${JSON.stringify(rows)}`); });
    return rows;
  }
  // Choose a menu entry with the pointer.
  async function chooseWithPointer(title) {
    const point = await page(`(() => { const row = [...document.querySelectorAll('.action-widget .monaco-list-row')]
      .find(e => e.getClientRects().length && e.innerText.replaceAll('\\u00a0', ' ').trim() === ${JSON.stringify(title)});
      if (!row) return; const r = row.getBoundingClientRect(); return { x: r.x + Math.min(80, r.width / 2), y: r.y + r.height / 2 }; })()`);
    assert.ok(point, `menu entry ${title}`);
    await click(point, `menu entry ${title}`);
  }
  // Choose a menu entry with the keyboard: Down until it is focused, then Enter.
  async function chooseWithKeyboard(title) {
    for (let step = 0; step < 12; step++) {
      const focused = await page(`(() => { const row = document.querySelector('.action-widget .monaco-list-row.focused');
        return row ? row.innerText.replaceAll('\\u00a0', ' ').trim() : ''; })()`);
      if (focused === title) { await key("Enter", "Enter", 13); return; }
      await key("ArrowDown", "ArrowDown", 40);
      await sleep(100);
    }
    throw new Error(`menu entry ${title} never focused`);
  }
  const ctrlDot = () => key(".", "Period", 190, 2, "Ctrl+.");
  // Problems view (Ctrl+Shift+M), filtered by typing `filter` into its filter box (Ctrl+F there):
  // the rows naming `message`. Other open files' diagnostics would otherwise push them out of view.
  async function problems(message, filter) {
    await key("M", "KeyM", 77, 10, "Ctrl+Shift+M");
    await until(() => page(`Boolean(document.querySelector('.markers-panel')?.getClientRects().length &&
      document.activeElement?.closest('.pane-body, .panel'))`), "Problems view focused");
    const filterFocused = () => page(`Boolean(document.activeElement?.closest('.viewpane-filter, .markers-panel-action-filter, .monaco-inputbox'))`);
    for (let attempt = 1; ; attempt++) {
      await key("f", "KeyF", 70, 2, "Ctrl+F");
      try { await until(filterFocused, "Problems filter box focused", 3000); break; }
      catch (error) { if (attempt === 3) throw error; }
    }
    await key("a", "KeyA", 65, 2, "Ctrl+A");
    await type(filter);
    let rows;
    await until(async () => (rows = (await visibleRows(".markers-panel .monaco-list-row")).filter(row => row.includes(message))).length > 0,
      `Problems view lists "${message}"`, 30000);
    return rows;
  }
  const diagnosticsOf = (uri, message) => vscode.languages.getDiagnostics(uri).filter(item => item.message === message);
  // The backend's replies to these requests, recorded as they arrive.
  const replies = method => requests.filter(entry => entry.method === method && entry.done);
  // Run a command from the Command Palette: type its name, wait until it is the focused entry, Enter.
  async function commandPalette(command, pattern) {
    await key("P", "KeyP", 80, 10, "Ctrl+Shift+P");
    await until(() => page(`Boolean(document.querySelector('.quick-input-widget .quick-input-box input')?.getClientRects().length)`), "Command Palette");
    await type(command);
    await until(async () => (await visibleRows(".quick-input-widget .monaco-list-row.focused")).some(row => pattern.test(row)),
      `${command} is the focused command`);
    await key("Enter", "Enter", 13);
  }
  const toasts = () => visibleRows(".notifications-toasts .notification-list-item-message");
  // The lines of this test profile's VS Code window logs.
  const workbenchLog = () => {
    const lines = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (entry.name.endsWith(".log") && /window/.test(directory)) lines.push(...fs.readFileSync(target, "utf8").split("\n"));
      }
    };
    visit(path.join(process.env.ROBOT_COMPANION_UI_USER_DATA_DIR, "logs"));
    return lines;
  };
  // A visible button of the workbench (outside editors) labelled exactly `label`.
  const buttonPoint = label => page(`(() => { const b = [...document.querySelectorAll('.monaco-workbench .monaco-button')]
    .find(e => e.getClientRects().length && e.innerText.trim() === ${JSON.stringify(label)} && !e.closest('.editor-instance'));
    if (!b) return; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  // Select the whole line containing `line` with the keyboard (click, Home, Shift+End).
  async function selectLine(line, token) {
    await clickText(line, token);
    await key("Home", "Home", 36);
    await key("End", "End", 35, 8, "Shift+End");
    await until(() => vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection) === line.trim(),
      `"${line.trim()}" selected`);
  }
  // Click the Run Test CodeLens above the test `name` (pointer) and wait for the run's notification.
  async function runFromCodeLens(name) {
    api.clearLastRunNotificationForTest();
    let lens, previous;
    await until(async () => {
      lens = await page(`(() => {
        const line = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')].find(el => el.innerText.replaceAll('\\u00a0', ' ').trim() === ${JSON.stringify(name)});
        if (!line) return;
        const top = line.getBoundingClientRect().top;
        const link = [...document.querySelectorAll('.editor-instance .monaco-editor .codelens-decoration a')].filter(a => a.textContent.trim() === 'Run Test')
          .map(a => ({ a, rect: a.getBoundingClientRect() })).find(({ rect }) => rect.bottom <= top + 1 && top - rect.bottom < 30);
        if (!link) return;
        const x = link.rect.x + link.rect.width / 2, y = link.rect.y + link.rect.height / 2;
        return link.a.contains(document.elementFromPoint(x, y)) || document.elementFromPoint(x, y) === link.a ? { x, y } : undefined;
      })()`);
      const stable = lens && previous && lens.x === previous.x && lens.y === previous.y;
      previous = lens;
      if (!stable) await sleep(200);
      return stable;
    }, `Run Test CodeLens above ${name}`, 30000);
    await click(lens, `Run Test CodeLens (${name})`);
    await until(() => api.getLastRunNotificationForTest()?.message, `${name} run finished`, 90000);
    return { notification: api.getLastRunNotificationForTest().message, output: api.getLastRunOutputForTest() };
  }
  async function revertAll() {
    for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }
  async function writeFixture() {
    for (const [name, text] of Object.entries(FIXTURE)) await vscode.workspace.fs.writeFile(file(name), Buffer.from(text));
  }

  suiteSetup(async function () {
    if (!provider.available()) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    api = activatedExtensionApi(extension.extensionPath);
    manager = api.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await writeFixture();
    cdp = await WebviewCdp.connect();
    const descriptor = provider.descriptor(extension, folder);
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", provider.robot(), vscode.ConfigurationTarget.Workspace);
    await config.update("languageBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", `${provider.key} running`, 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.deepEqual({ ...root.session.serverInfo }, provider.serverInfo);
    // Record the backend's code action and formatting replies (the session is the real one).
    const request = root.session.request.bind(root.session);
    root.session.request = (method, params, options) => {
      const entry = { method, at: Date.now(), only: params?.context?.only, uri: params?.textDocument?.uri, range: params?.range };
      if (/codeAction|ormatting/.test(method)) requests.push(entry);
      return request(method, params, options).then(result => Object.assign(entry, { done: true, result }).result,
        error => { Object.assign(entry, { done: true, error: error.message }); throw error; });
    };
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "code action and formatting checks run at 1280x900");
    assert.deepEqual([...root.features].sort(), provider.features, "one provider per advertised capability");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: descriptor.services.language.executable, argv: descriptor.services.language.argv, pid: root.session.child.pid,
      exposed: [...root.features], codeActionProvider: root.session.capabilities.codeActionProvider,
      documentFormattingProvider: root.session.capabilities.documentFormattingProvider ?? null,
      documentRangeFormattingProvider: root.session.capabilities.documentRangeFormattingProvider ?? null, viewport });
  });
  async function failureSnapshot(title) {
    if (!evidenceDirectory) return;
    const name = title.split(":")[0].replace(/\W+/g, "-");
    await screenshot(`failed-${name}`);
    evidence.push({ failed: title, menu: await menuRows().catch(() => []),
      editor: vscode.window.activeTextEditor?.document.getText(), message: await visibleRows(".monaco-editor-overlaymessage").catch(() => []),
      requests: requests.map(({ method, done, result, error }) => ({ method, done, error,
        result: Array.isArray(result) ? result.map(item => item.title ? `${item.title}${item.disabled ? " (disabled)" : ""}` : "edit") : result })),
      backend: { state: root?.session?.state, error: root?.error, features: root && [...root.features] } });
  }
  teardown(async function () {
    if (this.currentTest?.state === "failed") await failureSnapshot(this.currentTest.title);
    await key("Escape", "Escape", 27).catch(() => {});
    await revertAll();
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await writeFixture();
  });
  suiteTeardown(async () => {
    if (!extension) return;
    // Leave the Problems filter empty for later suites.
    await key("M", "KeyM", 77, 10, "Ctrl+Shift+M");
    await key("f", "KeyF", 70, 2, "Ctrl+F");
    await key("a", "KeyA", 65, 2, "Ctrl+A");
    await key("Backspace", "Backspace", 8);
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await revertAll();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const child = root?.session?.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    await manager.queue;
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null, `${provider.key} process exit`);
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, FOLDER), { recursive: true });
    evidence.push({ cleanup: "coexistence", roots: manager.roots.size, exitCode: child?.exitCode });
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `${provider.key}-code-actions-ui-actions.json`), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  const UNKNOWN = "No keyword with name 'Quick Fix Step' found.";

  if (provider.key === "native") {
    test("quick fix: the unresolved-keyword diagnostic shows in Problems and as a squiggle; Ctrl+. offers add-import, which removes it", async function () {
      this.timeout(120000);
      const document = await open(file("quickfix.robot"));
      await until(() => diagnosticsOf(document.uri, UNKNOWN).length === 1, "native unresolved-keyword diagnostic", 30000);
      await until(() => squiggle("    Quick Fix Step", "Quick Fix Step", provider.unknownSeverity), "error squiggle under Quick Fix Step");
      const listed = await problems(UNKNOWN, "Quick Fix Step");
      assert.ok(listed.some(row => /\[Ln 3, Col 5\]/.test(row)), JSON.stringify(listed));
      evidence.push({ result: "Problems view", rows: listed });
      await screenshot("problems-unknown-keyword");

      await clickText("    Quick Fix Step", "Quick Fix Step");
      await ctrlDot();
      const rows = await menu("Import resource steps.resource", "Ctrl+. menu");
      assert.equal(count(rows, "Import resource steps.resource"), 1, `no duplicate entry: ${rows}`);
      evidence.push({ result: "Ctrl+. menu", rows });
      await screenshot("menu-add-import");
      await chooseWithPointer("Import resource steps.resource");
      const expected = "*** Settings ***\nResource    steps.resource\n\n" + FIXTURE["quickfix.robot"];
      await until(() => document.getText() === expected, "the import is inserted", 30000)
        .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
      await until(() => diagnosticsOf(document.uri, UNKNOWN).length === 0, "the diagnostic disappears", 30000);
      await until(async () => !await squiggle("    Quick Fix Step", "Quick Fix Step", provider.unknownSeverity), "the squiggle disappears");
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0, "no diagnostic remains in the fixed file");
      evidence.push({ result: "add import applied", text: document.getText() });
      await screenshot("add-import-applied");
    });

    test("quick fix: an ambiguous call's warning offers qualify-with-library from the lightbulb; applying it removes the warning", async function () {
      this.timeout(120000);
      const document = await open(file("ambiguous.robot"));
      const isAmbiguous = item => /Twin Step/.test(item.message) && item.severity === vscode.DiagnosticSeverity.Warning;
      await until(() => vscode.languages.getDiagnostics(document.uri).some(isAmbiguous), "native ambiguity warning", 30000);
      const warning = vscode.languages.getDiagnostics(document.uri).find(isAmbiguous);
      assert.match(warning.message, /FirstLibrary\.Twin Step \(FirstLibrary\.py\)/);
      assert.match(warning.message, /SecondLibrary\.Twin Step \(SecondLibrary\.py\)/);
      await until(() => squiggle("    Twin Step", "Twin Step", "warning"), "warning squiggle under Twin Step");
      const listed = await problems("Twin Step", "Twin Step");
      evidence.push({ result: "Problems view (ambiguity)", rows: listed });
      await screenshot("problems-ambiguous");

      await clickText("    Twin Step", "Twin Step");
      // The lightbulb VS Code shows on the call's line (layout-stable: CodeLenses move lines), clicked with the pointer.
      let bulb, previous;
      await until(async () => {
        bulb = await page(`(() => {
          const row = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
            .find(el => el.innerText.replaceAll('\\u00a0', ' ') === '    Twin Step');
          if (!row) return;
          const line = row.getBoundingClientRect();
          const el = [...document.querySelectorAll('.editor-instance .monaco-editor .lightBulbWidget, .editor-instance .monaco-editor [class*="codicon-lightbulb"], .editor-instance .monaco-editor .codicon-light-bulb')]
            .find(e => { const r = e.getBoundingClientRect(); return r.width && r.top + r.height / 2 > line.top && r.top + r.height / 2 < line.bottom; });
          if (!el) return; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const stable = bulb && previous && bulb.x === previous.x && bulb.y === previous.y;
        previous = bulb;
        if (!stable) await sleep(200);
        return stable;
      }, "lightbulb on the Twin Step line", 30000);
      await screenshot("lightbulb");
      await click(bulb, "lightbulb");
      const rows = await menu("Use FirstLibrary.Twin Step (FirstLibrary.py)", "lightbulb menu");
      assert.equal(count(rows, "Use SecondLibrary.Twin Step (SecondLibrary.py)"), 1, JSON.stringify(rows));
      for (const title of ["Use FirstLibrary.Twin Step (FirstLibrary.py)", "Use SecondLibrary.Twin Step (SecondLibrary.py)"]) {
        assert.equal(count(rows, title), 1, `no duplicate entry: ${rows}`);
      }
      evidence.push({ result: "lightbulb menu", rows });
      await screenshot("menu-qualify");
      await chooseWithKeyboard("Use FirstLibrary.Twin Step (FirstLibrary.py)");
      await until(() => document.getText() === FIXTURE["ambiguous.robot"].replace("    Twin Step\n", "    FirstLibrary.Twin Step\n"),
        "the call is qualified", 30000).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
      await until(() => !vscode.languages.getDiagnostics(document.uri).some(item => /Twin Step/.test(item.message)), "the warning disappears", 30000);
      await until(async () => !await squiggle("    FirstLibrary.Twin Step", "Twin Step", "warning"), "the warning squiggle disappears");
      evidence.push({ result: "qualify applied", text: document.getText() });
      await screenshot("qualify-applied");
    });
  } else {
    test("quick fix: RobotCode's unresolved-keyword diagnostic shows in Problems and as a squiggle; Ctrl+. Create Keyword applies its edit and selection", async function () {
      this.timeout(120000);
      const document = await open(file("quickfix.robot"));
      await until(() => diagnosticsOf(document.uri, UNKNOWN).length === 1, "RobotCode unresolved-keyword diagnostic", 60000);
      await until(() => squiggle("    Quick Fix Step", "Quick Fix Step", provider.unknownSeverity), "error squiggle under Quick Fix Step");
      const listed = await problems(UNKNOWN, "Quick Fix Step");
      evidence.push({ result: "Problems view", rows: listed });
      await screenshot("problems-unknown-keyword");

      await clickText("    Quick Fix Step", "Quick Fix Step");
      await ctrlDot();
      const title = "Create Keyword `Quick Fix Step`";
      const rows = await menu(title, "Ctrl+. menu");
      assert.equal(count(rows, title), 1, `no duplicate entry: ${rows}`);
      assert.equal(count(rows, "Assign keyword result to variable"), 1, `RobotCode's refactoring is offered too: ${rows}`);
      assert.ok(!rows.some(row => row.includes("Open Documentation")), "no action whose command only RobotCode's extension runs");
      evidence.push({ result: "Ctrl+. menu", rows });
      await screenshot("menu-create-keyword");
      await chooseWithPointer(title);
      await until(() => /\*\*\* Keywords \*\*\*\nQuick Fix Step\n {4}\[Arguments\] {4}\$\{arg1\}\n/.test(document.getText()),
        "RobotCode's resolved edit created the keyword", 30000).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
      assert.ok(document.getText().startsWith(FIXTURE["quickfix.robot"].trimEnd()), "the test case is unchanged");
      // RobotCode's follow-up command, translated by the bridge: the new keyword's placeholder step is selected.
      await until(() => vscode.window.activeTextEditor?.document === document &&
        document.getText(vscode.window.activeTextEditor.selection) === "Fail    Not Implemented" &&
        document.lineAt(vscode.window.activeTextEditor.selection.start.line - 1).text.includes("# TODO: implement keyword"),
      "the created keyword's placeholder step is selected");
      await until(() => diagnosticsOf(document.uri, UNKNOWN).length === 0, "the diagnostic disappears", 60000);
      await until(async () => !await squiggle("    Quick Fix Step", "Quick Fix Step", provider.unknownSeverity), "the squiggle disappears");
      assert.ok(replies("codeAction/resolve").length >= 1, "the edit came from codeAction/resolve");
      evidence.push({ result: "Create Keyword applied", text: document.getText(),
        selection: vscode.window.activeTextEditor.selection.start.line + 1 });
      await screenshot("create-keyword-applied");
    });

    test("refactorings: Ctrl+Shift+R on a selected call lists RobotCode's extract and surround actions; each applies its edit; no source action is shown", async function () {
      this.timeout(150000);
      const document = await open(file("refactor.robot"));
      const original = FIXTURE["refactor.robot"];
      const selectCall = async () => {
        await clickText("    Log    first", "first");
        await key("Home", "Home", 36);
        await key("End", "End", 35, 8, "Shift+End");
        await until(() => document.getText(vscode.window.activeTextEditor.selection) === "Log    first", "the Log call is selected");
      };
      const apply = async (title, expected, chooser) => {
        let rows;
        // Right after an undo the menu can miss its first request: Escape and press again (recorded).
        for (let attempt = 1; ; attempt++) {
          await selectCall();
          await key("R", "KeyR", 82, 10, "Ctrl+Shift+R");
          try { rows = await menu(title, "Refactor menu", 10000); break; }
          catch (error) {
            evidence.push({ retry: `Refactor menu for ${title}`, attempt, message: await visibleRows(".monaco-editor-overlaymessage") });
            if (attempt === 3) throw error;
            await key("Escape", "Escape", 27);
          }
        }
        assert.equal(count(rows, title), 1, `no duplicate entry: ${rows}`);
        evidence.push({ result: `Refactor menu for ${title}`, rows });
        await screenshot(`refactor-${title.replace(/\W+/g, "-")}`);
        await chooser(title);
        await until(() => expected(document.getText()), `${title} applied`, 30000)
          .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
        evidence.push({ result: `${title} applied`, text: document.getText() });
        await key("z", "KeyZ", 90, 2, "Ctrl+Z");
        await until(() => document.getText() === original, `${title} undone`);
        return rows;
      };
      const rows = await apply("Surround with TRY...EXCEPT", text => text.includes("    TRY\n        Log    first\n    EXCEPT    message\n"),
        chooseWithPointer);
      for (const title of ["Extract keyword", "Surround with TRY...FINALLY", "Surround with TRY...EXCEPT..FINALLY"]) {
        assert.equal(count(rows, title), 1, `${title}: ${rows}`);
      }
      await apply("Extract keyword", text => /^ {4}New Keyword$/m.test(text) && /\nNew Keyword\n {4}Log {4}first\n/.test(text), chooseWithKeyboard);
      await apply("Assign keyword result to variable", text => text.includes("    ${new_variable}    Log    first\n"), chooseWithKeyboard);

      // Source Action... from the Command Palette: RobotCode's only source action needs its own extension's command.
      await clickText("    Log    first", "first");
      await key("P", "KeyP", 80, 10, "Ctrl+Shift+P");
      await until(() => page(`Boolean(document.querySelector('.quick-input-widget .quick-input-box input')?.getClientRects().length)`), "Command Palette");
      await type("Source Action...");
      await until(async () => (await visibleRows(".quick-input-widget .monaco-list-row.focused")).some(row => /^Source Action/.test(row)),
        "Source Action is the focused command");
      // What Companion's code action provider returned to VS Code for each request, recorded as it returns.
      const exposed = [];
      const provide = manager.codeActions;
      manager.codeActions = async (...args) => {
        const result = await provide.apply(manager, args);
        exposed.push({ only: args[2]?.only?.value, actions: (result || []).map(action => ({ title: action.title, kind: action.kind?.value })) });
        return result;
      };
      const isSource = kind => kind === "source" || String(kind).startsWith("source.");
      const sourceRequests = () => requests.filter(entry => entry.method === "textDocument/codeAction" && entry.done &&
        (entry.only || []).some(isSource));
      const before = sourceRequests().length;
      try {
        await key("Enter", "Enter", 13);
        // (a) The Source Action... input sent RobotCode a source-only request; nothing it returned is exposed as a source action.
        await until(() => sourceRequests().length > before && exposed.some(entry => isSource(entry.only)),
          "a source-only code action request and its provider result", 15000);
      } finally { manager.codeActions = provide; }
      const replies = sourceRequests().slice(before);
      const returned = replies.flatMap(entry => (entry.result || []).map(item => item.title));
      const offered = exposed.filter(entry => isSource(entry.only)).flatMap(entry => entry.actions).filter(action => isSource(action.kind));
      evidence.push({ result: "Source Action request", only: replies.map(entry => entry.only), returnedByRobotCode: returned,
        exposedByCompanion: offered });
      assert.deepEqual(offered, [], "no source action is exposed");
      // (b) After the response and a fixed settle, no code action menu is visible. The transient
      // "No source actions available" message is recorded when it is still shown, not required.
      await sleep(1000);
      const message = (await visibleRows(".monaco-editor-overlaymessage")).join(" ");
      const widget = await page(`[...document.querySelectorAll('.action-widget, .action-widget .monaco-list-row')]
        .filter(e => e.getClientRects().length).length`);
      assert.equal(widget, 0, `no code action menu is visible: ${JSON.stringify(await menuRows())}`);
      evidence.push({ result: "Source Action", visibleActionWidgets: widget, message: message || "(not shown at check time)" });
      await screenshot("no-source-actions");
    });

    test("Open Documentation: where RobotCode returns it, Companion's code action provider does not expose it", async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      // Each position: a Library and a Resource import name, a keyword call name and a keyword definition name.
      const positions = [
        { label: "Library import name", uri: file("ambiguous.robot"), text: "Library    FirstLibrary.py", token: "FirstLibrary" },
        { label: "Resource import name", uri: auditFile(), text: "Resource    shared.resource", token: "shared" },
        { label: "keyword call name", uri: file("refactor.robot"), text: "    Log    first", token: "Log" },
        { label: "keyword definition name", uri: file("steps.resource"), text: "Quick Fix Step", token: "Fix" }
      ];
      const exposed = [];
      const provide = manager.codeActions;
      manager.codeActions = async (...args) => {
        const result = await provide.apply(manager, args);
        exposed.push({ only: args[2]?.only?.value,
          actions: (result || []).map(action => ({ title: action.title, kind: action.kind?.value })) });
        return result;
      };
      const tried = [];
      try {
        for (const position of positions) {
          const document = await vscode.workspace.openTextDocument(position.uri);
          const line = document.getText().split("\n").findIndex(text => text.startsWith(position.text));
          assert.ok(line >= 0, `${position.label}: ${position.text}`);
          const character = document.lineAt(line).text.indexOf(position.token) + 1;
          for (const only of ["source", undefined]) {
            const at = new vscode.Range(line, character, line, character);
            const same = entry => entry.uri === document.uri.toString() && entry.range?.start.line === line &&
              entry.range.start.character === character && (entry.only || [])[0] === only;
            const before = requests.length, shown = exposed.length;
            const returned = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", document.uri, at, only);
            await until(() => requests.slice(before).some(entry => entry.method === "textDocument/codeAction" && entry.done && same(entry)),
              `${position.label} (only ${only}) reply`, 15000);
            const reply = requests.slice(before).filter(entry => entry.method === "textDocument/codeAction" && entry.done && same(entry));
            tried.push({ position: position.label, file: path.basename(position.uri.fsPath), line: line + 1, character: character + 1, only: only ?? "(unfiltered)",
              robotCode: reply.flatMap(entry => (entry.result || []).map(item => ({ title: item.title, kind: item.kind, command: item.command?.command }))),
              companion: exposed.slice(shown).flatMap(entry => entry.actions),
              vscode: (returned || []).map(action => action.title) });
          }
        }
      } finally { manager.codeActions = provide; }
      evidence.push({ result: "Open Documentation probe", tried });
      const found = tried.filter(entry => entry.robotCode.some(item => item.title === "Open Documentation"));
      assert.ok(found.length > 0, `RobotCode returned Open Documentation somewhere: ${JSON.stringify(tried)}`);
      for (const entry of found) {
        assert.deepEqual(entry.companion.filter(action => action.title === "Open Documentation"), [], `not exposed: ${JSON.stringify(entry)}`);
        assert.ok(!entry.vscode.includes("Open Documentation"), `not offered by VS Code: ${JSON.stringify(entry)}`);
      }
    });
  }

  test("formatting: Shift+Alt+F applies the backend's edits and a second Format Document changes nothing" +
    (provider.key === "native" ? "; the audit test then passes from its Run Test CodeLens" : "; Format Selection formats only the selected line"),
  async function () {
    this.timeout(180000);
    // Earlier suites may have saved edits into the shared copy: format the audit corpus file itself.
    const originalAudit = fs.readFileSync(auditFile().fsPath, "utf8");
    const pristine = fs.readFileSync(path.join(extension.extensionPath, "tests/integration/fixtures/audit-v1/audit.robot"), "utf8");
    try {
      fs.writeFileSync(auditFile().fsPath, pristine);
      await until(() => vscode.workspace.textDocuments.every(document => document.uri.toString() !== auditFile().toString() ||
        document.getText() === pristine), "pristine audit.robot");
      const audit = await open(auditFile());
      assert.equal(audit.getText(), pristine);
      // Earlier suites leave this editor scrolled: back to the top, then click into the text.
      await key("Home", "Home", 36, 2, "Ctrl+Home");
      await clickText("Library    AuditLibrary.py", "AuditLibrary");
      const before = replies("textDocument/formatting").length;
      await key("F", "KeyF", 70, 9, "Shift+Alt+F");
      await until(() => audit.getText() === FORMATTED_AUDIT, "Format Document applied the backend's edits", 30000)
        .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(audit.getText())}`); });
      const first = replies("textDocument/formatting").slice(before);
      assert.equal(first.length, 1, "one textDocument/formatting request");
      assert.ok(first[0].result.length > 0, "the backend returned edits");
      evidence.push({ result: "Shift+Alt+F", edits: first[0].result.length, dirty: audit.isDirty });
      await screenshot("formatted");
      await key("s", "KeyS", 83, 2, "Ctrl+S");
      await until(() => !audit.isDirty && fs.readFileSync(auditFile().fsPath, "utf8") === FORMATTED_AUDIT, "formatted audit.robot saved");

      // Format again, from the Command Palette: the backend has nothing to change.
      const version = audit.version;
      await key("P", "KeyP", 80, 10, "Ctrl+Shift+P");
      await until(() => page(`Boolean(document.querySelector('.quick-input-widget .quick-input-box input')?.getClientRects().length)`), "Command Palette");
      await type("Format Document");
      await until(async () => (await visibleRows(".quick-input-widget .monaco-list-row.focused"))
        .some(row => /^Format Document(?! With)/.test(row)), "Format Document is the focused command");
      await key("Enter", "Enter", 13);
      await until(() => replies("textDocument/formatting").length === before + 2, "second formatting reply", 30000);
      const second = replies("textDocument/formatting")[before + 1].result;
      assert.ok(second === null || (Array.isArray(second) && second.length === 0), `second format returns no edits: ${JSON.stringify(second)}`);
      await sleep(500);
      assert.equal(audit.getText(), FORMATTED_AUDIT);
      assert.equal(audit.version, version, "no edit was applied");
      assert.equal(audit.isDirty, false);
      evidence.push({ result: "second format", edits: Array.isArray(second) ? second.length : second });

      if (provider.key === "native") {
        // The formatted audit test passes from its Run Test CodeLens (pointer).
        const run = await runFromCodeLens("Debug Smoke");
        assert.match(run.notification, /Debug Smoke.*passed/);
        assert.match(run.output, /1 test, 1 passed, 0 failed/);
        evidence.push({ result: "formatted audit test run from its CodeLens", notification: run.notification });
        await screenshot("formatted-audit-passed");
      } else {
        // Format Selection (Ctrl+K Ctrl+F): only the selected line changes.
        const messy = await open(file("messy.robot"));
        await clickText("  Log   one", "one");
        await key("Home", "Home", 36);
        await key("End", "End", 35, 8, "Shift+End");
        await key("k", "KeyK", 75, 2, "Ctrl+K");
        await key("f", "KeyF", 70, 2, "Ctrl+F");
        await until(() => messy.getText() === "*** Test Cases ***\nMessy Lines\n    Log    one\n  Log   two\n", "Format Selection applied", 30000)
          .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(messy.getText())}`); });
        assert.ok(replies("textDocument/rangeFormatting").length >= 1, "a textDocument/rangeFormatting request");
        evidence.push({ result: "Format Selection", text: messy.getText() });
        await screenshot("format-selection");
      }
    } finally {
      await revertAll();
      fs.writeFileSync(auditFile().fsPath, originalAudit);
      await until(() => vscode.workspace.textDocuments.every(document => document.uri.toString() !== auditFile().toString() ||
        document.getText() === originalAudit), "audit.robot restored");
    }
  });

  if (provider.key === "native") {
    test("source action: Source Action... offers Add all missing imports; Escape and the preview's Discard change nothing, " +
      "a stale preview is refused, Enter adds both imports and the suite passes from its CodeLens", async function () {
      this.timeout(180000);
      const document = await open(file("imports.robot"));
      const original = FIXTURE["imports.robot"];
      const title = "Add all missing imports (2)";
      const unresolved = () => vscode.languages.getDiagnostics(document.uri).filter(item => item.code === "unknown-keyword");
      await until(() => unresolved().length === 3, "three unresolved calls", 30000);
      const sourceMenu = async label => {
        await clickText("    Imported Step 😀    from-source-action", "from-source");
        await commandPalette("Source Action...", /^Source Action/);
        const rows = await menu(title, label);
        assert.equal(count(rows, title), 1, `one entry: ${rows}`);
        assert.ok(!rows.some(row => /^Import /.test(row)), `quick fixes are not source actions: ${rows}`);
        return rows;
      };
      const unchanged = async label => {
        await sleep(500);
        assert.equal(document.getText(), original, `${label}: the file is unchanged`);
        assert.equal(document.isDirty, false, `${label}: not dirty`);
      };

      // 1. Escape closes the menu.
      const rows = await sourceMenu("Source Action menu");
      evidence.push({ result: "Source Action menu", rows });
      await screenshot("source-action-menu");
      await key("Escape", "Escape", 27);
      await until(async () => (await menuRows()).length === 0, "menu closed");
      await unchanged("Escape");
      evidence.push({ result: "Escape: menu closed, file unchanged" });

      // 2. Ctrl+Enter previews the edit in Refactor Preview; Discard drops it.
      const preview = async () => {
        await sourceMenu("Source Action menu (preview)");
        for (let step = 0; step < 6 && (await page(`document.querySelector('.action-widget .monaco-list-row.focused')?.innerText.trim()`)) !== title; step++) {
          await key("ArrowDown", "ArrowDown", 40);
        }
        await key("Enter", "Enter", 13, 2, "Ctrl+Enter");
        let shown;
        await until(async () => (shown = await page(`[...document.querySelectorAll('.bulk-edit-panel')].filter(e => e.getClientRects().length)
          .map(e => e.innerText.replaceAll('\\u00a0', ' ')).join('\\n')`)).includes("imports.robot") && Boolean(await buttonPoint("Apply")),
        "Refactor Preview shows the edit", 30000);
        return shown;
      };
      const shown = await preview();
      evidence.push({ result: "Refactor Preview", panel: shown });
      await screenshot("source-action-preview");
      await unchanged("preview open");
      await click(await buttonPoint("Discard"), "Refactor Preview: Discard");
      await until(async () => !await buttonPoint("Apply"), "preview closed");
      await unchanged("Discard");
      evidence.push({ result: "Discard: preview closed, file unchanged" });

      // 3. A preview of an older version is refused: VS Code applies nothing after the file changed.
      await preview();
      await clickText("# A comment kept   as written.", "as written", 3);
      await key("End", "End", 35);
      await type("!");
      const changed = original.replace("# A comment kept   as written.\r\n", "# A comment kept   as written.!\r\n");
      await until(() => document.getText() === changed, "the file changed meanwhile");
      await click(await buttonPoint("Apply"), "Refactor Preview: Apply (stale)");
      // VS Code refuses with a modal dialog; the test host does not show dialogs and writes the text to its window log.
      let refusal;
      await until(() => (refusal = workbenchLog().find(line =>
        /Cannot apply refactoring because '.*imports\.robot' has changed in the meantime/.test(line))), "stale preview refused", 15000);
      await sleep(500);
      assert.equal(document.getText(), changed, "nothing was applied");
      evidence.push({ result: "stale preview refused", notification: refusal });
      await screenshot("source-action-stale-refused");
      await vscode.commands.executeCommand("notifications.clearAll");
      if (await buttonPoint("Discard")) await click(await buttonPoint("Discard"), "Refactor Preview: Discard");
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await until(() => document.getText() === original && !document.isDirty, "typed change reverted");

      // 4. Enter applies it: both imports after the Settings header; CRLF, comment and documentation unchanged.
      await until(() => unresolved().length === 3, "diagnostics again", 30000);
      await sourceMenu("Source Action menu (apply)");
      await chooseWithKeyboard(title);
      await until(() => document.getText() === IMPORTED, "both imports added", 30000)
        .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
      await until(() => unresolved().length === 0, "the unresolved-call errors disappear", 30000);
      const sent = replies("textDocument/codeAction").filter(entry => (entry.only || []).includes("source")).pop();
      assert.ok(Number.isInteger(sent.result[0].edit.documentChanges[0].textDocument.version), "the edit names the document version");
      evidence.push({ result: "Add all missing imports applied", text: document.getText(),
        editVersion: sent.result[0].edit.documentChanges[0].textDocument.version });
      await screenshot("source-action-applied");
      await key("s", "KeyS", 83, 2, "Ctrl+S");
      await until(() => !document.isDirty && fs.readFileSync(document.uri.fsPath, "utf8") === IMPORTED, "imports.robot saved");
      const run = await runFromCodeLens("Imports Needed 😀");
      assert.match(run.notification, /Imports Needed 😀.*passed/);
      assert.match(run.output, /1 test, 1 passed, 0 failed/);
      evidence.push({ result: "changed imports.robot run from its CodeLens", notification: run.notification });
      await screenshot("source-action-passed");
    });

    test("Format Selection: Ctrl+K Ctrl+F formats only the selected line; selections whose comment or other lines Robocop " +
      "would change are declined with a warning and nothing changes; the suite passes from its CodeLens", async function () {
      this.timeout(150000);
      const document = await open(file("selection.robot"));
      const original = FIXTURE["selection.robot"];
      const formatSelection = async () => { await key("k", "KeyK", 75, 2, "Ctrl+K"); await key("f", "KeyF", 70, 2, "Ctrl+F"); };
      await selectLine("  Log   one 😀", "one");
      const before = replies("textDocument/rangeFormatting").length;
      await formatSelection();
      const formatted = original.replace("  Log   one 😀\n", "    Log    one 😀\n");
      await until(() => document.getText() === formatted, "only the selected line formatted", 30000)
        .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
      const edits = replies("textDocument/rangeFormatting").slice(before)[0].result;
      assert.deepEqual(edits.map(edit => [edit.range.start.line, edit.range.end.line]), [[4, 5]], "one edit of line 5");
      evidence.push({ result: "Format Selection", edits, text: document.getText() });
      await screenshot("format-selection-native");

      const declined = async (line, token, message, name) => {
        await vscode.commands.executeCommand("notifications.clearAll");
        const version = document.version, text = document.getText();
        await selectLine(line, token);
        await formatSelection();
        let toast;
        await until(async () => (toast = (await toasts()).find(item => item.includes(message))), `warning: ${message}`, 30000)
          .catch(async error => { throw new Error(`${error.message}; toasts ${JSON.stringify(await toasts())}`); });
        await sleep(300);
        assert.equal(document.getText(), text, "nothing changed");
        assert.equal(document.version, version, "no edit was applied");
        evidence.push({ result: `declined: ${name}`, notification: toast });
        await screenshot(`format-selection-declined-${name}`);
      };
      await declined("  Log   two   # keep   spacing", "two", "Format Selection declined: Robocop 9.1.0 would change a comment or " +
        "documentation in lines 6-6; the document was not changed.", "comment");
      await declined("  Log Many   three", "three", "Format Selection declined: Robocop 9.1.0 would change lines outside lines 7-7; " +
        "the document was not changed.", "outside-lines");
      await vscode.commands.executeCommand("notifications.clearAll");

      await key("s", "KeyS", 83, 2, "Ctrl+S");
      await until(() => !document.isDirty && fs.readFileSync(document.uri.fsPath, "utf8") === formatted, "selection.robot saved");
      const run = await runFromCodeLens("Selection Lines");
      assert.match(run.notification, /Selection Lines.*passed/);
      evidence.push({ result: "changed selection.robot run from its CodeLens", notification: run.notification });
    });

    test("on-type formatting: with editor.formatOnType, Enter formats the spacing of the line just typed and nothing else; " +
      "a line Robocop would change beyond spacing stays as typed; the suite passes from its CodeLens", async function () {
      this.timeout(150000);
      const editorConfig = vscode.workspace.getConfiguration("editor", { languageId: "robotframework", uri: file("typing.robot") });
      await editorConfig.update("formatOnType", true, vscode.ConfigurationTarget.WorkspaceFolder, true);
      try {
        // The previous test's CodeLens run leaves its "Test '…' passed." toast; this test checks that typing shows none.
        await until(async () => {
          await vscode.commands.executeCommand("notifications.clearAll");
          return (await toasts()).length === 0;
        }, "earlier notifications cleared");
        const document = await open(file("typing.robot"));
        await clickText("    Log    first", "first");
        await key("End", "End", 35);
        await typeEnter();
        await until(() => document.getText() === FIXTURE["typing.robot"] + "    \n", "auto-indented new line");
        await type("Log Many   typed   😀");
        const before = replies("textDocument/onTypeFormatting").length;
        await typeEnter();
        const typed = "*** Test Cases ***\nTyped Steps\n    Log    first\n    Log Many    typed    😀\n    \n";
        await until(() => document.getText() === typed, "the completed line formatted, the new line kept", 30000)
          .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(document.getText())}`); });
        const reply = replies("textDocument/onTypeFormatting").slice(before)[0];
        assert.deepEqual(reply.result, [{ range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
          newText: "    Log Many    typed    😀\n" }]);
        assert.equal(vscode.window.activeTextEditor.selection.active.line, 4, "the cursor stays on the new line");
        evidence.push({ result: "on-type formatting after Enter", edits: reply.result, text: document.getText() });
        await screenshot("on-type-formatted");

        // A comment whose inner spacing Robocop would change is declined: the line stays as typed.
        await type("#  note   kept");
        const declinedBefore = requests.filter(entry => entry.method === "textDocument/onTypeFormatting" && entry.error).length;
        await typeEnter();
        await until(() => requests.filter(entry => entry.method === "textDocument/onTypeFormatting" && entry.error).length > declinedBefore,
          "the backend declined", 30000);
        await sleep(300);
        const kept = typed.replace(/ {4}\n$/, "    #  note   kept\n    \n");
        assert.equal(document.getText(), kept, "the comment stays as typed");
        const refusal = requests.filter(entry => entry.method === "textDocument/onTypeFormatting" && entry.error).pop().error;
        assert.match(refusal, /^On-type formatting declined: Robocop 9\.1\.0 would change a comment or documentation in lines 5-5/);
        assert.deepEqual(await toasts(), [], "no notification interrupts typing");
        evidence.push({ result: "on-type declined", refusal, text: document.getText() });

        await key("s", "KeyS", 83, 2, "Ctrl+S");
        await until(() => !document.isDirty && fs.readFileSync(document.uri.fsPath, "utf8") === kept, "typing.robot saved");
        const run = await runFromCodeLens("Typed Steps");
        assert.match(run.notification, /Typed Steps.*passed/);
        evidence.push({ result: "changed typing.robot run from its CodeLens", notification: run.notification });
      } finally {
        await editorConfig.update("formatOnType", undefined, vscode.ConfigurationTarget.WorkspaceFolder, true);
      }
    });
  }
  test("hit test: a hover in .overflowingContentWidgets over a token's click point is refused; after Escape the point is free", async function () {
    this.timeout(60000);
    await open(file("hover.robot"));
    const target = ["    Log    hover-target", "hover-target"];
    // The old deny-list, for the same hit: same editor and not under sticky scroll, (non-overflowing) widgets or the margin.
    const coverage = point => page(`(() => {
      const row = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
        .find(el => el.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(target[0])}));
      const editor = row.closest('.monaco-editor'), hit = document.elementFromPoint(${point.x}, ${point.y});
      const layer = hit?.closest('.overflowingContentWidgets'), hover = layer?.querySelector('.monaco-hover');
      const rect = hover?.getBoundingClientRect();
      return { overflowing: Boolean(layer && layer.parentElement === editor), onRow: row.contains(hit),
        hoverVisible: Boolean(rect?.width && rect.height && getComputedStyle(hover).visibility !== 'hidden'),
        hoverCovers: Boolean(rect && rect.left <= ${point.x} && ${point.x} <= rect.right && rect.top <= ${point.y} && ${point.y} <= rect.bottom),
        hoverText: hover?.innerText.replaceAll('\\u00a0', ' ').trim(),
        denyListFree: Boolean(hit && (row.contains(hit) || (hit.closest('.monaco-editor') === editor &&
          !hit.closest('.sticky-widget, .contentWidgets, .overlayWidgets, .margin')))),
        editorInput: [...editor.querySelectorAll('.cursors-layer .cursor, textarea.inputarea, .native-edit-context')]
          .map(el => el.tagName + '.' + el.className.trim().split(/\\s+/).join('.')) };
    })()`);
    // Companion's Run Suite/Run Test CodeLenses move the lines down when they render: wait for them first.
    await until(() => page(`[...document.querySelectorAll('.editor-instance .monaco-editor .codelens-decoration a')]
      .filter(a => a.getClientRects().length && /^Run (Suite|Test)$/.test(a.textContent.trim())).length >= 2`), "Run Suite and Run Test CodeLenses");
    const free = await textPoint(...target);
    // Real input: the cursor on the call's line below, then Ctrl+K Ctrl+I (Show Hover) with the keyboard.
    await clickText("    Hover Step", "Step");
    await key("k", "KeyK", 75, 2, "Ctrl+K");
    await key("i", "KeyI", 73, 2, "Ctrl+I");
    let covered, state;
    await until(async () => (covered = await hitTest(...target))?.blocked && (state = await coverage(covered)).hoverCovers,
      "the hover covers hover-target's click point", 30000)
      .catch(error => { throw new Error(`${error.message}; hit test ${JSON.stringify(covered)}, ${JSON.stringify(state)}`); });
    evidence.push({ result: "hover open", point: covered, blocked: covered.blocked, ...state });
    await screenshot("hover-covers-target");
    assert.deepEqual([covered.x, covered.y], [free.x, free.y], "the same click point");
    assert.ok(state.hoverVisible && state.overflowing, `a visible hover in this editor's .overflowingContentWidgets: ${JSON.stringify(state)}`);
    assert.match(state.hoverText, /Hover Step/, "the hover of the call");
    assert.equal(state.onRow, false, "the hit is not on the target line");
    assert.match(covered.blocked, /(^|\.)overflowingContentWidgets( |\.|$)/, `the refusal names the overflowing widget: ${covered.blocked}`);
    assert.equal(state.denyListFree, true, "the old deny-list would have accepted this hit");

    await key("Escape", "Escape", 27);
    let after;
    await until(async () => (after = await hitTest(...target)) && !after.blocked, "the hover closed and the point is free")
      .catch(error => { throw new Error(`${error.message}; hit test ${JSON.stringify(after)}`); });
    assert.deepEqual(after, free, "the same point is accepted once the hover is closed");
    const closed = await coverage(after);
    assert.equal(closed.onRow, true, "the hit is on the target line");
    evidence.push({ result: "hover closed with Escape", point: after, ...closed });
    await screenshot("hover-closed");
  });

  test("Companion's folding and documentation command keep working; each code action appears once", async function () {
    this.timeout(60000);
    const audit = await open(auditFile());
    const folding = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", audit.uri);
    const documentationLine = audit.getText().split("\n").findIndex(line => line.includes("#> Build a typed record"));
    assert.ok(folding.some(range => range.start <= documentationLine && range.end >= documentationLine), "Companion folds the #> block");
    await clickText("#> Build a typed record", "typed record");
    await vscode.commands.executeCommand("robotCompanion.openCurrentBlock");
    await until(() => api.getDocumentationPreviewSnapshotForTest().selectedBlockId, "Companion's Open Current Block");
    // Every action the providers return for a call line, by title: no duplicates.
    const quickfix = await open(file("quickfix.robot"));
    await until(() => diagnosticsOf(quickfix.uri, UNKNOWN).length === 1, "diagnostic", 60000);
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", quickfix.uri, new vscode.Range(2, 4, 2, 4));
    const titles = (actions || []).map(action => action.title).filter(title => !/^Modify|inline chat/i.test(title));
    assert.equal(new Set(titles).size, titles.length, `no duplicate code actions: ${titles}`);
    evidence.push({ result: "Companion features with code actions and formatting", foldingRanges: folding.length, codeActions: titles });
  });
});
}

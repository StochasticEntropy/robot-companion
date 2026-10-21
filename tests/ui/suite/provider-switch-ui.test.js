"use strict";

// Provider selection (MIS-363): languageBackend and executionBackend each select
// the native backend or the pinned RobotCode 2.7.0 bridge. Driven by actual
// pointer and keyboard input at 1280x900 and asserted on what VS Code shows
// (language status hover, notifications, Debug Console, Testing view) and on
// the host's process table. Skipped by name (pending) when either provider's
// prepared environment is absent; never reported as a pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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

// Every backend process either provider can start, from the host's process table.
const KINDS = [
  ["native-language", /robot-companion-backend lsp$/], ["native-debug", /robot-companion-backend dap$/],
  ["native-robot-worker", /-m robot_companion_backend\.worker /], ["debugpy-adapter", /debugpy[/.]adapter/],
  ["robotcode-language", /robotcode\.cli language-server/], ["robotcode-debug", /robotcode\.cli debug-launch/],
  ["robotcode-discovery", /robotcode\.cli .*discover tests/], ["robotcode-run", /robotcode\.debugger|-m robotcode\.cli .*\bdebug\b/]
];
function backendProcesses() {
  try {
    return execFileSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" }).split("\n").flatMap(line => {
      const [pid, pgid, ...rest] = line.trim().split(/\s+/);
      const args = rest.join(" ");
      const kind = KINDS.find(([, pattern]) => pattern.test(args))?.[0];
      return kind ? [{ pid: Number(pid), pgid: Number(pgid), kind, args: args.slice(0, 160) }] : [];
    });
  } catch { return []; }
}
const kinds = () => backendProcesses().map(item => item.kind).sort();

suite("Provider selection: native backend and pinned RobotCode bridge, each independently (live, actual input)", () => {
  let extension, api, manager, debug, tests, folder, config, cdp, tracker, descriptors;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  // VS Code retains the last launch name in its status bar after Stop. Keep
  // this fixture label short enough to leave the language-status control visible.
  const launchName = "Provider audit";
  const auditUri = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot");
  const LABEL = { native: "Native backend 0.1.0.dev2", robotcode: "RobotCode 2.7.0" };
  const SERVER = { native: { name: "robot-companion-backend", version: "0.1.0.dev2" },
    robotcode: { name: "RobotCode Language Server", version: "2.7.0" } };
  // Where F12 on Build Record lands in AuditLibrary.py: native ranges start at the function name.
  const LIBRARY_COLUMN = { native: 4, robotcode: 0 };

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `providers-${name}.png`), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-")}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, `providers-${name}-hover.html`),
      await page(`[...document.querySelectorAll('.monaco-hover')].map(e => e.outerHTML).join('\\n')`));
    fs.writeFileSync(path.join(evidenceDirectory, `providers-${name}.json`), JSON.stringify(await page(`
      [...document.querySelectorAll('.monaco-list-row, .action-label, .notification-toast, .statusbar-item, .monaco-hover')]
        .filter(e => e.getClientRects().length).slice(0, 200)
        .map(e => ({ id: e.id, aria: e.getAttribute('aria-label'), text: (e.innerText || '').slice(0, 200), cls: String(e.className).slice(0, 80), rect: e.getBoundingClientRect().toJSON() }))`), null, 2));
  }
  // A visible element found by `finder` whose point is not covered by anything else.
  async function pointAt(finder, label, timeoutMs) {
    let point;
    try {
      await until(async () => {
        point = await page(`(() => {
          const element = (${finder})();
          if (!element) return;
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const x = rect.x + Math.min(rect.width / 2, 120), y = rect.y + rect.height / 2;
          if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return;
          const hit = document.elementFromPoint(x, y);
          return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
        })()`);
        return point;
      }, `visible ${label}`, timeoutMs);
    } catch (error) {
      await dump(label);
      throw error;
    }
    return point;
  }
  async function click(point, label, modifiers = 0) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers }, cdp.pageSession);
    await sleep(150);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, modifiers, button: "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cdp.pageSession);
    }
    evidence.push({ action: modifiers ? "Ctrl-click" : "click", target: label, point });
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }
  // The Output view renders only the lines in its viewport. Beside VS Code 1.141's Chat secondary side bar the
  // panel under the editor is 628x292 px at 1280x900, and the wrapped Details lines, now followed by the
  // Environment line, scroll the start of the Language line out of view. Until `done` holds for the visible
  // lines, the pointer wheel scrolls the Output view up a little at a time, as a user scrolls to read it.
  async function scrollOutputUntil(done, label) {
    let output;
    // Monaco reuses its row elements, so the rows are read in on-screen order (their top), not in DOM order.
    const visible = async () => (await page(`[...document.querySelectorAll('.part.panel .monaco-editor .view-lines > .view-line')]
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map(e => e.innerText.replaceAll('\\u00a0', ' ')).join('\\n')`)).replace(/\s+/g, " ");
    // Details has written its lines and the Output view follows them before any scrolling.
    await until(async () => done.tail.test(output = await visible()), `${label}: lines at the end of the Output view`, 10000)
      .catch(error => { throw new Error(`${error.message}: ${output}`); });
    const box = await page(`(() => { const r = document.querySelector('.part.panel .monaco-editor').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (let step = 0; step < 40; step += 1) {
      output = await visible();
      if (done.all.every(pattern => pattern.test(output))) return output;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -40 }, cdp.pageSession);
      await sleep(150);
    }
    throw new Error(`Timed out: ${label}: ${output}`);
  }
  async function rest() {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 5 }, cdp.pageSession);
    await key("Escape", "Escape", 27);
  }

  // Selects providers through the settings, then waits for every workspace to settle.
  async function select({ language, execution, discovery, mode = "owned" }) {
    // Clearing an override while still owned selects preview native defaults.
    // Enter coexistence first when the intention is to stop all services.
    if (mode === "coexistence") await config.update("integrationMode", mode, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", language ? descriptors[language] : undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", execution ? descriptors[execution] : undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("discoveryBackend", discovery ? descriptors[discovery] : undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    if (mode !== "coexistence") await config.update("integrationMode", mode, vscode.ConfigurationTarget.WorkspaceFolder);
    await settle();
  }
  async function settle() {
    await manager.queue;
    await debug.statusQueue;
    await tests.queue;
  }

  // The language status hover, opened by moving the pointer over the `{}` status bar entry.
  async function statusHover(expected) {
    // Debug sessions leave stacked panes with a workbench minimum height
    // larger than this fixture's 900px desktop. Restore the editor layout
    // through normal workbench actions before checking its status control.
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.window.showTextDocument(auditUri(), { preview: false });
    let text;
    for (let attempt = 1; ; attempt++) {
      await rest();
      const point = await pointAt(`() => [...document.querySelectorAll('.statusbar-item')]
        .find(element => (element.getAttribute('aria-label') || '').startsWith('Editor Language Status:'))`, "language status entry");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
      evidence.push({ action: "pointer over", target: "language status entry", point });
      try {
        await until(async () => (text = await page(`[...document.querySelectorAll('.monaco-hover')].filter(e => e.getClientRects().length)
          .map(e => e.innerText).join('\\n')`)) && expected.every(part => text.includes(part)), "language status hover", 8000);
        return text;
      } catch (error) { if (attempt === 3) throw new Error(`${error.message}; hover text: ${text}`); }
    }
  }
  // The visible notification toasts' text.
  const toasts = () => page(`[...document.querySelectorAll('.notifications-toasts .notification-toast')]
    .filter(e => e.getClientRects().length).map(e => e.innerText).join('\\n')`);
  // Every toast shown while a debug session ends, with its severity icon,
  // sampled until stop() so that a toast which hides again is still counted.
  function watchToasts() {
    const seen = new Map();
    let stopped = false;
    const done = (async () => {
      while (!stopped) {
        for (const toast of await page(`[...document.querySelectorAll('.notifications-toasts .notification-toast')]
          .filter(e => e.getClientRects().length).map(e => ({
            severity: (String(e.querySelector('.notification-list-item-icon')?.className || '').match(/codicon-(error|warning|info)/) || [])[1] || 'unknown',
            text: e.innerText.slice(0, 300) }))`)) seen.set(`${toast.severity}:${toast.text}`, toast);
        await sleep(100);
      }
    })();
    return async () => { stopped = true; await done; return [...seen.values()]; };
  }
  // A normal native debug end shows no error toast, and the routine end of its
  // Python child session is a Debug Console line, never a notification.
  async function assertQuietNativeEnd(stopWatching, session, label) {
    await sleep(1500);
    const shown = await stopWatching();
    await screenshot(`${label}-end-toasts`);
    assert.deepEqual(shown.filter(toast => toast.severity === "error"), [], `${label}: no error toast at the end of the session`);
    assert.deepEqual(shown.filter(toast => /Python session ended|Robot worker is not paused/.test(toast.text)), [],
      `${label}: no Python-end or not-paused notification`);
    const ended = protocol.filter(m => m.session === session.name && /^Python session ended:/.test(m.output || ""));
    assert.ok(ended.length, `${label}: the Python child's end is reported in the Debug Console`);
    assert.deepEqual(ended.filter(m => m.category === "important"), [], `${label}: the Python child's end is not a popup`);
    evidence.push({ result: `${label}: quiet native debug end`, toasts: shown, pythonEnd: ended.map(m => ({ category: m.category, output: m.output })),
      failedResponses: protocol.filter(m => m.session === session.name && m.success === false) });
  }

  async function openAuditAt(text) {
    const document = await vscode.workspace.openTextDocument(auditUri());
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    return { document, editor, line: document.getText().split("\n").findIndex(row => row.includes(text)) };
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
  // Pointer click on Build Record, then F12: the imported library, never AShadow.py.
  async function f12BuildRecord(language) {
    await openAuditAt("Build Record");
    for (let attempt = 1; ; attempt++) {
      await click(await textPoint("${record}=    Build Record", "Build Record"), "Build Record call");
      try {
        await until(() => vscode.window.activeTextEditor?.document.lineAt(vscode.window.activeTextEditor.selection.active.line)
          .text.includes("Build Record"), "cursor on Build Record", 2000);
        break;
      } catch (error) { if (attempt === 3) throw error; }
    }
    await key("F12", "F12", 123);
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith("AuditLibrary.py") && editor.selection.active.line === 11 &&
        editor.selection.active.character === LIBRARY_COLUMN[language];
    }, `F12 reaches AuditLibrary.py:12 (${language})`, 20000);
    evidence.push({ result: `F12 with ${language} language provider`, uri: vscode.window.activeTextEditor.document.uri.toString(),
      line: 12, character: LIBRARY_COLUMN[language] + 1 });
  }

  // Run and Debug with a gutter breakpoint at audit.robot:12: the paused Robot
  // session evaluates a live keyword, F5 finishes the run with 1 PASS and no
  // backend, Robot or debugpy process remains.
  async function clickGutter(marker, line) {
    for (let attempt = 1; ; attempt++) {
      const before = new Set(vscode.debug.breakpoints);
      let point, previous;
      await until(async () => {
        point = await page(`(() => {
          const editor = [...document.querySelectorAll('.monaco-editor')].find(e =>
            e.closest('.editor-instance') && e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(marker)}));
          if (!editor) return;
          const number = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === ${JSON.stringify(String(line))});
          const glyph = editor.querySelector('.margin-view-overlays');
          if (!number || !glyph) return;
          const row = number.getBoundingClientRect(), margin = glyph.getBoundingClientRect();
          return { x: margin.x + 8, y: row.y + row.height / 2 };
        })()`);
        const stable = point && previous && point.x === previous.x && point.y === previous.y;
        previous = point;
        if (!stable) await sleep(200);
        return stable;
      }, `gutter ${marker}:${line}`);
      await click(point, `breakpoint gutter ${marker} line ${line}`);
      try {
        await until(() => vscode.debug.breakpoints.some(b => !before.has(b)), "breakpoint from gutter", 3000);
      } catch (error) { if (attempt === 3) throw error; continue; }
      const added = vscode.debug.breakpoints.filter(b => !before.has(b));
      if (added.every(b => b.location.range.start.line === line - 1)) return;
      vscode.debug.removeBreakpoints(added);
      if (attempt === 3) throw new Error(`Gutter click for ${marker}:${line} kept missing its line.`);
    }
  }
  async function showConsole() {
    const visible = () => page(`Boolean(document.querySelector('.repl .repl-input-wrapper .monaco-editor')?.getClientRects().length)`);
    if (!await visible()) await key("Y", "KeyY", 89, 10); // Linux Ctrl+Shift+Y
    await until(visible, "Debug Console visible");
  }
  async function evaluate(expression) {
    await showConsole();
    const before = protocol.filter(m => m.response === "evaluate").length;
    const point = await pointAt(`() => document.querySelector('.repl .repl-input-wrapper .monaco-editor')`, "Debug Console input");
    await click(point, "Debug Console input");
    await cdp.send("Input.insertText", { text: expression }, cdp.pageSession);
    evidence.push({ action: "type", text: expression });
    await key("Enter", "Enter", 13);
    await until(() => protocol.filter(m => m.response === "evaluate").length > before, `evaluate ${expression}`);
    return protocol.filter(m => m.response === "evaluate")[before];
  }
  async function debugAuditToEnd(execution) {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await openAuditAt("Build Record");
    await clickGutter("${record}=    Build Record", 12);
    await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D: Run and Debug
    await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
      item.textContent.includes(${JSON.stringify(launchName)}) ||
      [...item.querySelectorAll('select option')].some(option => option.selected && option.text.includes(${JSON.stringify(launchName)})))`),
    "launch configuration selected");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    await click(await pointAt(`() => document.querySelector('.start-debug-action-item .codicon-debug-start')`, "start button"),
      "Run and Debug start button");
    const session = await started;
    const entry = debug.sessions.get(session.id);
    assert.equal(entry.adapter.backendId, descriptors[execution].id, "the session uses the selected execution provider");
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith("audit.robot") && editor.selection.active.line === 11 &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, "Robot breakpoint audit.robot:12", 45000);
    await showConsole();
    // The session's Debug Console output names its provider (the rendered rows may already be scrolled past it).
    const providerLine = `Robot Companion debug provider: ${LABEL[execution]}`;
    await until(() => protocol.some(m => m.session === session.name && m.output?.startsWith(providerLine)), "Debug Console names the provider");
    const live = await evaluate("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console");
    assert.equal(live.value, "'from-suite-console'");
    await screenshot(`debug-${execution}-paused`);
    const groups = [entry.pid];
    const terminated = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session.id) { listener.dispose(); resolve(); } });
    });
    await vscode.commands.executeCommand("notifications.clearAll");
    const stopWatching = watchToasts();
    await key("F5", "F5", 116);
    await terminated;
    if (execution === "native") await assertQuietNativeEnd(stopWatching, session, "debug-native");
    else await stopWatching();
    groups.push(...entry.adapter.ownedGroups);
    const xml = fs.readFileSync(path.join(entry.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    await until(() => debug.sessions.size === 0, "sessions released");
    await until(() => !backendProcesses().some(item => /debug|worker|debugpy|run/.test(item.kind)), "no debug process remains", 10000);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    evidence.push({ result: `debug with ${execution} execution provider`, provider: providerLine, live: live.value,
      robot: "1 PASS (output.xml)", groups, processesAfter: backendProcesses() });
  }

  suiteSetup(async function () {
    if (!fs.existsSync(python) || !nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    manager = api.getLanguageWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    tests = api.getTestWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // Start from the copied audit corpus: earlier suites may have saved edits.
    const fixture = path.join(extension.extensionPath, "tests/integration/fixtures/audit-v1");
    for (const name of ["audit.robot", "AuditLibrary.py", "shared.resource"]) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", name), fs.readFileSync(path.join(fixture, name)));
    }
    const native = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const robotCode = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const base = { workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath };
    const plain = value => JSON.parse(JSON.stringify(value));
    descriptors = {
      native: plain(native.nativeDescriptor({ ...base, executable: nativeExecutable, services: ["language", "debug"] })),
      robotcode: plain(robotCode.robotCodeDescriptor({ ...base, python, services: ["language", "debug", "discovery"] })),
      robotcodeDiscovery: plain(robotCode.robotCodeDescriptor({ ...base, python, services: ["discovery"] }))
    };
    cdp = await WebviewCdp.connect();
    if (process.platform === "linux") {
      // A preceding environment journey changes the real desktop size. Use
      // one geometry source for status-bar hit testing instead of retaining
      // a fixed emulated viewport over that differently sized native window.
      const { EnvironmentCdp } = require("./environment-cdp");
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, cdp.pageSession);
      const window = new EnvironmentCdp(cdp);
      await window.resize(1280, 900);
      evidence.push({ action: "provider suite native desktop", sizes: window.actions });
    }
    tracker = vscode.debug.registerDebugAdapterTrackerFactory("robotcompanion", {
      createDebugAdapterTracker: session => ({
        onDidSendMessage: message => protocol.push({ session: session.name, type: message.type,
          response: message.type === "response" ? message.command : undefined, success: message.success,
          value: message.command === "evaluate" ? message.body?.result : undefined, event: message.event,
          output: message.event === "output" ? message.body?.output : undefined,
          category: message.event === "output" ? message.body?.category : undefined,
          message: message.success === false ? message.message : undefined,
          showUser: message.success === false ? message.body?.error?.showUser : undefined })
      })
    });
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-audit-v1/audit.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "provider checks run at 1280x900");
    assert.deepEqual(kinds(), [], `no backend process before the suite: ${JSON.stringify(backendProcesses())}`);
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, viewport,
      native: { executable: nativeExecutable, language: descriptors.native.services.language.argv, debug: descriptors.native.services.debug.argv },
      robotcode: { python, language: descriptors.robotcode.services.language.argv, debug: descriptors.robotcode.services.debug.argv },
      externalExtensions: "RobotCode, Python, debugpy and Robocorp extensions absent" });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await dump(`failed ${this.currentTest.title.slice(0, 40)}`);
      // A failed step can leave the status hover open over the notification toasts; close it for the next test.
      await rest();
    }
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand("notifications.clearAll");
  });
  suiteTeardown(async () => {
    if (!extension) return;
    tracker?.dispose();
    await select({ mode: "coexistence" });
    await config.update("integrationMode", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await settle();
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "provider-switch-ui-actions.json"),
      JSON.stringify({ evidence, protocol }, null, 2));
    cdp?.close();
  });

  test("all four combinations start in owned mode and show the active providers and their advertised capabilities; switches leave no old process or duplicate", async function () {
    this.timeout(420000);
    await select({ mode: "coexistence" });
    const audit = (await openAuditAt("Build Record")).document;
    const position = new vscode.Position(audit.getText().split("\n").findIndex(row => row.includes("Build Record")), 20);
    const lenses = async () => ((await vscode.commands.executeCommand("vscode.executeCodeLensProvider", audit.uri)) || [])
      .map(lens => lens.command?.title).filter(Boolean).sort();
    const coexistenceLenses = await lenses();
    assert.ok(coexistenceLenses.includes("Run Test"), `Companion's Run Test CodeLens: ${coexistenceLenses}`);
    let previous;
    for (const [language, execution] of [["native", "native"], ["native", "robotcode"], ["robotcode", "native"], ["robotcode", "robotcode"]]) {
      await select({ language, execution });
      const root = manager.roots.get(folder.uri.toString());
      assert.equal(root?.session?.state, "running", `${language} language provider running`);
      assert.deepEqual({ ...root.session.serverInfo }, SERVER[language]);
      await until(() => api.getProviderStatusForTest().get("execution", folder)?.state === "running", "execution provider status", 30000);
      // The status hover names both providers and what they advertise.
      const hover = await statusHover([`Language: ${LABEL[language]}`, `Debug: ${LABEL[execution]}`]);
      // Native: eight editor features, code actions, document/range/on-type formatting and semantic tokens (whole
      // document and range); RobotCode: document and range formatting, whole-document semantic tokens only.
      const exposed = language === "native" ? 15 : 13;
      assert.match(hover, new RegExp(`Language: ${LABEL[language]}\\s+${exposed} capabilities`));
      assert.match(hover, new RegExp(`Debug: ${LABEL[execution]}\\s+\\d+ capabilities`));
      assert.match(hover, execution === "robotcode" ? /Tests: RobotCode 2\.7\.0\s+\d+ tests/ : /Tests: file\/run fallback/);
      // Every row fits: its Details link is inside the window.
      assert.equal(await page(`[...document.querySelectorAll('.monaco-hover .hover-language-status')]
        .filter(row => /^(Language|Debug|Tests):/.test(row.querySelector('.left')?.innerText || '')).filter(row => {
          const r = row.querySelector('.right a.monaco-link')?.getBoundingClientRect();
          return r?.width && r.right <= innerWidth && r.left >= 0; }).length`), 3,
      "the Details link of each Robot Companion status row is visible");
      await screenshot(`status-${language}-${execution}`);
      // Details: the full lines in the Robot Companion Language output.
      // The "Details" link in the hover row whose smallest enclosing block names the language provider.
      const detailsFinder = `() => {
        const links = [...document.querySelectorAll('.monaco-hover *')].filter(e => !e.children.length && e.textContent.trim() === 'Details');
        for (const link of links) {
          let row = link;
          while (row && !/Language:/.test(row.innerText || '')) row = row.parentElement;
          if (row && !/Debug:|Tests:/.test(row.innerText)) return link;
        }
      }`;
      let details;
      await until(async () => {
        const before = await pointAt(detailsFinder, "Details link of the language provider");
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...before }, cdp.pageSession);
        await sleep(200);
        details = await pointAt(detailsFinder, "Details link after hover layout");
        return details.x === before.x && details.y === before.y;
      }, "settled Details link");
      await click(details, "language status: Details");
      // Details lists the advertised capabilities in full (the Output view wraps long lines).
      const expectedLanguage = new RegExp(`Language: ${LABEL[language]} — definitions, hover, completion, signature help, references, ` +
        `rename, document symbols, workspace symbols, code actions, formatting, ` +
        `${language === "robotcode" ? "range formatting, semantic tokens" : "range formatting, on-type formatting, semantic tokens, semantic token ranges"}`);
      const expectedDebug = execution === "native" ? new RegExp(`Debug: ${LABEL.native} — ConfigurationDone, Terminate`)
        : /Debug: RobotCode 2\.7\.0 — ConfigurationDone, .*SetVariable/;
      // Output virtualizes wrapped lines. Copy through the actual control so a
      // header scrolled out of the DOM is still checked; only the newest block
      // may satisfy this combination, never an earlier provider's status.
      await click(await pointAt(`() => document.querySelector('.part.panel .monaco-editor')`, "Output editor"), "Output editor");
      const sentinel = "Robot Companion status copy pending";
      await vscode.env.clipboard.writeText(sentinel);
      await key("End", "End", 35, 2);
      await key("Home", "Home", 36, 10);
      await key("c", "KeyC", 67, 2);
      let copied;
      await until(async () => (copied = await vscode.env.clipboard.readText()) !== sentinel, "Output copied by keyboard");
      const marker = `[${folder.name}] owned:`;
      const start = copied.lastIndexOf(marker);
      assert.ok(start >= 0, `latest status block header: ${copied}`);
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `providers-status-copy-${language}-${execution}.txt`), copied.slice(start));
      const output = copied.slice(start).replace(/\s+/g, " ");
      assert.match(output, expectedLanguage);
      assert.match(output, expectedDebug);
      assert.equal((output.match(/Language:/g) || []).length, 1, "one latest language status");
      assert.equal((output.match(/Debug:/g) || []).length, 1, "one latest debug status");
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `providers-status-copy-${language}-${execution}.txt`), copied.slice(start));
      await key("End", "End", 35, 2);
      await screenshot(`status-details-${language}-${execution}`);
      evidence.push({ combination: { language, execution }, hover, details: output.split("[").filter(line => /Language:|Debug:|Tests:/.test(line)) });
      await rest();

      // Processes: exactly the selected language process; the initialize-only debug probe has ended.
      const processes = backendProcesses();
      assert.deepEqual(processes.map(item => item.kind).sort(), [`${language}-language`].concat(execution === "robotcode" ? [] : []),
        `only the ${language} language process runs: ${JSON.stringify(processes)}`);
      if (previous?.language !== language && previous) {
        assert.ok(previous.child.exitCode !== null || previous.child.signalCode !== null, "the previous language process stopped");
        assert.equal(previous.child.exitCode, 0, "and exited by itself after shutdown/exit");
      } else if (previous) assert.equal(root.session.child.pid, previous.child.pid, "an unchanged language selection keeps its process");
      // No duplicate providers, CodeLenses or test controllers.
      assert.equal(root.registrations.length, exposed + 4, "one provider per exposed capability, plus the file watcher");
      const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", audit.uri, position);
      assert.equal(definitions.length, 1, "exactly one definition answer");
      assert.ok(definitions[0].targetUri?.path.endsWith("AuditLibrary.py") || definitions[0].uri?.path.endsWith("AuditLibrary.py"));
      assert.deepEqual(await lenses(), coexistenceLenses, "CodeLenses unchanged, not duplicated");
      if (execution === "robotcode") {
        await until(() => tests.controller?.items.size > 0, "RobotCode discovery items", 90000);
        assert.equal(tests.roots.size, 1, "one discovery root");
      } else assert.equal(tests.controller, undefined, "no test controller without a discovery service");
      previous = { child: root.session.child, language };
    }
    await select({ mode: "coexistence" });
    await until(() => previous.child.exitCode !== null || previous.child.signalCode !== null, "last language process stopped");
    assert.deepEqual(kinds(), [], "coexistence: no backend process");
    assert.equal(tests.controller, undefined);
    assert.deepEqual(await lenses(), coexistenceLenses);
  });

  test("a contract or version mismatch and a missing executable are refused visibly, naming both values, and nothing starts", async function () {
    this.timeout(180000);
    const cases = [
      { setting: "languageBackend", value: { ...descriptors.native, version: "0.2.0" }, parts: ["0.1.0.dev2", "0.2.0"], status: "Language: refused" },
      { setting: "executionBackend", value: { ...descriptors.robotcode, version: "2.6.0" }, parts: ["2.7.0", "2.6.0"], status: "Debug: refused" },
      { setting: "languageBackend", value: { ...descriptors.robotcode, contractVersion: 2 }, parts: ["contract version: 2", "Expected 1"],
        status: "Language: refused" },
      { setting: "executionBackend", value: { ...descriptors.native, services: { debug: { ...descriptors.native.services.debug,
        executable: path.join(folder.uri.fsPath, "missing-venv/bin/robot-companion-backend") } } },
      parts: ["missing-venv/bin/robot-companion-backend", "does not exist"], status: "Debug: refused" }
    ];
    for (const item of cases) {
      await select({ mode: "coexistence" });
      await rest();
      await vscode.commands.executeCommand("notifications.clearAll");
      // The other side explicitly has no relevant service. An unset descriptor
      // would instead select a native default in this unprepared project.
      const other = item.setting === "languageBackend" ? "executionBackend" : "languageBackend";
      const service = item.setting === "languageBackend" ? "language" : "debug";
      await config.update(other, { ...descriptors.native, services: { [service]: descriptors.native.services[service] } },
        vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update(item.setting, item.value, vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
      await settle();
      let shown;
      await until(async () => { shown = await toasts(); return item.parts.every(part => shown.includes(part)); },
        `visible refusal ${item.parts}`, 15000);
      assert.match(shown, new RegExp(`robotCompanion\\.${item.setting}`), "the notification names the setting");
      await screenshot(`refused-${item.setting}-${item.parts[1].replace(/\W+/g, "-")}`);
      const hover = await statusHover([item.status]);
      assert.deepEqual(kinds(), [], `nothing started: ${JSON.stringify(backendProcesses())}`);
      evidence.push({ refused: item.setting, notification: shown, hover, processes: [] });
      await rest();
    }
    // Run and Debug refuses the same execution descriptor before anything starts.
    await vscode.commands.executeCommand("notifications.clearAll");
    const startedDebug = await vscode.debug.startDebugging(folder, launchName);
    assert.equal(startedDebug, false);
    await until(async () => /missing-venv\/bin\/robot-companion-backend/.test(await toasts()), "debug start refusal");
    assert.deepEqual(kinds(), []);
    await select({ mode: "coexistence" });
  });

  test("mixed: native language with RobotCode debugging, both live with actual input", async function () {
    this.timeout(240000);
    await select({ language: "native", execution: "robotcode" });
    await f12BuildRecord("native");
    await debugAuditToEnd("robotcode");
    assert.deepEqual(kinds(), ["native-language"], "the native language process keeps running alone");
  });

  test("mixed: RobotCode language with native debugging, both live with actual input", async function () {
    this.timeout(240000);
    await select({ language: "robotcode", execution: "native" });
    await f12BuildRecord("robotcode");
    await debugAuditToEnd("native");
    assert.deepEqual(kinds(), ["robotcode-language"], "the RobotCode language process keeps running alone");
  });

  test("switching back to RobotCode restores RobotCode behaviour with a clean stop of the native processes", async function () {
    this.timeout(240000);
    await select({ language: "native", execution: "native" });
    const nativeChild = manager.roots.get(folder.uri.toString()).session.child;
    await f12BuildRecord("native");
    await select({ language: "robotcode", execution: "native" });
    assert.notEqual(nativeChild.exitCode ?? nativeChild.signalCode, null, "native language process stopped");
    assert.equal(nativeChild.exitCode, 0);
    await f12BuildRecord("robotcode");
    await select({ language: "robotcode", execution: "robotcode" });
    await debugAuditToEnd("robotcode");
    assert.deepEqual(kinds(), ["robotcode-language"]);
    await statusHover([`Language: ${LABEL.robotcode}`, `Debug: ${LABEL.robotcode}`, "Tests: RobotCode 2.7.0"]);
    await rest();
  });

  test("Test Explorer discovery per combination; Debug Test uses the native execution provider for that test", async function () {
    this.timeout(300000);
    const fixtureRoot = path.join(folder.uri.fsPath, "integration-test-explorer");
    const checkoutUri = vscode.Uri.file(path.join(fixtureRoot, "checkout.robot")).toString();
    const rowFinder = name => `() => [...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].find(row =>
      row.getClientRects().length && /^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(|,|$)/.test(row.getAttribute('aria-label') || ''))`;
    const showTesting = async () => {
      if (await page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`)) return;
      await click(await pointAt(`() => [...document.querySelectorAll('.activitybar .action-label')]
        .find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))`, "Testing activity bar icon"), "Testing activity bar icon");
      await until(() => page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`), "Testing view");
    };
    const discovery = [];
    // Native execution without a discovery service: the file/run fallback.
    await select({ language: "native", execution: "native" });
    assert.equal(tests.controller, undefined, "no Robot Companion test controller");
    const lensTitles = ((await vscode.commands.executeCommand("vscode.executeCodeLensProvider", auditUri())) || []).map(lens => lens.command?.title);
    assert.ok(lensTitles.includes("Run Test") && lensTitles.includes("Run Suite"), "Run Test / Run Suite CodeLens fallback");
    discovery.push({ language: "native", execution: "native", discovery: "file/run fallback (no controller)",
      hover: await statusHover(["Tests: file/run fallback"]) });
    await rest();
    // Native execution plus the RobotCode discovery fallback setting.
    await select({ language: "robotcode", execution: "native", discovery: "robotcodeDiscovery" });
    await until(() => tests.controller?.items.get(checkoutUri)?.children.size === 3, "RobotCode discovery next to native debug", 90000);
    assert.ok(tests.debugProfile, "Debug profile from the native execution provider's debug service");
    discovery.push({ language: "robotcode", execution: "native", discovery: "robotCompanion.discoveryBackend (RobotCode 2.7.0)",
      hover: await statusHover(["Tests: RobotCode 2.7.0", `Debug: ${LABEL.native}`]) });
    assert.ok(api.getProviderStatusForTest().lines().some(line => /Tests: RobotCode 2\.7\.0 — .*Debug Test uses robotCompanion\.executionBackend/.test(line)));
    await rest();

    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(checkoutUri));
    await vscode.window.showTextDocument(document, { preview: false });
    const line = document.getText().split(/\r?\n/).indexOf("    Log    checkout-ok");
    await clickGutter("Log    checkout-ok", line + 1);
    await showTesting();
    if (!await page(`Boolean((${rowFinder("Checkout Passes")})())`)) {
      await click(await pointAt(rowFinder("checkout.robot"), "checkout.robot suite row"), "checkout.robot suite row");
    }
    const row = await pointAt(rowFinder("Checkout Passes"), "Checkout Passes row");
    await click(row, "Checkout Passes row");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    tests.lastRun = undefined;
    await vscode.commands.executeCommand("notifications.clearAll");
    const stopWatching = watchToasts();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
    await sleep(150);
    await click(await pointAt(`() => { const row = (${rowFinder("Checkout Passes")})();
      return row && [...row.querySelectorAll('.action-label')].find(action => (action.getAttribute('aria-label') || action.title || '').startsWith('Debug Test')); }`,
    "Checkout Passes Debug Test action"), "Checkout Passes row: Debug Test");
    const session = await started;
    const entry = debug.sessions.get(session.id);
    assert.equal(entry.adapter.backendId, "robot-companion-native", "Debug Test uses the native execution provider");
    assert.deepEqual(session.configuration.args, ["--test", "Checkout Passes"]);
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === checkoutUri && editor.selection.active.line === line &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, "paused at the breakpoint in Checkout Passes", 60000);
    // Continue at once, as a user who only wanted to see the stop does: VS Code
    // still asks for the rest of the call stack after the Robot run resumed.
    await key("F5", "F5", 116);
    await screenshot("test-explorer-native-debug-continued");
    await until(() => tests.lastRun?.length === 1, "Debug Test result", 60000);
    const [result] = tests.lastRun;
    assert.equal(result.robotStatus, "PASS");
    assert.equal(result.source, "output.xml");
    await showTesting();
    await until(async () => /^Checkout Passes \(Passed\)/.test(await page(`(() => { const row = (${rowFinder("Checkout Passes")})();
      return row && row.getAttribute('aria-label'); })()`) || ""), "Checkout Passes shows Passed");
    await screenshot("test-explorer-native-debug-passed");
    await until(() => debug.sessions.size === 0, "Debug Test sessions released", 10000);
    await assertQuietNativeEnd(stopWatching, session, "test-explorer-native-debug");
    await until(() => !backendProcesses().some(item => /debug|worker|debugpy|run/.test(item.kind)), "no debug process remains", 10000);
    evidence.push({ result: "Debug Test with native execution", backend: entry.adapter.backendId, robotStatus: result.robotStatus,
      outputDir: result.outputDir });
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

    // RobotCode execution with its own discovery service: RobotCode discovers (the fallback setting is not used).
    await select({ language: "native", execution: "robotcode", discovery: "robotcodeDiscovery" });
    await until(() => tests.controller?.items.get(checkoutUri)?.children.size === 3, "RobotCode discovery from executionBackend", 90000);
    assert.equal(tests.roots.get(folder.uri.toString()).setting, "executionBackend");
    discovery.push({ language: "native", execution: "robotcode", discovery: "robotCompanion.executionBackend (RobotCode 2.7.0)",
      hover: await statusHover(["Tests: RobotCode 2.7.0", `Debug: ${LABEL.robotcode}`]) });
    await rest();
    await select({ mode: "coexistence" });
    assert.equal(tests.controller, undefined);
    evidence.push({ discovery });
  });

  test("coexistence with both providers configured: no owned providers and no process", async function () {
    this.timeout(120000);
    await select({ language: "native", execution: "native", discovery: "robotcodeDiscovery", mode: "coexistence" });
    await sleep(2000);
    assert.equal(manager.roots.size, 0, "no owned language root");
    assert.equal(tests.controller, undefined, "no test controller");
    assert.deepEqual(kinds(), [], "no backend process");
    const audit = (await openAuditAt("Build Record")).document;
    const line = audit.getText().split("\n").findIndex(row => row.includes("Build Record"));
    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", audit.uri, new vscode.Position(line, 20));
    assert.equal(definitions.length, 0, "no owned definition provider");
    const hover = await statusHover(["Language: coexistence", "Debug: coexistence", "Tests: coexistence"]);
    await rest();
    await vscode.commands.executeCommand("notifications.clearAll");
    assert.equal(await vscode.debug.startDebugging(folder, launchName), false);
    await until(async () => /coexistence/.test(await toasts()), "coexistence debug refusal");
    assert.deepEqual(kinds(), []);
    evidence.push({ coexistence: { roots: 0, controller: "none", processes: [], hover } });
    await select({ mode: "coexistence" });
  });
});

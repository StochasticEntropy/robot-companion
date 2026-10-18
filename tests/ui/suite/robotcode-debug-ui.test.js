"use strict";

// Live mixed Robot/Python debugging through the pinned RobotCode 2.7.0 bridge,
// driven by actual pointer and keyboard input. Skipped by name (pending) when
// the prepared RobotCode environment is absent; never reported as a pass.
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

suite("Owned debugging with the pinned RobotCode 2.7.0 bridge (live)", () => {
  let extension, debug, folder, config, cdp, tracker;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const launchName = "Robot Companion: Debug audit (RobotCode)";
  const auditUri = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot");
  const libraryUri = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "AuditLibrary.py");

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function pointer(point, label) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, name + ".png"), Buffer.from(data, "base64"));
  }
  // Click the breakpoint gutter of the visible editor showing `marker` at a one-based line.
  // Late CodeLens rendering shifts lines: click only a layout-stable point and
  // check that the click created the breakpoint on the intended line.
  async function clickGutter(marker, line) {
    const fileOf = breakpoint => path.basename(breakpoint.location.uri.fsPath);
    for (let attempt = 1; ; attempt++) {
      const before = new Set(vscode.debug.breakpoints);
      await clickGutterOnce(marker, line);
      try {
        await until(() => vscode.debug.breakpoints.some(b => !before.has(b)), `breakpoint from gutter ${marker}:${line}`, 3000);
      } catch (error) { if (attempt === 3) throw error; continue; }
      const added = vscode.debug.breakpoints.filter(b => !before.has(b));
      if (added.every(b => b.location.range.start.line === line - 1)) return;
      evidence.push({ retry: "gutter click hit another line", lines: added.map(b => `${fileOf(b)}:${b.location.range.start.line + 1}`) });
      vscode.debug.removeBreakpoints(added);
      if (attempt === 3) throw new Error(`Gutter click for ${marker}:${line} kept missing its line.`);
    }
  }
  async function clickGutterOnce(marker, line) {
    let point, previous;
    await until(async () => {
      point = await page(`(() => {
        const editor = [...document.querySelectorAll('.monaco-editor')].find(e =>
          e.closest('.editor-instance') && e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(marker)}));
        if (!editor) return;
        const number = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === ${JSON.stringify(String(line))});
        const glyph = editor.querySelector('.margin-view-overlays') ;
        if (!number || !glyph) return;
        const row = number.getBoundingClientRect(), margin = glyph.getBoundingClientRect();
        return { x: margin.x + 8, y: row.y + row.height / 2 };
      })()`);
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(200);
      return stable;
    }, `gutter ${marker}:${line}`);
    await pointer(point, `breakpoint gutter ${marker} line ${line}`);
  }
  async function typeInConsole(text) {
    await key("Y", "KeyY", 89, 10); // Linux Ctrl+Shift+Y: Debug Console
    let point;
    await until(async () => {
      point = await page(`(() => {
        const input = document.querySelector('.repl .repl-input-wrapper .monaco-editor');
        if (!input || !input.getClientRects().length) return;
        const r = input.getBoundingClientRect();
        return { x: r.x + 20, y: r.y + r.height / 2 };
      })()`);
      return point;
    }, "Debug Console input");
    await pointer(point, "Debug Console input");
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
    await key("Enter", "Enter", 13);
  }
  const evaluations = () => protocol.filter(m => m.response === "evaluate");
  async function evaluated(expression, label) {
    const before = evaluations().length;
    await typeInConsole(expression);
    await until(() => evaluations().length > before, `evaluate ${label}`);
    const result = evaluations()[before];
    evidence.push({ result: "Debug Console", expression, session: result.session, value: result.value, success: result.success });
    return result;
  }
  const stops = () => protocol.filter(m => m.event === "stopped");
  async function stoppedAt(file, line, label) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith(file) && editor.selection.active.line === line - 1 &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, label, 45000);
    const item = vscode.debug.activeStackItem;
    evidence.push({ result: "paused", file, line, session: item.session.name, threadId: item.threadId });
    return item;
  }

  suiteSetup(async function () {
    if (!fs.existsSync(python)) this.skip();
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    debug = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    assert.equal(vscode.extensions.getExtension("ms-python.python"), undefined, "Python extension must be absent");
    assert.equal(vscode.extensions.getExtension("ms-python.debugpy"), undefined, "debugpy extension must be absent");
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Start from the copied audit corpus: earlier suites may have saved edits.
    const fixture = path.join(extension.extensionPath, "tests/integration/fixtures/audit-v1");
    for (const name of ["audit.robot", "AuditLibrary.py", "shared.resource"]) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", name), fs.readFileSync(path.join(fixture, name)));
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    cdp = await WebviewCdp.connect();
    tracker = vscode.debug.registerDebugAdapterTrackerFactory("robotcompanion", {
      createDebugAdapterTracker: session => ({
        onWillReceiveMessage: message => protocol.push({ session: session.name, to: "adapter", command: message.command,
          expression: message.arguments?.expression }),
        onDidSendMessage: message => protocol.push({ session: session.name, from: "adapter", type: message.type,
          response: message.type === "response" ? message.command : undefined, success: message.success,
          value: message.command === "evaluate" ? message.body?.result : undefined,
          event: message.event, reason: message.body?.reason, output: message.event === "output" ? message.body?.output : undefined })
      })
    });
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const descriptor = robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python, services: ["debug"] });
    await config.update("executionBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName,
      target: "${workspaceFolder}/integration-audit-v1/audit.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: "RobotCode 2.7.0 debug-launch",
      executable: descriptor.services.debug.executable, argv: descriptor.services.debug.argv,
      externalExtensions: "RobotCode, Python and debugpy extensions absent",
      viewport: await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`) });
  });
  suiteTeardown(async () => {
    if (!extension) return;
    tracker?.dispose();
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined,
      vscode.ConfigurationTarget.WorkspaceFolder);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "robotcode-debug-ui-actions.json"),
      JSON.stringify({ evidence, protocol }, null, 2));
    cdp?.close();
  });

  test("Robot pause, live keyword, Python pause/step/count, selected Robot frame, live resource keyword, 1 PASS", async function () {
    this.timeout(240000);
    await vscode.window.showTextDocument(auditUri(), { preview: false });
    await clickGutter("${record}=    Build Record", 12);
    await clickGutter("Resource Step    ${record.name}", 13);
    await vscode.window.showTextDocument(libraryUri(), { preview: false });
    await clickGutter("count = len(name)", 18);
    await until(() => vscode.debug.breakpoints.length === 3, "three breakpoints from gutter clicks");
    const lines = vscode.debug.breakpoints.map(b => `${path.basename(b.location.uri.fsPath)}:${b.location.range.start.line + 1}`).sort();
    assert.deepEqual(lines, ["AuditLibrary.py:18", "audit.robot:12", "audit.robot:13"]);
    evidence.push({ breakpoints: lines });

    await vscode.window.showTextDocument(auditUri(), { preview: false });
    await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D: Run and Debug
    await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
      item.textContent.includes(${JSON.stringify(launchName)}) ||
      [...item.querySelectorAll('select option')].some(option => option.selected && option.text.includes(${JSON.stringify(launchName)})))`),
    "RobotCode launch configuration selected");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    const point = await page(`(() => { const e = document.querySelector('.start-debug-action-item .codicon-debug-start');
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await pointer(point, "Run and Debug start button");
    const parent = await started;
    const entry = debug.sessions.get(parent.id);
    const { adapter } = entry;
    const outputDir = adapter.context.outputDir;
    const processGroup = adapter.child.pid;

    await stoppedAt("audit.robot", 12, "Robot breakpoint audit.robot:12");
    await screenshot("robotcode-debug-robot-12");
    const robotLive = await evaluated("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", "Robot keyword");
    assert.equal(robotLive.session, parent.name);
    assert.equal(robotLive.value, "'from-suite-console'");
    await until(() => page(`document.querySelector('.repl')?.innerText.includes("'from-suite-console'")`), "Robot result in Debug Console");

    await key("F5", "F5", 116); // Continue
    await stoppedAt("AuditLibrary.py", 18, "Python breakpoint AuditLibrary.py:18");
    const pythonSession = vscode.debug.activeStackItem.session;
    assert.equal(pythonSession.parentSession?.id, parent.id, "Python child belongs to the Robot session");
    assert.ok(entry.pythonChild, "Python child session tracked by the owned parent");
    await key("F10", "F10", 121); // Step Over
    await stoppedAt("AuditLibrary.py", 19, "Python step to line 19");
    const count = await evaluated("count", "Python local");
    assert.equal(count.session, pythonSession.name);
    assert.equal(count.value, "3");
    await screenshot("robotcode-debug-python-19");

    await key("F5", "F5", 116);
    await until(() => protocol.some(m => m.session === parent.name && m.event === "stopped" &&
      stops().filter(s => s.session === parent.name).length >= 2), "second Robot stop", 45000);
    // Select the Robot frame in Call Stack with the pointer so the console routes to Robot.
    let row;
    await until(async () => {
      row = await page(`(() => {
        const rows = [...document.querySelectorAll('.debug-call-stack .monaco-list-row')];
        const frame = rows.find(r => /audit\\.robot/.test(r.innerText) && /\\b13\\b/.test(r.innerText));
        if (!frame) return;
        const rect = frame.getBoundingClientRect();
        return { x: rect.x + rect.width / 3, y: rect.y + rect.height / 2, text: frame.innerText };
      })()`);
      return row;
    }, "Robot frame row in Call Stack");
    await pointer({ x: row.x, y: row.y }, `Call Stack Robot frame: ${row.text.replace(/\s+/g, " ")}`);
    await stoppedAt("audit.robot", 13, "selected Robot frame audit.robot:13");
    assert.equal(vscode.debug.activeStackItem.session.id, parent.id, "selected frame belongs to the Robot session");
    await screenshot("robotcode-debug-robot-13");
    const resourceLive = await evaluated("Resource Step    ${record.name}", "resource keyword");
    assert.equal(resourceLive.session, parent.name, "console routed back to the Robot session");
    assert.equal(resourceLive.success, true);

    const terminated = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(ended => {
        if (ended.id === parent.id) { listener.dispose(); resolve(); }
      });
    });
    await key("F5", "F5", 116);
    await terminated;
    const xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.match(xml, /<msg[^>]*>Ada<\/msg>/);
    await until(() => debug.sessions.size === 0, "sessions released");
    await until(() => { try { process.kill(-processGroup, 0); return false; } catch { return true; } }, "debug process group gone", 5000);
    await screenshot("robotcode-debug-finished");
    evidence.push({ result: "1 PASS", outputDir, processGroup: "gone", pythonChildSession: pythonSession.name,
      protocolStops: stops().map(s => `${s.session}:${s.reason}`) });
  });
});

"use strict";

// Live mixed Robot/Python debugging through each execution provider (the pinned
// RobotCode 2.7.0 bridge and the native backend with its debugpy handoff v1),
// driven by actual pointer and keyboard input. Skipped by name (pending) when a
// provider's prepared environment is absent; never reported as a pass.
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

// What differs between providers: descriptor and Debug Console output.
const PROVIDERS = [
  {
    key: "robotcode", title: "the pinned RobotCode 2.7.0 bridge", label: "RobotCode", available: () => fs.existsSync(python),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"))
      .robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python, services: ["debug"] }),
    providerLine: "Robot Companion debug provider: RobotCode 2.7.0",
    // RobotCode: Log messages reach the console; its internal debugpy-port line does not.
    consoleRows(rows) {
      assert.equal(rows.filter(row => /start debugpy session/.test(row)).length, 0, "internal line absent from the Debug Console");
      assert.ok(rows.some(row => /^Ada\b/.test(row)), "the test's Log message is shown");
      assert.ok(rows.some(row => /^local-step\b/.test(row)), "the keyword's Log message is shown");
      // The first program output row (after Robot Companion's own provider lines) is debugpy's warning.
      assert.match(rows.find(row => !row.startsWith("Robot Companion")), /Debugger warning: It seems that frozen modules/,
        "first program row is debugpy's warning");
    },
    consoleOutput(output) {
      assert.doesNotMatch(output, /start debugpy session/, "no output event carries the internal line");
      assert.match(output, /^Ada$/m);
      assert.match(output, /^local-step$/m);
    }
  },
  {
    key: "native", title: "the native backend", label: "Native backend", available: () => Boolean(nativeExecutable),
    descriptor: (extension, folder) => require(path.join(extension.extensionPath, "src/integration/native-backend"))
      .nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable, services: ["debug"] }),
    providerLine: "Robot Companion debug provider: Native backend 0.1.0.dev1",
    // Native: the Robot worker's console output; Robot Log messages stay in output.xml.
    consoleRows(rows) {
      assert.ok(rows.some(row => /Debug Smoke/.test(row)), "Robot's console lists the test");
    },
    consoleOutput(output) {
      assert.doesNotMatch(output, /robotCompanion\/python/, "no handoff detail reaches the console");
    }
  }
];

for (const provider of PROVIDERS) defineSuite(provider);

function defineSuite(provider) {
suite(`Owned debugging with ${provider.title} (live)`, () => {
  let extension, debug, folder, config, cdp, tracker;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const launchName = `Robot Companion: Debug audit (${provider.label})`;
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
    fs.writeFileSync(path.join(evidenceDirectory, `${provider.key}-${name.replace(/^robotcode-/, "")}.png`), Buffer.from(data, "base64"));
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
  // Linux Ctrl+Shift+Y toggles the Debug Console: press it only when hidden.
  async function showConsole() {
    const visible = () => page(`Boolean(document.querySelector('.repl .repl-input-wrapper .monaco-editor')?.getClientRects().length)`);
    if (!await visible()) await key("Y", "KeyY", 89, 10);
    await until(visible, "Debug Console visible");
  }
  async function typeInConsole(text) {
    await showConsole();
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
  // Read the whole Debug Console the way a person does: wheel to the top, then
  // down until the end, collecting every row the virtualized list renders.
  async function readConsole() {
    const center = await page(`(() => { const r = document.querySelector('.repl .monaco-list').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const wheel = deltaY => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY }, cdp.pageSession);
    const visibleRows = () => page(`[...document.querySelectorAll('.repl .monaco-list-row')].map(row =>
      [Number(row.getAttribute('data-index')), row.innerText.trim()])`);
    for (let i = 0; i < 30; i++) await wheel(-2000);
    await sleep(200);
    await screenshot("robotcode-debug-console-top");
    const rows = new Map();
    let unchanged = 0;
    for (let step = 0; step < 200 && unchanged < 3; step++) {
      const before = rows.size;
      for (const [index, text] of await visibleRows()) rows.set(index, text);
      unchanged = rows.size === before ? unchanged + 1 : 0;
      await wheel(120);
      await sleep(60);
    }
    evidence.push({ action: "wheel", target: "Debug Console, top to bottom", rows: rows.size });
    const indices = [...rows.keys()].sort((a, b) => a - b);
    assert.deepEqual(indices, indices.map((_, i) => i), "every Debug Console row from the first one was read");
    return indices.map(index => rows.get(index));
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
    if (!provider.available()) this.skip();
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
          message: message.type === "response" && !message.success ? message.message : undefined,
          event: message.event, reason: message.body?.reason, output: message.event === "output" ? message.body?.output : undefined })
      })
    });
    const descriptor = provider.descriptor(extension, folder);
    await config.update("executionBackend", JSON.parse(JSON.stringify(descriptor)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName,
      target: "${workspaceFolder}/integration-audit-v1/audit.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "Debug Console checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: provider.providerLine,
      executable: descriptor.services.debug.executable, argv: descriptor.services.debug.argv,
      externalExtensions: "RobotCode, Python and debugpy extensions absent",
      viewport });
  });
  suiteTeardown(async () => {
    if (!extension) return;
    tracker?.dispose();
    for (const { session } of [...(debug?.sessions.values() || [])]) {
      try { await vscode.debug.stopDebugging(session); } catch (error) { evidence.push({ teardown: error.message }); }
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined,
      vscode.ConfigurationTarget.WorkspaceFolder);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `${provider.key}-debug-ui-actions.json`),
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
    `${provider.label} launch configuration selected`);
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
    let ownedGroups = [];

    await stoppedAt("audit.robot", 12, "Robot breakpoint audit.robot:12");
    // Debug Console before any input (rendered rows only; the filter checks at
    // the end cover the whole session output): it names the provider.
    await showConsole();
    await until(() => protocol.some(m => m.session === parent.name && m.output?.startsWith(provider.providerLine)),
      "provider line sent to the Debug Console");
    const earlyConsole = await page(`document.querySelector('.repl').innerText`);
    assert.doesNotMatch(earlyConsole, /start debugpy session|robotCompanion\/python/, "no internal handoff detail is shown");
    evidence.push({ result: "Debug Console at first stop", text: earlyConsole });
    await screenshot("robotcode-debug-console-first-stop");
    await screenshot("robotcode-debug-robot-12");
    const robotLive = await evaluated("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", "Robot keyword");
    assert.equal(robotLive.session, parent.name);
    assert.equal(robotLive.value, "'from-suite-console'");
    await until(() => page(`document.querySelector('.repl')?.innerText.includes("'from-suite-console'")`), "Robot result in Debug Console");

    await key("F5", "F5", 116); // Continue
    await stoppedAt("AuditLibrary.py", 18, "Python breakpoint AuditLibrary.py:18");
    ownedGroups = [...adapter.ownedGroups];
    const pythonSession = vscode.debug.activeStackItem.session;
    assert.equal(pythonSession.parentSession?.id, parent.id, "Python child belongs to the Robot session");
    assert.ok(entry.pythonChild, "Python child session tracked by the owned parent");
    await key("F10", "F10", 121); // Step Over
    await stoppedAt("AuditLibrary.py", 19, "Python step to line 19");
    // Call Stack keeps the Robot session, with the paused Python child under it.
    const callStack = await page(`[...document.querySelectorAll('.debug-call-stack .monaco-list-row')].map(row =>
      ({ text: row.innerText.replace(/\\s+/g, ' ').trim(), level: Number(row.getAttribute('aria-level')) }))`);
    const robotRow = callStack.find(row => row.text.startsWith(parent.name));
    const pythonRow = callStack.find(row => row.text.startsWith(pythonSession.name));
    assert.ok(robotRow && pythonRow && pythonRow.level > robotRow.level, `Call Stack while Python is paused: ${JSON.stringify(callStack)}`);
    evidence.push({ result: "Call Stack while Python is paused", rows: callStack });
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
    // The whole session's Debug Console: the provider line and program output.
    await showConsole();
    const consoleRows = await readConsole();
    assert.ok(consoleRows.some(row => row.startsWith(provider.providerLine)), "the session names its provider");
    assert.ok(consoleRows.some(row => row.includes("1 test, 1 passed, 0 failed")), "Robot console summary shown");
    provider.consoleRows(consoleRows);
    evidence.push({ result: "Debug Console rows", rows: consoleRows });
    const consoleOutput = protocol.filter(m => m.output).map(m => m.output).join("");
    provider.consoleOutput(consoleOutput);
    await screenshot("robotcode-debug-console-end");
    await until(() => debug.sessions.size === 0, "sessions released");
    const gone = pid => { try { process.kill(-pid, 0); return false; } catch { return true; } };
    // The backend's own group, plus any further groups it reported (native: Robot worker, debugpy adapter).
    const groups = [processGroup, ...ownedGroups];
    await until(() => groups.every(gone), "debug process groups gone", 8000);
    await screenshot("robotcode-debug-finished");
    evidence.push({ result: "1 PASS", outputDir, processGroups: groups, processGroup: "gone", pythonChildSession: pythonSession.name,
      protocolStops: stops().map(s => `${s.session}:${s.reason}`) });
  });

  if (provider.key !== "native") return;

  const groupGone = pid => { try { process.kill(-pid, 0); return false; } catch { return true; } };
  const pidGone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const robotStops = session => stops().filter(s => s.session === session.name).length;
  async function toolbar(icon, label) {
    let point;
    await until(async () => {
      point = await page(`(() => { const e = [...document.querySelectorAll('.debug-toolbar .codicon-${icon}')]
        .find(item => item.getClientRects().length); if (!e) return;
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      return point;
    }, `debug toolbar ${label}`);
    await pointer(point, `debug toolbar ${label}`);
  }
  // Toolbar Restart, then the replacement run's first Robot stop at audit.robot:12.
  async function restartFromToolbar(parent, label) {
    const before = robotStops(parent);
    const requests = protocol.filter(m => m.session === parent.name && m.response === "restart").length;
    await toolbar("debug-restart", "Restart");
    await until(() => protocol.filter(m => m.session === parent.name && m.response === "restart").length > requests,
      `restart response (${label})`, 45000);
    const reply = protocol.filter(m => m.session === parent.name && m.response === "restart").at(-1);
    assert.equal(reply.success, true, `restart ${label} succeeded`);
    await until(() => robotStops(parent) > before, `Robot stop after restart (${label})`, 45000);
    await stoppedAt("audit.robot", 12, `restarted run at audit.robot:12 (${label})`);
    assert.equal(vscode.debug.activeStackItem.session.id, parent.id, "the same Robot session continues after restart");
  }

  test("native toolbar Restart while Robot and while Python are paused keeps breakpoints, replaces the child, 1 PASS", async function () {
    this.timeout(240000);
    assert.deepEqual(vscode.debug.breakpoints.map(b => `${path.basename(b.location.uri.fsPath)}:${b.location.range.start.line + 1}`).sort(),
      ["AuditLibrary.py:18", "audit.robot:12", "audit.robot:13"], "gutter breakpoints from the previous journey");
    await vscode.window.showTextDocument(auditUri(), { preview: false });
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    await key("F5", "F5", 116); // Start Debugging with the selected configuration
    const parent = await started;
    const entry = debug.sessions.get(parent.id);
    const firstOutput = entry.outputDir;
    await stoppedAt("audit.robot", 12, "first run at audit.robot:12");
    await until(() => entry.pythonChild, "first Python child");
    const firstChild = entry.pythonChild;
    const firstGroups = [entry.pid, ...entry.adapter.ownedGroups].filter(pid => pid !== entry.pid);
    assert.ok(firstGroups.length >= 2, `worker and debugpy groups reported: ${firstGroups}`);
    await screenshot("restart-before");

    // 1. Robot paused: Restart in the debug toolbar.
    await restartFromToolbar(parent, "Robot paused");
    await until(() => firstGroups.every(groupGone), "first generation's worker and debugpy groups gone", 8000);
    await until(() => entry.pythonChild && entry.pythonChild.id !== firstChild.id, "replacement Python child");
    assert.notEqual(entry.outputDir, firstOutput, "a restarted launch writes a new output folder");
    const robotLive = await evaluated("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", "Robot keyword after restart");
    assert.equal(robotLive.session, parent.name);
    assert.equal(robotLive.value, "'from-suite-console'");
    await screenshot("restart-robot-12");

    // 2. Python paused in the library keyword: the child's Restart restarts the Robot parent.
    await key("F5", "F5", 116);
    await stoppedAt("AuditLibrary.py", 18, "Python breakpoint after restart");
    const secondChild = vscode.debug.activeStackItem.session;
    assert.equal(secondChild.parentSession?.id, parent.id);
    assert.equal((await evaluated("name", "Python argument after restart")).value, "'Ada'");
    const secondGroups = [...entry.adapter.ownedGroups];
    await screenshot("restart-python-18");
    await restartFromToolbar(parent, "Python paused");
    await until(() => secondGroups.every(groupGone), "second generation's groups gone", 8000);
    await until(() => entry.pythonChild && entry.pythonChild.id !== secondChild.id, "third Python child");

    // The final run: Python, the second Robot breakpoint, then the end.
    await key("F5", "F5", 116);
    await stoppedAt("AuditLibrary.py", 18, "Python breakpoint in the final run");
    const beforeLast = robotStops(parent);
    await key("F5", "F5", 116);
    await until(() => robotStops(parent) > beforeLast, "Robot stop at line 13 in the final run", 45000);
    await stoppedAt("audit.robot", 13, "final run at audit.robot:13");
    const lastOutput = entry.outputDir;
    const terminated = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(ended => {
        if (ended.id === parent.id) { listener.dispose(); resolve(); }
      });
    });
    await key("F5", "F5", 116);
    await terminated;
    assert.match(fs.readFileSync(path.join(lastOutput, "output.xml"), "utf8"), /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    const lastGroups = [entry.pid, ...entry.adapter.ownedGroups];
    await until(() => debug.sessions.size === 0, "sessions released");
    await until(() => [entry.pid, ...firstGroups, ...secondGroups, ...lastGroups].every(groupGone), "every generation's groups gone", 8000);
    await screenshot("restart-finished");
    evidence.push({ result: "restart journey", outputDirs: [firstOutput, lastOutput], generations: [firstGroups, secondGroups],
      restarts: protocol.filter(m => m.session === parent.name && m.response === "restart").map(m => m.success) });
  });

  test("native prepared-session attach through Run and Debug: Robot and Python stops, console routing, toolbar Stop ends the owner", async function () {
    this.timeout(240000);
    assert.equal(debug.sessions.size, 0, "no owned session left from an earlier test");
    const { spawn } = require("node:child_process");
    const attachName = "Robot Companion: Attach prepared run";
    // The user's terminal: `robot-companion-backend dap-prepare` for this workspace folder.
    const owner = spawn(nativeExecutable, ["dap-prepare", "--workspace", folder.uri.fsPath,
      "--cwd", path.join(folder.uri.fsPath, "integration-audit-v1"), "--target", "audit.robot", "--attach-python"],
    { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    owner.stdout.on("data", chunk => { stdout += chunk; });
    owner.stderr.on("data", chunk => { stderr += chunk; });
    const exited = new Promise(resolve => owner.once("exit", code => resolve(code)));
    try {
      await until(() => /^preparedSession: (.+)$/m.test(stdout), `dap-prepare publishes its descriptor (${stderr})`, 40000);
      const preparedSession = stdout.match(/^preparedSession: (.+)$/m)[1].trim();
      evidence.push({ action: "terminal", command: "robot-companion-backend dap-prepare --attach-python", stdout });
      // Unsupported attach forms are refused visibly and start nothing.
      const refused = await vscode.debug.startDebugging(folder, { type: "robotcompanion", request: "attach",
        name: "Attach by process", processId: owner.pid });
      assert.equal(refused, false);
      await until(() => page(`document.querySelector('.notifications-toasts')?.innerText.includes('processId, host, port and secret attach are not supported')`),
        "processId attach refusal notification");
      await screenshot("attach-refused");
      await vscode.commands.executeCommand("notifications.clearAll");
      await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [
        { type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-audit-v1/audit.robot" },
        { type: "robotcompanion", request: "attach", name: attachName, preparedSession }], vscode.ConfigurationTarget.WorkspaceFolder);
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "attach" && session.configuration.preparedSession) { listener.dispose(); resolve(session); }
        });
      });
      // Command Palette: Debug: Select and Start Debugging, then the attach configuration.
      await key("F1", "F1", 112);
      await sleep(400);
      await cdp.send("Input.insertText", { text: "Debug: Select and Start Debugging" }, cdp.pageSession);
      evidence.push({ action: "type", text: "Debug: Select and Start Debugging" });
      await sleep(400);
      await key("Enter", "Enter", 13);
      await sleep(600);
      await cdp.send("Input.insertText", { text: attachName }, cdp.pageSession);
      evidence.push({ action: "type", text: attachName });
      await sleep(400);
      await key("Enter", "Enter", 13);
      const parent = await started;
      const entry = debug.sessions.get(parent.id);
      assert.deepEqual(entry.adapter.service.argv, ["dap-connect"], "the native connector carries the attach");
      await stoppedAt("audit.robot", 12, "prepared run at audit.robot:12");
      assert.equal(fs.existsSync(preparedSession), false, "the attach consumed the descriptor");
      assert.deepEqual([...entry.adapter.ownedGroups], [], "the owner's processes are not the extension's to signal");
      const robotLive = await evaluated("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", "Robot keyword (attached)");
      assert.equal(robotLive.session, parent.name);
      assert.equal(robotLive.value, "'from-suite-console'");
      await screenshot("attach-robot-12");
      await key("F5", "F5", 116);
      await stoppedAt("AuditLibrary.py", 18, "Python breakpoint (attached)");
      const child = vscode.debug.activeStackItem.session;
      assert.equal(child.parentSession?.id, parent.id);
      assert.equal((await evaluated("name", "Python argument (attached)")).value, "'Ada'");
      await screenshot("attach-python-18");
      const processes = protocol.filter(m => m.session === parent.name && m.event === "process");
      const terminated = new Promise(resolve => {
        const listener = vscode.debug.onDidTerminateDebugSession(ended => {
          if (ended.id === parent.id) { listener.dispose(); resolve(); }
        });
      });
      // An attach session shows Disconnect where a launch shows Stop.
      const stopIcon = await page(`document.querySelector('.debug-toolbar .codicon-debug-disconnect') ? 'debug-disconnect' : 'debug-stop'`);
      await toolbar(stopIcon, "Stop/Disconnect");
      await terminated;
      assert.equal(await exited, 0, `dap-prepare exits normally after Stop: ${stderr}`);
      await until(() => debug.sessions.size === 0, "attached session released");
      await until(() => pidGone(owner.pid), "prepared owner gone", 8000);
      await screenshot("attach-stopped");
      evidence.push({ result: "prepared attach", preparedSession, ownerExit: 0, toolbar: stopIcon, ownerStderr: stderr,
        processEvents: processes.length });
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
      await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
        type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-audit-v1/audit.robot"
      }], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  // Command Palette: Debug: Select and Start Debugging, then the named configuration.
  async function selectAndStart(name) {
    await key("F1", "F1", 112);
    await sleep(400);
    await cdp.send("Input.insertText", { text: "Debug: Select and Start Debugging" }, cdp.pageSession);
    evidence.push({ action: "type", text: "Debug: Select and Start Debugging" });
    await sleep(400);
    await key("Enter", "Enter", 13);
    await sleep(600);
    await cdp.send("Input.insertText", { text: name }, cdp.pageSession);
    evidence.push({ action: "type", text: name });
    await sleep(400);
    await key("Enter", "Enter", 13);
  }
  const visibleToolbar = () => page(`Boolean([...document.querySelectorAll('.debug-toolbar')].some(e => e.getClientRects().length))`);
  const progressShown = () => page(`Boolean([...document.querySelectorAll('.activitybar .progress-badge, .composite.title .monaco-progress-container.active, .monaco-progress-container.active.infinite')]
    .some(e => e.getClientRects().length))`);
  const notificationText = () => page(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-center .notification-list-item-message')]
    .map(e => e.innerText).join('\\n')`);
  // No session, toolbar or progress is left, and the extension owns nothing.
  async function nothingLeft(label) {
    await until(async () => !vscode.debug.activeDebugSession && debug.sessions.size === 0 && !await visibleToolbar() &&
      !await progressShown(), `${label}: no debug session, toolbar or progress left`, 15000);
  }
  // A following start works normally: the launch reaches audit.robot:12, then toolbar Stop ends it.
  async function launchWorksAfter(label) {
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch" && !session.parentSession) { listener.dispose(); resolve(session); }
      });
    });
    await selectAndStart(launchName);
    const session = await Promise.race([started, sleep(30000).then(async () => {
      await screenshot(`next-start-missing-${label.replace(/\W+/g, "-")}`);
      throw new Error(`${label}: the next launch did not start; notifications: ${await notificationText()}`);
    })]);
    const entry = debug.sessions.get(session.id);
    await stoppedAt("audit.robot", 12, `${label}: next launch stops at audit.robot:12`);
    const groups = [entry.pid, ...entry.adapter.ownedGroups];
    const ended = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(e => { if (e.id === session.id) { listener.dispose(); resolve(); } });
    });
    await toolbar("debug-stop", "Stop");
    await ended;
    await nothingLeft(`${label}: after the next launch`);
    await until(() => groups.every(groupGone), `${label}: next launch's process groups gone`, 8000);
    evidence.push({ result: `${label}: next launch started normally and stopped cleanly`, processGroups: groups });
  }

  test("native changed-input Restart is declined with its reason; the paused session stays usable; Stop and the next start work", async function () {
    this.timeout(240000);
    assert.equal(debug.sessions.size, 0, "no owned session left from an earlier test");
    const launches = vscode.workspace.getConfiguration("launch", folder.uri);
    const original = { type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-audit-v1/audit.robot" };
    await launches.update("configurations", [original], vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      for (const [index, edit] of [{ attachPython: false }, { args: ["--variable", "EXTRA:1"] }].entries()) {
        const label = `changed ${Object.keys(edit)[0]}`;
        const started = new Promise(resolve => {
          const listener = vscode.debug.onDidStartDebugSession(session => {
            if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
          });
        });
        await selectAndStart(launchName);
        const parent = await started;
        const entry = debug.sessions.get(parent.id);
        await stoppedAt("audit.robot", 12, `${label}: first stop`);
        const groups = [entry.pid, ...entry.adapter.ownedGroups];
        // Edit launch.json while paused, then Restart from the toolbar.
        await launches.update("configurations", [{ ...original, ...edit }], vscode.ConfigurationTarget.WorkspaceFolder);
        const stopsBefore = robotStops(parent);
        await toolbar("debug-restart", "Restart");
        await until(async () => /Restart cannot change the target, cwd, arguments or Python debugging/.test(await notificationText()) ||
          protocol.some(m => m.session === parent.name && /Restart cannot change/.test(m.output || "")), `${label}: named reason shown`);
        await screenshot(`restart-declined-${index}`);
        // The same session is still paused at line 12: no restart happened and nothing ended.
        await sleep(1500);
        assert.equal(robotStops(parent), stopsBefore, `${label}: no new run started`);
        assert.ok(debug.sessions.has(parent.id), `${label}: the session was not released`);
        assert.ok(groups.every(pid => !groupGone(pid)), `${label}: the run's processes are still alive`);
        assert.equal(vscode.debug.activeDebugSession?.id, parent.id, `${label}: the session is still active`);
        const live = await evaluated("Catenate    SEPARATOR=-    ${SUITE_VALUE}    console", `${label}: console after decline`);
        assert.equal(live.value, "'from-suite-console'");
        const allStops = stops().length;
        await key("F5", "F5", 116); // Continue works: the run reaches its next stop (Python or Robot) or ends
        await until(() => stops().length > allStops || entry.exitCode !== undefined, `${label}: Continue resumes the run`, 45000);
        const ended = new Promise(resolve => {
          const listener = vscode.debug.onDidTerminateDebugSession(e => { if (e.id === parent.id) { listener.dispose(); resolve(); } });
        });
        if (debug.sessions.has(parent.id)) await toolbar("debug-stop", "Stop");
        await ended;
        await nothingLeft(label);
        await until(() => groups.every(groupGone), `${label}: process groups gone after Stop`, 8000);
        await vscode.commands.executeCommand("notifications.clearAll");
        await launches.update("configurations", [original], vscode.ConfigurationTarget.WorkspaceFolder);
        await launchWorksAfter(label);
      }
    } finally {
      await launches.update("configurations", [original], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test("native failed prepared attach (consumed or invalid descriptor) ends cleanly; the next start works", async function () {
    this.timeout(240000);
    assert.equal(debug.sessions.size, 0, "no owned session left from an earlier test");
    const os = require("node:os");
    const launches = vscode.workspace.getConfiguration("launch", folder.uri);
    const original = { type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-audit-v1/audit.robot" };
    if (!vscode.debug.breakpoints.some(b => b.location?.uri.fsPath === auditUri().fsPath && b.location.range.start.line === 11)) {
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(auditUri(), new vscode.Position(11, 0)))]); // setup only
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rcb-attach-ui-"));
    fs.chmodSync(directory, 0o700);
    const invalid = path.join(directory, "invalid.json");
    fs.writeFileSync(invalid, "{}", { mode: 0o600 });
    const cases = [["consumed", path.join(directory, "consumed.json"), "No prepared session descriptor"],
      ["invalid", invalid, "Invalid prepared session descriptor"]];
    try {
      for (const [label, preparedSession, reason] of cases) {
        const name = `Robot Companion: Attach ${label} descriptor`;
        await launches.update("configurations", [original, { type: "robotcompanion", request: "attach", name, preparedSession }],
          vscode.ConfigurationTarget.WorkspaceFolder);
        const ended = new Promise(resolve => {
          const listener = vscode.debug.onDidTerminateDebugSession(session => {
            if (session.configuration.preparedSession === preparedSession) { listener.dispose(); resolve(session); }
          });
        });
        await selectAndStart(name);
        await until(async () => (await notificationText()).includes("Cannot attach to the prepared Robot session") &&
          (await notificationText()).includes(reason), `${label}: named attach error shown`);
        await screenshot(`attach-failed-${label}`);
        await ended;
        await nothingLeft(`${label} attach`);
        await vscode.commands.executeCommand("notifications.clearAll");
        await launchWorksAfter(`${label} attach`);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      await launches.update("configurations", [original], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });
});
}

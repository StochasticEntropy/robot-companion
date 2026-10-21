"use strict";

// Native advanced debugging (MIS-479) in the real editor: a Hit Count entered in
// the breakpoint widget, Robot failure filters ticked in the Breakpoints view,
// Set Value in the Variables view for a Robot value and a Python local, and the
// read-only failure stop. Driven by actual pointer and keyboard input through the
// workbench's DevTools endpoint and asserted on what VS Code shows, on the DAP
// messages and on Robot's own output.xml. Skipped by name (pending) without the
// prepared native backend; never reported as a pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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
const debugProcesses = () => {
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")
      .filter(line => /robot-companion-backend dap$|-m robot_companion_backend\.worker |debugpy[/.]adapter/.test(line));
  } catch { return []; }
};

suite("Native advanced debugging in the editor: hit counts, failure filters, value edits (live, actual input)", () => {
  let extension, debug, folder, config, cdp, tracker;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const launchName = "Robot Companion: Advanced debug (synthetic)";
  const suiteUri = () => vscode.Uri.joinPath(folder.uri, "integration-advanced-debug", "advanced_debug.robot");
  const libraryUri = () => vscode.Uri.joinPath(folder.uri, "integration-advanced-debug", "DebugValues.py");

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `advanced-${name}.png`), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-").slice(0, 60)}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, `advanced-${name}.json`), JSON.stringify(await page(`
      [...document.querySelectorAll('.monaco-list-row, .action-label, .monaco-menu .action-item, .notification-toast, .monaco-inputbox input, select, .exception-widget, .breakpoint-widget')]
        .filter(e => e.getClientRects().length).slice(0, 300)
        .map(e => ({ tag: e.tagName, aria: e.getAttribute('aria-label'), text: (e.innerText || e.value || '').slice(0, 160), cls: String(e.className).slice(0, 90) }))`), null, 2));
  }
  // A visible element found by `finder` whose point is not covered by anything else.
  async function pointAt(finder, label, timeoutMs = 20000) {
    let point;
    try {
      await until(async () => {
        point = await page(`(() => {
          const element = (${finder})();
          if (!element) return;
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom > innerHeight || rect.top < 0 || rect.right > innerWidth) return;
          const x = rect.x + Math.min(rect.width / 2, 60), y = rect.y + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return hit && (hit === element || element.contains(hit) || hit.contains(element)) ? { x, y } : undefined;
        })()`);
        return point;
      }, `visible ${label}`, timeoutMs);
    } catch (error) {
      await dump(label);
      throw error;
    }
    return point;
  }
  async function click(point, label, button = "left") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    await sleep(150);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, button,
        buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0, clickCount: 1 }, cdp.pageSession);
    }
    evidence.push({ action: button === "right" ? "right-click" : "click", target: label, point });
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }
  async function type(text) {
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
  }
  const menuItem = pattern => `() => [...document.querySelectorAll('.monaco-menu .action-item .action-label')]
    .find(a => a.getClientRects().length && ${pattern}.test((a.getAttribute('aria-label') || a.textContent || '').trim()))`;

  // Opens a file and waits until its CodeLens rows are rendered, so lines no longer move.
  async function showSettled(uri) {
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    // An earlier test may have left the editor scrolled to a later stop.
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    const lenses = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri) || []).length;
    if (lenses) await until(() => page(`document.querySelectorAll('.editor-instance .codelens-decoration').length > 0`), "CodeLens rendered", 15000);
    await sleep(500);
  }
  // The breakpoint gutter point of a one-based line in the visible editor showing `marker`.
  async function gutterPoint(marker, line) {
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
    return point;
  }
  // Late CodeLens rendering shifts lines: keep a new breakpoint only on its intended line.
  async function onLine(line, create) {
    for (let attempt = 1; ; attempt++) {
      const before = new Set(vscode.debug.breakpoints);
      await create();
      const removed = [...before].filter(b => !vscode.debug.breakpoints.includes(b));
      if (removed.length) throw new Error(`A gutter click for line ${line} removed the breakpoint at line ${removed[0].location.range.start.line + 1}.`);
      try {
        await until(() => vscode.debug.breakpoints.some(b => !before.has(b)), `breakpoint at line ${line}`, 5000);
      } catch (error) {
        if (attempt === 3) throw error;
        await key("Escape", "Escape", 27);
        continue;
      }
      const added = vscode.debug.breakpoints.filter(b => !before.has(b));
      if (added.every(b => b.location.range.start.line === line - 1)) return added;
      evidence.push({ retry: "breakpoint landed on another line", lines: added.map(b => b.location.range.start.line + 1) });
      vscode.debug.removeBreakpoints(added);
      if (attempt === 3) throw new Error(`Breakpoint for line ${line} kept missing its line.`);
      await sleep(500);
    }
  }
  async function clickGutter(marker, line) {
    await onLine(line, async () => click(await gutterPoint(marker, line), `breakpoint gutter ${marker} line ${line}`));
  }
  // Gutter context menu > Add Conditional Breakpoint..., the widget's Breakpoint Type
  // select > Hit Count, then the count typed and Enter.
  async function addHitCount(marker, line, count) {
    const [added] = await onLine(line, () => enterHitCount(marker, line, count));
    assert.equal(added.hitCondition, count);
  }
  async function enterHitCount(marker, line, count) {
    await click(await gutterPoint(marker, line), `gutter ${marker} line ${line}`, "right");
    await click(await pointAt(menuItem("/^Add Conditional Breakpoint/"), "Add Conditional Breakpoint menu item"),
      "gutter menu: Add Conditional Breakpoint...");
    const select = `() => document.querySelector('.breakpoint-widget select[aria-label="Breakpoint Type"]')`;
    await click(await pointAt(select, "Breakpoint Type select"), "breakpoint widget: Breakpoint Type");
    const option = `() => [...document.querySelectorAll('.monaco-select-box-dropdown-container .monaco-list-row, .select-box-dropdown-list-container .monaco-list-row')]
      .find(row => row.getClientRects().length && /Hit Count/.test(row.innerText))`;
    await click(await pointAt(option, "Hit Count option"), "Breakpoint Type: Hit Count");
    await until(() => page(`(${select})()?.value === 'Hit Count'`), "Hit Count selected");
    await click(await pointAt(`() => document.querySelector('.breakpoint-widget .inputContainer .monaco-editor')`, "hit count input"),
      "breakpoint widget input");
    await type(count);
    await screenshot(`hit-count-${count}-typed`);
    await key("Enter", "Enter", 13);
  }
  async function showRunAndDebug() {
    await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D
    await until(() => page(`Boolean(document.querySelector('.debug-breakpoints'))`), "Run and Debug view");
  }
  const filterRow = label => `() => [...document.querySelectorAll('.debug-breakpoints .monaco-list-row')]
    .find(row => row.getClientRects().length && row.innerText.includes(${JSON.stringify(label)}))`;
  // The row's checkbox state: a native input or VS Code's toggle with aria-checked.
  const filterBoxFinder = label => `() => { const row = (${filterRow(label)})();
    return row && (row.querySelector('input[type=checkbox]') || row.querySelector('[role=checkbox]') || row.querySelector('.monaco-checkbox, .monaco-custom-toggle')); }`;
  const filterChecked = label => page(`(() => { const box = (${filterBoxFinder(label)})();
    if (!box) return 'missing: ' + ((${filterRow(label)})()?.outerHTML || '').slice(0, 1500);
    return 'checked' in box && box.tagName === 'INPUT' ? box.checked : box.getAttribute('aria-checked') === 'true' || box.classList.contains('checked'); })()`);
  // Variables rows by their accessible name, "<name>, value <value>".
  const variableRow = name => `() => [...document.querySelectorAll('.debug-variables .monaco-list-row')]
    .find(row => row.getClientRects().length && (row.getAttribute('aria-label') || '').startsWith(${JSON.stringify(name + ", value ")}))`;
  const rowText = name => page(`(() => { const row = (${variableRow(name)})(); return row && row.getAttribute('aria-label'); })()`);
  const responses = command => protocol.filter(m => m.response === command);
  // Variables view: the row's context menu > Set Value (or F2 on the selected row), then type and Enter.
  // VS Code fetches the rest of the call stack after a stop and then rebuilds Variables
  // with fresh handles; act on a row only once the session has been quiet for a moment.
  async function quiet(ms = 800) {
    let count = -1, since = Date.now();
    await until(() => {
      if (protocol.length !== count) { count = protocol.length; since = Date.now(); }
      return Date.now() - since >= ms;
    }, "debug session quiet", 15000);
  }
  async function setValue(name, value, { keyboard = false, cancel = false } = {}) {
    await quiet();
    const before = responses("setVariable").length;
    const row = await pointAt(variableRow(name), `${name} row in Variables`);
    if (keyboard) {
      await click(row, `Variables row ${name}`);
      await key("F2", "F2", 113);
    } else {
      await click(row, `Variables row ${name}`, "right");
      await click(await pointAt(menuItem("/^Set Value/"), "Set Value menu item"), `Variables ${name}: Set Value`);
    }
    const input = `() => [...document.querySelectorAll('.debug-variables input, .debug-variables textarea')].find(e => e.getClientRects().length)`;
    await pointAt(input, "Set Value input");
    await key("a", "KeyA", 65, 2); // Ctrl+A in the value input
    await type(value);
    if (cancel) {
      await key("Escape", "Escape", 27);
      await until(async () => !await page(`Boolean((${input})())`), "Set Value input closed");
      return undefined;
    }
    await key("Enter", "Enter", 13);
    await until(() => responses("setVariable").length > before, `setVariable ${name}`);
    return responses("setVariable")[before];
  }
  // Continue (F5) once VS Code has settled on the current stop; an F5 sent earlier is ignored by VS Code.
  async function resume() {
    await quiet(400);
    await key("F5", "F5", 116);
  }
  async function stoppedAt(file, line, label) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith(file) && editor.selection.active.line === line - 1 &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, label, 45000);
    evidence.push({ result: "paused", file, line, session: vscode.debug.activeStackItem.session.name });
  }
  // Stops of the Robot session; the Python child reports its own.
  const stops = () => protocol.filter(m => m.event === "stopped" && m.session === launchName);
  async function nextStop(count, label) {
    await until(() => stops().length >= count, label, 45000);
    return stops()[count - 1];
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    debug = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const fixture = path.join(extension.extensionPath, "tests/integration/fixtures/advanced-debug");
    for (const name of ["advanced_debug.robot", "DebugValues.py"]) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "integration-advanced-debug", name), fs.readFileSync(path.join(fixture, name)));
    }
    const native = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const descriptor = JSON.parse(JSON.stringify(native.nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
      executable: nativeExecutable, services: ["language", "debug"] })));
    await config.update("languageBackend", descriptor, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", descriptor, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-advanced-debug/advanced_debug.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    cdp = await WebviewCdp.connect();
    // The headless window never receives OS focus; without this an inline Set Value editor blurs at once.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, cdp.pageSession);
    tracker = vscode.debug.registerDebugAdapterTrackerFactory("robotcompanion", {
      createDebugAdapterTracker: session => ({
        onWillReceiveMessage: message => protocol.push({ session: session.name, to: "adapter", command: message.command,
          arguments: ["setVariable", "setExceptionBreakpoints", "setBreakpoints"].includes(message.command) ? message.arguments : undefined }),
        onDidSendMessage: message => protocol.push({ session: session.name, from: "adapter", type: message.type,
          response: message.type === "response" ? message.command : undefined, success: message.success,
          body: ["setVariable", "evaluate"].includes(message.command) ? message.body : undefined,
          message: message.success === false ? message.message : undefined,
          event: message.event, reason: message.body?.reason, description: message.body?.description, text: message.body?.text,
          hitBreakpointIds: message.body?.hitBreakpointIds,
          output: message.event === "output" ? message.body?.output : undefined,
          capabilities: message.command === "initialize" ? message.body : undefined })
      })
    });
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "advanced debugging checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, viewport, executable: nativeExecutable,
      externalExtensions: "RobotCode, Python and debugpy extensions absent" });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") await dump(`failed ${this.currentTest.title.slice(0, 40)}`);
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand("notifications.clearAll");
  });
  suiteTeardown(async () => {
    if (!extension) return;
    tracker?.dispose();
    for (const setting of ["languageBackend", "executionBackend"]) await config.update(setting, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    // The fixture exists only while this suite runs, so other suites' discovery never sees it.
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, "integration-advanced-debug"), { recursive: true, useTrash: false });
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-advanced-debug-ui-actions.json"),
      JSON.stringify({ evidence, protocol }, null, 2));
    cdp?.close();
  });

  test("hit count, failure filters and Set Value at 1280x900: what VS Code shows matches Robot's run", async function () {
    this.timeout(600000);
    await showSettled(suiteUri());
    await addHitCount("Local Check    ${i}", 13, "2");
    await clickGutter("Log    ${message}", 15);
    await showSettled(libraryUri());
    await clickGutter("counter = len(text)", 13);
    await showSettled(suiteUri());
    const placed = vscode.debug.breakpoints.map(b => `${path.basename(b.location.uri.fsPath)}:${b.location.range.start.line + 1}` +
      (b.hitCondition ? ` hit ${b.hitCondition}` : "")).sort();
    assert.deepEqual(placed, ["DebugValues.py:13", "advanced_debug.robot:13 hit 2", "advanced_debug.robot:15"]);
    evidence.push({ breakpoints: placed });
    await showRunAndDebug();
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
      [...item.querySelectorAll('select option')].some(option => option.selected && option.text.includes(${JSON.stringify(launchName)})) ||
      item.textContent.includes(${JSON.stringify(launchName)}))`), "launch configuration selected");
    await click(await pointAt(`() => document.querySelector('.start-debug-action-item .codicon-debug-start')`, "start button"), "Run and Debug start");
    const session = await started;
    const entry = debug.sessions.get(session.id);
    const outputDir = entry.adapter.context.outputDir;

    // Hit count 2: the first stop is the second Local Check call.
    const first = await nextStop(1, "hit-count stop");
    assert.equal(first.reason, "breakpoint");
    await stoppedAt("advanced_debug.robot", 13, "stop at advanced_debug.robot:13");
    await until(async () => /^\$\{i\}, value 2$/.test(await rowText("${i}") || ""), "${i} is 2 in Variables");
    await screenshot("hit-count-stop");
    // U2: both Robot failure filters are listed, off; tick failed keyword with the pointer.
    for (const label of ["Robot: failed keyword (includes handled failures)", "Robot: failed test/task (final outcome)"]) {
      assert.equal(await filterChecked(label), false, `${label} listed and off by default`);
    }
    await click(await pointAt(filterBoxFinder("Robot: failed keyword (includes handled failures)"), "failed keyword filter checkbox"),
      "Breakpoints: Robot: failed keyword");
    await until(() => protocol.some(m => m.command === "setExceptionBreakpoints" && m.arguments?.filters?.includes("robot-failed-keyword")),
      "setExceptionBreakpoints with the failed keyword filter");
    assert.equal(await filterChecked("Robot: failed keyword (includes handled failures)"), true);
    await screenshot("filter-ticked");
    await resume();

    // U4: Set Value of ${message}; an invalid value is refused visibly and changes nothing; Escape cancels.
    await nextStop(2, "stop before Log ${message}");
    await stoppedAt("advanced_debug.robot", 15, "stop at advanced_debug.robot:15");
    await until(async () => /^\$\{message\}, value 'before'$/.test(await rowText("${message}") || ""), "${message} shown");
    const rejected = await setValue("${message}", "after");
    assert.equal(rejected.success, false);
    assert.match(rejected.message, /^Cannot change this value\. Use one JSON value/);
    await screenshot("set-value-rejected");
    await until(async () => /Cannot change this value/.test(await page(`document.querySelector('.debug-variables')?.innerText || ''`) +
      await page(`[...document.querySelectorAll('.notification-toast')].map(e => e.innerText).join(' ')`)), "refusal visible");
    evidence.push({ result: "invalid Set Value shown", variables: await page(`document.querySelector('.debug-variables')?.innerText`) });
    // The editor stays open on the refusal with the old value; Escape leaves it unchanged.
    await key("Escape", "Escape", 27);
    await until(async () => !await page(`Boolean([...document.querySelectorAll('.debug-variables input')].find(e => e.getClientRects().length))`),
      "value editor closed");
    assert.equal(await rowText("${message}"), "${message}, value 'before'");
    await setValue("${message}", '"cancelled"', { cancel: true });
    const accepted = await setValue("${message}", '"after"', { keyboard: true });
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    assert.deepEqual(accepted.body, { value: "'after'", type: "str", variablesReference: 0 });
    await until(async () => /^\$\{message\}, value 'after'$/.test(await rowText("${message}") || ""), "${message} shows 'after'");
    await screenshot("set-value-accepted");
    await resume();

    // U5: the Python breakpoint pauses the Python child; its local is edited in that session only.
    await stoppedAt("DebugValues.py", 13, "Python stop at DebugValues.py:13");
    const pythonSession = vscode.debug.activeStackItem.session;
    assert.equal(pythonSession.parentSession?.id, session.id, "Python child belongs to the Robot session");
    await key("F10", "F10", 121);
    await stoppedAt("DebugValues.py", 14, "Python step to DebugValues.py:14");
    await until(async () => /^counter, value 5$/.test(await rowText("counter") || ""), "Python counter is 5");
    const python = await setValue("counter", "9");
    assert.equal(python.session, pythonSession.name, "Set Value went to the Python child session");
    assert.equal(python.success, true);
    await screenshot("python-set-value");
    await resume();

    // AC1: the handled failure stops as a Robot failure, read-only.
    const failure = await nextStop(3, "handled failure stop");
    assert.deepEqual([failure.reason, failure.description], ["exception", "Robot failure: failed keyword"]);
    assert.match(failure.text, /^Robot keyword 'Fail' failed at advanced_debug\.robot:23: synthetic handled failure$/);
    await stoppedAt("advanced_debug.robot", 23, "failure stop at advanced_debug.robot:23");
    // VS Code shows the stop's description as the session state; its exception widget keeps its own
    // generic heading above the Robot text.
    await until(() => page(`[...document.querySelectorAll('.debug-call-stack .monaco-list-row')].some(row =>
      /^Session .* Robot failure: failed keyword$/.test(row.getAttribute('aria-label') || ''))`), "Call Stack: Robot failure: failed keyword");
    await until(() => page(`(document.querySelector('.exception-widget')?.innerText || '').includes('synthetic handled failure')`),
      "exception widget names the Robot failure");
    const widget = await page(`document.querySelector('.exception-widget').innerText`);
    assert.doesNotMatch(widget, /python/i);
    await screenshot("failure-stop");
    // Keyboard: Space on the focused failed test/task row ticks it.
    await click(await pointAt(filterRow("Robot: failed test/task (final outcome)"), "failed test filter row"), "Breakpoints: failed test/task row");
    await key(" ", "Space", 32);
    await until(() => protocol.some(m => m.command === "setExceptionBreakpoints" && m.arguments?.filters?.includes("robot-failed-test")),
      "setExceptionBreakpoints with both filters");
    assert.equal(await filterChecked("Robot: failed test/task (final outcome)"), true);
    await resume();

    const keywordStop = await nextStop(4, "propagated keyword failure stop");
    assert.equal(keywordStop.text, "Robot keyword 'Fail' failed at advanced_debug.robot:29: synthetic failure");
    await stoppedAt("advanced_debug.robot", 29, "keyword failure stop at advanced_debug.robot:29");
    await quiet(300);
    await resume();
    const testStop = await nextStop(5, "final test outcome stop");
    assert.equal(testStop.description, "Robot failure: failed test (final outcome)");
    await stoppedAt("advanced_debug.robot", 28, "final outcome at the test definition");
    await screenshot("final-outcome-stop");
    const terminated = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session.id) { listener.dispose(); resolve(); } });
    });
    await resume();
    await Promise.race([terminated, sleep(45000).then(() => { throw new Error("Timed out: session end after Continue"); })]);
    const xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="2" fail="1" skip="0">All Tests<\/stat>/, "Robot ran the edits: Edit And Count passed");
    await until(() => debug.sessions.size === 0, "sessions released");
    await until(() => debugProcesses().length === 0, "no debug process remains", 10000);
    evidence.push({ result: "advanced journey at 1280x900", robot: "2 PASS, 1 FAIL (output.xml)", stops: stops().map(s => s.reason) });
  });
  test("1024x768: an invalid hit count is refused visibly and arms nothing; F9, F5 and Shift+F5 by keyboard", async function () {
    this.timeout(600000);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }, cdp.pageSession);
    try {
      await until(async () => {
        const size = await page(`[innerWidth, innerHeight]`);
        return size[0] === 1024 && size[1] === 768;
      }, "1024x768 viewport");
      evidence.push({ viewport: await page(`({width: innerWidth, height: innerHeight})`) });
      await vscode.commands.executeCommand("notifications.clearAll");
      // A Hit Count VS Code accepts but the backend refuses: 0. The plain breakpoint is set by F9.
      await showSettled(suiteUri());
      await addHitCount("Local Check    ${i}", 13, "0");
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(14, 4, 14, 4);
      await click(await gutterPoint("Log    ${message}", 15).then(point => ({ x: point.x + 120, y: point.y })), "editor line 15");
      await onLine(15, () => key("F9", "F9", 120));
      await showRunAndDebug();
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      await key("F5", "F5", 116);
      const session = await started;
      // The refusal reaches the user and nothing in that file is armed: the run does not stop at line 13 or 15.
      await until(() => protocol.some(m => m.response === "setBreakpoints" && m.success === false &&
        /^Invalid hit count \(hitCondition\) at line 13\./.test(m.message || "")), "setBreakpoints refused");
      let shown = "";
      await until(async () => (shown = await page(`[...document.querySelectorAll('.notification-toast, .debug-breakpoints .monaco-list-row')]
        .filter(e => e.getClientRects().length).map(e => (e.innerText || '') + ' ' + (e.getAttribute('aria-label') || e.title || '')).join(' | ')`))
        .includes("Invalid hit count"), "invalid hit count visible", 15000).catch(() => {});
      await screenshot("compact-invalid-hit-count");
      evidence.push({ result: "invalid hit count 0", visible: shown.slice(0, 2000) });
      assert.match(shown, /Invalid hit count \(hitCondition\) at line 13\. Use N, ==N, >=N or %N/, "the refusal is visible");
      const terminated = new Promise(resolve => {
        const listener = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session.id) { listener.dispose(); resolve(); } });
      });
      await key("F5", "F5", 116, 8); // Shift+F5: Stop
      await terminated;
      await until(() => debug.sessions.size === 0 && debugProcesses().length === 0, "first compact session ended", 15000);
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, cdp.pageSession);
    }
  });
  test("1024x768 by keyboard: Space ticks a filter, F2 changes a value, Stop with the value editor open ends everything", async function () {
    this.timeout(600000);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false }, cdp.pageSession);
    try {
      await until(async () => (await page(`innerWidth + 'x' + innerHeight`)) === "1024x768", "1024x768 viewport");
      const palette = async command => {
        await key("P", "KeyP", 80, 10); // Ctrl+Shift+P
        await until(() => page(`Boolean(document.querySelector('.quick-input-widget input')?.getClientRects().length)`), "Command Palette");
        await type(command);
        await sleep(400);
        await key("Enter", "Enter", 13);
      };
      const focusedRow = view => page(`document.querySelector('${view} .monaco-list-row.focused')?.getAttribute('aria-label') || ''`);
      // Arrow keys from the top of a focused view until the row whose accessible name starts with `prefix`.
      const arrowTo = async (view, prefix) => {
        await key("Home", "Home", 36);
        for (let i = 0; i < 60 && !(await focusedRow(view)).startsWith(prefix); i++) await key("ArrowDown", "ArrowDown", 40);
        assert.ok((await focusedRow(view)).startsWith(prefix), `${prefix} focused in ${view}: ${await focusedRow(view)}`);
      };
      await showSettled(suiteUri());
      await click(await gutterPoint("Log    ${message}", 15).then(point => ({ x: point.x + 120, y: point.y })), "editor line 15");
      await onLine(15, () => key("F9", "F9", 120));
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      await showRunAndDebug();
      await key("F5", "F5", 116);
      const session = await started;
      await stoppedAt("advanced_debug.robot", 15, "stop at advanced_debug.robot:15");
      await quiet();
      await palette("Breakpoints: Focus on Breakpoints View");
      await arrowTo(".debug-breakpoints", "Robot: failed test/task");
      await key(" ", "Space", 32);
      await until(() => protocol.some(m => m.command === "setExceptionBreakpoints" && m.arguments?.filters?.includes("robot-failed-test")),
        "failed test/task ticked by Space");
      await palette("Run and Debug: Focus on Variables View");
      await arrowTo(".debug-variables", "${message}, value");
      await key("F2", "F2", 113);
      await until(() => page(`Boolean([...document.querySelectorAll('.debug-variables input')].find(e => e.getClientRects().length))`), "value editor");
      await key("a", "KeyA", 65, 2);
      await type('"after"');
      await key("Enter", "Enter", 13);
      await until(async () => (await rowText("${message}")) === "${message}, value 'after'", "${message} shows 'after'");
      await screenshot("compact-keyboard-set-value");
      // Stop while a second edit is still being typed: the session and every debug process end, nothing is applied.
      await quiet();
      await palette("Run and Debug: Focus on Variables View");
      await arrowTo(".debug-variables", "${message}, value");
      await key("F2", "F2", 113);
      await until(() => page(`Boolean([...document.querySelectorAll('.debug-variables input')].find(e => e.getClientRects().length))`), "second value editor");
      await type('"late"');
      await screenshot("compact-stop-with-editor-open");
      const terminated = new Promise(resolve => {
        const listener = vscode.debug.onDidTerminateDebugSession(ended => { if (ended.id === session.id) { listener.dispose(); resolve(); } });
      });
      await key("F5", "F5", 116, 8); // Shift+F5: Stop
      await Promise.race([terminated, sleep(30000).then(() => { throw new Error("Timed out: Stop with the value editor open"); })]);
      await until(() => debug.sessions.size === 0 && debugProcesses().length === 0, "no debug process after Stop", 15000);
      assert.equal(protocol.filter(m => m.command === "setVariable" && /late/.test(m.arguments?.value || "")).length, 0,
        "the unfinished edit was never sent");
      evidence.push({ result: "1024x768 keyboard: Space, F2, Stop with editor open", processes: debugProcesses() });
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, cdp.pageSession);
    }
  });
});

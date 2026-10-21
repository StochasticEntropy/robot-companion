"use strict";

// Native debug controls (MIS-500): editing Robot breakpoints during a session,
// Pause and Step Out, with the native backend as the execution provider. Driven
// by actual pointer and keyboard input at 1280x900 (gutter clicks, F9, F5, F11,
// Shift+F11, the debug toolbar's Pause/Step Out/Stop buttons, Debug Console
// typing) and asserted on what VS Code shows (gutter, stopped line, Variables,
// notifications) plus the debug protocol and the host's process table. Skipped
// by name (pending) when the prepared native backend is absent; never a pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const PAUSE_BOUND_MS = 5000;
const OUTERMOST = /^Step Out is not available here: the current line is not inside a Robot user keyword/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const KINDS = [["native-language", /robot-companion-backend lsp$/], ["native-debug", /robot-companion-backend dap$/],
  ["native-robot-worker", /-m robot_companion_backend\.worker /], ["debugpy-adapter", /debugpy[/.]adapter/]];
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
const debugProcesses = () => backendProcesses().filter(item => item.kind !== "native-language");

suite("Native debug controls: breakpoint editing, Pause and Step Out (live, actual input)", () => {
  let extension, api, manager, debug, folder, config, cdp, tracker, descriptor, directory;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const launchName = "Robot Companion: Debug current file (native controls)";
  const fixture = name => vscode.Uri.file(path.join(directory, name));
  const lineOf = (name, text) => fs.readFileSync(path.join(directory, name), "utf8").split(/\r?\n/).findIndex(row => row.trim() === text) + 1;

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `controls-${name}.png`), Buffer.from(data, "base64"));
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
          if (!rect.width || !rect.height || rect.bottom > innerHeight || rect.top < 0) return;
          const x = rect.x + Math.min(rect.width / 2, 120), y = rect.y + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
        })()`);
        return point;
      }, `visible ${label}`, timeoutMs);
    } catch (error) {
      await screenshot(`missing-${label.replace(/\W+/g, "-")}`);
      throw error;
    }
    return point;
  }
  async function click(point, label) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    await sleep(150);
    const at = Date.now();
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cdp.pageSession);
    }
    evidence.push({ action: "click", target: label, point, at });
    return at;
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    const at = Date.now();
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers, at });
    return at;
  }
  const F5 = () => key("F5", "F5", 116);
  const F9 = () => key("F9", "F9", 120);
  const F11 = () => key("F11", "F11", 122);
  const shiftF11 = () => key("F11", "F11", 122, 8);

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
  // Lines of the visible editor showing `marker` that have an enabled breakpoint glyph, after layout settles.
  async function gutterLines(marker) {
    let lines, previous;
    await until(async () => {
      lines = await page(`(() => {
        const editor = [...document.querySelectorAll('.monaco-editor')].find(e =>
          e.closest('.editor-instance') && e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(marker)}));
        if (!editor) return;
        const numbers = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')];
        const glyphs = [...editor.querySelectorAll('[class*="codicon-debug-breakpoint"]')]
          .filter(g => !/disabled/.test(g.className) && g.getClientRects().length);
        return glyphs.map(g => {
          const y = g.getBoundingClientRect().y + g.getBoundingClientRect().height / 2;
          const row = numbers.find(n => { const r = n.getBoundingClientRect(); return y >= r.top && y < r.bottom; });
          return row ? Number(row.textContent.trim()) : undefined;
        }).filter(Boolean).sort((a, b) => a - b).join(",");
      })()`);
      const stable = lines !== undefined && lines === previous;
      previous = lines;
      if (!stable) await sleep(200);
      return stable;
    }, `gutter glyphs on ${marker}`);
    return lines ? lines.split(",").map(Number) : [];
  }
  // A real click in the breakpoint gutter of `line`, toggling it to `present`.
  async function clickGutter(marker, line, present = true) {
    const has = () => vscode.debug.breakpoints.some(b => b instanceof vscode.SourceBreakpoint && b.enabled &&
      b.location.uri.fsPath.endsWith(marker.file) && b.location.range.start.line === line - 1);
    for (let attempt = 1; ; attempt++) {
      const before = new Set(vscode.debug.breakpoints);
      let point, previous, steady = 0;
      await until(async () => {
        point = await page(`(() => {
          const editor = [...document.querySelectorAll('.monaco-editor')].find(e =>
            e.closest('.editor-instance') && e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(marker.text)}));
          if (!editor) return;
          const number = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === ${JSON.stringify(String(line))});
          const glyph = editor.querySelector('.margin-view-overlays');
          if (!number || !glyph) return;
          const row = number.getBoundingClientRect(), margin = glyph.getBoundingClientRect();
          return { x: margin.x + 8, y: row.y + row.height / 2 };
        })()`);
        // CodeLens rows can appear late and move the lines: require three equal reads.
        steady = point && previous && point.x === previous.x && point.y === previous.y ? steady + 1 : 0;
        previous = point;
        if (steady < 2) await sleep(200);
        return steady >= 2;
      }, `gutter ${marker.file}:${line}`);
      await click(point, `breakpoint gutter ${marker.file} line ${line} (${present ? "add" : "remove"})`);
      try {
        await until(() => has() === present, `gutter ${present ? "adds" : "removes"} ${marker.file}:${line}`, 3000);
        return;
      } catch (error) {
        // A click that landed on another line (layout moved) is undone before retrying.
        const stray = vscode.debug.breakpoints.filter(b => !before.has(b));
        if (stray.length) {
          evidence.push({ result: "gutter click landed on another line; undone", lines: stray.map(b => b.location?.range.start.line + 1) });
          vscode.debug.removeBreakpoints(stray);
        }
        if (attempt === 3) throw error;
      }
    }
  }
  async function openAt(name, text) {
    const document = await vscode.workspace.openTextDocument(fixture(name));
    await vscode.window.showTextDocument(document, { preview: false });
    return { file: name, text };
  }
  // A click on the editor text of the stopped line gives the editor focus for F9.
  async function focusLine(text, token) {
    await click(await textPoint(text, token), `editor text "${text}"`);
    await until(() => vscode.window.activeTextEditor?.document.lineAt(vscode.window.activeTextEditor.selection.active.line)
      .text.trim() === text, `cursor on "${text}"`, 3000);
  }
  async function toolbar(icon, label) {
    return click(await pointAt(`() => [...document.querySelectorAll('.debug-toolbar .action-label.codicon-${icon}')]
      .find(e => e.getClientRects().length && !e.closest('.disabled') && !e.classList.contains('disabled'))`, label), label);
  }
  const requests = command => protocol.filter(m => m.direction === "request" && m.command === command);
  const responses = command => protocol.filter(m => m.direction === "response" && m.command === command);
  const stops = () => protocol.filter(m => m.event === "stopped");
  // The next stopped event after `since`, then VS Code showing that frame in the editor.
  async function stoppedAt(since, file, line, reason, timeoutMs = 30000) {
    await until(() => stops().some(m => m.at >= since), `stopped event (${reason}) after input`, timeoutMs);
    const stop = stops().find(m => m.at >= since);
    assert.equal(stop.reason, reason, JSON.stringify(stop));
    await until(() => {
      const item = vscode.debug.activeStackItem, editor = vscode.window.activeTextEditor;
      return item instanceof vscode.DebugStackFrame && editor?.document.uri.fsPath.endsWith(file) &&
        editor.selection.active.line === line - 1;
    }, `VS Code shows ${file}:${line}`, 15000);
    return stop;
  }
  // The Variables view's visible rows (VS Code fetched them for the shown frame).
  async function variablesShown(expected) {
    let text;
    await until(async () => {
      text = await page(`[...document.querySelectorAll('.debug-variables .monaco-list-row, .variables-view .monaco-list-row')]
        .filter(e => e.getClientRects().length).map(e => e.innerText.replaceAll('\\n', ' ')).join('\\n')`);
      return expected.every(part => text.includes(part));
    }, `Variables view shows ${expected.join(", ")}`, 15000);
    return text;
  }
  const toasts = () => page(`[...document.querySelectorAll('.notifications-toasts .notification-toast')]
    .filter(e => e.getClientRects().length).map(e => e.innerText).join('\\n')`);
  async function showConsole() {
    const visible = () => page(`Boolean(document.querySelector('.repl .repl-input-wrapper .monaco-editor')?.getClientRects().length)`);
    if (!await visible()) await key("Y", "KeyY", 89, 10); // Linux Ctrl+Shift+Y
    await until(visible, "Debug Console visible");
  }
  async function evaluate(expression) {
    await showConsole();
    const before = responses("evaluate").length;
    await click(await pointAt(`() => document.querySelector('.repl .repl-input-wrapper .monaco-editor')`, "Debug Console input"),
      "Debug Console input");
    await cdp.send("Input.insertText", { text: expression }, cdp.pageSession);
    evidence.push({ action: "type", text: expression });
    await key("Enter", "Enter", 13);
    await until(() => responses("evaluate").length > before, `evaluate ${expression}`);
    return responses("evaluate")[before];
  }
  async function showRunAndDebug() {
    await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D
    await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
      item.textContent.includes(${JSON.stringify(launchName)}) ||
      [...item.querySelectorAll('select option')].some(option => option.selected && option.text.includes(${JSON.stringify(launchName)})))`),
    "launch configuration selected");
  }
  // F5 with the target file active starts the "${file}" configuration.
  async function start(name) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixture(name)), { preview: false });
    await showRunAndDebug();
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    await F5();
    const session = await started;
    const entry = debug.sessions.get(session.id);
    assert.equal(entry.adapter.backendId, descriptor.id, "the session uses the native execution provider");
    return { session, entry };
  }
  function ended(session) {
    return new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(item => { if (item.id === session.id) { listener.dispose(); resolve(); } });
    });
  }
  async function noDebugProcess(label) {
    await until(() => debug.sessions.size === 0, `${label}: sessions released`);
    await until(() => debugProcesses().length === 0, `${label}: no backend debug, Robot or debugpy process remains`, 10000);
    evidence.push({ result: `${label}: processes after the session`, processes: backendProcesses() });
  }
  function outputXml(entry) {
    return fs.readFileSync(path.join(entry.outputDir, "output.xml"), "utf8");
  }
  function settled() {
    return Promise.all([manager.queue, debug.statusQueue]);
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    manager = api.getLanguageWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // The synthetic control fixtures, copied into a folder whose name has a space and non-ASCII characters.
    directory = path.join(folder.uri.fsPath, "native controls Ü");
    fs.rmSync(directory, { recursive: true, force: true });
    fs.cpSync(path.join(extension.extensionPath, "backend/tests/controls_fixtures"), directory, { recursive: true });
    const native = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const base = { workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath };
    descriptor = JSON.parse(JSON.stringify(native.nativeDescriptor({ ...base, executable: nativeExecutable, services: ["language", "debug"] })));
    await config.update("languageBackend", descriptor, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", descriptor, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await settled();
    cdp = await WebviewCdp.connect();
    tracker = vscode.debug.registerDebugAdapterTrackerFactory("robotcompanion", {
      createDebugAdapterTracker: session => ({
        onWillReceiveMessage: message => protocol.push({ at: Date.now(), session: session.name, direction: "request",
          command: message.command, arguments: message.command === "setBreakpoints" ? message.arguments : undefined }),
        onDidSendMessage: message => protocol.push({ at: Date.now(), session: session.name,
          direction: message.type === "response" ? "response" : "event", command: message.command, success: message.success,
          message: message.success === false ? message.message : undefined, event: message.event,
          reason: message.event === "stopped" ? message.body?.reason : undefined,
          hits: message.event === "stopped" ? message.body?.hitBreakpointIds : undefined,
          breakpoints: message.command === "setBreakpoints" ? message.body?.breakpoints
            : message.event === "breakpoint" ? [message.body?.breakpoint] : undefined,
          value: message.command === "evaluate" ? message.body?.result : undefined,
          output: message.event === "output" ? message.body?.output : undefined,
          category: message.event === "output" ? message.body?.category : undefined })
      })
    });
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName, target: "${file}", attachPython: false
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "native control checks run at 1280x900");
    assert.deepEqual(debugProcesses(), [], "no debug process before the suite");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, viewport, directory,
      native: { executable: nativeExecutable, debug: descriptor.services.debug.argv } });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") await screenshot(`failed-${this.currentTest.title.slice(0, 40).replace(/\W+/g, "-")}`);
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand("notifications.clearAll");
  });
  suiteTeardown(async () => {
    if (!extension) return;
    tracker?.dispose();
    for (const key of ["languageBackend", "executionBackend", "integrationMode"]) {
      await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await settled();
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-debug-controls-ui-actions.json"),
      JSON.stringify({ evidence, protocol }, null, 2));
    cdp?.close();
  });

  test("breakpoints added and removed with gutter clicks and F9 while paused and while running", async function () {
    this.timeout(180000);
    const first = lineOf("edit.robot", "Log    edit-first"), second = lineOf("edit.robot", "Log    edit-second");
    const third = lineOf("edit.robot", "Log    edit-third"), fifth = lineOf("edit.robot", "Log    edit-fifth");
    const edit = await openAt("edit.robot", "edit-first");
    await clickGutter(edit, first);
    await clickGutter(edit, second);
    assert.deepEqual(await gutterLines("edit-first"), [first, second]);
    let since = Date.now();
    const { session, entry } = await start("edit.robot");
    const firstStop = await stoppedAt(since, "edit.robot", first, "breakpoint");
    await screenshot("edit-paused-first");
    // While paused: add edit-third and remove edit-second in the gutter.
    const sent = requests("setBreakpoints").length;
    await clickGutter(edit, third);
    await clickGutter(edit, second, false);
    await until(() => responses("setBreakpoints").slice(sent).some(m => m.success &&
      JSON.stringify(m.breakpoints.map(b => [b.line, b.verified])) === JSON.stringify([[first, true], [third, true]])),
    "paused setBreakpoints reply verifies edit-first and edit-third");
    assert.deepEqual(await gutterLines("edit-first"), [first, third]);
    await screenshot("edit-paused-edited");
    since = Date.now();
    await F5();
    const thirdStop = await stoppedAt(since, "edit.robot", third, "breakpoint");
    assert.notDeepEqual(thirdStop.hits, firstStop.hits);
    // F9 on the stopped line removes edit-third; F9 on edit-fifth adds it.
    await focusLine("Log    edit-third", "edit-third");
    await F9();
    await until(async () => (await gutterLines("edit-first")).join() === String(first), "F9 removed edit-third");
    await focusLine("Log    edit-fifth", "edit-fifth");
    await F9();
    await until(async () => (await gutterLines("edit-first")).join() === [first, fifth].join(), "F9 added edit-fifth");
    since = Date.now();
    await F5();
    await stoppedAt(since, "edit.robot", fifth, "breakpoint");
    assert.deepEqual(stops().filter(m => m.session === session.name).length, 3, "no stop at the removed edit-second or edit-third");
    const done = ended(session);
    await F5();
    await done;
    assert.match(outputXml(entry), /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    await noDebugProcess("paused edits");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

    // While running: a gutter click on the loop's Sleep line applies at the next keyword.
    const sleepLine = lineOf("loop.robot", "Sleep    0.05s");
    const loop = await openAt("loop.robot", "controls-loop-ready");
    const running = await start("loop.robot");
    await until(() => protocol.some(m => m.session === running.session.name && /controls-loop-ready/.test(m.output || "")),
      "the loop is running");
    const before = requests("setBreakpoints").length;
    since = Date.now();
    await clickGutter(loop, sleepLine);
    await until(() => responses("setBreakpoints").slice(before).some(m => m.success && m.breakpoints?.[0]?.verified === false &&
      /next keyword/.test(m.breakpoints[0].message)), "running setBreakpoints reply: pending until the next keyword");
    await until(() => protocol.some(m => m.at >= since && m.event === "breakpoint" && m.breakpoints?.[0]?.verified === true),
      "breakpoint changed event: verified at the safe point");
    await stoppedAt(since, "loop.robot", sleepLine, "breakpoint");
    assert.deepEqual(await gutterLines("controls-loop-ready"), [sleepLine]);
    await screenshot("edit-running-hit");
    await focusLine("Sleep    0.05s", "Sleep");
    await F9();
    await until(async () => (await gutterLines("controls-loop-ready")).length === 0, "F9 removed the Sleep breakpoint");
    since = Date.now();
    await F5();
    await sleep(1500);
    assert.deepEqual(stops().filter(m => m.at >= since), [], "no stop after the breakpoint was removed");
    const stopped = ended(running.session);
    await toolbar("debug-stop", "debug toolbar Stop");
    await stopped;
    await noDebugProcess("running edits");
    evidence.push({ result: "breakpoint editing", edit: { first, second, third, fifth }, loop: { sleepLine },
      setBreakpoints: responses("setBreakpoints").map(m => m.breakpoints) });
  });

  test("Pause button and F6 within five seconds, then Shift+F11 and the Step Out button over three cycles with console, edits and the outermost refusal", async function () {
    this.timeout(240000);
    const tick = lineOf("loop.robot", "Tick    ${index}"), assign = lineOf("loop.robot", "Set Test Variable    ${TICK}    ${index}");
    const sleepLine = lineOf("loop.robot", "Sleep    0.05s");
    const loop = await openAt("loop.robot", "controls-loop-ready");
    const { session } = await start("loop.robot");
    await until(() => protocol.some(m => m.session === session.name && /controls-loop-ready/.test(m.output || "")), "the loop is running");
    const timings = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      // The toolbar Pause button, and F6 in the last cycle.
      const clicked = cycle === 2 ? await key("F6", "F6", 117) : await toolbar("debug-pause", "debug toolbar Pause");
      await until(() => stops().some(m => m.at >= clicked), "stopped after Pause", PAUSE_BOUND_MS);
      const stop = stops().find(m => m.at >= clicked);
      assert.equal(stop.reason, "pause");
      const request = requests("pause").find(m => m.at >= clicked);
      assert.ok(request, "the Pause click sent a DAP pause request");
      timings.push({ cycle, clickToStoppedMs: stop.at - clicked, requestToStoppedMs: stop.at - request.at });
      assert.ok(stop.at - clicked < PAUSE_BOUND_MS, `Pause took ${stop.at - clicked} ms`);
      await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
        [tick, assign, sleepLine].includes(vscode.window.activeTextEditor?.selection.active.line + 1) &&
        vscode.window.activeTextEditor.document.uri.fsPath.endsWith("loop.robot"), "Pause shows a loop.robot frame");
      await screenshot(`pause-cycle-${cycle}`);
      if (vscode.window.activeTextEditor.selection.active.line + 1 === tick) {
        const since = Date.now();
        await F11(); // into Tick, so Step Out has a user keyword to leave
        await stoppedAt(since, "loop.robot", assign, "step");
      }
      const typed = await evaluate(`Set Test Variable    \\\${CYCLE}    ui-cycle-${cycle}`);
      assert.equal(typed.success, true);
      let since = Date.now();
      if (cycle === 1) await toolbar("debug-step-out", "debug toolbar Step Out");
      else await shiftF11();
      await stoppedAt(since, "loop.robot", tick, "step");
      await variablesShown(["${CYCLE}", `ui-cycle-${cycle}`]);
      assert.match((await evaluate("Catenate    tick    ${TICK}")).value, /^'tick \d+'$/);
      await screenshot(`step-out-cycle-${cycle}`);
      // At test level, Step Out is refused visibly and the session stays paused.
      await vscode.commands.executeCommand("notifications.clearAll");
      since = Date.now();
      await shiftF11();
      await until(() => responses("stepOut").some(m => m.at >= since && m.success === false && OUTERMOST.test(m.message)),
        "outermost Step Out refused");
      await until(async () => OUTERMOST.test(await toasts()), "refusal shown as a notification");
      await screenshot(`step-out-refused-cycle-${cycle}`);
      assert.ok(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame, "still paused after the refusal");
      // A gutter breakpoint added while paused stops the next Tick; F9 removes it.
      await clickGutter(loop, sleepLine);
      since = Date.now();
      await F5();
      await stoppedAt(since, "loop.robot", sleepLine, "breakpoint");
      await focusLine("Sleep    0.05s", "Sleep");
      await F9();
      await until(async () => (await gutterLines("controls-loop-ready")).length === 0, "F9 removed the Sleep breakpoint");
      await F5();
    }
    const stopped = ended(session);
    await toolbar("debug-stop", "debug toolbar Stop");
    await stopped;
    await noDebugProcess("pause cycles");
    evidence.push({ result: "pause and step out cycles", pauseTimings: timings, pauseBoundMs: PAUSE_BOUND_MS });
  });

  test("Step Out from a nested resource keyword stops at each exact caller with current variables", async function () {
    this.timeout(180000);
    const leaf = lineOf("controls.resource", "Log    inner-leaf ${value}");
    const caller = lineOf("controls.resource", "Log    outer-after-inner ${inner}");
    const after = lineOf("controls.robot", "Log    after-outer ${result}");
    const resource = await openAt("controls.resource", "inner-leaf");
    await clickGutter(resource, leaf);
    let since = Date.now();
    const { session } = await start("controls.robot");
    await stoppedAt(since, "controls.resource", leaf, "breakpoint");
    await clickGutter(resource, leaf, false); // later tests in this file run without stops
    since = Date.now();
    await toolbar("debug-step-out", "debug toolbar Step Out");
    await stoppedAt(since, "controls.resource", caller, "step");
    assert.equal((await evaluate("Catenate    ${inner}    ${INNER_DONE}")).value, "'inner-start done-start'");
    await screenshot("nested-step-out-caller");
    since = Date.now();
    await shiftF11();
    await stoppedAt(since, "controls.robot", after, "step");
    assert.equal((await evaluate("Catenate    ${result}")).value, "'inner-start-outer'");
    await screenshot("nested-step-out-test");
    await vscode.commands.executeCommand("notifications.clearAll");
    since = Date.now();
    await shiftF11();
    await until(async () => OUTERMOST.test(await toasts()), "outermost refusal notification");
    const done = ended(session);
    await F5();
    await done;
    await noDebugProcess("nested step out");
  });

  test("Pause during a blocking library call stays running, says so, and Stop ends the run", async function () {
    this.timeout(120000);
    await openAt("blocking.robot", "controls-blocking-ready");
    const { session } = await start("blocking.robot");
    await until(() => protocol.some(m => m.session === session.name && /controls-blocking-started/.test(m.output || "")),
      "the library call is blocking");
    const clicked = await toolbar("debug-pause", "debug toolbar Pause");
    await until(() => responses("pause").some(m => m.at >= clicked && m.success), "pause accepted");
    await until(() => protocol.some(m => m.at >= clicked && /^Pause requested: Robot stops before its next keyword/.test(m.output || "")),
      "the Debug Console explains the pending pause");
    await sleep(2000);
    assert.deepEqual(stops().filter(m => m.at >= clicked), [], "no paused state while library code blocks");
    assert.ok(!(vscode.debug.activeStackItem instanceof vscode.DebugStackFrame), "VS Code shows no stopped frame");
    await screenshot("pause-blocking-pending");
    const stopped = ended(session);
    await toolbar("debug-stop", "debug toolbar Stop");
    await stopped;
    await noDebugProcess("blocking pause then stop");
  });
});

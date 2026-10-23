"use strict";

// Live Test Explorer runs over RobotCode 2.7.0 discovery and real Robot
// Framework 7.5, driven by actual pointer and keyboard input at 1280x900:
// multi-selection, failure reporting, Rerun Failed Tests, Stop, Debug Test and
// the fallback when discovery is unavailable. Skipped by name (pending) when
// the prepared environment is absent; never reported as a pass.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
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
// Processes of a process group, from the host's process table.
function groupMembers(pgid) {
  try { return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

// This UI run's own processes: every process the extension host starts
// inherits the run's unique profile directory in its environment (set by
// tests/ui/run-ui-tests.js), so processes of another run never match.
const RUN_MARKER = `ROBOT_COMPANION_UI_USER_DATA_DIR=${process.env.ROBOT_COMPANION_UI_USER_DATA_DIR}`;
function ownedByThisRun(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(RUN_MARKER); }
  catch { return false; } // Already gone, or not readable: not this run's.
}

const ps = () => execFileSync("ps", ["-eo", "pid=,pgid=,ppid=,args="], { encoding: "utf8" }).split("\n").map(line => line.trim());

// Robot, RobotCode debug, debugpy and the fixture's sleep child: every process
// a Test Explorer debug run of this UI run can start (the language server is not included).
function debugRunProcesses() {
  try {
    return ps().filter(line => {
      const [pid, , , ...rest] = line.split(/\s+/);
      const args = rest.join(" ");
      return (/^sleep 300$/.test(args) || /^\S*debugpy\S*( |$)/.test(args) ||
        (/^\S*python\S* /.test(args) && /robotcode\.cli (debug-launch|.*\bdebug\b)|robotcode\.debugger|debugpy/.test(args))) &&
        ownedByThisRun(pid);
    }).map(line => line.replace(/\s+/g, " ").slice(0, 160));
  } catch { return []; }
}

suite("Test Explorer runs with RobotCode discovery and Robot 7.5 (live)", () => {
  let extension, tests, debug, folder, config, cdp, fixtureRoot, checkoutUri, billingUri;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const id = (uri, name) => `${uri}::${name}`;

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, name + ".png"), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-")}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, name + ".json"), JSON.stringify(await page(`
      [...document.querySelectorAll('.monaco-list-row, .action-label, .monaco-menu .action-item')].filter(e => e.getClientRects().length)
        .slice(0, 200).map(e => ({ tag: e.tagName, aria: e.getAttribute('aria-label'), title: e.title,
          text: (e.textContent || '').slice(0, 80), level: e.getAttribute('aria-level'),
          ancestors: (() => { const chain = []; for (let a = e.parentElement; a && chain.length < 12; a = a.parentElement)
            chain.push((a.id ? '#' + a.id + ' ' : '') + String(a.className).split(' ').slice(0, 3).join('.')); return chain.join(' < '); })() }))`), null, 2));
  }
  // A visible element found by `finder` whose centre (or left part, for wide
  // rows) is not covered by anything else.
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
      await dump(label);
      throw error;
    }
    return point;
  }
  async function click(point, label, { modifiers = 0, button = "left", clickCount = 1 } = {}) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers }, cdp.pageSession);
    await sleep(150);
    for (let count = 1; count <= clickCount; count++) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, ...point, modifiers, button,
          buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0, clickCount: count }, cdp.pageSession);
      }
    }
    evidence.push({ action: `${modifiers === 2 ? "Ctrl+" : ""}${button === "right" ? "right-" : ""}${clickCount > 1 ? "double-" : ""}click`,
      target: label, point });
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }

  // Test Explorer rows are matched by their accessible name, which starts with
  // the item label and then carries the visible state ("Checkout Passes (Passed)").
  const rowFinder = name => `() => [...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].find(row =>
    row.getClientRects().length && /^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(|,|$)/.test(row.getAttribute('aria-label') || ''))`;
  const rowLabel = name => page(`(() => { const row = (${rowFinder(name)})(); return row && row.getAttribute('aria-label'); })()`);
  async function rowState(name, state, timeoutMs = 60000) {
    try {
      await until(async () => new RegExp(`^${name} \\(${state}\\)`).test(await rowLabel(name) || ""), `${name} row shows ${state}`, timeoutMs);
    } catch (error) {
      await dump(`${name} ${state}`);
      throw error;
    }
    const label = await rowLabel(name);
    evidence.push({ visibleState: label });
    return label;
  }
  async function showRow(name, suiteLabel) {
    if (await page(`Boolean((${rowFinder(name)})())`)) return;
    await click(await pointAt(rowFinder(suiteLabel), `${suiteLabel} suite row`), `${suiteLabel} suite row`);
    await pointAt(rowFinder(name), `${name} row`);
  }
  // Hover the row, then click its inline action ("Run Test", "Debug Test").
  async function rowAction(name, action) {
    const row = await pointAt(rowFinder(name), `${name} row`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
    await sleep(150);
    const point = await pointAt(`() => { const row = (${rowFinder(name)})();
      return row && [...row.querySelectorAll('.action-label')].find(action =>
        (action.getAttribute('aria-label') || action.title || '').startsWith(${JSON.stringify(action)})); }`, `${name} ${action} action`);
    await click(point, `${name} row: ${action}`);
  }
  // The Testing view, opened with a pointer click on its activity bar icon.
  async function showTesting() {
    if (await page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`)) return;
    await click(await pointAt(`() => [...document.querySelectorAll('.activitybar .action-label')]
      .find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))`, "Testing activity bar icon"), "Testing activity bar icon");
    await until(() => page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`),
      "Testing view shown");
  }
  async function configure(backend) {
    await config.update("executionBackend", backend, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", backend ? "owned" : "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await tests.queue;
  }
  const lineOf = async (uri, text) => (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText()
    .split(/\r?\n/).findIndex(line => line === text);
  const runResults = () => new Map((tests.lastRun || []).map(entry => [entry.id, entry]));
  // The selected tests a Robot run was given: [source, name line] pairs from its selection file.
  const selectionOf = runDir => JSON.parse(fs.readFileSync(path.join(runDir, "selection.json"), "utf8")).tests;
  const testLine = async (uri, name) => [vscode.Uri.parse(uri).fsPath, await lineOf(uri, name) + 1, name];
  const readyFlag = () => path.join(fixtureRoot, "checkout.ready");

  suiteSetup(async function () {
    if (!fs.existsSync(python)) this.skip();
    this.timeout(180000);
    assert.ok(process.env.ROBOT_COMPANION_UI_USER_DATA_DIR, "run through tests/ui/run-ui-tests.js: its profile directory marks this run's processes");
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    const api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    tests = api.getTestWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    fixtureRoot = path.join(folder.uri.fsPath, "integration-test-explorer");
    checkoutUri = vscode.Uri.file(path.join(fixtureRoot, "checkout.robot")).toString();
    billingUri = vscode.Uri.file(path.join(fixtureRoot, "billing.robot")).toString();
    for (const absent of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy"]) {
      assert.equal(vscode.extensions.getExtension(absent), undefined, `${absent} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.rmSync(readyFlag(), { force: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    cdp = await WebviewCdp.connect();
    console.log("VIEWPORT", JSON.stringify(await page(`({ width: innerWidth, height: innerHeight, outerWidth, outerHeight, scale: devicePixelRatio, screen: [screen.width, screen.height] })`)));
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand",
      path.join(path.dirname(python), "robot"), vscode.ConfigurationTarget.Workspace);
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const descriptor = robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python,
      services: ["debug", "discovery"] });
    await configure(JSON.parse(JSON.stringify(descriptor)));
    await until(() => tests.controller?.items.get(checkoutUri)?.children.size === 3 &&
      tests.controller.items.get(billingUri)?.children.size === 2, "RobotCode discovered the fixture suites", 90000);
    assert.ok(tests.debugProfile, "Debug profile offered for a backend with a debug service");
    await showTesting();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: "RobotCode 2.7.0 discovery + debug-launch",
      robot: path.join(path.dirname(python), "robot"), externalExtensions: "RobotCode, Python and debugpy extensions absent",
      viewport: await page(`({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })`),
      suites: tests.controller.items.size });
  });
  suiteTeardown(async () => {
    if (!extension) return;
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // A failed case must not leak into the next suite: no run of this suite
    // keeps a process, and no test result (or its failed badge) stays visible.
    await until(() => debugRunProcesses().length === 0, "this suite's debug processes gone", 10000).catch(() => {
      const leftover = debugRunProcesses();
      evidence.push({ cleanup: "debug-run processes still present at suite end; killed", leftover });
      for (const line of leftover) { try { process.kill(Number(line.split(" ")[0]), "SIGKILL"); } catch { /* Already gone. */ } }
    });
    await vscode.commands.executeCommand("testing.clearTestResults");
    await vscode.commands.executeCommand("notifications.clearAll");
    fs.rmSync(readyFlag(), { force: true });
    await configure(undefined);
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "test-explorer-runs-ui-actions.json"),
      JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("multi-selection across suites runs exactly those tests; a failure shows Robot's message and links to its source", async function () {
    this.timeout(240000);
    await showRow("Checkout Passes", "checkout.robot");
    await showRow("Billing Passes", "billing.robot");
    await click(await pointAt(rowFinder("Checkout Passes"), "Checkout Passes row"), "Checkout Passes row");
    await click(await pointAt(rowFinder("Checkout Needs Ready Flag"), "Checkout Needs Ready Flag row"),
      "Checkout Needs Ready Flag row", { modifiers: 2 });
    await click(await pointAt(rowFinder("Billing Passes"), "Billing Passes row"), "Billing Passes row", { modifiers: 2 });
    const selected = await page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row.selected')]
      .map(row => row.getAttribute('aria-label'))`);
    assert.equal(selected.length, 3, `three selected rows: ${selected}`);
    await screenshot("test-explorer-multi-selection");
    tests.lastRun = undefined;
    await rowAction("Billing Passes", "Run Test");
    await until(() => tests.lastRun?.length === 3, "three selected tests reported", 90000);
    const results = runResults();
    const checkoutPass = results.get(id(checkoutUri, "Checkout Passes"));
    const checkoutFail = results.get(id(checkoutUri, "Checkout Needs Ready Flag"));
    const billingPass = results.get(id(billingUri, "Billing Passes"));
    assert.deepEqual([checkoutPass.robotStatus, checkoutFail.robotStatus, billingPass.robotStatus], ["PASS", "FAIL", "PASS"]);
    for (const entry of [checkoutPass, checkoutFail, billingPass]) assert.equal(entry.source, "output.xml");
    assert.equal(new Set([checkoutPass, checkoutFail, billingPass].map(entry => entry.outputDir)).size, 1,
      "one Robot run for the workspace folder, across both suites");
    assert.equal(results.has(id(checkoutUri, "Checkout Not Selected")), false);
    assert.deepEqual(checkoutPass.args.slice(-3), ["--argumentfile", path.join(checkoutPass.runDir, "arguments.txt"),
      folder.uri.fsPath], "Robot runs the workspace folder with the run's argument file");
    assert.deepEqual(selectionOf(checkoutPass.runDir).sort(), (await Promise.all([testLine(checkoutUri, "Checkout Passes"),
      testLine(checkoutUri, "Checkout Needs Ready Flag"), testLine(billingUri, "Billing Passes")])).sort(),
    "exactly the three selected tests, by source and name line");
    const checkoutXml = fs.readFileSync(path.join(checkoutPass.outputDir, "output.xml"), "utf8");
    assert.match(checkoutXml, /generator="Robot 7\.5/);
    assert.match(checkoutXml, /<stat pass="2" fail="1" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(checkoutXml, /Checkout Not Selected|Billing Waits For Stop/);
    assert.match(checkoutFail.message, /^File '.*checkout\.ready' does not exist\.$/);
    await rowState("Checkout Passes", "Passed");
    await rowState("Checkout Needs Ready Flag", "Failed");
    await rowState("Billing Passes", "Passed");
    assert.doesNotMatch(await rowLabel("Checkout Not Selected"), /Passed|Failed/, "unselected test has no result");
    await screenshot("test-explorer-multi-selection-results");
    evidence.push({ result: "multi-selection run", run: checkoutPass.outputDir, selection: selectionOf(checkoutPass.runDir),
      statuses: [...results.values()].map(entry => `${entry.id.split("/").pop()}: ${entry.robotStatus}`), failure: checkoutFail.message });

    // Opening the failed test reaches its source line; the failure message is shown there.
    const failLine = await lineOf(checkoutUri, "Checkout Needs Ready Flag");
    await vscode.window.showTextDocument(vscode.Uri.parse(billingUri));
    const opened = () => vscode.window.activeTextEditor?.document.uri.toString() === checkoutUri &&
      vscode.window.activeTextEditor.selection.active.line === failLine;
    await click(await pointAt(rowFinder("Checkout Needs Ready Flag"), "failed row"), "Checkout Needs Ready Flag row");
    try { await until(opened, "single click opens the failed test's source", 3000); }
    catch {
      await click(await pointAt(rowFinder("Checkout Needs Ready Flag"), "failed row"), "Checkout Needs Ready Flag row", { clickCount: 2 });
      await until(opened, "double click opens the failed test's source");
    }
    const item = tests.controller.items.get(checkoutUri).children.get(id(checkoutUri, "Checkout Needs Ready Flag"));
    assert.equal(item.range.start.line, failLine);
    await until(() => page(`[...document.querySelectorAll('.monaco-editor')].some(e => /does not exist/.test(e.closest('.editor-instance') ?
      e.closest('.editor-instance').innerText : ''))`), "failure message shown in the editor at the test", 20000).catch(async error => {
      await dump("failure message in editor");
      throw error;
    });
    await screenshot("test-explorer-failure-at-source");
    evidence.push({ result: "failed test source", uri: checkoutUri, line: failLine + 1, message: "shown in editor" });
  });

  test("Rerun Failed Tests runs only the failed test and updates its state", async function () {
    this.timeout(180000);
    fs.writeFileSync(readyFlag(), "ready\n");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    tests.lastRun = undefined;
    // Test Results: hover the last run and click its "Rerun Failed Tests" action.
    await vscode.commands.executeCommand("workbench.panel.testResults.view.focus");
    const runRow = `() => [...document.querySelectorAll('.monaco-list-row')].find(row => row.getClientRects().length &&
      row.closest('.test-output-peek-tree, .testing-output-peek, [id*="testResults"]') && row.getAttribute('aria-level') === '1')`;
    const row = await pointAt(runRow, "Test Results run row");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
    await sleep(200);
    await click(await pointAt(`() => { const row = (${runRow})();
      return row && [...row.querySelectorAll('.action-label')].find(a => /Rerun Failed Tests/.test(a.getAttribute('aria-label') || a.title || '')); }`,
    "Rerun Failed Tests action"), "Test Results run: Rerun Failed Tests");
    await until(() => tests.lastRun?.length === 1, "rerun reported", 90000);
    const [rerun] = tests.lastRun;
    assert.equal(rerun.id, id(checkoutUri, "Checkout Needs Ready Flag"));
    assert.equal(rerun.robotStatus, "PASS");
    const xml = fs.readFileSync(path.join(rerun.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(xml, /Checkout Passes|Billing/);
    await showTesting();
    await rowState("Checkout Needs Ready Flag", "Passed");
    await screenshot("test-explorer-rerun-failed");
    evidence.push({ result: "rerun failed", id: rerun.id, robotStatus: rerun.robotStatus, outputDir: rerun.outputDir });
  });

  test("Run on a suite node runs every test of that suite in one Robot run", async function () {
    this.timeout(180000);
    await showTesting();
    await showRow("Checkout Passes", "checkout.robot");
    tests.lastRun = undefined;
    await rowAction("checkout.robot", "Run Test");
    await until(() => tests.lastRun?.length === 3, "three suite tests reported", 90000);
    assert.deepEqual(tests.lastRun.map(entry => [entry.id.split("::")[1], entry.robotStatus]).sort(),
      [["Checkout Needs Ready Flag", "PASS"], ["Checkout Not Selected", "PASS"], ["Checkout Passes", "PASS"]]);
    assert.equal(new Set(tests.lastRun.map(entry => entry.outputDir)).size, 1, "one Robot run");
    const xml = fs.readFileSync(path.join(tests.lastRun[0].outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="3" fail="0" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(xml, /Billing/);
    assert.deepEqual(selectionOf(tests.lastRun[0].runDir).sort(), (await Promise.all(["Checkout Passes", "Checkout Not Selected",
      "Checkout Needs Ready Flag"].map(name => testLine(checkoutUri, name)))).sort(), "the suite node selects every test of the suite");
    await showTesting();
    await rowState("Checkout Not Selected", "Passed");
    await rowState("checkout.robot", "Passed");
    await screenshot("test-explorer-suite-run");
    evidence.push({ result: "suite node run", outputDir: tests.lastRun[0].outputDir, tests: tests.lastRun.length });
  });

  test("Stop ends the Robot process group within the bound, marks the test Skipped, and a later run works", async function () {
    this.timeout(180000);
    await showTesting();
    await showRow("Billing Waits For Stop", "billing.robot");
    await click(await pointAt(rowFinder("Billing Waits For Stop"), "Billing Waits For Stop row"), "Billing Waits For Stop row");
    tests.lastRun = undefined;
    await rowAction("Billing Waits For Stop", "Run Test");
    let robot;
    await until(() => { robot = [...tests.active][0]; return robot?.pid && groupMembers(robot.pid).length >= 2; },
      "Robot and its child process running", 60000);
    const members = groupMembers(robot.pid);
    await screenshot("test-explorer-running");
    const stopped = Date.now();
    await click(await pointAt(`() => [...document.querySelectorAll('.action-label')]
      .find(a => a.getClientRects().length && /^Cancel Test Run/.test(a.getAttribute('aria-label') || a.title || ''))`,
    "Stop button"), "Test Explorer Stop (Cancel Test Run)");
    await until(() => tests.lastRun?.length === 1, "stopped run reported", 10000);
    await until(() => groupMembers(robot.pid).length === 0, "process group gone", 5000);
    const elapsed = Date.now() - stopped;
    assert.ok(elapsed < 5000, `stopped within 5 s (${elapsed} ms)`);
    assert.equal(tests.lastRun[0].status, "cancelled");
    await rowState("Billing Waits For Stop", "Skipped");
    await screenshot("test-explorer-stopped");
    evidence.push({ result: "Stop", processGroup: robot.pid, membersBefore: members, membersAfter: groupMembers(robot.pid),
      elapsedMs: elapsed, state: "Skipped" });

    await click(await pointAt(rowFinder("Billing Passes"), "Billing Passes row"), "Billing Passes row");
    tests.lastRun = undefined;
    await rowAction("Billing Passes", "Run Test");
    await until(() => tests.lastRun?.length === 1, "next run reported", 60000);
    assert.equal(tests.lastRun[0].robotStatus, "PASS");
    await rowState("Billing Passes", "Passed");
    evidence.push({ result: "run after Stop", id: tests.lastRun[0].id, robotStatus: "PASS" });
  });

  test("Debug Test starts the owned debug type for exactly that test, stops at its breakpoint and reports the result", async function () {
    this.timeout(240000);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(checkoutUri));
    await vscode.window.showTextDocument(document, { preview: false });
    const line = document.getText().split(/\r?\n/).indexOf("    Log    checkout-ok");
    assert.ok(line > 0);
    // Breakpoint by a gutter click on the test's first step. Late CodeLens
    // rendering shifts lines: click only a layout-stable point, then check it.
    for (let attempt = 1; !vscode.debug.breakpoints.some(b => b.location.range.start.line === line); attempt++) {
      let gutter, previous;
      await until(async () => {
        gutter = await page(`(() => {
          const editor = [...document.querySelectorAll('.monaco-editor')].find(e => e.closest('.editor-instance') &&
            e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes('Log    checkout-ok'));
          const number = editor && [...editor.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === '${line + 1}');
          if (!number) return;
          const row = number.getBoundingClientRect(), margin = editor.querySelector('.margin-view-overlays').getBoundingClientRect();
          return { x: margin.x + 8, y: row.y + row.height / 2 };
        })()`);
        const stable = gutter && previous && gutter.x === previous.x && gutter.y === previous.y;
        previous = gutter;
        if (!stable) await sleep(200);
        return stable;
      }, "layout-stable gutter point");
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await click(gutter, `breakpoint gutter checkout.robot line ${line + 1}`);
      await until(() => vscode.debug.breakpoints.length, "breakpoint from gutter click", 3000).catch(async error => {
        if (attempt === 3) { await dump("breakpoint gutter"); throw error; }
      });
      if (attempt === 3 && !vscode.debug.breakpoints.some(b => b.location.range.start.line === line)) {
        await dump("breakpoint line");
        throw new Error(`Gutter click kept missing line ${line + 1}.`);
      }
    }

    await showTesting();
    await showRow("Checkout Passes", "checkout.robot");
    await click(await pointAt(rowFinder("Checkout Passes"), "Checkout Passes row"), "Checkout Passes row");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    tests.lastRun = undefined;
    await rowAction("Checkout Passes", "Debug Test");
    const session = await started;
    assert.equal(session.type, "robotcompanion");
    assert.equal(session.configuration.args[0], "--argumentfile");
    assert.equal(session.configuration.args.length, 2);
    assert.equal(session.configuration.target, folder.uri.fsPath, "Debug Test runs the workspace folder, with its init files");
    assert.deepEqual(selectionOf(path.dirname(session.configuration.args[1])), [await testLine(checkoutUri, "Checkout Passes")]);
    const processGroup = debug.sessions.get(session.id).pid;
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === checkoutUri && editor.selection.active.line === line &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, "paused at the breakpoint in Checkout Passes", 60000);
    await screenshot("test-explorer-debug-paused");
    evidence.push({ result: "Debug Test paused", session: session.name, type: session.type, args: session.configuration.args,
      line: line + 1 });
    await key("F5", "F5", 116); // Continue
    await until(() => tests.lastRun?.length === 1, "debug run reported", 60000);
    await showTesting();
    const [result] = tests.lastRun;
    assert.equal(result.id, id(checkoutUri, "Checkout Passes"));
    assert.equal(result.robotStatus, "PASS");
    assert.equal(result.source, "output.xml");
    const xml = fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.match(xml, /<test [^>]*name="Checkout Passes"/);
    await rowState("Checkout Passes", "Passed");
    await until(() => groupMembers(processGroup).length === 0, "debug process group gone", 5000);
    await screenshot("test-explorer-debug-finished");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    evidence.push({ result: "Debug Test finished", robotStatus: result.robotStatus, outputDir: result.outputDir,
      processGroup: "gone" });
  });
  test("Stop during Debug Test (Testing Stop and debug toolbar Stop) ends every debug process and skips the test", async function () {
    this.timeout(300000);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // A `sleep 300` of another UI run (or of anything else on the host) is never this run's process.
    const env = { ...process.env };
    delete env.ROBOT_COMPANION_UI_USER_DATA_DIR;
    // The initialize-only debug status probe (`robotcode.cli debug-launch`) that the suite's
    // configuration change started may still be answering; it is not part of this filter check.
    await debug.statusQueue;
    const foreign = spawn("sleep", ["300"], { env, stdio: "ignore" });
    try {
      await until(() => ps().some(line => line.startsWith(`${foreign.pid} `)), "foreign sleep 300 started", 5000);
      assert.deepEqual(debugRunProcesses(), [], "a foreign sleep 300 is not a debug-run process of this run");
    } finally { foreign.kill("SIGKILL"); }
    const waitLine = fs.readFileSync(path.join(fixtureRoot, "billing.robot"), "utf8").split(/\r?\n/)
      .findIndex(line => line.trim().startsWith("Wait In Child Process"));
    for (const stopButton of ["Testing Cancel Test Run", "debug toolbar Stop"]) {
      // The extension's own debug capability probe may still be ending.
      await until(() => debugRunProcesses().length === 0, "no debug-run process before the Debug Test", 10000);
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      // The toolbar Stop is issued at a deterministic point: paused at a
      // breakpoint on the waiting keyword, with the debug toolbar settled.
      if (stopButton === "debug toolbar Stop") vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.parse(billingUri), new vscode.Position(waitLine, 4)))]);
      await showTesting();
      await showRow("Billing Waits For Stop", "billing.robot");
      tests.lastRun = undefined;
      await rowAction("Billing Waits For Stop", "Debug Test");
      let stopPoint;
      if (stopButton === "Testing Cancel Test Run") {
        await until(() => debugRunProcesses().some(line => line.includes("sleep 300")), "debugged test waiting in sleep 300", 60000);
        await sleep(500);
      } else {
        await until(() => vscode.window.activeTextEditor?.document.uri.toString() === billingUri &&
          vscode.window.activeTextEditor.selection.active.line === waitLine &&
          vscode.debug.activeStackItem instanceof vscode.DebugStackFrame, "paused at the Wait In Child Process breakpoint", 60000);
        let previous;
        await until(async () => {
          const point = await pointAt(`() => [...document.querySelectorAll('.debug-toolbar .action-label')]
            .find(a => a.getClientRects().length && /^(Stop|Disconnect)/.test(a.getAttribute('aria-label') || a.title || ''))`,
          "debug toolbar Stop");
          const stable = previous && point.x === previous.x && point.y === previous.y &&
            await page(`Boolean([...document.querySelectorAll('.debug-toolbar .action-label')].find(a =>
              a.getClientRects().length && /^Continue/.test(a.getAttribute('aria-label') || a.title || '')))`);
          previous = point;
          if (!stable) await sleep(200);
          stopPoint = point;
          return stable;
        }, "settled debug toolbar while paused", 10000);
      }
      const before = debugRunProcesses();
      // Positive control: this run's RobotCode launcher and debugger carry the run's marker.
      assert.ok(before.some(line => / -m robotcode\.cli debug-launch /.test(line)) &&
        before.some(line => / -m robotcode\.cli debug --tcp /.test(line)), `this run's debug processes: ${JSON.stringify(before)}`);
      await screenshot(`test-explorer-debug-running-${stopButton.split(" ")[0].toLowerCase()}`);
      const stopped = Date.now();
      if (stopButton === "Testing Cancel Test Run") {
        await showTesting();
        await click(await pointAt(`() => [...document.querySelectorAll('.action-label')]
          .find(a => a.getClientRects().length && /^Cancel Test Run/.test(a.getAttribute('aria-label') || a.title || ''))`,
        "Cancel Test Run button"), "Test Explorer Stop (Cancel Test Run) during Debug Test");
      } else {
        await click(stopPoint, "debug toolbar Stop while the Debug Test is paused");
      }
      try {
        await until(() => tests.lastRun?.length === 1 && debugRunProcesses().length === 0 && debug.sessions.size === 0 &&
          !vscode.debug.activeDebugSession, "debug run stopped and its processes gone", 15000);
      } catch (error) {
        evidence.push({ failure: stopButton, before, after: debugRunProcesses(), lastRun: tests.lastRun, sessions: debug.sessions.size });
        await dump(`debug stop ${stopButton}`);
        throw error;
      }
      const elapsed = Date.now() - stopped;
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      assert.ok(elapsed < 10000, `${stopButton}: stopped within 10 s (${elapsed} ms)`);
      assert.equal(tests.lastRun[0].status, "cancelled", JSON.stringify(tests.lastRun[0]));
      await showTesting();
      await rowState("Billing Waits For Stop", "Skipped");
      await screenshot(`test-explorer-debug-stopped-${stopButton.split(" ")[0].toLowerCase()}`);
      evidence.push({ result: `Stop during Debug Test: ${stopButton}`, before, after: debugRunProcesses(), elapsedMs: elapsed,
        state: "Skipped" });
    }

    // A later Run and a later Debug Test both work.
    tests.lastRun = undefined;
    await rowAction("Billing Passes", "Run Test");
    await until(() => tests.lastRun?.length === 1, "run after the debug stops", 60000);
    assert.equal(tests.lastRun[0].robotStatus, "PASS");
    await rowState("Billing Passes", "Passed");
    tests.lastRun = undefined;
    await rowAction("Billing Passes", "Debug Test");
    await until(() => tests.lastRun?.length === 1, "Debug Test after the stops", 60000);
    assert.equal(tests.lastRun[0].robotStatus, "PASS");
    await until(() => debugRunProcesses().length === 0 && debug.sessions.size === 0, "debug processes gone after the later Debug Test", 10000);
    await showTesting();
    await rowState("Billing Passes", "Passed");
    evidence.push({ result: "Run and Debug Test after the stops", robotStatus: "PASS", processesAfter: debugRunProcesses() });
  });

  test("without discovery, F12 navigation, a CodeLens Run Test click and the Run and Debug launch keep working", async function () {
    this.timeout(300000);
    const api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    const language = api.getLanguageWorkspaceForTest();
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const auditDir = path.join(folder.uri.fsPath, "integration-audit-v1");
    // Start from the copied audit corpus: earlier suites may have saved edits.
    for (const name of ["audit.robot", "AuditLibrary.py", "shared.resource"]) {
      fs.copyFileSync(path.join(extension.extensionPath, "tests/integration/fixtures/audit-v1", name), path.join(auditDir, name));
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Discovery fails (its executable is missing); language and debug are configured as usual.
    const execution = JSON.parse(JSON.stringify(robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
      python, services: ["debug", "discovery"] })));
    execution.services.discovery.executable = path.join(folder.uri.fsPath, "missing-discovery-python");
    await config.update("languageBackend", JSON.parse(JSON.stringify(robotCodeDescriptor({ workspaceUri: folder.uri.toString(),
      cwd: folder.uri.fsPath, python }))), vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: "Robot Companion: Debug audit", target: "${workspaceFolder}/integration-audit-v1/audit.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      await configure(execution);
      await language.queue;
      const errorId = `discovery-error:${folder.uri}`;
      await until(() => tests.controller?.items.get(errorId), "discovery error item");
      assert.equal(tests.controller.items.get(checkoutUri), undefined, "no stale tree after discovery fails");
      await showTesting();
      const errorRow = await pointAt(`() => [...document.querySelectorAll('.test-explorer-tree .monaco-list-row')]
        .find(row => row.getClientRects().length && /discovery unavailable/.test(row.innerText))`, "discovery unavailable row");
      await screenshot("discovery-unavailable");
      evidence.push({ result: "discovery unavailable", visible: await page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row')]
        .map(row => row.innerText.trim()).filter(Boolean).join(' / ')`), error: tests.controller.items.get(errorId).error, point: errorRow });

      // Navigation: pointer on the keyword, then F12.
      const audit = await vscode.workspace.openTextDocument(path.join(auditDir, "audit.robot"));
      await vscode.window.showTextDocument(audit, { preview: false });
      await until(() => language.roots.get(folder.uri.toString())?.session?.state === "running", "RobotCode language service", 60000);
      let point, previous;
      for (let attempt = 1; ; attempt++) {
      previous = undefined;
      await until(async () => {
        point = await page(`(() => {
          const line = [...document.querySelectorAll('.monaco-editor .view-line')].find(el => el.innerText.replaceAll('\\u00a0', ' ').includes('Build Record'));
          if (!line) return;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) {
            const start = node.textContent.replaceAll('\\u00a0', ' ').indexOf('Build Record');
            if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start + 1); range.setEnd(node, start + 3);
            const rect = range.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        })()`);
        const stable = point && previous && point.x === previous.x && point.y === previous.y;
        previous = point;
        if (!stable) await sleep(200);
        return stable;
      }, "layout-stable Build Record");
      await click(point, "Build Record keyword");
      const onKeyword = () => vscode.window.activeTextEditor?.document.lineAt(vscode.window.activeTextEditor.selection.active.line)
        .text.includes("Build Record");
      try { await until(onKeyword, "cursor on Build Record", 2000); break; }
      catch (error) { if (attempt === 3) { await dump("Build Record click"); throw error; } }
      }
      await key("F12", "F12", 123);
      await until(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith("AuditLibrary.py") &&
        vscode.window.activeTextEditor.selection.active.line === 11, "F12 reached AuditLibrary.py line 12", 30000)
        .catch(async error => { await dump("F12 target"); throw error; });
      evidence.push({ result: "F12 without discovery", target: "AuditLibrary.py:12" });

      // CodeLens run: pointer on the Run Test lens above Debug Smoke.
      await vscode.window.showTextDocument(audit, { preview: false });
      api.clearLastRunNotificationForTest();
      let lens;
      previous = undefined;
      await until(async () => {
        lens = await page(`(() => {
          const line = [...document.querySelectorAll('.monaco-editor .view-line')].find(el => el.innerText.replaceAll('\\u00a0', ' ').trim() === 'Debug Smoke');
          if (!line) return;
          const top = line.getBoundingClientRect().top;
          const links = [...document.querySelectorAll('.monaco-editor .codelens-decoration a')].filter(a => a.textContent.trim() === 'Run Test')
            .map(a => ({ a, rect: a.getBoundingClientRect() })).filter(({ rect }) => rect.bottom <= top + 1 && top - rect.bottom < 30);
          const link = links[0];
          if (!link) return;
          const x = link.rect.x + link.rect.width / 2, y = link.rect.y + link.rect.height / 2;
          return link.a.contains(document.elementFromPoint(x, y)) || document.elementFromPoint(x, y) === link.a ? { x, y } : undefined;
        })()`);
        const stable = lens && previous && lens.x === previous.x && lens.y === previous.y;
        previous = lens;
        if (!stable) await sleep(200);
        return stable;
      }, "Run Test CodeLens above Debug Smoke", 30000);
      await click(lens, "Run Test CodeLens (Debug Smoke)");
      await until(() => /Debug Smoke.*passed/.test(api.getLastRunNotificationForTest()?.message || ""), "CodeLens run passed", 60000);
      assert.match(api.getLastRunOutputForTest(), /1 test, 1 passed, 0 failed/);
      evidence.push({ result: "CodeLens run without discovery", notification: api.getLastRunNotificationForTest().message });

      // Run and Debug launch: the start button with the robotcompanion configuration.
      await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D: Run and Debug
      await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
        [...item.querySelectorAll('select option')].some(option => option.selected && option.text.includes('Robot Companion: Debug audit')) ||
        item.textContent.includes('Robot Companion: Debug audit'))`), "launch configuration selected");
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      await click(await pointAt(`() => document.querySelector('.start-debug-action-item .codicon-debug-start')`, "Run and Debug start"),
        "Run and Debug start button");
      const session = await started;
      const entry = debug.sessions.get(session.id);
      const finished = await new Promise(resolve => {
        const listener = debug.onDidFinishRun(result => { if (result.session.id === session.id) { listener.dispose(); resolve(result); } });
      });
      const xml = fs.readFileSync(path.join(finished.outputDir, "output.xml"), "utf8");
      assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
      await until(() => groupMembers(entry.pid).length === 0, "launch process group gone", 5000);
      await screenshot("discovery-unavailable-launch-finished");
      evidence.push({ result: "Run and Debug launch without discovery", outputDir: finished.outputDir, stat: "1 PASS", processGroup: "gone" });
    } finally {
      await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });
});

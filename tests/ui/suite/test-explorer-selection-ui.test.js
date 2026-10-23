"use strict";

// Directory suites, tags, profiles and artifacts in Test Explorer with the
// native backend's discovery and debugging and real Robot Framework 7.5 from
// the native venv, driven by actual pointer and keyboard input at 1280x900
// over the synthetic "Selection Workspace" (paths with spaces and brackets,
// nested __init__.robot files, Test Tags, Default Tags, -tag removal, a test
// that starts a worker process). Skipped by name (pending) without the native
// backend; never reported as a pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
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
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

suite("Test Explorer directories, tags, profiles and artifacts (native backend, live, actual input)", () => {
  let extension, tests, debug, folder, config, cdp, root, descriptors;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const file = name => path.join(root, ...name.split("/"));
  const uriOf = name => vscode.Uri.file(file(name)).toString();
  const testId = (name, test, occurrence = 1) => `${uriOf(name)}::${test}${occurrence > 1 ? `#${occurrence}` : ""}`;
  const lineOf = (name, test, occurrence = 1) => fs.readFileSync(file(name), "utf8").split(/\r?\n/)
    .map((line, index) => (line === test ? index + 1 : 0)).filter(Boolean)[occurrence - 1];
  const selectionOf = runDir => JSON.parse(fs.readFileSync(path.join(runDir, "selection.json"), "utf8")).tests;
  const results = () => new Map((tests.lastRun || []).map(entry => [entry.id, entry]));

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `selection-${name}.png`), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-")}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, `selection-${name}.json`), JSON.stringify(await page(`
      [...document.querySelectorAll('.monaco-list-row, .action-label, .monaco-menu .action-item, .quick-input-list .monaco-list-row')]
        .filter(e => e.getClientRects().length).slice(0, 200).map(e => ({ aria: e.getAttribute('aria-label'), title: e.title,
          text: (e.innerText || '').slice(0, 120), level: e.getAttribute('aria-level'), expanded: e.getAttribute('aria-expanded') }))`), null, 2));
  }
  async function pointAt(finder, label, timeoutMs, { quiet = false } = {}) {
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
      if (!quiet) await dump(label);
      throw error;
    }
    return point;
  }
  async function click(point, label, { modifiers = 0, button = "left" } = {}) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers }, cdp.pageSession);
    await sleep(150);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, modifiers, button,
        buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0, clickCount: 1 }, cdp.pageSession);
    }
    evidence.push({ action: `${modifiers === 2 ? "Ctrl+" : ""}${button === "right" ? "right-" : ""}click`, target: label, point });
  }
  async function key(name, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key: name, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key: name, modifiers });
  }
  async function type(text) {
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
  }

  // Test Explorer rows by accessible name (the label, then the visible state).
  const rowFinder = (name, index = 0) => `() => [...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].filter(row =>
    row.getClientRects().length && /^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}( \\(|,|$)/u.test(row.getAttribute('aria-label') || ''))[${index}]`;
  const rowAttribute = (name, attribute, index = 0) =>
    page(`(() => { const row = (${rowFinder(name, index)})(); return row && row.getAttribute(${JSON.stringify(attribute)}); })()`);
  async function rowPoint(name, index = 0) {
    for (let attempt = 0; ; attempt++) {
      try { return await pointAt(rowFinder(name, index), `${name} row`, 1000, { quiet: true }); }
      catch (error) {
        if (attempt === 16) { await dump(`${name} row`); throw error; }
      }
      const tree = await page(`(() => { const tree = [...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length);
        const r = tree && tree.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!tree) continue;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...tree, deltaX: 0, deltaY: attempt < 8 ? 200 : -200 }, cdp.pageSession);
      evidence.push({ action: "wheel", target: "Test Explorer tree", deltaY: attempt < 8 ? 200 : -200 });
      await sleep(200);
    }
  }
  // Expands the given rows in order with a click on each collapsed one.
  async function expand(...labels) {
    for (const label of labels) {
      await rowPoint(label);
      if (await rowAttribute(label, "aria-expanded") === "false") await click(await rowPoint(label), `${label} row (expand)`);
      await until(async () => await rowAttribute(label, "aria-expanded") === "true", `${label} expanded`, 5000);
    }
  }
  async function rowState(name, state, index = 0, timeoutMs = 60000) {
    const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${state}\\)`, "u");
    await rowPoint(name, index); // Scrolled into view: the tree renders only visible rows.
    try {
      await until(async () => pattern.test(await rowAttribute(name, "aria-label", index) || ""), `${name} row shows ${state}`, timeoutMs);
    } catch (error) {
      await dump(`${name} ${state}`);
      throw error;
    }
    const label = await rowAttribute(name, "aria-label", index);
    evidence.push({ visibleState: label });
    return label;
  }
  async function rowAction(name, action, index = 0) {
    const row = await rowPoint(name, index);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
    await sleep(150);
    await click(await pointAt(`() => { const row = (${rowFinder(name, index)})();
      return row && [...row.querySelectorAll('.action-label')].find(action =>
        (action.getAttribute('aria-label') || action.title || '').startsWith(${JSON.stringify(action)})); }`, `${name} ${action} action`),
    `${name} row: ${action}`);
  }
  // Right-click a row and choose an entry of its context menu.
  async function contextMenu(name, entry) {
    await click(await rowPoint(name), `${name} row`, { button: "right" });
    await click(await pointAt(`() => [...document.querySelectorAll('.monaco-menu .action-item .action-label, .context-view .action-label')]
      .find(e => e.getClientRects().length && (e.getAttribute('aria-label') || e.textContent || '').trim().startsWith(${JSON.stringify(entry)}))`,
    `${entry} menu entry`), `${name} context menu: ${entry}`);
  }
  async function showTesting() {
    const shown = () => page(`(() => { const bar = document.querySelector('.part.sidebar');
      return Boolean(bar && bar.getClientRects().length && /^Testing/i.test(bar.querySelector('.title-label')?.textContent.trim() || '')); })()`);
    if (!await shown()) {
      await click(await pointAt(`() => [...document.querySelectorAll('.activitybar .action-label')]
        .find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))`, "Testing activity bar icon"), "Testing activity bar icon");
    }
    await until(() => page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`),
      "Testing view tree");
  }
  async function runAndWait(count, label, start, timeoutMs = 90000) {
    tests.lastRun = undefined;
    await start();
    await until(() => tests.lastRun?.length === count, label, timeoutMs);
    return results();
  }
  const itemById = itemId => {
    let found;
    const visit = item => { if (item.id === itemId) found = item; else item.children.forEach(visit); };
    tests.controller?.items.forEach(visit);
    return found;
  };

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    assert.ok(process.env.ROBOT_COMPANION_UI_USER_DATA_DIR, "run through tests/ui/run-ui-tests.js");
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    const api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    tests = api.getTestWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    root = path.join(folder.uri.fsPath, "integration-selection");
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("testing.clearTestResults");
    cdp = await WebviewCdp.connect();
    const viewport = await page(`({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "checked at 1280x900");
    const native = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const base = { workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable };
    const plain = value => JSON.parse(JSON.stringify(value));
    descriptors = { language: plain(native.nativeDescriptor({ ...base, services: ["language"] })),
      execution: plain(native.nativeDescriptor({ ...base, services: ["debug", "discovery"] })) };
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand",
      path.join(path.dirname(nativeExecutable), "robot"), vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration("robotCompanion").update("testProfiles", [
      { name: "Smoke", include: ["smoke"], exclude: ["duplicate"] },
      { name: "Broken", include: "smoke" }
    ], vscode.ConfigurationTarget.Workspace);
    await config.update("languageBackend", descriptors.language, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", descriptors.execution, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await tests.queue;
    await until(() => itemById(uriOf("api tests/orders.robot"))?.children.size === 3, "native discovery of the selection fixture", 60000);
    await showTesting();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: nativeExecutable, viewport,
      robot: path.join(path.dirname(nativeExecutable), "robot") });
  });

  // A failed case keeps VS Code's output channel logs (the profile is removed after the run).
  teardown(function () {
    if (this.currentTest?.state !== "failed" || !evidenceDirectory) return;
    const logs = path.join(process.env.ROBOT_COMPANION_UI_USER_DATA_DIR, "logs");
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(evidenceDirectory, `logs-${this.currentTest.title.slice(0, 40).replace(/\W+/g, "-")}`),
      { recursive: true });
  });

  suiteTeardown(async () => {
    if (!extension) return;
    await vscode.commands.executeCommand("testing.clearTestResults");
    await vscode.commands.executeCommand("notifications.clearAll");
    for (const name of ["testProfiles", "robotCommand"]) {
      await vscode.workspace.getConfiguration("robotCompanion").update(name, undefined, vscode.ConfigurationTarget.Workspace);
    }
    for (const name of ["languageBackend", "executionBackend", "integrationMode"]) {
      await config.update(name, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await tests.queue;
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "test-explorer-selection-ui-actions.json"),
      JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("directory suites hold their file suites with Robot's names; tests carry Robot's tags; rows expand by mouse and keyboard", async function () {
    this.timeout(120000);
    const orders = itemById(uriOf("api tests/orders.robot"));
    assert.equal(orders.parent.label, "API Suites", "the init file's Name setting names the directory suite");
    assert.equal(orders.parent.parent.label, "Integration-Selection");
    assert.equal(orders.parent.uri, undefined, "a directory suite has no URI");
    const tags = test => itemById(test).tags.map(tag => tag.id).sort();
    assert.deepEqual(tags(testId("api tests/orders.robot", "Create Order")), ["api", "smoke", "workspace"]);
    assert.deepEqual(tags(testId("api tests/orders.robot", "Cancel Order")), ["slow", "workspace"], "-api removes the init's tag");
    assert.deepEqual(tags(testId("api tests/users [v2].robot", "Login Again")), ["api", "regression", "workspace"]);
    assert.equal(itemById(testId("api tests/orders.robot", "Create Order")).description, undefined,
      "no description: screen readers hear the test's name");
    await expand("Integration-Selection", "API Suites", "Orders");
    // Keyboard: the focused Ui Tests row opens with the Right arrow key.
    await click(await rowPoint("Ui Tests"), "Ui Tests row");
    await key("ArrowRight", "ArrowRight", 39);
    await until(async () => await rowAttribute("Ui Tests", "aria-expanded") === "true", "Ui Tests expanded by the Right arrow key");
    const levels = {};
    for (const name of ["Integration-Selection", "API Suites", "Orders", "Create Order", "Ui Tests", "Unrelated"]) {
      levels[name] = await rowAttribute(name, "aria-level");
    }
    assert.deepEqual(levels, { "Integration-Selection": "1", "API Suites": "2", Orders: "3", "Create Order": "4", "Ui Tests": "2",
      Unrelated: "2" });
    assert.match(await rowAttribute("Create Order", "aria-label"), /^Create Order( \(|$)/, "the row's accessible name is the test name");
    await screenshot("tree");
    // The Testing view's filter selects by tag: @robotCompanion:<tag>.
    // The filter is a single-line editor (with suggestions) in the Testing view's header.
    await click(await pointAt(`() => [...document.querySelectorAll('.part.sidebar .suggest-input-container')]
      .find(e => e.getClientRects().length)`, "Testing filter"), "Testing filter");
    await type("@robotCompanion:regression");
    await until(async () => Boolean(await rowAttribute("Login Again", "aria-label")) && !await rowAttribute("Create Order", "aria-label"),
      "the tag filter shows Login Again only", 10000).catch(async error => { await dump("tag filter"); throw error; });
    await screenshot("tag-filter");
    await key("a", "KeyA", 65, 2);
    await key("Backspace", "Backspace", 8);
    await until(async () => Boolean(await rowAttribute("Create Order", "aria-label")), "filter cleared");
    evidence.push({ result: "directory tree and tags", levels, filter: "@robotCompanion:regression -> Login Again" });
  });

  test("a multi-selection of a directory, a file and a test runs exactly those, with every __init__.robot on their path", async function () {
    this.timeout(180000);
    await expand("Integration-Selection", "API Suites", "Ui Tests");
    await rowPoint("Users [V2]");
    await click(await rowPoint("Ui Tests"), "Ui Tests row");
    await click(await rowPoint("Users [V2]"), "Users [V2] row", { modifiers: 2 });
    await expand("Orders");
    await click(await rowPoint("Create Order"), "Create Order row", { modifiers: 2 });
    const selected = await page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row.selected')].map(r => r.getAttribute('aria-label'))`);
    assert.equal(selected.length, 3, `three selected rows: ${selected}`);
    await screenshot("multi-selection");
    const shown = await runAndWait(6, "six tests reported", () => rowAction("Create Order", "Run Test"));
    const expected = {
      [testId("api tests/orders.robot", "Create Order")]: "PASS", [testId("api tests/users [v2].robot", "Login *")]: "PASS",
      [testId("api tests/users [v2].robot", "Login Again")]: "PASS", [testId("ui tests/basket.robot", "Basket Passes")]: "PASS",
      [testId("ui tests/basket.robot", "Basket Fails")]: "FAIL", [testId("ui tests/nested dir/deep.robot", "Deep Test")]: "PASS" };
    assert.deepEqual(Object.fromEntries([...shown.values()].map(entry => [entry.id, entry.robotStatus])), expected);
    const [first] = shown.values();
    assert.equal(new Set([...shown.values()].map(entry => entry.outputDir)).size, 1, "one Robot run");
    assert.deepEqual(first.args.slice(-3), ["--argumentfile", path.join(first.runDir, "arguments.txt"), folder.uri.fsPath]);
    assert.equal(selectionOf(first.runDir).length, 6);
    assert.equal(fs.readFileSync(path.join(first.outputDir, "markers.txt"), "utf8"), "root-setup\napi-setup\n",
      "the root and API Suites init files' suite setups ran once each; nothing unrelated ran");
    const xml = fs.readFileSync(path.join(first.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="5" fail="1" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(xml, /Cancel Order|Unrelated Must Not Run|Starts A Worker/);
    assert.equal(shown.has(testId("api tests/orders.robot", "Create Order", 2)), false, "the second Create Order did not run");
    await expand("Ui Tests", "Basket", "Users [V2]");
    await rowState("Basket Fails", "Failed");
    await rowState("Login *", "Passed");
    await rowState("Ui Tests", "Failed");
    await screenshot("multi-selection-results");
    const manifest = JSON.parse(fs.readFileSync(path.join(first.runDir, "robot-companion-run.json"), "utf8"));
    assert.deepEqual([manifest.kind, manifest.profile, manifest.mode, manifest.tests.length], ["Run", null, "tests", 6]);
    evidence.push({ result: "directory + file + test", run: first.outputDir, statuses: expected, manifest: path.join(first.runDir,
      "robot-companion-run.json") });

    // Rerun Failed Tests from the Test Results view: only Basket Fails runs again.
    await vscode.commands.executeCommand("workbench.panel.testResults.view.focus");
    const runRow = `() => [...document.querySelectorAll('.monaco-list-row')].find(row => row.getClientRects().length &&
      row.closest('.test-output-peek-tree, .testing-output-peek, [id*="testResults"]') && row.getAttribute('aria-level') === '1')`;
    const rerun = await runAndWait(1, "rerun reported", async () => {
      const row = await pointAt(runRow, "Test Results run row");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
      await sleep(200);
      await click(await pointAt(`() => { const row = (${runRow})();
        return row && [...row.querySelectorAll('.action-label')].find(a => /Rerun Failed Tests/.test(a.getAttribute('aria-label') || a.title || '')); }`,
      "Rerun Failed Tests action"), "Test Results run: Rerun Failed Tests");
    });
    assert.deepEqual([...rerun.keys()], [testId("ui tests/basket.robot", "Basket Fails")]);
    assert.deepEqual(selectionOf([...rerun.values()][0].runDir), [[file("ui tests/basket.robot"), lineOf("ui tests/basket.robot", "Basket Fails"),
      "Basket Fails"]]);
    await showTesting();
    await expand("Integration-Selection", "Ui Tests", "Basket");
    await rowState("Basket Fails", "Failed");
    evidence.push({ result: "rerun failed", ids: [...rerun.keys()] });
  });

  test("Execute Using Profile 'Smoke' runs only the selected tests whose tags it selects; an invalid profile is not offered", async function () {
    this.timeout(180000);
    assert.deepEqual(tests.profiles.map(profile => profile.name), ["Smoke"], "the entry with a non-list include is left out");
    // Earlier results would stay visible: every row shown below comes from this run.
    await vscode.commands.executeCommand("testing.clearTestResults");
    await expand("Integration-Selection");
    // API Suites holds Create Order (smoke), Cancel Order (slow), Create Order #2 (smoke, duplicate),
    // Login * (smoke) and Login Again (regression): Smoke (include smoke, exclude duplicate) runs two.
    const shown = await runAndWait(2, "two Smoke tests reported", async () => {
      await contextMenu("API Suites", "Execute Using Profile");
      await click(await pointAt(`() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(row =>
        row.getClientRects().length && /^Smoke\\b/.test(row.getAttribute('aria-label') || ''))`, "Smoke profile in the quick pick"),
      "Quick pick: Smoke");
    }).catch(async error => { await dump("profile run"); throw error; });
    assert.deepEqual(Object.fromEntries([...shown.values()].map(entry => [entry.id, entry.robotStatus])), {
      [testId("api tests/orders.robot", "Create Order")]: "PASS", [testId("api tests/users [v2].robot", "Login *")]: "PASS" });
    const [first] = shown.values();
    const argumentFile = fs.readFileSync(path.join(first.runDir, "arguments.txt"), "utf8").split("\n");
    assert.ok(argumentFile.includes("--include smoke") && argumentFile.includes("--exclude duplicate"), "Robot gets the same patterns");
    const xml = fs.readFileSync(path.join(first.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="2" fail="0" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(xml, /Cancel Order|Login Again|second create/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.runDir, "robot-companion-run.json"), "utf8")).profile, "Smoke");
    await showTesting();
    await expand("API Suites", "Users [V2]");
    await rowState("Login *", "Passed");
    await rowState("Login Again", "Not yet run");
    await screenshot("profile-smoke");
    evidence.push({ result: "profile Smoke on API Suites", ids: [...shown.keys()], argumentFile: argumentFile.filter(Boolean) });
  });

  test("Open Robot Log and Open Robot Report in the item menu open the item's own latest results, the log at the test", async function () {
    this.timeout(120000);
    const login = itemById(testId("api tests/users [v2].robot", "Login *"));
    const artifact = tests.artifactFor(login);
    assert.ok(artifact, "Login * has results of the Smoke run");
    tests.lastOpened = undefined;
    await expand("Integration-Selection", "API Suites", "Users [V2]");
    await contextMenu("Login *", "Open Robot Log");
    await until(() => tests.lastOpened, "Open Robot Log handled");
    const log = tests.lastOpened;
    assert.equal(log.fsPath, path.join(artifact.outputDir, "log.html"));
    assert.ok(log.fragment, "the log opens at the test");
    assert.match(fs.readFileSync(path.join(artifact.outputDir, "output.xml"), "utf8"),
      new RegExp(`<test id="${log.fragment}" name="Login \\*"`), "the fragment is Robot's id of Login * in that run");
    tests.lastOpened = undefined;
    await contextMenu("API Suites", "Open Robot Report");
    await until(() => tests.lastOpened, "Open Robot Report handled");
    assert.equal(tests.lastOpened.fsPath, path.join(tests.artifactFor(itemById(uriOf("api tests/orders.robot")).parent).outputDir,
      "report.html"), "a directory opens the report of the latest run below it");
    assert.ok(fs.existsSync(tests.lastOpened.fsPath));
    await screenshot("open-log");
    evidence.push({ result: "Open Robot Log / Report", log: log.toString(true), report: tests.lastOpened.toString(true) });
  });

  test("Debug Test on a directory runs its tests in one owned debug session and reports each test", async function () {
    this.timeout(180000);
    await vscode.commands.executeCommand("testing.clearTestResults");
    await expand("Integration-Selection");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    tests.lastRun = undefined;
    await rowAction("Ui Tests", "Debug Test");
    const pauses = [];
    await until(async () => {
      const frame = vscode.debug.activeStackItem;
      if (frame instanceof vscode.DebugStackFrame) {
        const session = frame.session;
        const stack = await session.customRequest("stackTrace", { threadId: frame.threadId, levels: 3 }).catch(error => ({ error: error.message }));
        pauses.push({ session: session.name, type: session.type, stack: JSON.stringify(stack).slice(0, 600) });
        await key("F5", "F5", 116);
        await sleep(500);
      }
      return tests.lastRun?.length === 3;
    }, "three debugged tests reported", 90000).catch(async error => {
      await vscode.commands.executeCommand("workbench.panel.repl.view.focus");
      await sleep(1000);
      const consoleText = await page(`[...document.querySelectorAll('.repl')].map(e => e.innerText).join('\\n').slice(-3000)`);
      evidence.push({ pauses, consoleText });
      throw new Error(`${error.message}: ${JSON.stringify(pauses)} Debug Console: ${consoleText}`);
    });
    const shown = results();
    const session = await started;
    assert.equal(session.type, "robotcompanion");
    assert.equal(session.configuration.target, folder.uri.fsPath);
    assert.equal(session.configuration.args[0], "--argumentfile");
    assert.deepEqual(Object.fromEntries([...shown.values()].map(entry => [entry.id, entry.robotStatus])), {
      [testId("ui tests/basket.robot", "Basket Passes")]: "PASS", [testId("ui tests/basket.robot", "Basket Fails")]: "FAIL",
      [testId("ui tests/nested dir/deep.robot", "Deep Test")]: "PASS" });
    const [first] = shown.values();
    assert.match(fs.readFileSync(path.join(first.outputDir, "output.xml"), "utf8"), /<stat pass="2" fail="1" skip="0">All Tests<\/stat>/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.runDir, "robot-companion-run.json"), "utf8")).kind, "Debug");
    await until(() => debug.sessions.size === 0, "debug session released", 15000);
    await expand("Ui Tests", "Basket");
    await rowState("Basket Fails", "Failed");
    await rowState("Basket Passes", "Passed");
    await screenshot("debug-directory");
    evidence.push({ result: "Debug Test on Ui Tests", session: session.name, outputDir: first.outputDir });
  });

  test("Stop ends Robot and the worker process a test started in its own session; the stopped tests are Skipped", async function () {
    this.timeout(180000);
    await expand("Integration-Selection", "Workers", "Long Run");
    tests.lastRun = undefined;
    await rowAction("Long Run", "Run Test");
    let pidFile;
    await until(() => {
      const robot = [...tests.active][0];
      pidFile = robot && path.join(robot.outputDir, "worker.pid");
      return pidFile && fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")) > 0;
    }, "the worker test started its worker", 60000);
    const worker = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(alive(worker));
    const robotGroup = [...tests.active][0].pid;
    const workerGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(worker)], { encoding: "utf8" }).trim());
    assert.notEqual(workerGroup, robotGroup, "the worker runs outside Robot's process group");
    await screenshot("worker-running");
    const stopped = Date.now();
    await click(await pointAt(`() => [...document.querySelectorAll('.action-label')]
      .find(a => a.getClientRects().length && /^Cancel Test Run/.test(a.getAttribute('aria-label') || a.title || ''))`, "Stop button"),
    "Test Explorer Stop (Cancel Test Run)");
    await until(() => tests.lastRun?.length === 2, "stopped run reported", 15000);
    await until(() => !alive(worker), "the worker is gone", 5000);
    const elapsed = Date.now() - stopped;
    assert.ok(elapsed < 10000, `stopped within 10 s (${elapsed} ms)`);
    assert.deepEqual(tests.lastRun.map(entry => entry.status), ["cancelled", "cancelled"]);
    await rowState("Starts A Worker And Waits", "Skipped");
    await rowState("Never Reached", "Skipped");
    await screenshot("worker-stopped");
    evidence.push({ result: "Stop with a worker", worker, workerGroup, robotGroup, elapsedMs: elapsed, workerAlive: alive(worker) });
  });
});

"use strict";

// Run with Coverage and continuous runs in Test Explorer with the native
// backend's discovery and real Robot Framework 7.5 from the native venv, driven
// by actual pointer and keyboard input at 1280x900 over the synthetic
// "Coverage Workspace". Skipped by name (pending) without the native backend;
// never reported as a pass.
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

suite("Test Explorer coverage and continuous runs (native backend, live, actual input)", () => {
  let extension, api, tests, debug, folder, config, cdp, root, descriptors;
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
    fs.writeFileSync(path.join(evidenceDirectory, `coverage-${name}.png`), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-")}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, `coverage-${name}.json`), JSON.stringify(await page(`
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
    api = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    tests = api.getTestWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    root = path.join(folder.uri.fsPath, "integration-coverage");
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
    await vscode.workspace.getConfiguration("robotCompanion").update("testProfiles", [{ name: "Smoke", include: ["smoke"] }],
      vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration("robotCompanion").update("continuousRunDelay", 800, vscode.ConfigurationTarget.Workspace);
    await config.update("languageBackend", descriptors.language, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("executionBackend", descriptors.execution, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await tests.queue;
    await until(() => itemById(uriOf("orders.robot"))?.children.size === 4, "native discovery of the coverage fixture", 60000);
    await showTesting();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: nativeExecutable, viewport,
      robot: path.join(path.dirname(nativeExecutable), "robot") });
  });

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
    for (const name of ["testProfiles", "robotCommand", "continuousRunDelay"]) {
      await vscode.workspace.getConfiguration("robotCompanion").update(name, undefined, vscode.ConfigurationTarget.Workspace);
    }
    for (const name of ["languageBackend", "executionBackend", "integrationMode"]) {
      await config.update(name, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await tests.queue;
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "test-explorer-coverage-ui-actions.json"),
      JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  // Coverage decorations of the visible editor lines: line number -> "hit" or "miss".
  const gutter = () => page(`Object.fromEntries([...document.querySelectorAll('.monaco-editor .line-numbers.coverage-deco-gutter')]
    .filter(e => e.getClientRects().length).map(e => [Number(e.textContent), e.classList.contains('coverage-deco-miss') ? 'miss'
      : e.classList.contains('coverage-deco-hit') ? 'hit' : 'other']))`);
  const coverageRowFinder = name => `() => [...document.querySelectorAll('.monaco-list-row')].find(row => row.getClientRects().length &&
    (row.getAttribute('aria-label') || '').startsWith(${JSON.stringify(`${name} coverage`)}))`;
  const coverageRows = () => page(`[...document.querySelectorAll('.monaco-list-row')].filter(row => row.getClientRects().length &&
    / coverage: /.test(row.getAttribute('aria-label') || '')).map(row => ({ aria: row.getAttribute('aria-label'),
      text: row.innerText.replace(/\\s+/g, ' ').trim() }))`);
  const toasts = () => page(`[...document.querySelectorAll('.notification-toast .notification-list-item-message')]
    .filter(e => e.getClientRects().length).map(e => e.innerText)`);
  const lineOfText = (name, text) => fs.readFileSync(file(name), "utf8").split(/\r?\n/).findIndex(line => line.trim() === text) + 1;
  const save = async () => { await key("s", "KeyS", 83, 2); return Date.now(); };
  // Quick Open (Ctrl+P) a file of the fixture by name and click its entry.
  async function quickOpen(name) {
    await key("1", "Digit1", 49, 2); // Ctrl+1: the editor group, not the Test Results terminal, gets Ctrl+P.
    await key("p", "KeyP", 80, 2);
    await until(() => page(`Boolean(document.activeElement?.closest('.quick-input-widget'))`), "Quick Open focused");
    await type(name);
    await click(await pointAt(`() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(row => row.getClientRects().length &&
      (row.getAttribute('aria-label') || '').startsWith(${JSON.stringify(name)}))`, `${name} in Quick Open`), `Quick Open: ${name}`);
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === file(name), `${name} open`)
      .catch(async error => { await dump(`quick open ${name}`); throw error; });
  }
  // Replaces line `line` (1-based) of the active editor by typing.
  async function replaceLine(line, text) {
    await key("Home", "Home", 36, 2);
    for (let index = 1; index < line; index++) await key("ArrowDown", "ArrowDown", 40);
    await key("Home", "Home", 36);
    await key("End", "End", 35, 8);
    await type(text);
  }
  // Every Test Explorer run of this suite's cases: start, end, the tests it ran and its note.
  function recordRuns() {
    const runs = [], original = tests.runOnce;
    let mostActive = 0;
    tests.runOnce = async function (request, token, options) {
      const entry = { started: Date.now(), ids: (request.include || []).map(item => item.id), note: options?.note || null };
      runs.push(entry);
      try { return await original.call(this, request, token, options); } finally { entry.ended = Date.now(); }
    };
    const sampler = setInterval(() => { mostActive = Math.max(mostActive, tests.active.size); }, 20);
    return { runs, mostActive: () => mostActive, restore: () => { clearInterval(sampler); tests.runOnce = original; } };
  }

  test("Run Test with Coverage on a file shows the measured Python lines in Test Coverage and the editor, per test on request", async function () {
    this.timeout(180000);
    await vscode.commands.executeCommand("testing.clearTestResults");
    await expand("Integration-Coverage", "Orders");
    const shown = await runAndWait(4, "four tests reported", () => rowAction("Orders", "Run Test with Coverage"));
    assert.deepEqual([...shown.values()].map(entry => entry.robotStatus), ["PASS", "PASS", "PASS", "PASS"]);
    const [first] = shown.values();
    const manifest = JSON.parse(fs.readFileSync(path.join(first.runDir, "robot-companion-run.json"), "utf8"));
    assert.deepEqual([manifest.coverage.files, manifest.coverage.covered, manifest.coverage.total, manifest.coverage.unmeasured],
      [2, 29, 31, []]);
    assert.ok(fs.readFileSync(path.join(first.runDir, "arguments.txt"), "utf8").includes(
      `--listener ${path.join(first.runDir, "RobotCompanionCoverage.py")}`));
    // Test Coverage lists exactly the measured files: no site-packages module, no script of the separate process.
    await until(async () => (await coverageRows()).some(row => row.aria.startsWith("pricing.py coverage")), "Test Coverage rows", 15000)
      .catch(async error => { await dump("coverage rows"); throw error; });
    const rows = await coverageRows();
    assert.deepEqual(rows.map(row => row.aria.split(" coverage")[0]).sort(), ["OrderLibrary.py", "libraries", "pricing.py"]);
    assert.match(rows.find(row => row.aria.startsWith("OrderLibrary.py")).text, /96\.15?%/, "25 of 26 lines");
    assert.match(rows.find(row => row.aria.startsWith("pricing.py")).text, /80(\.00?)?%/, "4 of 5 lines");
    await screenshot("coverage-view");
    evidence.push({ result: "Test Coverage rows", rows });

    // A click on the file's row opens it with the lines decorated: run or not run.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await click(await pointAt(coverageRowFinder("OrderLibrary.py"), "OrderLibrary.py coverage row"), "Test Coverage: OrderLibrary.py");
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === file("libraries/OrderLibrary.py"), "OrderLibrary.py open");
    const library = "libraries/OrderLibrary.py";
    const [blank, minus, notRun, neverDef] = [lineOfText(library, "STORE = {}") + 1, lineOfText(library, "price -= discount(price)"),
      lineOfText(library, 'return "not run"'), lineOfText(library, "def never_called():")];
    await until(async () => (await gutter())[minus] === "hit", "decorations shown");
    const top = await gutter();
    assert.equal(top[blank], undefined, "a blank line has no decoration");
    assert.equal(top[1], "hit", "the module docstring line ran");
    await key("1", "Digit1", 49, 2); // Ctrl+1: focus the editor (the click left focus in Test Coverage).
    await key("End", "End", 35, 2); // Ctrl+End: the end of the file.
    await until(async () => (await gutter())[notRun] === "miss", "never_called's body shown as not run");
    assert.equal((await gutter())[neverDef], "hit", "its def line ran at import");
    await screenshot("coverage-editor");

    // Filter Coverage to Test -> Small Order Has No Discount: only that test's lines.
    await click(await pointAt(`() => [...document.querySelectorAll('.editor-actions .action-label')].find(a => a.getClientRects().length &&
      /^Filter Coverage to Test/.test(a.getAttribute('aria-label') || a.title || ''))`, "Filter Coverage to Test"), "Filter Coverage to Test");
    await click(await pointAt(`() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(row => row.getClientRects().length &&
      /^Small Order Has No Discount/.test(row.getAttribute('aria-label') || ''))`, "Small Order in the test filter"), "Quick pick: Small Order Has No Discount");
    await key("Home", "Home", 36, 2);
    const own = [lineOfText(library, "quantity = int(quantity)"), lineOfText(library, "price = quantity * 10"),
      lineOfText(library, "if quantity >= 100:"), lineOfText(library, "return vendored.identity(price)")];
    await until(async () => (await gutter())[minus] !== "hit", "the per-test view drops the discount line", 10000)
      .catch(async error => { await dump("per-test filter"); throw error; });
    const filtered = await gutter();
    assert.deepEqual(own.map(line => filtered[line]), ["hit", "hit", "hit", "hit"]);
    assert.notEqual(filtered[lineOfText(library, "STORE[\"open\"] = True")], "hit", "the suite setup's line belongs to no test");
    await screenshot("coverage-per-test");
    evidence.push({ result: "per-test coverage", filtered, own, minus });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("Execute Using Profile 'Smoke (Coverage)' measures only the smoke test's lines", async function () {
    this.timeout(180000);
    await vscode.commands.executeCommand("testing.clearTestResults");
    await showTesting();
    await expand("Integration-Coverage");
    const shown = await runAndWait(1, "the smoke test reported", async () => {
      await contextMenu("Orders", "Execute Using Profile");
      await click(await pointAt(`() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(row =>
        row.getClientRects().length && /^Smoke \\(Coverage\\)/.test(row.getAttribute('aria-label') || ''))`, "Smoke (Coverage) in the quick pick"),
      "Quick pick: Smoke (Coverage)");
    });
    assert.deepEqual([...shown.keys()], [testId("orders.robot", "Small Order Has No Discount")]);
    const manifest = JSON.parse(fs.readFileSync(path.join([...shown.values()][0].runDir, "robot-companion-run.json"), "utf8"));
    assert.equal(manifest.profile, "Smoke");
    assert.deepEqual([manifest.coverage.covered, manifest.coverage.total], [20, 31], "imports, defs, the suite setup and the small order's lines");
    await until(async () => (await coverageRows()).some(row => row.aria.startsWith("OrderLibrary.py")), "coverage of the profile run");
    const rows = await coverageRows();
    assert.match(rows.find(row => row.aria.startsWith("OrderLibrary.py")).text, /69\.23?%/, "18 of 26 lines");
    await screenshot("coverage-profile");
    evidence.push({ result: "Smoke (Coverage)", rows, coverage: manifest.coverage });
  });

  test("Robot run under another Python tracer: no coverage is shown, the run output and a notification say why", async function () {
    this.timeout(180000);
    await vscode.commands.executeCommand("testing.clearTestResults");
    await vscode.commands.executeCommand("notifications.clearAll");
    const traceDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "robot-companion-trace-"));
    const robotCommand = `"${path.join(path.dirname(nativeExecutable), "python")}" -m trace --count --coverdir "${traceDir}" --module robot`;
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", robotCommand, vscode.ConfigurationTarget.Workspace);
    try {
      await showTesting();
      await expand("Integration-Coverage", "Orders");
      const shown = await runAndWait(1, "traced run reported", () => rowAction("Small Order Has No Discount", "Run Test with Coverage"));
      const [entry] = shown.values();
      assert.equal(entry.robotStatus, "PASS", "the test itself ran and passed");
      const manifest = JSON.parse(fs.readFileSync(path.join(entry.runDir, "robot-companion-run.json"), "utf8"));
      assert.match(manifest.coverage.unavailable, /another Python tracer .* was already active/);
      await until(async () => (await toasts()).some(text => /no coverage for this run: another Python tracer/.test(text)),
        "the notification", 10000).catch(async error => { await dump("tracer notification"); throw error; });
      evidence.push({ result: "unavailable coverage", toasts: await toasts(), coverageRows: await coverageRows(), manifest: manifest.coverage });
      assert.deepEqual(await coverageRows(), [], "Test Coverage shows no file for this run");
      await screenshot("coverage-unavailable");
    } finally {
      await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand",
        path.join(path.dirname(nativeExecutable), "robot"), vscode.ConfigurationTarget.Workspace);
      fs.rmSync(traceDir, { recursive: true, force: true });
      await vscode.commands.executeCommand("notifications.clearAll");
    }
  });

  test("Turn on Continuous Run: saves are debounced, runs never overlap, a manual run is waited for, Turn off stops the run", async function () {
    this.timeout(300000);
    await vscode.commands.executeCommand("testing.clearTestResults");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showTesting();
    await expand("Integration-Coverage", "Watched");
    const record = recordRuns();
    const watched = [testId("watched.robot", "Watched Passes"), testId("watched.robot", "Watched Waits")];
    try {
      await rowAction("Watched", "Turn on Continuous Run");
      await until(() => tests.watches.size === 1, "continuous run on");
      await rowPoint("Watched");
      await until(() => page(`(() => { const row = (${rowFinder("Watched")})();
        return Boolean(row && [...row.querySelectorAll('.action-label')].some(a => /^Turn off Continuous Run/.test(a.getAttribute('aria-label') || a.title || ''))); })()`),
      "the row offers Turn off Continuous Run");
      await sleep(1500);
      assert.equal(record.runs.length, 0, "turning it on runs nothing by itself");

      // (a) Two saves 300 ms apart: one run of the file's tests, after the delay (800 ms) from the last save.
      await quickOpen("watched.robot");
      await key("End", "End", 35, 2);
      await type("\n# first edit");
      await save();
      await sleep(300);
      await type(" and more");
      const lastSave = await save();
      await until(() => record.runs.length === 1 && record.runs[0].ended, "one continuous run", 30000);
      await sleep(2000);
      assert.equal(record.runs.length, 1, "two saves, one run");
      assert.ok(record.runs[0].started - lastSave >= 750, `debounced: ${record.runs[0].started - lastSave} ms after the last save`);
      assert.deepEqual(record.runs[0].ids.sort(), [...watched].sort());
      assert.equal(record.runs[0].note, "Continuous run after integration-coverage/watched.robot was saved.");
      await expand("Integration-Coverage", "Watched"); // Rediscovery after the save replaced the items.
      await rowState("Watched Passes", "Passed");

      // (b) A resource save makes Watched Waits take 3 s; saves during that run start exactly one run after it.
      await quickOpen("watched.resource");
      await replaceLine(2, "${WAIT}    3s");
      await save();
      await until(() => record.runs.length === 2 && tests.active.size === 1, "second run running", 30000);
      await sleep(800);
      await type(" ");
      await save();
      await sleep(300);
      await key("Backspace", "Backspace", 8);
      await save();
      await until(() => record.runs.length === 3 && record.runs[2].ended, "the follow-up run ended", 60000);
      await sleep(2500);
      assert.equal(record.runs.length, 3, "the saves during the run started one run");
      assert.ok(record.runs[2].started >= record.runs[1].ended, "the follow-up started after the run ended");

      // (c) A save while a manual Run Test runs: the continuous run starts after it.
      await expand("Integration-Coverage", "Watched");
      await rowAction("Watched Waits", "Run Test");
      await until(() => record.runs.length === 4 && tests.active.size === 1, "the manual run is running", 30000);
      await key("1", "Digit1", 49, 2); // Ctrl+1: back to the watched.resource editor.
      await type(" ");
      const duringManual = await save();
      await until(() => record.runs.length === 5 && record.runs[4].ended, "the continuous run after the manual one", 60000);
      assert.equal(record.runs[3].note, null, "run 4 is the manual one");
      assert.ok(duringManual < record.runs[3].ended, "saved while the manual run ran");
      assert.ok(record.runs[4].started >= record.runs[3].ended, "the continuous run waited for the manual run");
      assert.equal(record.mostActive(), 1, "never two Robot runs at once");

      // (d) Turn off Continuous Run during a 60 s run: the run stops, its tests are Skipped, and saves start nothing.
      await quickOpen("watched.resource");
      await replaceLine(2, "${WAIT}    60s");
      await save();
      await until(() => record.runs.length === 6 && tests.active.size === 1, "a long continuous run", 30000);
      const robot = [...tests.active][0];
      await sleep(1500);
      assert.ok(robot.groupAlive(), "Robot runs");
      await expand("Integration-Coverage", "Watched");
      const stopped = Date.now();
      await rowAction("Watched", "Turn off Continuous Run");
      await until(() => record.runs[5].ended, "the run ended", 15000);
      await until(() => !robot.groupAlive(), "no process of the run is left", 10000);
      const elapsed = Date.now() - stopped;
      assert.ok(elapsed < 10000, `stopped within 10 s (${elapsed} ms)`);
      assert.equal(tests.watches.size, 0, "continuous run off");
      await expand("Integration-Coverage", "Watched");
      await rowState("Watched Waits", "Skipped");
      await key("1", "Digit1", 49, 2); // Ctrl+1: the watched.resource editor.
      await type(" ");
      await save();
      await sleep(2500);
      assert.equal(record.runs.length, 6, "a save after Turn off starts nothing");
      await screenshot("continuous-off");
      evidence.push({ result: "continuous run", runs: record.runs, mostActive: record.mostActive(), stopElapsedMs: elapsed });
    } finally {
      record.restore();
      if (tests.watches.size) await vscode.commands.executeCommand("testing.stopContinuousRun"); // Cleanup after a failure only.
      await vscode.commands.executeCommand("workbench.action.files.saveAll");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("Deactivation during a continuous run ends its Robot run and the continuous run; a new instance discovers again", async function () {
    this.timeout(180000);
    await showTesting();
    await expand("Integration-Coverage", "Watched");
    await rowAction("Watched", "Turn on Continuous Run");
    await until(() => tests.watches.size === 1, "continuous run on");
    await quickOpen("watched.resource");
    await replaceLine(2, "${WAIT}    60s");
    await type(" ");
    await save();
    await until(() => tests.active.size === 1, "a continuous run running", 30000);
    const robot = [...tests.active][0], old = tests;
    await sleep(1500);
    const started = Date.now();
    tests = await api.restartTestWorkspaceForTest();
    const elapsed = Date.now() - started;
    assert.equal(robot.groupAlive(), false, "no process of the run is left after dispose()");
    assert.equal(old.watches.size, 0, "the continuous run ended");
    assert.equal(old.active.size, 0);
    assert.ok(elapsed < 10000, `dispose() took ${elapsed} ms`);
    await until(() => itemById(uriOf("orders.robot"))?.children.size === 4, "the new instance's discovery", 60000);
    // VS Code keeps its own "Tests are being watched" state for the disposed controller (in a real
    // deactivation the extension host goes with it); clear it so the next suites start as before.
    const badge = await page(`[...document.querySelectorAll('.activitybar .action-label')].map(a => a.getAttribute('aria-label'))
      .find(label => /^Testing/.test(label || ''))`);
    await vscode.commands.executeCommand("testing.stopContinuousRun");
    await until(async () => await page(`[...document.querySelectorAll('.activitybar .action-label')].map(a => a.getAttribute('aria-label'))
      .find(label => /^Testing/.test(label || ''))`).then(label => !/watched/i.test(label || "")), "VS Code's watch state cleared", 10000);
    evidence.push({ result: "dispose during continuous run", disposeMs: elapsed, robotPid: robot.pid, testingBadgeAfterDispose: badge });
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});

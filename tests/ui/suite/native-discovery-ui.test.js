"use strict";

// Live Test Explorer over the native backend's discovery service
// (`robot-companion-backend discovery`, normalized discovery API v1) with
// native language and native debugging, real Robot Framework 7.5 runs from the
// native venv (no RobotCode anywhere), driven by actual pointer and keyboard
// input at 1280x900: the tree against an independent backend request, source
// navigation, multi-selection, suite runs, duplicate names, Rerun Failed, Stop,
// Debug Test, Refresh after files change on disk, failures that leave language
// and debugging running, and the discovery combinations. Skipped by name
// (pending) when the native backend venv is absent; never reported as a pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const robotCodePython = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const NATIVE = "Native backend 0.1.0.dev8";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function groupMembers(pgid) {
  try { return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

// This UI run's own processes carry its unique profile directory in their
// environment (set by tests/ui/run-ui-tests.js); other runs never match.
const RUN_MARKER = `ROBOT_COMPANION_UI_USER_DATA_DIR=${process.env.ROBOT_COMPANION_UI_USER_DATA_DIR}`;
function ownedByThisRun(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(RUN_MARKER); }
  catch { return false; }
}
const KINDS = [
  ["robotcode", /robotcode/i], ["native-language", /robot-companion-backend lsp$/], ["native-discovery", /robot-companion-backend discovery/],
  ["native-debug", /robot-companion-backend dap$/], ["native-worker", /-m robot_companion_backend\.worker /],
  ["debugpy", /debugpy/], ["robot", /\/bin\/robot |robot\.run/], ["sleep", /^sleep 300$/], ["fixture-discovery", /fixtures\/discovery\/server\.js/]
];
// Backend, Robot and debugger processes of this run, by kind.
function processes() {
  try {
    return execFileSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" }).split("\n").flatMap(line => {
      const [pid, pgid, ...rest] = line.trim().split(/\s+/);
      const args = rest.join(" ");
      const kind = KINDS.find(([, pattern]) => pattern.test(args))?.[0];
      return kind && ownedByThisRun(pid) ? [{ pid: Number(pid), pgid: Number(pgid), kind, args: args.slice(0, 160) }] : [];
    });
  } catch { return []; }
}
const runProcesses = () => processes().filter(item => /native-debug|native-worker|debugpy|robot|sleep/.test(item.kind));

suite("Native Test Explorer discovery with native language and debugging (live, actual input)", () => {
  let extension, api, tests, debug, language, folder, config, cdp, fixtureRoot, tasksUri, namesUri, waitsUri, descriptors;
  const evidence = [];
  const robotCodeSeen = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const id = (uri, name) => `${uri}::${name}`;
  const fixtureFile = name => path.join(fixtureRoot, name);
  const readyFlag = () => fixtureFile("nested/native.ready");
  const launchName = "Robot Companion: Debug native tasks";

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `native-discovery-${name}.png`), Buffer.from(data, "base64"));
  }
  async function dump(label) {
    if (!evidenceDirectory) return;
    const name = `missing-${label.replace(/\W+/g, "-")}`;
    await screenshot(name);
    fs.writeFileSync(path.join(evidenceDirectory, `native-discovery-${name}.json`), JSON.stringify(await page(`
      [...document.querySelectorAll('.monaco-list-row, .action-label, .notification-toast, .notification-list-item')]
        .filter(e => e.getClientRects().length).slice(0, 200).map(e => ({ aria: e.getAttribute('aria-label'), title: e.title,
          text: (e.innerText || '').slice(0, 120), level: e.getAttribute('aria-level'), cls: String(e.className).slice(0, 80) }))`), null, 2));
  }
  // A visible element found by `finder` whose point is not covered by anything else.
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
          let hit = document.elementFromPoint(x, y);
          while (hit?.shadowRoot) {
            const next = hit.shadowRoot.elementFromPoint(x, y);
            if (!next || next === hit) break;
            hit = next;
          }
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
  async function click(point, label, { modifiers = 0, clickCount = 1, button = "left" } = {}) {
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

  // Test Explorer rows by accessible name (label, then the visible state); `index` picks one of equally named rows.
  const rowFinder = (name, index = 0) => `() => [...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].filter(row =>
    row.getClientRects().length && /^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}( \\(|,|$)/u.test(row.getAttribute('aria-label') || ''))[${index}]`;
  const rowLabel = (name, index = 0) => page(`(() => { const row = (${rowFinder(name, index)})(); return row && row.getAttribute('aria-label'); })()`);
  // The centre of the visible Test Explorer tree, where mouse-wheel events scroll it; undefined while a
  // refresh replaces the tree.
  const TREE_CENTRE = `(() => { const tree = [...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length);
    const r = tree && tree.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
  // Waits for the visible tree: a wheel event needs a position, and CDP refuses one without it (-32602).
  async function treeCentre() {
    let tree;
    await until(async () => (tree = await page(TREE_CENTRE)), "the visible Test Explorer tree");
    return tree;
  }
  // A row's point; the tree is scrolled with the mouse wheel when the row is outside the visible part.
  async function rowPoint(name, index = 0) {
    const finder = rowFinder(name, index);
    for (let attempt = 0; ; attempt++) {
      try { return await pointAt(finder, `${name} row`, 1000, { quiet: true }); }
      catch (error) {
        if (attempt === 16) { await dump(`${name} row`); throw error; }
      }
      const tree = await page(TREE_CENTRE);
      if (!tree) continue;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...tree, deltaX: 0, deltaY: attempt < 8 ? 200 : -200 }, cdp.pageSession);
      evidence.push({ action: "wheel", target: "Test Explorer tree", deltaY: attempt < 8 ? 200 : -200 });
      await sleep(200);
    }
  }
  // Every row label of the tree, collected while the list is scrolled from top to bottom with the
  // mouse wheel (the list renders only the rows in view).
  async function allRowLabels() {
    const visible = () => page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].filter(row => row.getClientRects().length)
      .map(row => row.getAttribute('aria-label') || '')`);
    for (let step = 0; step < 10; step++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...await treeCentre(), deltaX: 0, deltaY: -1000 }, cdp.pageSession);
    }
    await sleep(200);
    const labels = new Set();
    for (let unchanged = 0, previous = ""; unchanged < 2;) {
      const rows = await visible();
      rows.forEach(label => labels.add(label));
      const key = rows.join("\n");
      unchanged = key === previous ? unchanged + 1 : 0;
      previous = key;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...await treeCentre(), deltaX: 0, deltaY: 300 }, cdp.pageSession);
      await sleep(150);
    }
    evidence.push({ action: "wheel through the whole Test Explorer tree", rows: labels.size });
    return [...labels];
  }
  const hasRow = (labels, name) => labels.some(label => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(|,|$)`, "u").test(label));
  async function rowState(name, state, index = 0, timeoutMs = 60000) {
    const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${state}\\)`, "u");
    try {
      await until(async () => pattern.test(await rowLabel(name, index) || ""), `${name} row shows ${state}`, timeoutMs);
    } catch (error) {
      await dump(`${name} ${state}`);
      throw error;
    }
    const label = await rowLabel(name, index);
    evidence.push({ visibleState: label });
    return label;
  }
  // A suite row expanded with a click on its twistie (a click on the row itself only selects it).
  async function expandRow(suiteLabel) {
    await rowPoint(suiteLabel);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const expanded = await page(`(() => { const row = (${rowFinder(suiteLabel)})(); return row && row.getAttribute('aria-expanded'); })()`);
      if (expanded === "true") return;
      await click(await pointAt(`() => (${rowFinder(suiteLabel)})()?.querySelector('.monaco-tl-twistie')`, `${suiteLabel} twistie`),
        `${suiteLabel} suite row: expand`);
      await sleep(300);
    }
    throw new Error(`${suiteLabel} did not expand.`);
  }
  // The row of a test or suite: each collapsed row above it (directory suites, then its suite) is
  // expanded with a click first.
  async function showRow(name, suiteLabel, index = 0) {
    if (await page(`Boolean((${rowFinder(name, index)})())`)) return rowPoint(name, index);
    const target = allItems().filter(item => item.label === name)[index] || allItems().find(item => item.label === suiteLabel);
    for (const label of ancestorLabels(target)) {
      if (await page(`Boolean((${rowFinder(name, index)})())`)) break;
      await rowPoint(label);
      if (await page(`(${rowFinder(label)})().getAttribute('aria-expanded') === 'false'`)) {
        await click(await rowPoint(label), `${label} row (expand)`);
      }
    }
    return rowPoint(name, index);
  }
  async function rowAction(name, action, index = 0) {
    const row = await rowPoint(name, index);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
    await sleep(150);
    const point = await pointAt(`() => { const row = (${rowFinder(name, index)})();
      return row && [...row.querySelectorAll('.action-label')].find(action =>
        (action.getAttribute('aria-label') || action.title || '').startsWith(${JSON.stringify(action)})); }`, `${name} ${action} action`);
    await click(point, `${name}${index ? ` #${index + 1}` : ""} row: ${action}`);
  }
  // The Testing view in the side bar, opened with its activity bar icon. A click on the icon of the
  // view already shown would close the side bar, so the side bar's title decides, not the tree
  // (which is briefly empty while a refresh replaces its items).
  async function showTesting() {
    const shown = () => page(`(() => { const bar = document.querySelector('.part.sidebar');
      return Boolean(bar && bar.getClientRects().length && /^Testing/i.test(bar.querySelector('.title-label')?.textContent.trim() || '')); })()`);
    if (await shown()) {
      await until(() => page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`),
        "Testing view tree");
      return;
    }
    await click(await pointAt(`() => [...document.querySelectorAll('.activitybar .action-label')]
      .find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))`, "Testing activity bar icon"), "Testing activity bar icon");
    await until(() => page(`Boolean([...document.querySelectorAll('.test-explorer-tree')].find(e => e.getClientRects().length))`),
      "Testing view shown");
  }
  // The Testing view's Refresh Tests title action.
  async function clickRefresh() {
    await showTesting();
    const before = tests.queue;
    await click(await pointAt(`() => [...document.querySelectorAll('.action-label')].find(a => a.getClientRects().length &&
      /^Refresh Tests/.test(a.getAttribute('aria-label') || a.title || ''))`, "Refresh Tests action"), "Testing view: Refresh Tests");
    await until(() => tests.queue !== before, "refresh started", 5000);
    await tests.queue;
  }
  // The text of the notification center's list, opened with a click on the status bar bell (stays until closed).
  async function notificationCenter() {
    const visible = () => page(`Boolean([...document.querySelectorAll('.notifications-center')].find(e => e.getClientRects().length))`);
    if (!await visible()) {
      await click(await pointAt(`() => document.getElementById('status.notifications')`, "notifications bell"), "status bar notifications bell");
      await until(visible, "notification center open");
    }
    const text = await page(`[...document.querySelectorAll('.notifications-center .notification-list-item')].map(e => e.innerText).join('\\n')`);
    await click(await pointAt(`() => document.getElementById('status.notifications')`, "notifications bell"), "status bar notifications bell (close)");
    return text;
  }
  async function settle() {
    await language.queue;
    await debug.statusQueue;
    await tests.queue;
  }
  // Changes only the settings whose folder value differs, so an unchanged provider keeps its process.
  async function configure({ languageBackend, executionBackend, discoveryBackend, mode = "owned" }) {
    const values = mode === "coexistence"
      ? { integrationMode: mode, languageBackend, executionBackend, discoveryBackend }
      : { languageBackend, executionBackend, discoveryBackend, integrationMode: mode };
    for (const [name, value] of Object.entries(values)) {
      const current = vscode.workspace.getConfiguration("robotCompanion", folder.uri).inspect(name)?.workspaceFolderValue;
      if (JSON.stringify(current) !== JSON.stringify(value)) await config.update(name, value, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await settle();
    noteRobotCode();
  }
  // Native language with native debug + discovery: the configuration under test.
  async function configureNative() {
    await configure({ languageBackend: descriptors.language, executionBackend: descriptors.execution });
    if (tests.roots.get(folder.uri.toString())?.session?.state !== "running") await clickRefresh();
    await until(() => itemById(namesUri)?.children.size === 5, "native discovery of the fixture", 30000);
  }
  // No RobotCode process of this run while native mode is under test.
  function noteRobotCode() {
    const found = processes().filter(item => item.kind === "robotcode");
    if (found.length) robotCodeSeen.push(...found);
  }
  const runResults = () => new Map((tests.lastRun || []).map(entry => [entry.id, entry]));
  // Robot's suite name of the integration-native-discovery folder (no prefix, all lower case: title-cased).
  const directoryLabel = "Integration-Native-Discovery";
  // Every item of the controller (directory suites, file suites, tests, error items), depth first.
  function allItems() {
    const found = [];
    const visit = item => { found.push(item); item.children.forEach(visit); };
    tests.controller?.items.forEach(visit);
    return found;
  }
  const itemById = itemId => allItems().find(item => item.id === itemId);
  // Labels of the rows above an item, outermost first.
  function ancestorLabels(item) {
    const labels = [];
    for (let parent = item?.parent; parent; parent = parent.parent) labels.unshift(parent.label);
    return labels;
  }
  // The selected tests a Robot run was given: [source, name line] pairs from its selection file.
  const selectionOf = runDir => JSON.parse(fs.readFileSync(path.join(runDir, "selection.json"), "utf8")).tests;
  // The controller's items as plain data, error items apart.
  function controllerTree() {
    const suites = [], errors = [];
    const visit = item => {
      if (item.id.startsWith("discovery-error:")) { errors.push({ id: item.id, label: item.label, error: item.error }); return; }
      if (!item.uri) { item.children.forEach(visit); return; } // A directory suite.
      const children = [];
      item.children.forEach(child => children.push({ id: child.id, label: child.label, uri: child.uri.toString(),
        range: [child.range.start.line, child.range.start.character, child.range.end.line, child.range.end.character],
        tags: child.tags.map(tag => tag.id) }));
      suites.push({ id: item.id, label: item.label, uri: item.uri.toString(), parents: ancestorLabels(item),
        range: [item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character], children });
    };
    tests.controller.items.forEach(visit);
    return { suites: suites.sort((a, b) => a.id.localeCompare(b.id)), errors };
  }
  // The same workspace asked directly: a separate `robot-companion-backend discovery` process.
  async function backendTree() {
    const { LspSession } = require(path.join(extension.extensionPath, "src/integration/lsp-session"));
    const discovery = require(path.join(extension.extensionPath, "src/integration/test-discovery"));
    const session = new LspSession({ service: "discovery" });
    try {
      await session.start(descriptors.discoveryOnly, true);
      const workspaceUri = folder.uri.toString();
      const result = await session.request(discovery.DISCOVERY_METHOD, { workspaceUri });
      const suites = discovery.normalizeDiscovery(result, workspaceUri).map(suite => ({ id: suite.id, label: suite.label, uri: suite.uri,
        parents: suite.parents.map(parent => parent.label),
        range: [suite.range.start.line, suite.range.start.character, suite.range.end.line, suite.range.end.character],
        children: suite.children.map(test => ({ id: test.id, label: test.label, uri: test.uri,
          range: [test.range.start.line, test.range.start.character, test.range.end.line, test.range.end.character], tags: test.tags })) }));
      return { suites: suites.sort((a, b) => a.id.localeCompare(b.id)), errors: discovery.normalizeDiscoveryErrors(result, workspaceUri) };
    } finally { await session.stop(); }
  }
  // Run and Debug's start button with a native launch configuration: one Robot run to its end.
  async function runAndDebugLaunch(label) {
    await vscode.window.showTextDocument(vscode.Uri.parse(tasksUri), { preview: false });
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
    const ended = new Promise(resolve => {
      const listener = debug.onDidFinishRun(result => {
        if (result.session.configuration.name === launchName) { listener.dispose(); resolve(result); }
      });
    });
    await click(await pointAt(`() => document.querySelector('.start-debug-action-item .codicon-debug-start')`, "Run and Debug start"),
      `Run and Debug start button (${label})`);
    const session = await started;
    const entry = debug.sessions.get(session.id);
    assert.equal(entry.adapter.backendId, "robot-companion-native", "native debugging");
    const finished = await ended;
    const xml = fs.readFileSync(path.join(finished.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tasks<\/stat>/);
    await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "native launch ended without processes", 15000);
    await showTesting();
    return { backend: entry.adapter.backendId, outputDir: finished.outputDir, stat: "1 PASS" };
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    assert.ok(process.env.ROBOT_COMPANION_UI_USER_DATA_DIR, "run through tests/ui/run-ui-tests.js: its profile directory marks this run's processes");
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    api = activatedExtensionApi(extension.extensionPath);
    tests = api.getTestWorkspaceForTest();
    debug = api.getDebugWorkspaceForTest();
    language = api.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    fixtureRoot = path.join(folder.uri.fsPath, "integration-native-discovery");
    tasksUri = vscode.Uri.file(fixtureFile("native_tasks.robot")).toString();
    namesUri = vscode.Uri.file(fixtureFile("nested/native_names.robot")).toString();
    waitsUri = vscode.Uri.file(fixtureFile("native_waits.robot")).toString();
    for (const absent of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(absent), undefined, `${absent} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.rmSync(readyFlag(), { force: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    cdp = await WebviewCdp.connect();
    const native = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const base = { workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable };
    const plain = value => JSON.parse(JSON.stringify(value));
    descriptors = {
      language: plain(native.nativeDescriptor({ ...base, services: ["language"] })),
      execution: plain(native.nativeDescriptor({ ...base, services: ["debug", "discovery"] })),
      debugOnly: plain(native.nativeDescriptor({ ...base, services: ["debug"] })),
      discoveryOnly: plain(native.nativeDescriptor({ ...base, services: ["discovery"] }))
    };
    // Robot runs use the native venv's own Robot Framework: no RobotCode environment is involved.
    const robot = path.join(path.dirname(nativeExecutable), "robot");
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", robot, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName, target: "${workspaceFolder}/integration-native-discovery/native_tasks.robot",
      args: ["--test", "Archive Reports"]
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    const viewport = await page(`({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "native discovery checks run at 1280x900");
    // The native venv: no RobotCode package (pip and the backend's own doctor).
    const python = path.join(path.dirname(nativeExecutable), "python");
    const packages = JSON.parse(execFileSync(python, ["-m", "pip", "list", "--format", "json"], { encoding: "utf8",
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } }));
    assert.deepEqual(packages.filter(item => /robotcode/i.test(item.name)), [], "no RobotCode package in the native venv");
    const doctor = JSON.parse(execFileSync(nativeExecutable, ["doctor"], { encoding: "utf8" }));
    assert.equal(doctor.robotcodePresent, false);
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, viewport, nativeExecutable, robot,
      venvPackages: packages.map(item => `${item.name}==${item.version}`).sort(), doctor: { robotcodePresent: doctor.robotcodePresent },
      externalExtensions: "RobotCode, Python, debugpy and Robocorp extensions absent" });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") await dump(`failed ${this.currentTest.title.slice(0, 40)}`);
    for (const { session } of [...(debug?.sessions.values() || [])]) await vscode.debug.stopDebugging(session);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.commands.executeCommand("notifications.clearAll");
  });
  suiteTeardown(async () => {
    if (!extension) return;
    await until(() => runProcesses().length === 0, "this suite's run processes gone", 10000).catch(() => {
      const leftover = runProcesses();
      evidence.push({ cleanup: "run processes still present at suite end; killed", leftover });
      for (const item of leftover) { try { process.kill(item.pid, "SIGKILL"); } catch { /* Already gone. */ } }
    });
    await vscode.commands.executeCommand("testing.clearTestResults");
    await vscode.commands.executeCommand("notifications.clearAll");
    for (const name of ["nested/native.ready", "added_suite.robot", "renamed_suite.robot", "broken_suite.robot"]) {
      fs.rmSync(fixtureFile(name), { force: true });
    }
    await configure({ mode: "coexistence" });
    await config.update("nativeBackendExecutable", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-discovery-ui-actions.json"),
      JSON.stringify({ evidence, robotCodeSeen }, null, 2));
    cdp?.close();
  });

  test("owned editor Run entrypoints use native Test Results, exact selected tests and current-file suites", async function () {
    this.timeout(180000);
    await configureNative();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, cdp.pageSession);
    const main = fixtureFile("editor_entrypoints.robot"), other = fixtureFile("editor_suite.robot");
    const runFeature = require(path.join(extension.extensionPath, "src/features/run")).__test__;
    const legacyBefore = runFeature.getLastRunOutputForTest();
    const toml = path.join(folder.uri.fsPath, "robot.toml");
    const priorToml = fs.existsSync(toml) ? fs.readFileSync(toml) : undefined;
    fs.writeFileSync(toml, "[tool.robotcode-analyze]\nload_library_timeout=3000\n# ignored legacy analysis settings\n");
    fs.writeFileSync(main, "*** Variables ***\n${ENV}    stage\n\n*** Test Cases ***\nPassing ${ENV}\n    Log    selected pass\n\nFailing Selected\n    Fail    Selected failure\n\nNever Selected\n    Fail    Neighbour must never run.\n");
    fs.writeFileSync(other, "*** Test Cases ***\nSuite One\n    No Operation\n\nSuite Two\n    No Operation\n");
    const menuFinder = `(() => { const all = root => [...root.querySelectorAll('.action-label'), ...[...root.querySelectorAll('*')].flatMap(e => e.shadowRoot ? all(e.shadowRoot) : [])]; return all(document); })()`;
    const open = async (file, line) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line - 1, 4, line - 1, 4) });
      await sleep(600);
      return document;
    };
    const finished = async (names, statuses) => {
      await until(() => tests.lastRun?.length === names.length && tests.executions.size === 0 && tests.active.size === 0,
        "native editor run results", 30000);
      assert.deepEqual(tests.lastRun.map(test => test.id.split("::").at(-1)), names);
      assert.deepEqual(tests.lastRun.map(test => test.robotStatus), statuses);
      const runDir = tests.lastRun[0].runDir;
      const selection = selectionOf(runDir);
      const xml = fs.readFileSync(path.join(tests.lastRun[0].outputDir, "output.xml"), "utf8");
      assert.doesNotMatch(xml, /Neighbour must never run/);
      assert.equal(runFeature.getLastRunOutputForTest(), legacyBefore,
        "owned editor runs never invoke the legacy output runner");
      await until(() => runProcesses().length === 0, "owned editor Robot processes gone", 10000);
      await until(() => page("![...document.querySelectorAll('.notification-toast')].some(e=>e.getClientRects().length && /Robot Companion: locating/.test(e.innerText))"),
        "locating progress is absent after native run completion", 5000);
      evidence.push({ result: "owned editor native run", tests: tests.lastRun, selection });
      return selection;
    };
    const menu = async (marker, command) => {
      const finder = `() => [...document.querySelectorAll('.monaco-editor .view-lines .view-line')].find(e => e.getClientRects().length && e.innerText.replaceAll('\\u00a0',' ').includes(${JSON.stringify(marker)}))`;
      await click(await pointAt(finder, marker), `source ${marker}`, { button: "right" });
      await until(() => page(`${menuFinder}.some(e=>e.getClientRects().length && e.innerText===${JSON.stringify(command)})`), `${command} editor menu`);
      await screenshot(`owned-${command.replaceAll(" ", "-").toLowerCase()}-menu`);
      await click(await pointAt(`() => ${menuFinder}.find(e=>e.getClientRects().length && e.innerText===${JSON.stringify(command)})`, command), command);
    };
    try {
      const document = await open(main, 6);
      assert.equal(itemById(document.uri.toString()), undefined, "the new file has no cached Test Explorer suite yet");
      const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", document.uri);
      const passLens = lenses.find(lens => lens.command?.command === "robotCompanion.runTest");
      assert.deepEqual(passLens.command.arguments, [document.uri.toString(), "Passing ${ENV}", 5]);
      tests.lastRun = undefined;
      await click(await pointAt(`() => [...document.querySelectorAll('.codelens-decoration a')].find(e=>e.getClientRects().length && e.innerText==='Run Test')`, "Passing raw-variable Run Test CodeLens"), "Passing ${ENV} Run Test CodeLens");
      assert.deepEqual(await finished(["Passing stage"], ["PASS"]), [[main, 5, "Passing stage"]]);
      await vscode.commands.executeCommand("workbench.panel.testResults.view.focus");
      const passedView = await page("document.body.innerText");
      assert.match(passedView, /Test Results/);
      await screenshot("owned-codelens-native-test-results-passed");
      await open(main, 9); tests.lastRun = undefined;
      await menu("Selected failure", "Run Test at Cursor");
      assert.deepEqual(await finished(["Failing Selected"], ["FAIL"]), [[main, 8, "Failing Selected"]]);
      await vscode.commands.executeCommand("workbench.panel.testResults.view.focus");
      await screenshot("owned-context-native-test-results-failed");
      await open(other, 3); tests.lastRun = undefined;
      await menu("No Operation", "Run Suite");
      assert.deepEqual(await finished(["Suite One", "Suite Two"], ["PASS", "PASS"]), [[other, 2, "Suite One"], [other, 5, "Suite Two"]]);
      await screenshot("owned-current-file-suite-native-results");
      await open(main, 6); tests.lastRun = undefined;
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(main), new vscode.Position(5, 0)))]);
      await menu("selected pass", "Debug Test at Cursor");
      await until(() => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame &&
        vscode.window.activeTextEditor?.document.uri.fsPath === main && vscode.window.activeTextEditor.selection.active.line === 5,
      "native debug paused at selected test", 30000);
      await until(() => page("![...document.querySelectorAll('.notification-toast')].some(e=>e.getClientRects().length && /Robot Companion: locating/.test(e.innerText))"),
        "locating progress is absent while native debug is paused", 5000);
      evidence.push({ result: "native paused debug has no locating progress notification" });
      await screenshot("owned-debug-paused-without-locating-progress");
      await key("F5", "F5", 116);
      assert.deepEqual(await finished(["Passing stage"], ["PASS"]), [[main, 5, "Passing stage"]]);
    } finally {
      fs.rmSync(main, { force: true }); fs.rmSync(other, { force: true });
      if (priorToml) fs.writeFileSync(toml, priorToml); else fs.rmSync(toml, { force: true });
    }
  });

  test("Test Explorer shows exactly the native backend's suites and tests; go to source opens each test's name line; no RobotCode is involved", async function () {
    this.timeout(180000);
    await configureNative();
    const root = tests.roots.get(folder.uri.toString());
    assert.equal(root.setting, "executionBackend");
    assert.equal(root.provider, NATIVE);
    assert.equal(root.session.constructor.name, "LspSession", "the native service speaks discovery API v1 itself (no bridge)");
    const expected = await backendTree();
    const shown = controllerTree();
    assert.deepEqual(shown.suites, expected.suites, "the controller's suites and tests are exactly the backend's");
    // The backend's errors (two synthetic files with an empty test) are visible error items next to the tree.
    assert.deepEqual(shown.errors.map(item => item.label).sort(), expected.errors.map(error =>
      `${path.relative(folder.uri.fsPath, vscode.Uri.parse(error.uri).fsPath)}: discovery error (line ${error.range.start.line + 1})`).sort());
    assert.ok(expected.errors.length >= 1, "the UI workspace has files the backend reports as discovery errors");
    const names = shown.suites.find(suite => suite.id === namesUri);
    assert.deepEqual(names.children.map(test => [test.id.slice(namesUri.length), test.range[0]]), [
      ["::Grüße aus Köln 🎉 und 𝄞", 8], ["::Duplicate Name", 11], ["::Duplicate Name#2", 14], ["::Needs Ready Flag", 17], ["::Login On staging", 20]]);
    assert.deepEqual(shown.suites.find(suite => suite.id === tasksUri).children.map(test => test.label), ["Archive Reports", "Notify Team ✉"]);
    // Processes: native language and discovery, never RobotCode.
    const running = processes();
    assert.ok(running.some(item => item.kind === "native-discovery") && running.some(item => item.kind === "native-language"),
      JSON.stringify(running));
    assert.deepEqual(running.filter(item => item.kind === "robotcode"), [], "no robotcode process");
    // The provider status names the native discovery source (Details: Show Language Service Status).
    const status = api.getProviderStatusForTest();
    await vscode.window.showTextDocument(vscode.Uri.parse(namesUri), { preview: false });
    assert.equal(status.items.discovery.text, `Tests: ${NATIVE}`);
    await vscode.commands.executeCommand("robotCompanion.showLanguageServiceStatus");
    // The Output view wraps long lines, so the text is compared without whitespace.
    let output;
    await until(async () => /Tests:Nativebackend0\.1\.0\.dev8—TestExplorerdiscovery;discoveryserviceofrobotCompanion\.executionBackend;\d+testsin\d+suites,\d+discoveryerrors?\(shownaserroritemsinTestExplorer\);RunusestheRobotenvironmentofRunTest\(robotCompanion\.robotCommandwhenset\);DebugTestusesrobotCompanion\.executionBackend/
      .test((output = await page(`[...document.querySelectorAll('.part.panel .monaco-editor .view-lines')]
        .map(e => e.innerText.replaceAll('\\u00a0', ' ')).join('\\n')`)).replace(/\s+/g, "")), "Tests status line in Output", 10000)
      .catch(error => { throw new Error(`${error.message}: ${output}`); });
    await screenshot("status-details");
    evidence.push({ result: "tree equals the backend's", suites: shown.suites.length, tests: shown.suites.reduce((n, s) => n + s.children.length, 0),
      errors: shown.errors, processes: running, status: output.replace(/\s+/g, " ").match(/Tests: Native backend[^[]*/)?.[0] });

    // The tree as a person sees it: expand the suites, then each test row is there, nested one level below its suite.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showTesting();
    await showRow("Archive Reports", "Native Tasks");
    await showRow("Grüße aus Köln 🎉 und 𝄞", "Native Names");
    const rows = await page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].filter(row => row.getClientRects().length)
      .map(row => ({ label: row.getAttribute('aria-label'), level: row.getAttribute('aria-level') }))`);
    const levelOf = name => rows.filter(row => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(|,|$)`, "u").test(row.label || ""))
      .map(row => row.level);
    // Directory suites hold their file suites: integration-native-discovery/ (level 1), its file suite
    // Native Tasks and nested/ (level 2), nested/'s Native Names (level 3); tests one row below their suite.
    assert.deepEqual(names.parents, [directoryLabel, "Nested"]);
    assert.deepEqual(levelOf(directoryLabel), ["1"], "the fixture folder is a top-level directory suite row");
    assert.deepEqual([levelOf("Native Tasks"), levelOf("Nested"), levelOf("Native Names")], [["2"], ["2"], ["3"]]);
    for (const name of ["Archive Reports", "Notify Team ✉"]) assert.deepEqual(levelOf(name), ["3"], `${name} is one row below its suite`);
    for (const name of ["Grüße aus Köln 🎉 und 𝄞", "Needs Ready Flag", "Login On staging"]) {
      assert.deepEqual(levelOf(name), ["4"], `${name} is one row below its suite`);
    }
    assert.deepEqual(levelOf("Duplicate Name"), ["4", "4"], "both Duplicate Name tests are separate rows");
    assert.ok(rows.some(row => /discovery error \(line \d+\)/.test(row.label || "")), "a discovery error row is visible");
    await screenshot("tree");
    evidence.push({ visibleRows: rows });

    // Go to source: the second Duplicate Name and the non-BMP test open at their name lines.
    for (const [name, index, line] of [["Duplicate Name", 1, 14], ["Grüße aus Köln 🎉 und 𝄞", 0, 8], ["Archive Reports", 0, 5]]) {
      const uri = name === "Archive Reports" ? tasksUri : namesUri;
      const written = (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText().split(/\r?\n/)
        .flatMap((text, number) => text.startsWith(name) ? [number] : []);
      assert.equal(written[index], line, `${name} #${index + 1} is written on line ${line + 1}`);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await showTesting();
      const opened = () => vscode.window.activeTextEditor?.document.uri.toString() === uri &&
        vscode.window.activeTextEditor.selection.active.line === line;
      const row = await rowPoint(name, index);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
      await sleep(150);
      // The row's context menu offers Go to Test where VS Code has it; otherwise a click on the row opens the source.
      await click(row, `${name}${index ? ` #${index + 1}` : ""} row`, { button: "right" });
      const menuItem = `() => [...document.querySelectorAll('.monaco-menu .action-item .action-label')].find(a => a.getClientRects().length &&
        /^Go to Test/.test((a.getAttribute('aria-label') || a.textContent || '').trim()))`;
      let route, goTo;
      try { goTo = await pointAt(menuItem, "Go to Test menu item", 2000, { quiet: true }); } catch { goTo = undefined; }
      if (goTo) {
        route = "context menu: Go to Test";
        await click(goTo, `${name}${index ? ` #${index + 1}` : ""} context menu: Go to Test`);
        await until(opened, `${name} opens at line ${line + 1}`, 10000);
      } else {
        await key("Escape", "Escape", 27);
        route = "row click";
        await click(row, `${name}${index ? ` #${index + 1}` : ""} row`);
        try { await until(opened, "single click opens the test's source", 3000); }
        catch {
          route = "row double-click";
          await click(await rowPoint(name, index), `${name}${index ? ` #${index + 1}` : ""} row`, { clickCount: 2 });
          await until(opened, "double click opens the test's source");
        }
      }
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.lineAt(line).text.startsWith(name), true);
      await screenshot(`go-to-source-${line + 1}`);
      evidence.push({ result: "go to source", test: name, occurrence: index + 1, route, uri, line: line + 1,
        column: editor.selection.active.character + 1 });
    }
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process during native discovery");
  });

  test("Run: multi-selection runs exactly the selected tests and tasks; Rerun Failed; a suite node; each duplicate reports its own result", async function () {
    this.timeout(300000);
    await configureNative();
    fs.rmSync(readyFlag(), { force: true });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showTesting();
    await showRow("Archive Reports", "Native Tasks");
    await showRow("Grüße aus Köln 🎉 und 𝄞", "Native Names");
    await click(await rowPoint("Grüße aus Köln 🎉 und 𝄞"), "Grüße aus Köln 🎉 und 𝄞 row");
    await click(await rowPoint("Needs Ready Flag"), "Needs Ready Flag row", { modifiers: 2 });
    await click(await rowPoint("Archive Reports"), "Archive Reports row", { modifiers: 2 });
    const selected = await page(`[...document.querySelectorAll('.test-explorer-tree .monaco-list-row.selected')].map(row => row.getAttribute('aria-label'))`);
    assert.equal(selected.length, 3, `three selected rows: ${selected}`);
    await screenshot("multi-selection");
    tests.lastRun = undefined;
    await rowAction("Archive Reports", "Run Test");
    await until(() => tests.lastRun?.length === 3, "three selected tests reported", 90000);
    let results = runResults();
    const greeting = results.get(id(namesUri, "Grüße aus Köln 🎉 und 𝄞")), ready = results.get(id(namesUri, "Needs Ready Flag"));
    const archive = results.get(id(tasksUri, "Archive Reports"));
    assert.deepEqual([greeting.robotStatus, ready.robotStatus, archive.robotStatus], ["PASS", "FAIL", "PASS"]);
    for (const entry of [greeting, ready, archive]) assert.equal(entry.source, "output.xml");
    // Robot runs tests and tasks only in separate runs: one run of the workspace folder per mode.
    assert.equal(greeting.outputDir, ready.outputDir, "one Robot run for the selected tests");
    assert.notEqual(greeting.outputDir, archive.outputDir, "a separate Robot run for the selected task");
    for (const entry of [greeting, archive]) {
      assert.deepEqual(entry.args.slice(-3), ["--argumentfile", path.join(entry.runDir, "arguments.txt"), folder.uri.fsPath]);
    }
    assert.deepEqual(selectionOf(greeting.runDir), [[fixtureFile("nested/native_names.robot"), 9, "Grüße aus Köln 🎉 und 𝄞"],
      [fixtureFile("nested/native_names.robot"), 18, "Needs Ready Flag"]], "exactly the selected tests");
    assert.deepEqual(selectionOf(archive.runDir), [[fixtureFile("native_tasks.robot"), 6, "Archive Reports"]], "exactly the selected task");
    const namesXml = fs.readFileSync(path.join(greeting.outputDir, "output.xml"), "utf8");
    const tasksXml = fs.readFileSync(path.join(archive.outputDir, "output.xml"), "utf8");
    assert.match(namesXml, /generator="Robot 7\.5/);
    assert.match(namesXml, /<stat pass="1" fail="1" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(namesXml, /Duplicate Name|Login On|Archive/);
    assert.match(tasksXml, /<stat pass="1" fail="0" skip="0">All Tasks<\/stat>/);
    assert.doesNotMatch(tasksXml, /Notify Team/);
    assert.match(ready.message, /^File '.*native\.ready' does not exist\.$/);
    await rowState("Grüße aus Köln 🎉 und 𝄞", "Passed");
    await rowState("Needs Ready Flag", "Failed");
    await rowState("Archive Reports", "Passed");
    await rowPoint("Notify Team ✉");
    assert.doesNotMatch(await rowLabel("Notify Team ✉"), /Passed|Failed/, "an unselected task has no result");
    await screenshot("multi-selection-results");
    evidence.push({ result: "multi-selection run", runs: { tests: greeting.outputDir, tasks: archive.outputDir },
      statuses: [...results.values()].map(entry => `${entry.id.split("/").pop()}: ${entry.robotStatus}`), failure: ready.message });

    // Rerun Failed Tests from the Test Results view.
    fs.writeFileSync(readyFlag(), "ready\n");
    tests.lastRun = undefined;
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
    assert.equal(rerun.id, id(namesUri, "Needs Ready Flag"));
    assert.equal(rerun.robotStatus, "PASS");
    const rerunXml = fs.readFileSync(path.join(rerun.outputDir, "output.xml"), "utf8");
    assert.match(rerunXml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.doesNotMatch(rerunXml, /Grüße|Archive/);
    await showTesting();
    await rowState("Needs Ready Flag", "Passed");
    await screenshot("rerun-failed");
    evidence.push({ result: "rerun failed", id: rerun.id, robotStatus: rerun.robotStatus, outputDir: rerun.outputDir });

    // Run on the suite node: one unfiltered Robot run; each Duplicate Name gets its own occurrence's result.
    tests.lastRun = undefined;
    await rowAction("Native Names", "Run Test");
    await until(() => tests.lastRun?.length === 5, "five suite tests reported", 90000);
    results = runResults();
    assert.deepEqual(Object.fromEntries([...results.values()].map(entry => [entry.id.slice(namesUri.length), entry.robotStatus])), {
      "::Grüße aus Köln 🎉 und 𝄞": "PASS", "::Duplicate Name": "PASS", "::Duplicate Name#2": "FAIL", "::Needs Ready Flag": "PASS",
      "::Login On staging": "PASS" });
    assert.equal(results.get(id(namesUri, "Duplicate Name#2")).message, "second occurrence fails");
    assert.equal(new Set([...results.values()].map(entry => entry.outputDir)).size, 1, "one Robot run");
    assert.deepEqual(selectionOf(tests.lastRun[0].runDir).map(([source, line, name]) => [path.basename(source), line, name]),
      [[9, "Grüße aus Köln 🎉 und 𝄞"], [12, "Duplicate Name"], [15, "Duplicate Name"], [18, "Needs Ready Flag"], [21, "Login On staging"]]
        .map(([line, name]) => ["native_names.robot", line, name]), "the suite node selects every test of the suite");
    const suiteXml = fs.readFileSync(path.join(tests.lastRun[0].outputDir, "output.xml"), "utf8");
    assert.match(suiteXml, /<stat pass="4" fail="1" skip="0">All Tests<\/stat>/);
    await showTesting();
    await rowState("Duplicate Name", "Passed", 0);
    await rowState("Duplicate Name", "Failed", 1);
    await rowState("Native Names", "Failed");
    await screenshot("suite-run");
    evidence.push({ result: "suite node run", outputDir: tests.lastRun[0].outputDir,
      statuses: [...results.values()].map(entry => `${entry.id.split("::")[1]}: ${entry.robotStatus}`) });

    // Only the second Duplicate Name: selected by its name line, it runs alone and reports its own entry.
    // Clear the shown results, so each state below comes from the new run.
    await vscode.commands.executeCommand("testing.clearTestResults");
    await click(await rowPoint("Duplicate Name", 1), "Duplicate Name #2 row");
    tests.lastRun = undefined;
    await rowAction("Duplicate Name", "Run Test", 1);
    await until(() => tests.lastRun?.length === 1, "second duplicate reported", 60000);
    const [second] = tests.lastRun;
    assert.equal(second.id, id(namesUri, "Duplicate Name#2"));
    assert.equal(second.robotStatus, "FAIL");
    assert.equal(second.message, "second occurrence fails");
    assert.deepEqual(selectionOf(second.runDir), [[fixtureFile("nested/native_names.robot"), 15, "Duplicate Name"]]);
    assert.match(fs.readFileSync(path.join(second.outputDir, "output.xml"), "utf8"), /<stat pass="0" fail="1" skip="0">All Tests<\/stat>/,
      "the first Duplicate Name does not run");
    await rowState("Duplicate Name", "Failed", 1);
    evidence.push({ result: "second duplicate only", id: second.id, robotStatus: second.robotStatus, message: second.message,
      outputDir: second.outputDir });

    // A test whose name has a variable: selected by its name line, the result has the replaced name.
    await vscode.commands.executeCommand("testing.clearTestResults");
    await click(await rowPoint("Login On staging"), "Login On staging row");
    tests.lastRun = undefined;
    await rowAction("Login On staging", "Run Test");
    await until(() => tests.lastRun?.length === 1, "Login On staging reported", 60000);
    const [login] = tests.lastRun;
    assert.equal(login.id, id(namesUri, "Login On staging"));
    assert.equal(login.robotStatus, "PASS");
    assert.deepEqual(selectionOf(login.runDir), [[fixtureFile("nested/native_names.robot"), 21, "Login On staging"]],
      "its discovered name; Robot's model has Login On ${ENVIRONMENT}, which the modifier matches");
    assert.match(fs.readFileSync(path.join(login.outputDir, "output.xml"), "utf8"), /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    await rowState("Login On staging", "Passed");
    evidence.push({ result: "variable in the test name", id: login.id, robotStatus: login.robotStatus, selection: selectionOf(login.runDir) });
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process during native runs");
  });

  test("Stop ends the Robot run's process group; Debug Test uses native debugging, stops at its breakpoint, and Stop during it leaves no process", async function () {
    this.timeout(300000);
    await configureNative();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await showTesting();
    await showRow("Waits For Stop", "Native Waits");
    await click(await rowPoint("Waits For Stop"), "Waits For Stop row");
    tests.lastRun = undefined;
    await rowAction("Waits For Stop", "Run Test");
    let robot;
    await until(() => { robot = [...tests.active][0]; return robot?.pid && groupMembers(robot.pid).length >= 2; },
      "Robot and its child process running", 60000);
    const members = groupMembers(robot.pid);
    await screenshot("running");
    const stopped = Date.now();
    await click(await pointAt(`() => [...document.querySelectorAll('.action-label')]
      .find(a => a.getClientRects().length && /^Cancel Test Run/.test(a.getAttribute('aria-label') || a.title || ''))`, "Stop button"),
    "Test Explorer Stop (Cancel Test Run)");
    await until(() => tests.lastRun?.length === 1, "stopped run reported", 10000);
    await until(() => groupMembers(robot.pid).length === 0, "process group gone", 5000);
    const elapsed = Date.now() - stopped;
    assert.ok(elapsed < 5000, `stopped within 5 s (${elapsed} ms)`);
    assert.equal(tests.lastRun[0].status, "cancelled");
    assert.deepEqual(runProcesses(), [], "no Robot or child process left");
    await rowState("Waits For Stop", "Skipped");
    await screenshot("stopped");
    evidence.push({ result: "Stop", processGroup: robot.pid, membersBefore: members, membersAfter: groupMembers(robot.pid), elapsedMs: elapsed });

    // Debug Test with a gutter breakpoint on Login On staging's step.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(namesUri));
    const line = document.getText().split(/\r?\n/).indexOf("    Log    ${ENVIRONMENT}");
    assert.ok(line > 0);
    // The editor opens with that line in view (the panel below would otherwise hide it).
    await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
    for (let attempt = 1; !vscode.debug.breakpoints.some(b => b.location.range.start.line === line); attempt++) {
      let gutter, previous;
      await until(async () => {
        gutter = await page(`(() => {
          const editor = [...document.querySelectorAll('.monaco-editor')].find(e => e.closest('.editor-instance') &&
            e.querySelector('.view-lines')?.innerText.replaceAll('\\u00a0', ' ').includes('Log    \${ENVIRONMENT}'));
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
      await click(gutter, `breakpoint gutter native_names.robot line ${line + 1}`);
      await until(() => vscode.debug.breakpoints.length, "breakpoint from gutter click", 3000).catch(async error => {
        if (attempt === 3) { await dump("breakpoint gutter"); throw error; }
      });
      if (attempt === 3 && !vscode.debug.breakpoints.some(b => b.location.range.start.line === line)) throw new Error("gutter click missed");
    }
    // Close the editor, so the editor that opens at the breakpoint line shows where the run stopped.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("testing.clearTestResults");
    await showTesting();
    await showRow("Login On staging", "Native Names");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
      });
    });
    tests.lastRun = undefined;
    await rowAction("Login On staging", "Debug Test");
    const session = await started;
    const entry = debug.sessions.get(session.id);
    assert.equal(session.type, "robotcompanion");
    assert.equal(entry.adapter.backendId, "robot-companion-native", "Debug Test uses the native execution provider");
    assert.equal(session.configuration.args[0], "--argumentfile");
    assert.deepEqual(selectionOf(path.dirname(session.configuration.args[1])), [[fixtureFile("nested/native_names.robot"), 21, "Login On staging"]],
      "selected by its name line");
    assert.equal(session.configuration.target, folder.uri.fsPath, "Debug Test runs the workspace folder, with its init files");
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.toString() === namesUri && editor.selection.active.line === line &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, "paused at the breakpoint in Login On staging", 60000);
    await screenshot("debug-paused");
    const debugProcesses = runProcesses();
    assert.ok(debugProcesses.some(item => item.kind === "native-debug") && debugProcesses.some(item => item.kind === "native-worker"),
      `native debug processes: ${JSON.stringify(debugProcesses)}`);
    await key("F5", "F5", 116);
    await until(() => tests.lastRun?.length === 1, "Debug Test result", 60000);
    const [result] = tests.lastRun;
    assert.equal(result.id, id(namesUri, "Login On staging"));
    assert.equal(result.robotStatus, "PASS");
    assert.equal(result.source, "output.xml");
    const xml = fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8");
    assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
    assert.match(xml, /<test [^>]*name="Login On staging"/);
    await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "Debug Test processes gone", 15000);
    await showTesting();
    await rowState("Login On staging", "Passed");
    await screenshot("debug-passed");
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    evidence.push({ result: "Debug Test (native)", backend: entry.adapter.backendId, processesWhilePaused: debugProcesses.map(item => item.kind),
      robotStatus: result.robotStatus, outputDir: result.outputDir });

    // Stop (Testing Cancel Test Run) during a Debug Test waiting in its child process.
    await vscode.commands.executeCommand("testing.clearTestResults");
    await showRow("Waits For Stop", "Native Waits");
    tests.lastRun = undefined;
    await rowAction("Waits For Stop", "Debug Test");
    await until(() => runProcesses().some(item => item.kind === "sleep"), "debugged test waiting in sleep 300", 60000);
    await sleep(500);
    const before = runProcesses();
    const cancelled = Date.now();
    await showTesting();
    await click(await pointAt(`() => [...document.querySelectorAll('.action-label')]
      .find(a => a.getClientRects().length && /^Cancel Test Run/.test(a.getAttribute('aria-label') || a.title || ''))`, "Cancel Test Run button"),
    "Test Explorer Stop (Cancel Test Run) during Debug Test");
    try {
      await until(() => tests.lastRun?.length === 1 && runProcesses().length === 0 && debug.sessions.size === 0 && !vscode.debug.activeDebugSession,
        "debug run stopped and its processes gone", 15000);
    } catch (error) {
      evidence.push({ failure: "Stop during Debug Test", before, after: runProcesses(), lastRun: tests.lastRun });
      await dump("debug stop");
      throw error;
    }
    assert.equal(tests.lastRun[0].status, "cancelled");
    await rowState("Waits For Stop", "Skipped");
    await screenshot("debug-stopped");
    evidence.push({ result: "Stop during Debug Test", before: before.map(item => item.kind), after: runProcesses(), elapsedMs: Date.now() - cancelled });
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process during native debugging");
  });

  // A breakpoint set with a real click in the glyph margin of the editor showing `marker`, at 1-based `line`.
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
  // The session pauses at `file`:`line` (1-based): the editor shows that line and the top stack frame is there.
  async function pausedAt(session, file, line, label) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.fsPath === file && editor.selection.active.line === line - 1 &&
        vscode.debug.activeStackItem instanceof vscode.DebugStackFrame;
    }, `paused at ${label}`, 60000);
    const { stackFrames } = await session.customRequest("stackTrace", { threadId: vscode.debug.activeStackItem.threadId });
    assert.deepEqual([stackFrames[0].source?.path, stackFrames[0].line], [file, line], `top frame at ${label}`);
    evidence.push({ paused: label, frames: stackFrames.map(frame => `${frame.name} ${path.basename(frame.source?.path || "")}:${frame.line}`) });
  }

  // A point inside `text` on the visible editor line containing `lineText`, once it stays put (late CodeLenses shift lines).
  async function editorPoint(lineText, text) {
    let point, previous;
    await until(async () => {
      point = await page(`(() => {
        const line = [...document.querySelectorAll('.monaco-editor .view-line')]
          .find(el => el.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(lineText)}));
        if (!line) return;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          const start = node.textContent.replaceAll('\\u00a0', ' ').indexOf(${JSON.stringify(text)});
          if (start < 0) continue;
          const range = document.createRange(); range.setStart(node, start + 1); range.setEnd(node, start + 3);
          const rect = range.getBoundingClientRect();
          if (!rect.width || rect.top < 0 || rect.bottom > innerHeight) return;
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      })()`);
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
    }, `visible ${text} in the editor`);
    return point;
  }

  test("Project Robot configuration: robotArguments reach language, discovery, Run and Debug Test; Ctrl+click and F12 follow --pythonpath and --variablefile", async function () {
    this.timeout(300000);
    await configureNative();
    const projectRoot = path.join(folder.uri.fsPath, "integration-project-config");
    const suiteUri = vscode.Uri.file(path.join(projectRoot, "suites", "project_configured.robot")), suiteId = suiteUri.toString();
    const configuredArguments = ["--pythonpath", "integration-project-config/lib", "--variablefile",
      "integration-project-config/vars/env.py", "--variable", "ENV:prod"];
    const backendDiagnostics = () => vscode.languages.getDiagnostics(suiteUri).filter(item => item.source === "Robot Companion")
      .map(item => `${item.range.start.line + 1}: ${item.message}`);
    const discovered = name => itemById(suiteId)?.children.get(id(suiteId, name));
    const activeAt = (file, line, character) => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.fsPath === path.join(projectRoot, file) && editor.selection.active.line === line &&
        editor.selection.active.character === character;
    };
    try {
      // Without robotArguments Robot cannot import the library either; discovery keeps the written name.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await until(() => backendDiagnostics().includes("2: Library not resolved in this version: projectlib"),
        "unconfigured import diagnostic", 20000);
      await until(() => discovered("Check local on ${TARGET}"), "unconfigured discovered name", 20000);
      evidence.push({ projectConfiguration: "unset", diagnostics: backendDiagnostics(), discovered: "Check local on ${TARGET}" });

      // The folder's restricted robotArguments setting: language and discovery restart with it.
      await config.update("robotArguments", configuredArguments, vscode.ConfigurationTarget.WorkspaceFolder);
      await settle();
      const reported = language.roots.get(folder.uri.toString())?.session?.robotConfiguration;
      assert.deepEqual(reported, { version: 1, cwd: folder.uri.fsPath, pythonPath: [path.join(projectRoot, "lib")],
        variableFiles: [path.join(projectRoot, "vars", "env.py")], variables: ["${ENV}"], errors: [], projectFiles: [] });
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await until(() => backendDiagnostics().length === 0, "no import diagnostic with --pythonpath", 20000);
      await until(() => discovered("Check prod on staging") && !discovered("Check local on ${TARGET}"), "configured discovered name", 20000);
      await screenshot("project-config-editor");

      // Ctrl+click on the library keyword and F12 on the variable file's variable, with real input.
      await click(await editorPoint("Project Step", "Project Step"), "editor: Project Step", { modifiers: 2 }); // Linux Ctrl+click
      await until(() => activeAt(path.join("lib", "projectlib.py"), 0, 4), "Ctrl+click opens projectlib.py at project_step", 15000);
      await screenshot("project-config-ctrl-click");
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await click(await editorPoint("Log    ${TARGET}", "${TARGET}"), "editor: ${TARGET} in Log");
      await key("F12", "F12", 123);
      await until(() => activeAt(path.join("vars", "env.py"), 0, 0), "F12 opens env.py at TARGET", 15000);
      await screenshot("project-config-f12");
      evidence.push({ result: "project configuration navigation", reported, ctrlClick: "lib/projectlib.py:1:5", f12: "vars/env.py:1:1" });

      // Run Test and Debug Test from the configured item: Robot runs with the same arguments and reports that name.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await showTesting();
      await showRow("Check prod on staging", "Project Configured");
      tests.lastRun = undefined;
      await rowAction("Check prod on staging", "Run Test");
      await until(() => tests.lastRun?.length === 1, "Run Test result", 90000);
      let [result] = tests.lastRun;
      assert.deepEqual([result.id, result.robotStatus, result.source], [id(suiteId, "Check prod on staging"), "PASS", "output.xml"]);
      assert.deepEqual(result.args.slice(0, configuredArguments.length), configuredArguments, "Run passes robotArguments first");
      assert.match(fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8"), /<test [^>]*name="Check prod on staging"/);
      await rowState("Check prod on staging", "Passed");
      await vscode.commands.executeCommand("testing.clearTestResults");
      tests.lastRun = undefined;
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      await rowAction("Check prod on staging", "Debug Test");
      const session = await started;
      assert.equal(debug.sessions.get(session.id)?.adapter.backendId, "robot-companion-native");
      await until(() => tests.lastRun?.length === 1, "Debug Test result", 90000);
      [result] = tests.lastRun;
      assert.deepEqual([result.robotStatus, result.source], ["PASS", "output.xml"]);
      assert.match(fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8"), /<test [^>]*name="Check prod on staging"/);
      await rowState("Check prod on staging", "Passed");
      await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "Debug Test processes gone", 15000);
      await screenshot("project-config-results");
      evidence.push({ result: "project configuration Run and Debug Test", status: "PASS", name: "Check prod on staging" });
    } finally {
      await config.update("robotArguments", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await settle();
    }
    // Removing the setting restores the unconfigured behaviour in both services.
    await vscode.window.showTextDocument(suiteUri, { preview: false });
    await until(() => backendDiagnostics().includes("2: Library not resolved in this version: projectlib"),
      "import diagnostic again without robotArguments", 20000);
    await until(() => discovered("Check local on ${TARGET}"), "written name again without robotArguments", 20000);
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process with the project configuration");
  });

  test("robot.toml and Markdown sources: validation and help on robot.toml, Markdown lines in Problems, Ctrl+click and F12 in a .robot.md block, Test Explorer Run and Debug Test with robot.toml's settings, glyph-margin breakpoints in Markdown pause Debug Test", async function () {
    this.timeout(300000);
    await configureNative();
    const projectRoot = path.join(folder.uri.fsPath, "integration-project-files");
    const tomlPath = path.join(folder.uri.fsPath, "robot.toml");
    const tomlUri = vscode.Uri.file(tomlPath);
    const suiteUri = vscode.Uri.file(path.join(projectRoot, "markdown_login.robot.md")), suiteId = suiteUri.toString();
    const tomlArguments = ["--pythonpath", "integration-project-files/lib", "--variable", "ENV:staging"];
    const shown = uri => vscode.languages.getDiagnostics(uri).filter(item => item.source === "Robot Companion")
      .map(item => `${item.range.start.line + 1}:${item.range.start.character + 1}: ${item.message}`);
    const discovered = name => itemById(suiteId)?.children.get(id(suiteId, name));
    const activeAt = (file, line, character) => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.fsPath === path.join(projectRoot, file) && editor.selection.active.line === line &&
        editor.selection.active.character === character;
    };
    const reported = () => language.roots.get(folder.uri.toString())?.session?.robotConfiguration;
    try {
      // The project files appear on disk: the language service restarts with robot.toml, discovery reads it.
      fs.cpSync(path.join(extension.extensionPath, "tests/integration/fixtures/project-files"), projectRoot, { recursive: true });
      fs.copyFileSync(path.join(projectRoot, "robot.toml.txt"), tomlPath);
      await until(() => reported()?.projectFiles?.includes(tomlPath), "language service restarted with robot.toml", 30000);
      await settle();
      assert.deepEqual(reported().pythonPath, [path.join(projectRoot, "lib")]);
      assert.deepEqual(reported().variables, ["${ENV}"]);
      assert.deepEqual(reported().errors, ["robot.toml:3: 'output-dir' is a RobotCode setting Robot Companion does not apply " +
        "(it applies `python-path`, `variables`, `variable-files`, `extensions`, `args`); pass Robot options with 'args' instead."]);

      // robot.toml: its problem in Problems at its line, help on hover over a setting with the real pointer.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(tomlUri, { preview: false });
      await until(() => shown(tomlUri).some(line => line.startsWith("3:1: 'output-dir' is a RobotCode setting")),
        "robot.toml diagnostic", 20000);
      const hoverAt = await editorPoint('python-path = ["integration-project-files/lib"]', "python-path");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hoverAt }, cdp.pageSession);
      evidence.push({ action: "pointer rests", target: "robot.toml: python-path", point: hoverAt });
      let hoverText;
      await until(async () => {
        hoverText = await page(`[...document.querySelectorAll('.monaco-hover')].filter(e => e.getClientRects().length)
          .map(e => e.innerText).join('\\n')`);
        return /python-path · Applied by Robot Companion as --pythonpath/.test(hoverText);
      }, "robot.toml hover help", 15000);
      await screenshot("project-files-toml");
      evidence.push({ result: "robot.toml validation and help", problems: shown(tomlUri), hover: hoverText.slice(0, 200) });

      // The Markdown suite: Robot's diagnostic at the Markdown line and column, none for prose.
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await until(() => JSON.stringify(shown(suiteUri)) === JSON.stringify([
        "22:7: No keyword with name 'Markdown Missing Keyword' found."]), "Markdown diagnostic at its line", 20000);
      await screenshot("project-files-markdown-problems");
      // Ctrl+click a keyword of a Robot block: the Markdown resource opens at the keyword.
      await click(await editorPoint("    Markdown Shared Keyword", "Shared Keyword"), "editor: Markdown Shared Keyword", { modifiers: 2 });
      await until(() => activeAt("markdown_keywords.md", 4, 0), "Ctrl+click opens markdown_keywords.md:5:1", 15000);
      await screenshot("project-files-markdown-ctrl-click");
      // F12 on a library keyword found only through robot.toml's python-path.
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await click(await editorPoint("    Toml Kw", "Toml Kw"), "editor: Toml Kw");
      await key("F12", "F12", 123);
      await until(() => activeAt(path.join("lib", "tomlkw.py"), 0, 4), "F12 opens tomlkw.py at toml_kw", 15000);
      await screenshot("project-files-markdown-f12");
      evidence.push({ result: "Markdown navigation", problems: shown(suiteUri), ctrlClick: "markdown_keywords.md:5:1",
        f12: "lib/tomlkw.py:1:5" });

      // Test Explorer: the Markdown suite's tests at their Markdown lines; Run and Debug Test pass with robot.toml's settings.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await clickRefresh();
      await until(() => discovered("Markdown First Test") && discovered("Markdown Second Test"), "Markdown suite discovered", 20000);
      const range = item => [item.range.start.line, item.range.start.character];
      assert.deepEqual([range(discovered("Markdown First Test")), range(discovered("Markdown Second Test"))], [[10, 0], [20, 2]]);
      await showRow("Markdown First Test", "Markdown Login");
      tests.lastRun = undefined;
      await rowAction("Markdown First Test", "Run Test");
      await until(() => tests.lastRun?.length === 1, "Run Test result", 90000);
      let [result] = tests.lastRun;
      assert.deepEqual([result.id, result.robotStatus, result.source], [id(suiteId, "Markdown First Test"), "PASS", "output.xml"]);
      assert.deepEqual(result.args.slice(0, tomlArguments.length), tomlArguments, "Run passes robot.toml's settings first");
      await rowState("Markdown First Test", "Passed");
      await vscode.commands.executeCommand("testing.clearTestResults");
      // Breakpoints set with real clicks in the glyph margin of the Markdown suite and the imported Markdown resource.
      const loginFile = path.join(projectRoot, "markdown_login.robot.md"), keywordsFile = path.join(projectRoot, "markdown_keywords.md");
      const controlFile = path.join(projectRoot, "markdown_control.robot");
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await vscode.window.showTextDocument(suiteUri, { preview: false });
      await clickGutter("Markdown First Test", 13); // `    Toml Kw`
      await vscode.window.showTextDocument(vscode.Uri.file(keywordsFile), { preview: false });
      await clickGutter("Markdown Shared Keyword", 6); // `    Log    shared from Markdown`
      await screenshot("project-files-markdown-breakpoints");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await showTesting();
      const debugStarted = () => new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      tests.lastRun = undefined;
      let started = debugStarted();
      await rowAction("Markdown First Test", "Debug Test");
      let session = await started;
      assert.equal(debug.sessions.get(session.id)?.adapter.backendId, "robot-companion-native");
      // Markdown Shared Keyword (line 12) runs the resource's Log first, then Toml Kw (line 13).
      await pausedAt(session, keywordsFile, 6, "markdown_keywords.md:6");
      await screenshot("project-files-markdown-paused-resource");
      await key("F5", "F5", 116);
      await pausedAt(session, loginFile, 13, "markdown_login.robot.md:13");
      await screenshot("project-files-markdown-paused-suite");
      await key("F5", "F5", 116);
      await until(() => tests.lastRun?.length === 1, "Debug Test result", 90000);
      [result] = tests.lastRun;
      assert.deepEqual([result.robotStatus, result.source], ["PASS", "output.xml"]);
      assert.match(fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8"), /<test [^>]*name="Markdown First Test"/);
      await showTesting(); // pausing showed the Run and Debug view
      await rowState("Markdown First Test", "Passed");
      await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "Debug Test processes gone", 15000);
      await screenshot("project-files-results");
      evidence.push({ result: "Markdown suite Run and Debug Test with robot.toml", status: "PASS", name: "Markdown First Test" });

      // Control: a .robot suite's breakpoint, then the same Markdown resource breakpoint from it.
      await vscode.window.showTextDocument(vscode.Uri.file(controlFile), { preview: false });
      await clickGutter("Robot Control Test", 6); // `    Log    control`
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await clickRefresh();
      const controlId = vscode.Uri.file(controlFile).toString();
      await until(() => itemById(controlId)?.children.get(id(controlId, "Robot Control Test")), "control suite discovered");
      await vscode.commands.executeCommand("testing.clearTestResults");
      tests.lastRun = undefined;
      started = debugStarted();
      await settle();
      await sleep(300); // Let the refreshed/cleared Testing tree render before revealing the row.
      await showRow("Robot Control Test", "Markdown Control");
      await rowAction("Robot Control Test", "Debug Test");
      session = await started;
      await pausedAt(session, controlFile, 6, "markdown_control.robot:6");
      await key("F5", "F5", 116);
      await pausedAt(session, keywordsFile, 6, "markdown_keywords.md:6 from the .robot control");
      await key("F5", "F5", 116);
      await until(() => tests.lastRun?.length === 1, "control Debug Test result", 90000);
      assert.deepEqual([tests.lastRun[0].robotStatus, tests.lastRun[0].source], ["PASS", "output.xml"]);
      await showTesting();
      await rowState("Robot Control Test", "Passed");
      await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "control Debug Test processes gone", 15000);
      evidence.push({ result: "Markdown breakpoints bind in Debug Test; .robot control", stops: ["markdown_keywords.md:6",
        "markdown_login.robot.md:13", "markdown_control.robot:6", "markdown_keywords.md:6"] });
    } finally {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(tomlPath, { force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
      await until(() => !reported()?.projectFiles?.length, "language service restarted without robot.toml", 30000).catch(() => {});
      await settle();
      await clickRefresh();
    }
    assert.deepEqual(reported().projectFiles, []);
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process with robot.toml or Markdown sources");
  });

  // The default Debug Test path attaches the Python child session, which VS Code sends every
  // breakpoint of the debug type: it must not claim Markdown (or any non-Python) breakpoints.
  // Row-aware: the RF 7.3.2 row shows the Markdown breakpoints unverified with the backend's
  // not-read text; the RF 7.5 row binds them. A .py breakpoint pauses in the child on both.
  test("default Debug Test with the Python child: Markdown breakpoints show the Robot backend's answer (RF 7.3.2 unverified with the not-read text, RF 7.5 bound) and a .py breakpoint pauses", async function () {
    this.timeout(300000);
    await configureNative();
    const doctor = JSON.parse(execFileSync(nativeExecutable, ["doctor"], { encoding: "utf8" }));
    const rf75 = doctor.runtime.robotframework === "7.5";
    evidence.push({ row: doctor.runtime });
    const projectRoot = path.join(folder.uri.fsPath, "integration-project-files");
    const tomlPath = path.join(folder.uri.fsPath, "robot.toml");
    const loginFile = path.join(projectRoot, "markdown_login.robot.md"), keywordsFile = path.join(projectRoot, "markdown_keywords.md");
    const controlFile = path.join(projectRoot, "markdown_control.robot"), pythonFile = path.join(projectRoot, "lib", "tomlkw.py");
    const notRead = "Robot Framework 7.3.2 does not read Markdown files";
    let failure;
    // The Breakpoints view rows: file label, unverified icon, and the text shown on hover (its title).
    const breakpointRows = () => page(`[...document.querySelectorAll('.debug-breakpoints .monaco-list-row')].filter(row =>
      row.getClientRects().length).map(row => ({ text: row.innerText.replace(/\\s+/g, ' ').trim(),
        unverified: Boolean(row.querySelector('.codicon-debug-breakpoint-unverified')),
        verified: Boolean(row.querySelector('.codicon-debug-breakpoint')),
        title: [row, ...row.querySelectorAll('*')].map(e => e.getAttribute('title') || e.getAttribute('aria-label') || '').join(' | ') }))`);
    try {
      fs.cpSync(path.join(extension.extensionPath, "tests/integration/fixtures/project-files"), projectRoot, { recursive: true });
      fs.copyFileSync(path.join(projectRoot, "robot.toml.txt"), tomlPath);
      await until(() => language.roots.get(folder.uri.toString())?.session?.robotConfiguration?.projectFiles?.includes(tomlPath),
        "language service restarted with robot.toml", 30000);
      await settle();
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      // Glyph-margin clicks: both Markdown files, the .robot control and the Python library.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(vscode.Uri.file(loginFile), { preview: false });
      await clickGutter("Markdown First Test", 13);
      await vscode.window.showTextDocument(vscode.Uri.file(keywordsFile), { preview: false });
      await clickGutter("Markdown Shared Keyword", 6);
      await vscode.window.showTextDocument(vscode.Uri.file(controlFile), { preview: false });
      await clickGutter("Robot Control Test", 6);
      await vscode.window.showTextDocument(vscode.Uri.file(pythonFile), { preview: false });
      await clickGutter("def toml_kw", 2);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await clickRefresh();
      const controlId = vscode.Uri.file(controlFile).toString();
      await until(() => itemById(controlId)?.children.get(id(controlId, "Robot Control Test")), "control suite discovered");
      await vscode.commands.executeCommand("testing.clearTestResults");
      tests.lastRun = undefined;
      const started = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "launch") { listener.dispose(); resolve(session); }
        });
      });
      const child = new Promise(resolve => {
        const listener = vscode.debug.onDidStartDebugSession(session => {
          if (session.configuration.request === "attach") { listener.dispose(); resolve(session); }
        });
      });
      await settle();
      await sleep(300); // Let the refreshed/cleared Testing tree render before revealing the row.
      await showRow("Robot Control Test", "Markdown Control");
      await rowAction("Robot Control Test", "Debug Test");
      const session = await started;
      assert.equal(session.configuration.attachPython, undefined, "the default path: attachPython is not false");
      const childSession = await child; // the Python child is attached
      await pausedAt(session, controlFile, 6, "markdown_control.robot:6 (Python child attached)");
      // While paused: what the Breakpoints view shows for the Markdown breakpoints.
      let rows;
      await until(async () => {
        rows = await breakpointRows();
        const markdown = rows.filter(row => /markdown_(login\.robot|keywords)\.md/.test(row.text));
        return markdown.length === 2 && markdown.every(row => rf75 ? !row.unverified : row.unverified && row.title.includes(notRead));
      }, `Markdown breakpoints ${rf75 ? "bound" : "unverified with the not-read text"} in the Breakpoints view`, 20000).catch(async error => {
        if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-discovery-default-path-breakpoint-rows.json"), JSON.stringify(rows, null, 2));
        throw error;
      });
      const pythonRow = rows.find(row => /tomlkw\.py/.test(row.text));
      assert.ok(pythonRow && !pythonRow.unverified, "the .py breakpoint is bound by the Python child");
      evidence.push({ breakpointsView: rows });
      if (!rf75) {
        // The not-read text, made visible with the pointer resting on the Markdown breakpoint row.
        const row = await pointAt(`() => [...document.querySelectorAll('.debug-breakpoints .monaco-list-row')]
          .find(r => r.getClientRects().length && /markdown_keywords\.md/.test(r.innerText))`, "markdown_keywords.md breakpoint row");
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
        evidence.push({ action: "pointer rests", target: "Breakpoints view: markdown_keywords.md", point: row });
        await until(async () => (await page(`[...document.querySelectorAll('.monaco-hover, .workbench-hover, .custom-hover')]
          .filter(e => e.getClientRects().length).map(e => e.innerText).join('\\n')`)).includes(notRead), "not-read text on hover", 15000);
      }
      await screenshot(`default-path-markdown-breakpoints-rf${rf75 ? "75" : "732"}`);
      await key("F5", "F5", 116);
      // The .py breakpoint pauses in the Python child session (Toml Kw, line 7 of the control).
      await until(() => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.fsPath === pythonFile && editor.selection.active.line === 1 &&
          vscode.debug.activeStackItem instanceof vscode.DebugStackFrame && vscode.debug.activeStackItem.session.id === childSession.id;
      }, "paused at tomlkw.py:2 in the Python child", 60000);
      const { stackFrames } = await childSession.customRequest("stackTrace", { threadId: vscode.debug.activeStackItem.threadId });
      assert.deepEqual([stackFrames[0].source?.path, stackFrames[0].line], [pythonFile, 2]);
      await screenshot(`default-path-python-paused-rf${rf75 ? "75" : "732"}`);
      evidence.push({ paused: "tomlkw.py:2 (Python child)", frames: stackFrames.slice(0, 3).map(f => `${f.name} ${path.basename(f.source?.path || "")}:${f.line}`) });
      if (rf75) {
        await key("F5", "F5", 116);
        await pausedAt(session, keywordsFile, 6, "markdown_keywords.md:6 (Python child attached)");
        await key("F5", "F5", 116);
        await until(() => tests.lastRun?.length === 1, "control Debug Test result", 90000);
        assert.deepEqual([tests.lastRun[0].robotStatus, tests.lastRun[0].source], ["PASS", "output.xml"]);
      } else {
        // RF 7.3.2 refuses the Markdown import, so this run fails at Markdown Shared Keyword; its end
        // under debugpy's default "Uncaught Exceptions" stop on the worker's sys.exit(1) does not finish
        // (the same with the previous DebugAdapterServer child; outside this check). Stop it instead,
        // with the debug toolbar's Stop key.
        await key("F5", "F5", 116, 8); // Shift+F5
        await until(() => tests.lastRun?.length === 1, "stopped control Debug Test result", 60000);
        assert.equal(tests.lastRun[0].status, "cancelled");
      }
      await until(() => debug.sessions.size === 0 && runProcesses().length === 0, "Debug Test processes gone", 15000);
      evidence.push({ result: "default-path Debug Test with the Python child", row: doctor.runtime.robotframework,
        status: tests.lastRun[0].robotStatus || tests.lastRun[0].status });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      if (vscode.debug.activeDebugSession) await vscode.debug.stopDebugging(); // after a failure while paused
      await until(() => debug.sessions.size === 0, "debug sessions ended", 15000).catch(() => {});
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(tomlPath, { force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
      await until(() => !language.roots.get(folder.uri.toString())?.session?.robotConfiguration?.projectFiles?.length,
        "language service restarted without robot.toml", 30000).catch(() => {});
      await settle();
      // A cleanup failure never hides the failure that left the window in this state.
      try { await clickRefresh(); } catch (error) { if (!failure) throw error; }
    }
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process");
  });

  test("Refresh Tests shows files added, renamed and deleted on disk, and a file's discovery error next to its tests", async function () {
    this.timeout(180000);
    await configureNative();
    const languageChild = language.roots.get(folder.uri.toString())?.session?.child;
    const added = vscode.Uri.file(fixtureFile("added_suite.robot")).toString();
    const renamed = vscode.Uri.file(fixtureFile("renamed_suite.robot")).toString();
    const broken = vscode.Uri.file(fixtureFile("broken_suite.robot")).toString();
    fs.writeFileSync(fixtureFile("added_suite.robot"), "*** Test Cases ***\nAdded On Disk\n    Log    added\n");
    await clickRefresh();
    await until(() => itemById(added)?.children.get(id(added, "Added On Disk")), "added suite discovered");
    await showRow("Added On Disk", "Added Suite");
    await screenshot("refresh-added");
    fs.renameSync(fixtureFile("added_suite.robot"), fixtureFile("renamed_suite.robot"));
    await clickRefresh();
    await until(() => itemById(renamed) && !itemById(added), "renamed suite replaces the old one");
    await rowPoint("Renamed Suite");
    let labels = await allRowLabels();
    assert.ok(hasRow(labels, "Renamed Suite") && !hasRow(labels, "Added Suite"), "the tree has the new file name only");
    fs.rmSync(fixtureFile("renamed_suite.robot"));
    await clickRefresh();
    await until(() => itemById(namesUri) && !itemById(renamed), "deleted suite gone");
    labels = await allRowLabels();
    assert.ok(hasRow(labels, "Native Names") && !hasRow(labels, "Renamed Suite"), "no row for the deleted file");
    evidence.push({ result: "refresh after add, rename and delete", added, renamed, deleted: renamed });

    // A parse error: RF's tests of the file are listed and an error item says what is missing.
    fs.writeFileSync(fixtureFile("broken_suite.robot"), "*** Test Cases ***\nListed Before Error\n    Log    x\n\n*** Not A Section ***\nx\n");
    await clickRefresh();
    const errorLabel = "integration-native-discovery/broken_suite.robot: discovery error (line 5)";
    await until(() => itemById(broken), "broken suite discovered");
    await rowPoint(errorLabel);
    const errorItem = controllerTree().errors.find(item => item.label === errorLabel);
    assert.match(errorItem.error, /Unrecognized section header '\*\*\* Not A Section \*\*\*'/);
    const status = api.getProviderStatusForTest().get("discovery", folder);
    assert.equal(status.severity, vscode.LanguageStatusSeverity.Warning);
    assert.match(status.summary, /\d+ tests, \d+ discovery errors/);
    await screenshot("refresh-discovery-error");
    fs.rmSync(fixtureFile("broken_suite.robot"));
    await clickRefresh();
    await until(() => !itemById(broken), "broken suite gone");
    assert.equal(controllerTree().errors.some(item => item.label === errorLabel), false);
    assert.equal(language.roots.get(folder.uri.toString())?.session?.child, languageChild, "the language service kept running");
    evidence.push({ result: "discovery error item", label: errorLabel, error: errorItem.error, status: status.summary });
    noteRobotCode();
  });

  test("a discovery service that crashes, fails to start or answers with a JSON-RPC error is reported visibly; language and debugging keep running", async function () {
    this.timeout(300000);
    await configureNative();
    const errorId = `discovery-error:${folder.uri}`;
    const languageChild = language.roots.get(folder.uri.toString())?.session?.child;
    // The language process is the same and still answers: F12's definition provider on Build Record.
    const checkLanguage = async () => {
      const root = language.roots.get(folder.uri.toString());
      assert.equal(root?.session?.state, "running", "native language service running");
      assert.equal(root.session.child, languageChild, "the same language process");
      const audit = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot"));
      const line = audit.getText().split(/\r?\n/).findIndex(text => text.includes("Build Record    name=Ada"));
      const character = audit.lineAt(line).text.indexOf("Build Record") + 2;
      const targets = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", audit.uri, new vscode.Position(line, character));
      assert.equal(targets.length, 1);
      assert.ok((targets[0].targetUri || targets[0].uri).path.endsWith("AuditLibrary.py"), "definition from the native language service");
    };
    const failure = async (label, pattern) => {
      await until(() => pattern.test(itemById(errorId)?.error || ""), `${label}: error item`, 30000);
      const ids = [];
      tests.controller.items.forEach(item => ids.push(item.id));
      assert.deepEqual(ids, [errorId], `${label}: only the error item, no partial or stale tree`);
      await showTesting();
      await rowPoint(`${folder.name}: discovery unavailable`);
      const status = api.getProviderStatusForTest().get("discovery", folder);
      assert.equal(status.state, "refused");
      assert.match(status.error, pattern);
      const center = await notificationCenter();
      assert.match(center, /Robot Companion test discovery not available\. robotCompanion\.\w+ for folder/);
      assert.match(center, pattern);
      await checkLanguage();
      assert.ok(tests.debugProfile, `${label}: Debug Test stays available for the native debug service`);
      await screenshot(`failure-${label}`);
      const shown = { label, error: itemById(errorId).error, status: status.error, notification: center.split("\n")[0] };
      await vscode.commands.executeCommand("notifications.clearAll");
      // Native debugging still starts and runs to its end.
      shown.nativeLaunch = await runAndDebugLaunch(`after discovery ${label}`);
      return shown;
    };

    // A crash of the running discovery service.
    const discovery = tests.roots.get(folder.uri.toString()).session.child;
    process.kill(discovery.pid, "SIGKILL");
    const crashed = await failure("crash", /Discovery backend exited \(SIGKILL\)/);
    await clickRefresh();
    await until(() => itemById(namesUri)?.children.size === 5 && !itemById(errorId),
      "Refresh Tests restarts discovery after the crash");
    evidence.push({ result: "crash", shown: crashed, recovered: "Refresh Tests" });

    // A service that fails to start (the executable exits with a usage error); native debugging still runs.
    const typo = JSON.parse(JSON.stringify(descriptors.execution));
    typo.services.discovery.argv = ["discovery-typo"];
    await configure({ languageBackend: descriptors.language, executionBackend: typo });
    const startFailure = await failure("start", /Discovery backend exited \(2\)/);
    evidence.push({ result: "failed start", shown: startFailure });

    // A JSON-RPC error answer (local discovery fixture as robotCompanion.discoveryBackend), next to native debug.
    const server = path.join(extension.extensionPath, "tests/integration/fixtures/discovery/server.js");
    await configure({ languageBackend: descriptors.language, executionBackend: descriptors.debugOnly, discoveryBackend: {
      id: "discovery-fixture", version: "1", contractVersion: 1, workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
      env: { ELECTRON_RUN_AS_NODE: "1" }, services: { discovery: { executable: process.execPath, argv: [server, "rpc-error"], transport: "stdio" } } } });
    const rpcError = await failure("json-rpc-error", /fixture discovery failed/);
    assert.equal(api.getProviderStatusForTest().get("execution", folder)?.state, "running", "native debug provider status");
    evidence.push({ result: "JSON-RPC error", shown: rpcError });
    noteRobotCode();
    assert.deepEqual(robotCodeSeen, [], "no RobotCode process");
  });

  test("discovery combinations: native discoveryBackend next to native or RobotCode debugging, no execution backend, and no discovery service", async function () {
    this.timeout(240000);
    const combinations = [];
    // Native debug only + native discoveryBackend.
    await configure({ languageBackend: descriptors.language, executionBackend: descriptors.debugOnly, discoveryBackend: descriptors.discoveryOnly });
    await until(() => itemById(namesUri)?.children.size === 5, "native discovery from discoveryBackend", 30000);
    assert.equal(tests.roots.get(folder.uri.toString()).setting, "discoveryBackend");
    assert.ok(tests.debugProfile, "Debug Test from the native execution provider");
    combinations.push({ executionBackend: "native (debug)", discoveryBackend: "native (discovery)", items: "native (discoveryBackend)", debugTest: "native",
      line: api.getProviderStatusForTest().lines().find(line => /Tests:/.test(line)) });
    // No executionBackend: the preview's native default supplies the debug service next to the explicit
    // discoveryBackend (README combination table). The default is robotCompanion.nativeBackendExecutable, here the
    // native test venv's backend, so its debug provider really runs.
    await config.update("nativeBackendExecutable", nativeExecutable, vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      await configure({ languageBackend: descriptors.language, discoveryBackend: descriptors.discoveryOnly });
      await until(() => api.getProviderStatusForTest().get("execution", folder)?.state === "running" &&
        api.getProviderStatusForTest().get("execution", folder).environment?.origin === "setting",
      "native default debug provider from robotCompanion.nativeBackendExecutable", 30000);
      await until(() => itemById(namesUri)?.children.size === 5, "native discovery without an execution backend", 30000);
      assert.equal(tests.roots.get(folder.uri.toString()).setting, "discoveryBackend");
      assert.ok(tests.debugProfile, "Debug Test from the preview's native default execution backend");
      combinations.push({ executionBackend: "not set (preview native default: nativeBackendExecutable)", discoveryBackend: "native (discovery)",
        items: "native (discoveryBackend)", debugTest: "native default", line: api.getProviderStatusForTest().lines().find(line => /Debug:/.test(line)) });
    } finally {
      await config.update("nativeBackendExecutable", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await settle();
    }
    // An execution backend without a debug service: discovery only, no Debug Test.
    await configure({ languageBackend: descriptors.language, executionBackend: descriptors.discoveryOnly });
    await until(() => itemById(namesUri)?.children.size === 5, "native discovery from a discovery-only execution backend", 30000);
    assert.equal(tests.roots.get(folder.uri.toString()).setting, "executionBackend");
    assert.equal(tests.debugProfile, undefined, "no Debug Test without a debug service");
    assert.ok(api.getProviderStatusForTest().lines().some(line => /Tests: Native backend 0\.1\.0\.dev8 — .*no Debug Test/.test(line)));
    combinations.push({ executionBackend: "native (discovery only)", discoveryBackend: "not set", items: "native (executionBackend)", debugTest: "none" });
    // Native debug only, no discovery: the file/run fallback.
    await configure({ languageBackend: descriptors.language, executionBackend: descriptors.debugOnly });
    assert.equal(tests.controller, undefined, "no test controller");
    assert.ok(api.getProviderStatusForTest().lines().some(line => /Tests: file\/run fallback — No discovery service configured/.test(line)));
    combinations.push({ executionBackend: "native (debug)", discoveryBackend: "not set", items: "none: file/run fallback" });
    // RobotCode debug only + native discoveryBackend.
    if (fs.existsSync(robotCodePython)) {
      const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
      const robotCodeDebug = JSON.parse(JSON.stringify(robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
        python: robotCodePython, services: ["debug"] })));
      await configure({ languageBackend: descriptors.language, executionBackend: robotCodeDebug, discoveryBackend: descriptors.discoveryOnly });
      await until(() => itemById(namesUri)?.children.size === 5, "native discovery next to RobotCode debugging", 30000);
      assert.equal(tests.roots.get(folder.uri.toString()).setting, "discoveryBackend");
      assert.ok(tests.debugProfile, "Debug Test from the RobotCode execution provider");
      combinations.push({ executionBackend: "RobotCode (debug)", discoveryBackend: "native (discovery)", items: "native (discoveryBackend)",
        debugTest: "RobotCode (profile offered; a Debug Test run is not part of this check)" });
      await configure({ languageBackend: descriptors.language, executionBackend: robotCodeDebug });
      assert.equal(tests.controller, undefined, "RobotCode debug without discovery: no test controller");
      combinations.push({ executionBackend: "RobotCode (debug)", discoveryBackend: "not set", items: "none: file/run fallback" });
    } else combinations.push({ skipped: `RobotCode environment absent at ${robotCodePython}` });
    await configure({ mode: "coexistence" });
    assert.equal(tests.controller, undefined);
    evidence.push({ combinations });
    if (!fs.existsSync(robotCodePython)) this.skip(); // The RobotCode rows were not checked: pending, never a pass.
  });
});

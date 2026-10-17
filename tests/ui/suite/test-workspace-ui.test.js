"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

suite("Owned Test Explorer discovery (local discovery fixture; not Robot run acceptance)", () => {
  let extension, tests, folder, config, cdp, auditUri;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const fixture = path => ({ executable: process.execPath, argv: [path], transport: "stdio" });
  const descriptor = (services) => ({
    id: "discovery-fixture", version: "1", contractVersion: 1,
    workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
    // Electron's executable cannot run the Node fixture without this environment.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    services
  });
  const discoveryFixture = (...args) => ({ discovery: { ...fixture(path.join(extension.extensionPath,
    "tests/integration/fixtures/discovery/server.js")), argv: [path.join(extension.extensionPath,
    "tests/integration/fixtures/discovery/server.js"), ...args] } });
  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function pointAt(finder, label) {
    let point;
    try {
      await findPoint();
    } catch (error) {
      if (evidenceDirectory) {
        await screenshot(`missing-${label.replace(/\W+/g, "-")}`);
        fs.writeFileSync(path.join(evidenceDirectory, `missing-${label.replace(/\W+/g, "-")}.json`), JSON.stringify(await page(`
          [...document.querySelectorAll('input, .monaco-list-row')].filter(e => e.getClientRects().length).slice(0, 80).map(e => ({
            tag: e.tagName, placeholder: e.placeholder, aria: e.getAttribute('aria-label'), text: (e.textContent || '').slice(0, 60),
            classes: [e.className, e.parentElement?.className, e.closest('[id]')?.id].join(' | ') }))`), null, 2));
      }
      throw error;
    }
    return point;
    async function findPoint() {
    await until(async () => {
      point = await page(`(() => {
        const element = (${finder})();
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = rect.x + Math.min(rect.width / 2, 120), y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
      })()`);
      return point;
    }, `visible ${label}`);
    }
  }
  async function click(point, label, clickCount = 1) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    await sleep(150);
    for (let count = 1; count <= clickCount; count++) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left",
          buttons: type === "mousePressed" ? 1 : 0, clickCount: count }, cdp.pageSession);
      }
    }
    evidence.push({ action: clickCount > 1 ? "double-click" : "click", target: label, point });
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, name + ".png"), Buffer.from(data, "base64"));
  }
  async function configure(mode, backend) {
    await config.update("executionBackend", backend, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", mode, vscode.ConfigurationTarget.WorkspaceFolder);
    await tests.queue;
  }
  const suiteItem = () => tests.controller?.items.get(auditUri);

  suiteSetup(async () => {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    tests = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getTestWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    auditUri = vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot").toString();
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node },
      backend: "local Node discovery fixture only", externalRobotExtensions: "absent",
      viewport: await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`) });
  });
  teardown(async () => {
    await configure("coexistence", undefined);
    assert.equal(tests.controller, undefined, "no Robot Companion test controller outside owned mode");
  });
  suiteTeardown(async () => {
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "test-explorer-ui-actions.json"),
      JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("Test Explorer lists source-backed tests and a click opens the test's source line", async () => {
    await configure("owned", descriptor(discoveryFixture()));
    await until(() => suiteItem()?.children.get(`${auditUri}::Debug Smoke`), "discovered audit test");
    const testItem = suiteItem().children.get(`${auditUri}::Debug Smoke`);
    // Earlier suites may have saved edits to this synthetic copy: expect the
    // line where the file currently declares the test.
    const testLine = (await vscode.workspace.openTextDocument(vscode.Uri.parse(auditUri))).getText()
      .split(/\r?\n/).findIndex(line => line === "Debug Smoke");
    assert.ok(testLine > 0);
    assert.equal(testItem.uri.toString(), auditUri);
    assert.equal(testItem.range.start.line, testLine);
    const session = [...tests.roots.values()][0].session;
    const child = session.child;

    await vscode.commands.executeCommand("workbench.view.testing.focus");
    const rowFinder = name => `() => [...document.querySelectorAll('.monaco-list-row')].find(row =>
      row.getClientRects().length && row.querySelector('.label, .monaco-highlighted-label') &&
      row.querySelector('.label, .monaco-highlighted-label').textContent.trim() === ${JSON.stringify(name)})`;
    // Expand the suite the way a person does (tree rows expand on click), then
    // click the discovered test.
    await click(await pointAt(rowFinder("audit"), "audit suite row"), "audit suite row");
    const row = await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row");
    await screenshot("owned-test-explorer");
    const opened = () => vscode.window.activeTextEditor?.document.uri.toString() === auditUri &&
      vscode.window.activeTextEditor.selection.active.line === testLine;
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "AuditLibrary.py"));
    await click(row, "Debug Smoke row");
    try {
      await until(opened, "single click opens test source", 3000);
    } catch {
      // VS Code builds differ: when a single click only selects the row, a
      // double click is the person's route to the test's source.
      await click(await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row"), "Debug Smoke row", 2);
      await until(opened, "double click opens test source");
    }
    evidence.push({ result: "test source", uri: auditUri, line: vscode.window.activeTextEditor.selection.active.line,
      id: testItem.id });
    await screenshot("owned-test-explorer-opened");

    await configure("coexistence", undefined);
    assert.equal(tests.controller, undefined);
    await until(() => child.exitCode !== null || child.signalCode !== null, "discovery process exited");
    evidence.push({ cleanup: "coexistence", exitCode: child.exitCode, signal: child.signalCode, controller: "disposed" });
  });

  test("Test Explorer's Run action runs one test through the CodeLens runner with its own output folder", async () => {
    const nodePath = process.env.npm_node_execpath || "node";
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand",
      `"${nodePath}" "${path.join(extension.extensionPath, "tests/fixtures/fake-robot/fake-robot.js")}"`,
      vscode.ConfigurationTarget.Workspace);
    try {
      await configure("owned", descriptor(discoveryFixture()));
      await until(() => suiteItem()?.children.get(`${auditUri}::Debug Smoke`), "discovered audit test");
      await vscode.commands.executeCommand("workbench.view.testing.focus");
      const rowFinder = name => `() => [...document.querySelectorAll('.monaco-list-row')].find(row =>
        row.getClientRects().length && row.querySelector('.label, .monaco-highlighted-label') &&
        row.querySelector('.label, .monaco-highlighted-label').textContent.trim() === ${JSON.stringify(name)})`;
      if (!await page(`Boolean((${rowFinder("Debug Smoke")})())`)) {
        await click(await pointAt(rowFinder("audit"), "audit suite row"), "audit suite row");
      }
      const row = await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
      const runAction = await pointAt(`() => { const row = (${rowFinder("Debug Smoke")})();
        return row && [...row.querySelectorAll('.action-label')].find(action =>
          /^Run Test/.test(action.getAttribute('aria-label') || action.title || '')); }`, "Run Test action");
      await click(runAction, "Debug Smoke Run Test action");
      await until(() => tests.lastRun?.length === 1 && tests.lastRun[0].status, "Test Explorer run finished", 20000);
      const [result] = tests.lastRun;
      assert.equal(result.id, `${auditUri}::Debug Smoke`);
      assert.equal(result.outcome, "passed");
      const invocation = JSON.parse(fs.readFileSync(path.join(result.outputDir, "invocation.json"), "utf8"));
      assert.equal(invocation.argv[invocation.argv.indexOf("--test") + 1], "Debug Smoke");
      assert.ok(invocation.argv.at(-1).endsWith(path.join("integration-audit-v1", "audit.robot")));
      await screenshot("owned-test-explorer-run");
      evidence.push({ result: "Test Explorer run", id: result.id, outcome: result.outcome, outputDir: result.outputDir,
        argv: invocation.argv });
    } finally {
      await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("no discovery service registers no controller; invalid results become a visible error item", async () => {
    await configure("owned", descriptor({ debug: fixture(process.execPath) }));
    assert.equal(tests.controller, undefined, "debug-only backend: no test controller");
    await configure("owned", descriptor(discoveryFixture("outside")));
    const errorId = `discovery-error:${folder.uri}`;
    await until(() => tests.controller?.items.get(errorId), "discovery error item");
    assert.match(tests.controller.items.get(errorId).error, /outside its workspace folder/);
    assert.equal(suiteItem(), undefined, "no partial tree from an invalid result");
    await configure("owned", descriptor(discoveryFixture("no-discovery")));
    await until(() => /does not advertise discovery API v1/.test(tests.controller?.items.get(errorId)?.error || ""),
      "unsupported discovery capability");
    evidence.push({ refused: ["debug-only backend: no controller", "outside URI: error item", "no discovery capability: error item"] });
  });
});

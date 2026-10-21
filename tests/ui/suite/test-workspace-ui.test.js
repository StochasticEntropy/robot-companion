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

  test("Test Explorer's Run action runs one test with the configured robotCommand and its own output folder", async () => {
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
      // Robot runs the workspace folder; the run's argument file parses only audit.robot and its
      // selection names Debug Smoke by its file and name line.
      assert.equal(invocation.argv.at(-1), folder.uri.fsPath);
      assert.equal(invocation.expanded[invocation.expanded.indexOf("--parseinclude") + 1],
        path.join(folder.uri.fsPath, "integration-audit-v1", "audit.robot"));
      assert.ok(invocation.expanded.includes("--prerunmodifier"));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.runDir, "selection.json"), "utf8")).tests,
        [[path.join(folder.uri.fsPath, "integration-audit-v1", "audit.robot"),
          suiteItem().children.get(`${auditUri}::Debug Smoke`).range.start.line + 1, "Debug Smoke"]]);
      await screenshot("owned-test-explorer-run");
      evidence.push({ result: "Test Explorer run", id: result.id, outcome: result.outcome, outputDir: result.outputDir,
        argv: invocation.argv });
    } finally {
      await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("live RobotCode discovery: a Test Explorer click opens the source and Run gives PASS from the run's output.xml", async function () {
    const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
    if (!fs.existsSync(python)) this.skip(); // Reported as pending, never as a pass.
    this.timeout(180000);
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const robot = path.join(path.dirname(python), "robot");
    // Explicit robotCommand compatibility: the CodeLens runner runs the real Robot Framework.
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", robot, vscode.ConfigurationTarget.Workspace);
    try {
      await configure("owned", JSON.parse(JSON.stringify(robotCodeDescriptor({ workspaceUri: folder.uri.toString(),
        cwd: folder.uri.fsPath, python, services: ["debug", "discovery"] }))));
      await until(() => suiteItem()?.children.get(`${auditUri}::Debug Smoke`), "RobotCode discovered the audit test", 90000);
      const testItem = suiteItem().children.get(`${auditUri}::Debug Smoke`);
      const testLine = (await vscode.workspace.openTextDocument(vscode.Uri.parse(auditUri))).getText()
        .split(/\r?\n/).findIndex(line => line === "Debug Smoke");
      assert.equal(testItem.range.start.line, testLine, "RobotCode's source range");
      evidence.push({ liveDiscovery: "RobotCode 2.7.0", suites: tests.controller.items.size, id: testItem.id, line: testLine });
      await vscode.commands.executeCommand("workbench.view.testing.focus");
      // Rows keep earlier results in their label ("audit.robot (Passed), in 67ms"): match the accessible name.
      const rowFinder = name => `() => [...document.querySelectorAll('.monaco-list-row')].find(row =>
        row.getClientRects().length && (row.getAttribute('aria-label') || '').startsWith(${JSON.stringify(name + " (")}))`;
      if (!await page(`Boolean((${rowFinder("Debug Smoke")})())`)) {
        await click(await pointAt(rowFinder("audit.robot"), "audit.robot suite row"), "audit.robot suite row");
      }
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "AuditLibrary.py"));
      const opened = () => vscode.window.activeTextEditor?.document.uri.toString() === auditUri &&
        vscode.window.activeTextEditor.selection.active.line === testLine;
      await click(await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row"), "Debug Smoke row (RobotCode)");
      try { await until(opened, "single click opens test source", 3000); }
      catch {
        await click(await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row"), "Debug Smoke row (RobotCode)", 2);
        await until(opened, "double click opens test source");
      }
      const row = await pointAt(rowFinder("Debug Smoke"), "Debug Smoke row");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...row }, cdp.pageSession);
      const runAction = await pointAt(`() => { const row = (${rowFinder("Debug Smoke")})();
        return row && [...row.querySelectorAll('.action-label')].find(action =>
          /^Run Test/.test(action.getAttribute('aria-label') || action.title || '')); }`, "Run Test action");
      tests.lastRun = undefined;
      await click(runAction, "Debug Smoke Run Test action (real Robot)");
      await until(() => tests.lastRun?.length === 1 && tests.lastRun[0].status, "real Robot run finished", 60000);
      const [result] = tests.lastRun;
      assert.equal(result.id, `${auditUri}::Debug Smoke`);
      assert.equal(result.robotStatus, "PASS");
      assert.equal(result.source, "output.xml", "status read from this run's own output.xml");
      const xml = fs.readFileSync(path.join(result.outputDir, "output.xml"), "utf8");
      assert.match(xml, /generator="Robot 7\.5/);
      assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
      await screenshot("robotcode-test-explorer-run");
      evidence.push({ result: "real Test Explorer run", id: result.id, robotStatus: result.robotStatus, source: result.source,
        outputDir: result.outputDir });
    } finally {
      await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("live owned mode: a real click on audit.robot's Run Test CodeLens passes through robotCommand", async function () {
    const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
    if (!fs.existsSync(python)) this.skip(); // Reported as pending, never as a pass.
    this.timeout(180000);
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const runs = require(path.join(extension.extensionPath, "src/core/extension")).__test__;
    const robot = path.join(path.dirname(python), "robot");
    await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", robot, vscode.ConfigurationTarget.Workspace);
    try {
      // The README's owned configuration: RobotCode debug and discovery services.
      await configure("owned", JSON.parse(JSON.stringify(robotCodeDescriptor({ workspaceUri: folder.uri.toString(),
        cwd: folder.uri.fsPath, python, services: ["debug", "discovery"] }))));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(vscode.Uri.parse(auditUri), { preview: false });
      // The rendered lens of the audit editor; CodeLenses render late and shift
      // lines, so click only a point that stayed put and hits the lens link.
      const lensFinder = `() => {
        const editor = [...document.querySelectorAll('.editor-instance .monaco-editor')].find(e =>
          (e.querySelector('.view-lines')?.innerText || '').replaceAll('\\u00a0', ' ').includes('Debug Smoke'));
        return editor && [...editor.querySelectorAll('.codelens-decoration a')].find(a => a.textContent.trim() === 'Run Test');
      }`;
      // Earlier pointer actions can leave the pointer on an Explorer row whose
      // path tooltip covers the lens: rest it on the editor's line numbers first.
      const margin = await page(`(() => { const m = document.querySelector('.editor-instance .monaco-editor .margin');
        const r = m && m.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height - 20 }; })()`);
      if (margin) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...margin }, cdp.pageSession);
      let point, previous;
      await until(async () => {
        point = await pointAt(lensFinder, "Run Test CodeLens");
        const stable = previous && point.x === previous.x && point.y === previous.y;
        previous = point;
        if (!stable) await sleep(250);
        return stable;
      }, "Run Test CodeLens at a stable point", 30000);
      const lenses = await page(`[...document.querySelectorAll('.editor-instance .codelens-decoration')].map(e => e.innerText.trim())`);
      runs.clearLastRunNotificationForTest();
      await screenshot("owned-codelens-before-click");
      await click(point, "Run Test CodeLens on audit.robot (owned mode)");
      await until(() => runs.getLastRunNotificationForTest(), "CodeLens run finished", 60000);
      assert.deepEqual(runs.getLastRunNotificationForTest(), { severity: "info", message: 'Test "Debug Smoke" passed.',
        actions: ["Open Log", "Open Report", "Show Output"] });
      const output = runs.getLastRunOutputForTest().split("\n");
      assert.ok(output[0].startsWith(`$ ${robot} `), `ran robotCommand: ${output[0]}`);
      assert.match(output[0], /--test 'Debug Smoke' .*integration-audit-v1\/audit\.robot$/);
      const outputDir = output.find(line => line.startsWith("Results: ")).slice("Results: ".length);
      const xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
      assert.match(xml, /generator="Robot 7\.5/);
      assert.match(xml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
      await screenshot("owned-codelens-run-passed");
      evidence.push({ result: "real CodeLens run", mode: "owned", lenses, command: output[0], outputDir,
        notification: runs.getLastRunNotificationForTest().message });
    } finally {
      await vscode.workspace.getConfiguration("robotCompanion").update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // A synthetic suite file in the folder whose test name each save changes,
  // and the test discovery error notifications shown meanwhile (the fixture
  // backend's missing debug service has its own notification).
  async function savedSuite(run) {
    const uri = vscode.Uri.joinPath(folder.uri, "stale-discovery.robot");
    fs.writeFileSync(uri.fsPath, "*** Test Cases ***\nBefore Save\n    No Operation\n");
    const shown = [], showErrorMessage = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = (message, ...rest) => {
      if (/^Robot Companion test discovery/.test(message)) shown.push(message);
      return showErrorMessage.call(vscode.window, message, ...rest);
    };
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      let name = "Before Save";
      const save = async next => {
        const edit = new vscode.WorkspaceEdit();
        const offset = document.getText().indexOf(name);
        edit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + name.length)), next);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(await document.save(), `saved ${next}`);
        name = next;
      };
      await run({ uri: uri.toString(), save, shown });
    } finally {
      vscode.window.showErrorMessage = showErrorMessage;
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(uri.fsPath, { force: true });
    }
  }
  // Resolves when the fixture has answered the newer request and then failed
  // the held one; after one more event-loop turn the extension has handled
  // that failure (its handling is promise-chained, not timed).
  const staleFailureSent = session => new Promise(resolve => session.on("notification", method => {
    if (method === "fixture/staleFailureSent") setImmediate(resolve);
  }));
  // The newer request's tree stays: no error item, no notification, the
  // running status and the same running discovery process.
  function assertNewerTree(label, { uri, shown }, root, child) {
    const ids = [];
    tests.controller.items.forEach(item => ids.push(item.id));
    assert.equal(ids.includes(`discovery-error:${folder.uri}`), false, `${label}: no discovery-unavailable item`);
    const suite = tests.controller.items.get(uri);
    assert.ok(suite?.children.get(`${uri}::Newer Save`), `${label}: the newer request's test is listed`);
    assert.equal(suite.children.size, 1, `${label}: only the newer request's tests`);
    assert.ok(suiteItem()?.children.get(`${auditUri}::Debug Smoke`), `${label}: the rest of the newer tree stays`);
    assert.equal(root.failure, undefined, `${label}: no failure recorded`);
    assert.deepEqual(shown, [], `${label}: no error notification`);
    const status = tests.status.get("discovery", folder);
    assert.equal(status.state, "running", `${label}: status stays running`);
    assert.equal(tests.roots.get(folder.uri.toString()), root, `${label}: same folder root`);
    assert.equal(root.session.state, "running", `${label}: discovery session keeps running`);
    assert.equal(root.session.child, child, `${label}: the same discovery process`);
    assert.equal(child.exitCode, null, `${label}: discovery process not ended`);
    evidence.push({ result: `stale failure ignored (${label})`, requests: root.request, status: status.summary,
      tests: [...suite.children].map(([id]) => id) });
  }

  test("on save: an older request's late failure does not replace the newer request's tree", async () => {
    await savedSuite(async saved => {
      // Request 1 (Refresh) is answered; save request 2 is held until save request 3 is answered, then fails.
      await configure("owned", descriptor(discoveryFixture("stale-failure", "2")));
      await until(() => tests.controller?.items.get(saved.uri)?.children.get(`${saved.uri}::Before Save`), "first tree");
      const root = tests.roots.get(folder.uri.toString()), child = root.session.child;
      const sent = staleFailureSent(root.session);
      await saved.save("Older Save");
      await until(() => root.request === 2, "save request 2 sent");
      await saved.save("Newer Save");
      await until(() => root.request === 3, "save request 3 sent");
      await sent;
      assertNewerTree("on save", saved, root, child);
    });
  });

  test("Refresh Tests: an older request's late failure neither replaces the newer tree nor stops the service", async () => {
    await savedSuite(async saved => {
      // The Refresh request 1 is held until save request 2 is answered, then fails.
      await config.update("executionBackend", descriptor(discoveryFixture("stale-failure", "1")),
        vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
      await until(() => tests.roots.get(folder.uri.toString())?.request === 1, "Refresh request 1 sent");
      const root = tests.roots.get(folder.uri.toString()), child = root.session.child;
      const sent = staleFailureSent(root.session);
      await saved.save("Newer Save");
      await until(() => root.request === 2, "save request 2 sent");
      await sent;
      await tests.queue; // Refresh has handled its request's failure.
      assertNewerTree("Refresh Tests", saved, root, child);
    });
  });

  test("on save: a failure of the newest request empties the tree, notifies once and shows refused", async () => {
    await savedSuite(async saved => {
      await configure("owned", descriptor(discoveryFixture("rpc-error-after-first")));
      await until(() => tests.controller?.items.get(saved.uri)?.children.get(`${saved.uri}::Before Save`), "first tree");
      const errorId = `discovery-error:${folder.uri}`;
      await saved.save("Failing Save");
      await until(() => tests.controller.items.get(errorId), "discovery-unavailable item");
      const ids = [];
      tests.controller.items.forEach(item => ids.push(item.id));
      assert.deepEqual(ids, [errorId], "only the error item, no stale tree");
      const item = tests.controller.items.get(errorId);
      assert.equal(item.label, `${folder.name}: discovery unavailable`);
      assert.match(item.error, /fixture discovery failed\. Use Refresh Tests to start discovery again\./);
      assert.equal(tests.status.get("discovery", folder).state, "refused");
      assert.equal(saved.shown.length, 1, "one error notification");
      assert.match(saved.shown[0], /^Robot Companion test discovery not available\. robotCompanion\.executionBackend for folder '.+': fixture discovery failed\./);
      // A second failing save is the same failure: no second notification.
      const root = tests.roots.get(folder.uri.toString());
      await saved.save("Failing Again");
      await until(() => root.request === 3 && root.session.pending.size === 0, "save request 3 answered");
      await new Promise(setImmediate); // Its failure has been handled.
      assert.ok(tests.controller.items.get(errorId), "still the error item");
      assert.equal(saved.shown.length, 1, "still one error notification");
      assert.equal(root.session.state, "running", "an on-save failure leaves the service for the next save");
      evidence.push({ result: "current save request failed", label: item.label, status: "refused", notifications: saved.shown });
    });
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

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
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

suite("Owned debug lifecycle (local DAP fixture; not Robot debug acceptance)", () => {
  let extension, debug, folder, config, cdp;
  const evidence = [];
  const protocol = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const launchName = "Robot Companion: Debug audit (fixture)";
  const descriptor = (services) => ({
    id: "dap-fixture", version: "1", contractVersion: 1,
    workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath,
    // Electron's executable cannot run the Node fixture without this environment.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    services: services || { debug: { executable: process.execPath, argv: [
      path.join(extension.extensionPath, "tests/integration/fixtures/dap/server.js"), "minimal"
    ], transport: "stdio" } }
  });
  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers
    }, cdp.pageSession);
    evidence.push({ action: "key", key, modifiers });
  }
  // Pointer click on a visible workbench element found by CSS selector; the
  // point must hit that element (or its child) before the click is sent.
  async function clickElement(selector, label) {
    let point;
    await until(async () => {
      point = await page(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find(candidate => candidate.getClientRects().length && candidate.offsetParent !== null);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
      })()`);
      return point;
    }, `visible ${label}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, name + ".png"), Buffer.from(data, "base64"));
  }
  async function configure(mode, backend) {
    await config.update("executionBackend", backend, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", mode, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  suiteSetup(async () => {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    debug = activatedExtensionApi(extension.extensionPath).getDebugWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    // Observe the real protocol traffic between VS Code and the owned adapter.
    protocol.tracker = vscode.debug.registerDebugAdapterTrackerFactory("robotcompanion", {
      createDebugAdapterTracker: () => ({
        onWillReceiveMessage: message => protocol.push({ to: "adapter", command: message.command }),
        onDidSendMessage: message => protocol.push({ from: "adapter", type: message.type,
          command: message.command, event: message.event, output: message.body?.output })
      })
    });
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", [{
      type: "robotcompanion", request: "launch", name: launchName,
      target: "${workspaceFolder}/integration-audit-v1/audit.robot"
    }], vscode.ConfigurationTarget.WorkspaceFolder);
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node },
      backend: "local Node DAP fixture only", externalRobotExtensions: "absent",
      viewport: await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`) });
  });
  teardown(async () => {
    for (const { session } of [...debug.sessions.values()]) await vscode.debug.stopDebugging(session);
    await until(() => debug.sessions.size === 0, "owned debug sessions released");
    await configure("coexistence", undefined);
  });
  suiteTeardown(async () => {
    protocol.tracker?.dispose();
    await vscode.workspace.getConfiguration("launch", folder.uri).update("configurations", undefined,
      vscode.ConfigurationTarget.WorkspaceFolder);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "debug-ui-actions.json"),
      JSON.stringify({ evidence, protocol }, null, 2));
    cdp?.close();
  });

  test("Run and Debug start and toolbar stop own and clean up the adapter process", async () => {
    await configure("owned", descriptor());
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot"));
    await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D: Run and Debug view
    await until(() => page(`Boolean(document.querySelector('.debug-viewlet, .debug-pane'))`), "Run and Debug view");
    await until(() => page(`[...document.querySelectorAll('.start-debug-action-item')].some(item =>
      item.textContent.includes(${JSON.stringify(launchName)}) ||
      [...item.querySelectorAll('select option')].some(option => option.text.includes(${JSON.stringify(launchName)})))`),
    "launch configuration selected in Run and Debug");
    const started = new Promise(resolve => {
      const listener = vscode.debug.onDidStartDebugSession(session => { listener.dispose(); resolve(session); });
    });
    await clickElement(".start-debug-action-item .codicon-debug-start", "Run and Debug start button");
    const session = await started;
    assert.equal(session.type, "robotcompanion");
    await until(() => debug.sessions.get(session.id)?.adapter.capabilities, "negotiated capabilities");
    const { adapter } = debug.sessions.get(session.id);
    const child = adapter.child;
    assert.ok(child?.pid, "owned debug process");
    assert.deepEqual(adapter.unsupported, ["supportsTerminateRequest", "supportsSetVariable", "supportsEvaluateForHovers"]);
    await until(() => protocol.some(message => /launched target .*integration-audit-v1\/audit\.robot/.test(message.output || "")),
      "launch reached the fixture with the resolved target");
    assert.ok(protocol.some(message => /does not support: graceful terminate, editing variables, hover evaluation/
      .test(message.output || "")), "unsupported capabilities reported in the Debug Console");
    await until(() => page(`Boolean([...document.querySelectorAll('.debug-toolbar .codicon-debug-stop')].find(e => e.offsetParent))`),
      "debug toolbar stop");
    await screenshot("owned-debug-started");
    evidence.push({ result: "started", session: session.name, pid: child.pid, unsupported: adapter.unsupported });

    const terminated = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(ended => {
        if (ended.id === session.id) { listener.dispose(); resolve(); }
      });
    });
    await clickElement(".debug-toolbar .codicon-debug-stop", "debug toolbar stop button");
    await terminated;
    await until(() => child.exitCode !== null || child.signalCode !== null, "owned process exited");
    await until(() => debug.sessions.size === 0, "session released");
    assert.ok(protocol.some(message => message.to === "adapter" && message.command === "disconnect"), "disconnect sent");
    await screenshot("owned-debug-stopped");
    evidence.push({ result: "stopped", pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, sessions: debug.sessions.size });
  });

  test("coexistence, a backend without debug and a missing preview executable start no process", async () => {
    const launch = () => vscode.debug.startDebugging(folder, { type: "robotcompanion", request: "launch",
      name: "refused", target: "${workspaceFolder}/integration-audit-v1/audit.robot" });
    await configure("coexistence", descriptor());
    assert.equal(await launch(), false);
    await configure("owned", descriptor({ language: { executable: process.execPath, argv: [], transport: "stdio" } }));
    assert.equal(await launch(), false);
    await configure("owned", undefined);
    await assert.rejects(() => debug.descriptorFor(folder), /no \.venv backend.*Select the project.*offers to install its bundled backend/,
      "an unset descriptor selects the native preview executable; it does not disable debug");
    assert.equal(await launch(), false);
    assert.equal(debug.sessions.size, 0);
    assert.notEqual(vscode.debug.activeDebugSession?.type, "robotcompanion");
    evidence.push({ refused: ["coexistence", "no debug service", "missing native preview executable"], processes: 0 });
  });

  test("coexistence: choosing Robot Companion in Run and Debug explains owned mode and starts nothing", async () => {
    await configure("coexistence", descriptor());
    const launch = vscode.workspace.getConfiguration("launch", folder.uri);
    await launch.update("configurations", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    const startedTypes = [];
    const listener = vscode.debug.onDidStartDebugSession(session => startedTypes.push(session.type));
    const refusal = 'Robot Companion debugging runs only when robotCompanion.integrationMode is "owned"';
    const toast = () => page(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')]
      .map(e => e.textContent).find(text => text.includes(${JSON.stringify(refusal)})) || ""`);
    const runAndDebugButton = ".debug-viewlet .welcome-view-content .monaco-button";
    try {
      // Without a .robot editor, Run and Debug asks which debugger to use.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("notifications.clearAll");
      // The previous test raised the same refusal: only a new toast counts.
      await until(async () => !await toast(), "earlier refusal toast cleared");
      await key("D", "KeyD", 68, 10); // Linux Ctrl+Shift+D: Run and Debug view
      await clickElement(runAndDebugButton, "Run and Debug welcome button");
      const choice = ".quick-input-widget .monaco-list-row[aria-label^='Robot Companion']";
      await until(() => page(`Boolean(document.querySelector(${JSON.stringify(choice)}))`), "debugger picker lists Robot Companion");
      const choices = await page(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(row => row.getAttribute('aria-label'))`);
      await screenshot("coexistence-debugger-picker");
      await clickElement(choice, "Robot Companion in the debugger picker");
      await until(toast, "coexistence refusal after choosing Robot Companion").catch(async error => {
        const shown = await page(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map(e => e.textContent)`);
        throw new Error(`${error.message}; notifications shown: ${JSON.stringify(shown)}`);
      });
      await sleep(300);
      await screenshot("coexistence-debugger-refusal");
      evidence.push({ result: "picker refusal", choices, message: await toast() });

      // With a .robot editor active, VS Code picks Robot Companion without asking.
      await vscode.commands.executeCommand("notifications.clearAll");
      await until(async () => !await toast(), "refusal toast cleared");
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot"));
      await key("D", "KeyD", 68, 10);
      await clickElement(runAndDebugButton, "Run and Debug welcome button (audit.robot open)");
      await until(toast, "coexistence refusal with a .robot file open");
      await sleep(300); // Let the toast finish fading in for the evidence image.
      await screenshot("coexistence-robot-file-refusal");
      evidence.push({ result: "robot-file refusal", message: await toast() });
      await sleep(500);
      assert.deepEqual(startedTypes, [], "no debug session started");
      assert.equal(debug.sessions.size, 0, "no owned adapter process");
    } finally {
      listener.dispose();
      await vscode.commands.executeCommand("notifications.clearAll");
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      await launch.update("configurations", [{
        type: "robotcompanion", request: "launch", name: launchName,
        target: "${workspaceFolder}/integration-audit-v1/audit.robot"
      }], vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test("changing the execution descriptor stops a running owned session", async () => {
    await configure("owned", descriptor());
    assert.equal(await vscode.debug.startDebugging(folder, launchName), true);
    await until(() => debug.sessions.size === 1 && [...debug.sessions.values()][0].adapter.capabilities, "session running");
    const child = [...debug.sessions.values()][0].adapter.child;
    await config.update("executionBackend", descriptor({ debug: { executable: process.execPath, argv: [
      path.join(extension.extensionPath, "tests/integration/fixtures/dap/server.js"), "full"
    ], transport: "stdio" } }), vscode.ConfigurationTarget.WorkspaceFolder);
    await until(() => debug.sessions.size === 0, "session stopped after descriptor change");
    await until(() => child.exitCode !== null || child.signalCode !== null, "old process exited");
    evidence.push({ cleanup: "descriptor change", exitCode: child.exitCode, signal: child.signalCode });
  });
});

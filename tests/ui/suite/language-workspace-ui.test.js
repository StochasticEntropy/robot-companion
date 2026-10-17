"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function updateFolders(start, count, ...folders) {
  let changed = false;
  const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { changed = true; });
  try {
    assert.equal(vscode.workspace.updateWorkspaceFolders(start, count, ...folders), true);
    await until(() => changed, "workspace folder update event");
  } finally { listener.dispose(); }
}

suite("Owned language lifecycle (local protocol fixture; not Robot backend acceptance)", () => {
  let extension, manager, config, folder, audit, cdp;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const descriptor = (mode = "language-ui") => ({
    id: "local-protocol-fixture", version: "1", contractVersion: 1,
    workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, env: {},
    services: { language: { executable: process.execPath, argv: [
      path.join(extension.extensionPath, "tests/integration/fixtures/protocol/server.js"), mode
    ], transport: "stdio" } }
  });
  // Electron's executable cannot run the Node fixture without this environment.
  async function owned(mode = "language-ui") {
    const input = descriptor(mode); input.env.ELECTRON_RUN_AS_NODE = "1";
    await config.update("languageBackend", input, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "fixture running");
    return manager.roots.get(folder.uri.toString());
  }
  async function openAudit() {
    audit = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot"));
    await vscode.window.showTextDocument(audit, { preview: false });
    assert.equal(audit.languageId, "robotframework");
    return audit;
  }
  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function clickKeyword(text, modifiers = 0) {
    let point;
    await until(async () => {
      point = await page(`(() => {
        const line = [...document.querySelectorAll('.monaco-editor .view-line')]
          .find(el => el.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(text)}));
        if (!line) return;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          const start = node.textContent.replaceAll('\\u00a0', ' ').indexOf(${JSON.stringify(text)});
          if (start < 0) continue;
          const range = document.createRange(); range.setStart(node, start + 1); range.setEnd(node, start + 3);
          const rect = range.getBoundingClientRect();
          if (!rect.width || rect.top < 0 || rect.bottom > innerHeight) return;
          return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        }
      })()`);
      return point;
    }, `visible keyword ${text}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, modifiers,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(250);
    }
    evidence.push({ action: modifiers ? "Ctrl-click" : "click", text, point });
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
    fs.writeFileSync(path.join(evidenceDirectory, name + ".png"), Buffer.from(data, "base64"));
  }

  suiteSetup(async () => {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    assert.equal(vscode.extensions.getExtension("d-biehl.robotcode"), undefined, "RobotCode extension must be absent");
    assert.equal(vscode.extensions.getExtension("robocorp.robotframework-lsp"), undefined);
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    cdp = await WebviewCdp.connect();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node },
      backend: "local Node protocol fixture only", externalRobotExtensions: "absent",
      viewport: await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`) });
  });
  teardown(async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert");
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    assert.equal(manager.roots.size, 0);
  });
  suiteTeardown(async () => {
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "language-ui-actions.json"), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("coexistence starts nothing; malformed owned descriptor reports an actionable failure", async () => {
    await manager.queue;
    assert.equal(manager.roots.size, 0);
    await config.update("languageBackend", { contractVersion: 9 }, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    const root = manager.roots.get(folder.uri.toString());
    assert.match(root.error, /contract version/);
    assert.equal(root.session, undefined);
    assert.equal(root.definitionRegistration, undefined);
  });

  test("actual editor pointer + F12, Peek and Ctrl-click use the backend source range", async () => {
    const root = await owned();
    await openAudit();
    await clickKeyword("Build Record");
    await key("F12", "F12", 123);
    await until(() => vscode.window.activeTextEditor?.document.uri.path.endsWith("AuditLibrary.py") &&
      vscode.window.activeTextEditor.selection.active.line === 11 &&
      vscode.window.activeTextEditor.selection.active.character === 4, "F12 target and selection");
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 11);
    assert.equal(vscode.window.activeTextEditor.selection.active.character, 4);
    evidence.push({ result: "F12", uri: vscode.window.activeTextEditor.document.uri.toString(), line: 11, character: 4 });
    await screenshot("fixture-f12-target");
    await openAudit();
    await clickKeyword("Build Record");
    await key("F10", "F10", 121, 10); // Linux Ctrl+Shift+F10: Peek Definition
    await until(() => page(`Boolean(document.querySelector('.peekview-widget .monaco-editor'))`), "Peek widget");
    const peekText = await page(`document.querySelector('.peekview-widget').innerText`);
    assert.match(peekText, /AuditLibrary/);
    assert.doesNotMatch(peekText, /AShadow/);
    evidence.push({ result: "Peek", text: peekText.slice(0, 400) });
    await screenshot("fixture-peek");
    await key("Escape", "Escape", 27);
    await until(() => page(`!document.querySelector('.peekview-widget')`), "Peek closed");
    await clickKeyword("Resource Step", 2); // Linux Ctrl+click
    await until(() => vscode.window.activeTextEditor?.document.uri.path.endsWith("shared.resource") &&
      vscode.window.activeTextEditor.selection.active.line === 1, "Ctrl-click target and selection");
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);
    evidence.push({ result: "Ctrl-click", uri: vscode.window.activeTextEditor.document.uri.toString(), line: 1,
      focused: await page(`document.activeElement?.className`) });
    const child = root.session.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    assert.equal(root.session.state, "stopped");
    assert.notEqual(child.exitCode, null);
    assert.equal(root.registrations.length, 0);
    assert.equal(manager.roots.size, 0);
    evidence.push({ cleanup: "coexistence", processExitCode: child.exitCode, roots: 0 });
  });

  test("UTF-16 edits synchronize; stale definitions and cancelled requests are discarded", async () => {
    const root = await owned();
    await openAudit();
    const initial = await root.session.request("fixture/documents", {});
    assert.equal(initial.find(doc => doc.uri === audit.uri.toString()).text, audit.getText());
    await root.session.request("fixture/delayDefinition", 200);
    const token = new vscode.CancellationTokenSource();
    const stale = manager.definition(audit, new vscode.Position(11, 20), token.token);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(audit.uri, new vscode.Position(5, 0), "# Ä😀\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await stale, undefined);
    const documents = await root.session.request("fixture/documents", {});
    const synced = documents.find(doc => doc.uri === audit.uri.toString());
    assert.equal(synced.text, audit.getText());
    assert.equal(synced.version, audit.version);
    const cancelled = manager.definition(audit, new vscode.Position(12, 20), token.token);
    token.cancel();
    assert.equal(await cancelled, undefined);
    token.dispose();
    assert.equal(root.session.pending.size, 0);
  });

  test("restart kills its old process; unsupported definitions register no provider", async () => {
    let root = await owned();
    const child = root.session.child;
    await vscode.commands.executeCommand("robotCompanion.restartLanguageService");
    assert.notEqual(child.exitCode, null);
    root = manager.roots.get(folder.uri.toString());
    assert.notEqual(root.session.child.pid, child.pid);
    root = await owned("language-no-definition");
    assert.equal(root.definitionRegistration, undefined);
    assert.equal(root.session.capabilities.definitionProvider, false);
    evidence.push({ cleanup: "restart", oldExitCode: child.exitCode,
      unsupportedDefinitionRegistrations: root.definitionRegistration ? 1 : 0 });
  });

  test("versioned diagnostics clear on edits and mode exit; save and file changes reach the process", async () => {
    const root = await owned();
    await openAudit();
    const params = { uri: audit.uri.toString(), version: audit.version,
      diagnostics: [{ message: "Protocol fixture diagnostic", severity: 2,
        range: { start: { line: 11, character: 17 }, end: { line: 11, character: 29 } } }] };
    await root.session.request("fixture/publishDiagnostics", params);
    await until(() => vscode.languages.getDiagnostics(audit.uri).length === 1, "fixture diagnostic");
    const edit = new vscode.WorkspaceEdit(); edit.insert(audit.uri, new vscode.Position(0, 0), "# edited\n");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(vscode.languages.getDiagnostics(audit.uri).length, 0);
    await root.session.request("fixture/publishDiagnostics", params);
    assert.equal(vscode.languages.getDiagnostics(audit.uri).length, 0, "old diagnostic version must be dropped");
    assert.equal(await audit.save(), true);
    await until(async () => (await root.session.request("fixture/events", {})).some(event =>
      event.method === "textDocument/didSave" && event.params.text === audit.getText()), "save notification");
    const probe = vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "watch-probe.resource");
    try {
      await vscode.workspace.fs.writeFile(probe, Buffer.from("*** Keywords ***\n"));
      await until(async () => (await root.session.request("fixture/events", {})).some(event =>
        event.method === "workspace/didChangeWatchedFiles" && event.params.changes.some(change => change.uri === probe.toString())),
      "file change notification");
    } finally { await vscode.workspace.fs.delete(probe); }
    params.version = audit.version;
    await root.session.request("fixture/publishDiagnostics", params);
    await until(() => vscode.languages.getDiagnostics(audit.uri).length === 1, "current diagnostic");
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    assert.equal(vscode.languages.getDiagnostics(audit.uri).length, 0);
    evidence.push({ diagnostics: "current accepted; stale dropped; edit/exit cleared", save: "text included", watchedFiles: "received" });
  });

  test("a definition in flight cannot escape an owned-to-coexistence transition", async () => {
    const root = await owned();
    await openAudit();
    await root.session.request("fixture/delayDefinition", 250);
    const token = new vscode.CancellationTokenSource();
    const pending = manager.definition(audit, new vscode.Position(11, 20), token.token);
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal(await pending, undefined);
    await manager.queue;
    assert.equal(root.session.child, undefined);
    token.dispose();
  });

  test("mode exit stops a backend during initialization without waiting for the request timeout", async () => {
    const input = descriptor("hang-initialize"); input.env.ELECTRON_RUN_AS_NODE = "1";
    await config.update("languageBackend", input, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "starting", "initializing backend");
    const root = manager.roots.get(folder.uri.toString()), child = root.session.child;
    const started = Date.now();
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    assert.ok(Date.now() - started < 2000, "mode exit must not await the 10-second initialize timeout");
    assert.equal(root.session.child, undefined);
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    assert.equal(manager.roots.size, 0);
    evidence.push({ cleanup: "mode exit during initialization", elapsedMs: Date.now() - started,
      exitCode: child.exitCode, signal: child.signalCode });
  });

  test("nested workspace roots send definitions and file events only to their owning backend", async () => {
    await owned();
    await openAudit();
    const nested = vscode.Uri.joinPath(folder.uri, "integration-audit-v1");
    const settingsDirectory = vscode.Uri.joinPath(nested, ".vscode");
    const input = descriptor(); input.workspaceUri = nested.toString(); input.env.ELECTRON_RUN_AS_NODE = "1";
    await vscode.workspace.fs.createDirectory(settingsDirectory);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(settingsDirectory, "settings.json"), Buffer.from(JSON.stringify({
      "robotCompanion.integrationMode": "owned", "robotCompanion.languageBackend": input
    })));
    const probe = vscode.Uri.joinPath(nested, "nested-watch-probe.resource");
    try {
      await updateFolders(vscode.workspace.workspaceFolders.length, 0, { uri: nested, name: "nested-audit" });
      await until(() => manager.roots.get(nested.toString())?.session?.state === "running", "nested root running");
      const parent = manager.roots.get(folder.uri.toString());
      const child = manager.roots.get(nested.toString());
      const before = await child.session.request("fixture/definitionCount", {});
      const callLine = audit.getText().split("\n").findIndex(line => line.includes("Build Record"));
      assert.ok(callLine >= 0);
      const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", audit.uri, new vscode.Position(callLine, 20));
      assert.equal(definitions.length, 1);
      assert.equal(await child.session.request("fixture/definitionCount", {}), before + 1,
        "overlapping parent selector must not duplicate a child-root request");
      assert.equal(await parent.session.request("fixture/definitionCount", {}), 0);
      await vscode.workspace.fs.writeFile(probe, Buffer.from("*** Keywords ***\n"));
      const hasProbe = events => events.some(event => event.method === "workspace/didChangeWatchedFiles" &&
        event.params.changes.some(change => change.uri === probe.toString()));
      await until(async () => hasProbe(await child.session.request("fixture/events", {})), "nested file event");
      await sleep(150); // Allow the overlapping parent watcher to deliver its event, if any.
      assert.equal(hasProbe(await parent.session.request("fixture/events", {})), false);
      evidence.push({ nestedRoots: "one child definition request; no parent definition/file event" });
    } finally {
      const index = vscode.workspace.workspaceFolders.findIndex(item => item.uri.toString() === nested.toString());
      if (index >= 0) {
        await updateFolders(index, 1);
        await until(() => !manager.roots.has(nested.toString()) && manager.roots.get(folder.uri.toString())?.session?.state === "running",
          "nested root removed");
      }
      await vscode.workspace.fs.delete(probe).then(() => {}, () => {});
      await vscode.workspace.fs.delete(settingsDirectory, { recursive: true });
    }
  });

  test("definition boundary rejects malformed ranges and executable URI schemes", () => {
    const { normalizeDefinitions } = require(path.join(extension.extensionPath, "src/integration/language-workspace"));
    assert.throws(() => normalizeDefinitions({ uri: "command:workbench.action.terminal.new", range: {} }), /file/);
    assert.throws(() => normalizeDefinitions({ uri: audit.uri.toString(), range: {
      start: { line: -1, character: 0 }, end: { line: 1, character: 0 }
    } }), /source range/);
    assert.throws(() => normalizeDefinitions({ uri: audit.uri.toString(), range: {
      start: { line: 1, character: 5 }, end: { line: 1, character: 2 }
    } }), /source range/);
    assert.deepEqual(normalizeDefinitions(null), []);
  });
});

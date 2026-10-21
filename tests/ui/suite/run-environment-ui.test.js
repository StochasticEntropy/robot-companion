const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vscode = require("vscode");
const { EnvironmentCdp, sleep } = require("./environment-cdp");
const { STATE_KEY } = require("../../../src/features/run/environment-core");
const readRun = result => JSON.parse(fs.readFileSync(path.join(result.outputDir, "invocation.json"), "utf8"));
suite("Robot environment selection", function () {
  this.timeout(90000);
  let environment, runApi, uri, root, python, cdp, editor, modulePath;
  const config = () => vscode.workspace.getConfiguration("robotCompanion", uri);
  const calls = executable => fs.existsSync(path.join(path.dirname(executable), "calls.jsonl")) ? fs.readFileSync(path.join(path.dirname(executable), "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  function fixture(executable, mode = "healthy") {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    const source = fs.readFileSync(path.join(modulePath, "tests/fixtures/environment/synthetic-python.js"), "utf8").replace("#!/usr/bin/env node", `#!${process.env.npm_node_execpath || "/usr/local/bin/node"}`);
    fs.writeFileSync(executable, source, { mode: 0o755 }); fs.writeFileSync(path.join(path.dirname(executable), "mode"), mode); return executable;
  }
  const choose = async text => { await cdp.filter(text); await cdp.key("Enter"); };
  const pickerOpen = async () => cdp.wait("!!document.querySelector('.quick-input-widget input') && document.querySelector('.quick-input-widget').textContent.includes('Select Robot Environment')");
  const pickerClosed = async () => cdp.wait("!document.querySelector('.quick-input-widget') || getComputedStyle(document.querySelector('.quick-input-widget')).display === 'none'");
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion"); await extension.activate(); modulePath = extension.extensionPath;
    runApi = require(path.join(modulePath, "src/features/run")).__test__; environment = runApi.getEnvironmentForTest();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    uri = vscode.Uri.file(path.join(root, "run-robot-sample.robot"));
    for (const name of [".venv", "venv", "env"]) fixture(path.join(root, name, "bin/python"), name === "env" ? "missing" : "healthy");
    python = path.join(root, ".venv/bin/python");
    await config().update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    cdp = await EnvironmentCdp.connect();
  });
  suiteTeardown(async () => {
    // Later suites in the combined UI run check their own window size (1280x900): restore it.
    try { await cdp?.resize(1280, 900); } catch (error) { console.log(`Window size not restored: ${error.message}`); }
    cdp?.close(); environment.pool.invalidate();
    await environment.context.workspaceState.update(STATE_KEY, {});
    await config().update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    await config().update("robotArguments", undefined, vscode.ConfigurationTarget.Workspace);
    // Remove the second root this suite added: later suites check that coexistence leaves no owned root.
    const added = (vscode.workspace.workspaceFolders || []).findIndex(folder => path.basename(folder.uri.fsPath).startsWith("robot-env-second-"));
    if (added > 0) { vscode.workspace.updateWorkspaceFolders(added, 1); await sleep(500); }
    environment.invalidate();
    // The reset choice restarts this folder's native services (project-environment.js): let the
    // reconciliation and those restarts finish before the next suite starts its own checks.
    const api = require(path.join(modulePath, "src/core/extension")).__test__;
    await api.getProjectEnvironmentsForTest().queue;
    await sleep(200);
    await Promise.all([api.getLanguageWorkspaceForTest().queue, api.getTestWorkspaceForTest().queue, api.getDebugWorkspaceForTest().statusQueue]);
  });
  test("native status click, keyboard custom-path Back/Escape and selection preserve editor at both desktop sizes", async () => {
    editor.selection = new vscode.Selection(8, 4, 8, 4);
    for (const [width, height] of [[1440, 900], [1024, 768]]) {
      await cdp.resize(width, height); await environment.refreshStatus();
      // The editor relayouts after a native resize; capture its position once that has settled.
      for (let previous; !previous || !previous.isEqual(editor.visibleRanges[0]); await sleep(250)) previous = editor.visibleRanges[0];
      const selection = editor.selection, visible = editor.visibleRanges[0];
      await cdp.click("[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))");
      await pickerOpen(); await cdp.wait("document.querySelector('.quick-input-widget').textContent.includes('Robot Framework 7.3.2')");
      await cdp.retain(`picker-${width}`);
      await choose("Enter path"); await cdp.wait("document.querySelector('.quick-input-widget').textContent.includes('Choose executable type')");
      await cdp.key("Enter"); await cdp.text("/Prüfung Umgebung mit Leerzeichen $(literal);/python");
      await cdp.retain(`custom-${width}`);
      await cdp.click("document.querySelector('.quick-input-widget .codicon-quick-input-back')");
      await cdp.wait("document.querySelector('.quick-input-widget').textContent.includes('Choose executable type')");
      await cdp.click("document.querySelector('.quick-input-widget .codicon-quick-input-back')"); await pickerOpen();
      assert.equal(await cdp.eval("document.querySelector('.quick-input-widget input').value"), "Enter path");
      await cdp.key("Escape"); await pickerClosed(); assert.deepStrictEqual(editor.selection, selection); assert.deepStrictEqual(editor.visibleRanges[0], visible);
      // Escape returns keyboard focus to the editor.
      await cdp.wait("!!document.activeElement?.closest('.monaco-editor')");
      assert.equal(environment.saved(uri), undefined);
      await cdp.palette("Robot Companion: Select Robot Environment"); await pickerOpen();
      await cdp.wait("document.querySelector('.quick-input-widget').textContent.includes('Robot Framework 7.3.2')");
      await choose(".venv"); await pickerClosed(); assert.equal(environment.saved(uri).path, python);
      // The visible status names the choice; its accessible tooltip carries the full identity.
      const statusItem = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
      await cdp.wait(`${statusItem}?.textContent.startsWith('Robot: .venv (3.13.7)')`);
      const label = await cdp.eval(`${statusItem}.getAttribute('aria-label')`);
      for (const part of [`Folder: ${vscode.workspace.workspaceFolders[0].uri.toString()}`, "Source: saved", python, "Robot Framework 7.3.2"]) assert(label.includes(part), label);
      await cdp.retain(`selected-${width}`);
      // Escape keeps an existing saved choice.
      await cdp.click(statusItem); await pickerOpen(); await cdp.key("Escape"); await pickerClosed();
      assert.equal(environment.saved(uri).path, python);
      await environment.context.workspaceState.update(STATE_KEY, {}); environment.invalidate();
    }
  });
  test("two quick native status clicks leave a visible picker at 1024x768", async () => {
    await cdp.resize(1024, 768); await environment.refreshStatus();
    const statusItem = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
    for (const gap of [40, 120]) {
      await cdp.doubleClick(statusItem, gap); await pickerOpen();
      // A superseded flow finishes after the second picker opens; it must not take focus away from it.
      await sleep(1500);
      assert(await cdp.eval("!!document.querySelector('.quick-input-widget') && getComputedStyle(document.querySelector('.quick-input-widget')).display !== 'none' && document.querySelector('.quick-input-widget').textContent.includes('Select Robot Environment')"), `picker hidden after two clicks ${gap} ms apart`);
      assert(await cdp.eval("document.activeElement?.matches('.quick-input-widget input')"), `picker input lost focus after two clicks ${gap} ms apart`);
      await cdp.retain(`double-click-${gap}`);
      await cdp.key("Escape"); await pickerClosed(); await cdp.wait("!!document.activeElement?.closest('.monaco-editor')"); assert.equal(environment.saved(uri), undefined);
    }
  });
  test("saved Python is used by Run Test and Run Suite with literal arguments; executable choice remains exact", async () => {
    const literalDir = path.join(root, "Umgebung ü $(literal); mit Leerzeichen");
    const custom = fixture(path.join(literalDir, "python"));
    await cdp.palette("Robot Companion: Select Robot Environment"); await pickerOpen(); await choose("Enter path"); await cdp.key("Enter"); await cdp.text(custom); await cdp.key("Enter"); await pickerClosed();
    assert.equal(environment.saved(uri).path, custom);
    await config().update("robotArguments", ["--name", "$(touch sentinel); Prüfung"], vscode.ConfigurationTarget.Workspace);
    for (const [command, args] of [["robotCompanion.runTest", [uri.toString(), "Sum * Check"]], ["robotCompanion.runSuite", [uri.toString()]]]) {
      const result = await vscode.commands.executeCommand(command, ...args); assert.equal(result.status, "completed"); assert.equal(result.executable, custom);
      const invocation = readRun(result); assert.deepStrictEqual(invocation.argv.slice(0, 2), ["-m", "robot"]); assert(invocation.argv.includes("$(touch sentinel); Prüfung"));
    }
    assert(!fs.existsSync(path.join(root, "sentinel")));
    await environment.save(uri, { version: 1, kind: "executable", path: custom, label: "Custom executable" });
    const result = await vscode.commands.executeCommand("robotCompanion.runSuite", uri); assert(!readRun(result).argv.includes("-m"));
    await config().update("robotArguments", undefined, vscode.ConfigurationTarget.Workspace);
  });
  test("explicit robotCommand overrides saved choice and removal resumes it", async () => {
    await environment.save(uri, { version: 1, kind: "python", path: python, label: ".venv" });
    for (const scope of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) {
      await config().update("robotCommand", '"' + python + '"', scope);
      const target = await environment.resolve(uri); assert.equal(target.source, "setting"); assert.equal(target.maskedSelection.executable, python);
      const result = await vscode.commands.executeCommand("robotCompanion.runSuite", uri); assert(!readRun(result).argv.includes("-m"));
      await config().update("robotCommand", undefined, scope);
    }
    assert.equal((await environment.resolve(uri)).source, "saved");
  });
  test("missing Robot notification Install requests named confirmation; Cancel starts nothing, Confirm runs only captured pip", async () => {
    // Test hosts refuse modal prompts; tests/ui/run-install-confirmation.js drives the real modal.
    await vscode.window.showTextDocument(uri);
    const missing = path.join(root, "env/bin/python"), recorders = [".venv", "venv", "env"].map(name => path.join(root, name, "bin/python"));
    fs.writeFileSync(path.join(path.dirname(missing), "mode"), "missing");
    await environment.save(uri, { version: 1, kind: "python", path: missing, label: "env" });
    const pip = () => recorders.flatMap(calls).filter(c => c.argv[1] === "pip");
    const original = vscode.window.showWarningMessage, prompts = [];
    let answer;
    vscode.window.showWarningMessage = async (message, options, ...items) => { prompts.push({ message, options, items }); return answer; };
    const viaNotification = async name => {
      await vscode.commands.executeCommand("notifications.clearAll"); await sleep(1000); // VS Code drops toasts beyond 3 per 800 ms.
      assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", uri)).status, "environmentUnavailable");
      await cdp.wait("document.querySelector('.notifications-toasts')?.textContent.includes('Robot Framework is not installed in')");
      await cdp.away(); if (name) await cdp.retain(name);
      const count = prompts.length;
      await cdp.click("[...document.querySelectorAll('.notifications-toasts .monaco-button')].find(el => el.textContent.trim() === 'Install robotframework')");
      for (let i = 0; prompts.length === count && i < 50; i++) await sleep(100);
      const prompt = prompts[count];
      assert.equal(prompt.message, "Install robotframework in this Python environment?"); assert.equal(prompt.options.modal, true);
      assert(prompt.options.detail.includes(missing)); assert(prompt.options.detail.includes("-m pip install robotframework")); assert.deepStrictEqual(prompt.items, ["Install robotframework"]);
    };
    try {
      answer = undefined; await viaNotification("missing-robot-error"); await sleep(500);
      assert.equal(pip().length, 0); assert.equal((await environment.resolve(uri, true, true)).availability.state, "missingRobot"); assert.equal(environment.saved(uri).path, missing);
      answer = "Install robotframework"; await viaNotification();
      await cdp.wait("document.querySelector('.notifications-toasts')?.textContent.includes('Robot Framework is available in')", 20000); await cdp.retain("install-success");
    } finally { vscode.window.showWarningMessage = original; }
    const installs = pip(); assert.equal(installs.length, 1);
    assert.deepStrictEqual(installs[0], { executable: missing, argv: ["-m", "pip", "install", "robotframework"], cwd: fs.realpathSync(root) });
    assert.equal((await environment.resolve(uri, true, true)).availability.state, "available");
    if (process.env.ROBOT_COMPANION_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.ROBOT_COMPANION_EVIDENCE_DIR, "install-recorder-calls.json"), JSON.stringify(Object.fromEntries(recorders.map(r => [r, calls(r)])), null, 2));
  });
  test("deleted/failed/timed-out Python never falls back; changing folder cancels tentative choice", async () => {
    const deleted = fixture(path.join(root, "deleted/python")); await environment.save(uri, { version: 1, kind: "python", path: deleted }); fs.unlinkSync(deleted); environment.pool.invalidate();
    await environment.refreshStatus();
    for (const width of [1024, 1280]) {
      await cdp.resize(width, 900);
      const statusItem = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
      await cdp.wait(`${statusItem}?.textContent.endsWith(' — unavailable')`);
      const label = await cdp.eval(`${statusItem}.getAttribute('aria-label')`);
      assert(label.includes(deleted) && label.includes("Unavailable — executable not found or cannot start"), label);
      await cdp.wait("document.getElementById('status.languageStatus')?.getBoundingClientRect().width > 0");
      await cdp.retain(`unavailable-status-${width}`);
    }
    assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", uri)).status, "environmentUnavailable");
    for (const mode of ["failed", "hung"]) {
      const executable = fixture(path.join(root, mode, "python"), mode); const start = Date.now();
      assert.equal((await environment.pool.probe({ executable, args: ["-m", "robot"], kind: "python" }, root)).state, mode === "hung" ? "timedOut" : "checkFailed"); assert(Date.now() - start < 2500);
    }
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "robot-env-second-")); const otherUri = vscode.Uri.file(path.join(other, "other.robot")); fs.writeFileSync(otherUri.fsPath, "*** Test Cases ***\nOther\n    No Operation\n");
    // Adding a non-first root preserves the extension host.
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.file(other), name: "Same name" }); await sleep(300);
    await vscode.window.showTextDocument(uri); const before = environment.saved(uri);
    await cdp.palette("Robot Companion: Select Robot Environment"); await pickerOpen(); await choose("Enter path"); await cdp.key("Enter"); await cdp.text(python);
    await vscode.window.showTextDocument(otherUri); await sleep(400); await pickerClosed(); assert.deepStrictEqual(environment.saved(uri), before); assert.equal(environment.saved(otherUri), undefined);
    const b = fixture(path.join(other, ".venv/bin/python")); await environment.save(otherUri, { version: 1, kind: "python", path: b });
    assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", otherUri)).executable, b);
    await vscode.window.showTextDocument(uri); assert.equal(environment.saved(uri).path, deleted);
    await vscode.commands.executeCommand("workbench.action.navigateBack"); await sleep(200); await vscode.commands.executeCommand("workbench.action.navigateForward");
    await vscode.window.showTextDocument(uri); await environment.save(uri, { version: 1, kind: "python", path: python });
    const text = vscode.Uri.file(path.join(root, "notes.txt")); fs.writeFileSync(text.fsPath, "notes"); await vscode.window.showTextDocument(text); await sleep(200);
    assert(!await cdp.eval("[...document.querySelectorAll('.statusbar-item a')].some(el => el.textContent.startsWith('Robot:'))"));
    await vscode.window.showTextDocument(uri);
  });
  test("trust changes after confirmation and after runner awaits prevent execution", async () => {
    const missing = fixture(path.join(root, "trust-race/python"), "missing");
    await environment.save(uri, { version: 1, kind: "python", path: missing });
    const captured = await environment.resolve(uri, true), original = vscode.window.showWarningMessage;
    // VS Code namespace is mutable in the extension host; fixture confirmation proves boundary timing.
    vscode.window.showWarningMessage = async () => { runApi.setWorkspaceTrustOverrideForTest(false); return "Install robotframework"; };
    try { assert.equal(await environment.install(uri, captured), false); assert.equal(calls(missing).filter(c => c.argv[1] === "pip").length, 0); }
    finally { vscode.window.showWarningMessage = original; runApi.setWorkspaceTrustOverrideForTest(undefined); }
    const runner = environment.runner, originalDirectory = runner._createRunDirectory.bind(runner);
    await environment.save(uri, { version: 1, kind: "python", path: python });
    runner._createRunDirectory = async () => { const d = await originalDirectory(); runApi.setWorkspaceTrustOverrideForTest(false); return d; };
    const before = calls(python).filter(c => c.argv[1] === "robot").length;
    try { assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", uri)).status, "untrusted"); assert.equal(calls(python).filter(c => c.argv[1] === "robot").length, before); }
    finally { runner._createRunDirectory = originalDirectory; runApi.setWorkspaceTrustOverrideForTest(undefined); }
  });
});

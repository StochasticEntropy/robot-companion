"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activatedExtensionApi } = require("./activated-extension-api");
const { WebviewCdp } = require("./webview-cdp");

const CORPUS = [
  "*** Settings ***", "Library    OperatingSystem", "",
  "*** Variables ***", "${record.name}    example", "",
  "*** Test Cases ***", "Baseline Colors", "    Log    ${record.name}[0]",
  "    IF    ${True}", "        Log    ready    # inline comment", "    END",
  "    ...    continued", "# standalone comment", "",
  "*** Keywords ***", "Local Step", "    Log    local", "",
  "| *** Test Cases *** |", "| Pipe Example |", "| | Log | ${record.name}[0] |",
  "| | IF | ${True} |", "| | END |", "", "*** Test Cases ***", "Assignment And Tabs", "    ${vorbereitung}=    Set Variable    IF", "\tLog\t${vorbereitung}", "    [Documentation]    text", "", "| *** Settings *** |", "| Library | OperatingSystem |", "| *** Test Cases *** |", "| More Pipe Cells |", "| | Log | IF | # pipe comment |", ""
].join("\n");

suite("Robot baseline grammar without a backend", () => {
  test("the real token inspector shows section, names, variables, comments and flow in space and pipe format", async function () {
    this.timeout(90000);
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion");
    await extension.activate();
    const api = activatedExtensionApi(extension.extensionPath);
    const folder = vscode.workspace.workspaceFolders[0];
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const previous = Object.fromEntries(["integrationMode", "languageBackend", "nativeBackendExecutable"].map(key =>
      [key, config.inspect(key).workspaceFolderValue]));
    const uri = vscode.Uri.joinPath(folder.uri, "baseline-grammar.robot");
    let cdp;
    const evidence = [];
    const directory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
    async function page(expression) {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, cdp.pageSession);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function until(predicate, label) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`Timed out: ${label}`);
    }
    async function screenshot(name) {
      if (!directory) return;
      const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
      fs.writeFileSync(path.join(directory, `robot-grammar-${name}.png`), Buffer.from(data, "base64"));
    }
    try {
      await config.update("nativeBackendExecutable", "/nonexistent/robot-companion-backend", vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
      await api.getLanguageWorkspaceForTest().queue;
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(CORPUS));
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.languageId, "robotframework");
      assert.equal(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", uri), undefined,
        "no running backend supplies semantic tokens");
      assert.equal(api.getLanguageWorkspaceForTest().roots.get(folder.uri.toString()).session?.state === "running", false);
      assert.ok(extension.packageJSON.contributes.grammars.some(grammar => grammar.language === "robotframework" &&
        grammar.scopeName === "source.robotframework"));
      cdp = await WebviewCdp.connect();
      await vscode.commands.executeCommand("notifications.clearAll");
      for (const [line, token, scope, forbiddenScope] of [
        [0, "Settings", "keyword.control.section.robotframework"], [1, "Library", "keyword.other.setting.robotframework"],
        [7, "Baseline", "entity.name.function.test.robotframework"], [8, "Log", "entity.name.function.call.robotframework"],
        [8, "record.name", "variable.other.robotframework"], [9, "IF", "keyword.control.robotframework"],
        [10, "inline comment", "comment.line.number-sign.robotframework"], [12, "...", "keyword.control.continuation.robotframework"],
        [16, "Local", "entity.name.function.robotframework"], [19, "Test Cases", "keyword.control.section.robotframework"],
        [20, "Pipe Example", "entity.name.function.test.robotframework"], [21, "record.name", "variable.other.robotframework"],
        [22, "IF", "keyword.control.robotframework"], [27, "vorbereitung", "variable.other.robotframework"],
        [28, "Log", "entity.name.function.call.robotframework"], [29, "Documentation", "keyword.other.setting.robotframework"],
        [27, "IF", "meta.section.tests.robotframework", "keyword.control.robotframework"],
        [32, "Library", "keyword.other.setting.robotframework"], [35, "Log", "entity.name.function.call.robotframework"],
        [35, "IF", "meta.section.tests.robotframework", "keyword.control.robotframework"],
        [35, "pipe comment", "comment.line.number-sign.robotframework"]
      ]) {
        const character = document.lineAt(line).text.indexOf(token) + 1;
        await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, character, line, character) });
        await vscode.commands.executeCommand("editor.action.inspectTMScopes");
        let shown;
        await until(async () => {
          shown = await page(`(() => { const widget = document.querySelector('.token-inspect-widget');
            return widget?.getClientRects().length ? widget.innerText : undefined; })()`);
          return shown?.includes(scope);
        }, `${token} has ${scope}`);
        if (forbiddenScope) assert.equal(shown.includes(forbiddenScope), false, "an argument cell is not control syntax");
        evidence.push({ line: line + 1, token, scope, forbiddenScope, inspector: shown });
        if (line === 8 && token === "record.name") await screenshot("unavailable-backend-inspector");
        // Escape closes the inspector before selecting the next token.
        for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
          type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
        }, cdp.pageSession);
      }
      await screenshot("unavailable-backend-colors");
    } finally {
      if (directory) fs.writeFileSync(path.join(directory, "robot-grammar-inspectors.json"), JSON.stringify(evidence, null, 2));
      cdp?.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.workspace.fs.delete(uri).catch(() => {});
      for (const [key, value] of Object.entries(previous)) await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });
});

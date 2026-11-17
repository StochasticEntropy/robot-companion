"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

suite("Large workspace navigation", () => {
  test("F12 returns the same resource and definition line on first use and repeated queries", async function () {
    this.timeout(90000);
    if (!process.env.ROBOT_COMPANION_NATIVE_BACKEND) return this.skip();
    const folder = vscode.workspace.workspaceFolders[0];
    const directory = fs.mkdtempSync(path.join(folder.uri.fsPath, "navigation-"));
    const settings = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion");
    const result = {};
    try {
      for (let i = 0; i < 600; ++i) {
        fs.writeFileSync(path.join(directory, i + ".resource"),
          "*** Keywords ***\n" + Array.from({ length: 10 }, (_, j) => "Action " + i + " Item " + j + "\n    No Operation\n").join(""));
      }
      const header = ["*** Settings ***", ...Array.from({ length: 40 }, (_, i) => "Resource    " + i + ".resource"),
        "*** Test Cases ***", "Large Case"];
      const calls = Array.from({ length: 3000 }, (_, i) => "    Action " + (i % 40) + " Item " + (i % 10));
      const uri = vscode.Uri.file(path.join(directory, "large.robot"));
      fs.writeFileSync(uri.fsPath, header.concat(calls).join("\n"));
      await extension.activate();
      const manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
      await settings.update("nativeBackendExecutable", process.env.ROBOT_COMPANION_NATIVE_BACKEND, vscode.ConfigurationTarget.WorkspaceFolder);
      await settings.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
      const doc = await vscode.workspace.openTextDocument(uri);
      const start = performance.now();
      await vscode.window.showTextDocument(doc);
      result.showDocumentMs = Math.round(performance.now() - start);
      result.definitionMs = [];
      for (let i = 0; i < 4; ++i) {
        const at = performance.now();
        const locations = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri,
          new vscode.Position(header.length + 2999, 8));
        result.definitionMs.push(Math.round(performance.now() - at));
        const hit = locations.find(loc => path.basename((loc.targetUri || loc.uri).fsPath) === "39.resource");
        assert.ok(hit, "last call resolves to imported resource 39");
        assert.equal((hit.targetSelectionRange || hit.range).start.line, 19);
      }
      result.files = 601;
      result.lines = doc.lineCount;
      console.log("Navigation timings", result);
      if (process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR) fs.writeFileSync(
        path.join(process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR, "navigation-times.json"), JSON.stringify(result, null, 2));
    } finally {
      await settings.update("integrationMode", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await settings.update("nativeBackendExecutable", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

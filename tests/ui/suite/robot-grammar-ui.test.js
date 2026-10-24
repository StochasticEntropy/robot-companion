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
  "| | IF | ${True} |", "| | END |", "", "*** Test Cases ***", "Assignment And Tabs", "    ${vorbereitung}=    Set Variable    IF", "\tLog\t${vorbereitung}", "    [Documentation]    text", "", "| *** Settings *** |", "| Library | OperatingSystem |", "| *** Test Cases *** |", "| More Pipe Cells |", "| | Log | IF | # pipe comment |", "    FOR    ${i}    IN RANGE    3", "    END", "    FOR    ${i}    IN ENUMERATE    items", "    END", "| | FOR | ${i} | IN ZIP | items |", "| | END |", "| | FOR | ${i} | IN | items |", "| | END |", ""
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
        [10, "inline comment", "comment.line.number-sign.robotframework"], [12, "...", "punctuation.separator.continuation.robotframework"],
        [16, "Local", "entity.name.function.robotframework"], [19, "Test Cases", "keyword.control.section.robotframework"],
        [20, "Pipe Example", "entity.name.function.test.robotframework"], [21, "record.name", "variable.other.robotframework"],
        [22, "IF", "keyword.control.robotframework"], [27, "vorbereitung", "variable.other.robotframework"],
        [28, "Log", "entity.name.function.call.robotframework"], [29, "Documentation", "keyword.other.setting.robotframework"],
        [27, "IF", "meta.section.tests.robotframework", "keyword.control.robotframework"],
        [32, "Library", "keyword.other.setting.robotframework"], [35, "Log", "entity.name.function.call.robotframework"],
        [35, "IF", "meta.section.tests.robotframework", "keyword.control.robotframework"],
        [35, "pipe comment", "comment.line.number-sign.robotframework"],
        ...["IN RANGE", "IN ENUMERATE", "IN ZIP", "IN"].map(token => [
          CORPUS.split("\n").findIndex(line => line.includes("FOR") && line.split(/ {2,}|\t+|[ \t]*\|[ \t]*/).includes(token)),
          token, "keyword.control.robotframework"
        ])
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

suite("Robot screenshot palette with and without native semantics", () => {
  test("the reference dark palette, live native ranges, user overrides and light/high-contrast themes remain usable", async function () {
    this.timeout(180000);
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion");
    await extension.activate();
    const manager = activatedExtensionApi(extension.extensionPath).getLanguageWorkspaceForTest();
    const folder = vscode.workspace.workspaceFolders[0];
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const prior = Object.fromEntries(["integrationMode", "languageBackend", "nativeBackendExecutable"].map(key => [key, config.inspect(key).workspaceFolderValue]));
    const editor = vscode.workspace.getConfiguration("editor");
    const previousColors = Object.fromEntries(["tokenColorCustomizations", "semanticTokenColorCustomizations"].map(key => [key, editor.inspect(key).workspaceValue]));
    const uri = vscode.Uri.joinPath(folder.uri, "reference-palette.robot");
    const text = ["*** Settings ***", "Library    Collections", "", "*** Variables ***", "${anzahlLeistungsfaelle}    1", "",
      "*** Test Cases ***", "Screenshot Palette", "    ${fall}=    Create Dictionary    id=9", "    FOR    ${i}    IN RANGE    ${anzahlLeistungsfaelle}",
      "        Log    ${fall.id}", "    END", "    Log    auslöser=SACHBEARBEITER    # grüner Kommentar",
      "    ...    erwarteteAnzahl=0", "    Log    \\${escaped}    ${fall}[${i}]", ""].join("\n");
    const evidence = [];
    const directory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
    const cdp = await WebviewCdp.connect();
    const page = async expression => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, cdp.pageSession);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    async function until(predicate, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`Timed out: ${label}`);
    }
    async function escape() {
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
        type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
      }, cdp.pageSession);
      await until(() => page(`!document.querySelector('.token-inspect-widget')?.getClientRects().length`), "inspector closes");
    }
    async function screenshot(name) {
      if (!directory) return;
      const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
      fs.writeFileSync(path.join(directory, `robot-palette-${name}.png`), Buffer.from(data, "base64"));
    }
    let document;
    async function inspect(line, token, offset = 1) {
      const column = document.lineAt(line).text.indexOf(token) + offset;
      assert.ok(column >= offset, `${token} occurs on line ${line + 1}`);
      await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, column, line, column) });
      await vscode.commands.executeCommand("editor.action.inspectTMScopes");
      let shown;
      await until(async () => {
        shown = await page(`(() => { const widget = document.querySelector('.token-inspect-widget');
          if (!widget?.getClientRects().length) return;
          const rows = [...widget.querySelectorAll('tr')].map(row => ({ key:row.querySelector('.tiw-metadata-key')?.innerText.trim(), value:row.querySelector('.tiw-metadata-value')?.innerText.trim() }));
          return {text:widget.innerText,foreground:rows.find(r => r.key === 'foreground')?.value, semanticType:rows.find(r => r.key === 'semantic token type')?.value}; })()`);
        return shown?.foreground;
      }, `${token} inspector foreground`);
      evidence.push({ line: line + 1, token, ...shown });
      await escape();
      return shown;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
      document = await vscode.workspace.openTextDocument(uri);
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Workspace);
      const targets = [
        [8, "Create Dictionary", "#DCDCAA"], [8, "fall", "#9CDCFE"], [8, "${", "#FFD700"],
        [8, "id=", "#9CDCFE"], [8, "9", "#CE9178", 0], [9, "FOR", "#C586C0"],
        [9, "IN RANGE", "#C586C0"], [12, "# grüner", "#6A9955"], [12, "auslöser", "#9CDCFE"],
        [12, "SACHBEARBEITER", "#CE9178"], [13, "...", "#D4D4D4"], [13, "0", "#CE9178", 0]
      ];
      for (const backend of ["unavailable", "native"]) {
        await config.update("nativeBackendExecutable", backend === "native" ? process.env.ROBOT_COMPANION_NATIVE_BACKEND : "/nonexistent/robot-companion-backend", vscode.ConfigurationTarget.WorkspaceFolder);
        await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
        await manager.queue;
        if (backend === "native") await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "native semantic service running");
        await vscode.commands.executeCommand("notifications.clearAll");
        assert.equal(Boolean(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", uri)), backend === "native");
        evidence.push({ backend, effectiveDefaults: editor.inspect("tokenColorCustomizations").defaultValue });
        for (const [line, token, expected, offset] of targets) {
          const shown = await inspect(line, token, offset ?? 1);
          assert.equal(shown.foreground.toUpperCase(), expected, `${backend}: ${token}`);
          if (backend === "native" && token === "fall") assert.equal(shown.semanticType, "variable");
          if (token === "${") assert.equal(shown.semanticType, undefined, "variable delimiter uses the grammar");
        }
        if (backend === "native") {
          const root = manager.roots.get(folder.uri.toString());
          const request = root.session.request;
          const responses = [];
          let holdNextFull = false, held, releaseHeld;
          root.session.request = async function (method, ...args) {
            const result = await request.call(this, method, ...args);
            if (method.startsWith("textDocument/semanticTokens/")) responses.push({ method, result: JSON.parse(JSON.stringify(result)) });
            if (holdNextFull && method.endsWith("/full")) {
              holdNextFull = false;
              held = result;
              await new Promise(resolve => { releaseHeld = resolve; });
            }
            return result;
          };
          const cancellation = new vscode.CancellationTokenSource();
          const markdownUri = vscode.Uri.joinPath(folder.uri, "presentation-regression.robot.md");
          try {
            const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", uri);
            const full = await manager.semanticTokens(document, undefined, legend, cancellation.token);
            const raw = responses.find(answer => answer.result.resultId === full.resultId).result;
            const cached = root.semanticResults.get(uri.toString());
            assert.deepEqual([...cached.data], raw.data, "live cache contains the exact raw full result");
            assert.notDeepEqual([...full.data], raw.data, "displayed Robot result differs only after caching");
            const cacheBeforeRange = { resultId: cached.resultId, data: [...cached.data] };
            const range = new vscode.Range(8, 0, 8, document.lineAt(8).text.length);
            const ranged = await manager.semanticTokens(document, range, legend, cancellation.token);
            const rawRange = responses.filter(answer => answer.method.endsWith("/range")).at(-1).result;
            assert.equal(ranged.resultId, rawRange.resultId, "range result ID is passed through");
            assert.notDeepEqual([...ranged.data], rawRange.data, "range presentation also leaves variable punctuation to grammar");
            assert.deepEqual({ resultId: root.semanticResults.get(uri.toString()).resultId, data: [...root.semanticResults.get(uri.toString()).data] }, cacheBeforeRange,
              "range presentation never replaces the raw delta base");
            await vscode.workspace.fs.writeFile(markdownUri, Buffer.from("# Presentation regression\n\n```robotframework\n" + text + "```\n"));
            const markdown = await vscode.workspace.openTextDocument(markdownUri);
            await vscode.window.showTextDocument(markdown, { preview: false });
            const markdownTokens = await manager.semanticTokens(markdown, undefined, legend, cancellation.token);
            const rawMarkdown = responses.find(answer => answer.result.resultId === markdownTokens.resultId).result;
            assert.deepEqual([...markdownTokens.data], rawMarkdown.data, "Markdown retains every raw native span");
            const activeEditor = await vscode.window.showTextDocument(document, { preview: false });
            holdNextFull = true;
            const delayed = manager.semanticTokens(document, undefined, legend, cancellation.token);
            await until(() => held && releaseHeld, "native full result held before client receipt");
            await activeEditor.edit(edit => edit.insert(new vscode.Position(0, 0), "# inserted during the request\n"));
            releaseHeld();
            assert.deepEqual([...(await delayed).data], [...full.data], "late reply uses request-time text, before VS Code moves its ranges");
            await vscode.commands.executeCommand("workbench.action.files.revert");
            assert.equal(document.getText(), text);
            evidence.push({ regression: "live full/range/raw-cache/Markdown", fullResultId: full.resultId,
              rawTokens: raw.data.length / 5, displayedTokens: full.data.length / 5, rangeId: ranged.resultId,
              markdownResultId: markdownTokens.resultId, markdownUnchanged: true });
          } finally {
            releaseHeld?.();
            root.session.request = request;
            cancellation.dispose();
            await vscode.workspace.fs.delete(markdownUri).catch(() => {});
          }
        }
        await screenshot(`${backend}-reference-colors`);
      }
      // Explicit user values at workspace scope must win over the contributed defaults.
      await editor.update("semanticTokenColorCustomizations", { rules: { "variable:robotframework": "#F38BA8" } }, vscode.ConfigurationTarget.Workspace);
      await editor.update("tokenColorCustomizations", { textMateRules: [{ scope: "punctuation.definition.variable.begin.robotframework", settings: { foreground: "#89B4FA" } }] }, vscode.ConfigurationTarget.Workspace);
      await new Promise(resolve => setTimeout(resolve, 500));
      const genericVariable = await inspect(8, "fall");
      assert.equal(genericVariable.foreground.toUpperCase(), "#F38BA8", "generic user semantic override wins");
      const genericPunctuation = await inspect(8, "${");
      evidence.push({ override: "generic user rules", variable: genericVariable.foreground, punctuation: genericPunctuation.foreground });
      await editor.update("semanticTokenColorCustomizations", { "[Default Dark+][Default Dark Modern][Dark+][Dark Modern]": { rules: { "variable:robotframework": "#F38BA8" } } }, vscode.ConfigurationTarget.Workspace);
      await editor.update("tokenColorCustomizations", { "[Default Dark+][Default Dark Modern][Dark+][Dark Modern]": { textMateRules: [{ scope: "punctuation.definition.variable.begin.robotframework", settings: { foreground: "#89B4FA" } }] } }, vscode.ConfigurationTarget.Workspace);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal((await inspect(8, "fall")).foreground.toUpperCase(), "#F38BA8");
      assert.equal((await inspect(8, "${")).foreground.toUpperCase(), "#89B4FA");
      for (const [key, value] of Object.entries(previousColors)) await editor.update(key, value, vscode.ConfigurationTarget.Workspace);
      for (const theme of ["Default Light Modern", "Default High Contrast", "Default High Contrast Light"]) {
        await vscode.workspace.getConfiguration("workbench").update("colorTheme", theme, vscode.ConfigurationTarget.Workspace);
        await new Promise(resolve => setTimeout(resolve, 200));
        const shown = await inspect(8, "${");
        assert.notEqual(shown.foreground.toUpperCase(), "#FFD700", `${theme} inherits readable theme punctuation`);
        evidence.push({ theme, punctuation: shown.foreground });
        await screenshot(theme.replaceAll(" ", "-"));
      }
      await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Workspace);
    } finally {
      if (directory) fs.writeFileSync(path.join(directory, "robot-palette-inspectors.json"), JSON.stringify(evidence, null, 2));
      cdp.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.workspace.fs.delete(uri).catch(() => {});
      for (const [key, value] of Object.entries(previousColors)) await editor.update(key, value, vscode.ConfigurationTarget.Workspace);
      for (const [key, value] of Object.entries(prior)) await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      await manager.queue;
    }
  });
});

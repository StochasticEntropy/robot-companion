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

async function updateFolders(start, count, ...folders) {
  let changed = false;
  const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { changed = true; });
  try {
    assert.equal(vscode.workspace.updateWorkspaceFolders(start, count, ...folders), true);
    await until(() => changed, "workspace folder update event");
  } finally { listener.dispose(); }
}

const robotCodePython = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
// The owned venv's robot-companion-backend, built offline by the UI runner (tests/native-backend.js).
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";

suite("Owned language lifecycle (local protocol fixture, plus live RobotCode 2.7.0 and native backend cases)", () => {
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
    for (let attempt = 1; ; attempt++) {
      await clickKeywordOnce(text, modifiers);
      if (modifiers) return;
      try {
        await until(() => vscode.window.activeTextEditor?.document.lineAt(
          vscode.window.activeTextEditor.selection.active.line).text.includes(text), `cursor on ${text}`, 2000);
        return;
      } catch (error) { if (attempt === 3) throw error; }
    }
  }
  async function clickKeywordOnce(text, modifiers) {
    let point, previous;
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
      // Late CodeLens rendering shifts lines: click only a point that stayed put.
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
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
  function explorerHtml() {
    return require(path.join(extension.extensionPath, "src/core/extension")).__test__.getReturnExplorerWebviewHtmlForTest();
  }
  async function showKeyword(text, expected) {
    await vscode.commands.executeCommand("robotCompanion.returnView.focus");
    await openAudit();
    await clickKeyword(text);
    try { await until(() => explorerHtml().includes(expected), `Return Explorer ${expected}`); }
    catch (error) {
      if (evidenceDirectory) {
        const selection = vscode.window.activeTextEditor?.selection.active;
        fs.writeFileSync(path.join(evidenceDirectory, `explorer-timeout-${Date.now()}.html`),
          `<!-- ${vscode.window.activeTextEditor?.document.uri} ${selection?.line}:${selection?.character} -->\n${explorerHtml()}`);
        await screenshot(`explorer-timeout-${Date.now()}`);
      }
      throw error;
    }
  }
  // Selection and technical-detail refreshes replace the webview document; wait
  // for the rendered HTML to settle and retry when its frame was recreated.
  async function settledExplorer() {
    let last, stableSince = Date.now();
    await until(() => {
      const html = explorerHtml();
      if (html !== last) { last = html; stableSince = Date.now(); }
      return Date.now() - stableSince >= 400;
    }, "Return Explorer settled");
  }
  async function clickExplorerLink(text) {
    for (let attempt = 1; ; attempt++) {
      await settledExplorer();
      try { return await clickExplorerLinkOnce(text); }
      catch (error) {
        if (attempt === 3 || !/execution context|box model|Cannot find context|link hit test/.test(error.message)) throw error;
      }
    }
  }
  async function clickExplorerLinkOnce(text) {
    const frame = await cdp.findWebviewFrame('return Boolean(document.querySelector(".details") && document.querySelector(".meta"));', "Return Explorer");
    const expression = `Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === ${JSON.stringify(text)})`;
    let rect;
    for (let i = 0; i < 8; i++) {
      rect = await cdp.evaluate(frame.frameId, `(()=>{const a=${expression};if(!a)return;const r=a.getClientRects()[0];return {x:r.x+r.width/2,y:r.y+r.height/2,h:innerHeight};})()`);
      assert.ok(rect, `visible link ${text}`);
      if (rect.y > 0 && rect.y < rect.h) break;
      const origin = await cdp.frameOrigin(frame);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: origin.pageX + 100,
        y: origin.pageY + 300, deltaX: 0, deltaY: rect.y < 0 ? -250 : 250 }, cdp.pageSession);
      await sleep(100);
    }
    assert.ok(await cdp.hitsElement(frame, rect.x, rect.y, expression), `link hit test ${text}`);
    await cdp.click(frame, rect.x, rect.y);
    evidence.push({ action: "Return Explorer pointer", link: text, point: { x: rect.x, y: rect.y } });
  }
  async function assertTarget(file, line, character) {
    await until(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.path.endsWith(file) && editor.selection.active.line === line &&
        editor.selection.active.character === character;
    }, `source ${file}:${line + 1}:${character + 1}`);
    evidence.push({ result: "source target", uri: vscode.window.activeTextEditor.document.uri.toString(), line, character,
      focused: await page('document.activeElement?.className') });
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
    // Toasts left by earlier suites take Escape before Peek does.
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node },
      backend: "local Node protocol fixture; live cases use the pinned RobotCode bridge",
      robotCodePython: fs.existsSync(robotCodePython) ? robotCodePython : "absent", externalRobotExtensions: "absent",
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
    // The fixture holds the definition answer until the edit has reached it,
    // so the answer is stale by protocol order, not by a timer.
    await root.session.request("fixture/holdDefinitions", {});
    const token = new vscode.CancellationTokenSource();
    let released = false;
    try {
      const requested = audit.version;
      const stale = manager.definition(audit, new vscode.Position(11, 20), token.token);
      await until(async () => await root.session.request("fixture/heldDefinitions", {}) > 0, "definition held by the fixture");
      const edit = new vscode.WorkspaceEdit();
      edit.insert(audit.uri, new vscode.Position(5, 0), "# Ä😀\n");
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      let synced;
      await until(async () => {
        synced = (await root.session.request("fixture/documents", {})).find(doc => doc.uri === audit.uri.toString());
        return synced.version === audit.version;
      }, "edit synchronized while the definition is held");
      assert.ok(audit.version > requested);
      assert.equal(synced.text, audit.getText());
      released = true;
      assert.ok(await root.session.request("fixture/releaseDefinitions", {}) > 0);
      assert.equal(await stale, undefined);
    } finally {
      // A failure above must not leave later tests' definitions held.
      if (!released) await root.session.request("fixture/releaseDefinitions", {}).catch(() => undefined);
    }
    const cancelledId = root.session.nextId;
    const cancelled = manager.definition(audit, new vscode.Position(12, 20), token.token);
    assert.equal(root.session.pending.has(cancelledId), true);
    token.cancel();
    assert.equal(await cancelled, undefined);
    token.dispose();
    // Owned Return Explorer refreshes may have their own request in flight.
    assert.equal(root.session.pending.has(cancelledId), false);
  });

  test("Return Explorer definition, argument and return-variable source clicks share editor identity", async () => {
    await owned();
    await showKeyword("Build Record", "AuditLibrary.py line 12");
    assert.doesNotMatch(explorerHtml(), /AShadow|Unrelated shadow/);
    await screenshot("owned-explorer-imported-doc");
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("AuditLibrary.py", 11, 4);

    await showKeyword("Build Record", "AuditLibrary.py line 12");
    await clickExplorerLink("name");
    await until(() => explorerHtml().includes("What This Argument Accepts"), "argument preview");
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), audit.uri.toString(), "argument name keeps call-site navigation");
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("AuditLibrary.py", 11, 4);

    await showKeyword("${record}=", "What You Can Access");
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("AuditLibrary.py", 11, 4);
    for (const [keyword, file, line] of [["Resource Step", "shared.resource", 1], ["Local Step", "audit.robot", 17]]) {
      await showKeyword(keyword, `${file} line ${line + 1}`);
      await clickExplorerLink("Jump to keyword definition");
      await assertTarget(file, line, 0);
    }
  });

  test("returned alias identity selects source metadata and missing/ambiguous targets never guess", async () => {
    const root = await owned();
    await openAudit();
    const callLine = audit.getText().split("\n").findIndex(line => line.includes("Build Record"));
    const start = audit.lineAt(callLine).text.indexOf("Build Record");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(audit.uri, new vscode.Position(callLine, start), "Audit.");
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await showKeyword("Audit.Build Record", "AuditLibrary.py line 12");
    assert.doesNotMatch(explorerHtml(), /AShadow|Unrelated shadow/);
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("AuditLibrary.py", 11, 4);
    await showKeyword("Audit.Build Record", "AuditLibrary.py line 12");
    await root.session.request("fixture/definitionMode", "missing");
    // Click the still-rendered link after resolution changes: the command must
    // re-resolve and refuse the old target, then replace it with an honest state.
    await clickExplorerLink("Jump to keyword definition");
    await until(() => explorerHtml().includes("Keyword definition is unavailable"), "missing source after link invalidation");
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), audit.uri.toString());
    assert.doesNotMatch(explorerHtml(), /Jump to keyword definition|AShadow|Unrelated shadow/);
    await root.session.request("fixture/definitionMode", "ambiguous");
    await clickKeyword("Local Step");
    await clickKeyword("Audit.Build Record");
    await until(() => explorerHtml().includes("Keyword definition is ambiguous"), "ambiguous identity");
    assert.doesNotMatch(explorerHtml(), /Jump to keyword definition|AShadow|Unrelated shadow/);
    await screenshot("owned-explorer-ambiguous");
    evidence.push({ alias: "Audit.Build Record -> AuditLibrary.py:12:5", missing: "old pointer target refused", ambiguous: "no guessed target" });
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

  test("only advertised capabilities register providers: no hover, rename, code action, formatting or semantic tokens provider without them", async () => {
    const at = new vscode.Position(11, 20);
    const hoverTexts = async () => (await vscode.commands.executeCommand("vscode.executeHoverProvider", audit.uri, at))
      .flatMap(hover => hover.contents.map(content => typeof content === "string" ? content : content.value));
    let root = await owned("language-features");
    await openAudit();
    assert.deepEqual([...root.features].sort(), ["code actions", "completion", "definitions", "document symbols", "formatting", "hover",
      "inlay hints", "range formatting", "references", "rename", "semantic token ranges", "semantic tokens", "signature help", "workspace symbols"]);
    assert.ok((await hoverTexts()).some(text => text.includes("Protocol fixture hover")), "advertised hover is shown");
    const renamed = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", audit.uri, at, "Renamed");
    assert.equal(renamed.entries().length, 1, "advertised rename returns the backend's edit");
    // Code actions: a direct edit and a resolved one; the command-only action Companion cannot run is not offered.
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", audit.uri, new vscode.Range(11, 4, 11, 4),
      undefined, 10);
    const fixtureActions = actions.filter(action => action.title.startsWith("Fixture "));
    assert.deepEqual(fixtureActions.map(action => action.title), ["Fixture direct fix", "Fixture resolved fix"]);
    const edited = action => action.edit.entries().flatMap(([, edits]) => edits.map(edit => edit.newText));
    assert.deepEqual(edited(fixtureActions[0]), ["# direct\n"]);
    assert.equal(fixtureActions[0].isPreferred, true);
    assert.deepEqual(edited(fixtureActions[1]), ["# resolved\n"], "codeAction/resolve filled in the edit");
    assert.equal(fixtureActions[1].command, undefined, "an unsupported backend command is not run");
    const formatted = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", audit.uri, { tabSize: 4, insertSpaces: true });
    assert.deepEqual(formatted.map(edit => edit.newText), ["# formatted\n"]);
    const rangeFormatted = await vscode.commands.executeCommand("vscode.executeFormatRangeProvider", audit.uri, new vscode.Range(2, 0, 3, 0),
      { tabSize: 4, insertSpaces: true });
    assert.deepEqual(rangeFormatted.map(edit => edit.newText), ["# range formatted\n"]);
    const fullCounts = await root.session.request("fixture/featureCounts", {});
    for (const method of ["textDocument/codeAction", "codeAction/resolve", "textDocument/formatting", "textDocument/rangeFormatting"]) {
      assert.ok(fullCounts[method] >= 1, `${method} reached the backend`);
    }
    // Semantic tokens in exactly the advertised legend, whole document and range; the delta offer is never used.
    const legend = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri);
    assert.deepEqual([legend.tokenTypes, legend.tokenModifiers], [["fixtureCall", "fixtureName"], ["fixtureModifier"]]);
    const lines = audit.getText().split("\n");
    const callLine = lines.findIndex(line => line.includes("Build Record")), stepLine = lines.findIndex(line => line.trim() === "Local Step");
    const expected = [[callLine, lines[callLine].indexOf("Build Record"), "Build Record", "fixtureCall", "fixtureModifier"],
      [stepLine, lines[stepLine].indexOf("Local Step"), "Local Step", "fixtureName", ""]];
    const full = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", audit.uri);
    assert.deepEqual(decodeSemanticTokens(full, legend, lines).filter(token => token[0] === callLine || token[0] === stepLine), expected);
    const ranged = await vscode.commands.executeCommand("vscode.provideDocumentRangeSemanticTokens", audit.uri,
      new vscode.Range(callLine, 0, callLine, lines[callLine].length));
    assert.deepEqual(decodeSemanticTokens(ranged, legend, lines), [expected[0]], "range request: only that line's token");
    // A server refresh request is answered and VS Code asks the visible editor's tokens again.
    const before = (await root.session.request("fixture/featureCounts", {}))["textDocument/semanticTokens/full"];
    await root.session.request("fixture/semanticTokensRefresh", {});
    await until(async () => (await root.session.request("fixture/featureCounts", {}))["textDocument/semanticTokens/full"] > before,
      "refresh: whole-document tokens requested again");
    assert.deepEqual((await root.session.request("fixture/refreshAnswers", {})).map(answer => answer.result), [null]);
    // Data outside the legend is refused, not shown.
    await root.session.request("fixture/semanticTokensMode", "invalid");
    assert.equal(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", audit.uri), undefined,
      "token types outside the legend are refused");
    await root.session.request("fixture/semanticTokensMode", "valid");
    assert.equal((await root.session.request("fixture/featureCounts", {}))["textDocument/semanticTokens/full/delta"], undefined,
      "no delta request");
    // Inlay hints as text only: the label part's command and location and the hint's text edits are not used;
    // a hint outside the document or without a label is skipped. The settings filter by kind.
    const hintRange = new vscode.Range(0, 0, audit.lineCount - 1, 0);
    const inlayHints = async () => (await vscode.commands.executeCommand("vscode.executeInlayHintProvider", audit.uri, hintRange))
      .map(hint => ({ line: hint.position.line, character: hint.position.character, kind: hint.kind,
        label: typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join(""),
        parts: typeof hint.label === "string" ? undefined : hint.label.map(part => ({ command: part.command, location: part.location })),
        textEdits: hint.textEdits, paddingLeft: hint.paddingLeft }));
    const recordLine = lines[callLine];
    const fixtureHints = [{ line: callLine, character: recordLine.indexOf("name="), kind: vscode.InlayHintKind.Parameter,
      label: "fixtureParameter=", parts: undefined, textEdits: undefined, paddingLeft: undefined },
    { line: callLine, character: recordLine.indexOf("}") + 1, kind: vscode.InlayHintKind.Type, label: ": FixtureType",
      parts: [{ command: undefined, location: undefined }], textEdits: undefined, paddingLeft: true },
    { line: callLine, character: recordLine.indexOf("Build Record"), kind: undefined, label: "Fixture.", parts: undefined,
      textEdits: undefined, paddingLeft: undefined }];
    const hintSettings = vscode.workspace.getConfiguration("robotCompanion.inlayHints", folder.uri);
    const byLabel = hints => hints.slice().sort((a, b) => a.character - b.character);
    assert.deepEqual(byLabel(await inlayHints()), byLabel(fixtureHints));
    await hintSettings.update("parameterNames", false, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.deepEqual(byLabel(await inlayHints()), byLabel(fixtureHints.slice(1)), "parameterNames off: no parameter hint");
    await hintSettings.update("returnTypes", false, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.deepEqual(await inlayHints(), fixtureHints.slice(2), "returnTypes off too: only the hint without a kind");
    const asked = (await root.session.request("fixture/featureCounts", {}))["textDocument/inlayHint"];
    await hintSettings.update("enabled", false, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.deepEqual(await inlayHints(), [], "disabled: no hints");
    assert.equal((await root.session.request("fixture/featureCounts", {}))["textDocument/inlayHint"], asked, "disabled: no request");
    for (const name of ["enabled", "parameterNames", "returnTypes"]) await hintSettings.update(name, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.deepEqual(byLabel(await inlayHints()), byLabel(fixtureHints), "defaults again: every hint");
    // A server refresh request is answered and VS Code asks the visible editor's hints again.
    const hintsBefore = (await root.session.request("fixture/featureCounts", {}))["textDocument/inlayHint"];
    await root.session.request("fixture/inlayHintRefresh", {});
    await until(async () => (await root.session.request("fixture/featureCounts", {}))["textDocument/inlayHint"] > hintsBefore,
      "inlay hint refresh: hints requested again");
    assert.deepEqual((await root.session.request("fixture/refreshAnswers", {})).map(answer => [answer.id, answer.result]),
      [["semantic-refresh", null], ["inlay-refresh", null]]);

    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.size === 0, "previous backend stopped");
    root = await owned("language-features-partial");
    await openAudit();
    assert.deepEqual([...root.features].sort(), ["completion", "definitions", "document symbols", "references",
      "signature help", "workspace symbols"]);
    assert.equal(root.registrations.length, 6 + 4, "six feature providers plus the file watcher and its three listeners");
    assert.ok((await hoverTexts()).every(text => !text.includes("Protocol fixture hover")), "no backend hover");
    const refused = await Promise.resolve(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", audit.uri, at, "Renamed"))
      .then(value => value, error => error);
    assert.ok(!(refused instanceof vscode.WorkspaceEdit) || refused.entries().length === 0, "no rename provider answers");
    const counts = await root.session.request("fixture/featureCounts", {});
    assert.equal(counts["textDocument/hover"], undefined, "hover never reached the backend");
    assert.equal(counts["textDocument/rename"], undefined, "rename never reached the backend");
    assert.equal(counts["textDocument/prepareRename"], undefined);
    const partialActions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", audit.uri, new vscode.Range(11, 4, 11, 4));
    assert.ok(!(partialActions || []).some(action => action.title.startsWith("Fixture ")), "no code action provider answers");
    const partialFormat = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", audit.uri, { tabSize: 4, insertSpaces: true });
    assert.ok(!partialFormat?.length, "no formatting provider answers");
    const partialCounts = await root.session.request("fixture/featureCounts", {});
    for (const method of ["textDocument/codeAction", "codeAction/resolve", "textDocument/formatting", "textDocument/rangeFormatting",
      "textDocument/semanticTokens/full", "textDocument/semanticTokens/range"]) {
      assert.equal(partialCounts[method], undefined, `${method} never reached the backend`);
    }
    assert.equal(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri), undefined,
      "no semantic tokens provider without semanticTokensProvider");
    assert.deepEqual(await inlayHints(), [], "no inlay hints provider without inlayHintProvider");
    assert.equal((await root.session.request("fixture/featureCounts", {}))["textDocument/inlayHint"], undefined,
      "textDocument/inlayHint never reached the backend");

    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    assert.equal(manager.roots.size, 0, "coexistence: no backend, so none of these providers");
    assert.ok((await hoverTexts()).every(text => !text.includes("Protocol fixture hover")));
    const coexistenceActions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", audit.uri, new vscode.Range(11, 4, 11, 4));
    assert.ok(!(coexistenceActions || []).some(action => action.title.startsWith("Fixture ")), "coexistence: no code actions");
    const coexistenceFormat = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", audit.uri, { tabSize: 4, insertSpaces: true });
    assert.ok(!coexistenceFormat?.length, "coexistence: no formatting");
    assert.equal(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokensLegend", audit.uri), undefined,
      "coexistence: no semantic tokens provider");
    assert.deepEqual(await inlayHints(), [], "coexistence: no inlay hints");
    evidence.push({ capabilityGating: { advertised: "hover, rename, code action, formatting, range formatting and semantic token (full, range) providers registered",
      semanticTokens: { legend: "fixtureCall, fixtureName / fixtureModifier", refresh: "answered null, tokens requested again",
        invalid: "refused", delta: "never requested" },
      inlayHints: { shown: "parameter, type and kindless hints as text; command, location and text edits dropped; outside/empty skipped",
        settings: "parameterNames/returnTypes filter by kind; enabled=false sends no request", refresh: "answered null, hints requested again" },
      partial: "no hover/rename/code action/formatting/semantic tokens/inlay hints provider; backend counts 0",
      coexistence: "no roots, no code actions, formatting or semantic tokens" } });
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
    // Held until the backend stops: the answer can never arrive before the transition.
    await root.session.request("fixture/holdDefinitions", {});
    const token = new vscode.CancellationTokenSource();
    const pending = manager.definition(audit, new vscode.Position(11, 20), token.token);
    await until(async () => await root.session.request("fixture/heldDefinitions", {}) > 0, "definition held by the fixture");
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

  // Real backends: pointer F12, Peek, Ctrl-click and the Return Explorer link
  // reach the imported library, never AShadow.py; mode exit ends the process.
  async function liveNavigation(input, serverInfo, libraryCharacter, label) {
    await config.update("languageBackend", JSON.parse(JSON.stringify(input)), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    const root = manager.roots.get(folder.uri.toString());
    assert.equal(root.error, undefined);
    assert.equal(root.session.state, "running");
    assert.deepEqual({ ...root.session.serverInfo }, serverInfo);
    evidence.push({ liveBackend: { ...root.session.serverInfo }, executable: input.services.language.executable,
      argv: input.services.language.argv, pid: root.session.child.pid });
    await openAudit();
    await clickKeyword("Build Record");
    await key("F12", "F12", 123);
    await assertTarget("AuditLibrary.py", 11, libraryCharacter);
    await screenshot(`${label}-f12-target`);
    await openAudit();
    await clickKeyword("Build Record");
    await key("F10", "F10", 121, 10); // Linux Ctrl+Shift+F10: Peek Definition
    await until(() => page(`Boolean(document.querySelector('.peekview-widget .monaco-editor'))`), "Peek widget", 20000);
    const peekText = await page(`document.querySelector('.peekview-widget').innerText`);
    assert.match(peekText, /AuditLibrary/);
    assert.doesNotMatch(peekText, /AShadow/);
    evidence.push({ result: `live Peek (${label})`, text: peekText.slice(0, 400) });
    await screenshot(`${label}-peek`);
    await key("Escape", "Escape", 27);
    await until(() => page(`!document.querySelector('.peekview-widget')`), "Peek closed");
    await clickKeyword("Resource Step", 2); // Linux Ctrl+click
    await assertTarget("shared.resource", 1, 0);
    await showKeyword("Build Record", "AuditLibrary.py line 12");
    assert.doesNotMatch(explorerHtml(), /AShadow|Unrelated shadow/);
    await screenshot(`${label}-explorer-imported-doc`);
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("AuditLibrary.py", 11, libraryCharacter);
    // The real backend reports the current saved source, which earlier cases may have shifted.
    const localLine = audit.getText().split("\n").indexOf("Local Step");
    assert.ok(localLine > 0);
    await showKeyword("Local Step", `audit.robot line ${localLine + 1}`);
    await clickExplorerLink("Jump to keyword definition");
    await assertTarget("audit.robot", localLine, 0);
    const child = root.session.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => child.exitCode !== null || child.signalCode !== null, `${label} process exit`);
    assert.equal(child.exitCode, 0, "the backend process exits by itself after shutdown/exit");
    assert.equal(manager.roots.size, 0);
    evidence.push({ cleanup: `live ${label} coexistence`, processExitCode: child.exitCode, signal: child.signalCode, roots: 0 });
  }

  test("live pinned RobotCode 2.7.0 bridge: pointer F12, Peek, Ctrl-click and Return Explorer reach the imported library", async function () {
    if (!fs.existsSync(robotCodePython)) this.skip(); // Reported as pending, never as a pass.
    const { robotCodeDescriptor } = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"));
    const input = robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python: robotCodePython });
    await liveNavigation(input, { name: "RobotCode Language Server", version: "2.7.0" }, 0, "robotcode");
  });

  test("live native backend: pointer F12, Peek, Ctrl-click and Return Explorer reach the imported library", async function () {
    if (!nativeExecutable) this.skip(); // Reported as pending, never as a pass.
    const { nativeDescriptor } = require(path.join(extension.extensionPath, "src/integration/native-backend"));
    const input = nativeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable: nativeExecutable });
    await liveNavigation(input, { name: "robot-companion-backend", version: "0.1.0.dev1" }, 4, "native");
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

// [line, character, text, type, modifiers] of each token in VS Code's relative encoding.
function decodeSemanticTokens(tokens, legend, lines) {
  const result = [];
  let line = 0, character = 0;
  const data = tokens?.data || [];
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] ? data[index + 1] : character + data[index + 1];
    result.push([line, character, lines[line].slice(character, character + data[index + 2]), legend.tokenTypes[data[index + 3]],
      legend.tokenModifiers.filter((_, bit) => data[index + 4] & (1 << bit)).join(" ")]);
  }
  return result;
}

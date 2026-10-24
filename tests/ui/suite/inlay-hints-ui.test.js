"use strict";

// Owned-mode inlay hints, checked live in VS Code at 1280x900 with actual keyboard
// and pointer input over the named synthetic corpus of the native backend
// (backend/tests/inlay_fixtures). What VS Code renders is read from the editor's
// view lines: each hint is an injected span, so removing the hint spans gives
// back the document line, and the text before a hint gives its UTF-16 offset.
// Settings are changed in the Settings editor with the pointer. Skipped by name
// (pending) when the native backend's prepared environment is absent; never
// reported as a pass. The RobotCode case runs only with its prepared environment.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const FOLDER = "integration-inlay-hints";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
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

// Lines of hints.robot without any hint, and labels that only the unimported Unimported.py would give.
const UNHINTED = ["    Twin Step    one", "    Unknown Step    one", "    Greet Ada Kindly", "    Combine    @{LIST}    tail",
  "    Log Many    a    b"];
const NEVER = ["label=", ": int"];
const ALIAS = "    ${record}=    Audit.Build Record    Ada";
const UNICODE_LINE = "    Combine    Äöü 😀    𝔘 ${GRÜẞE}";

suite("Owned inlay hints with the native backend (live, actual input)", function () {
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  let extension, manager, folder, config, root, cdp, hintsDocument;
  const hintsFile = () => vscode.Uri.joinPath(folder.uri, FOLDER, "hints.robot");
  const auditFile = () => vscode.Uri.joinPath(folder.uri, "integration-audit-v1", "audit.robot");
  const nativeDescriptor = (target = folder) => require(path.join(extension.extensionPath, "src/integration/native-backend"))
    .nativeDescriptor({ workspaceUri: target.uri.toString(), cwd: target.uri.fsPath, executable: nativeExecutable });

  async function page(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `native-inlay-hints-${name}.png`), Buffer.from(data, "base64"));
  }
  async function key(name, code, virtualKeyCode, modifiers = 0, label) {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
      type, key: name, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers,
      ...(type === "keyDown" && name === "Enter" ? { text: "\r" } : {})
    }, cdp.pageSession);
    evidence.push({ action: "key", key: label || name, modifiers });
  }
  async function type(text) {
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
  }
  async function move(point, label) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
    evidence.push({ action: "move", target: label, point });
  }
  async function click(point, label) {
    for (const kind of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type: kind, ...point,
        ...(kind === "mouseMoved" ? {} : { button: "left", buttons: kind === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (kind === "mouseMoved") await sleep(150);
    }
    evidence.push({ action: "click", target: label, point });
  }
  async function pointerAway() {
    const point = await page(`(() => { const bar = document.querySelector('.part.titlebar'); const r = bar?.getBoundingClientRect();
      return r?.height ? { x: Math.round(r.x + r.width * 0.75), y: Math.round(r.y + r.height / 2) } : { x: 1000, y: 4 }; })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
  }

  // Every rendered line of the active editor group's editor: its document text (the
  // non-hint spans) and each hint span with its UTF-16 offset, label, style and center.
  const RENDERED = `(() => {
    const editor = document.querySelector('.editor-group-container.active .editor-instance .monaco-editor');
    if (!editor) return [];
    return [...editor.querySelectorAll('.lines-content .view-line')].map(line => {
      let source = '';
      const hints = [];
      for (const span of line.querySelectorAll(':scope > span > span')) {
        const text = span.textContent.replaceAll('\\u00a0', ' ');
        if (/\\bdyn-rule-/.test(span.className)) {
          const rect = span.getBoundingClientRect(), style = getComputedStyle(span);
          hints.push({ offset: source.length, label: text, background: style.backgroundColor, fontSize: style.fontSize,
            point: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
            free: (() => { const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return Boolean(hit && (span === hit || span.contains(hit))); })() });
        } else source += text;
      }
      return { source, hints, top: line.getBoundingClientRect().top };
    }).filter(line => line.top >= 0 && line.top < innerHeight).sort((a, b) => a.top - b.top);
  })()`;
  const rendered = () => page(RENDERED);
  const renderedLine = async text => (await rendered()).find(line => line.source === text);

  // The hints VS Code collects from every registered provider, and the native backend's own answer.
  async function composed(document) {
    const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", document.uri,
      new vscode.Range(0, 0, document.lineCount, 0));
    return hints.map(hint => ({ line: hint.position.line, character: hint.position.character,
      label: typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join(""), kind: hint.kind }));
  }
  async function backendHints(owner, document) {
    const result = await owner.session.request("textDocument/inlayHint", { textDocument: { uri: document.uri.toString() },
      range: { start: { line: 0, character: 0 }, end: { line: document.lineCount, character: 0 } } });
    return result.map(hint => ({ line: hint.position.line, character: hint.position.character,
      label: typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join(""), kind: hint.kind }));
  }
  const order = hints => hints.slice().sort((a, b) => a.line - b.line || a.character - b.character || a.label.localeCompare(b.label));
  const key3 = hint => `${hint.line}:${hint.character}:${hint.label}`;

  // A layout-stable, unobstructed point inside `token` on the visible line whose document text is `line`.
  async function textPoint(line, token, offset = 1) {
    let point, previous;
    await until(async () => {
      point = await page(`(() => {
        const editor = document.querySelector('.editor-group-container.active .editor-instance .monaco-editor');
        for (const row of editor ? editor.querySelectorAll('.lines-content .view-line') : []) {
          const spans = [...row.querySelectorAll(':scope > span > span')].filter(span => !/\\bdyn-rule-/.test(span.className));
          if (spans.map(span => span.textContent.replaceAll('\\u00a0', ' ')).join('') !== ${JSON.stringify(line)}) continue;
          let before = 0;
          const wanted = ${JSON.stringify(line)}.indexOf(${JSON.stringify(token)}) + ${offset};
          for (const span of spans) {
            const length = span.textContent.length;
            if (wanted < before + length) {
              const range = document.createRange(); range.setStart(span.firstChild, wanted - before); range.setEnd(span.firstChild, wanted - before + 1);
              const rect = range.getBoundingClientRect();
              if (!rect.width || rect.top < 0 || rect.bottom > innerHeight) return;
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return hit && row.contains(hit) ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : undefined;
            }
            before += length;
          }
        }
      })()`);
      const stable = point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      if (!stable) await sleep(150);
      return stable;
    }, `visible ${token} on "${line}"`);
    return point;
  }
  async function hoverText() {
    return page(`[...document.querySelectorAll('.monaco-hover:not(.hidden) .monaco-hover-content')].filter(e => e.getClientRects().length)
      .map(e => e.innerText.replaceAll('\\u00a0', ' ').trim()).join('\\n---\\n')`);
  }
  async function hoverOver(point, label, expected) {
    let text;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await pointerAway();
      await sleep(300);
      await move(point, label);
      try {
        await until(async () => (text = await hoverText()) && expected.test(text), `hover over ${label}`, 8000);
        return text;
      } catch (error) { if (attempt === 3) throw new Error(`${error.message}; last hover text: ${text}`); }
    }
  }
  async function closeHover() {
    await pointerAway();
    await key("Escape", "Escape", 27);
    await until(async () => !await hoverText(), "hover closed", 5000).catch(() => {});
  }

  // Ctrl+P, the file name, Enter: the file opens in the active group.
  async function quickOpen(uri) {
    await key("p", "KeyP", 80, 2, "Ctrl+P");
    await until(() => page(`Boolean(document.querySelector('.quick-input-widget .quick-input-box input')?.getClientRects().length)`), "Quick Open");
    const relative = vscode.workspace.asRelativePath(uri, false);
    await type(relative);
    await until(() => page(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row.focused')].some(row =>
      row.innerText.replaceAll('\\u00a0', ' ').includes(${JSON.stringify(path.basename(uri.fsPath))}))`), `${relative} is the focused pick`);
    await key("Enter", "Enter", 13);
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), `${relative} active`);
    await until(() => page(`Boolean(document.activeElement?.closest('.editor-group-container.active .monaco-editor'))`),
      `${relative} has keyboard focus`);
    return vscode.window.activeTextEditor.document;
  }

  // A pointer click on a visible line's text, then Ctrl+Home or Ctrl+End; waits until the
  // document's first or last line is drawn.
  async function scrollTo(document, edge) {
    // A line in the middle of the editor, never under sticky scroll.
    const visible = (await rendered()).filter(line => line.source.trim().length > 1);
    const middle = visible[Math.floor(visible.length / 2)];
    assert.ok(middle, "a visible line");
    await click(await textPoint(middle.source, middle.source.trim()), `"${middle.source.trim()}"`);
    const lines = document.getText().split("\n");
    const wanted = edge === "top" ? lines[0] : lines.filter(line => line.trim()).pop();
    if (edge === "top") await key("Home", "Home", 36, 2, "Ctrl+Home");
    else await key("End", "End", 35, 2, "Ctrl+End");
    await until(async () => (await rendered()).some(line => line.source === wanted), `${edge} of ${path.basename(document.uri.fsPath)} drawn`);
  }

  // The rendered hints of every visible hinted line equal the composed hints there, at their offsets.
  async function assertRendered(document, expected, seen) {
    const lines = document.getText().split("\n");
    let shown = 0;
    await until(async () => {
      const view = await rendered();
      shown = 0;
      for (const line of view) {
        const index = lines.indexOf(line.source);
        if (index < 0 || lines.indexOf(line.source, index + 1) >= 0) continue; // only lines that are unique in the document
        const wanted = expected.filter(hint => hint.line === index).map(hint => [hint.character, hint.label]).sort((a, b) => a[0] - b[0]);
        const got = line.hints.map(hint => [hint.offset, hint.label]);
        if (JSON.stringify(got) !== JSON.stringify(wanted)) return false;
        for (const hint of line.hints) seen?.set(`${index}:${hint.offset}:${hint.label}`, { line: line.source, ...hint });
        shown += line.hints.length;
      }
      return shown > 0;
    }, "rendered hints match the composed hints on every visible line").catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify((await rendered()).filter(line => line.hints.length || UNHINTED.includes(line.source)))}`);
    });
    return shown;
  }

  // Ctrl+, opens the Settings editor; the setting's id in the search box; a pointer click on its checkbox.
  // Only the row titled `title` (Robot Companion › Inlay Hints: <title>) is clicked, after the search shows exactly it.
  async function toggleInSettingsEditor(id, expected, title) {
    await key(",", "Comma", 188, 2, "Ctrl+,");
    await until(() => page(`Boolean(document.querySelector('.settings-editor .settings-header .monaco-editor textarea'))`), "Settings editor");
    await until(() => page(`document.activeElement?.closest('.settings-header') !== null`), "Settings search box focused");
    await key("a", "KeyA", 65, 2, "Ctrl+A");
    await type(id);
    let point;
    await until(async () => (point = await page(`(() => {
      // The search has applied: every shown row is one of Robot Companion's inlay hint settings.
      const count = document.querySelector('.settings-editor .settings-count-widget')?.innerText.trim() || '';
      const titleOf = row => row.querySelector('.setting-item-title')?.innerText.replaceAll('\u00a0', ' ').trim() || '';
      const rows = [...document.querySelectorAll('.settings-editor .settings-tree-container .setting-item')]
        .filter(row => row.getClientRects().length);
      if (!/^[1-9]\d* Settings? Found$/.test(count) || !rows.length ||
          !rows.every(row => titleOf(row).startsWith('Robot Companion › Inlay Hints: '))) return;
      const matching = rows.filter(row => titleOf(row) === ${JSON.stringify(`Robot Companion › Inlay Hints: ${title}`)});
      if (matching.length !== 1 || !matching[0].classList.contains('setting-item-bool')) return;
      const box = matching[0].querySelector('.setting-value-checkbox');
      const r = box?.getBoundingClientRect();
      if (!r?.width) return;
      const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
      return hit && (hit === box || box.contains(hit)) ? { x: Math.round(x), y: Math.round(y),
        title: titleOf(matching[0]), checked: box.getAttribute('aria-checked'), shown: rows.map(titleOf), count } : undefined;
    })()`)), `${id} is the only setting shown`);
    await click({ x: point.x, y: point.y }, `${point.title} checkbox`);
    // Back at its default, the Settings editor removes the user value instead of writing it.
    await until(() => vscode.workspace.getConfiguration().get(id) === expected &&
      [expected, undefined].includes(vscode.workspace.getConfiguration().inspect(id)?.globalValue), `${id} is ${expected}`);
    evidence.push({ setting: id, title: point.title, before: point.checked, after: expected, shown: point.shown, count: point.count,
      target: "User settings (Settings editor)" });
    await screenshot(`setting-${id.split(".").pop()}-${expected}`);
    await key("w", "KeyW", 87, 2, "Ctrl+W");
    await until(() => page(`!document.querySelector('.settings-editor')?.getClientRects().length`), "Settings editor closed");
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    this.timeout(180000);
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    manager = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getLanguageWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    for (const id of ["d-biehl.robotcode", "ms-python.python", "ms-python.debugpy", "robocorp.robotframework-lsp"]) {
      assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
    }
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // The named synthetic corpus, copied from this checkout's backend tests.
    await vscode.workspace.fs.copy(vscode.Uri.file(path.join(extension.extensionPath, "backend/tests/inlay_fixtures")),
      vscode.Uri.joinPath(folder.uri, FOLDER), { overwrite: true });
    for (const name of ["enabled", "parameterNames", "returnTypes"]) {
      const inspected = vscode.workspace.getConfiguration().inspect(`robotCompanion.inlayHints.${name}`);
      assert.deepEqual([inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue, inspected.defaultValue],
        [undefined, undefined, undefined, true], `robotCompanion.inlayHints.${name} starts at its default`);
    }
    // The test profile turns VS Code's inlay hints off for the other suites (run-ui-tests.js); on for this one.
    await vscode.workspace.getConfiguration("editor").update("inlayHints.enabled", "on", vscode.ConfigurationTarget.Global);
    assert.equal(vscode.workspace.getConfiguration("editor").get("inlayHints.enabled"), "on");
    cdp = await WebviewCdp.connect();
    await config.update("languageBackend", JSON.parse(JSON.stringify(nativeDescriptor())), vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "native backend running", 60000);
    root = manager.roots.get(folder.uri.toString());
    assert.deepEqual({ ...root.session.serverInfo }, { name: "robot-companion-backend", version: "0.1.0.dev17" });
    assert.deepEqual(root.session.capabilities.inlayHintProvider, { resolveProvider: false });
    assert.equal([...root.features].filter(feature => feature === "inlay hints").length, 1);
    const viewport = await page(`({width: innerWidth, height: innerHeight, scale: devicePixelRatio})`);
    assert.deepEqual([viewport.width, viewport.height], [1280, 900], "inlay hint checks run at 1280x900");
    evidence.push({ versions: { vscode: vscode.version, node: process.versions.node }, backend: { ...root.session.serverInfo },
      executable: nativeExecutable, pid: root.session.child.pid, exposed: [...root.features],
      inlayHintProvider: root.session.capabilities.inlayHintProvider, viewport });
  });
  teardown(async function () {
    if (this.currentTest?.state === "failed") {
      await screenshot(`failed-${this.currentTest.title.split(":")[0].replace(/\W+/g, "-")}`);
      evidence.push({ failed: this.currentTest.title, rendered: await rendered().catch(() => undefined),
        hover: await hoverText().catch(() => undefined),
        backend: { state: root?.session?.state, error: root?.error, features: root && [...root.features] } });
    }
    await closeHover().catch(() => {});
    // Each test starts from the default settings, even after a failure. A nested owned folder without its
    // own debug/discovery backend leaves refusal notifications; they are not this suite's subject.
    await resetSettings();
    await vscode.commands.executeCommand("notifications.clearAll");
  });
  async function resetSettings() {
    for (const name of ["enabled", "parameterNames", "returnTypes"]) {
      await vscode.workspace.getConfiguration().update(`robotCompanion.inlayHints.${name}`, undefined, vscode.ConfigurationTarget.Global);
    }
  }
  suiteTeardown(async () => {
    if (!extension) return;
    await resetSettings();
    await vscode.workspace.getConfiguration("editor").update("inlayHints.enabled", "off", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const child = manager.roots.get(folder.uri.toString())?.session?.child;
    await config.update("integrationMode", "coexistence", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("languageBackend", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    if (child) await until(() => child.exitCode !== null || child.signalCode !== null, "native process exit");
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, FOLDER), { recursive: true });
    evidence.push({ cleanup: "coexistence", roots: manager.roots.size, exitCode: child?.exitCode });
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "native-inlay-hints-ui-actions.json"), JSON.stringify(evidence, null, 2));
    cdp?.close();
  });

  test("rendering and placement: the named corpus shows exactly the backend's hints, once, at their UTF-16 positions", async function () {
    this.timeout(180000);
    hintsDocument = await quickOpen(hintsFile());
    const expected = await backendHints(root, hintsDocument);
    const all = await composed(hintsDocument);
    // One provider: VS Code's collected hints are the backend's own, none twice.
    assert.deepEqual(order(all), order(expected));
    assert.equal(new Set(all.map(key3)).size, all.length, "no duplicate hint");
    assert.ok(expected.length >= 20, `the corpus has its hints (${expected.length})`);
    for (const label of NEVER) assert.ok(!all.some(hint => hint.label === label), `${label} (unimported Unimported.py) never appears`);
    // The first screen, then Ctrl+End for the rest of the corpus.
    await scrollTo(hintsDocument, "top");
    const seen = new Map();
    let shown = await assertRendered(hintsDocument, all, seen);
    await screenshot("corpus-top");
    await scrollTo(hintsDocument, "bottom");
    shown += await assertRendered(hintsDocument, all, seen);
    await screenshot("corpus-bottom");
    assert.equal(seen.size, new Set(all.map(key3)).size, "every hint of the corpus was seen rendered at its position");
    const lines = hintsDocument.getText().split("\n");
    const view = await rendered();
    for (const text of UNHINTED) {
      const line = view.find(item => item.source === text);
      if (line) assert.deepEqual(line.hints, [], `${text.trim()}: no hint`);
    }
    // UTF-16 placement on the line with an umlaut, an emoji and a non-BMP letter.
    const unicode = await renderedLine(UNICODE_LINE);
    assert.deepEqual(unicode.hints.map(hint => [hint.offset, hint.label]), [[15, "first:"], [25, "second="]]);
    // Hints are drawn as hints (VS Code's inlay hint style), not as document text.
    const sample = [...seen.values()][0];
    assert.notEqual(sample.background, "rgba(0, 0, 0, 0)", "inlay hint background");
    evidence.push({ result: "rendered corpus", hints: all.length, renderedPositions: seen.size, renderedSpans: shown,
      unicode: unicode.hints.map(({ offset, label }) => ({ offset, label })), style: { background: sample.background, fontSize: sample.fontSize },
      lines: [...seen.entries()].map(([position, hint]) => `${position} ${hint.label} | ${hint.line}`) });
    assert.equal(lines.length, hintsDocument.lineCount);
  });

  test("hover over a hint shows the resolved definition it names", async function () {
    this.timeout(120000);
    hintsDocument = await quickOpen(hintsFile());
    await scrollTo(hintsDocument, "top");
    let alias;
    await until(async () => (alias = await renderedLine(ALIAS))?.hints.length === 2, "alias line hints");
    const [type, argument] = alias.hints;
    assert.deepEqual([type.label, argument.label, type.free, argument.free], [": Record", "name=", true, true]);
    const typeHover = await hoverOver(type.point, ": Record hint", /Declared return type of Build Record · Library Audit · AuditLibrary\.py/);
    await screenshot("hover-return-type");
    await closeHover();
    const argumentHover = await hoverOver(argument.point, "name= hint", /Argument name of Build Record · Library Audit · AuditLibrary\.py/);
    await screenshot("hover-argument");
    assert.doesNotMatch(argumentHover + typeHover, /Unimported|label/);
    evidence.push({ result: "hint tooltips", typeHover, argumentHover });
  });

  test("hints follow a typed edit, a changed library on disk and an unsaved resource edit", async function () {
    this.timeout(180000);
    hintsDocument = await quickOpen(hintsFile());
    const original = hintsDocument.getText();
    const target = "    TwinB.Twin Step    one";
    await click(await textPoint(target, "one"), "one on the TwinB line");
    await key("End", "End", 35);
    await key("Enter", "Enter", 13);
    await type("TwinA.Twin Step    typed");
    const typed = "    TwinA.Twin Step    typed";
    await until(() => hintsDocument.getText().split("\n").includes(typed), "typed line in the document");
    let line;
    await until(async () => JSON.stringify((line = await renderedLine(typed))?.hints.map(h => [h.offset, h.label])) ===
      JSON.stringify([[typed.indexOf("typed"), "left="]]), "left= before the typed argument");
    await screenshot("typed-edit");
    evidence.push({ result: "typed edit", line: typed, hints: line.hints.map(({ offset, label }) => ({ offset, label })) });
    // A changed library on disk: no edit of hints.robot, its hints change.
    const twin = vscode.Uri.joinPath(folder.uri, FOLDER, "TwinA.py");
    const twinText = Buffer.from(await vscode.workspace.fs.readFile(twin)).toString("utf8");
    try {
      await vscode.workspace.fs.writeFile(twin, Buffer.from(twinText.replace("def twin_step(left):\n    return left",
        "def twin_step(renamed):\n    return renamed")));
      await until(async () => {
        const view = await rendered();
        return ["    TwinA.Twin Step    one", typed].every(text => view.find(item => item.source === text)?.hints.map(h => h.label)
          .join() === "renamed=");
      }, "renamed= after the library changed on disk");
      await screenshot("library-changed");
    } finally { await vscode.workspace.fs.writeFile(twin, Buffer.from(twinText)); }
    await until(async () => (await renderedLine(typed))?.hints.map(h => h.label).join() === "left=", "left= again");
    // An unsaved edit of the imported resource, shown beside: Resource Step's argument name follows it.
    const resource = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, FOLDER, "shared.resource"));
    await vscode.window.showTextDocument(resource, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
    const rename = (from, to) => {
      const edit = new vscode.WorkspaceEdit();
      for (const [index, text] of resource.getText().split("\n").entries()) {
        const at = text.indexOf(from);
        if (at >= 0) edit.replace(resource.uri, new vscode.Range(index, at, index, at + from.length), to);
      }
      return vscode.workspace.applyEdit(edit);
    };
    const resourceLine = "    Resource Step    ${GRÜẞE}";
    try {
      assert.equal(await rename("${value}", "${changed}"), true);
      assert.equal(resource.isDirty, true, "the resource edit is unsaved");
      await until(async () => (await renderedLine(resourceLine))?.hints.map(h => h.label).join() === "changed=",
        "changed= from the unsaved resource");
      await screenshot("resource-unsaved-edit");
    } finally {
      await rename("${changed}", "${value}");
      await resource.save();
    }
    await until(async () => (await renderedLine(resourceLine))?.hints.map(h => h.label).join() === "value=", "value= again");
    await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
    // Ctrl+Z back to the saved text: the typed line and its hint are gone.
    for (let attempt = 0; attempt < 6 && hintsDocument.getText() !== original; attempt++) {
      await key("z", "KeyZ", 90, 2, "Ctrl+Z");
      await sleep(200);
    }
    assert.equal(hintsDocument.getText(), original);
    assert.equal(hintsDocument.isDirty, false);
    await until(async () => !(await rendered()).some(item => item.source === typed), "typed line undone");
    evidence.push({ result: "edits", library: "left= -> renamed= -> left=", resource: "value= -> changed= (unsaved) -> value=", undo: "clean" });
  });

  test("settings: argument names and then all hints switched off in the Settings editor; Companion's own enrichment is unchanged", async function () {
    this.timeout(240000);
    // Companion's own hover sections and CodeLenses on audit.robot, with hints on.
    const enrichment = async () => {
      const audit = await quickOpen(auditFile());
      await until(() => page(`[...document.querySelectorAll('.editor-group-container.active .codelens-decoration')]
        .some(e => e.innerText.includes('Run Test'))`), "CodeLenses");
      const lenses = await page(`[...document.querySelectorAll('.editor-group-container.active .codelens-decoration')]
        .map(e => e.innerText.replaceAll('\\u00a0', ' ').trim()).filter(Boolean)`);
      // The hover's text, independent of where its width wraps the lines.
      const hover = (await hoverOver(await textPoint("    ${record}=    Build Record    name=Ada", "${record}", 3), "${record}",
        /Robot Return Hint[\s\S]*Assigned in test Debug Smoke/)).replace(/\s+/g, " ");
      await closeHover();
      const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", audit.uri);
      return { lenses, hover, semanticTokens: tokens?.data.length || 0 };
    };
    const before = await enrichment();
    assert.ok(before.semanticTokens > 0 && before.lenses.length > 0);
    await screenshot("enrichment-hints-on");

    await toggleInSettingsEditor("robotCompanion.inlayHints.parameterNames", false, "Parameter Names");
    hintsDocument = await quickOpen(hintsFile());
    const all = await composed(hintsDocument);
    assert.ok(all.length > 0 && all.every(hint => hint.kind === vscode.InlayHintKind.Type), "only return types remain");
    await scrollTo(hintsDocument, "top");
    await assertRendered(hintsDocument, all);
    assert.deepEqual((await renderedLine(ALIAS)).hints.map(h => h.label), [": Record"]);
    await screenshot("parameter-names-off");

    await toggleInSettingsEditor("robotCompanion.inlayHints.enabled", false, "Enabled");
    hintsDocument = await quickOpen(hintsFile());
    assert.deepEqual(await composed(hintsDocument), [], "disabled: no hints");
    await until(async () => (await rendered()).every(line => !line.hints.length) && Boolean(await renderedLine(ALIAS)), "no hint rendered");
    await screenshot("hints-off");
    const after = await enrichment();
    assert.deepEqual(after, before, "hover, CodeLenses and semantic tokens are the same with hints off");
    await screenshot("enrichment-hints-off");

    await toggleInSettingsEditor("robotCompanion.inlayHints.enabled", true, "Enabled");
    await toggleInSettingsEditor("robotCompanion.inlayHints.parameterNames", true, "Parameter Names");
    hintsDocument = await quickOpen(hintsFile());
    await until(async () => (await renderedLine(ALIAS))?.hints.map(h => h.label).join() === ": Record,name=", "hints back");
    evidence.push({ result: "settings", parameterNamesOff: all.length, enrichment: before });
  });

  test("no duplicate provider hints: a nested workspace folder and a provider switch", async function () {
    this.timeout(240000);
    // A nested folder with its own native backend: hints.robot belongs to the nested root only.
    const nested = vscode.Uri.joinPath(folder.uri, FOLDER);
    const settingsDirectory = vscode.Uri.joinPath(nested, ".vscode");
    await vscode.workspace.fs.createDirectory(settingsDirectory);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(settingsDirectory, "settings.json"), Buffer.from(JSON.stringify({
      "robotCompanion.integrationMode": "owned", "robotCompanion.languageBackend": nativeDescriptor({ uri: nested }) })));
    try {
      await updateFolders(vscode.workspace.workspaceFolders.length, 0, { uri: nested, name: "nested-inlay-hints" });
      await until(() => manager.roots.get(nested.toString())?.session?.state === "running", "nested native root running", 60000);
      await until(() => manager.roots.get(folder.uri.toString())?.session?.state === "running", "parent native root running", 60000);
      const child = manager.roots.get(nested.toString());
      hintsDocument = await quickOpen(hintsFile());
      const all = await composed(hintsDocument);
      assert.deepEqual(order(all), order(await backendHints(child, hintsDocument)), "the nested root's hints, once");
      assert.equal(new Set(all.map(key3)).size, all.length, "no duplicate hint across the overlapping roots");
      await click(await textPoint(ALIAS, "Ada"), "Ada on the alias line");
      await key("Home", "Home", 36, 2, "Ctrl+Home");
      await assertRendered(hintsDocument, all);
      await screenshot("nested-root");
      evidence.push({ result: "nested roots", hints: all.length, roots: [...manager.roots.keys()] });
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const index = vscode.workspace.workspaceFolders.findIndex(item => item.uri.toString() === nested.toString());
      if (index >= 0) {
        await updateFolders(index, 1);
        await until(() => !manager.roots.has(nested.toString()) && manager.roots.get(folder.uri.toString())?.session?.state === "running",
          "nested root removed");
      }
      await vscode.workspace.fs.delete(settingsDirectory, { recursive: true });
    }
    if (!fs.existsSync(python)) {
      evidence.push({ result: "provider switch", skipped: `RobotCode environment absent at ${python}` });
      return;
    }
    // Native -> RobotCode -> native: one provider at a time, its own hints only.
    const robotCode = require(path.join(extension.extensionPath, "src/integration/robotcode-bridge"))
      .robotCodeDescriptor({ workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, python });
    const nativeChild = manager.roots.get(folder.uri.toString()).session.child;
    await config.update("languageBackend", JSON.parse(JSON.stringify(robotCode)), vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.serverInfo?.name === "RobotCode Language Server" &&
      manager.roots.get(folder.uri.toString())?.session?.state === "running", "RobotCode running", 60000);
    assert.notEqual(nativeChild.exitCode ?? nativeChild.signalCode, null, "the native process ended");
    const robotCodeRoot = manager.roots.get(folder.uri.toString());
    assert.equal([...robotCodeRoot.features].filter(feature => feature === "inlay hints").length, 1);
    hintsDocument = await quickOpen(hintsFile());
    let robotCodeHints;
    await until(async () => (robotCodeHints = await composed(hintsDocument)).length > 0, "RobotCode hints", 30000);
    assert.deepEqual(order(robotCodeHints), order(await backendHints(robotCodeRoot, hintsDocument)));
    assert.equal(new Set(robotCodeHints.map(key3)).size, robotCodeHints.length, "no duplicate RobotCode hint");
    assert.ok(!robotCodeHints.some(hint => hint.label === ": Record"), "no native return-type hint remains");
    await scrollTo(hintsDocument, "top");
    await assertRendered(hintsDocument, robotCodeHints);
    await screenshot("robotcode-provider");
    await config.update("languageBackend", JSON.parse(JSON.stringify(nativeDescriptor())), vscode.ConfigurationTarget.WorkspaceFolder);
    await manager.queue;
    await until(() => manager.roots.get(folder.uri.toString())?.session?.serverInfo?.name === "robot-companion-backend" &&
      manager.roots.get(folder.uri.toString())?.session?.state === "running", "native running again", 60000);
    root = manager.roots.get(folder.uri.toString());
    const again = await composed(hintsDocument);
    assert.deepEqual(order(again), order(await backendHints(root, hintsDocument)));
    assert.equal(new Set(again.map(key3)).size, again.length, "no duplicate after switching back");
    await assertRendered(hintsDocument, again);
    evidence.push({ result: "provider switch", robotCode: robotCodeHints.length, nativeAgain: again.length,
      robotCodeLabels: [...new Set(robotCodeHints.map(hint => hint.label))] });
  });
});

"use strict";

// Robot notebooks and the Robot REPL with the native backend's `interactive`
// service, driven by actual pointer and keyboard input: Run All, typed cells,
// the cell Stop button, the notebook toolbar's session actions, the REPL input
// and a paused Robot debug session's Debug Console next to a running notebook
// session. Session and worker processes are observed in /proc. Pending (never a
// pass) when the native backend venv is absent.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const nativeExecutable = process.env.ROBOT_COMPANION_NATIVE_BACKEND || "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
const alive = pid => { try { process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; } catch { return false; } };

const LIBRARY = `import sys, time
import robot.version


def who_am_i():
    return f"{sys.executable}|{robot.version.VERSION}"


def shout(text):
    print("printed " + text)
    return text.upper()


def native_sleep(seconds):
    time.sleep(float(seconds))
`;
const PAUSED = `*** Variables ***
\${SUITE_ONLY}    suite

*** Test Cases ***
Paused Console
    Log    before pause
    Log    paused here
    Catenate    SEPARATOR=-
    ...    \${SUITE_ONLY}
    ...    selected
`;
const CELLS = [
  "Import Library    SessionLibrary.py\n${who}=    Who Am I\nLog    ${PROJECT} runs ${who}",
  "${count}=    Evaluate    40 + 2\nLog To Console    count is ${count}",
  "Log    still ${count}\nShout    quiet",
  "No Such Keyword"
];

suite("Robot notebook and REPL sessions (native backend, live)", function () {
  let extension, sessions, folder, config, cdp, directory, notebookUri;
  const evidence = [];
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR;
  const python = () => fs.realpathSync(path.join(path.dirname(nativeExecutable), "python"));

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
    await sleep(120);
  }
  async function type(text) {
    await cdp.send("Input.insertText", { text }, cdp.pageSession);
    evidence.push({ action: "type", text });
    await sleep(150);
  }
  // A real pointer click on the visible element an expression returns, once its
  // position is stable and the point hits it.
  async function click(expression, label) {
    const point = await until(() => page(`(async () => {
      const box = () => { const el = ${expression}; if (!el || !el.getClientRects().length) return;
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const root = el.getRootNode(), hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y); // menus render in a shadow root
        return hit && (hit === el || el.contains(hit) || hit.contains(el)) ? { x, y } : undefined; };
      const a = box(); await new Promise(resolve => setTimeout(resolve, 150)); const b = box();
      return a && b && a.x === b.x && a.y === b.y ? b : undefined;
    })()`), `visible ${label}`).catch(async error => {
      const seen = await page(`(() => { const el = ${expression}; if (!el) return "no element"; const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return JSON.stringify({ rect: [r.x, r.y, r.width, r.height], hit: hit && (hit.className || hit.tagName), viewport: [innerWidth, innerHeight] }); })()`);
      throw new Error(`${error.message}: ${seen}`);
    });
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point,
        ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) }, cdp.pageSession);
      if (type === "mouseMoved") await sleep(120);
    }
    evidence.push({ action: "click", target: label, point });
    await sleep(250);
  }
  async function screenshot(name) {
    if (!evidenceDirectory) return;
    const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
    fs.writeFileSync(path.join(evidenceDirectory, `interactive-${name}.png`), Buffer.from(data, "base64"));
  }
  async function palette(command) {
    await key("F1", "F1", 112);
    await until(() => page("document.activeElement?.matches('.quick-input-widget input')"), "command palette");
    await type(command);
    await until(() => page(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(command.split(": ").pop())})`), `palette row ${command}`);
    await key("Enter", "Enter", 13);
  }
  const statusText = () => page("[...document.querySelectorAll('.statusbar-item')].map(e => e.textContent.trim()).find(t => t.startsWith('Robot session')) || ''");
  const notebook = () => vscode.workspace.notebookDocuments.find(document => document.uri.toString() === notebookUri.toString());
  const sessionOf = document => sessions.sessions.get(document.uri.toString());
  // What each output item of a cell shows: text (stream, plain) or the error's name and message.
  const outputs = cell => cell.outputs.flatMap(output => output.items).map(item => {
    const text = Buffer.from(item.data).toString("utf8");
    if (item.mime === "application/vnd.code.notebook.error") { const { name, message } = JSON.parse(text); return `${name}: ${message}`; }
    return text;
  }).join("");
  // The list renders visible rows only, in any DOM order: find a cell's row by its list index.
  const cellRow = index => `[...document.querySelectorAll('.notebook-editor .monaco-list-row.code-cell-row[data-index="${index}"]')].find(row => row.getClientRects().length && row.getBoundingClientRect().x >= 0)`;
  const runButton = index => `${cellRow(index)}?.querySelector('.run-button-container .action-label')`;
  async function moreAction(label) {
    await click("[...document.querySelectorAll('.notebook-toolbar-container .action-item a')].find(a => a.className.includes('toolbar-more'))", "notebook toolbar More Actions");
    // The menu renders in a shadow root.
    await click(`(() => { for (const host of document.querySelectorAll('.shadow-root-host')) {
      const item = [...(host.shadowRoot?.querySelectorAll('.action-label') || [])].find(e => e.textContent.trim() === ${JSON.stringify(label)});
      if (item) return item; } })()`, `More Actions > ${label}`);
  }
  // Scrolls the notebook so a cell is visible (navigation only; the actions on it are real input).
  async function reveal(index) {
    const editor = vscode.window.visibleNotebookEditors.find(item => item.notebook.uri.toString() === notebookUri.toString());
    editor.revealRange(new vscode.NotebookRange(index, index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    await sleep(400);
  }
  // Adds a code cell below the last one through the toolbar and types its text.
  async function typeCell(text) {
    const count = notebook().cellCount;
    await reveal(count - 1);
    await click(`${cellRow(count - 1)}?.querySelector('.view-lines')`, `cell ${count} editor`);
    await click("[...document.querySelectorAll('.notebook-toolbar-container .action-item a')].find(a => a.textContent.trim() === 'Code')", "toolbar + Code");
    await until(() => notebook().cellCount === count + 1, "new cell");
    await reveal(count);
    await type(text);
    await key("Escape", "Escape", 27);
    await until(() => notebook().cellAt(count).document.getText() === text, "typed cell text");
    return count;
  }
  async function runCell(index) {
    const before = notebook().cellAt(index).executionSummary?.timing?.endTime;
    await reveal(index);
    await click(runButton(index), `Execute Cell ${index + 1}`);
    return until(() => { const summary = notebook().cellAt(index).executionSummary; return summary?.timing?.endTime && summary.timing.endTime !== before && summary; },
      `cell ${index + 1} executed`, 60000);
  }
  // The rendered text of the output webview that shows `marker` (what a person sees, not the API items).
  async function renderedText(marker) {
    const frame = await cdp.findWebviewFrame(`return document.body.innerText.includes(${JSON.stringify(marker)});`, `output "${marker}"`, 20000);
    return cdp.evaluate(frame.frameId, "document.body.innerText");
  }
  // Every line of a mixed INFO/WARN/stdout/stderr/ERROR cell is rendered, in emission order,
  // WARN/ERROR marked; and the API items carry stderr for them.
  async function assertMixedRendered(cell, prefix) {
    const expected = [`${prefix}-info-first`, `[ WARN ] ${prefix}-warn-second`, `${prefix}-console-third`,
      `${prefix}-stderr-fourth`, `${prefix}-info-fifth`, `[ ERROR ] ${prefix}-error-sixth`];
    const rendered = await until(async () => { const text = (await renderedText(`${prefix}-info-first`)).replace(/\u00a0/g, " ");
      return expected.every(line => text.includes(line)) && text; }, `${prefix}: every mixed line rendered`, 20000)
      .catch(async error => { throw new Error(`${error.message}: rendered ${JSON.stringify((await renderedText(`${prefix}-info-first`)).slice(-1500))}`); });
    const positions = expected.map(line => rendered.indexOf(line));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${prefix}: rendered in emission order ${JSON.stringify(positions)}`);
    const items = cell.outputs.flatMap(output => output.items.map(item => [item.mime, Buffer.from(item.data).toString("utf8")]));
    for (const marker of ["warn-second", "stderr-fourth", "error-sixth"]) {
      assert.ok(items.some(([mime, text]) => mime === "application/vnd.code.notebook.stderr" && text.includes(`${prefix}-${marker}`)), `${marker} is stderr`);
    }
    for (const output of cell.outputs) assert.equal(new Set(output.items.map(item => item.mime)).size, 1, "one MIME per output");
    return rendered;
  }
  const mixedCell = prefix => [`Log    ${prefix}-info-first`, `Log    ${prefix}-warn-second    WARN`, `Log To Console    ${prefix}-console-third`,
    `Log To Console    ${prefix}-stderr-fourth    stream=STDERR`, `Log    ${prefix}-info-fifth`, `Log    ${prefix}-error-sixth    ERROR`].join("\n");
  async function webviewShows(text) {
    const frame = await cdp.findWebviewFrame(`return document.body.innerText.includes(${JSON.stringify(text)});`, `notebook output "${text}"`, 20000);
    return Boolean(frame);
  }

  suiteSetup(async function () {
    if (!nativeExecutable) { this.skip(); return; }
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    await extension.activate();
    sessions = require(path.join(extension.extensionPath, "src/core/extension")).__test__.getInteractiveWorkspaceForTest();
    folder = vscode.workspace.workspaceFolders[0];
    config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
    directory = path.join(folder.uri.fsPath, "interactive-session");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SessionLibrary.py"), LIBRARY);
    fs.writeFileSync(path.join(directory, "paused.robot"), PAUSED);
    fs.writeFileSync(path.join(directory, "session.robotnb"), JSON.stringify({ robotCompanionNotebook: 1,
      cells: CELLS.map(source => ({ kind: "code", source })) }, null, 2));
    notebookUri = vscode.Uri.file(path.join(directory, "session.robotnb"));
    await config.update("integrationMode", "owned", vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("nativeBackendExecutable", nativeExecutable, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update("robotArguments", ["--variable", "PROJECT:UI suite", "--pythonpath", "interactive-session"], vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
    cdp = await WebviewCdp.connect();
    evidence.push({ versions: { vscode: vscode.version }, nativeExecutable, python: python(),
      viewport: await page("({ width: innerWidth, height: innerHeight })") });
  });

  suiteTeardown(async () => {
    if (!sessions) return;
    if (notebook()) { await vscode.window.showNotebookDocument(notebook()); await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor"); }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await until(() => sessions.sessions.size === 0, "sessions released", 15000).catch(() => {});
    for (const name of ["robotArguments", "nativeBackendExecutable", "integrationMode"]) {
      await config.update(name, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, "interactive-ui-actions.json"), JSON.stringify(evidence, null, 2));
    fs.rmSync(directory, { recursive: true, force: true });
    cdp?.close();
  });

  test("Run All runs Robot keywords in the folder's environment, with per-cell output and errors", async () => {
    await palette("Go to File");
    await type("session.robotnb");
    await until(() => page("document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes('session.robotnb')"), "Go to File row");
    await key("Enter", "Enter", 13);
    await until(() => page("document.querySelectorAll('.notebook-editor .monaco-list-row.code-cell-row').length === 4"), "notebook with four cells");
    await until(async () => (await statusText()) === "Robot session: not started", "status before the first cell");
    assert.ok(await page("document.querySelector('.notebook-toolbar-container')?.innerText.includes('Robot Companion')"), "Robot Companion kernel selected");
    await click("[...document.querySelectorAll('.notebook-toolbar-container .action-item a')].find(a => a.textContent.includes('Run All'))", "toolbar Run All");
    const document = await until(() => { const doc = notebook(); return doc && [...doc.getCells()].every(cell => cell.executionSummary?.timing?.endTime) && doc; }, "all four cells ran", 60000);
    const [first, second, third, fourth] = document.getCells();
    assert.deepEqual(document.getCells().map(cell => [cell.executionSummary.executionOrder, cell.executionSummary.success]),
      [[1, true], [2, true], [3, true], [4, false]]);
    const session = sessionOf(document);
    const expected = `${python()}|`;
    assert.match(outputs(first), new RegExp(`^Started Robot session 1 in folder '${folder.name}'`));
    assert.ok(outputs(first).includes(`Working directory: ${folder.uri.fsPath}`), outputs(first));
    assert.ok(outputs(first).includes("Robot options: --variable --pythonpath"), outputs(first));
    assert.ok(fs.realpathSync(session.info.executable) === python(), "the worker runs the folder's selected interpreter");
    assert.ok(outputs(first).includes(`\${who} = ${session.info.executable}|${session.info.robot}\n`), outputs(first));
    const ran = outputs(first).split("\n").find(line => line.startsWith("UI suite runs "));
    assert.ok(ran && fs.realpathSync(ran.slice("UI suite runs ".length).split("|")[0]) === python() && ran.endsWith(`|${session.info.robot}`), ran);
    assert.equal(outputs(second), "${count} = 42\ncount is 42\n"); // RF logs the assignment itself
    assert.equal(outputs(third), "still 42\nprinted quiet\n'QUIET'");
    assert.equal(outputs(fourth), "FAIL: No keyword with name 'No Such Keyword' found.");
    // The output webview renders the outputs of cells in view: reveal each before reading it.
    await reveal(1);
    assert.ok(await webviewShows("count is 42"));
    await reveal(3);
    assert.ok(await webviewShows("No keyword with name 'No Such Keyword' found."));
    await until(async () => (await statusText()) === "Robot session 1: idle", "status idle");
    assert.ok(alive(session.process.child.pid) && alive(session.info.processId), "session service and worker run");
    await screenshot("notebook-run-all");
    evidence.push({ result: "Run All", expected, cells: document.getCells().map(outputs), worker: session.info });
  });

  test("A cell mixing INFO, WARN, console, stderr and ERROR output renders every line in order", async () => {
    const mixed = await typeCell(mixedCell("nb"));
    assert.equal((await runCell(mixed)).success, true);
    await reveal(mixed);
    const rendered = await assertMixedRendered(notebook().cellAt(mixed), "nb");
    await screenshot("notebook-mixed-output");
    evidence.push({ result: "mixed output (notebook)", rendered: rendered.slice(-800) });
  });

  test("Stop interrupts a typed Sleep cell and keeps variables; More Actions shows them and Restart clears them", async () => {
    const sleepCell = await typeCell("Sleep    30s");
    await reveal(sleepCell);
    await click(runButton(sleepCell), "Execute Cell (Sleep)");
    await until(async () => (await statusText()) === "Robot session 1: busy", "busy session");
    await until(() => page(`${runButton(sleepCell)}?.getAttribute('aria-label') === 'Stop Cell Execution'`), "Stop button");
    await screenshot("notebook-busy");
    const started = Date.now();
    await click(runButton(sleepCell), "Stop Cell Execution");
    await until(() => notebook().cellAt(sleepCell).executionSummary?.timing?.endTime, "interrupted cell ended", 10000);
    const stopped = Date.now() - started;
    assert.ok(stopped < 3000, `Interrupt took ${stopped} ms`);
    assert.equal(notebook().cellAt(sleepCell).executionSummary.success, false);
    assert.equal(outputs(notebook().cellAt(sleepCell)), "Interrupted: The cell was interrupted. The Robot session and its variables are kept.");
    await until(async () => (await statusText()) === "Robot session 1: idle", "idle after interrupt");
    const after = await typeCell("Log    after interrupt ${count}");
    assert.equal((await runCell(after)).success, true);
    assert.equal(outputs(notebook().cellAt(after)), "after interrupt 42\n");

    await moreAction("Show Robot Session Variables");
    await until(() => page("document.querySelector('.quick-input-widget')?.textContent.includes('variables')"), "variables picker");
    const rows = await page("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.getAttribute('aria-label'))");
    assert.ok(rows.includes("${count}, 42, int, Set in cells"), JSON.stringify(rows));
    assert.ok(rows.some(row => row.startsWith("${who}, ")), JSON.stringify(rows));
    await screenshot("notebook-variables");
    // The list renders visible rows only: filter it as a person would.
    await type("PROJECT");
    const filtered = await until(async () => { const found = await page("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.getAttribute('aria-label'))");
      return found.length && found.every(row => row.includes("PROJECT")) && found; }, "filtered variables");
    assert.ok(filtered.some(row => row.startsWith("${PROJECT}, 'UI suite', str")), JSON.stringify(filtered));
    await key("Escape", "Escape", 27);

    const before = sessionOf(notebook()).info;
    await moreAction("Restart Robot Session");
    await until(async () => (await statusText()) === "Robot session 2: idle", "restarted session");
    await until(() => !alive(before.processId), "previous worker ended");
    assert.equal((await runCell(after)).success, false);
    assert.equal(outputs(notebook().cellAt(after)), "FAIL: Variable '${count}' not found.");
    evidence.push({ result: "interrupt/variables/restart", stoppedMs: stopped, rows: rows.slice(0, 6), previousWorker: before.processId,
      worker: sessionOf(notebook()).info.processId });
  });

  test("Stop on a keyword blocked in native code ends the session; the next cell starts a new one", async () => {
    const blocked = await typeCell("Import Library    SessionLibrary.py\nNative Sleep    120");
    const { processId: worker, sessionId } = sessionOf(notebook()).info;
    await reveal(blocked);
    await click(runButton(blocked), "Execute Cell (Native Sleep)");
    await until(async () => (await statusText()) === `Robot session ${sessionId}: busy`, "busy session");
    await sleep(500);
    await click(runButton(blocked), "Stop Cell Execution (native call)");
    await until(() => notebook().cellAt(blocked).executionSummary?.timing?.endTime, "blocked cell ended", 20000);
    assert.equal(outputs(notebook().cellAt(blocked)), "Interrupted: The cell did not stop within 5 s of Interrupt; the Robot session was ended and its variables are gone");
    await until(async () => (await statusText()) === "Robot session: ended", "ended session");
    await until(() => !alive(worker), "blocked worker ended");
    await screenshot("notebook-session-ended");
    const next = await typeCell("Log    fresh session");
    assert.equal((await runCell(next)).success, true);
    assert.ok(outputs(notebook().cellAt(next)).startsWith(`Started Robot session ${sessionId + 1} in folder`), outputs(notebook().cellAt(next)));
    assert.ok(outputs(notebook().cellAt(next)).endsWith("fresh session\n"));
    evidence.push({ result: "native interrupt", endedWorker: worker, worker: sessionOf(notebook()).info.processId });
  });

  test("The Robot REPL runs typed commands in its own session", async () => {
    await palette("Robot Companion: Open Robot REPL");
    const input = "document.querySelector('.interactive-editor .input-editor-container .monaco-editor .view-lines, .input-editor-container .monaco-editor .view-lines')";
    await until(() => page(`Boolean(${input})`), "REPL input");
    const repl = await until(() => vscode.workspace.notebookDocuments.find(document => document.notebookType === "interactive"), "REPL document");
    await until(() => page("[...document.querySelectorAll('.kernel-label')].some(e => e.textContent === 'Robot Companion REPL')"), "REPL controller");
    const command = async (text, count) => {
      await click(input, "REPL input");
      await type(text);
      await key("Escape", "Escape", 27);
      await key("Enter", "Enter", 13);
      return until(() => { const cell = repl.cellCount >= count && repl.cellAt(count - 1); return cell?.executionSummary?.timing?.endTime && cell; },
        `REPL command ${count}`, 60000);
    };
    const set = await command("${greeting}=    Set Variable    hello repl", 1);
    assert.match(outputs(set), /^Started Robot session 1 in folder/);
    const logged = await command("Log    ${greeting} from ${EXECDIR}", 2);
    assert.equal(outputs(logged), `hello repl from ${folder.uri.fsPath}\n`);
    // The notebook's ${count} belongs to another session.
    const isolated = await command("Get Variable Value    ${count}    not in this session", 3);
    assert.equal(outputs(isolated), "'not in this session'");
    // The REPL input takes one command per Enter: the mixed cell's lines as one Run Keywords call.
    const mixed = await command(`Run Keywords    ${mixedCell("repl").split("\n").map(line => line.replace(/ {4}/g, "    ")).join("    AND    ")}`, 4);
    await assertMixedRendered(mixed, "repl");
    const replSession = sessionOf(repl), notebookSession = sessionOf(notebook());
    assert.notEqual(replSession.info.processId, notebookSession.info.processId);
    assert.ok(alive(replSession.info.processId) && alive(notebookSession.info.processId));
    assert.ok(await webviewShows("hello repl from"));
    await until(async () => (await statusText()) === "Robot session 1: idle", "REPL status");
    // The status item opens the REPL session's variables.
    await click("[...document.querySelectorAll('.statusbar-item')].find(e => e.textContent.trim().startsWith('Robot session'))?.querySelector('a') || [...document.querySelectorAll('.statusbar-item')].find(e => e.textContent.trim().startsWith('Robot session'))", "Robot session status item");
    await until(() => page("document.querySelector('.quick-input-widget')?.textContent.includes('variables')"), "REPL variables picker");
    const replRows = await page("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(r => r.getAttribute('aria-label'))");
    assert.equal(replRows[0], "${greeting}, 'hello repl', str, Set in cells", JSON.stringify(replRows));
    assert.ok(!replRows.some(row => row.startsWith("${count},")), "the notebook's variables are not in the REPL session");
    await key("Escape", "Escape", 27);
    await screenshot("repl");
    evidence.push({ result: "REPL", outputs: [set, logged, isolated].map(outputs), worker: replSession.info.processId, notebookWorker: notebookSession.info.processId });
  });

  test("Evaluate in Debug Console accepts the selected Robot call with continuation lines", async () => {
    const paused = vscode.Uri.file(path.join(directory, "paused.robot"));
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(paused, new vscode.Position(6, 4)));
    vscode.debug.addBreakpoints([breakpoint]);
    const stopped = new Promise(resolve => {
      const listener = vscode.debug.onDidChangeActiveStackItem(item => { if (item) { listener.dispose(); resolve(item); } });
    });
    assert.equal(await vscode.debug.startDebugging(folder, { type: "robotcompanion", request: "launch", name: "Selected multiline call",
      target: paused.fsPath, attachPython: false }), true);
    await stopped;
    const session = vscode.debug.activeDebugSession;
    const editor = await vscode.window.showTextDocument(paused);
    const selection = new vscode.Selection(7, 4, 9, editor.document.lineAt(9).text.length);
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    assert.equal(editor.document.getText(selection), "Catenate    SEPARATOR=-\n    ...    ${SUITE_ONLY}\n    ...    selected");
    // The native editor context action forwards the entire selection through
    // DAP, rather than this test calling evaluate with a hand-built expression.
    await key("F10", "F10", 121, 8); // Shift+F10: editor context menu.
    await click(`(() => { for (const root of [document, ...[...document.querySelectorAll('.shadow-root-host')].map(host => host.shadowRoot).filter(Boolean)]) {
      const item = [...root.querySelectorAll('.action-label')].find(e => e.textContent.trim() === 'Evaluate in Debug Console');
      if (item) return item; } })()`, "Evaluate in Debug Console");
    const consoleText = await until(() => page("document.querySelector('.repl .monaco-list')?.innerText.includes(\"'suite-selected'\") && document.querySelector('.repl .monaco-list').innerText"),
      "selected multiline result in Debug Console");
    await screenshot("selected-multiline-console");
    evidence.push({ result: "native selected multiline evaluation", selection: editor.document.getText(selection), console: consoleText.slice(-700) });
    const ended = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(item => { if (item.id === session.id) { listener.dispose(); resolve(); } });
    });
    await click("[...document.querySelectorAll('.debug-toolbar .codicon-debug-stop')].find(e => e.offsetParent)", "debug toolbar Stop");
    await ended;
    vscode.debug.removeBreakpoints([breakpoint]);
  });

  test("A paused Robot debug session keeps its Debug Console context next to a notebook session", async () => {
    await vscode.window.showNotebookDocument(notebook());
    const own = await typeCell("${notebook_only}=    Set Variable    nb");
    assert.equal((await runCell(own)).success, true);
    const worker = sessionOf(notebook()).info.processId;
    const paused = vscode.Uri.file(path.join(directory, "paused.robot"));
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(paused, new vscode.Position(6, 4)))]);
    const stopped = new Promise(resolve => {
      const listener = vscode.debug.onDidChangeActiveStackItem(item => { if (item) { listener.dispose(); resolve(item); } });
    });
    assert.equal(await vscode.debug.startDebugging(folder, { type: "robotcompanion", request: "launch", name: "Paused console",
      target: paused.fsPath, attachPython: false }), true);
    await stopped;
    const session = vscode.debug.activeDebugSession;
    const consoleVisible = () => page("Boolean(document.querySelector('.repl .repl-input-wrapper .monaco-editor')?.getClientRects().length)");
    if (!await consoleVisible()) await key("Y", "KeyY", 89, 10); // Linux Ctrl+Shift+Y: Debug Console
    await until(consoleVisible, "Debug Console");
    const replText = () => page("document.querySelector('.repl .monaco-list')?.innerText || ''");
    const evaluate = async (text, expected) => {
      await click("document.querySelector('.repl .repl-input-wrapper .monaco-editor .view-lines')", "Debug Console input");
      await type(text);
      await key("Escape", "Escape", 27);
      await key("Enter", "Enter", 13);
      return until(async () => (await replText()).includes(expected) && replText(), `Debug Console shows ${expected}`);
    };
    await evaluate("Catenate    ${SUITE_ONLY}    paused", "'suite paused'");
    await evaluate("Get Variable Value    ${notebook_only}    absent in debug", "'absent in debug'");
    // Unchanged paused-console rule: one keyword call without an assignment.
    await evaluate("${x}=    Set Variable    1", "Enter one Robot keyword call without an assignment");
    await screenshot("paused-debug-console");
    await vscode.window.showNotebookDocument(notebook());
    const probe = await typeCell("Get Variable Value    ${SUITE_ONLY}    absent in notebook");
    assert.equal((await runCell(probe)).success, true);
    assert.equal(outputs(notebook().cellAt(probe)), "'absent in notebook'");
    assert.equal(sessionOf(notebook()).info.processId, worker, "the notebook session is the same worker");
    const ended = new Promise(resolve => {
      const listener = vscode.debug.onDidTerminateDebugSession(item => { if (item.id === session.id) { listener.dispose(); resolve(); } });
    });
    await click("[...document.querySelectorAll('.debug-toolbar .codicon-debug-stop')].find(e => e.offsetParent)", "debug toolbar Stop");
    await ended;
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    assert.ok(alive(worker), "stopping the debug session leaves the notebook session running");
    evidence.push({ result: "paused console separation", worker, console: (await replText()).slice(-600) });
  });

  test("Closing the notebook and the REPL ends their sessions and processes", async () => {
    const owned = [...sessions.sessions.values()].flatMap(session => [session.process?.child?.pid, session.info?.processId]).filter(Boolean);
    assert.equal(owned.length, 4, "two services and two workers");
    // The typed cells are unsaved: revert the notebook rather than answer a save prompt.
    await vscode.window.showNotebookDocument(notebook());
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    // Close only this suite's REPL tab: dirty editors left by earlier suites would make
    // Close All Editors wait on a save prompt.
    const keys = new Set(sessions.sessions.keys());
    const own = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      tab.input instanceof vscode.TabInputInteractiveWindow || (tab.input?.uri && keys.has(tab.input.uri.toString())));
    await vscode.window.tabGroups.close(own, false);
    await until(() => sessions.sessions.size === 0, "sessions released", 20000).catch(async error => {
      const dialog = await page("document.querySelector('.monaco-dialog-box')?.innerText || ''");
      throw new Error(`${error.message}; open sessions ${JSON.stringify([...sessions.sessions.keys()])}; ` +
        `tabs ${JSON.stringify(vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.label))}; dialog ${JSON.stringify(dialog)}`);
    });
    await until(() => owned.every(pid => !alive(pid)), "session processes ended", 20000);
    assert.equal(await statusText(), "", "no session status without a Robot notebook");
    evidence.push({ result: "closed", ended: owned });
  });
});

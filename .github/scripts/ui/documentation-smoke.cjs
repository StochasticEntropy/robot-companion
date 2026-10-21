"use strict";

// VS Code APIs arrange the synthetic editor and inspect results. The operation
// under test is a trusted pointer click on Companion's rendered source link.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { WebviewCdp } = require("./webview-cdp.cjs");

const EXPECTED_TEXT = "Click this documented source sentence.";
const EXPECTED_LINE = 3;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

suite("Windows Companion documentation UI smoke", () => {
  test("trusted rendered-documentation click opens its exact source line", async function () {
    const output = process.env.WINDOWS_UI_EVIDENCE;
    const actions = [];
    const proof = {
      kind: "rendered-documentation-source-click", platform: process.platform,
      vscode: vscode.version, electron: process.versions.electron, node: process.versions.node,
      expected: { line: EXPECTED_LINE, text: `    #> - ${EXPECTED_TEXT}` },
      assertions: {}, actions,
      claims: { keywordNavigation: false, nativeBackend: false, robotDebug: false, mixedPythonDebug: false }
    };
    let cdp;
    const save = () => fs.writeFileSync(path.join(output, "ui-proof.json"), JSON.stringify(proof, null, 2));
    async function page(expression) {
      const response = await cdp.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true
      }, cdp.pageSession);
      assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    }
    async function screenshot(name) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, cdp.pageSession);
      const bytes = Buffer.from(data, "base64");
      assert(bytes.length > 1024 && bytes.subarray(1, 4).toString() === "PNG", "a real non-empty PNG screenshot");
      fs.writeFileSync(path.join(output, `${name}.png`), bytes);
      actions.push({ action: "screenshot", path: `${name}.png`, bytes: bytes.length });
    }
    const focusState = () => page(`(() => {
      const active = document.activeElement;
      return { documentFocused: document.hasFocus(), tag: active?.tagName,
        className: active?.className, label: active?.getAttribute('aria-label'),
        inEditor: Boolean(active?.closest('.editor-instance .monaco-editor')) };
    })()`);
    async function focusEditorByPointer() {
      let point, previous;
      await until(async () => {
        point = await page(`(() => {
          const row = [...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
            .find(element => element.innerText.replaceAll('\\u00a0', ' ').includes('Log')
              && element.innerText.replaceAll('\\u00a0', ' ').includes('ready'));
          if (!row) return;
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const start = node.textContent.indexOf('Log'); if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start + 1); range.setEnd(node, start + 2);
            const rect = range.getBoundingClientRect();
            const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
            if (!rect.width || !rect.height || y < 0 || y > innerHeight) return;
            const hit = document.elementFromPoint(x, y), lines = row.closest('.view-lines');
            // Only a hit in this editor's text layer qualifies. A chat pane,
            // hover, overlay or another editor must never receive the click.
            return {x, y, hitTag: hit?.tagName, hitClass: hit?.className,
              blocked: !hit || !lines?.contains(hit)};
          }
        })()`);
        proof.editorHitCandidate = point;
        const stable = point && !point.blocked && previous && point.x === previous.x && point.y === previous.y;
        previous = point;
        return stable;
      }, "stable unobscured Log token in the actual editor");
      proof.editorHitTest = { passed: true, ...point };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, cdp.pageSession);
      await delay(100);
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {
        type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1
      }, cdp.pageSession);
      await until(async () => {
        const selected = vscode.window.activeTextEditor;
        return selected?.document.uri.toString() === document.uri.toString()
          && selected.selection.active.line === 5
          && selected.selection.active.character < document.lineAt(5).text.length
          && (await focusState()).inEditor;
      }, "trusted pointer click focuses the editor before the End key");
      proof.focusBeforeEnd = await focusState();
      proof.assertions.editorFocusByPointer = true;
    }
    let document;
    try {
      assert.equal(process.platform, "win32", "this receipt must come from a Windows test host");
      assert.equal(vscode.version, "1.141.0", "the UI runtime is pinned");
      const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion");
      assert(extension, "the selected Companion extension is loaded");
      await extension.activate();
      proof.extension = { id: extension.id, version: extension.packageJSON.version, path: extension.extensionPath };
      for (const id of ["d-biehl.robotcode", "robocorp.robotframework-lsp", "ms-python.python", "ms-python.debugpy"]) {
        assert.equal(vscode.extensions.getExtension(id), undefined, `${id} must be absent`);
      }
      proof.assertions.externalProviderExtensionsAbsent = true;
      const folder = vscode.workspace.workspaceFolders[0];
      document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "documentation-smoke.robot"));
      assert.equal(document.lineAt(EXPECTED_LINE).text, proof.expected.text);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      // Opening the panel is setup, and is recorded as such. No source-jump
      // command or provider is invoked by the test.
      await vscode.commands.executeCommand("robotCompanion.openCurrentBlock");
      actions.push({ action: "setup", command: "robotCompanion.openCurrentBlock" });
      cdp = await WebviewCdp.connect();
      const originalSend = cdp.send.bind(cdp);
      cdp.send = (method, params, session) => {
        if (method.startsWith("Input.")) actions.push({ action: "trusted-input", method, params });
        return originalSend(method, params, session);
      };
      proof.viewport = await page("({width: innerWidth, height: innerHeight, scale: devicePixelRatio})");
      assert(proof.viewport.width >= 600 && proof.viewport.height >= 400, "visible rendered workbench viewport");
      // The End key is also real input: the editor must receive it before the
      // source-link click. Resolve the webview frame afterwards, because the
      // resulting selection event legitimately refreshes the preview.
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      editor.selection = new vscode.Selection(5, 0, 5, 0);
      proof.focusBeforePointer = await focusState();
      await focusEditorByPointer();
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", {
        type, key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35
      }, cdp.pageSession);
      await until(() => vscode.window.activeTextEditor?.selection.active.line === 5
        && vscode.window.activeTextEditor.selection.active.character === document.lineAt(5).text.length,
      "End key reaches the editor");
      proof.focusAfterEnd = await focusState();
      proof.assertions.actualKeyboardInput = true;
      proof.before = { uri: editor.document.uri.toString(), line: editor.selection.active.line,
        character: editor.selection.active.character };
      let frame = await cdp.findWebviewFrame(
        `return Boolean(document.querySelector('.doc-render-flow')) && document.body.innerText.includes(${JSON.stringify(EXPECTED_TEXT)});`,
        "Companion's actual documentation preview", 30000
      );
      proof.preview = await cdp.evaluate(frame.frameId, "document.querySelector('.doc-render-flow').innerText");
      assert.match(proof.preview, /Windows UI source click/);
      assert(proof.preview.includes(EXPECTED_TEXT));
      proof.assertions.documentationRendered = true;

      // The editor is on a different line in the same documented test, so the
      // tested click must move the caret rather than repeat the setup result.
      assert.notEqual(editor.selection.active.line, EXPECTED_LINE);
      const target = `[...document.querySelectorAll('.doc-render-flow [data-source-command]')].find(e => e.innerText.trim() === ${JSON.stringify(EXPECTED_TEXT)})`;
      let point, scrolls = 0;
      await until(async () => {
        frame = await cdp.findWebviewFrame(
          `return Boolean(document.querySelector('.doc-render-flow')) && document.body.innerText.includes(${JSON.stringify(EXPECTED_TEXT)});`,
          "documentation source link after selection refresh", 5000);
        point = await cdp.evaluate(frame.frameId, `(() => {
          const element = ${target}; if (!element) return;
          const copy = r => ({x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right});
          const elementRects = [...element.getClientRects()].map(copy);
          const textRects = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const start = node.textContent.search(/\\S/); if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 1);
            textRects.push(...[...range.getClientRects()].map(copy));
          }
          const nonempty = r => r.width > 0 && r.height > 0;
          const visible = r => nonempty(r) && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
          // An inline source span may wrap. Its bounding-box center can hit
          // blank space after a short second line, outside the actual span.
          const r = textRects.find(visible) || textRects.find(nonempty) || elementRects.find(nonempty);
          if (!r) return;
          return {x:r.x+r.width/2,y:r.y+r.height/2,top:r.top,bottom:r.bottom,
            width:innerWidth,height:innerHeight, tag:element.tagName,
            elementBounds:copy(element.getBoundingClientRect()),elementRects,textRects,scroll:{x:scrollX,y:scrollY}};
        })()`);
        proof.sourceTargetGeometry = point;
        if (point && (point.top < 0 || point.bottom > point.height)) {
          assert(scrolls++ < 12, "documentation target must become visible through bounded real scrolling");
          const origin = await cdp.frameOrigin(frame);
          const position = {x: Math.round(origin.pageX + point.width / 2),
            y: Math.round(origin.pageY + point.height / 2)};
          const hit = await cdp.send("DOM.getNodeForLocation", {
            ...position, includeUserAgentShadowDOM: false
          }, cdp.pageSession);
          assert.equal(hit.backendNodeId, origin.webviewOwnerNodeId, "scroll input hits the actual documentation webview");
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...position }, cdp.pageSession);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...position,
            deltaX: 0, deltaY: point.top < 0 ? -180 : 180 }, cdp.pageSession);
          return false;
        }
        if (!point) return false;
        try { return await cdp.hitsElement(frame, point.x, point.y, target); }
        finally { proof.sourceHitTest = cdp.lastHitTest; }
      }, "visible unobscured documentation source link");
      proof.hitTest = { passed: true, point };
      await screenshot("before-source-click");
      const sourceInputStart = actions.length;
      await cdp.click(frame, point.x, point.y);
      await until(() => {
        const selected = vscode.window.activeTextEditor;
        return selected?.document.uri.toString() === document.uri.toString()
          && selected.selection.active.line === EXPECTED_LINE;
      }, "trusted click selects the exact source line");
      const selected = vscode.window.activeTextEditor;
      proof.selected = {
        uri: selected.document.uri.toString(), line: selected.selection.active.line,
        character: selected.selection.active.character,
        text: selected.document.lineAt(selected.selection.active.line).text
      };
      assert.equal(proof.selected.text, proof.expected.text);
      assert.equal(proof.selected.character, 0);
      assert(actions.slice(sourceInputStart).some(action => action.method === "Input.dispatchMouseEvent" && action.params.type === "mousePressed"));
      proof.assertions.actualPointerClick = true;
      proof.assertions.exactSourceLine = true;
      await screenshot("after-source-click");
      proof.outcome = "passed";
    } catch (error) {
      proof.outcome = "failed";
      proof.error = { name: error.name, message: error.message, stack: error.stack };
      if (cdp) {
        proof.focusAtFailure = await focusState().catch(failure => ({ error: failure.message }));
        proof.editorAtFailure = {
          uri: vscode.window.activeTextEditor?.document.uri.toString(),
          line: vscode.window.activeTextEditor?.selection.active.line,
          character: vscode.window.activeTextEditor?.selection.active.character
        };
        proof.visibleEditorLines = await page(`[...document.querySelectorAll('.editor-instance .monaco-editor .view-line')]
          .filter(e => e.getBoundingClientRect().height > 0).slice(0, 12).map(e => e.innerText)`)
          .catch(failure => ({ error: failure.message }));
      }
      if (cdp) await screenshot("failure").catch(failure => { proof.screenshotError = failure.message; });
      throw error;
    } finally {
      save();
      cdp?.close();
    }
  });
});

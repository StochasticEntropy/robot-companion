const fs = require("fs");
const path = require("path");

// Drives the real webviews of the VS Code window under test through the Chrome DevTools Protocol:
// evaluates in a webview's content frame, hit-tests and sends trusted mouse clicks. VS Code ignores
// untrusted (script-generated) clicks on links, so a real click needs this. run-ui-tests.js starts VS
// Code with --remote-debugging-port=0 and a fresh profile, where Chromium writes the DevTools port.
// Each webview is an out-of-process iframe target; its content is the frame inside it.
// CI-owned copy of the baseline helper, with bounded protocol waits.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WebviewCdp {
  static async connect() {
    const userDataPath = process.env.ROBOT_COMPANION_UI_USER_DATA_DIR;
    if (!userDataPath) {
      throw new Error("ROBOT_COMPANION_UI_USER_DATA_DIR is not set; run the UI tests through tests/ui/run-ui-tests.js.");
    }
    const [port, browserPath] = fs.readFileSync(path.join(userDataPath, "DevToolsActivePort"), "utf8").split("\n");
    const socket = new WebSocket(`ws://127.0.0.1:${port.trim()}${browserPath.trim()}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("VS Code DevTools connection timed out.")); }, 15000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Could not connect to the VS Code DevTools endpoint.")); };
    });
    const cdp = new WebviewCdp(socket);
    const { targetInfos } = await cdp.send("Target.getTargets");
    const workbench = targetInfos.find((target) => target.type === "page" && target.url.includes("workbench.html"));
    if (!workbench) {
      throw new Error("Could not find the VS Code workbench page target.");
    }
    cdp.pageSession = await cdp.attach(workbench.targetId);
    return cdp;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.pageSession = undefined;
    // targetId -> sessionId of the attached webview targets
    this.webviewSessions = new Map();
    // frameId -> { sessionId, contextId } of each frame's default execution context
    this.contexts = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          resolve(message.result);
        }
        return;
      }
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params.context;
        if (context.auxData && context.auxData.isDefault && context.auxData.frameId) {
          this.contexts.set(context.auxData.frameId, { sessionId: message.sessionId, contextId: context.id });
        }
      } else if (message.method === "Runtime.executionContextDestroyed") {
        for (const [frameId, context] of this.contexts) {
          if (context.sessionId === message.sessionId && context.contextId === message.params.executionContextId) {
            this.contexts.delete(frameId);
          }
        }
      } else if (message.method === "Runtime.executionContextsCleared") {
        for (const [frameId, context] of this.contexts) {
          if (context.sessionId === message.sessionId) {
            this.contexts.delete(frameId);
          }
        }
      } else if (message.method === "Target.detachedFromTarget") {
        for (const [targetId, sessionId] of this.webviewSessions) {
          if (sessionId === message.params.sessionId) {
            this.webviewSessions.delete(targetId);
          }
        }
      }
    };
    socket.onclose = () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("VS Code DevTools connection closed."));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}, sessionId = undefined) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after 15 seconds: CDP ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Page.enable", {}, sessionId);
    await this.send("DOM.enable", {}, sessionId);
    return sessionId;
  }

  close() {
    this.socket.close();
  }

  async evaluate(frameId, expression) {
    const context = this.contexts.get(frameId);
    if (!context) {
      throw new Error(`No execution context for frame ${frameId}.`);
    }
    const result = await this.send(
      "Runtime.evaluate",
      { expression, contextId: context.contextId, returnByValue: true, awaitPromise: true },
      context.sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
    }
    return result.result.value;
  }

  // The content frames of all webviews: { frameId, sessionId, targetId }.
  async listWebviewContentFrames() {
    const { targetInfos } = await this.send("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type === "iframe" && target.url.startsWith("vscode-webview://") && !this.webviewSessions.has(target.targetId)) {
        try {
          this.webviewSessions.set(target.targetId, await this.attach(target.targetId));
        } catch {
          // The webview went away meanwhile.
        }
      }
    }
    const frames = [];
    for (const [targetId, sessionId] of this.webviewSessions) {
      try {
        const { frameTree } = await this.send("Page.getFrameTree", {}, sessionId);
        for (const child of frameTree.childFrames || []) {
          frames.push({ frameId: child.frame.id, sessionId, targetId });
        }
      } catch {
        this.webviewSessions.delete(targetId);
      }
    }
    return frames;
  }

  // Finds the content frame of a visible webview for which `predicate` (a function body evaluated in
  // the frame, returning a boolean) is true. Returns the frame descriptor.
  async findWebviewFrame(predicate, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      for (const frame of await this.listWebviewContentFrames()) {
        if (!this.contexts.has(frame.frameId)) {
          continue;
        }
        try {
          const matches = await this.evaluate(
            frame.frameId,
            `(() => { if (document.readyState !== "complete" || !document.body) { return false; } ${predicate} })()`
          );
          if (matches && (await this.frameOrigin(frame)).visible) {
            return frame;
          }
        } catch (error) {
          lastError = error;
          if (/Cannot find context/.test(error.message)) {
            this.contexts.delete(frame.frameId);
          }
        }
      }
      await sleep(100);
    }
    const seen = [];
    for (const frame of await this.listWebviewContentFrames()) {
      try {
        const text = await this.evaluate(frame.frameId, `String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 160)`);
        seen.push(`${JSON.stringify(text)} visible=${(await this.frameOrigin(frame)).visible}`);
      } catch (error) {
        seen.push(`(${error.message})`);
      }
    }
    throw new Error(
      `Timed out waiting for the webview frame of ${description}.${lastError ? ` ${lastError.message}` : ""} Webviews: ${seen.join(" | ")}`
    );
  }

  // Where the content frame's viewport is, inside its webview (local) and on the VS Code page.
  async frameOrigin(frame) {
    const inner = await this.send("DOM.getFrameOwner", { frameId: frame.frameId }, frame.sessionId);
    const innerBox = (await this.send("DOM.getBoxModel", { backendNodeId: inner.backendNodeId }, frame.sessionId)).model;
    const outer = await this.send("DOM.getFrameOwner", { frameId: frame.targetId }, this.pageSession);
    const outerBox = (await this.send("DOM.getBoxModel", { backendNodeId: outer.backendNodeId }, this.pageSession)).model;
    return {
      localX: innerBox.content[0],
      localY: innerBox.content[1],
      pageX: outerBox.content[0] + innerBox.content[0],
      pageY: outerBox.content[1] + innerBox.content[1],
      webviewOwnerNodeId: outer.backendNodeId,
      visible: innerBox.width > 0 && innerBox.height > 0 && outerBox.width > 0 && outerBox.height > 0
    };
  }

  // True when the browser's hit test at the point (CSS pixels in the content frame) lands on the
  // element `elementExpression` evaluates to, or inside it, and nothing of VS Code covers the webview
  // there.
  async hitsElement(frame, x, y, elementExpression) {
    const origin = await this.frameOrigin(frame);
    const pageHit = await this.send(
      "DOM.getNodeForLocation",
      { x: Math.round(origin.pageX + x), y: Math.round(origin.pageY + y), includeUserAgentShadowDOM: false },
      this.pageSession
    );
    if (pageHit.backendNodeId !== origin.webviewOwnerNodeId) {
      return false;
    }
    const hit = await this.send(
      "DOM.getNodeForLocation",
      { x: Math.round(origin.localX + x), y: Math.round(origin.localY + y), includeUserAgentShadowDOM: false },
      frame.sessionId
    );
    if (hit.frameId !== frame.frameId) {
      return false;
    }
    const context = this.contexts.get(frame.frameId);
    const { object: hitObject } = await this.send(
      "DOM.resolveNode",
      { backendNodeId: hit.backendNodeId, executionContextId: context.contextId },
      frame.sessionId
    );
    const { result: elementObject } = await this.send(
      "Runtime.evaluate",
      { expression: elementExpression, contextId: context.contextId },
      frame.sessionId
    );
    if (!elementObject.objectId) {
      return false;
    }
    const { result } = await this.send(
      "Runtime.callFunctionOn",
      {
        objectId: elementObject.objectId,
        functionDeclaration: "function (hit) { return this === hit || this.contains(hit); }",
        arguments: [{ objectId: hitObject.objectId }],
        returnByValue: true
      },
      frame.sessionId
    );
    return result.value === true;
  }

  // A trusted left click at a point (CSS pixels in the content frame), sent to the VS Code page.
  async click(frame, x, y) {
    const origin = await this.frameOrigin(frame);
    const point = { x: Math.round(origin.pageX + x), y: Math.round(origin.pageY + y) };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, this.pageSession);
    // Input is routed to a webview by the compositor's hit-test data, which follows layout changes
    // (a new panel, scrolling) a little later than the DOM does.
    await sleep(200);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 }, this.pageSession);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }, this.pageSession);
  }
}

module.exports = { WebviewCdp };

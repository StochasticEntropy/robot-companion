"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { WebviewCdp } = require("./webview-cdp.cjs");

const frame = { frameId: "content-frame", sessionId: "webview-session", targetId: "webview-target" };

function protocol({ pageNode = 40, localFrame = frame.frameId, contains = true, missingTarget = false } = {}) {
  const cdp = new WebviewCdp({});
  cdp.pageSession = "workbench-session";
  cdp.contexts.set(frame.frameId, { sessionId: frame.sessionId, contextId: 90 });
  cdp.frameOrigin = async () => ({
    pageX: 48, pageY: 95, localX: 4, localY: 6, webviewOwnerNodeId: 40, visible: true
  });
  const calls = [];
  cdp.send = async (method, params, session) => {
    calls.push({ method, params, session });
    if (method === "DOM.getNodeForLocation") return session === cdp.pageSession
      ? { backendNodeId: pageNode, frameId: "workbench-frame" }
      : { backendNodeId: 60, frameId: localFrame };
    if (method === "DOM.describeNode") return {
      node: { nodeName: "SPAN", localName: "span", attributes: ["class", "source-text", "src", "not-recorded"] }
    };
    if (method === "DOM.resolveNode") return { object: { objectId: "actual-hit" } };
    if (method === "Runtime.evaluate") return { result: missingTarget ? {} : { objectId: "expected-source" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: contains } };
    throw new Error(`Unexpected protocol method ${method}`);
  };
  return { cdp, calls };
}

test("a source hit requires both parent ownership and same-frame target containment", async () => {
  const { cdp, calls } = protocol();
  assert.equal(await cdp.hitsElement(frame, 55.2, 210.2, "expectedSource"), true);
  assert.equal(cdp.lastHitTest.passed, true);
  const hits = calls.filter(call => call.method === "DOM.getNodeForLocation");
  assert.deepEqual(hits.map(call => [call.session, call.params.x, call.params.y]), [
    ["workbench-session", 103, 305], ["webview-session", 59, 216]
  ]);
  assert.deepEqual(cdp.lastHitTest.localHitNode.attributes, { class: "source-text" });
});

test("a parent overlay refuses the click before any local-frame lookup", async () => {
  const { cdp, calls } = protocol({ pageNode: 999 });
  assert.equal(await cdp.hitsElement(frame, 55, 210, "expectedSource"), false);
  assert.match(cdp.lastHitTest.refusal, /parent workbench/);
  assert.equal(calls.filter(call => call.method === "DOM.getNodeForLocation").length, 1);
});

test("a local hit in a different frame cannot qualify", async () => {
  const { cdp, calls } = protocol({ localFrame: "other-frame" });
  assert.equal(await cdp.hitsElement(frame, 55, 210, "expectedSource"), false);
  assert.match(cdp.lastHitTest.refusal, /different frame/);
  assert.equal(calls.some(call => call.method === "DOM.resolveNode"), false);
});

test("blank space outside a wrapped inline target refuses the click", async () => {
  const { cdp } = protocol({ contains: false });
  assert.equal(await cdp.hitsElement(frame, 55, 210, "expectedSource"), false);
  assert.match(cdp.lastHitTest.refusal, /outside the actual source/);
  assert.equal(cdp.lastHitTest.localHit.backendNodeId, 60);
});

test("a target removed during a frame refresh refuses the click", async () => {
  const { cdp } = protocol({ missingTarget: true });
  assert.equal(await cdp.hitsElement(frame, 55, 210, "expectedSource"), false);
  assert.match(cdp.lastHitTest.refusal, /disappeared/);
});

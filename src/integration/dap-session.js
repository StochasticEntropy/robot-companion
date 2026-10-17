"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { requireService } = require("./backend-contract");
const { frame, MessageReader } = require("./lsp-session");

// DAP capabilities the Robot Companion debug journey relies on beyond the
// baseline requests. A backend that omits one is reported, never emulated.
const JOURNEY_CAPABILITIES = Object.freeze({
  supportsConfigurationDoneRequest: "configurationDone after breakpoints",
  supportsTerminateRequest: "graceful terminate",
  supportsSetVariable: "editing variables",
  supportsEvaluateForHovers: "hover evaluation"
});

// Integration-owned inline debug adapter: one owned stdio process per debug
// session. It implements the vscode.DebugAdapter shape without importing VS
// Code. Backend-specific handoffs (such as a child Python session) belong in
// this layer later, so that they never leak into UI or provider code.
class DapProcessAdapter extends EventEmitter {
  constructor({ descriptor, trusted, stopTimeoutMs = 1000 }) {
    super();
    // Throws for untrusted workspaces, invalid descriptors and backends
    // without a debug service, before any process exists.
    this.service = requireService(descriptor, "debug", trusted);
    this.backendId = descriptor.id;
    this.stopTimeoutMs = stopTimeoutMs;
    this.state = "stopped";
    this.capabilities = undefined;
    this.unsupported = [];
    this.pending = new Map();
    this.onDidSendMessage = (listener, thisArg, disposables) => {
      const handler = message => listener.call(thisArg, message);
      this.on("message", handler);
      const disposable = { dispose: () => this.off("message", handler) };
      disposables?.push(disposable);
      return disposable;
    };
  }

  start() {
    if (this.state !== "stopped" || this.child) throw new Error("Debug backend is already started.");
    this.state = "running";
    const child = spawn(this.service.executable, this.service.argv, {
      cwd: this.service.cwd, env: { ...process.env, ...this.service.env }, shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.exit = { code, signal };
      if (this.state !== "stopping") {
        this.backendEnded(`Debug backend exited (${signal || code}).`, this.disconnecting && code === 0);
      }
      this.state = "stopped";
      this.child = undefined;
      this.emit("closed", this.exit);
      resolve();
    }));
    const reader = new MessageReader(message => this.receive(message), "DAP");
    child.stdout.on("data", chunk => {
      try { reader.accept(chunk); } catch (error) { this.fail(error); }
    });
    child.stderr.on("data", chunk => this.emit("log", chunk.toString("utf8")));
    child.on("error", error => { if (this.child === child) this.fail(error); });
    child.stdin.on("error", error => { if (this.child === child) this.fail(error); });
    return child.pid;
  }

  handleMessage(message) {
    if (this.state !== "running" || !this.child) {
      if (message?.type === "request") this.answerFailed(message, "Debug backend is not running.");
      return;
    }
    if (message?.type === "request") this.pending.set(message.seq, message);
    if (message?.command === "disconnect") this.disconnecting = true;
    try { this.child.stdin.write(frame(message)); } catch (error) { this.fail(error); }
  }

  receive(message) {
    if (!message || typeof message.type !== "string") throw new Error("Invalid DAP message.");
    const request = message.type === "response" ? this.pending.get(message.request_seq) : undefined;
    if (request) this.pending.delete(message.request_seq);
    this.emit("message", message);
    if (request?.command === "initialize" && message.success) this.negotiated(message.body || {});
  }

  negotiated(capabilities) {
    this.capabilities = Object.freeze({ ...capabilities });
    this.unsupported = Object.keys(JOURNEY_CAPABILITIES).filter(name => capabilities[name] !== true);
    this.emit("capabilities", this.capabilities, this.unsupported);
    if (this.unsupported.length) {
      this.send({ type: "event", event: "output", body: { category: "console", output:
        `Robot Companion: debug backend '${this.backendId}' does not support: ` +
        `${this.unsupported.map(name => JOURNEY_CAPABILITIES[name]).join(", ")}.\n` } });
    }
  }

  send(message) {
    this.emit("message", { seq: 0, ...message });
  }

  answerFailed(request, text) {
    this.send({ type: "response", request_seq: request.seq, command: request.command, success: false, message: text });
  }

  // Requests still waiting when the process disappears get explicit failures,
  // and the session ends, so the UI never waits on a dead backend.
  backendEnded(text, expected = false) {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) this.answerFailed(request, text);
    this.pending.clear();
    if (!expected) this.send({ type: "event", event: "output", body: { category: "stderr", output: `${text}\n` } });
    this.send({ type: "event", event: "terminated", body: {} });
  }

  fail(error) {
    if (this.state === "stopping") return;
    this.backendEnded(`Debug backend failed: ${error.message}`);
    this.emit("failure", error);
    if (this.child) void this.stop();
  }

  // VS Code calls dispose after disconnect or when the session is torn down.
  // The owned process gets a bounded grace period, then SIGTERM, then SIGKILL.
  dispose() {
    return this.stop();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.state = "stopping";
    this.pending.clear();
    const term = setTimeout(() => child.kill(), this.stopTimeoutMs);
    const force = setTimeout(() => child.kill("SIGKILL"), this.stopTimeoutMs + 500);
    try { child.stdin.end(); } catch { /* Process already closing. */ }
    this.stopPromise = this.closed.finally(() => {
      clearTimeout(term);
      clearTimeout(force);
    });
    return this.stopPromise;
  }
}

module.exports = { DapProcessAdapter, JOURNEY_CAPABILITIES };

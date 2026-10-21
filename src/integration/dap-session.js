"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { requireService } = require("./backend-contract");
const { frame, MessageReader } = require("./lsp-session");
const { debugBridge } = require("./backend-providers");

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
// Code. A provider's debug bridge (RobotCode or native) translates launch
// arguments and turns its Python handoff into one normalized `pythonChild`
// endpoint, so that no provider detail leaks into UI or provider code.
class DapProcessAdapter extends EventEmitter {
  constructor({ descriptor, trusted, stopTimeoutMs = 1000, disconnectTimeoutMs = 2000, holdTimeoutMs = 30000, context,
    prepared, nextOutputDir }) {
    super();
    // Throws for untrusted workspaces, invalid descriptors and backends
    // without a debug service, before any process exists.
    this.service = requireService(descriptor, "debug", trusted);
    this.backendId = descriptor.id;
    // A new output folder for each restarted launch (see restartArguments).
    this.nextOutputDir = nextOutputDir;
    this.prepared = prepared;
    this.stopTimeoutMs = stopTimeoutMs;
    this.disconnectTimeoutMs = disconnectTimeoutMs;
    this.state = "stopped";
    this.capabilities = undefined;
    this.unsupported = [];
    // Client requests are renumbered so the adapter can send its own requests
    // (such as RobotCode's robot/sync) without colliding with VS Code's seq.
    this.pending = new Map();
    this.nextSeq = 1;
    this.context = context;
    this.bridge = debugBridge(descriptor, this.service);
    if (prepared) {
      // Attach to a prepared session: its provider's connector, which gets
      // its startup data on stdin before any DAP message.
      const connector = this.bridge?.preparedConnector?.(prepared);
      if (!connector) throw new Error("Attaching to a prepared Robot session requires the native backend.");
      this.service = Object.freeze({ ...this.service, argv: connector.argv });
      this.startup = connector.startup;
    }
    // Requests a bridge holds until its handoff is ready (native: Robot
    // configurationDone until the Python child is attached and connected).
    this.held = [];
    this.holdTimeoutMs = holdTimeoutMs;
    // Further process groups the backend reported as its own (Robot worker,
    // debugpy adapter); ended with the session, after the backend itself.
    this.ownedGroups = new Set();
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
    // Own process group: backends such as RobotCode start the Robot run and the
    // debugpy adapter as further processes, which stop() must clean up too.
    const child = spawn(this.service.executable, this.service.argv, {
      cwd: this.service.cwd, env: { ...process.env, ...this.service.env }, shell: false,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"
    });
    this.child = child;
    if (this.startup) child.stdin.write(this.startup);
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.exit = { code, signal };
      // Leftover Robot processes of this session: a paused Robot run ignores a
      // graceful SIGTERM, so the group is killed after a short grace period.
      this.killGroup(child, "SIGTERM");
      setTimeout(() => this.killGroup(child, "SIGKILL"), 500);
      this.killOwnedGroups();
      clearTimeout(this.disconnectTimer);
      clearTimeout(this.holdTimer);
      if (this.state !== "stopping") {
        this.backendEnded(`Debug backend exited (${signal || code}).`, this.disconnecting && (code === 0 || this.forcedStop));
      } else this.backendEnded("Debug backend stopped.", true); // The session ends in VS Code too.
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
    if (this.failedStart && message?.type === "request") {
      // The session is ending after a failed prepared attach (see endFailedStart).
      if (message.command === "disconnect" || message.command === "terminate") {
        this.send({ type: "response", request_seq: message.seq, command: message.command, success: true });
        void this.stop();
      } else this.answerFailed(message, this.failedStart);
      return;
    }
    if (this.state !== "running" || !this.child) {
      if (message?.type === "request") this.answerFailed(message, "Debug backend is not running.");
      return;
    }
    let outgoing = { ...message, seq: this.nextSeq++ };
    if (message?.type === "request") {
      try {
        if (message.command === "launch" && this.bridge) {
          outgoing.arguments = this.bridge.launchArguments(message.arguments, this.context);
        } else if (message.command === "attach" && this.bridge?.attachArguments) {
          outgoing.arguments = this.bridge.attachArguments(message.arguments);
        } else if (message.command === "restart" && this.bridge?.restartArguments) {
          outgoing.arguments = this.bridge.restartArguments(message.arguments, this.prepared ? undefined : this.nextOutputDir?.());
          outgoing.restartOutputDir = this.bridge.outputDir;
        }
      } catch (error) {
        if (error.restartDeclined) {
          // VS Code treats a failed restart response as the end of the session, but
          // keeps showing it with its adapter detached. A declined restart therefore
          // answers without restarting, so the paused session stays usable, and says why.
          this.emit("log", `${error.message}\n`);
          this.send({ type: "response", request_seq: message.seq, command: message.command, success: true });
          this.send({ type: "event", event: "output", body: { category: "important", output: `${error.message}\n` } });
          return;
        }
        this.answerFailed(message, error.message);
        return;
      }
      const restartOutputDir = outgoing.restartOutputDir;
      delete outgoing.restartOutputDir;
      if (restartOutputDir !== undefined) message = { ...message, restartOutputDir };
      const answer = this.bridge?.answer?.(message);
      if (answer) {
        this.send({ type: "response", request_seq: message.seq, command: message.command, success: true, body: answer });
        return;
      }
      if (this.bridge?.hold?.(message)) {
        this.hold(message);
        return;
      }
      this.pending.set(outgoing.seq, message);
    }
    if (message?.command === "disconnect" || message?.command === "terminate") {
      this.release();
      this.disconnectRequested();
    }
    this.write(outgoing);
  }

  hold(message) {
    this.held.push(message);
    if (this.holdTimer) return;
    // A handoff that never completes must not leave the session waiting: the
    // held request then reaches the backend, which reports its own refusal.
    this.holdTimer = setTimeout(() => {
      this.emit("log", `Python handoff not ready after ${this.holdTimeoutMs} ms; continuing without waiting.\n`);
      this.release();
    }, this.holdTimeoutMs);
  }

  release() {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    const held = this.held.splice(0);
    for (const message of held) {
      const outgoing = { ...message, seq: this.nextSeq++ };
      this.pending.set(outgoing.seq, message);
      this.write(outgoing);
    }
  }

  // The Python child session has finished its own configuration (see
  // DebugWorkspace); held Robot requests may continue once the bridge agrees.
  childConfigured() {
    if (this.bridge?.childReady?.() && this.child) this.release();
  }

  // A backend busy in a keyword (for example a long Python call) may not end
  // after disconnect/terminate. Its process group is then ended within
  // `disconnectTimeoutMs`, so Stop always ends the session and its processes.
  disconnectRequested() {
    this.disconnecting = true;
    if (this.disconnectTimer || !this.child) return;
    const child = this.child;
    this.disconnectTimer = setTimeout(() => {
      if (this.child !== child) return;
      this.forcedStop = true;
      this.emit("log", `Debug backend did not end ${this.disconnectTimeoutMs} ms after disconnect; stopping its process group.\n`);
      this.killGroup(child, "SIGTERM");
      setTimeout(() => this.killGroup(child, "SIGKILL"), 500);
    }, this.disconnectTimeoutMs);
  }

  write(message) {
    try { this.child.stdin.write(frame(message)); } catch (error) { this.fail(error); }
  }

  // Adapter-owned request; its response never reaches VS Code.
  internalRequest(command, args) {
    const seq = this.nextSeq++;
    this.pending.set(seq, { internal: true, command });
    this.write({ seq, type: "request", command, arguments: args });
  }

  receive(message) {
    if (!message || typeof message.type !== "string") throw new Error("Invalid DAP message.");
    if (message.type === "response") {
      const request = this.pending.get(message.request_seq);
      if (!request) return; // Late answer to a request that already failed.
      this.pending.delete(message.request_seq);
      if (request.internal) {
        if (!message.success) this.emit("log", `${request.command} failed: ${message.message}\n`);
        return;
      }
      if (this.prepared && !message.success && ["initialize", "attach"].includes(request.command)) {
        this.endFailedStart(message.message || `${request.command} failed.`);
        return;
      }
      const { restartOutputDir, ...original } = request;
      this.emit("message", { ...(this.bridge?.response?.(message) || message), request_seq: original.seq });
      if (request.command === "initialize" && message.success) this.negotiated(message.body || {});
      if (request.command === "restart" && message.success) this.emit("restarted", { outputDir: restartOutputDir });
      return;
    }
    if (message.type === "event" && this.bridge) {
      const handled = this.bridge.event(message);
      if (handled.sync) this.internalRequest("robot/sync", {});
      // The backend stopped a retired generation itself: never signal its
      // process groups later, their IDs may belong to someone else by then.
      if (handled.retired) this.ownedGroups.clear();
      for (const pid of handled.ownedProcessGroups || []) this.ownedGroups.add(pid);
      if (handled.pythonChild) this.emit("pythonChild", handled.pythonChild);
      if (handled.release) this.release();
      if (handled.exited) this.emit("runExited", handled.exited);
      if (!handled.forward) return;
      if (handled.message) message = handled.message;
    }
    this.emit("message", message);
  }

  // VS Code 1.141 strands a session whose initialize or attach request fails: it
  // detaches the session's listeners before the adapter-exit event that would end it,
  // so the session and its "initializing" progress remain. A failed prepared attach
  // therefore shows its reason and ends the session with `terminated` first; the failed
  // request is left to VS Code's own cancellation when the session stops.
  endFailedStart(text) {
    if (this.failedStart) return;
    this.failedStart = text;
    this.emit("failure", new Error(text));
    this.send({ type: "event", event: "output", body: { category: "important", output: `${text}\n` } });
    this.send({ type: "event", event: "terminated", body: {} });
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
    for (const request of this.pending.values()) if (!request.internal) this.answerFailed(request, text);
    for (const request of this.held.splice(0)) this.answerFailed(request, text);
    clearTimeout(this.holdTimer);
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
    this.held.splice(0);
    const term = setTimeout(() => this.killGroup(child, "SIGTERM"), this.stopTimeoutMs);
    const force = setTimeout(() => this.killGroup(child, "SIGKILL"), this.stopTimeoutMs + 500);
    try { child.stdin.end(); } catch { /* Process already closing. */ }
    this.stopPromise = this.closed.finally(() => {
      clearTimeout(term);
      clearTimeout(force);
    });
    return this.stopPromise;
  }
}

// Signal the session's whole process group (the adapter and anything it
// started); falls back to the adapter process alone where groups are absent.
DapProcessAdapter.prototype.killGroup = function killGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch { /* Group already gone. */ }
};

// Process groups the backend reported (each a session leader): normally gone
// already; a backend that was killed cannot end them itself.
DapProcessAdapter.prototype.killOwnedGroups = function killOwnedGroups() {
  const groups = [...this.ownedGroups];
  this.ownedGroups.clear();
  const signal = name => {
    for (const pid of groups) {
      try { if (process.platform !== "win32") process.kill(-pid, name); } catch { /* Group already gone. */ }
    }
  };
  if (!groups.length) return;
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 500);
};

module.exports = { DapProcessAdapter, JOURNEY_CAPABILITIES };

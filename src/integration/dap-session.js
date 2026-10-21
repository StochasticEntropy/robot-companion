"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { requireService } = require("./backend-contract");
const { frame, MessageReader } = require("./lsp-session");
const { debugBridge } = require("./backend-providers");
const { processGuard } = require("./process-guard");

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
    // The process guard's release of each owned group.
    this.releaseGroups = new Map();
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
    // Ended by the process guard if the extension host goes away without stopping it.
    const release = processGuard.register(child.pid, { group: process.platform !== "win32" });
    if (this.startup) child.stdin.write(this.startup);
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.exit = { code, signal };
      // Leftover Robot processes of this session: a paused Robot run ignores a
      // graceful SIGTERM, so the group is killed after a short grace period.
      this.killGroup(child, "SIGTERM");
      setTimeout(() => this.killGroup(child, "SIGKILL"), 500);
      this.killOwnedGroups();
      // After the group's SIGKILL above has been sent.
      setTimeout(release, 600);
      clearTimeout(this.disconnectTimer);
      clearTimeout(this.holdTimer);
      clearTimeout(this.failedStartTimer);
      if (this.state !== "stopping") {
        // After the user's Stop (terminate/disconnect), the exit is what was asked
        // for; otherwise an exit other than a clean one, or any exit while the session
        // is still launching, is reported to the user, once, by the unexpectedExit
        // warning. In both cases the requests it leaves unanswered are cancelled
        // rather than failed, so VS Code shows nothing more.
        const requested = Boolean(this.disconnecting);
        const reported = !requested && (code !== 0 || !this.launchAnswered);
        this.backendEnded(`Debug backend exited (${signal || code}).`, {
          expected: requested && (code === 0 || this.forcedStop), requested, quiet: requested || reported });
        if (reported) this.emit("unexpectedExit", this.exit);
      } else this.backendEnded("Debug backend stopped.", { expected: true }); // The session ends in VS Code too.
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
      // Ending a session whose backend is already gone has nothing left to do.
      if (isEndRequest(message)) this.answerEnded(message);
      else if (message?.type === "request" && this.quietEnd) this.answerCancelled(message);
      else if (message?.type === "request") this.answerFailed(message, "Debug backend is not running.");
      return;
    }
    if (isEndRequest(message) && !this.initializeSent) {
      // The user's Stop while VS Code is still starting the session, before it has sent
      // initialize: the backend has no session to end, and may refuse any request before
      // initialize (native: "Debug adapter not initialized"), which VS Code would show.
      // The Stop succeeds here, the backend is stopped, and later requests are cancelled.
      this.disconnecting = true;
      this.answerEnded(message);
      this.backendEnded("Debug backend stopped.", { expected: true, requested: true, quiet: true });
      void this.stop();
      return;
    }
    if (message?.type === "request" && message.command === "initialize") this.initializeSent = true;
    let outgoing = { ...message, seq: this.nextSeq++ };
    if (message?.type === "request") {
      try {
        if (message.command === "launch" && this.bridge) {
          outgoing.arguments = this.bridge.launchArguments(message.arguments, this.context);
        } else if (message.command === "attach" && this.bridge?.attachArguments) {
          outgoing.arguments = this.bridge.attachArguments(message.arguments);
        } else if (message.command === "restart" && this.bridge?.restartArguments) {
          outgoing.arguments = this.bridge.restartArguments(message.arguments, this.prepared ? undefined : this.nextOutputDir);
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
        if (message.command === "launch") this.launchAnswered = true;
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
    if (isEndRequest(message)) {
      // The user's Stop: a request held for the Python handoff (native: configurationDone
      // before the child is attached) will not be needed and is cancelled, not sent to a
      // backend that would refuse it.
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
      for (const request of this.held.splice(0)) this.answerCancelled(request);
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
      if (isEndRequest(request) && !message.success) {
        // A backend refusing the user's Stop (for example while it is still starting)
        // is still ended, by its process group within `disconnectTimeoutMs`; the
        // refusal goes to the debug log, not to VS Code, which would show it.
        this.emit("log", `${request.command} refused by the debug backend: ${message.message}\n`);
        this.answerEnded(request);
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
      // From here on VS Code has started the session and reports its end.
      if (request.command === "launch" && message.success) this.launched = true;
      // A refused launch is shown by VS Code itself; a clean exit after it is no surprise.
      if (request.command === "launch") this.launchAnswered = true;
      return;
    }
    if (message.type === "event" && this.bridge) {
      const handled = this.bridge.event(message);
      if (handled.sync) this.internalRequest("robot/sync", {});
      if (handled.retired) {
        for (const release of this.releaseGroups.values()) release();
        this.releaseGroups.clear();
        this.ownedGroups.clear();
      }
      for (const pid of handled.ownedProcessGroups || []) {
        if (this.ownedGroups.has(pid)) continue;
        this.ownedGroups.add(pid);
        this.releaseGroups.set(pid, processGuard.register(pid, { group: true }));
      }
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
    // VS Code normally answers with disconnect (handleMessage); the connector ends either way.
    this.failedStartTimer = setTimeout(() => { void this.stop(); }, this.disconnectTimeoutMs);
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

  answerEnded(request) {
    this.send({ type: "response", request_seq: request.seq, command: request.command, success: true });
  }

  // VS Code treats exactly this response as a cancellation and shows no error for it,
  // neither a notification nor the launch dialog (a failed launch or configurationDone
  // otherwise shows its message, which `body.error.showUser: false` does not prevent
  // for configurationDone).
  answerCancelled(request) {
    this.send(cancelledResponse(request));
  }

  // Requests still waiting when the process disappears get explicit failures,
  // and the session ends, so the UI never waits on a dead backend. The user's
  // own terminate/disconnect succeeded when the backend ended after it. A quiet
  // end (the user's Stop, or an exit the user is told about separately) cancels
  // the other requests, also those still arriving: launch and configurationDone
  // during a launch, for example.
  backendEnded(text, { expected = false, requested = false, quiet = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    this.quietEnd = quiet;
    const answer = request => quiet ? this.answerCancelled(request) : this.answerFailed(request, text);
    for (const request of this.pending.values()) {
      if (request.internal) continue;
      if (requested && isEndRequest(request)) this.answerEnded(request);
      else answer(request);
    }
    for (const request of this.held.splice(0)) answer(request);
    clearTimeout(this.holdTimer);
    this.pending.clear();
    if (!expected) this.send({ type: "event", event: "output", body: { category: "stderr", output: `${text}\n` } });
    this.send({ type: "event", event: "terminated", body: {} });
  }

  // The user's Stop was sent or the backend is gone: nothing new may start for this session.
  get ending() {
    return Boolean(this.disconnecting || this.ended);
  }

  fail(error) {
    if (this.state === "stopping") return;
    // After the user's Stop, a backend that closes its input (write EPIPE) is ending as asked.
    const requested = Boolean(this.disconnecting);
    this.backendEnded(`Debug backend failed: ${error.message}`, { expected: requested, requested, quiet: requested });
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

const isEndRequest = message => message?.type === "request" && (message.command === "terminate" || message.command === "disconnect");
const cancelledResponse = request => ({ seq: 0, type: "response", request_seq: request.seq, command: "canceled", success: false, message: "canceled" });

// Stand-in adapter for a session that can no longer start, such as a Python child
// whose Robot session was stopped while launching: VS Code drops it without an error.
class CancelledDebugAdapter extends EventEmitter {
  constructor() {
    super();
    this.onDidSendMessage = (listener, thisArg, disposables) => {
      const handler = message => listener.call(thisArg, message);
      this.on("message", handler);
      const disposable = { dispose: () => this.off("message", handler) };
      disposables?.push(disposable);
      return disposable;
    };
  }

  handleMessage(message) {
    if (message?.type === "request") this.emit("message", cancelledResponse(message));
  }

  dispose() {}
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
  const releases = [...this.releaseGroups.values()];
  this.ownedGroups.clear();
  this.releaseGroups.clear();
  const signal = name => {
    for (const pid of groups) {
      try { if (process.platform !== "win32") process.kill(-pid, name); } catch { /* Group already gone. */ }
    }
  };
  if (!groups.length) return;
  signal("SIGTERM");
  setTimeout(() => { signal("SIGKILL"); for (const release of releases) release(); }, 500);
};

module.exports = { DapProcessAdapter, CancelledDebugAdapter, JOURNEY_CAPABILITIES };

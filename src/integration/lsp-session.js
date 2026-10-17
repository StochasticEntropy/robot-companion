"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { requireService } = require("./backend-contract");
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

// UTF-8 byte framing, not string lengths: Robot source may contain umlauts or
// astral characters even though its LSP positions are UTF-16 code units.
function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

class MessageReader {
  constructor(onMessage, label = "LSP") {
    this.onMessage = onMessage;
    this.label = label;
    this.buffer = Buffer.alloc(0);
    this.length = undefined;
  }

  accept(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.length === undefined) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new Error(`${this.label} header exceeds limit.`);
          return;
        }
        if (end > MAX_HEADER_BYTES) throw new Error(`${this.label} header exceeds limit.`);
        const lengths = this.buffer.subarray(0, end).toString("ascii").split("\r\n")
          .filter(line => /^Content-Length:/i.test(line));
        if (lengths.length !== 1 || !/^Content-Length: *[0-9]+$/i.test(lengths[0])) {
          throw new Error(`${this.label} message requires one valid Content-Length header.`);
        }
        this.length = Number(lengths[0].split(":")[1]);
        if (this.length < 1 || this.length > MAX_MESSAGE_BYTES) throw new Error(`${this.label} body exceeds limit or is empty.`);
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const body = this.buffer.subarray(0, this.length).toString("utf8");
      this.buffer = this.buffer.subarray(this.length);
      this.length = undefined;
      this.onMessage(JSON.parse(body));
    }
  }
}

class LspSession extends EventEmitter {
  constructor({ timeoutMs = 10000, onServerRequest = async () => {
    throw Object.assign(new Error("Unsupported client request."), { code: -32601 });
  } } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.onServerRequest = onServerRequest;
    this.pending = new Map();
    this.nextId = 1;
    this.state = "stopped";
    this.capabilities = Object.freeze({});
  }

  async start(descriptor, trusted) {
    if (this.state !== "stopped") throw new Error("LSP session is already started.");
    const service = requireService(descriptor, "language", trusted);
    this.state = "starting";
    this.child = spawn(service.executable, service.argv, {
      cwd: service.cwd, env: { ...process.env, ...service.env }, shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const child = this.child;
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      const error = new Error(`Language backend exited (${signal || code}).`);
      if (this.state === "stopping" && code === 0) {
        this.capabilities = Object.freeze({});
        for (const finish of [...this.pending.values()]) finish(error);
      } else {
        this.fail(error);
      }
      this.state = "stopped";
      this.child = undefined;
      this.emit("closed", { code, signal });
      resolve();
    }));
    const reader = new MessageReader(message => this.receive(message));
    child.stdout.on("data", chunk => {
      try { reader.accept(chunk); } catch (error) { this.fail(error); }
    });
    child.stderr.on("data", chunk => this.emit("log", chunk.toString("utf8")));
    child.on("error", error => { if (this.child === child) this.fail(error); });
    child.stdin.on("error", error => { if (this.child === child) this.fail(error); });
    try {
      const result = await this.request("initialize", {
        processId: process.pid, rootUri: descriptor.workspaceUri,
        workspaceFolders: [{ uri: descriptor.workspaceUri, name: descriptor.workspaceUri.split("/").pop() }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            definition: { linkSupport: true },
            publishDiagnostics: { versionSupport: true }
          }
        }
      });
      if (!result || typeof result.capabilities !== "object" || result.capabilities === null) {
        throw new Error("Language backend returned invalid initialize capabilities.");
      }
      if (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== "utf-16") {
        throw new Error("Language backend must negotiate UTF-16 positions.");
      }
      this.capabilities = Object.freeze({ ...result.capabilities });
      this.notify("initialized", {});
      this.state = "running";
      return this.capabilities;
    } catch (error) {
      if (this.child === child) this.fail(error);
      await this.closed;
      throw error;
    }
  }

  write(message) {
    if (!this.child || this.state === "stopped" || this.state === "failed") {
      throw new Error("Language backend is not running.");
    }
    this.child.stdin.write(frame(message));
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("LSP request cancelled."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => {
        try { this.notify("$/cancelRequest", { id }); } catch { /* process already stopped */ }
        finish(new Error("LSP request cancelled."));
      };
      const timer = setTimeout(() => {
        try { this.notify("$/cancelRequest", { id }); } catch { /* process already stopped */ }
        finish(new Error(`LSP request '${method}' timed out.`));
      }, timeoutMs);
      this.pending.set(id, finish);
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) { finish(error); }
    });
  }

  receive(message) {
    if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC message.");
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const originatingChild = this.child;
        const reply = payload => {
          if (this.child !== originatingChild || !["starting", "running"].includes(this.state)) return;
          this.write({ jsonrpc: "2.0", id: message.id, ...payload });
        };
        Promise.resolve().then(() => this.onServerRequest(message.method, message.params))
          .then(result => reply({ result: result ?? null }),
            error => reply({ error: {
              code: Number.isInteger(error.code) ? error.code : -32603, message: error.message
            } }))
          .catch(() => {}); // Process may have closed while the handler was resolving.
      } else {
        this.emit("notification", message.method, message.params);
      }
      return;
    }
    const finish = this.pending.get(message.id);
    if (!finish) return; // Late response to cancelled/timed-out request.
    if (message.error) finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else if (Object.hasOwn(message, "result")) finish(undefined, message.result);
    else throw new Error("JSON-RPC response has neither result nor error.");
  }

  fail(error) {
    this.state = "failed";
    this.capabilities = Object.freeze({});
    for (const finish of [...this.pending.values()]) finish(error);
    if (this.child) this.terminateChild(this.child);
    this.emit("failure", error);
  }

  terminateChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const force = setTimeout(() => child.kill("SIGKILL"), 500);
    child.once("close", () => clearTimeout(force));
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.stopPromise = this.stopChild(child).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  async stopChild(child) {
    // Arm before awaiting shutdown: VS Code bounds deactivate, so a request
    // timeout must never postpone the owned process's termination timer.
    const force = setTimeout(() => child.kill("SIGKILL"), 500);
    try {
      if (this.state === "running") {
        this.state = "stopping";
        try {
          await this.request("shutdown", null);
          this.notify("exit");
        } catch { /* Owned process is already closing or will be killed. */ }
      } else {
        child.kill();
      }
      await this.closed;
    } finally { clearTimeout(force); }
  }
}

module.exports = { frame, MessageReader, LspSession };

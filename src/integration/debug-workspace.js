"use strict";

const vscode = require("vscode");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateDescriptor, selectServices, requireService, ExecutionContexts } = require("./backend-contract");
const providers = require("./backend-providers");
const { DapProcessAdapter } = require("./dap-session");

const DEBUG_TYPE = "robotcompanion";
const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);
const TRUST_REFUSAL = "Robot Companion debugging starts a configured executable and requires a trusted workspace.";
const COEXISTENCE_REFUSAL = "Robot Companion debugging runs only when robotCompanion.integrationMode is \"owned\". " +
  "In coexistence mode, keep using your existing Robot debugger.";
const integrationMode = folder => vscode.workspace.getConfiguration("robotCompanion", folder?.uri).get("integrationMode", "coexistence");
// Readable names of the DAP capabilities a backend advertises in initialize.
const capabilityNames = capabilities => Object.entries(capabilities || {})
  .filter(([name, value]) => name.startsWith("supports") && value === true)
  .map(([name]) => name.replace(/^supports/, "").replace(/Request$/, ""));

// Owns the Robot Companion debug type: configuration resolution, one owned
// adapter process per session and cleanup. Debug selection reads only
// robotCompanion.executionBackend, never the language descriptor.
class DebugWorkspace {
  constructor(extensionContext, status) {
    // Shared provider status (language status items and the status command).
    this.status = status;
    // Short-lived capability probes for the status (initialize only, no launch).
    this.probes = new Set();
    this.statusGeneration = 0;
    this.storagePath = (extensionContext?.storageUri || extensionContext?.globalStorageUri)?.fsPath;
    this.contexts = new ExecutionContexts();
    // One-time tokens for Python child sessions announced by an owned adapter.
    this.handoffs = new Map();
    this.sessions = new Map();
    this.disposed = false;
    // Fires once per ended owned launch session with its own output folder, so
    // Test Explorer debug runs can read that run's output.xml.
    this.finished = new vscode.EventEmitter();
    this.onDidFinishRun = this.finished.event;
    this.channel = vscode.window.createOutputChannel("Robot Companion Debug");
    this.subscriptions = [
      vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, this),
      vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, this),
      // A Python child session reports when its own configuration is done; a
      // provider whose handoff needs that order (native v1) continues then.
      vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, { createDebugAdapterTracker: session => this.tracker(session) }),
      vscode.debug.onDidTerminateDebugSession(session => {
        void this.release(session.id);
        // A Python child ends with its Robot parent session.
        for (const entry of this.sessions.values()) {
          if (entry.pythonChild?.parentSession?.id === session.id) void vscode.debug.stopDebugging(entry.pythonChild);
        }
      }),
      vscode.debug.onDidStartDebugSession(session => {
        const parent = session.parentSession && this.sessions.get(session.parentSession.id);
        if (session.type === DEBUG_TYPE && session.configuration.request === "attach" && parent) parent.pythonChild = session;
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refreshStatus(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refreshStatus(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("robotCompanion.integrationMode") ||
            event.affectsConfiguration("robotCompanion.executionBackend")) void this.refreshStatus();
        for (const { session, folder } of this.sessions.values()) {
          if (event.affectsConfiguration("robotCompanion.integrationMode", folder?.uri) ||
              event.affectsConfiguration("robotCompanion.executionBackend", folder?.uri)) {
            this.channel.appendLine(`[${folder?.name}] Debug configuration changed; stopping '${session.name}'.`);
            void vscode.debug.stopDebugging(session);
          }
        }
      })
    ];
    void this.refreshStatus();
  }

  tracker(session) {
    if (session.configuration.request !== "attach" || !session.parentSession) return undefined;
    return {
      onDidSendMessage: message => {
        if (message.type === "response" && message.success && ["configurationDone", "attach"].includes(message.command)) {
          this.sessions.get(session.parentSession.id)?.adapter.childConfigured();
        }
      }
    };
  }

  // The execution provider of each owned folder and the DAP capabilities it
  // advertises, from a short initialize-only probe: nothing is launched, and
  // nothing starts in Restricted Mode, in coexistence or for a refused descriptor.
  refreshStatus() {
    const generation = ++this.statusGeneration;
    this.statusQueue = (this.statusQueue || Promise.resolve()).then(async () => {
      await this.stopProbes();
      if (!this.status || this.disposed || generation !== this.statusGeneration) return;
      for (const folder of vscode.workspace.workspaceFolders || []) {
        this.status.delete("execution", folder);
        if (!vscode.workspace.isTrusted || folder.uri.scheme !== "file" || integrationMode(folder) !== "owned") continue;
        if (!vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("executionBackend")) continue;
        let input;
        try { input = this.descriptorFor(folder); }
        catch (error) {
          this.status.set("execution", folder, { state: "refused", error: error.message });
          void vscode.window.showErrorMessage(`Robot Companion debug provider not available. ${error.message}`);
          continue;
        }
        const provider = providers.describe(validateDescriptor(input));
        this.status.set("execution", folder, { state: "starting", provider, capabilities: [] });
        try {
          const capabilities = await this.probe(input, generation);
          if (generation !== this.statusGeneration || this.disposed) return;
          this.status.set("execution", folder, { state: "running", provider, capabilities: capabilityNames(capabilities) });
        } catch (error) {
          if (generation !== this.statusGeneration || this.disposed) return;
          const message = `robotCompanion.executionBackend for folder '${folder.name}': ${error.message}`;
          this.status.set("execution", folder, { state: "refused", error: message });
          this.channel.appendLine(`[${folder.name}] Debug provider unavailable: ${error.message}`);
        }
      }
    }).catch(error => this.channel.appendLine(`Debug status failed: ${error.message}`));
    return this.statusQueue;
  }

  async probe(input, generation) {
    const adapter = new DapProcessAdapter({ descriptor: input, trusted: vscode.workspace.isTrusted });
    this.probes.add(adapter);
    try {
      if (generation !== this.statusGeneration || this.disposed) throw new Error("superseded");
      adapter.start();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the debug backend did not answer initialize within 15 s.")), 15000);
        adapter.onDidSendMessage(message => {
          if (message.type !== "response" || message.command !== "initialize") return;
          clearTimeout(timer);
          if (message.success) resolve(message.body || {}); else reject(new Error(message.message || "initialize failed."));
        });
        adapter.handleMessage({ seq: 1, type: "request", command: "initialize", arguments: {
          clientID: "robot-companion-status", adapterID: DEBUG_TYPE, linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" } });
      });
    } finally {
      await adapter.stop();
      this.probes.delete(adapter);
    }
  }

  stopProbes() {
    return Promise.all([...this.probes].map(probe => probe.stop()));
  }

  provideDebugConfigurations() {
    return [{ type: DEBUG_TYPE, request: "launch", name: "Robot Companion: Debug current file", target: "${file}" }];
  }

  resolveDebugConfiguration(folder, config) {
    if (!config.type && !config.request && !config.name) {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!isRobotPath(uri)) {
        // Chosen in Run and Debug's debugger picker: in Restricted Mode or
        // coexistence, that is the reason to give, not a missing file.
        return this.refuse(this.unavailableReason(folder) ||
          "Open a .robot or .resource file, or add a robotcompanion launch configuration.");
      }
      config = { ...this.provideDebugConfigurations()[0], target: uri.fsPath };
      folder = vscode.workspace.getWorkspaceFolder(uri);
    }
    if (config.request === "attach") {
      // Only a Python child announced by a running owned session may attach.
      return this.handoffs.has(config.robotCompanionHandoff) ? config :
        this.refuse("Robot Companion attaches only to the Python process of its own running debug session.");
    }
    if (config.request !== "launch") return this.refuse("Robot Companion supports launch configurations only.");
    if (typeof config.target !== "string" || !config.target.trim()) {
      return this.refuse("The robotcompanion launch configuration needs a target file.");
    }
    try {
      this.descriptorFor(folder);
    } catch (error) {
      return this.refuse(error.message);
    }
    return config;
  }

  // Restricted Mode, or no candidate folder in owned mode (without folders,
  // the window's setting); undefined otherwise.
  unavailableReason(folder) {
    if (!vscode.workspace.isTrusted) return TRUST_REFUSAL;
    const folders = folder ? [folder] : vscode.workspace.workspaceFolders || [];
    const candidates = folders.length ? folders : [undefined];
    if (candidates.every(candidate => integrationMode(candidate) !== "owned")) return COEXISTENCE_REFUSAL;
    return undefined;
  }

  descriptorFor(folder) {
    // Check trust and mode before reading the executable descriptor.
    if (!vscode.workspace.isTrusted) throw new Error(TRUST_REFUSAL);
    if (!folder || folder.uri.scheme !== "file") throw new Error("Robot Companion debugging needs a workspace folder on this host.");
    const mode = integrationMode(folder);
    if (mode !== "owned") throw new Error(COEXISTENCE_REFUSAL);
    const input = vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("executionBackend");
    if (!input) throw new Error(`Set robotCompanion.executionBackend for folder '${folder.name}' to debug with Robot Companion.`);
    const prefix = `robotCompanion.executionBackend for folder '${folder.name}': `;
    try {
      const descriptor = validateDescriptor(input);
      if (descriptor.workspaceUri !== folder.uri.toString()) {
        throw new Error("executionBackend.workspaceUri must match this workspace folder URI.");
      }
      if (!selectServices({ mode, execution: input }).debug) {
        throw new Error(`Backend '${descriptor.id}' does not support debug.`);
      }
      // Refused before anything starts: a declared version the provider does not
      // support, or a debug executable that does not exist.
      providers.checkVersion(descriptor);
      requireService(descriptor, "debug", vscode.workspace.isTrusted);
    } catch (error) {
      throw new Error(prefix + error.message);
    }
    return input;
  }

  refuse(message) {
    this.channel.appendLine(`Debug not started: ${message}`);
    void vscode.window.showErrorMessage(`Robot Companion: ${message}`);
    return undefined;
  }

  createDebugAdapterDescriptor(session) {
    const folder = session.workspaceFolder;
    if (session.configuration.request === "attach") {
      const endpoint = this.handoffs.get(session.configuration.robotCompanionHandoff);
      this.handoffs.delete(session.configuration.robotCompanionHandoff);
      if (!endpoint || !session.parentSession || !this.sessions.has(session.parentSession.id)) {
        throw new Error("The Python child session has no running Robot Companion parent session.");
      }
      this.channel.appendLine(`[${folder?.name}] Python child '${session.name}' connects to ${endpoint.host}:${endpoint.port}.`);
      return new vscode.DebugAdapterServer(endpoint.port, endpoint.host);
    }
    // Re-check immediately before spawning: trust, mode and descriptor may
    // have changed since the configuration was resolved.
    let adapter, context, provider;
    try {
      if (this.disposed) throw new Error("Robot Companion is shutting down.");
      const descriptor = this.descriptorFor(folder);
      provider = providers.describe(validateDescriptor(descriptor));
      context = this.executionContext(folder);
      adapter = new DapProcessAdapter({ descriptor, trusted: vscode.workspace.isTrusted, context });
    } catch (error) {
      this.channel.appendLine(`[${folder?.name}] Debug not started: ${error.message}`);
      throw error;
    }
    const label = `[${folder.name}] ${adapter.backendId}`;
    adapter.on("log", text => this.channel.append(`${label}: ${text}`));
    adapter.on("failure", error => this.channel.appendLine(`${label}: ${error.message}`));
    adapter.on("capabilities", (capabilities, unsupported) => {
      this.channel.appendLine(`${label}: capabilities ${JSON.stringify(capabilities)}` +
        (unsupported.length ? `; not supported: ${unsupported.join(", ")}` : ""));
      // The Debug Console names the provider of this session and what it advertises.
      adapter.send({ type: "event", event: "output", body: { category: "console", output:
        `Robot Companion debug provider: ${provider}; advertises ${capabilityNames(capabilities).join(", ") || "no optional capabilities"}.\n` } });
      this.status?.set("execution", folder, { state: "running", provider, capabilities: capabilityNames(capabilities) });
    });
    adapter.on("closed", ({ code, signal }) => this.channel.appendLine(`${label}: process exited (${signal || code}).`));
    adapter.on("pythonChild", endpoint => { void this.startPythonChild(session, endpoint); });
    const entry = { session, folder, adapter, outputDir: context.outputDir };
    adapter.on("runExited", ({ exitCode, outputFile }) => {
      entry.exitCode = exitCode;
      this.channel.appendLine(`${label}: Robot run ended with exit code ${exitCode}${outputFile ? `; output ${outputFile}` : ""}.`);
    });
    const pid = entry.pid = adapter.start();
    this.sessions.set(session.id, entry);
    this.channel.appendLine(`${label}: started debug process ${pid} for '${session.name}'.`);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  // Per-root execution inputs (cwd, robotArguments) plus an output folder of
  // its own for each debug run, next to the CodeLens runner's results.
  executionContext(folder) {
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const context = this.contexts.forRoot(folder.uri.toString(), {
      robotCommand: config.get("robotCommand", "robot"), robotArguments: config.get("robotArguments", [])
    }, vscode.workspace.isTrusted);
    if (!this.storagePath) return context;
    const root = path.join(this.storagePath, "debug-runs");
    fs.mkdirSync(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return { ...context, outputDir: fs.mkdtempSync(path.join(root, `${stamp}-`)) };
  }

  async startPythonChild(parent, endpoint) {
    if (!this.sessions.has(parent.id)) return;
    const token = crypto.randomUUID();
    this.handoffs.set(token, endpoint);
    // The provider's normalized attach configuration (native handoff v1: the
    // supplied local listen/subProcess settings); none for RobotCode.
    const started = await vscode.debug.startDebugging(parent.workspaceFolder, {
      ...(endpoint.attach || {}), type: DEBUG_TYPE, request: "attach", name: `Python: ${parent.name}`, robotCompanionHandoff: token
    // Not compact: the Robot session stays visible in Call Stack, with the
    // Python child under it, while Python is paused.
    }, { parentSession: parent, consoleMode: vscode.DebugConsoleMode.MergeWithParent, lifecycleManagedByParent: true });
    this.handoffs.delete(token);
    if (!started) this.channel.appendLine(`[${parent.workspaceFolder?.name}] Python child session for '${parent.name}' did not start.`);
  }

  // Ends an owned session's processes directly (Test Explorer Stop when the
  // session did not end on its own); the session then ends in VS Code.
  forceStop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    this.channel.appendLine(`[${entry.folder?.name}] Stopping '${entry.session.name}' and its processes.`);
    return entry.adapter.stop();
  }

  release(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    this.sessions.delete(sessionId);
    return entry.adapter.stop().finally(() => this.finished.fire({ session: entry.session, outputDir: entry.outputDir,
      exitCode: entry.exitCode, processGroup: entry.pid }));
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.statusGeneration++;
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = Promise.all([...this.sessions.keys()].map(id => this.release(id)).concat(this.stopProbes()))
      .finally(() => { this.finished.dispose(); this.channel.dispose(); });
    return this.disposePromise;
  }
}

module.exports = { DebugWorkspace, DEBUG_TYPE };

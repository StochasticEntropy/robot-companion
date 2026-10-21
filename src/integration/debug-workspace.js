"use strict";

const vscode = require("vscode");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateDescriptor, selectServices, requireService, ExecutionContexts } = require("./backend-contract");
const providers = require("./backend-providers");
const { DapProcessAdapter, CancelledDebugAdapter } = require("./dap-session");
const { isNative, checkPreparedSession } = require("./native-backend");

const DEBUG_TYPE = "robotcompanion";
const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);
const TRUST_REFUSAL = "Robot Companion debugging starts a configured executable and requires a trusted workspace.";
const EXTERNAL_ATTACH_KEYS = ["processId", "host", "port", "connect", "address", "secret"];
const EXTERNAL_ATTACH_REFUSAL = "Robot Companion attaches only to a prepared native session (preparedSession) or to the " +
  "Python process of its own debug session; processId, host, port and secret attach are not supported.";
const PREPARED_PATH_REFUSAL = "The robotcompanion attach configuration needs preparedSession: the absolute descriptor " +
  "path printed by `robot-companion-backend dap-prepare`.";
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
  constructor(extensionContext, status, environments) {
    // Shared provider status (language status items and the status command).
    this.status = status;
    // The folder's project environment (selected interpreter) behind the native default.
    this.environments = environments;
    // Short-lived capability probes for the status (initialize only, no launch).
    this.probes = new Set();
    this.statusGeneration = 0;
    // Refusals already notified, per folder and message. One settings change refreshes the status several
    // times; repeating a refusal makes VS Code drop later toasts (more than three within 800 ms), which
    // could hide a different refusal. The status entry and the output channel keep every refusal.
    this.notifiedRefusals = new Set();
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
      vscode.workspace.onDidChangeWorkspaceFolders(event => {
        // A session ends with its workspace folder; it cannot move to another root.
        for (const { session, folder } of this.sessions.values()) {
          if (event.removed.some(removed => removed.uri.toString() === folder?.uri.toString())) {
            this.channel.appendLine(`[${folder?.name}] Workspace folder removed; stopping '${session.name}'.`);
            void vscode.debug.stopDebugging(session);
          }
        }
        void this.refreshStatus();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("robotCompanion.integrationMode") ||
            event.affectsConfiguration("robotCompanion.executionBackend") ||
            event.affectsConfiguration("robotCompanion.nativeBackendExecutable")) void this.refreshStatus();
        for (const { session, folder } of this.sessions.values()) {
          if (event.affectsConfiguration("robotCompanion.integrationMode", folder?.uri) ||
              event.affectsConfiguration("robotCompanion.executionBackend", folder?.uri) ||
              event.affectsConfiguration("robotCompanion.nativeBackendExecutable", folder?.uri)) {
            this.channel.appendLine(`[${folder?.name}] Debug configuration changed; stopping '${session.name}'.`);
            void vscode.debug.stopDebugging(session);
          }
        }
      }),
      // Another interpreter for a folder: its running sessions stop, others continue.
      ...(environments ? [environments.onDidChange(folders => {
        for (const { session, folder } of this.sessions.values()) {
          if (!folder || !folders.has(folder.uri.toString())) continue;
          this.channel.appendLine(`[${folder.name}] Robot environment changed; stopping '${session.name}'.`);
          void vscode.debug.stopDebugging(session);
        }
        void this.refreshStatus();
      })] : [])
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
        let input, environment;
        try { ({ input, environment } = await this.descriptorFor(folder)); }
        catch (error) {
          if (generation !== this.statusGeneration || this.disposed) return;
          this.status.set("execution", folder, { state: "refused", error: error.message, environment: error.backend });
          if (error.environment) this.environments.notify(folder, error.message);
          else {
            const key = JSON.stringify([folder.uri.toString(), error.message]);
            if (!this.notifiedRefusals.has(key)) {
              this.notifiedRefusals.add(key);
              void vscode.window.showErrorMessage(`Robot Companion debug provider not available. ${error.message}`);
            }
          }
          continue;
        }
        if (generation !== this.statusGeneration || this.disposed) return;
        const provider = providers.describe(validateDescriptor(input));
        this.status.set("execution", folder, { state: "starting", provider, capabilities: [], environment });
        try {
          const capabilities = await this.probe(input, generation);
          if (generation !== this.statusGeneration || this.disposed) return;
          this.status.set("execution", folder, { state: "running", provider, capabilities: capabilityNames(capabilities), environment });
        } catch (error) {
          if (generation !== this.statusGeneration || this.disposed) return;
          const message = `robotCompanion.executionBackend for folder '${folder.name}': ${error.message}`;
          this.status.set("execution", folder, { state: "refused", error: message, environment });
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
        // A backend that exits first leaves initialize cancelled, not answered.
        adapter.once("closed", ({ code, signal }) => {
          clearTimeout(timer);
          reject(new Error(`the debug backend exited (${signal || code}) before answering initialize.`));
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

  async resolveDebugConfiguration(folder, config) {
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
      if (EXTERNAL_ATTACH_KEYS.some(key => key in config)) return this.refuse(EXTERNAL_ATTACH_REFUSAL);
      // A Python child announced by a running owned session, or a prepared Robot session.
      if (config.robotCompanionHandoff !== undefined) {
        return config.preparedSession === undefined && this.handoffs.has(config.robotCompanionHandoff) ? config :
          this.refuse("Robot Companion attaches only to the Python process of its own running debug session.");
      }
      return this.resolvePreparedAttach(folder, config);
    }
    if (config.request !== "launch") return this.refuse("Robot Companion supports launch configurations and attach to a prepared session only.");
    if (typeof config.target !== "string" || !config.target.trim()) {
      return this.refuse("The robotcompanion launch configuration needs a target file.");
    }
    try {
      await this.descriptorFor(folder);
    } catch (error) {
      return this.refuse(error.message);
    }
    return config;
  }

  // Attach to a session prepared by `robot-companion-backend dap-prepare`.
  // Trust, owned mode and the native provider are checked before anything
  // reads the descriptor (which only the backend's own connector opens).
  resolvePreparedAttach(folder, config) {
    let descriptor;
    try {
      descriptor = this.descriptorFor(folder);
    } catch (error) {
      return this.refuse(error.message);
    }
    if (!isNative(validateDescriptor(descriptor))) {
      return this.refuse(`Attaching to a prepared Robot session requires the native backend; folder '${folder.name}' ` +
        "uses another execution backend (RobotCode keeps its own launch and attach behavior).");
    }
    const prepared = config.preparedSession;
    if (typeof prepared !== "string" || prepared.includes("\0") || !path.isAbsolute(prepared)) {
      return this.refuse(PREPARED_PATH_REFUSAL);
    }
    // A consumed or invalid descriptor is refused here, before a session exists:
    // VS Code cannot end a session cleanly once its initialize or attach has failed.
    const service = requireService(descriptor, "debug", vscode.workspace.isTrusted);
    return checkPreparedSession(service, { preparedSession: prepared, workspace: folder.uri.fsPath })
      .then(result => result.ok ? config : this.refuse(result.message.replace(/^Robot Companion: /, "")));
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

  // { input, environment }: the folder's execution descriptor and its project environment.
  async descriptorFor(folder) {
    // Check trust and mode before reading the executable descriptor.
    if (!vscode.workspace.isTrusted) throw new Error(TRUST_REFUSAL);
    if (!folder || folder.uri.scheme !== "file") throw new Error("Robot Companion debugging needs a workspace folder on this host.");
    const mode = integrationMode(folder);
    if (mode !== "owned") throw new Error(COEXISTENCE_REFUSAL);
    const environment = await this.environments.backend(folder, "executionBackend");
    // Trust and mode may have changed while the environment was checked.
    if (!vscode.workspace.isTrusted) throw new Error(TRUST_REFUSAL);
    if (integrationMode(folder) !== "owned") throw new Error(COEXISTENCE_REFUSAL);
    if (environment.refusal) throw Object.assign(new Error(environment.refusal), { environment: true, backend: environment });
    const input = environment.input;
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
      throw Object.assign(new Error(prefix + error.message), { backend: environment });
    }
    return { input, environment };
  }

  refuse(message) {
    this.channel.appendLine(`Debug not started: ${message}`);
    void vscode.window.showErrorMessage(`Robot Companion: ${message}`);
    return undefined;
  }

  async createDebugAdapterDescriptor(session) {
    const folder = session.workspaceFolder;
    const prepared = session.configuration.request === "attach" && session.configuration.robotCompanionHandoff === undefined;
    if (session.configuration.request === "attach" && !prepared) {
      const endpoint = this.handoffs.get(session.configuration.robotCompanionHandoff);
      this.handoffs.delete(session.configuration.robotCompanionHandoff);
      if (!endpoint || !session.parentSession) {
        throw new Error("The Python child session has no running Robot Companion parent session.");
      }
      // Its Robot session ended or was stopped meanwhile: the child would only fail to connect.
      const parent = this.sessions.get(session.parentSession.id);
      if (!parent || parent.adapter.ending) {
        this.channel.appendLine(`[${folder?.name}] Python child '${session.name}' not connected: its Robot session is ending.`);
        return new vscode.DebugAdapterInlineImplementation(new CancelledDebugAdapter());
      }
      if (endpoint.generation !== undefined && endpoint.generation !== parent.adapter.bridge?.generation) {
        throw new Error("This Python handoff belongs to an earlier run of the restarted Robot session.");
      }
      this.channel.appendLine(`[${folder?.name}] Python child '${session.name}' connects to ${endpoint.host}:${endpoint.port}.`);
      return new vscode.DebugAdapterServer(endpoint.port, endpoint.host);
    }
    // Re-check immediately before spawning: trust, mode and descriptor may
    // have changed since the configuration was resolved.
    let adapter, context, provider, environment;
    try {
      if (this.disposed) throw new Error("Robot Companion is shutting down.");
      const { input: descriptor, environment: resolved } = await this.descriptorFor(folder);
      if (this.disposed) throw new Error("Robot Companion is shutting down.");
      environment = resolved;
      provider = providers.describe(validateDescriptor(descriptor));
      if (prepared) {
        if (!isNative(validateDescriptor(descriptor))) throw new Error("Attaching to a prepared Robot session requires the native backend.");
        context = {};
        adapter = new DapProcessAdapter({ descriptor, trusted: vscode.workspace.isTrusted, context,
          prepared: { preparedSession: session.configuration.preparedSession, workspace: folder.uri.fsPath } });
      } else {
        context = this.executionContext(folder);
        adapter = new DapProcessAdapter({ descriptor, trusted: vscode.workspace.isTrusted, context,
          nextOutputDir: () => this.newOutputDir() });
      }
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
        `Robot Companion debug provider: ${provider}; advertises ${capabilityNames(capabilities).join(", ") || "no optional capabilities"}.\n` +
        (environment?.full ? `Robot Companion environment: ${environment.full}.\n` : "") } });
      this.status?.set("execution", folder, { state: "running", provider, capabilities: capabilityNames(capabilities), environment });
    });
    adapter.on("closed", ({ code, signal }) => {
      this.channel.appendLine(`${label}: process exited (${signal || code}).`);
      // VS Code reports no end (onDidTerminateDebugSession) for a session whose launch
      // never succeeded, for example one stopped or killed while launching: release it here.
      if (adapter.failedStart || !adapter.launched) void this.release(session.id);
    });
    // The backend ended without a Stop: a deliberate Stop stays quiet.
    adapter.on("unexpectedExit", ({ code, signal }) => {
      void vscode.window.showWarningMessage(`Robot Companion: the debug backend '${adapter.backendId}' exited unexpectedly ` +
        `(${signal || code}), so the debug session ended. Its debug log may show why.`,
      "Show Debug Log").then(choice => { if (choice) this.channel.show(true); });
    });
    adapter.on("pythonChild", endpoint => { void this.startPythonChild(session, endpoint); });
    const entry = { session, folder, adapter, outputDir: context.outputDir };
    adapter.on("restarted", ({ outputDir }) => {
      // Test Explorer reads the last run's results; the earlier run's folder is kept.
      if (outputDir) entry.outputDir = outputDir;
      this.channel.appendLine(`${label}: restarted '${session.name}'${outputDir ? `; output folder ${outputDir}` : ""}.`);
    });
    adapter.on("runExited", ({ exitCode, outputFile }) => {
      entry.exitCode = exitCode;
      this.channel.appendLine(`${label}: Robot run ended with exit code ${exitCode}${outputFile ? `; output ${outputFile}` : ""}.`);
    });
    const pid = entry.pid = adapter.start();
    this.sessions.set(session.id, entry);
    this.channel.appendLine(`${label}: started debug process ${pid} for '${session.name}'.` +
      (environment?.full ? ` Environment: ${environment.full}.` : ""));
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  // Per-root execution inputs (cwd, robotArguments) plus an output folder of
  // its own for each debug run, next to the CodeLens runner's results.
  executionContext(folder) {
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const context = this.contexts.forRoot(folder.uri.toString(), {
      robotCommand: config.get("robotCommand", "robot"), robotArguments: config.get("robotArguments", [])
    }, vscode.workspace.isTrusted);
    const outputDir = this.newOutputDir();
    return outputDir ? { ...context, outputDir } : context;
  }

  newOutputDir() {
    if (!this.storagePath) return undefined;
    const root = path.join(this.storagePath, "debug-runs");
    fs.mkdirSync(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return fs.mkdtempSync(path.join(root, `${stamp}-`));
  }

  async startPythonChild(parent, endpoint) {
    const entry = this.sessions.get(parent.id);
    if (!entry) return;
    // Stopped while launching: a Python child started now could only fail to connect.
    if (entry.adapter.ending) {
      this.channel.appendLine(`[${parent.workspaceFolder?.name}] Python child session for '${parent.name}' not started: the session is ending.`);
      return;
    }
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

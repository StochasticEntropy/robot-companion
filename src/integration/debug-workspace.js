"use strict";

const vscode = require("vscode");
const { validateDescriptor, selectServices } = require("./backend-contract");
const { DapProcessAdapter } = require("./dap-session");

const DEBUG_TYPE = "robotcompanion";
const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);

// Owns the Robot Companion debug type: configuration resolution, one owned
// adapter process per session and cleanup. Debug selection reads only
// robotCompanion.executionBackend, never the language descriptor.
class DebugWorkspace {
  constructor() {
    this.sessions = new Map();
    this.disposed = false;
    this.channel = vscode.window.createOutputChannel("Robot Companion Debug");
    this.subscriptions = [
      vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, this),
      vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, this),
      vscode.debug.onDidTerminateDebugSession(session => { void this.release(session.id); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        for (const { session, folder } of this.sessions.values()) {
          if (event.affectsConfiguration("robotCompanion.integrationMode", folder?.uri) ||
              event.affectsConfiguration("robotCompanion.executionBackend", folder?.uri)) {
            this.channel.appendLine(`[${folder?.name}] Debug configuration changed; stopping '${session.name}'.`);
            void vscode.debug.stopDebugging(session);
          }
        }
      })
    ];
  }

  provideDebugConfigurations() {
    return [{ type: DEBUG_TYPE, request: "launch", name: "Robot Companion: Debug current file", target: "${file}" }];
  }

  resolveDebugConfiguration(folder, config) {
    if (!config.type && !config.request && !config.name) {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!isRobotPath(uri)) return this.refuse("Open a .robot or .resource file, or add a robotcompanion launch configuration.");
      config = { ...this.provideDebugConfigurations()[0], target: uri.fsPath };
      folder = vscode.workspace.getWorkspaceFolder(uri);
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

  descriptorFor(folder) {
    // Check trust and mode before reading the executable descriptor.
    if (!vscode.workspace.isTrusted) {
      throw new Error("Robot Companion debugging starts a configured executable and requires a trusted workspace.");
    }
    if (!folder || folder.uri.scheme !== "file") throw new Error("Robot Companion debugging needs a workspace folder on this host.");
    const mode = vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("integrationMode", "coexistence");
    if (mode !== "owned") {
      throw new Error("Robot Companion debugging runs only when robotCompanion.integrationMode is \"owned\". " +
        "In coexistence mode, keep using your existing Robot debugger.");
    }
    const input = vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("executionBackend");
    if (!input) throw new Error(`Set robotCompanion.executionBackend for folder '${folder.name}' to debug with Robot Companion.`);
    const descriptor = validateDescriptor(input);
    if (descriptor.workspaceUri !== folder.uri.toString()) {
      throw new Error("executionBackend.workspaceUri must match this workspace folder URI.");
    }
    if (!selectServices({ mode, execution: input }).debug) {
      throw new Error(`Backend '${descriptor.id}' does not support debug.`);
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
    // Re-check immediately before spawning: trust, mode and descriptor may
    // have changed since the configuration was resolved.
    let adapter;
    try {
      if (this.disposed) throw new Error("Robot Companion is shutting down.");
      adapter = new DapProcessAdapter({ descriptor: this.descriptorFor(folder), trusted: vscode.workspace.isTrusted });
    } catch (error) {
      this.channel.appendLine(`[${folder?.name}] Debug not started: ${error.message}`);
      throw error;
    }
    const label = `[${folder.name}] ${adapter.backendId}`;
    adapter.on("log", text => this.channel.append(`${label}: ${text}`));
    adapter.on("failure", error => this.channel.appendLine(`${label}: ${error.message}`));
    adapter.on("capabilities", (capabilities, unsupported) => this.channel.appendLine(
      `${label}: capabilities ${JSON.stringify(capabilities)}` +
      (unsupported.length ? `; not supported: ${unsupported.join(", ")}` : "")));
    adapter.on("closed", ({ code, signal }) => this.channel.appendLine(`${label}: process exited (${signal || code}).`));
    const pid = adapter.start();
    this.sessions.set(session.id, { session, folder, adapter });
    this.channel.appendLine(`${label}: started debug process ${pid} for '${session.name}'.`);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  release(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    this.sessions.delete(sessionId);
    return entry.adapter.stop();
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = Promise.all([...this.sessions.keys()].map(id => this.release(id)))
      .finally(() => this.channel.dispose());
    return this.disposePromise;
  }
}

module.exports = { DebugWorkspace, DEBUG_TYPE };

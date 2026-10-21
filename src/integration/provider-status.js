"use strict";

const vscode = require("vscode");

const SELECTOR = [{ language: "robotframework" }];
const KINDS = Object.freeze({
  language: { title: "Language", setting: "robotCompanion.languageBackend" },
  execution: { title: "Debug", setting: "robotCompanion.executionBackend" },
  discovery: { title: "Tests", setting: "robotCompanion.discoveryBackend" }
});

// Which language, execution (debug) and Test Explorer discovery provider is
// active for the active editor's folder, with its advertised capabilities or
// the reason it was refused. Shown as language status items for Robot files (the `{}` entry in the status
// bar) and in Robot Companion: Show Language Service Status.
class ProviderStatus {
  constructor() {
    this.entries = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, new Map()]));
    this.items = {};
    for (const [kind, { title }] of Object.entries(KINDS)) {
      const item = vscode.languages.createLanguageStatusItem(`robotCompanion.${kind}Provider`, SELECTOR);
      item.name = `Robot Companion ${title.toLowerCase()} provider`;
      item.command = { title: "Details", command: "robotCompanion.showLanguageServiceStatus" };
      this.items[kind] = item;
    }
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      // Mode changes alter the shown state even before a workspace reports a provider.
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("robotCompanion")) this.render(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.render())
    ];
    this.render();
  }

  // entry: { state: "starting" | "running" | "refused" | "inactive", provider, capabilities: string[], detail, error }
  set(kind, folder, entry) {
    if (!folder) return;
    this.entries[kind].set(folder.uri.toString(), { folder, ...entry });
    this.render();
  }

  update(kind, folder, changes) {
    const current = folder && this.entries[kind].get(folder.uri.toString());
    if (current) this.set(kind, folder, { ...current, ...changes });
  }

  delete(kind, folder) {
    if (folder && this.entries[kind].delete(folder.uri.toString())) this.render();
  }

  get(kind, folder) {
    return folder && this.entries[kind].get(folder.uri.toString());
  }

  folder() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
  }

  // `detail` is the short line in the status hover, which does not wrap: it must
  // leave room for the row's Details link. `full` is the complete line for Details.
  describe(kind, folder) {
    const { title, setting } = KINDS[kind];
    if (!vscode.workspace.isTrusted) {
      return { text: `${title}: Restricted Mode`, detail: "nothing starts",
        full: "No backend processes start until the workspace is trusted." };
    }
    const mode = folder && vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("integrationMode", "coexistence");
    const entry = this.get(kind, folder);
    if (mode !== "owned") {
      return { text: `${title}: coexistence`, detail: "no owned provider", full: "No owned provider; Robot Companion's own features only." };
    }
    if (!entry && kind === "discovery") {
      return { text: `${title}: file/run fallback`, detail: "Run Test CodeLens",
        full: "No discovery service configured, so no Test Explorer items: use the Run Test / Run Suite CodeLens and Run and Debug." };
    }
    if (!entry) return { text: `${title}: none`, detail: `no ${setting}`, full: `No ${setting}; Robot Companion's own features only.` };
    if (entry.state === "refused") {
      return { text: `${title}: refused`, detail: "nothing started", full: entry.error, severity: vscode.LanguageStatusSeverity.Error };
    }
    const capabilities = entry.capabilities || [];
    const count = entry.summary || (capabilities.length ? `${capabilities.length} ${capabilities.length === 1 ? "capability" : "capabilities"}`
      : entry.state === "starting" ? "starting" : "no capabilities advertised");
    return { text: `${title}: ${entry.provider}`, detail: count, busy: entry.state === "starting",
      full: [capabilities.length ? capabilities.join(", ") : count, entry.detail].filter(Boolean).join("; ") };
  }

  render() {
    const folder = this.folder();
    for (const kind of Object.keys(KINDS)) {
      const item = this.items[kind], view = this.describe(kind, folder);
      item.text = view.text;
      item.detail = view.detail;
      item.accessibilityInformation = { label: `${view.text}: ${view.full}` };
      item.severity = view.severity ?? vscode.LanguageStatusSeverity.Information;
      item.busy = Boolean(view.busy);
    }
  }

  // Complete lines for every folder, for Show Language Service Status (Details).
  lines() {
    const lines = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const kind of Object.keys(KINDS)) {
        const view = this.describe(kind, folder);
        lines.push(`[${folder.name}] ${view.text} — ${view.full}`);
      }
    }
    return lines;
  }

  dispose() {
    for (const item of Object.values(this.items)) item.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

module.exports = { ProviderStatus };

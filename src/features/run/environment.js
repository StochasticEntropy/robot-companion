"use strict";
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const core = require("./environment-core");
const { bounded, execute, ProbePool } = require("./environment-process");
const { PythonEnvironment } = require("./python-environment");
const { formatCommandLine } = require("./runner-core");
const COMMAND = "robotCompanion.selectRobotEnvironment";
const TRUST = "Trust this workspace to check environments, run tests or install robotframework.";
const SELECT = "Select Environment", INSTALL = "Install robotframework", OUTPUT = "Show Output";
function robotUri(editor) { const uri = editor?.document.uri; return uri?.scheme === "file" && /\.robot$/i.test(uri.fsPath) ? uri : undefined; }
class RobotEnvironmentController {
  constructor(context, runner, trusted = () => vscode.workspace.isTrusted !== false) {
    this.context = context; this.runner = runner; this.trusted = trusted; this.version = 0; this.statusGeneration = 0; this.disposed = false;
    this.pool = new ProbePool(() => this.allowed(), { onFailure: (target, result, availability) => {
      this.runner._getChannel().appendLine(`Environment check: ${target.executable} — ${core.availabilityText(availability)}
${result.diagnostic || result.output || ""}`);
    } });
    this.python = new PythonEnvironment(vscode, () => this.allowed(), () => this.invalidate());
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.status.name = "Robot Environment"; this.status.command = COMMAND;
    this.disposables = [
      vscode.commands.registerCommand(COMMAND, () => this.pick()),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        this.statusGeneration++;
        if (this.flow && this.scope(editor?.document.uri) !== this.flow.scope) {
          this.flow.cancelled = true; this.flow.ui?.hide(); this.pool.invalidate();
          void vscode.window.showInformationMessage("Active folder changed. Select an environment for the current file.");
        }
        clearTimeout(this.editorTimer); this.editorTimer = setTimeout(() => { void this.refreshStatus(); }, 100);
      }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("robotCompanion.robotCommand")) this.invalidate(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { this.invalidate(false); }),
      vscode.extensions.onDidChange(() => { this.python.reset(); this.invalidate(); })
    ];
    void this.refreshStatus();
  }
  allowed() { return !this.disposed && this.trusted(); }
  scope(uri) { return uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() : undefined; }
  saved(uri) { const map = this.context.workspaceState.get(core.STATE_KEY, {}); return map[this.scope(uri)]; }
  cwd(uri) { return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath); }
  invalidate(refresh = true) {
    this.version++; this.statusGeneration++; this.pool.invalidate(); this.installCancellation?.cancel();
    if (refresh) void this.refreshStatus();
    else { this.status.text = "Robot: Refresh required"; this.status.tooltip = "Select Robot Environment to refresh after granting workspace trust."; }
  }
  dispose() {
    this.disposed = true; this.flow && (this.flow.cancelled = true); this.flow?.ui?.hide();
    clearTimeout(this.editorTimer); this.installCancellation?.cancel(); this.pool.invalidate(); this.python.dispose(); this.status.dispose();
    this.disposables.forEach(d => d.dispose());
  }
  async resolve(uri, check = false, fresh = false) {
    if (!this.allowed()) return { label: "Trust required", availability: { state: "trustRequired" } };
    const version = this.version;
    const target = core.effectiveTarget(vscode.workspace.getConfiguration("robotCompanion", uri), this.saved(uri));
    if (target.source === "pythonExtension") Object.assign(target, await this.python.resolve(uri));
    if (!this.allowed() || version !== this.version) return { ...target, availability: { state: "cancelled" } };
    // A run of the default or a configured command keeps its original invocation: no extra probe.
    if (check && target.executable && !(fresh && ["default", "setting"].includes(target.source))) {
      if (fresh) {
        const error = target.executable === "robot" ? undefined : await this.validatePath(target.executable);
        if (error) return { ...target, version, availability: { state: "unavailable", diagnostic: error } };
        if (!this.allowed() || version !== this.version) return { ...target, version, availability: { state: "cancelled" } };
        this.pool.forget(target, this.cwd(uri));
      }
      target.availability = await this.pool.probe(target, this.cwd(uri));
    }
    return { ...target, version };
  }
  async refreshStatus() {
    const generation = ++this.statusGeneration;
    const uri = robotUri(vscode.window.activeTextEditor);
    if (!uri) { this.status.hide(); return; }
    this.status.show(); this.status.text = this.allowed() ? "Robot: Checking…" : "Robot: Trust required";
    try {
      const target = await this.resolve(uri, true);
      if (this.disposed || generation !== this.statusGeneration || robotUri(vscode.window.activeTextEditor)?.toString() !== uri.toString()) return;
      if (target.availability?.state === "cancelled") return;
      const state = core.availabilityText(target.availability);
      const suffix = target.availability?.pythonVersion ? ` (${target.availability.pythonVersion})` : "";
      const degraded = target.availability && !["available", "trustRequired"].includes(target.availability.state) ? ` — ${state}` : "";
      this.status.text = `Robot: ${target.label}${suffix}${degraded}`;
      this.status.tooltip = ["Select Robot Environment", `Folder: ${this.scope(uri) || "Standalone file (default/setting only)"}`, `Source: ${target.source || "trust required"}${target.settingScope ? ` (${target.settingScope}) — robotCompanion.robotCommand` : ""}`, target.executable && formatCommandLine(target.executable, target.args), state, target.availability?.diagnostic, target.maskedSelection && `Saved choice: ${target.maskedSelection.label}. Not used while robotCompanion.robotCommand is set.`].filter(Boolean).join("\n");
      this.status.accessibilityInformation = { label: `Select Robot Environment: ${this.status.tooltip}`, role: "button" };
    } catch (error) {
      if (generation !== this.statusGeneration) return;
      this.status.text = "Robot: Setting — invalid"; this.status.tooltip = `Select Robot Environment\n${error.message}`;
    }
  }
  async validatePath(value) {
    const error = core.pathError(value); if (error) return error;
    try {
      await bounded((async () => { const stat = await fs.promises.stat(value); if (!stat.isFile()) throw new Error("Choose an executable file, not a directory."); await fs.promises.access(value, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); })());
    } catch (error) { return error.code === "ENOENT" ? "Executable not found. Check the full path." : error.message; }
  }
  async candidates(uri) {
    const rows = [];
    try { const effective = await this.resolve(uri); if (effective.source === "setting") rows.push({ ...effective, id: "setting", utility: "setting" }); } catch (error) { rows.push({ id: "setting", label: "Setting — invalid", utility: "setting", availability: { state: "checkFailed", diagnostic: error.message } }); }
    if (vscode.extensions.getExtension("ms-python.python") || this.saved(uri)?.kind === "pythonExtension") rows.push({ id: "pythonExtension", source: "pythonExtension", kind: "python", label: "Python extension", args: ["-m", "robot"], selection: { version: 1, kind: "pythonExtension" } });
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    for (const name of [".venv", "venv", "env"]) {
      const executable = core.interpreterPath(path.join(folder.uri.fsPath, name));
      rows.push({ id: executable, kind: "python", label: name, executable, args: ["-m", "robot"], selection: { version: 1, kind: "python", path: executable, label: name } });
    }
    // A bounded .venv text hint is data only; never invoke a manager.
    try {
      const hint = path.join(folder.uri.fsPath, ".venv");
      const stat = await bounded(fs.promises.stat(hint));
      if (stat.isFile() && stat.size <= 4096) {
        const text = (await bounded(fs.promises.readFile(hint, "utf8"))).trim();
        if (path.isAbsolute(text) && !/[\r\n\0]/.test(text)) {
          const executable = core.interpreterPath(text);
          rows.push({ id: executable, kind: "python", label: ".venv location", executable, args: ["-m", "robot"], selection: { version: 1, kind: "python", path: executable, label: ".venv location" } });
        }
      }
    } catch { /* An absent hint is normal. */ }
    const saved = core.selectionTarget(this.saved(uri));
    if (saved?.source === "saved" && !rows.some(r => r.executable === saved.executable)) rows.push({ ...saved, id: saved.executable, selection: this.saved(uri) });
    rows.push({ id: "pathRobot", kind: "executable", source: "pathRobot", label: "robot on PATH", executable: "robot", args: [], selection: { version: 1, kind: "pathRobot" } });
    return rows.slice(0, 8);
  }
  flowValid(flow) { return !flow.cancelled && !this.disposed && this.flow === flow && this.allowed() && this.scope(vscode.window.activeTextEditor?.document.uri) === flow.scope; }
  async pick() {
    const editor = vscode.window.activeTextEditor, uri = robotUri(editor);
    if (!uri) return vscode.window.showInformationMessage("Open a saved .robot file to select its environment.");
    if (!this.allowed()) {
      const choice = await vscode.window.showWarningMessage(TRUST, "Manage Workspace Trust");
      if (choice) void vscode.commands.executeCommand("workbench.trust.manage"); return;
    }
    if (!this.scope(uri)) return vscode.window.showInformationMessage("Open a workspace folder to save an environment choice. Standalone Robot files still use robotCompanion.robotCommand or the default robot on PATH.");
    if (this.flow) { this.flow.cancelled = true; this.flow.ui?.hide(); }
    const flow = { uri, scope: this.scope(uri), cancelled: false }; this.flow = flow;
    const picker = vscode.window.createQuickPick(); flow.ui = picker;
    picker.title = `Select Robot Environment — ${vscode.workspace.getWorkspaceFolder(uri).name}`;
    picker.placeholder = "Used by Run Test and Run Suite in this folder.";
    picker.matchOnDescription = true; picker.matchOnDetail = true; picker.keepScrollPosition = true;
    const utilities = [{ label: "Enter path…", id: "custom" }, { label: "Refresh", id: "refresh" }, { label: "Open robotCommand Setting", id: "setting", utility: "setting" }];
    picker.items = [{ label: "Checking environments…", id: "loading" }, ...utilities];
    let rows = [], refresh = 0, step = "picker", deadline;
    const update = () => {
      if (!this.flowValid(flow) || step !== "picker") return;
      const active = picker.activeItems[0]?.id;
      const saved = this.saved(uri);
      const scope = core.settingScope(vscode.workspace.getConfiguration("robotCompanion", uri).inspect("robotCommand"));
      picker.items = [...rows.map(row => ({ ...row, description: [core.availabilityText(row.availability), row.utility === "setting" || (!scope && JSON.stringify(row.selection) === JSON.stringify(saved)) || (!saved && !scope && row.id === "pathRobot") ? "Effective" : saved && JSON.stringify(row.selection) === JSON.stringify(saved) ? "Saved, overridden by setting" : ""].filter(Boolean).join(" · "), detail: [row.executable, row.availability?.diagnostic].filter(Boolean).join(" — ") })), ...utilities];
      const highlight = picker.items.find(row => row.id === active) || picker.items.find(row => row.description?.includes("Effective"));
      if (highlight) picker.activeItems = [highlight];
    };
    const load = async () => {
      const current = ++refresh; clearTimeout(deadline); picker.busy = true;
      deadline = setTimeout(() => { if (current !== refresh || !this.flowValid(flow)) return; refresh++; this.pool.invalidate(); rows.forEach(r => { if (!r.availability || r.availability.state === "checking") r.availability = { state: "timedOut" }; }); picker.busy = false; update(); }, 8000);
      try {
        const found = await this.candidates(uri);
        if (current !== refresh || !this.flowValid(flow)) return;
        rows = found; update();
        await Promise.all(rows.map(async row => {
          if (row.source === "pythonExtension") {
            const resolved = await this.python.resolve(uri);
            if (current !== refresh || !this.flowValid(flow)) return;
            Object.assign(row, resolved);
          }
          if (current !== refresh || !this.flowValid(flow)) return;
          const availability = row.executable ? await this.pool.probe(row, this.cwd(uri)) : row.availability || { state: "unavailable" };
          // A deadline or Refresh supersedes this result; never overwrite its rows late.
          if (current !== refresh) return;
          row.availability = availability; update();
        }));
      } catch (error) { if (this.flowValid(flow)) void vscode.window.showErrorMessage(`Could not check environments: ${error.message}`); }
      finally { if (current === refresh) { clearTimeout(deadline); picker.busy = false; } }
    };
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; flow.cancelled = true; refresh++; clearTimeout(deadline); this.pool.invalidate(); resolve(); };
      const disposables = [picker.onDidHide(() => { if (step === "picker") finish(); }), picker.onDidAccept(async () => {
        const row = picker.selectedItems[0]; if (!row || !this.flowValid(flow)) return;
        try {
          if (row.id === "refresh") { this.pool.invalidate(); void load(); return; }
          if (row.utility === "setting") { finish(); picker.hide(); void vscode.commands.executeCommand("workbench.action.openSettings", "robotCompanion.robotCommand"); return; }
          let selection;
          if (row.id === "custom") {
            step = "custom"; picker.hide(); selection = await this.customPath(flow);
            if (!this.flowValid(flow)) { finish(); return; }
            if (selection === "back") { step = "picker"; flow.ui = picker; picker.show(); update(); return; }
            if (!selection) { finish(); return; }
          } else {
            if (!row.selection || !["available", "missingRobot"].includes(row.availability?.state)) { picker.validationMessage = "Choose an available environment, Enter path, or Refresh after a failed check."; return; }
            selection = row.selection;
          }
          if (!this.flowValid(flow)) { finish(); return; }
          await this.save(uri, selection);
          if (!this.flowValid(flow)) { finish(); return; }
          finish(); picker.hide();
          const target = await this.resolve(uri, true);
          if (target.availability?.state === "missingRobot") void this.reportUnavailable(uri, target);
        } catch (error) { if (this.flowValid(flow)) void vscode.window.showErrorMessage(`Could not save Robot environment: ${error.message}`); }
      })];
      picker.show(); // Show before any API/stat/process await.
      void load();
      flow.cleanup = () => disposables.forEach(d => d.dispose());
    });
    flow.cleanup?.(); picker.dispose(); if (this.flow === flow) this.flow = undefined;
    if (!this.disposed) void this.refreshStatus();
    if (!this.disposed && vscode.window.activeTextEditor === editor) void vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }
  async save(uri, selection) {
    if (!this.allowed()) throw new Error(TRUST);
    const map = { ...this.context.workspaceState.get(core.STATE_KEY, {}), [this.scope(uri)]: selection };
    await this.context.workspaceState.update(core.STATE_KEY, map);
    this.invalidate();
    const target = await this.resolve(uri);
    if (target.settingScope) void vscode.window.showInformationMessage(`Saved ${core.selectionTarget(selection).label}. Runs still use robotCompanion.robotCommand (${target.settingScope}).`, "Open Setting").then(choice => { if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "robotCompanion.robotCommand"); });
  }
  async customPath(flow) {
    let kind, text = "";
    while (this.flowValid(flow)) {
      const type = vscode.window.createQuickPick(); flow.ui = type;
      type.title = "Choose executable type"; type.buttons = [vscode.QuickInputButtons.Back];
      type.items = [{ label: "Python interpreter", kind: "python" }, { label: "Robot executable", kind: "executable" }];
      if (kind) type.activeItems = type.items.filter(item => item.kind === kind);
      const selected = await new Promise(resolve => {
        const ds = [type.onDidAccept(() => resolve(type.selectedItems[0]?.kind)), type.onDidTriggerButton(() => resolve("back")), type.onDidHide(() => resolve(undefined))];
        type.show(); flow.stepCleanup = () => ds.forEach(d => d.dispose());
      });
      flow.stepCleanup(); type.dispose();
      if (!selected || selected === "back" || !this.flowValid(flow)) return selected;
      kind = selected;
      const input = vscode.window.createInputBox(); flow.ui = input;
      input.title = kind === "python" ? "Path to Python interpreter" : "Path to Robot executable";
      input.prompt = "Enter an absolute executable path, without arguments or surrounding quotes.";
      input.value = text; input.buttons = [vscode.QuickInputButtons.Back];
      const accepted = await new Promise(resolve => {
        let validating = false;
        const ds = [input.onDidAccept(async () => {
          if (validating) return; validating = true; input.busy = true;
          const value = input.value;
          const error = await this.validatePath(value);
          if (!this.flowValid(flow)) { resolve(undefined); return; }
          if (input.value !== value) { input.busy = false; validating = false; return; }
          if (error) { input.validationMessage = error; input.busy = false; validating = false; return; }
          const target = { kind, executable: value, args: kind === "python" ? ["-m", "robot"] : [] };
          const availability = await this.pool.probe(target, this.cwd(flow.uri));
          if (!this.flowValid(flow)) { resolve(undefined); return; }
          if (input.value !== value) { input.busy = false; validating = false; return; }
          if (!["available", "missingRobot"].includes(availability.state)) { input.validationMessage = `${core.availabilityText(availability)}. Check the executable or go Back.`; input.busy = false; validating = false; return; }
          resolve({ version: 1, kind, path: value, label: path.basename(value) });
        }), input.onDidTriggerButton(() => resolve("back")), input.onDidHide(() => resolve(undefined))];
        input.show(); flow.stepCleanup = () => ds.forEach(d => d.dispose());
      });
      text = input.value; flow.stepCleanup(); input.dispose();
      if (accepted !== "back") return accepted;
    }
  }
  async reportUnavailable(uri, target) {
    const a = target.availability;
    const missing = a?.state === "missingRobot" && target.kind === "python";
    const message = missing ? `Robot Framework is not installed in ${target.executable}.` : `${target.kind === "python" ? "Python interpreter" : "Robot environment"} unavailable: ${target.executable || target.label}. ${a?.diagnostic || core.availabilityText(a)}`;
    const choice = await vscode.window.showErrorMessage(message, SELECT, ...(missing ? [INSTALL] : []), OUTPUT);
    if (choice === SELECT) void this.pick();
    if (choice === OUTPUT) this.runner.showOutput();
    if (choice === INSTALL) await this.install(uri, target);
  }
  async install(uri, target) {
    if (!this.allowed() || target.kind !== "python" || target.availability?.state !== "missingRobot") return false;
    const version = this.version, scope = this.scope(uri), captured = core.identity(target);
    const choice = await vscode.window.showWarningMessage("Install robotframework in this Python environment?", { modal: true, detail: `Folder: ${scope}\nInterpreter: ${target.executable}\nCommand: ${formatCommandLine(target.executable, ["-m", "pip", "install", "robotframework"])}\nThis installs a package in that environment.` }, INSTALL);
    if (choice !== INSTALL) return false;
    // After confirmation every refusal is shown; nothing starts.
    const refuse = reason => { void vscode.window.showErrorMessage(`robotframework was not installed in ${target.executable}: ${reason}`, SELECT).then(action => { if (action) void this.pick(); }); return false; };
    const blocked = () => !this.allowed() ? "workspace trust is required." : version !== this.version ? "the environment changed; choose Install robotframework again." : this.installing ? "another installation is running." : this.runner._activeRun ? "a Robot run is in progress." : undefined;
    if (blocked()) return refuse(blocked());
    if (scope !== this.scope(vscode.window.activeTextEditor?.document.uri)) return refuse("the active folder changed.");
    const current = await this.resolve(uri);
    if (blocked()) return refuse(blocked());
    if (captured !== core.identity(current)) return refuse("the selected environment changed.");
    const pathError = await this.validatePath(target.executable);
    if (pathError) return refuse(pathError);
    if (blocked()) return refuse(blocked());
    this.installing = true;
    this.installCancellation = new vscode.CancellationTokenSource();
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing robotframework: ${target.executable}`, cancellable: true }, async (_, token) => {
        const subscription = token.onCancellationRequested(() => this.installCancellation.cancel());
        try { return await execute(target, ["-m", "pip", "install", "robotframework"], this.cwd(uri), () => this.allowed() && version === this.version, { timeout: 120000, outputLimit: Infinity, token: this.installCancellation.token, onOutput: text => this.runner._getChannel().append(text) }); }
        finally { subscription.dispose(); }
      });
      if (result.code !== 0 || !this.allowed() || version !== this.version) throw new Error(result.state || `exit ${result.code}`);
      this.pool.invalidate(); const refreshed = await this.resolve(uri, true);
      if (refreshed.availability?.state !== "available") throw new Error(core.availabilityText(refreshed.availability));
      this.invalidate(); void vscode.window.showInformationMessage(`Robot Framework is available in ${target.executable}.`); return true;
    } catch (error) { void vscode.window.showErrorMessage(`Could not install robotframework in ${target.executable}: ${error.message}`, OUTPUT).then(choice => { if (choice) this.runner.showOutput(); }); return false; }
    finally { this.installCancellation.dispose(); this.installCancellation = undefined; this.installing = false; }
  }
}
module.exports = { RobotEnvironmentController, COMMAND };

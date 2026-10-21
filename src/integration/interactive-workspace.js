"use strict";

// Interactive Robot sessions: Robot notebooks (.robotnb) and the Robot REPL (an
// Interactive Window). Each notebook or REPL has its own session: one owned
// `interactive` service process of the native backend, started in the folder
// with the folder's selected Robot environment (the interpreter that runs its
// debug and discovery services), which owns one Robot worker at a time. Cells run
// as Robot keywords in that worker; variables stay set until the session is
// restarted or ends. The Debug Console of a paused Robot debug session is a
// separate path (the `dap` service) and is not used here.
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const vscode = require("vscode");
const { validateDescriptor, requireService } = require("./backend-contract");
const { frame, MessageReader } = require("./lsp-session");

const NOTEBOOK_TYPE = "robotcompanion-notebook";
const NOTEBOOK_CONTROLLER = "robotcompanion-session";
const REPL_CONTROLLER = "robotcompanion-repl";
const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const LANGUAGE = "robotframework";
const NOTEBOOK_FORMAT = 1;
const TRUST_REFUSAL = "Robot sessions start the folder's Python interpreter and require a trusted workspace.";
const MODE_REFUSAL = "Robot sessions run only when robotCompanion.integrationMode is \"owned\".";
const integrationMode = folder => vscode.workspace.getConfiguration("robotCompanion", folder?.uri).get("integrationMode", "coexistence");

// .robotnb: JSON with the cells' kind, language and text. Outputs are not saved.
class NotebookSerializer {
  deserializeNotebook(content) {
    const text = Buffer.from(content).toString("utf8").trim();
    let data = { cells: [] };
    if (text) {
      try { data = JSON.parse(text); } catch (error) { throw new Error(`Not a Robot notebook: ${error.message}`); }
    }
    if (!data || !Array.isArray(data.cells)) throw new Error("Not a Robot notebook: 'cells' must be a list.");
    return new vscode.NotebookData(data.cells.map(cell => new vscode.NotebookCellData(
      cell?.kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
      typeof cell?.source === "string" ? cell.source : "",
      cell?.kind === "markdown" ? "markdown" : LANGUAGE)));
  }

  serializeNotebook(data) {
    const cells = data.cells.map(cell => ({ kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
      source: cell.value }));
    return Buffer.from(`${JSON.stringify({ robotCompanionNotebook: NOTEBOOK_FORMAT, cells }, null, 2)}\n`, "utf8");
  }
}

// One owned `interactive` service process: requests, responses and events over stdio.
class SessionProcess extends EventEmitter {
  constructor(service) {
    super();
    this.service = service;
    this.pending = new Map();
    this.seq = 0;
    // Process groups the service reported as its own (each session worker); ended
    // after the service, also when the service itself was killed.
    this.ownedGroups = new Set();
  }

  start() {
    const child = spawn(this.service.executable, this.service.argv, {
      cwd: this.service.cwd, env: { ...process.env, ...this.service.env }, shell: false,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true
    });
    this.child = child;
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.exit = { code, signal };
      this.killGroups("SIGTERM");
      setTimeout(() => this.killGroups("SIGKILL"), 500);
      for (const { reject } of this.pending.values()) reject(new Error(`The Robot session service exited (${signal || code}).`));
      this.pending.clear();
      this.emit("closed", this.exit);
      resolve();
    }));
    const reader = new MessageReader(message => this.receive(message), "Robot session");
    child.stdout.on("data", chunk => {
      try { reader.accept(chunk); } catch (error) { this.emit("log", `${error.message}\n`); void this.stop(); }
    });
    child.stderr.on("data", chunk => this.emit("log", chunk.toString("utf8")));
    child.on("error", error => this.emit("log", `${error.message}\n`));
    child.stdin.on("error", () => { /* closing */ });
    return child.pid;
  }

  receive(message) {
    if (message?.type === "response") {
      const entry = this.pending.get(message.request_seq);
      if (!entry) return;
      this.pending.delete(message.request_seq);
      if (message.success) entry.resolve(message.body || {});
      else entry.reject(new Error(message.message || `${entry.command} failed.`));
      return;
    }
    if (message?.type !== "event") return;
    if (message.event === "process" && Number.isInteger(message.body?.systemProcessId)) this.ownedGroups.add(message.body.systemProcessId);
    this.emit("event", message);
  }

  request(command, args = {}) {
    if (!this.child || this.exit) return Promise.reject(new Error("The Robot session service is not running."));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, command });
      try { this.child.stdin.write(frame({ seq, type: "request", command, arguments: args })); }
      catch (error) { this.pending.delete(seq); reject(error); }
    });
  }

  // Shutdown ends the worker and the service; a service that does not end is
  // killed with its process group, then the worker groups it reported.
  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child || this.exit) return Promise.resolve();
    this.request("shutdown").catch(() => {});
    try { child.stdin.end(); } catch { /* closing */ }
    const term = setTimeout(() => this.killGroup(child.pid, "SIGTERM"), 4000);
    const kill = setTimeout(() => this.killGroup(child.pid, "SIGKILL"), 5000);
    this.stopPromise = this.closed.finally(() => { clearTimeout(term); clearTimeout(kill); });
    return this.stopPromise;
  }

  killGroup(pid, signal) {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else if (this.child && this.child.exitCode === null) this.child.kill(signal);
    } catch { /* gone */ }
  }

  killGroups(signal) {
    if (process.platform === "win32") return; // Windows: the service's job object ends its workers.
    for (const pid of this.ownedGroups) this.killGroup(pid, signal);
  }
}

// The session of one notebook or REPL.
class RobotSession {
  constructor(workspace, notebook, folder) {
    this.workspace = workspace;
    this.notebook = notebook;
    this.folder = folder;
    this.state = "not started";
    this.info = undefined;
    this.queue = Promise.resolve();
    this.waiting = new Set();
    this.order = 0;
    this.running = undefined;
    this.generation = 0;
  }

  label() {
    return this.info ? `Robot session ${this.info.sessionId}: ${this.state}` : `Robot session: ${this.state}`;
  }

  describe() {
    if (!this.info) return this.environment ? `Environment: ${this.environment}` : "";
    const info = this.info;
    return `Python ${info.python}, Robot Framework ${info.robot}; ${info.executable}; working directory ${info.cwd}` +
      (Object.keys(info.applied || {}).length ? `; Robot options ${Object.keys(info.applied).map(name => `--${name}`).join(" ")}` : "") +
      (info.ignored?.length ? `; ignored options ${info.ignored.map(name => `--${name}`).join(" ")}` : "");
  }

  setState(state) {
    this.state = state;
    this.workspace.changed(this);
  }

  // Starts the service and a Robot session when none runs; the lines it reports belong to `lines`.
  async ensure(lines) {
    if (this.process && this.info && this.state !== "ended") return;
    const generation = this.generation;
    if (!this.process) {
      const { service, environment } = await this.workspace.serviceFor(this.folder);
      if (generation !== this.generation) throw new Error("The Robot session was stopped.");
      this.environment = environment;
      const owned = new SessionProcess(service);
      owned.on("log", text => this.workspace.channel.append(`[${this.name()}] ${text}`));
      owned.on("event", message => this.event(message));
      owned.on("closed", ({ code, signal }) => {
        if (this.process !== owned) return;
        this.process = undefined;
        this.info = undefined;
        this.workspace.channel.appendLine(`[${this.name()}] Session service exited (${signal || code}).`);
        this.setState("not started");
      });
      this.process = owned;
      this.setState("starting");
      const pid = owned.start();
      this.workspace.channel.appendLine(`[${this.name()}] Started session service ${pid} in ${service.cwd}: ${service.executable} ${service.argv.join(" ")}`);
      await owned.request("initialize", { clientID: "robot-companion" });
    }
    this.setState("starting");
    const config = vscode.workspace.getConfiguration("robotCompanion", this.folder.uri);
    const args = config.get("robotArguments", []);
    this.info = await this.process.request("start", { args: Array.isArray(args) ? args.filter(arg => typeof arg === "string") : [] });
    this.order = 0;
    this.setState("idle");
    const info = this.info;
    this.workspace.channel.appendLine(`[${this.name()}] Started Robot session ${info.sessionId} in folder '${this.folder.name}': ${this.describe()}.`);
    lines.push(`Started Robot session ${info.sessionId} in folder '${this.folder.name}'`,
      `Python ${info.python}, Robot Framework ${info.robot}: ${info.executable}`, `Working directory: ${info.cwd}`,
      ...(Object.keys(info.applied || {}).length ? [`Robot options: ${Object.keys(info.applied).map(name => `--${name}`).join(" ")}`] : []),
      ...(info.ignored?.length ? [`Ignored Robot options: ${info.ignored.map(name => `--${name}`).join(" ")}`] : []),
      ...(info.warnings || []));
  }

  name() {
    return this.workspace.title(this.notebook);
  }

  event(message) {
    const body = message.body || {};
    if (message.event === "output") {
      const target = this.running && this.running.id === body.id ? this.running : undefined;
      if (target) target.output(body);
      else if (body.output) this.workspace.channel.append(`[${this.name()}] ${body.output}${body.category === "log" ? "\n" : ""}`);
    } else if (message.event === "sessionEnded") {
      if (this.info?.sessionId === body.sessionId) {
        this.info = undefined;
        this.setState("ended");
      }
      this.workspace.channel.appendLine(`[${this.name()}] Robot session ${body.sessionId} ended: ${body.reason}.`);
    }
  }

  // Runs cells one at a time, in order; each waits for the one before it.
  run(cells, controller) {
    const executions = cells.map(cell => {
      const execution = controller.createNotebookCellExecution(cell);
      this.waiting.add(execution);
      return execution;
    });
    for (const execution of executions) {
      this.queue = this.queue.then(() => this.execute(execution)).catch(error =>
        this.workspace.channel.appendLine(`[${this.name()}] ${error.message}`));
    }
    return this.queue;
  }

  async execute(execution) {
    if (!this.waiting.delete(execution)) return; // ended by Interrupt while it waited
    if (execution.token.isCancellationRequested) { execution.end(undefined); return; }
    execution.start(Date.now());
    await execution.clearOutput();
    const cell = new CellRun(execution);
    try {
      const lines = [];
      try {
        await this.ensure(lines);
      } finally {
        if (lines.length) cell.text(lines.join("\n"));
      }
      execution.executionOrder = ++this.order; // counts from 1 in each Robot session
      this.running = cell;
      this.setState("busy");
      const result = await this.process.request("execute", { id: cell.id, code: execution.cell.document.getText() });
      cell.finish(result);
      if (result.sessionEnded) this.setState("ended");
    } catch (error) {
      cell.error("Robot session", error.message);
      cell.success = false;
    } finally {
      if (this.running === cell) this.running = undefined;
      if (this.state === "busy") this.setState("idle");
      await cell.flush();
      execution.end(cell.success, Date.now());
    }
  }

  interrupt() {
    for (const execution of this.waiting) execution.end(undefined);
    this.waiting.clear();
    if (this.running && this.process) {
      this.workspace.channel.appendLine(`[${this.name()}] Interrupting the running cell.`);
      return this.process.request("interrupt", { id: this.running.id }).catch(() => ({}));
    }
    return Promise.resolve({ interrupted: false });
  }

  async restart() {
    this.interrupt();
    if (!this.process || !this.info) {
      this.workspace.channel.appendLine(`[${this.name()}] No Robot session runs; the next cell starts one.`);
      return false;
    }
    this.setState("restarting");
    this.info = await this.process.request("restart");
    this.order = 0;
    this.setState("idle");
    this.workspace.channel.appendLine(`[${this.name()}] Restarted: Robot session ${this.info.sessionId}; ${this.describe()}.`);
    return true;
  }

  variables() {
    if (!this.process || !this.info) return Promise.reject(new Error("No Robot session runs for this notebook."));
    return this.process.request("variables").then(body => body.variables || []);
  }

  // Ends the session and its processes; the next cell starts a new one.
  stop(reason) {
    this.generation++;
    this.interrupt();
    const owned = this.process;
    this.process = undefined;
    this.info = undefined;
    if (reason) this.workspace.channel.appendLine(`[${this.name()}] ${reason}`);
    this.setState("not started");
    return owned ? owned.stop() : Promise.resolve();
  }
}

// The outputs of one cell execution: streamed text, then values or the failure.
class CellRun {
  constructor(execution) {
    this.execution = execution;
    this.id = `${execution.cell.document.uri.toString()}#${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.success = undefined;
    this.chain = Promise.resolve();
    this.stream = undefined;
  }

  // Streamed text joins the current output while its MIME (stdout or stderr) stays the same.
  // A change of stream starts a new output: VS Code renders one MIME per output, so mixing
  // both in one output would hide one of them. Outputs follow emission order.
  append(item) {
    this.chain = this.chain.then(async () => {
      if (!this.stream || this.stream.mime !== item.mime) {
        this.stream = { mime: item.mime, output: new vscode.NotebookCellOutput([item]) };
        await this.execution.appendOutput(this.stream.output);
      } else {
        await this.execution.appendOutputItems([item], this.stream.output);
      }
    }).catch(() => {});
  }

  output(body) {
    const text = String(body.output ?? "");
    if (body.category === "log") {
      if (body.level === "FAIL") return; // the cell's failure is shown as its error
      const line = body.level === "INFO" ? text : `[ ${body.level} ] ${text}`;
      this.append(["WARN", "ERROR"].includes(body.level) ? vscode.NotebookCellOutputItem.stderr(`${line}\n`) :
        vscode.NotebookCellOutputItem.stdout(`${line}\n`));
    } else {
      this.append(body.category === "stderr" ? vscode.NotebookCellOutputItem.stderr(text) : vscode.NotebookCellOutputItem.stdout(text));
    }
  }

  // A value or error output of its own; streamed text after it starts a new output below it.
  appendOwn(item) {
    this.chain = this.chain.then(() => {
      this.stream = undefined;
      return this.execution.appendOutput(new vscode.NotebookCellOutput([item]));
    }).catch(() => {});
  }

  text(value) {
    this.appendOwn(vscode.NotebookCellOutputItem.text(value, "text/plain"));
  }

  error(name, message) {
    this.appendOwn(vscode.NotebookCellOutputItem.error({ name, message }));
  }

  finish(result) {
    // A returned value is echoed; Robot Framework logs assignments itself (`${x} = value`).
    const values = (result.values || []).filter(value => !value.label || ["keywords", "variables"].includes(value.type))
      .map(value => value.type === "keywords" ? `Defined keywords: ${value.value}` :
        value.type === "variables" ? `Set variables: ${value.value}` : value.value);
    if (values.length) this.text(values.join("\n"));
    if (result.status === "PASS") this.success = true;
    else if (result.status === "SKIP") this.text(`SKIP: ${result.message}`);
    else {
      this.success = false;
      this.error(result.status === "INTERRUPTED" ? "Interrupted" : "FAIL", result.status === "INTERRUPTED" && !result.sessionEnded ?
        "The cell was interrupted. The Robot session and its variables are kept." : result.message || result.status);
    }
  }

  flush() {
    return this.chain;
  }
}

class InteractiveWorkspace {
  constructor(environments) {
    this.environments = environments;
    this.sessions = new Map();
    this.folders = new Map(); // REPL and untitled notebook URI -> workspace folder
    this.channel = vscode.window.createOutputChannel("Robot Companion Sessions");
    this.status = vscode.window.createStatusBarItem("robotCompanion.session", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Robot session";
    this.status.command = "robotCompanion.showSessionVariables";
    this.notebookController = this.controller(NOTEBOOK_CONTROLLER, NOTEBOOK_TYPE, "Robot Companion");
    this.replController = this.controller(REPL_CONTROLLER, "interactive", "Robot Companion REPL");
    this.subscriptions = [
      vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new NotebookSerializer(), { transientOutputs: true }),
      this.notebookController, this.replController, this.status, this.channel,
      vscode.workspace.onDidCloseNotebookDocument(notebook => this.close(notebook)),
      // VS Code may keep a notebook document open after its last editor tab closed (another
      // consumer still holds it): the session ends with the last tab that shows it.
      vscode.window.tabGroups.onDidChangeTabs(() => this.closeUnshown()),
      vscode.window.onDidChangeActiveNotebookEditor(() => this.updateStatus()),
      vscode.workspace.onDidChangeConfiguration(event => {
        for (const session of this.sessions.values()) {
          if (["integrationMode", "executionBackend", "nativeBackendExecutable", "robotArguments"]
            .some(name => event.affectsConfiguration(`robotCompanion.${name}`, session.folder.uri)) && session.process) {
            void session.stop(`Robot Companion settings for folder '${session.folder.name}' changed; the session ended. The next cell starts a new one.`);
          }
        }
      }),
      // Another interpreter for a folder: its sessions end; the next cell uses the new one.
      environments.onDidChange(folders => {
        for (const session of this.sessions.values()) {
          if (folders.has(session.folder.uri.toString()) && session.process) {
            void session.stop(`The Robot environment of folder '${session.folder.name}' changed; the session ended. The next cell starts one with the new environment.`);
          }
        }
      }),
      vscode.commands.registerCommand("robotCompanion.newRobotNotebook", () => this.newNotebook()),
      vscode.commands.registerCommand("robotCompanion.openRobotRepl", () => this.openRepl()),
      vscode.commands.registerCommand("robotCompanion.restartSession", target => this.withSession(target, session => session.restart())),
      vscode.commands.registerCommand("robotCompanion.stopSession", target => this.withSession(target, session =>
        session.stop("The Robot session was stopped; the next cell starts a new one."))),
      vscode.commands.registerCommand("robotCompanion.interruptSession", target => this.withSession(target, session => session.interrupt())),
      vscode.commands.registerCommand("robotCompanion.showSessionVariables", target => this.withSession(target, session => this.showVariables(session)))
    ];
    for (const notebook of vscode.workspace.notebookDocuments) this.prefer(notebook);
    this.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(notebook => this.prefer(notebook)));
    this.updateStatus();
  }

  controller(id, type, label) {
    const controller = vscode.notebooks.createNotebookController(id, type, label);
    controller.supportedLanguages = [LANGUAGE];
    controller.supportsExecutionOrder = true;
    controller.description = "Robot Framework keywords in the folder's Robot environment";
    controller.executeHandler = (cells, notebook) => this.execute(cells, notebook, controller);
    controller.interruptHandler = notebook => { void this.sessions.get(notebook.uri.toString())?.interrupt(); };
    return controller;
  }

  prefer(notebook) {
    if (notebook.notebookType === NOTEBOOK_TYPE) {
      this.notebookController.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    }
  }

  title(notebook) {
    const folder = this.folderOf(notebook);
    if (notebook.notebookType === "interactive") return `Robot REPL${folder ? ` (${folder.name})` : ""}`;
    return vscode.workspace.asRelativePath(notebook.uri, false);
  }

  folderOf(notebook) {
    return this.folders.get(notebook.uri.toString()) || vscode.workspace.getWorkspaceFolder(notebook.uri);
  }

  // The folder's interactive service: trust, owned mode, its selected Robot environment, an interactive service.
  async serviceFor(folder) {
    if (!vscode.workspace.isTrusted) throw new Error(TRUST_REFUSAL);
    if (!folder || folder.uri.scheme !== "file") throw new Error("Robot sessions need a workspace folder on this host. Open the notebook inside a workspace folder.");
    if (integrationMode(folder) !== "owned") throw new Error(MODE_REFUSAL);
    const environment = await this.environments.backend(folder, "executionBackend");
    if (!vscode.workspace.isTrusted) throw new Error(TRUST_REFUSAL);
    if (integrationMode(folder) !== "owned") throw new Error(MODE_REFUSAL);
    if (environment.refusal) {
      this.environments.notify(folder, environment.refusal);
      throw new Error(environment.refusal);
    }
    const descriptor = validateDescriptor(environment.input);
    if (descriptor.workspaceUri !== folder.uri.toString()) throw new Error("executionBackend.workspaceUri must match this workspace folder URI.");
    if (!descriptor.services.interactive) {
      throw new Error(`Backend '${descriptor.id}' ${descriptor.version} for folder '${folder.name}' does not provide Robot sessions; ` +
        "they need the native backend (robotCompanion.executionBackend unset).");
    }
    return { service: requireService(descriptor, "interactive", vscode.workspace.isTrusted), environment: environment.full };
  }

  async execute(cells, notebook, controller) {
    const folder = this.folderOf(notebook);
    if (!vscode.workspace.isTrusted || !folder) {
      // Nothing starts: each cell reports why.
      for (const cell of cells) {
        const execution = controller.createNotebookCellExecution(cell);
        execution.start(Date.now());
        await execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name: "Robot session",
          message: !vscode.workspace.isTrusted ? TRUST_REFUSAL : "Robot sessions need a workspace folder. Open the notebook inside a workspace folder." })]));
        execution.end(false, Date.now());
      }
      return;
    }
    return this.session(notebook, folder).run(cells, controller);
  }

  session(notebook, folder = this.folderOf(notebook)) {
    const key = notebook.uri.toString();
    if (!this.sessions.has(key)) this.sessions.set(key, new RobotSession(this, notebook, folder));
    return this.sessions.get(key);
  }

  // The session of the given or active notebook/REPL editor.
  activeNotebook(target) {
    if (target?.notebookEditor?.notebookUri) return vscode.workspace.notebookDocuments.find(notebook => notebook.uri.toString() === target.notebookEditor.notebookUri.toString());
    if (target?.uri && target.notebookType) return target;
    return vscode.window.activeNotebookEditor?.notebook;
  }

  async withSession(target, action) {
    const notebook = this.activeNotebook(target);
    const session = notebook && this.sessions.get(notebook.uri.toString());
    if (!session) {
      void vscode.window.showInformationMessage("No Robot session runs for the active notebook or REPL. Run a cell to start one.");
      return undefined;
    }
    try { return await action(session); }
    catch (error) { void vscode.window.showErrorMessage(`Robot session: ${error.message}`); return undefined; }
  }

  async showVariables(session) {
    const variables = await session.variables();
    const item = variable => ({ label: variable.name, description: variable.value, detail: variable.type });
    const cells = variables.filter(variable => variable.origin === "cells"), started = variables.filter(variable => variable.origin !== "cells");
    const picked = await vscode.window.showQuickPick([
      { label: "Set in cells", kind: vscode.QuickPickItemKind.Separator }, ...cells.map(item),
      { label: "Session and built-in", kind: vscode.QuickPickItemKind.Separator }, ...started.map(item)
    ], { title: `${session.label()} — variables`, placeHolder: `${cells.length} set in cells, ${started.length} from the session; select one to copy its value`, matchOnDescription: true });
    if (picked && !picked.kind) await vscode.env.clipboard.writeText(picked.description || "");
    return variables;
  }

  async pickFolder() {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active && vscode.workspace.getWorkspaceFolder(active);
    if (folder) return folder;
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length <= 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: "Folder whose Robot environment runs the session" });
  }

  async newNotebook() {
    const folder = await this.pickFolder();
    const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "Log    Hello from Robot Framework", LANGUAGE)]);
    const notebook = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
    if (folder) this.folders.set(notebook.uri.toString(), folder);
    await vscode.window.showNotebookDocument(notebook);
    return notebook;
  }

  async openRepl() {
    const folder = await this.pickFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Robot Companion: open a workspace folder to start a Robot REPL.");
      return undefined;
    }
    const opened = await vscode.commands.executeCommand("interactive.open", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      undefined, `${EXTENSION_ID}/${REPL_CONTROLLER}`, `Robot REPL: ${folder.name}`);
    const uri = opened?.notebookUri;
    if (uri) {
      this.folders.set(uri.toString(), folder);
      const notebook = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === uri.toString());
      if (notebook) this.replController.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
      this.updateStatus();
    }
    return opened;
  }

  closeUnshown() {
    const shown = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input)
      .filter(input => input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputInteractiveWindow)
      .map(input => input.uri.toString()));
    for (const session of [...this.sessions.values()]) {
      if (!shown.has(session.notebook.uri.toString())) this.close(session.notebook);
    }
  }

  close(notebook) {
    const key = notebook.uri.toString();
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    this.folders.delete(key);
    if (session) void session.stop(`${this.title(notebook)} closed; its Robot session ended.`);
    this.updateStatus();
  }

  changed() {
    this.updateStatus();
  }

  updateStatus() {
    if (this.disposePromise) return;
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (!notebook || (notebook.notebookType !== NOTEBOOK_TYPE && !this.folders.has(notebook.uri.toString()))) {
      this.status.hide();
      return;
    }
    const session = this.sessions.get(notebook.uri.toString());
    const icon = { busy: "$(sync~spin)", starting: "$(loading~spin)", restarting: "$(loading~spin)", ended: "$(debug-disconnect)" }[session?.state] || "$(symbol-event)";
    this.status.text = `${icon} ${session ? session.label() : "Robot session: not started"}`;
    this.status.tooltip = session?.describe() || "Run a cell to start a Robot session in the folder's Robot environment.";
    this.status.show();
  }

  // Ends every session and its processes (also on deactivation).
  dispose() {
    if (this.disposePromise) return this.disposePromise;
    const stopping = [...this.sessions.values()].map(session => session.stop());
    this.sessions.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.disposePromise = Promise.all(stopping);
    return this.disposePromise;
  }
}

module.exports = { InteractiveWorkspace, NotebookSerializer, SessionProcess, NOTEBOOK_TYPE, NOTEBOOK_CONTROLLER, REPL_CONTROLLER };

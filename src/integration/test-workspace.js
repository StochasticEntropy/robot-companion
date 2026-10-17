"use strict";

const vscode = require("vscode");
const { validateDescriptor } = require("./backend-contract");
const { LspSession } = require("./lsp-session");
const { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery } = require("./test-discovery");

const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);

// Native Test Explorer discovery over the optional `discovery` service of
// robotCompanion.executionBackend. The controller exists only while an owned,
// trusted folder has a discovery service, so coexistence never adds a second
// test controller and a missing service leaves navigation and debug untouched.
class TestWorkspace {
  constructor() {
    this.roots = new Map();
    this.generation = 0;
    this.disposed = false;
    this.queue = Promise.resolve();
    this.channel = vscode.window.createOutputChannel("Robot Companion Tests");
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("robotCompanion.integrationMode") ||
            event.affectsConfiguration("robotCompanion.executionBackend")) void this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(document => {
        const folder = isRobotPath(document.uri) && vscode.workspace.getWorkspaceFolder(document.uri);
        const root = folder && this.roots.get(folder.uri.toString());
        if (root?.session?.state === "running") void this.discover(root);
      })
    ];
    void this.refresh();
  }

  refresh() {
    const generation = ++this.generation;
    for (const root of this.roots.values()) void root.session?.stop();
    this.queue = this.queue.then(async () => {
      await this.stopRoots();
      if (this.disposed || !vscode.workspace.isTrusted || generation !== this.generation) return;
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (this.disposed || generation !== this.generation) break;
        const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
        if (folder.uri.scheme !== "file" || config.get("integrationMode", "coexistence") !== "owned") continue;
        // Read executable configuration only after checking trust and mode.
        const input = config.get("executionBackend");
        if (!input?.services?.discovery) continue; // Optional: no discovery, no controller.
        const root = { folder, generation, itemIds: [] };
        this.roots.set(folder.uri.toString(), root);
        try {
          const descriptor = validateDescriptor(input);
          if (descriptor.workspaceUri !== folder.uri.toString()) {
            throw new Error("executionBackend.workspaceUri must match this workspace folder URI.");
          }
          root.session = new LspSession({ service: "discovery" });
          root.session.on("log", text => this.channel.append(`[${folder.name}] ${text}`));
          root.session.on("failure", error => this.failed(root, error));
          const capabilities = await root.session.start(descriptor, vscode.workspace.isTrusted && !this.disposed);
          if (capabilities.robotCompanionDiscovery?.version !== DISCOVERY_VERSION) {
            throw new Error(`Backend '${descriptor.id}' does not advertise discovery API v${DISCOVERY_VERSION}.`);
          }
          await this.discover(root);
        } catch (error) {
          this.failed(root, error);
          await root.session?.stop();
        }
      }
      if (!this.roots.size) this.disposeController();
    }).catch(error => this.channel.appendLine(`Test discovery lifecycle failed: ${error.message}`));
    return this.queue;
  }

  current(root) {
    return !this.disposed && root.generation === this.generation && this.roots.get(root.folder.uri.toString()) === root;
  }

  controllerFor() {
    if (!this.controller) {
      this.controller = vscode.tests.createTestController("robotCompanion", "Robot Companion");
      this.controller.refreshHandler = () => this.refresh();
      this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run,
        (request, token) => this.run(request, token), true);
    }
    return this.controller;
  }

  // Runs reuse the CodeLens runner (robotCommand, its own output folder per
  // run), one test at a time. Status comes from that run's outcome; per-test
  // results from Robot output are not parsed yet.
  async run(request, token) {
    const controller = this.controller;
    const run = controller.createTestRun(request);
    const queue = [];
    const add = item => {
      if (request.exclude?.includes(item) || item.error) return;
      if (item.children.size) item.children.forEach(add);
      else if (item.uri) queue.push(item);
    };
    if (request.include) request.include.forEach(add); else controller.items.forEach(add);
    for (const item of queue) run.enqueued(item);
    this.lastRun = [];
    try {
      for (const item of queue) {
        if (token.isCancellationRequested) { run.skipped(item); continue; }
        run.started(item);
        const started = Date.now();
        const result = await vscode.commands.executeCommand("robotCompanion.runTest", item.uri, item.label);
        const duration = Date.now() - started;
        run.appendOutput(`${item.label}: ${result?.message || result?.status || "not run"}\r\n`, undefined, item);
        if (result?.status === "completed" && result.outcome === "passed") run.passed(item, duration);
        else if (result?.status === "completed" && result.outcome === "failed") {
          run.failed(item, new vscode.TestMessage(result.message), duration);
        } else run.errored(item, new vscode.TestMessage(result?.message || `Run not completed: ${result?.status}`), duration);
        this.lastRun.push({ id: item.id, status: result?.status, outcome: result?.outcome, outputDir: result?.outputDir });
      }
    } finally {
      run.end();
    }
  }

  async discover(root) {
    const workspaceUri = root.folder.uri.toString();
    const tree = normalizeDiscovery(await root.session.request(DISCOVERY_METHOD, { workspaceUri }), workspaceUri);
    if (!this.current(root)) return;
    const controller = this.controllerFor();
    for (const id of root.itemIds.splice(0)) controller.items.delete(id);
    for (const suite of tree) {
      const item = controller.createTestItem(suite.id, suite.label, vscode.Uri.parse(suite.uri));
      item.range = toRange(suite.range);
      item.children.replace(suite.children.map(test => {
        const child = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
        child.range = toRange(test.range);
        return child;
      }));
      controller.items.add(item);
      root.itemIds.push(item.id);
    }
    this.channel.appendLine(`[${root.folder.name}] Discovered ${tree.reduce((count, suite) => count + suite.children.length, 0)} tests ` +
      `in ${tree.length} suites.`);
  }

  // Failures stay visible in Test Explorer as an error item, not only in output.
  failed(root, error) {
    if (!this.current(root)) return;
    this.channel.appendLine(`[${root.folder.name}] Discovery unavailable: ${error.message}`);
    const controller = this.controllerFor();
    for (const id of root.itemIds.splice(0)) controller.items.delete(id);
    const item = controller.createTestItem(`discovery-error:${root.folder.uri}`, `${root.folder.name}: discovery unavailable`);
    item.error = error.message;
    controller.items.add(item);
    root.itemIds.push(item.id);
  }

  async stopRoots() {
    const roots = [...this.roots.values()];
    this.roots.clear();
    for (const root of roots) {
      for (const id of root.itemIds.splice(0)) this.controller?.items.delete(id);
      await root.session?.stop();
    }
  }

  disposeController() {
    this.controller?.dispose();
    this.controller = undefined;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const root of this.roots.values()) void root.session?.stop();
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = this.queue.then(() => this.stopRoots()).finally(() => {
      this.disposeController();
      this.channel.dispose();
    });
    return this.disposePromise;
  }
}

function toRange(range) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

module.exports = { TestWorkspace };

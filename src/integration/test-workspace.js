"use strict";

const vscode = require("vscode");
const crypto = require("node:crypto");
const path = require("node:path");
const { validateDescriptor, ExecutionContexts } = require("./backend-contract");
const { LspSession } = require("./lsp-session");
const { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery } = require("./test-discovery");
const { isRobotCode, RobotCodeDiscovery } = require("./robotcode-bridge");
const { planSuiteRuns, testFilters, robotArguments, readRunResults, RobotProcess, createRunDirectory } = require("./test-runs");
const { interpretRobotRunExit } = require("../features/run/runner-core");
const { DEBUG_TYPE } = require("./debug-workspace");

const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);

// Native Test Explorer discovery over the optional `discovery` service of
// robotCompanion.executionBackend. The controller exists only while an owned,
// trusted folder has a discovery service, so coexistence never adds a second
// test controller and a missing service leaves navigation and debug untouched.
class TestWorkspace {
  constructor(extensionContext, debugWorkspace) {
    this.storagePath = (extensionContext?.storageUri || extensionContext?.globalStorageUri)?.fsPath;
    this.debugWorkspace = debugWorkspace;
    this.contexts = new ExecutionContexts();
    // Robot processes of running Test Explorer runs, for Stop and deactivation.
    this.active = new Set();
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
          root.debug = Boolean(descriptor.services.debug);
          root.session = isRobotCode(descriptor) ? new RobotCodeDiscovery() : new LspSession({ service: "discovery" });
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
      else this.updateDebugProfile();
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

  // Debug Test is offered only while a discovered folder's backend also has
  // a debug service; it uses the owned robotcompanion debug type.
  updateDebugProfile() {
    const debuggable = this.debugWorkspace && [...this.roots.values()].some(root => root.debug);
    if (debuggable && this.controller && !this.debugProfile) {
      this.debugProfile = this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug,
        (request, token) => this.run(request, token, true), true);
    } else if (!debuggable && this.debugProfile) {
      this.debugProfile.dispose();
      this.debugProfile = undefined;
    }
  }

  // The selected tests, grouped into one Robot run per suite file. A suite
  // selected without exclusions runs whole; otherwise each selected test name
  // becomes a --test filter. Discovery error items are never run.
  selections(request) {
    const selections = [];
    const excluded = item => request.exclude?.includes(item);
    const leaves = item => item.children.size ? [...childrenOf(item)].filter(child => !excluded(child)) : [item];
    const add = item => {
      if (excluded(item) || item.error || !item.uri) return;
      const tests = leaves(item).filter(test => test.uri && !test.error);
      if (!tests.length) return;
      selections.push({ suitePath: item.uri.fsPath, whole: item.children.size > 0 && tests.length === item.children.size,
        tests: tests.map(test => ({ id: test.id, name: test.label, occurrence: occurrenceOf(test.id), item: test })) });
    };
    if (request.include) request.include.forEach(add); else this.controller.items.forEach(add);
    return planSuiteRuns(selections);
  }

  // Each suite run's results come only from its own output.xml; tests without
  // an entry there get the run's exit outcome as an error. A Stop ends the
  // running Robot process group and marks every test whose run had not
  // finished as Skipped.
  async run(request, token, debug = false) {
    const run = this.controller.createTestRun(request);
    const plan = this.selections(request);
    this.lastRun = [];
    for (const suite of plan) for (const test of suite.tests) run.enqueued(test.item);
    try {
      for (const suite of plan) {
        if (token.isCancellationRequested) { this.skipAll(run, suite, "Run stopped before this test started."); continue; }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(suite.suitePath));
        for (const test of suite.tests) run.started(test.item);
        const started = Date.now();
        let outcome;
        try {
          outcome = debug ? await this.debugSuite(run, suite, folder, token) : await this.runSuite(run, suite, folder, token);
        } catch (error) {
          outcome = { error: error.message || String(error) };
        }
        this.report(run, suite, outcome, Date.now() - started, token);
      }
    } finally {
      run.end();
    }
  }

  async runSuite(run, suite, folder, token) {
    if (!vscode.workspace.isTrusted) throw new Error("Running Robot tests requires a trusted workspace.");
    if (!folder || !this.storagePath) throw new Error("Robot Companion needs a workspace folder on this host to run tests.");
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const context = this.contexts.forRoot(folder.uri.toString(), {
      robotCommand: config.get("robotCommand", "robot"), robotArguments: config.get("robotArguments", [])
    }, vscode.workspace.isTrusted);
    const outputDir = createRunDirectory(path.join(this.storagePath, "test-runs"));
    const args = [...context.robot.argv, ...robotArguments({ robotArguments: context.robotArguments, outputDir,
      testNames: suite.testNames, suitePath: suite.suitePath })];
    const robot = new RobotProcess({ executable: context.robot.executable, args, cwd: context.cwd,
      onOutput: text => run.appendOutput(text.replace(/\r?\n/g, "\r\n")) });
    run.appendOutput(`$ ${[context.robot.executable, ...args].join(" ")}\r\n`);
    this.active.add(robot);
    const stop = token.onCancellationRequested(() => { void robot.cancel(); });
    try {
      const exit = await robot.start();
      return { exit, outputDir, processGroup: robot.pid, cancelled: robot.cancelled, executable: context.robot.executable, args };
    } finally {
      stop.dispose();
      this.active.delete(robot);
    }
  }

  // Debug Test: one owned robotcompanion launch session per suite file, limited
  // to the selected tests, linked to this test run. Its result comes from the
  // session's own output folder once the session has ended.
  async debugSuite(run, suite, folder, token) {
    if (!folder) throw new Error("Robot Companion needs a workspace folder on this host to debug tests.");
    const handoff = crypto.randomUUID();
    const config = { type: DEBUG_TYPE, request: "launch", name: `Debug Test: ${suite.tests.map(test => test.name).join(", ")}`,
      target: suite.suitePath, args: testFilters(suite.testNames), robotCompanionTestRun: handoff };
    let session, resolveEnded;
    const ended = new Promise(resolve => { resolveEnded = resolve; });
    const listeners = [
      vscode.debug.onDidStartDebugSession(candidate => {
        if (candidate.configuration.robotCompanionTestRun === handoff) session = candidate;
      }),
      this.debugWorkspace.onDidFinishRun(result => {
        if (result.session.configuration.robotCompanionTestRun === handoff) resolveEnded(result);
      }),
      // A session that never reached the owned adapter ends without a result.
      vscode.debug.onDidTerminateDebugSession(candidate => {
        if (candidate.configuration.robotCompanionTestRun === handoff) setTimeout(() => resolveEnded(undefined), 10000);
      }),
      token.onCancellationRequested(() => { if (session) void vscode.debug.stopDebugging(session); })
    ];
    try {
      if (!await vscode.debug.startDebugging(folder, config, { testRun: run })) {
        throw new Error("The Robot Companion debug session did not start. See the Robot Companion Debug output.");
      }
      const result = await ended;
      if (!result) throw new Error("The Robot Companion debug session ended without a Robot result.");
      return { exit: { exitCode: result.exitCode }, outputDir: result.outputDir, processGroup: result.processGroup,
        cancelled: token.isCancellationRequested, executable: DEBUG_TYPE, args: config.args };
    } finally {
      for (const listener of listeners) listener.dispose();
    }
  }

  report(run, suite, outcome, duration, token) {
    const { exit, outputDir, cancelled } = outcome;
    if (outcome.error) {
      for (const test of suite.tests) run.errored(test.item, new vscode.TestMessage(outcome.error));
      this.record(suite, outcome, undefined);
      return;
    }
    if (cancelled || token.isCancellationRequested) {
      this.skipAll(run, suite, "Run stopped: Robot Companion ended this test's Robot process group before it finished.");
      this.record(suite, outcome, undefined, "cancelled");
      return;
    }
    const results = outputDir ? readRunResults(outputDir, suite.suitePath, suite.tests) : new Map();
    const fallback = interpretRobotRunExit({ ...exit, producedResults: results.size > 0,
      target: { testName: suite.tests.length === 1 ? suite.tests[0].name : undefined, suiteLabel: path.basename(suite.suitePath) },
      commandText: outcome.executable });
    for (const test of suite.tests) {
      const own = results.get(test.id);
      const item = test.item;
      const time = own?.elapsed !== undefined ? Math.round(own.elapsed * 1000) : duration;
      if (own?.status === "PASS") run.passed(item, time);
      else if (own?.status === "FAIL") run.failed(item, this.message(item, own.message || "Test failed."), time);
      else if (own?.status === "SKIP") run.skipped(item);
      else if (own) run.errored(item, this.message(item, `Unknown Robot status '${own.status}'.`), time);
      // The exit outcome decides only when the run reported no test at all.
      else if (!results.size && fallback.outcome === "passed") run.passed(item, duration);
      else if (!results.size && fallback.outcome === "failed") run.failed(item, this.message(item, fallback.message), duration);
      else run.errored(item, this.message(item, `Robot did not report this test. ${fallback.message}`), duration);
      this.lastRun.push({ id: item.id, status: "completed", outcome: fallback.outcome, outputDir, processGroup: outcome.processGroup,
        args: outcome.args,
        robotStatus: own?.status, message: own?.message, source: own ? "output.xml" : "exit outcome" });
    }
  }

  record(suite, outcome, robotStatus, status = "error") {
    for (const test of suite.tests) this.lastRun.push({ id: test.id, status, outputDir: outcome.outputDir,
      processGroup: outcome.processGroup, robotStatus, message: outcome.error, source: "none" });
  }

  skipAll(run, suite, text) {
    run.appendOutput(`${text}\r\n`);
    for (const test of suite.tests) run.skipped(test.item);
  }

  // A failure message is anchored at the test's source location.
  message(item, text) {
    const message = new vscode.TestMessage(text);
    if (item.uri && item.range) message.location = new vscode.Location(item.uri, item.range);
    return message;
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
    this.debugProfile = undefined;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const robot of this.active) void robot.cancel(500);
    for (const root of this.roots.values()) void root.session?.stop();
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = this.queue.then(() => this.stopRoots()).finally(() => {
      this.disposeController();
      this.channel.dispose();
    });
    return this.disposePromise;
  }
}

function childrenOf(item) {
  const children = [];
  item.children.forEach(child => children.push(child));
  return children;
}

// Discovery IDs end in `#n` for the n-th test with a repeated name.
function occurrenceOf(id) {
  const match = /#(\d+)$/.exec(id);
  return match ? Number(match[1]) : 1;
}

function toRange(range) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

module.exports = { TestWorkspace };

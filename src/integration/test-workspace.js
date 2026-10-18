"use strict";

const vscode = require("vscode");
const crypto = require("node:crypto");
const path = require("node:path");
const { validateDescriptor, ExecutionContexts } = require("./backend-contract");
const { LspSession } = require("./lsp-session");
const { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery } = require("./test-discovery");
const { isRobotCode, RobotCodeDiscovery } = require("./robotcode-bridge");
const { planSuiteRuns, testFilters, robotArguments, stoppedBySignal, readRunResults, RobotProcess, createRunDirectory } =
  require("./test-runs");
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
    // The n-th test with a repeated name in its suite, as discovered.
    this.occurrences = new WeakMap();
    // Debug Test sessions a Stop has already been sent to.
    this.stopping = new WeakSet();
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
        tests: tests.map(test => ({ id: test.id, name: test.label, occurrence: this.occurrences.get(test) || 1, item: test })) });
    };
    if (request.include) request.include.forEach(add); else this.controller.items.forEach(add);
    return planSuiteRuns(selections);
  }

  // Each suite run's results come only from its own output.xml; a test without
  // an entry there is errored with the run's exit outcome. A Stop ends the
  // running Robot process group; tests that Robot had finished keep their
  // result and every other test of the stopped run is marked Skipped.
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
    const outputDir = createRunDirectory(path.join(this.storagePath, "test-runs"), 40,
      new Set([...this.active].map(active => active.outputDir)));
    const args = [...context.robot.argv, ...robotArguments({ robotArguments: context.robotArguments, outputDir,
      testNames: suite.testNames, suitePath: suite.suitePath })];
    const robot = new RobotProcess({ executable: context.robot.executable, args, cwd: context.cwd,
      onOutput: text => run.appendOutput(text.replace(/\r?\n/g, "\r\n")) });
    robot.outputDir = outputDir;
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
        if (candidate.configuration.robotCompanionTestRun !== handoff) return;
        session = candidate;
        if (token.isCancellationRequested) this.stopDebugSession(session); // Stopped while starting.
      }),
      this.debugWorkspace.onDidFinishRun(result => {
        if (result.session.configuration.robotCompanionTestRun === handoff) resolveEnded(result);
      }),
      // A session that never reached the owned adapter ends without a result.
      vscode.debug.onDidTerminateDebugSession(candidate => {
        if (candidate.configuration.robotCompanionTestRun === handoff) setTimeout(() => resolveEnded(undefined), 10000);
      }),
      token.onCancellationRequested(() => { if (session) this.stopDebugSession(session); })
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

  // Stop asks VS Code to end the session; if it is still running after the
  // grace period, the owned adapter's processes are ended directly.
  stopDebugSession(session) {
    if (this.stopping.has(session)) return;
    this.stopping.add(session);
    void Promise.resolve(vscode.debug.stopDebugging(session)).catch(() => undefined);
    setTimeout(() => { void this.debugWorkspace.forceStop(session.id); }, 3000);
  }

  report(run, suite, outcome, duration, token) {
    const { exit, outputDir } = outcome;
    if (outcome.error && token.isCancellationRequested) { // E.g. a Debug Test session stopped before its result.
      this.skipAll(run, suite, `Run stopped: ${outcome.error}`);
      return;
    }
    if (outcome.error) {
      for (const test of suite.tests) run.errored(test.item, new vscode.TestMessage(outcome.error));
      this.record(suite, outcome, undefined);
      return;
    }
    const stopped = outcome.cancelled || token.isCancellationRequested;
    const results = outputDir ? readRunResults(outputDir, suite.suitePath, suite.tests) : new Map();
    const fallback = interpretRobotRunExit({ ...exit, producedResults: results.size > 0,
      target: { testName: suite.tests.length === 1 ? suite.tests[0].name : undefined, suiteLabel: path.basename(suite.suitePath) },
      commandText: outcome.executable });
    if (stopped) run.appendOutput("Run stopped: Robot Companion ended this Robot run's process group.\r\n");
    for (const test of suite.tests) {
      const item = test.item;
      const own = results.get(test.id);
      if (stopped && (!own || stoppedBySignal(own))) {
        run.skipped(item);
        this.lastRun.push({ id: item.id, status: "cancelled", outputDir, processGroup: outcome.processGroup, args: outcome.args,
          source: "none" });
        continue;
      }
      const time = own?.elapsed !== undefined ? Math.round(own.elapsed * 1000) : duration;
      if (own?.status === "PASS") run.passed(item, time);
      else if (own?.status === "FAIL") run.failed(item, this.message(item, own.message || "Test failed."), time);
      else if (own?.status === "SKIP") run.skipped(item);
      else if (own) run.errored(item, this.message(item, `Unknown Robot status '${own.status}'.`), time);
      else run.errored(item, this.message(item, `Robot did not report this test in this run's output.xml. ${fallback.message}`));
      this.lastRun.push({ id: item.id, status: "completed", outcome: fallback.outcome, outputDir, processGroup: outcome.processGroup,
        args: outcome.args, robotStatus: own?.status, message: own?.message, source: own ? "output.xml" : "exit outcome" });
    }
  }

  record(suite, outcome, robotStatus, status = "error") {
    for (const test of suite.tests) this.lastRun.push({ id: test.id, status, outputDir: outcome.outputDir,
      processGroup: outcome.processGroup, robotStatus, message: outcome.error, source: "none" });
  }

  skipAll(run, suite, text) {
    for (const test of suite.tests) this.lastRun.push({ id: test.id, status: "cancelled", source: "none" });
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
      const seen = new Map();
      item.children.replace(suite.children.map(test => {
        const child = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
        child.range = toRange(test.range);
        seen.set(test.label, (seen.get(test.label) || 0) + 1);
        this.occurrences.set(child, seen.get(test.label));
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
    const stopping = Promise.all([...this.active].map(robot => robot.cancel(500)));
    for (const root of this.roots.values()) void root.session?.stop();
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = Promise.all([stopping, this.queue.then(() => this.stopRoots())]).finally(() => {
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

function toRange(range) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

module.exports = { TestWorkspace };

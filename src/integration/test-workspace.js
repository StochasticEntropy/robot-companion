"use strict";

const vscode = require("vscode");
const { backendDescriptor } = require("./preview-defaults");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateDescriptor, ExecutionContexts } = require("./backend-contract");
const { LspSession } = require("./lsp-session");
const { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery, normalizeDiscoveryErrors } = require("./test-discovery");
const { isRobotCode, RobotCodeDiscovery } = require("./robotcode-bridge");
const providers = require("./backend-providers");
const { planFolderRuns, writeRunInputs, readSelectionResult, writeRunManifest, stoppedBySignal, readRunResults, RobotProcess,
  createRunDirectory } = require("./test-runs");
const { selectedByTags } = require("./robot-tags");
const { interpretRobotRunExit } = require("../features/run/runner-core");
const { DEBUG_TYPE } = require("./debug-workspace");
const { writeCoverageInputs, readCoverage, describeCoverage } = require("./test-coverage");
const { ContinuousRun, affects } = require("./continuous-runs");

const isRobotPath = uri => uri?.scheme === "file" && /\.(robot|resource)$/i.test(uri.path);
// Saved files that start a continuous run's next run.
const isWatchedPath = uri => uri?.scheme === "file" && /\.(robot|resource|py)$/i.test(uri.path);

// Test Explorer discovery over the optional `discovery` service of
// robotCompanion.executionBackend or, when that descriptor has none, of
// robotCompanion.discoveryBackend. The native backend's discovery service speaks
// the normalized discovery API itself; RobotCode's goes through its bridge. The
// controller exists only while an owned, trusted folder has a discovery service,
// so coexistence never adds a second test controller and a missing service
// leaves the file/run fallback, navigation and debug untouched. A discovery
// failure never stops the folder's language or debug services.
class TestWorkspace {
  constructor(extensionContext, debugWorkspace, status) {
    // Shared provider status (language status items and the status command).
    this.status = status;
    this.storagePath = (extensionContext?.storageUri || extensionContext?.globalStorageUri)?.fsPath;
    this.debugWorkspace = debugWorkspace;
    this.contexts = new ExecutionContexts();
    // Robot processes of running Test Explorer runs, for Stop and deactivation.
    this.active = new Set();
    // Each discovered test's source file, name line, tags, folder and the
    // occurrence of a repeated name in its suite.
    this.testInfo = new WeakMap();
    // The latest Test Explorer results of each test: its run's folder and
    // Robot's output folder, Robot's id of the test and its status.
    this.artifacts = new Map();
    // Run profiles from robotCompanion.testProfiles: { name, run, debug }.
    this.profiles = [];
    // Debug Test sessions a Stop has already been sent to.
    this.stopping = new WeakSet();
    // Test runs in progress, of any profile; continuous runs wait for them.
    this.executions = new Set();
    // Continuous runs that are on, and the queue that starts their runs one at a time.
    this.watches = new Set();
    this.continuousQueue = Promise.resolve();
    // Each reported FileCoverage's measured lines, for its details.
    this.coverage = new WeakMap();
    this.roots = new Map();
    this.generation = 0;
    this.disposed = false;
    this.queue = Promise.resolve();
    this.channel = vscode.window.createOutputChannel("Robot Companion Tests");
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("robotCompanion.integrationMode") ||
            event.affectsConfiguration("robotCompanion.executionBackend") ||
            event.affectsConfiguration("robotCompanion.discoveryBackend") ||
            event.affectsConfiguration("robotCompanion.nativeBackendExecutable")) void this.refresh();
        else if (event.affectsConfiguration("robotCompanion.testProfiles")) this.updateProfiles();
      }),
      vscode.commands.registerCommand("robotCompanion.openTestLog", item => this.openArtifact(item, "log.html")),
      vscode.commands.registerCommand("robotCompanion.openTestReport", item => this.openArtifact(item, "report.html")),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(document => {
        const folder = isWatchedPath(document.uri) && vscode.workspace.getWorkspaceFolder(document.uri);
        const root = folder && this.roots.get(folder.uri.toString());
        if (!root) return;
        if (isRobotPath(document.uri) && root.session?.state === "running") {
          root.discovering = this.discover(root).catch(error => this.failed(root, error));
        }
        for (const watch of this.watches) watch.changed(document.uri.fsPath);
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
        const root = { folder, generation, itemIds: [], setting: "executionBackend" };
        this.roots.set(folder.uri.toString(), root);
        try {
          // Trust and owned mode were checked before reading executable settings.
          const execution = backendDescriptor(config, folder, "executionBackend"), fallback = config.get("discoveryBackend");
          const source = config.get("executionBackend")?.services?.discovery ? { input: execution, setting: "executionBackend" }
            : fallback?.services?.discovery ? { input: fallback, setting: "discoveryBackend" }
            : execution?.services?.discovery ? { input: execution, setting: "executionBackend" } : undefined;
          if (!source) { this.roots.delete(folder.uri.toString()); continue; }
          root.setting = source.setting;
          const descriptor = validateDescriptor(source.input);
          if (descriptor.workspaceUri !== folder.uri.toString()) {
            throw new Error(`${source.setting}.workspaceUri must match this workspace folder URI.`);
          }
          // Debug Test uses the execution provider's debug service, whichever provider discovers.
          root.debug = debugService(execution);
          providers.checkVersion(descriptor);
          root.provider = providers.describe(descriptor);
          this.status?.set("discovery", folder, { state: "starting", provider: root.provider, capabilities: [] });
          root.session = isRobotCode(descriptor) ? new RobotCodeDiscovery() : new LspSession({ service: "discovery" });
          root.session.on("log", text => this.channel.append(`[${folder.name}] ${text}`));
          root.session.on("failure", error => this.failed(root, error));
          const capabilities = await root.session.start(descriptor, vscode.workspace.isTrusted && !this.disposed);
          if (capabilities.robotCompanionDiscovery?.version !== DISCOVERY_VERSION) {
            throw new Error(`Backend '${descriptor.id}' does not advertise discovery API v${DISCOVERY_VERSION}.`);
          }
          await (root.discovering = this.discover(root));
        } catch (error) {
          this.failed(root, error);
          await root.session?.stop();
        }
      }
      if (!this.roots.size) this.disposeController();
      else this.updateProfiles();
    }).catch(error => this.channel.appendLine(`Test discovery lifecycle failed: ${error.message}`));
    return this.queue;
  }

  current(root) {
    return !this.disposed && root.generation === this.generation && this.roots.get(root.folder.uri.toString()) === root;
  }

  // Run supports continuous runs. Run with Coverage is offered when this VS
  // Code has the test coverage API.
  controllerFor() {
    if (!this.controller) {
      this.controller = vscode.tests.createTestController("robotCompanion", "Robot Companion");
      this.controller.refreshHandler = () => this.refresh();
      this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run,
        (request, token) => this.run(request, token), true, undefined, true);
      this.coverageProfile("Run with Coverage", undefined, true);
    }
    return this.controller;
  }

  coverageProfile(label, profile, isDefault) {
    if (vscode.TestRunProfileKind.Coverage === undefined || typeof vscode.FileCoverage !== "function") {
      if (!this.reportedCoverageApi) {
        this.reportedCoverageApi = true;
        this.channel.appendLine(`VS Code ${vscode.version} has no test coverage API: Run with Coverage is not offered.`);
      }
      return undefined;
    }
    const coverage = this.controller.createRunProfile(label, vscode.TestRunProfileKind.Coverage,
      (request, token) => this.run(request, token, false, profile, true), isDefault);
    coverage.loadDetailedCoverage = async (testRun, fileCoverage) => this.coverageDetails(fileCoverage);
    coverage.loadDetailedCoverageForTest = async (testRun, fileCoverage, item) => this.coverageDetails(fileCoverage, item);
    return coverage;
  }

  // Debug Test is offered only while a discovered folder's backend also has
  // a debug service; it uses the owned robotcompanion debug type. Each valid
  // robotCompanion.testProfiles entry adds a Run profile with its name (with
  // continuous runs), a coverage profile "<name> (Coverage)" and, with Debug
  // Test, a Debug profile named "<name> (Debug)"; they are not the default
  // profiles (Run Using Profile... / Debug Using Profile... choose them).
  updateProfiles() {
    const debuggable = Boolean(this.debugWorkspace && [...this.roots.values()].some(root => root.debug));
    if (debuggable && this.controller && !this.debugProfile) {
      this.debugProfile = this.controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug,
        (request, token) => this.run(request, token, true), true);
    } else if (!debuggable && this.debugProfile) {
      this.debugProfile.dispose();
      this.debugProfile = undefined;
    }
    for (const profile of this.profiles) { profile.run?.dispose(); profile.debug?.dispose(); profile.coverage?.dispose(); }
    this.profiles = [];
    if (!this.controller) return;
    // Problems of the setting are logged once per value, not on every refresh.
    const value = vscode.workspace.getConfiguration("robotCompanion").get("testProfiles");
    const reported = JSON.stringify(value ?? null);
    const report = reported === this.reportedProfiles ? () => {} : text => this.channel.appendLine(`robotCompanion.testProfiles: ${text}`);
    this.reportedProfiles = reported;
    for (const profile of readProfiles(value, report)) {
      profile.run = this.controller.createRunProfile(profile.name, vscode.TestRunProfileKind.Run,
        (request, token) => this.run(request, token, false, profile), false, undefined, true);
      profile.coverage = this.coverageProfile(`${profile.name} (Coverage)`, profile, false);
      if (debuggable) {
        profile.debug = this.controller.createRunProfile(`${profile.name} (Debug)`, vscode.TestRunProfileKind.Debug,
          (request, token) => this.run(request, token, true, profile), false);
      }
      this.profiles.push(profile);
    }
  }

  // The selected tests: each included item with everything below it, without
  // excluded items and discovery error items, grouped into one Robot run per
  // workspace folder and execution mode (tests, tasks). A profile's tag
  // patterns leave out the tests whose discovered tags they do not select
  // (Robot applies the same patterns).
  selections(request, profile) {
    const excluded = new Set(request.exclude || []), tests = [], filtered = [];
    const visit = item => {
      if (excluded.has(item) || item.error) return;
      if (item.children.size) { item.children.forEach(visit); return; }
      const info = this.testInfo.get(item);
      if (!info) return;
      if (profile && !selectedByTags(profile, info.tags)) { filtered.push(item); return; }
      tests.push({ folderPath: info.folderPath, rpa: info.rpa, test: { id: item.id, item, name: item.label, source: info.source,
        line: info.line, occurrence: info.occurrence } });
    };
    if (request.include) request.include.forEach(visit); else this.controller.items.forEach(visit);
    const plan = planFolderRuns(tests.map(({ folderPath, rpa, test }) => ({ folderPath, rpa, tests: [test] })));
    return { plan, filtered };
  }

  run(request, token, debug = false, profile = undefined, coverage = false) {
    if (request.continuous && !debug && !coverage) return this.continuous(request, token, profile);
    return this.execute(request, token, { debug, profile, coverage });
  }

  // Continuous Run on a Run profile: VS Code calls the profile with
  // request.continuous until the user turns it off, which cancels `token`. A
  // save of a .robot, .resource or .py file in a discovered folder starts, once
  // saves have paused for robotCompanion.continuousRunDelay milliseconds, one
  // run of the request's tests that the saved files can affect (see affects()),
  // with the folder's tests as discovered after the save. These runs start one
  // at a time and only after every other Test Explorer run has ended; saves
  // during a run start one more run after it. Turning continuous run off stops
  // the running one like Stop and starts no other.
  async continuous(request, token, profile) {
    const include = request.include?.map(item => item.id), exclude = (request.exclude || []).map(item => item.id);
    const label = `${profile ? `profile '${profile.name}'` : "Run"}, ${include ? `${include.length} selected items` : "all tests"}`;
    const watch = new ContinuousRun({
      delayMs: continuousDelay,
      execute: files => this.runChanged(request, { include, exclude }, files, token, profile),
      queue: (task, candidate) => this.exclusive(task, candidate),
      log: text => this.channel.appendLine(text)
    });
    this.watches.add(watch);
    this.channel.appendLine(`Continuous run on (${label}): saved .robot, .resource and .py files start runs.`);
    const off = token.onCancellationRequested(() => { void watch.stop(); });
    if (token.isCancellationRequested || this.disposed) void watch.stop();
    try {
      await watch.stopped;
      await watch.stop();
    } finally {
      off.dispose();
      this.watches.delete(watch);
      this.channel.appendLine(`Continuous run off (${label}).`);
    }
  }

  // Starts `task` after the continuous runs queued before it and once no other
  // Test Explorer run is in progress, unless its continuous run is turned off
  // while it waits.
  exclusive(task, watch) {
    const next = this.continuousQueue.then(async () => {
      while (this.executions.size && !watch.isStopped) {
        await Promise.race([Promise.allSettled([...this.executions]), watch.stopped]);
      }
      if (!watch.isStopped) await task();
    });
    this.continuousQueue = next.catch(() => undefined);
    return next;
  }

  async runChanged(request, ids, files, token, profile) {
    await Promise.allSettled([...this.roots.values()].map(root => root.discovering));
    if (token.isCancellationRequested || this.disposed || !this.controller) return;
    const include = ids.include?.map(id => this.findItem(id)).filter(Boolean);
    const exclude = ids.exclude.map(id => this.findItem(id)).filter(Boolean);
    const names = files.map(file => vscode.workspace.asRelativePath(file)).join(", ");
    const { plan } = this.selections({ include, exclude }, profile);
    const affected = plan.flatMap(folderRun => folderRun.tests).filter(test => files.some(file => affects(file, test.source)))
      .map(test => test.item);
    if (!affected.length) {
      this.channel.appendLine(`Continuous run: ${names} saved; it affects none of this continuous run's tests.`);
      return;
    }
    await this.execute(new vscode.TestRunRequest(affected, undefined, request.profile, true), token,
      { profile, note: `Continuous run after ${names} was saved.` });
  }

  findItem(id) {
    let found;
    const visit = item => { if (found) return; if (item.id === id) found = item; else item.children.forEach(visit); };
    this.controller?.items.forEach(visit);
    return found;
  }

  async execute(request, token, options) {
    const execution = this.runOnce(request, token, options);
    this.executions.add(execution);
    try {
      return await execution;
    } finally {
      this.executions.delete(execution);
    }
  }

  // Each folder run's results come only from its own output.xml; a test without
  // an entry there is errored with the run's exit outcome. A Stop ends the
  // running Robot process group; tests that Robot had finished keep their
  // result and every other test of the stopped run is marked Skipped. A
  // coverage run reports the lines its listener measured, merged over the
  // request's Robot runs.
  async runOnce(request, token, { debug = false, profile, coverage = false, note } = {}) {
    const run = this.controller.createTestRun(request);
    const { plan, filtered } = this.selections(request, profile);
    this.lastRun = [];
    if (note) run.appendOutput(`${note}\r\n`);
    if (filtered.length) {
      run.appendOutput(`Profile '${profile.name}' does not select ${filtered.length} of the selected tests by their tags ` +
        `(${describeTagOptions(profile)}): ${filtered.map(item => item.label).join(", ")}.\r\n`);
    }
    if (!plan.length) {
      const text = profile ? `No selected test has tags that profile '${profile.name}' runs (${describeTagOptions(profile)}).`
        : "No discovered test is selected.";
      run.appendOutput(`${text}\r\n`);
      run.end();
      void vscode.window.showInformationMessage(`Robot Companion: ${text}`);
      return;
    }
    for (const folderRun of plan) for (const test of folderRun.tests) run.enqueued(test.item);
    const measured = coverage ? { files: new Map(), unavailable: [] } : undefined;
    try {
      for (const folderRun of plan) {
        if (token.isCancellationRequested) { this.skipAll(run, folderRun, "Run stopped before this test started."); continue; }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderRun.folderPath));
        for (const test of folderRun.tests) run.started(test.item);
        const started = new Date();
        let outcome;
        try {
          outcome = debug ? await this.debugFolder(run, folderRun, folder, token, profile)
            : await this.runFolder(run, folderRun, folder, token, profile, coverage);
        } catch (error) {
          outcome = { error: error.message || String(error), runDir: error.runDir };
        }
        this.report(run, folderRun, { ...outcome, debug, profile, started, folder, measured }, Date.now() - started.getTime(), token);
      }
      if (measured) this.addCoverage(run, measured);
    } finally {
      run.end();
    }
  }

  // Robot's run directory for this run's inputs (and, for Run, its results).
  // Folders holding a listed test's latest results are kept.
  runDirectory() {
    const keep = new Set([...this.active].map(active => active.outputDir));
    for (const artifact of this.artifacts.values()) keep.add(artifact.runDir).add(artifact.outputDir);
    return createRunDirectory(path.join(this.storagePath, "test-runs"), 40, keep);
  }

  async runFolder(run, folderRun, folder, token, profile, coverage = false) {
    if (!vscode.workspace.isTrusted) throw new Error("Running Robot tests requires a trusted workspace.");
    if (!folder || !this.storagePath) throw new Error("Robot Companion needs a workspace folder on this host to run tests.");
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const context = this.contexts.forRoot(folder.uri.toString(), {
      robotCommand: config.get("robotCommand", "robot"), robotArguments: config.get("robotArguments", [])
    }, vscode.workspace.isTrusted);
    const outputDir = this.runDirectory();
    const listeners = coverage ? [writeCoverageInputs(outputDir, [folder.uri.fsPath])] : [];
    const args = [...context.robot.argv, ...context.robotArguments, ...(profile?.arguments || []),
      ...writeRunInputs(outputDir, { tests: folderRun.tests, files: folderRun.files, tagOptions: profile, listeners }),
      folderRun.folderPath];
    const robot = new RobotProcess({ executable: context.robot.executable, args, cwd: context.cwd,
      onOutput: text => run.appendOutput(text.replace(/\r?\n/g, "\r\n")) });
    robot.outputDir = outputDir;
    // Deactivation stops the runs in `active`; a run that would start after it does not.
    if (this.disposed) throw Object.assign(new Error("Robot Companion is shutting down; Robot was not started."), { runDir: outputDir });
    run.appendOutput(`$ ${[context.robot.executable, ...args].join(" ")}\r\n`);
    this.active.add(robot);
    const stop = token.onCancellationRequested(() => { void robot.cancel(); });
    try {
      const exit = await robot.start();
      await robot.cleanup; // After a Stop: also the processes that left the run's group.
      return { exit, outputDir, runDir: outputDir, processGroup: robot.pid, cancelled: robot.cancelled,
        executable: context.robot.executable, args, extraArguments: [...context.robotArguments, ...(profile?.arguments || [])] };
    } finally {
      stop.dispose();
      this.active.delete(robot);
    }
  }

  // Debug Test: one owned robotcompanion launch session per workspace folder,
  // on the folder with the same selection inputs as Run (the debug adapter
  // chooses Robot's output folder), linked to this test run. Its result comes
  // from the session's own output folder once the session has ended.
  async debugFolder(run, folderRun, folder, token, profile) {
    if (!folder || !this.storagePath) throw new Error("Robot Companion needs a workspace folder on this host to debug tests.");
    const handoff = crypto.randomUUID();
    const runDir = this.runDirectory();
    const inputs = writeRunInputs(runDir, { tests: folderRun.tests, files: folderRun.files, outputDir: null, tagOptions: profile });
    const config = { type: DEBUG_TYPE, request: "launch", name: `Debug Test: ${folderRun.tests.map(test => test.name).join(", ")}`,
      target: folderRun.folderPath, args: [...(profile?.arguments || []), ...inputs], robotCompanionTestRun: handoff };
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
        throw Object.assign(new Error("The Robot Companion debug session did not start. See the Robot Companion Debug output."), { runDir });
      }
      const result = await ended;
      if (!result) throw Object.assign(new Error("The Robot Companion debug session ended without a Robot result."), { runDir });
      const settings = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
      return { exit: { exitCode: result.exitCode }, outputDir: result.outputDir, runDir, processGroup: result.processGroup,
        cancelled: token.isCancellationRequested, executable: DEBUG_TYPE, args: config.args,
        extraArguments: [...settings.get("robotArguments", []), ...(profile?.arguments || [])] };
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

  // Per-test status from this run's own output.xml only. Each test's output
  // names its run's log (at the test) and report, and the run's folder keeps
  // robot-companion-run.json: profile, command, exit and each test's status.
  report(run, folderRun, outcome, duration, token) {
    const { exit, outputDir } = outcome;
    if (outcome.measured) outcome.coverage = this.measure(run, folderRun, outcome, token);
    const finish = statuses => this.attribute(run, folderRun, outcome, statuses);
    if (outcome.error && token.isCancellationRequested) { // E.g. a Debug Test session stopped before its result.
      finish(this.skipAll(run, folderRun, `Run stopped: ${outcome.error}`));
      return;
    }
    if (outcome.error) {
      for (const test of folderRun.tests) run.errored(test.item, new vscode.TestMessage(outcome.error));
      finish(this.record(folderRun, outcome));
      return;
    }
    const stopped = outcome.cancelled || token.isCancellationRequested;
    const results = outputDir ? readRunResults(outputDir, undefined, folderRun.tests, outcome.runDir) : new Map();
    const selection = outcome.runDir ? readSelectionResult(outcome.runDir) : undefined;
    const missing = new Set((selection?.missing || []).map(([source, line]) => `${path.resolve(source)}\0${line}`));
    const fallback = interpretRobotRunExit({ ...exit, producedResults: results.size > 0,
      target: { testName: folderRun.tests.length === 1 ? folderRun.tests[0].name : undefined,
        suiteLabel: path.basename(folderRun.folderPath) },
      commandText: outcome.executable });
    if (stopped) run.appendOutput("Run stopped: Robot Companion ended this Robot run's process group.\r\n");
    const statuses = new Map();
    for (const test of folderRun.tests) {
      const item = test.item;
      const own = results.get(test.id);
      if (stopped && (!own || stoppedBySignal(own))) {
        run.skipped(item);
        statuses.set(test.id, { status: "cancelled", robotId: own?.id });
        this.lastRun.push({ id: item.id, status: "cancelled", outputDir, runDir: outcome.runDir, processGroup: outcome.processGroup,
          args: outcome.args, source: "none" });
        continue;
      }
      const time = own?.elapsed !== undefined ? Math.round(own.elapsed * 1000) : duration;
      let status = own?.status, note;
      if (own?.status === "PASS") run.passed(item, time);
      else if (own?.status === "FAIL") run.failed(item, this.message(item, own.message || "Test failed."), time);
      else if (own?.status === "SKIP") run.skipped(item);
      else if (own) run.errored(item, this.message(item, `Unknown Robot status '${own.status}'.`), time);
      else if (missing.has(`${path.resolve(test.source)}\0${test.line}`)) {
        status = "not found";
        run.errored(item, this.message(item, `Robot found no test '${test.name}' at line ${test.line} of ${test.source}: ` +
          "the file changed after discovery. Save it or use Refresh Tests, then run the test again."));
      } else if (selection && results.size > 0) {
        status = "not selected";
        note = "Not run: Robot's own selection of this run (--include/--exclude/--test/--suite from the profile or " +
          "robotCompanion.robotArguments) left this test out.";
        run.skipped(item);
      } else {
        run.errored(item, this.message(item, `Robot did not report this test in this run's output.xml. ${fallback.message}`));
      }
      statuses.set(test.id, { status: status || "error", robotId: own?.id, message: own?.message, note });
      this.lastRun.push({ id: item.id, status: "completed", outcome: fallback.outcome, outputDir, runDir: outcome.runDir,
        processGroup: outcome.processGroup,
        args: outcome.args, robotStatus: own?.status, message: own?.message, source: own ? "output.xml" : "exit outcome",
        ...(note ? { note } : {}) });
    }
    finish(statuses);
  }

  record(folderRun, outcome) {
    const statuses = new Map();
    for (const test of folderRun.tests) {
      statuses.set(test.id, { status: "error", message: outcome.error });
      this.lastRun.push({ id: test.id, status: "error", outputDir: outcome.outputDir, runDir: outcome.runDir,
        processGroup: outcome.processGroup, message: outcome.error, source: "none" });
    }
    return statuses;
  }

  skipAll(run, folderRun, text) {
    const statuses = new Map();
    for (const test of folderRun.tests) {
      statuses.set(test.id, { status: "cancelled" });
      this.lastRun.push({ id: test.id, status: "cancelled", source: "none" });
    }
    run.appendOutput(`${text}\r\n`);
    for (const test of folderRun.tests) run.skipped(test.item);
    return statuses;
  }

  // Names each test's own results in the run output (shown for the test in
  // Test Results), remembers them for Open Robot Log / Open Robot Report and
  // writes the run's manifest. Folders without any of Robot's files are not
  // remembered, so a test keeps its earlier results then.
  attribute(run, folderRun, outcome, statuses) {
    const { outputDir, runDir } = outcome;
    const written = outputDir && ["output.xml", "log.html", "report.html"].filter(name => fs.existsSync(path.join(outputDir, name)));
    const log = written?.includes("log.html") && path.join(outputDir, "log.html");
    const kind = outcome.debug ? "Debug" : "Run";
    if (written?.length) {
      run.appendOutput(`Robot results of this ${kind.toLowerCase()} (${outcome.profile ? `profile '${outcome.profile.name}'` :
        "default profile"}): ${outputDir} (${written.join(", ")}).\r\n`);
    }
    const ended = new Date().toISOString();
    for (const test of folderRun.tests) {
      const result = statuses.get(test.id) || { status: "error" };
      const where = log ? `${log}${result.robotId ? `#${result.robotId}` : ""}` : "no Robot log for this run";
      const location = test.item.uri && test.item.range ? new vscode.Location(test.item.uri, test.item.range) : undefined;
      run.appendOutput(`${test.item.label}: ${result.status}${result.note ? ` (${result.note})` : ""}; log: ${where}\r\n`,
        location, test.item);
      if (written?.length) {
        this.artifacts.set(test.id, { runDir, outputDir, robotId: result.robotId, status: result.status, kind,
          profile: outcome.profile?.name, ended });
      }
    }
    if (runDir) {
      writeRunManifest(runDir, { version: 1, kind, profile: outcome.profile?.name || null, folder: folderRun.folderPath,
        mode: folderRun.rpa === true ? "tasks" : folderRun.rpa === false ? "tests" : null,
        started: outcome.started?.toISOString(), ended, outputDir: outputDir || null, command: outcome.args || null,
        exit: outcome.exit || null, cancelled: Boolean(outcome.cancelled), error: outcome.error || null,
        ...(outcome.coverage ? { coverage: outcome.coverage } : {}),
        tests: folderRun.tests.map(test => ({ id: test.id, name: test.name, source: test.source, line: test.line,
          ...statuses.get(test.id) })) });
    }
  }

  // The lines a coverage run's listener measured, merged per file into
  // `outcome.measured`. A stopped run, a run without coverage.json (Robot did
  // not start or did not close its listeners) and a run whose listener could
  // not measure add nothing; the run output says why. Returns the manifest's
  // coverage entry.
  measure(run, folderRun, outcome, token) {
    const coverage = outcome.runDir && !outcome.cancelled && !token.isCancellationRequested
      ? readCoverage(outcome.runDir, folderRun.tests) : undefined;
    const reason = outcome.cancelled || token.isCancellationRequested ? "the run was stopped"
      : outcome.error ? outcome.error
      : !coverage ? "Robot wrote no coverage (it ended before closing its listeners; see the output above)"
      : coverage.unavailable;
    if (reason) {
      run.appendOutput(`No coverage for this run: ${sentence(reason)}\r\n`);
      if (reason !== "the run was stopped") outcome.measured.unavailable.push(reason);
      return { unavailable: reason };
    }
    run.appendOutput(`${describeCoverage(coverage)}\r\n`);
    const items = new Map(folderRun.tests.map(test => [test.id, test.item]));
    for (const file of coverage.files) {
      const key = path.resolve(file.path);
      const merged = outcome.measured.files.get(key) || { path: file.path, lines: new Set(), executed: new Set(), tests: new Map() };
      for (const line of file.lines) merged.lines.add(line);
      for (const line of file.executed) merged.executed.add(line);
      for (const [id, lines] of file.tests) {
        const own = merged.tests.get(id) || { item: items.get(id), lines: new Set() };
        for (const line of lines) own.lines.add(line);
        merged.tests.set(id, own);
      }
      outcome.measured.files.set(key, merged);
    }
    return { files: coverage.files.length, covered: coverage.covered, total: coverage.total, unmeasured: coverage.unmeasured };
  }

  // One FileCoverage per measured file, with the tests that ran its lines. A
  // coverage run that measured nothing says so in a notification as well.
  addCoverage(run, measured) {
    for (const file of measured.files.values()) {
      const tests = [...file.tests.values()].map(test => test.item).filter(Boolean);
      const fileCoverage = new vscode.FileCoverage(vscode.Uri.file(file.path),
        new vscode.TestCoverageCount(file.executed.size, file.lines.size), undefined, undefined, tests.length ? tests : undefined);
      this.coverage.set(fileCoverage, file);
      run.addCoverage(fileCoverage);
    }
    if (!measured.files.size && measured.unavailable.length) {
      void vscode.window.showWarningMessage(`Robot Companion: no coverage for this run: ${sentence(measured.unavailable[0])}`);
    }
  }

  // Each executable line of a file as a statement, executed or not; for a
  // test, only the lines that test ran.
  coverageDetails(fileCoverage, item) {
    const file = this.coverage.get(fileCoverage);
    if (!file) return [];
    let text = [];
    try { text = fs.readFileSync(file.path, "utf8").split(/\r\n|\r|\n/); } catch { /* Lines then start at column 0. */ }
    const statement = (line, executed) => {
      const content = text[line - 1] || "";
      return new vscode.StatementCoverage(executed, new vscode.Range(line - 1, content.length - content.trimStart().length,
        line - 1, content.trimEnd().length));
    };
    const lines = item ? [...(file.tests.get(item.id)?.lines || [])] : [...file.lines];
    return lines.sort((left, right) => left - right).map(line => statement(line, item ? true : file.executed.has(line)));
  }

  // The latest results of a test, or for a suite or directory the latest of
  // the tests below it.
  artifactFor(item) {
    if (!item) return undefined;
    let latest = this.artifacts.get(item.id);
    item.children?.forEach(child => {
      const candidate = this.artifactFor(child);
      if (candidate && (!latest || candidate.ended > latest.ended)) latest = candidate;
    });
    return latest;
  }

  // Open Robot Log / Open Robot Report in Test Explorer's item menu: the file of
  // the item's latest run, the log at the test's entry.
  async openArtifact(item, file) {
    const artifact = this.artifactFor(item);
    const label = item?.label || "this item";
    if (!artifact) {
      void vscode.window.showInformationMessage(`Robot Companion: no Test Explorer run has Robot results for ${label} yet.`);
      return undefined;
    }
    const target = path.join(artifact.outputDir, file);
    if (!fs.existsSync(target)) {
      void vscode.window.showWarningMessage(`Robot Companion: the run of ${label} did not write ${file} to ${artifact.outputDir}.`);
      return undefined;
    }
    const own = this.artifacts.get(item.id);
    const uri = vscode.Uri.file(target).with(file === "log.html" && own?.robotId ? { fragment: own.robotId } : {});
    this.lastOpened = uri;
    this.channel.appendLine(`Opening ${uri.toString(true)} for ${label}.`);
    if (!await vscode.env.openExternal(uri)) {
      void vscode.window.showWarningMessage(`Robot Companion: could not open ${target}.`);
    }
    return uri;
  }

  // A failure message is anchored at the test's source location.
  message(item, text) {
    const message = new vscode.TestMessage(text);
    if (item.uri && item.range) message.location = new vscode.Location(item.uri, item.range);
    return message;
  }

  // Replaces the folder's items with the backend's tree and, next to it, one
  // error item per file the backend could not read or parse completely. Only
  // the newest request of a folder is applied, whether it succeeds or fails:
  // an older request's late failure or timeout neither replaces the newer
  // request's tree nor notifies, and Refresh Tests does not stop the service
  // for it.
  async discover(root) {
    const workspaceUri = root.folder.uri.toString();
    const request = root.request = (root.request || 0) + 1;
    let result;
    try {
      result = await root.session.request(DISCOVERY_METHOD, { workspaceUri });
    } catch (error) {
      if (request !== root.request) return;
      throw error;
    }
    if (!this.current(root) || request !== root.request || root.session.state !== "running") return;
    const tree = normalizeDiscovery(result, workspaceUri), errors = normalizeDiscoveryErrors(result, workspaceUri);
    root.failure = undefined;
    const controller = this.controllerFor();
    for (const id of root.itemIds.splice(0)) controller.items.delete(id);
    // Directory suites (from the backend's `parents`) hold their file suites;
    // a directory item has no URI, so selecting it never opens a folder. Items
    // get no description: VS Code's Testing view reads an item's description
    // instead of its label to screen readers. Tags are the items' TestTags,
    // which the view's filter selects with @robotCompanion:<tag>.
    const directories = new Map(), folderPath = root.folder.uri.fsPath;
    const place = (item, parent) => {
      if (parent) parent.children.add(item);
      else { controller.items.add(item); root.itemIds.push(item.id); }
    };
    for (const suite of tree) {
      let parent;
      for (const directory of suite.parents) {
        let item = directories.get(directory.id);
        if (!item) {
          item = controller.createTestItem(directory.id, directory.label);
          directories.set(directory.id, item);
          place(item, parent);
        }
        parent = item;
      }
      const item = controller.createTestItem(suite.id, suite.label, vscode.Uri.parse(suite.uri));
      item.range = toRange(suite.range);
      const seen = new Map();
      item.children.replace(suite.children.map(test => {
        const child = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
        child.range = toRange(test.range);
        child.tags = test.tags.map(tag => new vscode.TestTag(tag));
        seen.set(test.label, (seen.get(test.label) || 0) + 1);
        this.testInfo.set(child, { source: vscode.Uri.parse(test.uri).fsPath, line: test.range.start.line + 1, tags: test.tags,
          occurrence: seen.get(test.label), folderPath, rpa: suite.rpa });
        return child;
      }));
      place(item, parent);
    }
    errors.forEach((error, index) => {
      const uri = vscode.Uri.parse(error.uri);
      const line = error.range ? ` (line ${error.range.start.line + 1})` : "";
      const item = controller.createTestItem(`discovery-error:${error.uri}#${index + 1}`,
        `${path.relative(root.folder.uri.fsPath, uri.fsPath) || root.folder.name}: discovery error${line}`, uri);
      if (error.range) item.range = toRange(error.range);
      item.error = `${sentence(error.message)} Tests the backend could not discover here are not listed.`;
      controller.items.add(item);
      root.itemIds.push(item.id);
      this.channel.appendLine(`[${root.folder.name}] Discovery error: ${error.uri}${line}: ${error.message}`);
    });
    const tests = tree.reduce((count, suite) => count + suite.children.length, 0);
    const errorText = errors.length ? `, ${errors.length} discovery ${errors.length === 1 ? "error" : "errors"}` : "";
    this.channel.appendLine(`[${root.folder.name}] Discovered ${tests} tests in ${tree.length} suites` +
      `${directories.size ? ` and ${directories.size} directory suites` : ""}${errorText}.`);
    this.status?.set("discovery", root.folder, { state: "running", provider: root.provider, summary: `${tests} tests${errorText}`,
      severity: errors.length ? vscode.LanguageStatusSeverity.Warning : undefined,
      capabilities: ["Test Explorer discovery"], detail: `discovery service of robotCompanion.${root.setting}; ` +
        `${tests} tests in ${tree.length} suites${errorText}${errors.length ? " (shown as error items in Test Explorer)" : ""}; ` +
        "Run uses robotCompanion.robotCommand" +
        (root.debug ? "; Debug Test uses robotCompanion.executionBackend" : "; no Debug Test (executionBackend has no debug service)") });
  }

  // A service that cannot start, exits or answers with an error leaves no
  // partial or stale tree: the folder's items are replaced by one error item,
  // the status entry shows the refusal, and an error notification says so once
  // per failure (a service failure also fails its pending requests). A later
  // successful discovery clears it. Refresh Tests starts the service again.
  failed(root, error) {
    if (!this.current(root) || root.failure) return;
    root.failure = error.message;
    const message = `robotCompanion.${root.setting} for folder '${root.folder.name}': ${error.message}`;
    this.channel.appendLine(`[${root.folder.name}] Discovery unavailable: ${error.message}`);
    this.status?.set("discovery", root.folder, { state: "refused", error: message });
    const controller = this.controllerFor();
    for (const id of root.itemIds.splice(0)) controller.items.delete(id);
    const item = controller.createTestItem(`discovery-error:${root.folder.uri}`, `${root.folder.name}: discovery unavailable`);
    item.error = `${sentence(error.message)} Use Refresh Tests to start discovery again.`;
    controller.items.add(item);
    root.itemIds.push(item.id);
    void vscode.window.showErrorMessage(`Robot Companion test discovery not available. ${sentence(message)} ` +
      "Test Explorer lists no tests for this folder until Refresh Tests succeeds; language and debugging are not affected.");
  }

  async stopRoots() {
    const roots = [...this.roots.values()];
    this.roots.clear();
    for (const root of roots) {
      for (const id of root.itemIds.splice(0)) this.controller?.items.delete(id);
      this.status?.delete("discovery", root.folder);
      await root.session?.stop();
    }
  }

  disposeController() {
    for (const watch of this.watches) void watch.stop();
    this.controller?.dispose();
    this.controller = undefined;
    this.debugProfile = undefined;
    this.profiles = [];
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    // Continuous runs end; their running Robot runs are among `active`.
    const continuing = [...this.watches].map(watch => watch.stop());
    this.watches.clear();
    const stopping = Promise.all([...this.active].map(robot => robot.cancel(500)).concat(continuing));
    for (const root of this.roots.values()) void root.session?.stop();
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = Promise.all([stopping, this.queue.then(() => this.stopRoots())]).finally(() => {
      this.disposeController();
      this.channel.dispose();
    });
    return this.disposePromise;
  }
}

// Valid robotCompanion.testProfiles entries: a unique non-empty name, and
// optional `include`/`exclude` tag patterns and Robot `arguments`, each a list
// of strings. Other entries are reported and left out.
function readProfiles(value, report) {
  const profiles = [], names = new Set();
  if (value === undefined || value === null) return profiles;
  if (!Array.isArray(value)) { report("must be a list of profiles; none is offered."); return profiles; }
  const strings = list => list === undefined || (Array.isArray(list) && list.every(entry => typeof entry === "string" && entry.length));
  value.forEach((entry, index) => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const problem = !name ? "needs a name" : names.has(name) ? `repeats the name '${name}'`
      : !strings(entry.include) ? "include must be a list of tag patterns"
      : !strings(entry.exclude) ? "exclude must be a list of tag patterns"
      : !(entry.arguments === undefined || (Array.isArray(entry.arguments) && entry.arguments.every(arg => typeof arg === "string")))
        ? "arguments must be a list of strings" : undefined;
    if (problem) { report(`entry ${index + 1} ${problem}; it is not offered.`); return; }
    names.add(name);
    profiles.push({ name, include: entry.include || [], exclude: entry.exclude || [], arguments: entry.arguments || [] });
  });
  return profiles;
}

function describeTagOptions(profile) {
  const parts = [];
  if (profile.include.length) parts.push(`include ${profile.include.join(" | ")}`);
  if (profile.exclude.length) parts.push(`exclude ${profile.exclude.join(" | ")}`);
  return parts.join("; ") || "no tag patterns";
}

// True when the execution descriptor is valid and has a debug service.
function debugService(input) {
  try { return Boolean(input && validateDescriptor(input).services.debug); } catch { return false; }
}

const sentence = text => /[.!?]$/.test(text) ? text : `${text}.`;

// robotCompanion.continuousRunDelay: milliseconds without a save before a continuous run starts.
function continuousDelay() {
  const value = Number(vscode.workspace.getConfiguration("robotCompanion").get("continuousRunDelay", 1000));
  return Number.isFinite(value) ? Math.min(60000, Math.max(100, Math.round(value))) : 1000;
}

function childrenOf(item) {
  const children = [];
  item.children.forEach(child => children.push(child));
  return children;
}

function toRange(range) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

module.exports = { TestWorkspace, readProfiles };

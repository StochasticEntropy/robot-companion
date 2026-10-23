"use strict";

// Runs a single Robot test or a whole .robot suite with the user's configured
// Robot Framework command. The process is started without a shell, its output
// streams into a dedicated output channel, and the result is reported in one
// notification with links to the log and report of that run.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const vscode = require("vscode");
const core = require("./runner-core");
const { RobotEnvironmentController } = require("./environment");
const { processGuard } = require("../../integration/process-guard");
const { ProjectFiles, describeProjectFiles } = require("../../integration/project-files");

const CMD_RUN_TEST = "robotCompanion.runTest";
const CMD_RUN_TEST_AT_CURSOR = "robotCompanion.runTestAtCursor";
const CMD_DEBUG_TEST_AT_CURSOR = "robotCompanion.debugTestAtCursor";
const CMD_RUN_SUITE = "robotCompanion.runSuite";
const RUN_OUTPUT_CHANNEL_NAME = "Robot Companion Test Run";
const RUN_DIRECTORY_NAME = "robot-runs";
const KEPT_RUN_DIRECTORIES = 20;
const MAX_KEPT_OUTPUT_CHARS = 65536;
const ACTION_OPEN_LOG = "Open Log";
const ACTION_OPEN_REPORT = "Open Report";
const ACTION_SHOW_OUTPUT = "Show Output";
const ACTION_MANAGE_TRUST = "Manage Workspace Trust";
const MESSAGE_NO_TEST_AT_CURSOR = "Place the cursor inside a test case to run it.";
const MESSAGE_TRUST_REQUIRED =
  "Running Robot tests requires a trusted workspace. Robot Companion does not start Robot Framework in Restricted Mode.";

let workspaceTrustOverrideForTest;
let lastRunNotificationForTest;
let lastRunOutputForTest = "";
let environmentForTest;
let registeredRunner;

function isWorkspaceTrustedForRun() {
  if (typeof workspaceTrustOverrideForTest === "boolean") {
    return workspaceTrustOverrideForTest;
  }
  return vscode.workspace.isTrusted !== false;
}

function getRunConfig(resourceUri) {
  return vscode.workspace.getConfiguration("robotCompanion", resourceUri);
}

class RobotRunCodeLensProvider {
  constructor() {
    this._onDidChangeCodeLensesEmitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLensesEmitter.event;
  }

  dispose() {
    this._onDidChangeCodeLensesEmitter.dispose();
  }

  refresh() {
    this._onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document) {
    if (
      !document ||
      document.uri.scheme !== "file" ||
      !core.isRobotSuitePath(document.uri.fsPath) ||
      !getRunConfig(document.uri).get("enableRunCodeLens", true)
    ) {
      return [];
    }
    const { sections, tests } = core.findRobotTestCases(document.getText());
    if (tests.length === 0) {
      return [];
    }
    const uriString = document.uri.toString();
    return [
      ...sections.map(
        (section) =>
          new vscode.CodeLens(new vscode.Range(section.line, 0, section.line, 0), {
            title: "Run Suite",
            tooltip: `Run every test in ${path.basename(document.uri.fsPath)} with Robot Framework`,
            command: CMD_RUN_SUITE,
            arguments: [uriString]
          })
      ),
      ...tests.map(
        (test) =>
          new vscode.CodeLens(new vscode.Range(test.line, 0, test.line, 0), {
            title: "Run Test",
            tooltip: `Run only "${test.name}" with Robot Framework`,
            command: CMD_RUN_TEST,
            arguments: [uriString, test.name]
          })
      )
    ];
  }
}

class RobotTestRunner {
  constructor(context) {
    this._context = context;
    this._channel = undefined;
    this._activeRun = undefined;
    this._projectFiles = new ProjectFiles();
  }

  dispose() {
    this._disposed = true;
    if (this._activeRun && this._activeRun.child) {
      this._activeRun.child.kill();
    }
    if (this._channel) {
      this._channel.dispose();
    }
  }

  _getChannel() {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(RUN_OUTPUT_CHANNEL_NAME);
    }
    return this._channel;
  }

  // The run channel, cleared for a new run; everything written to it is also
  // kept for the UI tests, which cannot read an output channel back.
  _startTranscript() {
    const channel = this._getChannel();
    channel.clear();
    lastRunOutputForTest = "";
    const keep = (text) => {
      if (lastRunOutputForTest.length < MAX_KEPT_OUTPUT_CHARS) {
        lastRunOutputForTest += text;
      }
    };
    return {
      append(text) {
        keep(text);
        channel.append(text);
      },
      appendLine(text) {
        keep(`${text}\n`);
        channel.appendLine(text);
      },
      show(preserveFocus) {
        channel.show(preserveFocus);
      }
    };
  }

  showOutput() {
    this._getChannel().show(true);
  }

  _notify(severity, message, actions = [], handlers = {}) {
    lastRunNotificationForTest = { severity, message, actions: [...actions] };
    const show =
      severity === "error"
        ? vscode.window.showErrorMessage
        : severity === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    // Not awaited: a notification stays until dismissed, and the run is over.
    void Promise.resolve(show(message, ...actions))
      .then(async (choice) => {
        if (choice && handlers[choice]) {
          await handlers[choice]();
        }
      })
      .catch((error) => {
        void vscode.window.showErrorMessage(
          `Robot Companion could not complete "${message}": ${error && error.message ? error.message : error}`
        );
      });
  }

  async runTestAtCursor() {
    const editor = vscode.window.activeTextEditor;
    const document = editor ? editor.document : undefined;
    if (!document) {
      this._notify("info", "Open a .robot file to run its tests.");
      return { status: "noFile" };
    }
    const { tests } = this._readTests(document);
    if (!core.isRobotSuitePath(document.uri.fsPath) || tests.length === 0) {
      return this._reportNoTests(document.uri);
    }
    const test = core.findTestAtLine(tests, editor.selection.active.line);
    if (!test) {
      this._notify("info", MESSAGE_NO_TEST_AT_CURSOR);
      return { status: "noTestAtCursor" };
    }
    return this.run(document.uri, test.name);
  }

  async runTest(uriArgument, testName) {
    const uri = toUri(uriArgument) || vscode.window.activeTextEditor?.document.uri;
    if (!uri || typeof testName !== "string") {
      return this.runTestAtCursor();
    }
    return this.run(uri, testName);
  }

  async runSuite(uriArgument) {
    const uri = toUri(uriArgument) || vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      this._notify("info", "Open a .robot file to run its tests.");
      return { status: "noFile" };
    }
    return this.run(uri, undefined);
  }

  _readTests(document) {
    return core.findRobotTestCases(document.getText());
  }

  _reportNoTests(uri) {
    this._notify(
      "info",
      `No tests in this file: ${path.basename(uri.fsPath || uri.path)} has no *** Test Cases *** or *** Tasks *** to run.`
    );
    return { status: "noTests" };
  }

  async run(uri, testName) {
    if (!isWorkspaceTrustedForRun()) {
      this._notify("warning", MESSAGE_TRUST_REQUIRED, [ACTION_MANAGE_TRUST], {
        [ACTION_MANAGE_TRUST]: () => vscode.commands.executeCommand("workbench.trust.manage")
      });
      return { status: "untrusted" };
    }
    const installing = this.environment?.installing;
    if (this._activeRun || installing) {
      this._notify(
        "info",
        this._activeRun
          ? `A Robot Framework run is already in progress (${core.describeRunTarget(this._activeRun.target)}). Wait for it to finish before starting another.`
          : `robotframework is being installed in ${installing.executable}. Wait for the installation to finish before starting a run.`,
        [ACTION_SHOW_OUTPUT],
        { [ACTION_SHOW_OUTPUT]: () => this.showOutput() }
      );
      return { status: "busy" };
    }
    if (uri.scheme !== "file") {
      this._notify("info", "Save the file before running its tests.");
      return { status: "notSaved" };
    }

    // Claimed before the first await so a second click cannot slip in.
    const target = { testName, suiteLabel: path.basename(uri.fsPath) };
    this._activeRun = { target };
    try {
      return await this._runClaimed(uri, target);
    } catch (error) {
      this._notify("error", `Robot Framework run failed: ${error && error.message ? error.message : error}`, [
        ACTION_SHOW_OUTPUT
      ], { [ACTION_SHOW_OUTPUT]: () => this.showOutput() });
      return { status: "failedToStart", message: String(error && error.message ? error.message : error) };
    } finally {
      this._activeRun = undefined;
    }
  }

  async _runClaimed(uri, target) {
    const document = await vscode.workspace.openTextDocument(uri);
    const { tests } = this._readTests(document);
    if (!core.isRobotSuitePath(uri.fsPath) || tests.length === 0) {
      return this._reportNoTests(uri);
    }
    if (document.isDirty && !(await document.save())) {
      this._notify("warning", `${target.suiteLabel} could not be saved, so its tests were not run.`);
      return { status: "notSaved" };
    }

    const config = getRunConfig(uri);
    let parsedCommand;
    try {
      parsedCommand = await this.environment.resolve(uri, true, true);
      if (parsedCommand.availability?.state === "cancelled") {
        this._notify("warning", "Robot environment changed before the run started. Run again to use the current environment.");
        return { status: "environmentChanged" };
      }
      if (!["default", "setting"].includes(parsedCommand.source) && parsedCommand.availability?.state !== "available") {
        void this.environment.reportUnavailable(uri, parsedCommand);
        return { status: "environmentUnavailable" };
      }
    } catch (error) {
      this._notify("error", error.message);
      return { status: "invalidCommand", message: error.message };
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceFolderPath = workspaceFolder?.uri.fsPath;
    const cwd = core.resolveRunWorkingDirectory(workspaceFolderPath, uri.fsPath);
    if (!fs.existsSync(cwd)) {
      // spawn reports a missing cwd as ENOENT, which would blame the command.
      const message = `The working folder ${cwd} does not exist, so ${core.describeRunTarget(target)} was not run.`;
      this._notify("error", message);
      return { status: "missingWorkingFolder", message };
    }

    // The folder's robot.toml settings come first, as the native language and discovery
    // services apply them; read by the native backend in owned mode only.
    const project = workspaceFolder
      ? await this._projectFiles.read(workspaceFolder, config, { owned: config.get("integrationMode", "coexistence") === "owned", environments: this.projectEnvironments })
      : { arguments: [], files: [], problems: [] };
    const outputDir = await this._createRunDirectory();
    const invocation = core.buildRobotRunInvocation({
      command: parsedCommand,
      robotArguments: [...project.arguments, ...core.normalizeRobotArguments(config.get("robotArguments", []))],
      outputDir,
      testName: target.testName,
      suitePath: uri.fsPath
    });

    const channel = this._startTranscript();
    channel.appendLine(`$ ${core.formatCommandLine(invocation.executable, invocation.args)}`);
    channel.appendLine(`cwd: ${cwd}`);
    for (const line of describeProjectFiles(project)) channel.appendLine(line);
    channel.appendLine(`Results: ${outputDir}`);
    channel.appendLine("");
    channel.show(true);

    if (!isWorkspaceTrustedForRun()) return { status: "untrusted" };
    if (parsedCommand.version !== this.environment.version) {
      this._notify("warning", "Robot environment changed before the run started. Run again to use the current environment.");
      return { status: "environmentChanged" };
    }
    const exit = await this._spawn(invocation, cwd, channel, target);
    const producedResults = ["output.xml", "log.html", "report.html"].some((name) =>
      fs.existsSync(path.join(outputDir, name))
    );
    const result = core.interpretRobotRunExit({
      ...exit,
      producedResults,
      target,
      commandText: parsedCommand.executable
    });

    channel.appendLine("");
    channel.appendLine(
      exit.spawnError
        ? `[could not start: ${exit.spawnError.code || exit.spawnError.message}] ${result.message}`
        : `[${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.exitCode}`}] ${result.message}`
    );

    const showOutput = () => this.showOutput();
    if (result.outcome === "error") {
      this._notify("error", result.message, [ACTION_SHOW_OUTPUT], { [ACTION_SHOW_OUTPUT]: showOutput });
    } else {
      this._notify(
        result.outcome === "passed" ? "info" : "warning",
        result.message,
        [ACTION_OPEN_LOG, ACTION_OPEN_REPORT, ACTION_SHOW_OUTPUT],
        {
          [ACTION_OPEN_LOG]: () => openRunArtifact(outputDir, "log.html"),
          [ACTION_OPEN_REPORT]: () => openRunArtifact(outputDir, "report.html"),
          [ACTION_SHOW_OUTPUT]: showOutput
        }
      );
    }

    return {
      status: "completed",
      outcome: result.outcome,
      message: result.message,
      exitCode: exit.exitCode,
      signal: exit.signal,
      executable: invocation.executable,
      args: invocation.args,
      cwd,
      outputDir
    };
  }

  _spawn(invocation, cwd, channel, target) {
    return new Promise((resolve) => {
      let settled = false;
      let release = () => {};
      const settle = (value) => {
        if (!settled) {
          settled = true;
          release();
          resolve(value);
        }
      };
      let child;
      try {
        if (this._disposed || !isWorkspaceTrustedForRun()) { settle({ spawnError: new Error("Workspace trust required") }); return; }
        child = childProcess.spawn(invocation.executable, invocation.args, {
          cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: "1" }
        });
      } catch (error) {
        settle({ spawnError: error });
        return;
      }
      // Ended by the process guard if the extension host goes away without stopping it.
      release = processGuard.register(child.pid);
      this._activeRun = { target, child };
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      child.stdout.on("data", (chunk) => channel.append(stdoutDecoder.write(chunk)));
      child.stderr.on("data", (chunk) => channel.append(stderrDecoder.write(chunk)));
      child.on("error", (error) => settle({ spawnError: error }));
      child.on("close", (exitCode, signal) => {
        channel.append(stdoutDecoder.end() + stderrDecoder.end());
        settle({ exitCode, signal });
      });
    });
  }

  async _createRunDirectory() {
    const storageUri = this._context.storageUri || this._context.globalStorageUri;
    const runsRoot = path.join(storageUri.fsPath, RUN_DIRECTORY_NAME);
    await fs.promises.mkdir(runsRoot, { recursive: true });
    await pruneRunDirectories(runsRoot, KEPT_RUN_DIRECTORIES - 1);
    const baseName = core.buildRunDirectoryName(new Date());
    let outputDir = path.join(runsRoot, baseName);
    for (let suffix = 2; fs.existsSync(outputDir); suffix += 1) {
      outputDir = path.join(runsRoot, `${baseName}-${suffix}`);
    }
    await fs.promises.mkdir(outputDir);
    return outputDir;
  }
}

async function pruneRunDirectories(runsRoot, keep) {
  try {
    const entries = (await fs.promises.readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
      await fs.promises.rm(path.join(runsRoot, name), { recursive: true, force: true });
    }
  } catch {
    // Old results are only housekeeping; a failed cleanup must not stop a run.
  }
}

async function openRunArtifact(outputDir, fileName) {
  const filePath = path.join(outputDir, fileName);
  if (!fs.existsSync(filePath)) {
    await vscode.window.showWarningMessage(`This run did not write ${fileName} to ${outputDir}.`);
    return;
  }
  const opened = await vscode.env.openExternal(vscode.Uri.file(filePath));
  if (!opened) {
    await vscode.window.showWarningMessage(`Could not open ${filePath}.`);
  }
}

function toUri(value) {
  if (!value) {
    return undefined;
  }
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (typeof value === "string") {
    return vscode.Uri.parse(value);
  }
  if (value.uri instanceof vscode.Uri) {
    return value.uri;
  }
  return undefined;
}

function registerRobotRunFeature(context) {
  const runner = new RobotTestRunner(context);
  const codeLensProvider = new RobotRunCodeLensProvider();
  const environment = new RobotEnvironmentController(context, runner, isWorkspaceTrustedForRun);
  runner.environment = environment;
  registeredRunner = runner;
  environmentForTest = environment;
  const disposables = [
    runner,
    environment,
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(
      [{ language: "robotframework" }, { pattern: "**/*.robot" }],
      codeLensProvider
    ),
    vscode.commands.registerCommand(CMD_RUN_TEST, (uri, testName) => runner.runTest(uri, testName)),
    vscode.commands.registerCommand(CMD_RUN_TEST_AT_CURSOR, () => runner.runTestAtCursor()),
    vscode.commands.registerCommand(CMD_DEBUG_TEST_AT_CURSOR, () => vscode.commands.executeCommand("testing.debugAtCursor")),
    vscode.commands.registerCommand(CMD_RUN_SUITE, (uri) => runner.runSuite(uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("robotCompanion.enableRunCodeLens")) {
        codeLensProvider.refresh();
      }
    })
  ];
  return disposables;
}

module.exports = {
  registerRobotRunFeature,
  // Reuse the one project backend assessment created by extension activation.
  setProjectEnvironments(environments) { registeredRunner.projectEnvironments = environments; },
  // The registered Select Robot Environment controller (after registerRobotRunFeature).
  environmentController() { return environmentForTest; },
  __test__: {
    RobotTestRunner,
    getEnvironmentForTest() { return environmentForTest; },
    setWorkspaceTrustOverrideForTest(value) {
      workspaceTrustOverrideForTest = value;
    },
    getLastRunOutputForTest() {
      return lastRunOutputForTest;
    },
    getLastRunNotificationForTest() {
      return lastRunNotificationForTest;
    },
    clearLastRunNotificationForTest() {
      lastRunNotificationForTest = undefined;
    }
  }
};

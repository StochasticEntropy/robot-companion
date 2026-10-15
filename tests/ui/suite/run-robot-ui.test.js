const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const SAMPLE_FIXTURE = "run-robot-sample.robot";
const RUN_ACTIONS = ["Open Log", "Open Report", "Show Output"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteForSetting(value) {
  return `"${value}"`;
}

function readInvocation(result) {
  return JSON.parse(fs.readFileSync(path.join(result.outputDir, "invocation.json"), "utf8"));
}

suite("Robot Companion run tests", function () {
  this.timeout(90000);

  let extensionTestApi;
  let fakeRobotCommand = "";
  let workspaceFolderPath = "";
  let sampleUri;
  let scratchDirectories = [];

  const config = () => vscode.workspace.getConfiguration("robotCompanion");
  const setRobotCommand = (value) => config().update("robotCommand", value, vscode.ConfigurationTarget.Workspace);
  const lastNotification = () => extensionTestApi.getLastRunNotificationForTest();

  async function codeLensesOf(uri) {
    return (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 100)) || [];
  }

  async function runLens(uri, title, line) {
    const lens = (await codeLensesOf(uri)).find(
      (candidate) => candidate.command && candidate.command.title === title && candidate.range.start.line === line
    );
    assert(lens, `Expected a "${title}" CodeLens on line ${line + 1}.`);
    return vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments || []));
  }

  function lineOf(document, text) {
    const line = document.getText().split(/\r?\n/).indexOf(text);
    assert(line >= 0, `Expected line "${text}" in ${path.basename(document.uri.fsPath)}.`);
    return line;
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be available.`);
    await extension.activate();
    extensionTestApi = require(path.join(extension.extensionPath, "src/core/extension.js")).__test__;
    const nodePath = process.env.npm_node_execpath || "node";
    fakeRobotCommand = `${quoteForSetting(nodePath)} ${quoteForSetting(
      path.join(extension.extensionPath, "tests/fixtures/fake-robot/fake-robot.js")
    )}`;
    workspaceFolderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    sampleUri = vscode.Uri.file(path.join(workspaceFolderPath, SAMPLE_FIXTURE));
    await setRobotCommand(fakeRobotCommand);
  });

  setup(() => {
    extensionTestApi.clearLastRunNotificationForTest();
    extensionTestApi.setWorkspaceTrustOverrideForTest(undefined);
  });

  suiteTeardown(async () => {
    extensionTestApi.setWorkspaceTrustOverrideForTest(undefined);
    await config().update("robotCommand", undefined, vscode.ConfigurationTarget.Workspace);
    await config().update("robotArguments", undefined, vscode.ConfigurationTarget.Workspace);
    for (const directory of scratchDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Run Suite and Run Test CodeLenses sit on the header and every test name", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    await vscode.window.showTextDocument(document, { preview: false });
    const lenses = await codeLensesOf(sampleUri);
    const runLenses = lenses
      .filter((lens) => lens.command && ["Run Suite", "Run Test"].includes(lens.command.title))
      .map((lens) => [lens.command.title, lens.range.start.line]);
    assert.deepStrictEqual(runLenses, [
      ["Run Suite", lineOf(document, "*** Test Cases ***")],
      ["Run Test", lineOf(document, "Passing Test")],
      ["Run Test", lineOf(document, "Failing Test")],
      ["Run Test", lineOf(document, "Sum * Check")],
      ["Run Test", lineOf(document, "Sum Total Check")],
      ["Run Test", lineOf(document, "Slow Test")],
      ["Run Test", lineOf(document, "Invalid Test")]
    ]);
  });

  test("Run Test passes the escaped --test name and the suite file, in the workspace folder", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const result = await runLens(sampleUri, "Run Test", lineOf(document, "Sum * Check"));

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.outcome, "passed");
    const invocation = readInvocation(result);
    assert.deepStrictEqual(invocation.argv.slice(-5), [
      "--outputdir",
      result.outputDir,
      "--test",
      "Sum [*] Check",
      sampleUri.fsPath
    ]);
    assert.strictEqual(fs.realpathSync(invocation.cwd), fs.realpathSync(workspaceFolderPath));
    assert.strictEqual(invocation.pythonUnbuffered, "1");

    assert.deepStrictEqual(lastNotification(), {
      severity: "info",
      message: 'Test "Sum * Check" passed.',
      actions: RUN_ACTIONS
    });
    for (const name of ["log.html", "report.html"]) {
      assert(fs.existsSync(path.join(result.outputDir, name)), `Expected ${name} in the run's output directory.`);
    }
    const output = extensionTestApi.getLastRunOutputForTest().split("\n");
    assert.match(output[0], /^\$ .*--test 'Sum \[\*\] Check' /);
    assert.strictEqual(output[1], `cwd: ${workspaceFolderPath}`);
    assert.strictEqual(output[2], `Results: ${result.outputDir}`);
    assert(extensionTestApi.getLastRunOutputForTest().includes("1 test, 1 passed, 0 failed"));
  });

  test("a failing test reports the failed count with log, report and output actions", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const result = await runLens(sampleUri, "Run Test", lineOf(document, "Failing Test"));
    assert.strictEqual(result.outcome, "failed");
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(lastNotification(), {
      severity: "warning",
      message: 'Test "Failing Test": 1 test failed.',
      actions: RUN_ACTIONS
    });
  });

  test("Run Suite runs the whole file without a --test selection", async () => {
    await config().update("robotArguments", ["--loglevel", "DEBUG"], vscode.ConfigurationTarget.Workspace);
    try {
      const document = await vscode.workspace.openTextDocument(sampleUri);
      const result = await runLens(sampleUri, "Run Suite", lineOf(document, "*** Test Cases ***"));
      assert.strictEqual(result.outcome, "failed");
      const invocation = readInvocation(result);
      assert(!invocation.argv.includes("--test"));
      assert.deepStrictEqual(invocation.argv.slice(-5), [
        "--loglevel",
        "DEBUG",
        "--outputdir",
        result.outputDir,
        sampleUri.fsPath
      ]);
      assert.deepStrictEqual(lastNotification(), {
        severity: "warning",
        message: `Suite "${SAMPLE_FIXTURE}": 2 tests failed.`,
        actions: RUN_ACTIONS
      });

      const commandResult = await vscode.commands.executeCommand("robotCompanion.runSuite", sampleUri);
      assert.strictEqual(commandResult.status, "completed");
      assert(!readInvocation(commandResult).argv.includes("--test"));
    } finally {
      await config().update("robotArguments", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("Run Test at Cursor runs the test around the cursor and nothing outside a test", async () => {
    const document = await vscode.workspace.openTextDocument(sampleUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const bodyLine = lineOf(document, "Passing Test") + 1;
    editor.selection = new vscode.Selection(bodyLine, 4, bodyLine, 4);
    const result = await vscode.commands.executeCommand("robotCompanion.runTestAtCursor");
    assert.strictEqual(result.status, "completed");
    assert.deepStrictEqual(readInvocation(result).argv.slice(-2), ["Passing Test", sampleUri.fsPath]);

    extensionTestApi.clearLastRunNotificationForTest();
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const outside = await vscode.commands.executeCommand("robotCompanion.runTestAtCursor");
    assert.deepStrictEqual(outside, { status: "noTestAtCursor" });
    assert.deepStrictEqual(lastNotification(), {
      severity: "info",
      message: "Place the cursor inside a test case to run it.",
      actions: []
    });
  });

  test("a missing command names the command and the setting", async () => {
    await setRobotCommand("robot-companion-missing-command");
    try {
      const result = await vscode.commands.executeCommand("robotCompanion.runTest", sampleUri.toString(), "Passing Test");
      assert.strictEqual(result.outcome, "error");
      assert.deepStrictEqual(lastNotification(), {
        severity: "error",
        message:
          "Robot Framework command 'robot-companion-missing-command' was not found. Install robotframework (pip install robotframework) or set robotCompanion.robotCommand.",
        actions: ["Show Output"]
      });
    } finally {
      await setRobotCommand(fakeRobotCommand);
    }
  });

  test("an error exit code is shown with Show Output", async () => {
    const result = await vscode.commands.executeCommand("robotCompanion.runTest", sampleUri.toString(), "Invalid Test");
    assert.strictEqual(result.exitCode, 252);
    assert.deepStrictEqual(lastNotification(), {
      severity: "error",
      message:
        'Robot Framework could not run test "Invalid Test": exit code 252 (invalid test data or command line options). See the output for details.',
      actions: ["Show Output"]
    });
  });

  test("a second run while one is active starts no process", async () => {
    const slowRun = vscode.commands.executeCommand("robotCompanion.runTest", sampleUri.toString(), "Slow Test");
    await sleep(200);
    const second = await vscode.commands.executeCommand("robotCompanion.runTest", sampleUri.toString(), "Passing Test");
    assert.deepStrictEqual(second, { status: "busy" });
    assert.deepStrictEqual(lastNotification(), {
      severity: "info",
      message:
        'A Robot Framework run is already in progress (test "Slow Test"). Wait for it to finish before starting another.',
      actions: ["Show Output"]
    });
    const slowResult = await slowRun;
    assert.strictEqual(slowResult.outcome, "passed");
    assert.deepStrictEqual(readInvocation(slowResult).argv.slice(-2), ["Slow Test", sampleUri.fsPath]);
  });

  test("a file outside every workspace folder runs in its own directory after saving edits", async () => {
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-run-outside-"));
    scratchDirectories.push(outsideDirectory);
    const outsidePath = path.join(outsideDirectory, "outside.robot");
    fs.writeFileSync(outsidePath, "*** Test Cases ***\nOutside Test\n    Log    outside\n");
    const document = await vscode.workspace.openTextDocument(outsidePath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await editor.edit((builder) => builder.insert(new vscode.Position(3, 0), "Added Test\n    Log    unsaved\n"));
    assert(document.isDirty);

    const result = await runLens(document.uri, "Run Test", 3);
    assert.strictEqual(result.status, "completed");
    assert(!document.isDirty, "the edited editor is saved before the run");
    assert(fs.readFileSync(outsidePath, "utf8").includes("Added Test"));
    const invocation = readInvocation(result);
    assert.strictEqual(fs.realpathSync(invocation.cwd), fs.realpathSync(outsideDirectory));
    assert.deepStrictEqual(invocation.argv.slice(-2), ["Added Test", outsidePath]);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("resource files and files without tests get no run CodeLens and a no-tests message", async () => {
    const resourcePath = path.join(workspaceFolderPath, "run-keywords.resource");
    const keywordsOnlyPath = path.join(workspaceFolderPath, "run-keywords-only.robot");
    fs.writeFileSync(resourcePath, "*** Test Cases ***\nLooks Like A Test\n    Log    x\n");
    fs.writeFileSync(keywordsOnlyPath, "*** Keywords ***\nHelper\n    Log    x\n");
    try {
      for (const filePath of [resourcePath, keywordsOnlyPath]) {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const runLenses = (await codeLensesOf(uri)).filter(
          (lens) => lens.command && ["Run Suite", "Run Test"].includes(lens.command.title)
        );
        assert.deepStrictEqual(runLenses, [], `${path.basename(filePath)} has no run CodeLens`);

        const expected = {
          severity: "info",
          message: `No tests in this file: ${path.basename(filePath)} has no *** Test Cases *** or *** Tasks *** to run.`,
          actions: []
        };
        assert.deepStrictEqual(await vscode.commands.executeCommand("robotCompanion.runSuite", uri), {
          status: "noTests"
        });
        assert.deepStrictEqual(lastNotification(), expected);
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        extensionTestApi.clearLastRunNotificationForTest();
        assert.deepStrictEqual(await vscode.commands.executeCommand("robotCompanion.runTestAtCursor"), {
          status: "noTests"
        });
        assert.deepStrictEqual(lastNotification(), expected);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      }
    } finally {
      fs.rmSync(resourcePath, { force: true });
      fs.rmSync(keywordsOnlyPath, { force: true });
    }
  });

  test("an untrusted workspace starts no process and says why", async () => {
    extensionTestApi.setWorkspaceTrustOverrideForTest(false);
    for (const run of [
      () => vscode.commands.executeCommand("robotCompanion.runTest", sampleUri.toString(), "Passing Test"),
      () => vscode.commands.executeCommand("robotCompanion.runSuite", sampleUri)
    ]) {
      extensionTestApi.clearLastRunNotificationForTest();
      assert.deepStrictEqual(await run(), { status: "untrusted" });
      assert.deepStrictEqual(lastNotification(), {
        severity: "warning",
        message:
          "Running Robot tests requires a trusted workspace. Robot Companion does not start Robot Framework in Restricted Mode.",
        actions: ["Manage Workspace Trust"]
      });
    }
  });
});

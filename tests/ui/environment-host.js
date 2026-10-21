// Dedicated extension-test hosts: two identical-named roots with the synthetic Python provider, and
// native Restricted Mode. Test hosts keep storage in memory; run-environment-restart.js covers restarts.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const cp = require("child_process");
const { EnvironmentCdp, sleep } = require("./suite/environment-cdp");
async function run() {
  const stage = process.env.ROBOT_ENV_HOST_STAGE;
  const calls = []; const spawn = cp.spawn;
  cp.spawn = function (...args) { calls.push({ executable: args[0], args: args[1] }); return spawn.apply(this, args); };
  let cdp;
  const summary = { stage, nativeTrust: vscode.workspace.isTrusted, assertions: 0 };
  try {
    if (stage === "restricted") assert.equal(vscode.workspace.isTrusted, false, "Host must genuinely be in Restricted Mode");
    const extension = vscode.extensions.getExtension("StochasticEntropy.robot-markdown-companion"); await extension.activate();
    const api = require(path.join(extension.extensionPath, "src/features/run")).__test__, environment = api.getEnvironmentForTest();
    api.setWorkspaceTrustOverrideForTest(undefined);
    const folders = vscode.workspace.workspaceFolders;
    const uri = vscode.Uri.file(path.join(folders[0].uri.fsPath, "sample.robot"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    if (stage === "restricted") {
      cdp = await EnvironmentCdp.connect();
      await cdp.palette("Robot Companion: Select Robot Environment");
      await cdp.wait("document.body.innerText.includes('Trust this workspace to check environments')");
      await cdp.retain("restricted-picker");
      assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", uri)).status, "untrusted");
      assert.equal((await vscode.commands.executeCommand("robotCompanion.runTest", uri.toString(), "Sample")).status, "untrusted");
      await assert.rejects(environment.save(uri, { version: 1, kind: "python", path: process.env.ROBOT_ENV_PROVIDER_PYTHON }), /Trust/);
      assert.equal(await environment.install(uri, { kind: "python", executable: process.env.ROBOT_ENV_PROVIDER_PYTHON, availability: { state: "missingRobot" } }), false);
      await environment.refreshStatus(); await sleep(200);
      assert.equal(calls.length, 0, "Restricted activation/picker/selection/run/install must spawn nothing");
      assert(!fs.existsSync(process.env.ROBOT_ENV_PROVIDER_ACTIVATIONS), "Python provider must not activate");
      summary.assertions = 8;
    } else {
      for (const [index, folder] of folders.entries()) {
        const file = vscode.Uri.file(path.join(folder.uri.fsPath, "sample.robot"));
        await vscode.window.showTextDocument(file);
        const executable = path.join(folder.uri.fsPath, ".venv/bin/python");
        await environment.save(file, { version: 1, kind: "python", path: executable, label: ".venv" });
        assert.equal(environment.saved(file).path, executable);
        for (const command of ["robotCompanion.runSuite", "robotCompanion.runTest"]) {
          const result = await vscode.commands.executeCommand(command, file.toString(), "Sample");
          assert.equal(result.executable, executable); assert.deepStrictEqual(result.args.slice(0, 2), ["-m", "robot"]); summary.assertions += 3;
        }
        summary[`root${index}`] = { scope: environment.scope(file), selection: environment.saved(file) };
      }
      // Real synthetic extension boundary; never reported as genuine ms-python evidence.
      const file = uri; await vscode.window.showTextDocument(file);
      await environment.save(file, { version: 1, kind: "pythonExtension" });
      let current = await environment.resolve(file, true); assert.equal(current.executable, process.env.ROBOT_ENV_PROVIDER_PYTHON);
      const provider = vscode.extensions.getExtension("ms-python.python").exports;
      const next = path.join(folders[1].uri.fsPath, ".venv/bin/python"); provider.setTestPath(next); await sleep(200);
      current = await environment.resolve(file, true); assert.equal(current.executable, next);
      await environment.refreshStatus();
      assert(environment.status.text.startsWith("Robot: Python extension (3.13.7)"), environment.status.text); assert(environment.status.tooltip.includes(next), environment.status.tooltip);
      assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", file)).executable, next);
      provider.setTestPath(undefined); await sleep(100);
      await environment.refreshStatus();
      assert(environment.status.text.endsWith(" — unavailable"), environment.status.text);
      assert(environment.status.tooltip.includes("Unavailable") && !environment.status.tooltip.includes(next), environment.status.tooltip);
      const spawnsBefore = calls.length;
      assert.equal((await vscode.commands.executeCommand("robotCompanion.runSuite", file)).status, "environmentUnavailable");
      assert.equal(calls.length, spawnsBefore, "An unavailable Python-extension source runs nothing");
      assert.equal(environment.saved(file).kind, "pythonExtension"); summary.assertions += 10;
      summary.syntheticProvider = true;
    }
    summary.memento = environment.context.workspaceState.keys().map(key => [key, environment.context.workspaceState.get(key)]);
    console.log(`ENVIRONMENT HOST ${stage}: ${summary.assertions} assertions passed`);
  } finally {
    cdp?.close(); cp.spawn = spawn;
    const dir = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
    if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${stage}.json`), JSON.stringify({ ...summary, calls }, null, 2)); }
  }
}
module.exports = { run };

"use strict";

// Robot Companion: Install or Update Backend. Adds the robot-companion-backend build
// bundled with this extension (bundled-backend/) to a folder's selected project
// interpreter, so installing the extension and selecting the project's Python is the
// whole setup. A modal names the interpreter, what is added or replaced and what stays
// unchanged; nothing runs until the user confirms. Then the owned, cancellable
// `<python> -m pip install --no-index --no-deps` installs only the bundled wheels
// (debugpy only when the environment has none), and the environment probe compares the
// installed backend files with the bundled build before the services restart.
// Python, Robot Framework, RobotCode and every other installed package stay as they are.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { execute } = require("../features/run/environment-process");
const { formatCommandLine } = require("../features/run/runner-core");
const { assess, bundledBackend, ACTIONS, describeIdentity } = require("./project-environment");

const COMMAND = "robotCompanion.installBackend";
const RETRY = "Retry", OUTPUT = "Show Output", SELECT = "Select Robot Environment";
const TIMEOUT = 300000;

const short = sha => sha.slice(0, 12);

// The wheels to install for this identity, after checking their bytes against the manifest.
function plan(identity, manifest = bundledBackend()) {
  const wheels = [{ ...manifest.backend, purpose: "Robot Companion's language, discovery and debug services" }];
  const debugpy = manifest.dependencies.find(item => item.distribution === "debugpy");
  if (debugpy && !identity.debugpy) wheels.push({ ...debugpy });
  for (const wheel of wheels) {
    const file = path.join(manifest.directory, wheel.wheel);
    let actual;
    try { actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { actual = "missing"; }
    if (actual !== wheel.sha256) {
      throw new Error(`The bundled ${wheel.wheel} does not match its manifest (expected sha256 ${short(wheel.sha256)}, found ${actual === "missing" ? "no file" : short(actual)}). Reinstall the Robot Companion extension.`);
    }
    wheel.file = file;
  }
  return wheels;
}

// pip installs exactly these files: no index, no dependency resolution; PIP_USER=0 (set by
// install) keeps it from falling back to the user site when site-packages is not writable.
function pipArguments(wheels) {
  return ["-m", "pip", "install", "--no-index", "--no-deps", "--force-reinstall", "--no-cache-dir",
    "--disable-pip-version-check", "--no-input", ...wheels.map(wheel => wheel.file)];
}

// The confirmation text: interpreter, what changes and what stays unchanged.
function consent(folder, interpreter, identity, verdict, wheels, manifest = bundledBackend()) {
  const backend = identity.backend, bundled = manifest.backend;
  const lines = [`Folder: ${folder.name}`, `Interpreter: ${interpreter} (Python ${identity.python}, Robot Framework ${identity.robot})`];
  lines.push(backend ?
    `Replaces: ${bundled.distribution} ${backend.version || "(without version metadata)"} (sha256 ${short(backend.sha256)}, ${backend.files} files) with the bundled ${bundled.version} build (sha256 ${short(bundled.installedFiles.sha256)}, ${bundled.installedFiles.files} files)` :
    `Adds: ${bundled.distribution} ${bundled.version} (bundled build, sha256 ${short(bundled.installedFiles.sha256)}, ${bundled.installedFiles.files} files)`);
  for (const wheel of wheels.slice(1)) lines.push(`Adds: ${wheel.distribution} ${wheel.version} (${wheel.purpose})`);
  const kept = [`Python ${identity.python}`, `Robot Framework ${identity.robot}`,
    ...(identity.debugpy ? [`debugpy ${identity.debugpy}`] : []), ...(identity.robotcode ? [`RobotCode ${identity.robotcode}`] : [])];
  lines.push(`Unchanged: ${kept.join(", ")} and every other installed package.`);
  if (identity.debugpy && identity.debugpy !== manifest.dependencies.find(item => item.distribution === "debugpy")?.version) {
    lines.push(`Python debugging in Robot runs needs debugpy ${manifest.dependencies[0].version}; debugpy ${identity.debugpy} is left as it is.`);
  }
  lines.push(`Command: ${formatCommandLine(interpreter, pipArguments(wheels))}`,
    "Nothing is downloaded: pip installs only the files bundled with this Robot Companion version.");
  return { title: `${verdict.action === "install" ? "Install" : "Update"} the Robot Companion backend in this Python environment?`,
    detail: lines.join("\n") };
}

// The last informative line of a failed pip run, and a next step for the common causes.
function failure(result, interpreter) {
  if (result.state === "cancelled") return "the installation was cancelled";
  if (result.state === "timedOut") return `pip did not finish within ${TIMEOUT / 60000} minutes`;
  if (result.state === "unavailable") return `${interpreter} does not exist or cannot start`;
  const output = (result.output || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (output.some(line => /No module named pip\b/.test(line))) {
    return `pip is not available in ${interpreter}. Add pip to that environment (for example \`${interpreter} -m ensurepip\`), then choose Retry`;
  }
  const error = [...output].reverse().find(line => /^ERROR:|Error:/.test(line)) || output[output.length - 1];
  return `pip exited with ${result.state ? result.state : `code ${result.code}`}${error ? `: ${error}` : ""}`;
}

class BackendInstaller {
  constructor(environments) {
    this.environments = environments;
    this.channel = vscode.window.createOutputChannel("Robot Companion Backend");
    this.running = undefined;
    this.subscriptions = [vscode.commands.registerCommand(COMMAND, uri => this.run(uri))];
  }

  async folder(uri) {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const folder = target && vscode.workspace.getWorkspaceFolder(target);
    if (folder) return folder;
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder: "Install or update the Robot Companion backend for which folder?" });
  }

  log(folder, text) {
    this.channel.appendLine(`[${new Date().toISOString()}] [${folder.name}] ${text}`);
  }

  // The whole guided flow; returns true when the bundled build is installed and verified.
  async run(uri) {
    const folder = await this.folder(uri);
    if (!folder) return false;
    if (vscode.workspace.isTrusted === false) {
      void vscode.window.showErrorMessage("Trust this workspace to install the Robot Companion backend.");
      return false;
    }
    if (this.running) {
      void vscode.window.showInformationMessage(`The Robot Companion backend is already being installed in ${this.running}.`);
      return false;
    }
    const before = await this.environments.inspect(folder);
    const interpreter = before.selected?.executable;
    if (before.origin !== "interpreter") {
      const why = before.origin === "descriptor" ? "an explicit robotCompanion.languageBackend descriptor" :
        before.origin === "setting" ? "robotCompanion.nativeBackendExecutable" : "no selected Python interpreter";
      const choice = await vscode.window.showWarningMessage(`Install Backend adds the backend to a folder's selected Python interpreter; folder '${folder.name}' uses ${why}. ` +
        "Select the project's Python interpreter first.", SELECT);
      if (choice === SELECT) void vscode.commands.executeCommand("robotCompanion.selectRobotEnvironment");
      return false;
    }
    if (!before.identity) {
      void vscode.window.showErrorMessage(`The Robot Companion backend cannot be installed for folder '${folder.name}': ${before.error}`, SELECT)
        .then(choice => { if (choice === SELECT) void vscode.commands.executeCommand("robotCompanion.selectRobotEnvironment"); });
      return false;
    }
    const verdict = assess(before.identity, interpreter);
    this.log(folder, `Checked ${describeIdentity(before.identity)}: ${verdict.state}${verdict.reason ? ` — ${verdict.reason}` : ""}`);
    if (verdict.state === "ready") {
      void vscode.window.showInformationMessage(`The Robot Companion backend in ${interpreter} is the bundled build ` +
        `(sha256 ${short(before.identity.backend.sha256)}, ${before.identity.backend.files} files). Nothing to install.`);
      return true;
    }
    if (!verdict.action) {
      void vscode.window.showErrorMessage(`The bundled Robot Companion backend cannot fix folder '${folder.name}': ${verdict.reason}`, SELECT)
        .then(choice => { if (choice === SELECT) void vscode.commands.executeCommand("robotCompanion.selectRobotEnvironment"); });
      return false;
    }
    let wheels;
    try { wheels = plan(before.identity); } catch (error) {
      void vscode.window.showErrorMessage(error.message);
      return false;
    }
    const button = ACTIONS[verdict.action].button;
    const text = consent(folder, interpreter, before.identity, verdict, wheels);
    const choice = await vscode.window.showWarningMessage(text.title, { modal: true, detail: text.detail }, button);
    if (choice !== button) {
      this.log(folder, `${button} was not confirmed; nothing was changed.`);
      return false;
    }
    // Confirmed: the folder must still select the same interpreter in a trusted workspace.
    const current = await this.environments.inspect(folder);
    if (vscode.workspace.isTrusted === false || current.signature !== before.signature || this.running) {
      void vscode.window.showErrorMessage(`The Robot Companion backend was not installed: ${vscode.workspace.isTrusted === false ?
        "workspace trust is required" : this.running ? "another installation is running" : "the folder's Robot environment changed"}.`);
      return false;
    }
    return this.install(folder, interpreter, before.identity, wheels, verdict.action);
  }

  async install(folder, interpreter, identity, wheels, action) {
    const args = pipArguments(wheels);
    this.running = interpreter;
    this.log(folder, `Running ${formatCommandLine(interpreter, args)}`);
    let result;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: `${action === "install" ? "Installing" : "Updating"} the Robot Companion backend in ${interpreter}` }, (_, token) =>
        execute({ executable: interpreter }, args, bundledBackend().directory, () => vscode.workspace.isTrusted !== false,
          { timeout: TIMEOUT, outputLimit: Infinity, token, env: { PIP_USER: "0" },
            onOutput: chunk => this.channel.append(chunk) }));
    } finally {
      this.running = undefined;
    }
    this.log(folder, `pip finished: ${result.state || `exit ${result.code}`}`);
    // Whatever pip did, the environment is checked again and that state is reported.
    const after = await this.environments.inspect(folder);
    const verdict = after.identity ? assess(after.identity, interpreter) : { state: "unknown", reason: after.error };
    this.log(folder, `Verification: ${after.identity ? describeIdentity(after.identity) : after.error}: ${verdict.state}${verdict.reason ? ` — ${verdict.reason}` : ""}`);
    const debugpyChanged = after.identity && after.identity.debugpy !== identity.debugpy;
    const changed = !after.identity || JSON.stringify(after.identity.backend) !== JSON.stringify(identity.backend) || debugpyChanged;
    if (result.code === 0 && !result.state && verdict.state === "ready") {
      const backend = after.identity.backend;
      void vscode.window.showInformationMessage(`Robot Companion backend ${backend.version} is installed in ${interpreter} and matches the bundled build ` +
        `(sha256 ${short(backend.sha256)}, ${backend.files} files). Native services are starting.`);
      await this.environments.installed(interpreter);
      return true;
    }
    if (verdict.state === "ready") await this.environments.installed(interpreter);
    const reason = result.code === 0 && !result.state ?
      `the installed files do not match the bundled build: ${(verdict.reason || verdict.state).replace(/\.$/, "")}` : failure(result, interpreter);
    const state = verdict.state === "ready" ? " The backend in that environment is nevertheless the bundled build." :
      !changed ? " Nothing in that environment was changed." :
      ` The environment now reports: ${(verdict.reason || verdict.state).replace(/\.$/, "")}. Retry installs the bundled build again.`;
    const message = result.state === "cancelled" ?
      `Robot Companion backend ${action === "install" ? "installation" : "update"} in ${interpreter} was cancelled.${state}` :
      `Could not ${action} the Robot Companion backend in ${interpreter}: ${reason}.${state}`;
    this.log(folder, message);
    const show = result.state === "cancelled" ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
    void show(message, RETRY, OUTPUT).then(choice => {
      if (choice === RETRY) void vscode.commands.executeCommand(COMMAND, folder.uri);
      if (choice === OUTPUT) this.channel.show(true);
    });
    return false;
  }

  dispose() {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.channel.dispose();
  }
}

module.exports = { BackendInstaller, COMMAND, plan, pipArguments, consent, failure };

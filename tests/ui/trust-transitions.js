"use strict";

// Workspace trust transitions of the owned providers in a normal VS Code window:
// workspace trust enabled, no test runner (test-electron always passes
// --disable-workspace-trust). Run once per provider (the pinned RobotCode 2.7.0
// bridge and the native backend), each selected for both languageBackend and
// executionBackend. Actual clicks through CDP:
//   1. Restricted Mode: no backend process starts for the folder.
//   2. Manage > Trust: the owned language process starts.
//   3. Don't Trust: the extension host restarts and every owned process is gone.
// Run under a display, for example `xvfb-run -a npm run test:trust`. A provider
// whose prepared environment is absent is reported "SKIPPED" (exit 0).
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repository = path.resolve(__dirname, "../..");
const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function vscodeExecutable() {
  if (process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE) return process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE;
  const cache = path.join(repository, ".vscode-test");
  const build = fs.existsSync(cache) && fs.readdirSync(cache).find(name => name.startsWith("vscode-linux"));
  if (!build) throw new Error("Set ROBOT_COMPANION_VSCODE_EXECUTABLE or link a VS Code build into .vscode-test.");
  return path.join(cache, build, "code");
}

// Owned backend processes of either provider whose working directory is `folder`:
// RobotCode (language server, debug launcher, discovery) or the native backend
// (lsp, dap, Robot worker, debugpy adapter). `language` marks the language service.
function backendProcesses(folder) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const robotCode = argv.includes("robotcode.cli");
      const native = argv.some(arg => arg.endsWith("/robot-companion-backend")) || argv.includes("robot_companion_backend") || argv.includes("robot_companion_backend.worker") ||
        argv.includes("debugpy.adapter");
      if (!robotCode && !native) continue;
      if (fs.realpathSync(`/proc/${pid}/cwd`) !== folder) continue;
      const parent = Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
      found.push({ pid: Number(pid), parent, argv: argv.filter(Boolean),
        language: argv.includes("language-server") || argv[argv.length - 2] === "lsp" || argv[argv.length - 1] === "lsp" });
    } catch { /* Process ended while reading. */ }
  }
  return found;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  for (const provider of ["robotcode", "native"]) await transitions(provider);
}

async function transitions(provider) {
  let nativeExecutable;
  if (provider === "robotcode" && !fs.existsSync(python)) {
    console.log(`SKIPPED (robotcode): RobotCode 2.7.0 environment absent at ${python}`);
    return;
  }
  if (provider === "native") {
    const native = require("../native-backend").nativeBackend();
    if (native.skip) { console.log(`SKIPPED (native): ${native.skip}`); return; }
    nativeExecutable = native.executable;
  }
  const { robotCodeDescriptor } = require(path.join(repository, "src/integration/robotcode-bridge"));
  const { nativeDescriptor } = require(path.join(repository, "src/integration/native-backend"));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-trust-")));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-trust-profile-"));
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR || "";
  if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
  const evidence = [];
  fs.cpSync(path.join(repository, "tests/integration/fixtures/audit-v1"), folder, { recursive: true });
  fs.mkdirSync(path.join(folder, ".vscode"));
  const base = { workspaceUri: `file://${folder}`, cwd: folder };
  const descriptor = provider === "native"
    ? nativeDescriptor({ ...base, executable: nativeExecutable, services: ["language", "debug"] })
    : robotCodeDescriptor({ ...base, python, services: ["language", "debug", "discovery"] });
  fs.writeFileSync(path.join(folder, ".vscode/settings.json"), JSON.stringify({
    "robotCompanion.integrationMode": "owned", "robotCompanion.languageBackend": descriptor,
    "robotCompanion.executionBackend": descriptor }, null, 2));
  const label = provider === "native" ? "native backend" : "RobotCode";
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User/settings.json"), JSON.stringify({
    // Open untrusted folders in Restricted Mode without the startup dialog.
    "security.workspace.trust.startupPrompt": "never",
    "security.workspace.trust.banner": "always",
    "workbench.startupEditor": "none",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off"
  }, null, 2));

  const code = childProcess.spawn(vscodeExecutable(), [folder, "--new-window", "--no-sandbox", "--disable-gpu-sandbox",
    "--disable-updates", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(userData, "extensions")}`, "--remote-debugging-port=0",
    `--extensionDevelopmentPath=${repository}`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let codeLog = "";
  code.stdout.on("data", chunk => { codeLog += chunk; });
  code.stderr.on("data", chunk => { codeLog += chunk; });
  let cdp, failed = false;
  try {
    await until(() => fs.existsSync(path.join(userData, "DevToolsActivePort")), "VS Code DevTools endpoint");
    process.env.ROBOT_COMPANION_UI_USER_DATA_DIR = userData;
    const { WebviewCdp } = require("./suite/webview-cdp");
    cdp = await until(() => WebviewCdp.connect().catch(() => undefined), "workbench page");
    const page = async expression => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdp.pageSession);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const screenshot = async name => {
      if (!evidenceDirectory) return;
      const { data } = await cdp.send("Page.captureScreenshot", {}, cdp.pageSession);
      fs.writeFileSync(path.join(evidenceDirectory, `${name}.png`), Buffer.from(data, "base64"));
    };
    // Pointer click on the first visible element matching `finder`; the point must hit it.
    const click = async (finder, label) => {
      const point = await until(() => page(`(() => {
        const element = (${finder})();
        if (!element || !element.getClientRects().length) return;
        const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === element || element.contains(hit)) ? { x, y } : undefined;
      })()`), `visible ${label}`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, cdp.pageSession);
      await sleep(150);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1 }, cdp.pageSession);
      }
      evidence.push({ action: "click", target: label, point });
    };
    const restricted = () => page(`[...document.querySelectorAll('.part.banner, .statusbar-item')]
      .some(e => /Restricted Mode/.test(e.textContent || e.getAttribute('aria-label') || ''))`);
    const button = text => `() => [...document.querySelectorAll('.workspace-trust-editor .monaco-button')]
      .find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length)`;

    // 1. Restricted Mode: the window is up, the extension host runs, no RobotCode process.
    await until(restricted, "Restricted Mode banner", 60000);
    const viewport = await page(`({ width: innerWidth, height: innerHeight })`);
    await until(() => page(`Boolean(document.querySelector('.activitybar [aria-label^="Robot Companion"]'))`),
      "Robot Companion activity bar entry");
    await sleep(10000); // Activation and any (wrong) backend start have time to happen.
    const restrictedProcesses = backendProcesses(folder);
    await screenshot(`trust-${provider}-1-restricted`);
    evidence.push({ provider, phase: "restricted", viewport, backendProcesses: restrictedProcesses });
    if (restrictedProcesses.length) throw new Error(`Restricted Mode started a ${label} process: ${JSON.stringify(restrictedProcesses)}`);

    // 2. Manage > Trust starts the owned RobotCode process.
    await click(`() => [...document.querySelectorAll('.part.banner a, .part.banner .monaco-link')]
      .find(a => a.textContent.trim() === 'Manage')`, "Restricted Mode banner: Manage");
    await click(button("Trust"), "Workspace Trust editor: Trust");
    const started = await until(() => backendProcesses(folder).find(item => item.language), `${label} language process after Trust`, 60000);
    await until(async () => !await restricted(), "Restricted Mode indicator gone");
    await screenshot(`trust-${provider}-2-trusted`);
    evidence.push({ provider, phase: "trusted", language: started, extensionHost: started.parent });

    // 3. Don't Trust restarts the extension host; the owned process is gone.
    await click(button("Don't Trust"), "Workspace Trust editor: Don't Trust");
    const dialog = await until(() => page(`document.querySelector('.monaco-dialog-box')?.innerText || ''`), "dialog", 3000)
      .catch(() => "");
    if (dialog) {
      evidence.push({ dialog });
      await click(`() => document.querySelector('.monaco-dialog-box .dialog-buttons .monaco-button')`, "dialog primary button");
    }
    await until(() => !alive(started.pid), `owned ${label} process gone`, 30000);
    await until(() => !alive(started.parent), "previous extension host gone", 30000);
    await until(restricted, "Restricted Mode again", 30000);
    await sleep(10000); // The restarted extension host must not start a backend again.
    const afterRevoke = backendProcesses(folder);
    await screenshot(`trust-${provider}-3-revoked`);
    evidence.push({ provider, phase: "revoked", languageGone: started.pid, extensionHostGone: started.parent, backendProcesses: afterRevoke });
    if (afterRevoke.length) throw new Error(`${label} running after Don't Trust: ${JSON.stringify(afterRevoke)}`);
    console.log(`PASS (${provider}): Restricted Mode starts no ${label} process; Trust starts it; Don't Trust restarts the extension host and it is gone.`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${error.message}`);
    console.error(`Workspace preserved at ${folder}`);
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(evidence, null, 2));
    if (evidenceDirectory) {
      fs.writeFileSync(path.join(evidenceDirectory, `trust-transitions-${provider}.json`), JSON.stringify(evidence, null, 2));
      fs.writeFileSync(path.join(evidenceDirectory, `trust-transitions-${provider}-vscode.log`), codeLog);
    }
    cdp?.close();
    try { process.kill(-code.pid, "SIGTERM"); } catch { /* Already gone. */ }
    await sleep(1000);
    try { process.kill(-code.pid, "SIGKILL"); } catch { /* Already gone. */ }
    for (const leftover of backendProcesses(folder)) process.kill(leftover.pid, "SIGKILL");
    if (!failed) fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

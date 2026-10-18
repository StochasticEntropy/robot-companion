"use strict";

// Workspace trust transitions of the owned RobotCode 2.7.0 language bridge in a
// normal VS Code window: workspace trust enabled, no test runner (test-electron
// always passes --disable-workspace-trust). Actual clicks through CDP:
//   1. Restricted Mode: no RobotCode process starts for the folder.
//   2. Manage > Trust: the owned RobotCode process starts.
//   3. Don't Trust: the extension host restarts and the owned process is gone.
// Run under a display, for example `xvfb-run -a npm run test:trust`. Skipped
// (exit 0, "SKIPPED") when the prepared RobotCode environment is absent.
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

// Owned RobotCode language-server processes whose working directory is `folder`.
function robotCodeProcesses(folder) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!argv.includes("robotcode.cli") || !argv.includes("language-server")) continue;
      if (fs.realpathSync(`/proc/${pid}/cwd`) !== folder) continue;
      const parent = Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
      found.push({ pid: Number(pid), parent, argv: argv.filter(Boolean) });
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
  if (!fs.existsSync(python)) {
    console.log(`SKIPPED: RobotCode 2.7.0 environment absent at ${python}`);
    return;
  }
  const { robotCodeDescriptor } = require(path.join(repository, "src/integration/robotcode-bridge"));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-trust-")));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-trust-profile-"));
  const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR || "";
  if (evidenceDirectory) fs.mkdirSync(evidenceDirectory, { recursive: true });
  const evidence = [];
  fs.cpSync(path.join(repository, "tests/integration/fixtures/audit-v1"), folder, { recursive: true });
  fs.mkdirSync(path.join(folder, ".vscode"));
  const descriptor = robotCodeDescriptor({ workspaceUri: `file://${folder}`, cwd: folder, python });
  fs.writeFileSync(path.join(folder, ".vscode/settings.json"), JSON.stringify({
    "robotCompanion.integrationMode": "owned", "robotCompanion.languageBackend": descriptor }, null, 2));
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
    const restrictedProcesses = robotCodeProcesses(folder);
    await screenshot("trust-1-restricted");
    evidence.push({ phase: "restricted", viewport, robotCodeProcesses: restrictedProcesses });
    if (restrictedProcesses.length) throw new Error(`Restricted Mode started RobotCode: ${JSON.stringify(restrictedProcesses)}`);

    // 2. Manage > Trust starts the owned RobotCode process.
    await click(`() => [...document.querySelectorAll('.part.banner a, .part.banner .monaco-link')]
      .find(a => a.textContent.trim() === 'Manage')`, "Restricted Mode banner: Manage");
    await click(button("Trust"), "Workspace Trust editor: Trust");
    const started = await until(() => robotCodeProcesses(folder)[0], "RobotCode process after Trust", 60000);
    await until(async () => !await restricted(), "Restricted Mode indicator gone");
    await screenshot("trust-2-trusted");
    evidence.push({ phase: "trusted", robotCode: started, extensionHost: started.parent });

    // 3. Don't Trust restarts the extension host; the owned process is gone.
    await click(button("Don't Trust"), "Workspace Trust editor: Don't Trust");
    const dialog = await until(() => page(`document.querySelector('.monaco-dialog-box')?.innerText || ''`), "dialog", 3000)
      .catch(() => "");
    if (dialog) {
      evidence.push({ dialog });
      await click(`() => document.querySelector('.monaco-dialog-box .dialog-buttons .monaco-button')`, "dialog primary button");
    }
    await until(() => !alive(started.pid), "owned RobotCode process gone", 30000);
    await until(() => !alive(started.parent), "previous extension host gone", 30000);
    await until(restricted, "Restricted Mode again", 30000);
    await sleep(10000); // The restarted extension host must not start RobotCode again.
    const afterRevoke = robotCodeProcesses(folder);
    await screenshot("trust-3-revoked");
    evidence.push({ phase: "revoked", robotCodeGone: started.pid, extensionHostGone: started.parent, robotCodeProcesses: afterRevoke });
    if (afterRevoke.length) throw new Error(`RobotCode running after Don't Trust: ${JSON.stringify(afterRevoke)}`);
    console.log("PASS: Restricted Mode starts no RobotCode process; Trust starts it; Don't Trust restarts the extension host and it is gone.");
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${error.message}`);
    console.error(`Workspace preserved at ${folder}`);
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(evidence, null, 2));
    if (evidenceDirectory) {
      fs.writeFileSync(path.join(evidenceDirectory, "trust-transitions.json"), JSON.stringify(evidence, null, 2));
      fs.writeFileSync(path.join(evidenceDirectory, "trust-transitions-vscode.log"), codeLog);
    }
    cdp?.close();
    try { process.kill(-code.pid, "SIGTERM"); } catch { /* Already gone. */ }
    await sleep(1000);
    try { process.kill(-code.pid, "SIGKILL"); } catch { /* Already gone. */ }
    for (const leftover of robotCodeProcesses(folder)) process.kill(leftover.pid, "SIGKILL");
    if (!failed) fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

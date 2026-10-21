// Owned VS Code hosts without the extension test runner, driven from outside over CDP. Hosts started
// with --extensionTestsPath refuse modal prompts and keep storage in memory, so confirmation and
// restart journeys need a normal window. Custom dialog style renders modals in the workbench DOM;
// Linux's default native GTK dialog is outside CDP.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const SOURCE = path.resolve(__dirname, "../..");
const PILOT_VSCODE = "/opt/vscode-test/vscode-linux-arm64-1.141.0/code";

// The offline pilot has VS Code preinstalled; elsewhere test-electron downloads it, as for test:ui.
async function vscodeExecutable() {
  if (process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE) return process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE;
  return fs.existsSync(PILOT_VSCODE) ? PILOT_VSCODE : downloadAndUnzipVSCode("1.141.0");
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A controlled recorder standing in for a Python interpreter; see tests/fixtures/environment.
function writeRecorder(file, mode = "healthy") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fixture = fs.readFileSync(path.join(SOURCE, "tests/fixtures/environment/synthetic-python.js"), "utf8").replace("#!/usr/bin/env node", `#!${process.execPath}`);
  fs.writeFileSync(file, fixture, { mode: 0o755 });
  fs.writeFileSync(path.join(path.dirname(file), "mode"), mode);
  return file;
}

function recorderCalls(file) {
  const log = path.join(path.dirname(file), "calls.jsonl");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function launchHost({ name, profile, extensions, targets, ready, timeout = 150000 }) {
  fs.mkdirSync(path.join(profile, "User"), { recursive: true });
  fs.writeFileSync(path.join(profile, "User/settings.json"), JSON.stringify({ "window.restoreWindows": "none", "workbench.startupEditor": "none", "window.dialogStyle": "custom" }));
  fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true }); // A relaunch must not reuse the old port.
  const args = [...targets, "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, "--remote-debugging-port=0", `--extensionDevelopmentPath=${SOURCE}`];
  const executable = await vscodeExecutable();
  console.log(`${name} host: ${executable} (no extension test runner)`);
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "inherit"], detached: true });
  let closed = false;
  const exited = new Promise(resolve => child.on("close", () => { closed = true; resolve(); }));
  const stop = () => {
    for (const [signal, delay] of [["SIGTERM", 0], ["SIGKILL", 3000]]) setTimeout(() => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } }, delay).unref();
  };
  const watchdog = setTimeout(() => { console.error(`${name} host timeout`); stop(); }, timeout);
  process.env.ROBOT_COMPANION_UI_USER_DATA_DIR = profile;
  const { EnvironmentCdp } = require("./suite/environment-cdp");
  let cdp;
  const close = async () => { cdp?.close(); clearTimeout(watchdog); stop(); await Promise.race([exited, sleep(5000)]); };
  try {
    for (let i = 0; !fs.existsSync(path.join(profile, "DevToolsActivePort")); i++) { if (i > 300) throw new Error("No DevTools endpoint"); await sleep(100); }
    for (let i = 0; !cdp; i++) { try { cdp = await EnvironmentCdp.connect(); } catch (error) { if (i > 100) throw error; await sleep(200); } }
    // The workbench may still be navigating; evaluation errors only mean "not ready yet".
    for (const end = Date.now() + 60000; ; await sleep(250)) {
      try { if (await cdp.eval(ready)) break; } catch (error) { if (Date.now() > end) throw error; }
      if (Date.now() > end) throw new Error(`${name} host did not become ready`);
    }
  } catch (error) { await close(); throw error; }
  // Graceful exit runs VS Code's shutdown, which flushes workspace storage to disk. On Linux,
  // File > Exit (workbench.action.quit) is keybinding-only: Ctrl+Q.
  const quit = async () => {
    for (const type of ["keyDown", "keyUp"]) await cdp.cdp.send("Input.dispatchKeyEvent", { type, key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 2 }, cdp.cdp.pageSession);
    await Promise.race([exited, sleep(20000)]);
    const graceful = closed;
    await close();
    if (!graceful) throw new Error(`${name} host did not exit through Ctrl+Q`);
  };
  return { cdp, close, quit };
}

module.exports = { launchHost, recorderCalls, writeRecorder, sleep, vscodeExecutable };

// Disconnect cleanup on the extension host that runs Robot Companion. On a remote, WSL or container
// host the extension host stays on that machine; when the window disconnects for longer than the
// reconnection grace, or the host crashes, it ends without deactivate. Here the same happens to a
// local extension host: it is killed (SIGKILL) while Robot Companion owns live processes in two
// folders with different runtimes:
//   language and discovery services (both folders), a debug adapter and Robot worker paused at a
//   breakpoint (A), a Test Explorer run (A, its own process group) and a CodeLens Run Test (B).
// Every one of them, and the process guard's helper, must end within seconds. (This development
// window then closes itself, with or without the guard; it is not used again.) A relaunch with the
// same profile starts the same work, and a graceful Ctrl+Q ends everything too.
// Each folder's robotCommand is a folder setting naming its own interpreter (machine-overridable
// settings still resolve per folder). Real input over CDP. Run under a display (xvfb-run -a).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchHost, sleep } = require("./cdp-host");
const { projectEnvironment } = require("../native-backend");

const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
const transcript = [];
const note = (step, data = {}) => { transcript.push({ at: new Date().toISOString(), step, ...data }); console.log(`- ${step}`); };

async function until(predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(200);
  }
}

function all() {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      let cwd = ""; try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch { /* No access. */ }
      found.push({ pid: Number(pid), ppid: Number(fields[1]), pgid: Number(fields[2]), argv, cwd });
    } catch { /* Ended while reading. */ }
  }
  return found;
}
const alive = pid => all().some(item => item.pid === pid);
const short = item => ({ pid: item.pid, ppid: item.ppid, pgid: item.pgid, cwd: path.basename(item.cwd), argv: item.argv.join(" ").slice(0, 200) });

async function main() {
  // Only a journey that reaches its last check passes (a stalled host must not exit 0).
  process.exitCode = 1;
  const envA = projectEnvironment({ python: "/opt/python3.11/bin/python3.11", wheels: "/opt/robot-wheels-py311" });
  const envB = projectEnvironment({ python: "python3.13", wheels: "/opt/robot-wheels" });
  if (envA.skip || envB.skip) { console.log(`SKIPPED: ${envA.skip || envB.skip}`); process.exitCode = 0; return; }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-host-disconnect-")));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const roots = { A: path.join(scratch, "Alpha"), B: path.join(scratch, "Beta") };
  for (const [key, root] of Object.entries(roots)) {
    const env = key === "A" ? envA : envB;
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.symlinkSync(env.venv, path.join(root, ".venv"), "dir");
    fs.writeFileSync(path.join(root, "long.robot"), `*** Test Cases ***\nLong ${key}\n    Sleep    600s\n`);
    fs.writeFileSync(path.join(root, ".vscode/settings.json"), JSON.stringify({ "robotCompanion.robotCommand": `${path.join(root, ".venv/bin/python")} -m robot` }));
  }
  fs.writeFileSync(path.join(roots.A, "paused.robot"), "*** Test Cases ***\nPaused A\n    No Operation\n    Log    after the breakpoint\n");
  fs.writeFileSync(path.join(roots.A, ".vscode/launch.json"), JSON.stringify({ version: "0.2.0", configurations: [{ type: "robotcompanion",
    request: "launch", name: "Debug Paused A", target: "${workspaceFolder}/paused.robot", attachPython: false }] }, null, 2));
  const workspace = path.join(scratch, "disconnect.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: roots.A }, { path: roots.B }] }));
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
  // Everything Robot Companion started for these folders, and the guard's helper.
  const owned = () => all().filter(item => item.cwd.startsWith(scratch + path.sep) || item.argv.some(arg => arg.endsWith("process-guard-helper.js")));
  const service = (key, name) => owned().find(item => item.cwd === roots[key] && item.argv[item.argv.length - 1] === name && item.argv.some(arg => arg.endsWith("/robot-companion-backend")));
  const robotRun = key => owned().find(item => item.cwd === roots[key] && item.argv.includes("-m") && item.argv.includes("robot") && item.argv.some(arg => arg.endsWith("long.robot")));
  let host;
  const retain = name => host.cdp.retain(`host-disconnect-${name}`);
  const open = async (key, file) => {
    await host.cdp.palette("Go to File");
    await host.cdp.text(path.join(roots[key], file));
    await host.cdp.wait(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(file)})`);
    await host.cdp.key("Enter");
    await host.cdp.wait(`document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label')?.startsWith(${JSON.stringify(file)})`, 20000);
    await sleep(500);
  };
  const tokenPoint = needle => host.cdp.wait(`(() => {
    for (const line of document.querySelectorAll('.editor-instance .monaco-editor .view-lines .view-line')) {
      const at = line.textContent.replace(/\\u00a0/g, ' ').indexOf(${JSON.stringify(needle)});
      if (at < 0) continue;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let offset = at + 1, node;
      while ((node = walker.nextNode())) { if (offset < node.length) break; offset -= node.length; }
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const r = range.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : false;
    }
    return false;
  })()`, 20000);
  // Live work in both folders: services, a paused debug session, a Test Explorer run and a CodeLens run.
  const startWork = async label => {
    const services = await until(() => {
      const found = ["A", "B"].flatMap(key => ["lsp", "discovery"].map(name => service(key, name)));
      return found.every(Boolean) && found;
    }, `${label}: language and discovery services in both folders`, 90000);
    await open("A", "paused.robot");
    if (!await host.cdp.eval("document.querySelectorAll('.editor-instance .codicon-debug-breakpoint').length")) {
      await host.cdp.press(await tokenPoint("Log    after"));
      await host.cdp.key("F9");
      await host.cdp.wait("document.querySelectorAll('.editor-instance .codicon-debug-breakpoint').length >= 1", 10000);
    }
    await host.cdp.palette("Debug: Select and Start Debugging");
    await host.cdp.wait("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(row => row.textContent.includes('Debug Paused A'))");
    await host.cdp.text("Debug Paused A");
    await host.cdp.wait("document.querySelector('.quick-input-widget .monaco-list-row.focused')?.textContent.includes('Debug Paused A')");
    await host.cdp.key("Enter");
    await host.cdp.wait("[...document.querySelectorAll('.pane-header')].some(h => /^Call Stack.*Paused on breakpoint/i.test(h.textContent))", 30000);
    const debug = await until(() => {
      const dap = service("A", "dap"), worker = owned().find(item => item.cwd === roots.A && item.argv.includes("robot_companion_backend.worker"));
      return dap && worker && { dap, worker };
    }, `${label}: A's debug adapter and paused Robot worker`);
    // Test Explorer: Run All starts A's long test (B's waits behind it).
    await host.cdp.palette("Test: Run All Tests");
    const testRun = await until(() => robotRun("A"), `${label}: A's Test Explorer Robot run`, 60000);
    // CodeLens Run Test on B's long test (pointer click).
    await open("B", "long.robot");
    await host.cdp.click("[...document.querySelectorAll('.codelens-decoration a')].find(el => el.textContent.trim() === 'Run Test')");
    const codeLensRun = await until(() => robotRun("B"), `${label}: B's CodeLens Robot run`, 60000);
    const helper = await until(() => owned().find(item => item.argv.some(arg => arg.endsWith("process-guard-helper.js"))), `${label}: process guard helper`);
    return { services, debug, testRun, codeLensRun, helper };
  };

  try {
    host = await launchHost({ name: "host-disconnect", profile, extensions, timeout: 600000, targets: [workspace, path.join(roots.A, "long.robot")], ready: `!!${status}` });
    const work = await startWork("abrupt");
    const extensionHost = all().find(item => item.pid === work.services[0].ppid);
    assert(extensionHost && extensionHost.argv.join(" ").includes("--utility-sub-type=node.mojom.NodeService"), `the services' parent is VS Code's extension host: ${JSON.stringify(extensionHost && short(extensionHost))}`);
    assert(work.services.every(item => item.ppid === extensionHost.pid) && work.testRun.ppid === extensionHost.pid && work.codeLensRun.ppid === extensionHost.pid,
      "the extension host started the services and both runs");
    const before = owned();
    note("live work before the extension host ends", { extensionHost: short(extensionHost), processes: before.map(short) });
    await retain("1-live-work");
    process.kill(extensionHost.pid, "SIGKILL");
    note("SIGKILL to the extension host", { pid: extensionHost.pid });
    const started = Date.now();
    await until(() => before.every(item => !alive(item.pid)), "every process Robot Companion owned has ended", 15000)
      .catch(error => { throw new Error(`${error.message}; left: ${JSON.stringify(before.filter(item => alive(item.pid)).map(short))}`); });
    note("every owned process ended after the extension host was killed", { seconds: (Date.now() - started) / 1000, ended: before.map(item => item.pid) });
    await host.close();

    // A relaunch runs the same work, then a graceful exit.
    host = await launchHost({ name: "host-disconnect-relaunch", profile, extensions, timeout: 600000, targets: [workspace, path.join(roots.A, "long.robot")], ready: `!!${status}` });
    await startWork("relaunch");
    const live = owned();
    note("live work after the relaunch", { processes: live.map(short) });
    await retain("2-relaunch-live-work");
    await host.quit();
    note("Ctrl+Q exit");
    await until(() => live.every(item => !alive(item.pid)), "every owned process ended after Ctrl+Q", 15000)
      .catch(error => { throw new Error(`${error.message}; left: ${JSON.stringify(live.filter(item => alive(item.pid)).map(short))}`); });
    assert.deepStrictEqual(owned().map(short), [], "nothing is left for these folders");
    note("graceful exit ended every owned process");
    process.exitCode = 0;
    console.log("HOST DISCONNECT: a killed extension host and a graceful exit both leave no Robot Companion process behind");
  } catch (error) {
    console.error("Host disconnect check failed:", error); process.exitCode = 1;
    try { await host?.cdp.retain("host-disconnect-failure"); } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "host-disconnect-transcript.json"), JSON.stringify(transcript, null, 2)); }
    await host?.close();
    for (const item of owned()) { try { process.kill(item.pid, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

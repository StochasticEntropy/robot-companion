// One selected project interpreter per folder runs that folder's native language, discovery and
// debug services and its default `python -m robot` runs. Real interpreters, real backend processes
// and a normal VS Code window driven over CDP (status item, picker, typed paths, palette, CodeLens,
// Ctrl+Q restart, Restricted Mode banner and Trust button). Two independent folders:
//   A "Projekt Ä"    — chosen through Enter path…: Python 3.11 + Robot Framework 7.3.2 + backend
//   B "Beta Projekt" — first the .venv backend fallback, then its .venv interpreter (3.13 + RF 7.5)
// Explicit robotCommand and nativeBackendExecutable overrides, an interpreter without the backend,
// persistence across a restart, and Restricted Mode are checked against /proc and files the Robot
// runs write (sys.executable and Robot Framework's version). Run under a display (xvfb-run -a).
const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { launchHost, sleep } = require("./cdp-host");
const { nativeBackend, projectEnvironment } = require("../native-backend");

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

// Native backend processes (module or console-script form) whose working directory is `root`.
function backendProcesses(root) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!argv.includes("robot_companion_backend") && !argv.some(arg => arg.endsWith("/robot-companion-backend"))) continue;
      if (fs.realpathSync(`/proc/${pid}/cwd`) !== root) continue;
      found.push({ pid: Number(pid), argv, service: argv[argv.length - 1] });
    } catch { /* Ended while reading. */ }
  }
  return found;
}
const service = (root, name) => backendProcesses(root).find(item => item.service === name);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Expected values computed independently of the extension: versions from the interpreter itself,
// the digest from the installed files (sorted `path NUL sha256 LF` over robot_companion_backend/).
function expected(python) {
  const [version, robot, pkg] = childProcess.execFileSync(python, ["-c",
    "import sys, robot.version as v, importlib.util as u; s = u.find_spec('robot_companion_backend'); " +
    "print('.'.join(map(str, sys.version_info[:3])), v.VERSION, s.submodule_search_locations[0] if s else '-')"], { encoding: "utf8", cwd: os.tmpdir() }).trim().split(" ");
  if (pkg === "-") return { python: version, robot };
  const names = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`); else names.push(`${prefix}/${entry.name}`);
    }
  };
  walk(pkg, "robot_companion_backend");
  const hash = crypto.createHash("sha256");
  for (const name of names.sort()) hash.update(`${name}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(pkg, ...name.split("/").slice(1)))).digest("hex")}\n`);
  return { python: version, robot, sha256: hash.digest("hex"), files: names.length };
}

async function main() {
  const native = nativeBackend();
  if (native.skip) { console.log(`SKIPPED: ${native.skip}`); return; }
  const env311 = projectEnvironment({ python: "/opt/python3.11/bin/python3.11", wheels: "/opt/robot-wheels-py311" });
  const env311Bare = projectEnvironment({ python: "/opt/python3.11/bin/python3.11", wheels: "/opt/robot-wheels-py311", backend: false });
  if (env311.skip || env311Bare.skip) { console.log(`SKIPPED: ${env311.skip || env311Bare.skip}`); return; }
  const pythonA = env311.python, pythonC = env311Bare.python, envB = native.venv, pythonB = path.join(envB, "bin", "python");
  const facts = { A: expected(pythonA), B: expected(pythonB), C: expected(pythonC) };
  note("environments", { pythonA, pythonB, pythonC, facts });

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-project-environment-")));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const rootA = path.join(scratch, "Projekt Ä"), rootB = path.join(scratch, "Beta Projekt");
  for (const [root, name] of [[rootA, "Alpha"], [rootB, "Beta"]]) {
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(root, "suite.robot"), `*** Settings ***\nLibrary    OperatingSystem\n\n*** Test Cases ***\n${name} Test\n` +
      "    ${python}=    Evaluate    sys.executable    modules=sys\n    ${rf}=    Evaluate    robot.version.VERSION    modules=robot.version\n" +
      "    Create File    ${CURDIR}/last-run.txt    ${python}|${rf}\n");
    fs.writeFileSync(path.join(root, "problems.robot"), `*** Keywords ***\nUses Missing Step\n    Undefined Step ${name}\n`);
    fs.writeFileSync(path.join(root, ".vscode/settings.json"), "{}");
  }
  fs.writeFileSync(path.join(rootA, ".vscode/launch.json"), JSON.stringify({ version: "0.2.0", configurations: [{ type: "robotcompanion",
    request: "launch", name: "Debug Alpha", target: "${workspaceFolder}/suite.robot", attachPython: false }] }, null, 2));
  // B's conventional in-project environment: the .venv backend fallback and later its interpreter.
  fs.symlinkSync(envB, path.join(rootB, ".venv"), "dir");
  const workspace = path.join(scratch, "two-projects.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: rootA }, { path: rootB }] }));
  const uri = root => pathToFileURL(root).href;
  const lastRun = root => { try { return fs.readFileSync(path.join(root, "last-run.txt"), "utf8").trim(); } catch { return undefined; } };
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
  let host;

  const open = async (root, file) => {
    await host.cdp.palette("Go to File");
    await host.cdp.text(path.join(root, file));
    await host.cdp.wait(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(file)})`);
    await host.cdp.key("Enter");
    await host.cdp.wait(`${status}?.getAttribute('aria-label')?.includes(${JSON.stringify(`Folder: ${uri(root)}`)}) && !${status}.textContent.includes('Checking')`, 20000);
    await sleep(300);
  };
  const statusOutput = async () => {
    await host.cdp.palette("Robot Companion: Show Language Service Status");
    await sleep(800);
    // Monaco renders visible lines only: maximize the panel while reading, then restore the editor.
    const tall = () => host.cdp.eval("(document.querySelector('.part.panel')?.getBoundingClientRect().height || 0) > innerHeight * 0.6");
    if (!await tall()) { await host.cdp.palette("View: Toggle Maximized Panel"); await until(tall, "maximized panel", 10000); await sleep(500); }
    const text = await host.cdp.eval("[...document.querySelectorAll('.part.panel .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(line => line.textContent).join('').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ')");
    await host.cdp.palette("View: Toggle Maximized Panel"); await until(async () => !await tall(), "restored panel", 10000);
    return text;
  };
  const expectStatus = async (parts, label) => {
    const text = await until(async () => { const t = await statusOutput(); return parts.every(part => t.includes(part)) && t; }, label, 30000)
      .catch(async error => { throw new Error(`${error.message}\n${await statusOutput()}`); });
    note(label, { parts });
    return text;
  };
  const identityLine = (fact, python) => `${python} (Python ${fact.python}, Robot Framework ${fact.robot}); robot-companion-backend 0.1.0.dev1 (sha256 ${fact.sha256.slice(0, 12)}, ${fact.files} files)`;
  const pickPath = async python => {
    await host.cdp.click(status);
    await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Select Robot Environment')");
    await host.cdp.filter("Enter path"); await host.cdp.key("Enter");
    await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Choose executable type')");
    await host.cdp.key("Enter");
    await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Path to Python interpreter')");
    await host.cdp.text(python); await host.cdp.key("Enter");
    await host.cdp.wait("!document.querySelector('.quick-input-widget') || getComputedStyle(document.querySelector('.quick-input-widget')).display === 'none'", 20000);
  };
  const run = async (root, start, expectedLine, label) => {
    fs.rmSync(path.join(root, "last-run.txt"), { force: true });
    await start();
    await until(() => lastRun(root), `${label}: last-run.txt in ${root}`, 60000);
    assert.equal(lastRun(root), expectedLine, label);
    note(label, { root, ran: lastRun(root) });
    await sleep(1500);
  };
  const codeLensRunTest = () => host.cdp.click("[...document.querySelectorAll('.codelens-decoration a')].find(el => el.textContent.trim() === 'Run Test')");
  const retain = name => host.cdp.retain(`project-environment-${name}`);
  try {
    // ---- Stage 1: trusted window, fresh profile ----
    host = await launchHost({ name: "project-environment", profile, extensions, targets: [workspace, path.join(rootA, "problems.robot")], ready: `!!${status}` });
    // Fallback: B has no selection, so its .venv backend executable runs; A has none and is refused.
    const fallbackB = await until(() => service(rootB, "lsp"), "B .venv fallback language process");
    assert(fallbackB.argv.some(arg => arg === path.join(rootB, ".venv/bin/robot-companion-backend")), JSON.stringify(fallbackB.argv));
    assert.equal(service(rootA, "lsp"), undefined, "A has no backend before an interpreter is selected");
    await expectStatus([`[Beta Projekt] Environment — default .venv backend (no interpreter selected): ${identityLine(facts.B, pythonB)}`,
      `backend files sha256 ${facts.B.sha256}`], "fallback: B status names its .venv backend's interpreter, versions and backend bytes");
    await retain("1-fallback-status");

    // A: Enter path… with the 3.11 interpreter. Only A's services restart.
    await open(rootA, "suite.robot");
    await pickPath(pythonA);
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: python (${facts.A.python})')`, 20000);
    const lspA = await until(() => { const p = service(rootA, "lsp"); return p?.argv[0] === pythonA && p; }, "A language process with the selected interpreter");
    assert.deepStrictEqual(lspA.argv, [pythonA, "-m", "robot_companion_backend", "lsp"]);
    const discoveryA = await until(() => { const p = service(rootA, "discovery"); return p?.argv[0] === pythonA && p; }, "A discovery process with the selected interpreter");
    assert.deepStrictEqual(discoveryA.argv, [pythonA, "-m", "robot_companion_backend", "discovery"]);
    assert.equal(service(rootB, "lsp")?.pid, fallbackB.pid, "B's language process is untouched by A's selection");
    note("A selected through Enter path: language and discovery run the interpreter; B untouched", { lspA, discoveryA, bPid: fallbackB.pid });
    await open(rootA, "problems.robot");
    await host.cdp.wait("!!document.querySelector('.editor-instance .monaco-editor .squiggly-error')", 30000);
    note("A native diagnostics shown (squiggle) from the selected interpreter's backend");
    await expectStatus([`[Projekt Ä] Environment — selected python: ${identityLine(facts.A, pythonA)}`, `backend files sha256 ${facts.A.sha256}`],
      "A status names the selected interpreter, Python 3.11/RF 7.3.2 and backend bytes");
    await retain("2-selected-A");

    // B: choose its .venv interpreter in the picker. Only B restarts.
    await open(rootB, "suite.robot");
    await host.cdp.click(status);
    await host.cdp.wait(`document.querySelector('.quick-input-widget')?.textContent.includes('Robot Framework ${facts.B.robot}')`, 20000);
    await host.cdp.filter(".venv"); await host.cdp.key("Enter");
    const venvB = path.join(rootB, ".venv/bin/python");
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: .venv (${facts.B.python})')`, 20000);
    const lspB = await until(() => { const p = service(rootB, "lsp"); return p?.argv[0] === venvB && p; }, "B language process with its .venv interpreter");
    assert.deepStrictEqual(lspB.argv, [venvB, "-m", "robot_companion_backend", "lsp"]);
    await until(() => !alive(fallbackB.pid), "B fallback language process gone");
    assert.equal(service(rootA, "lsp")?.pid, lspA.pid, "A's language process is untouched by B's selection");
    note("B selected .venv: restarted with its interpreter; A untouched", { lspB });
    await retain("3-selected-B");

    // Default python -m robot runs, debug and Test Explorer use each folder's interpreter.
    const lineA = `${pythonA}|${facts.A.robot}`, lineB = `${venvB}|${facts.B.robot}`;
    await open(rootA, "suite.robot");
    await run(rootA, codeLensRunTest, lineA, "A Run Test CodeLens ran the selected 3.11 interpreter");
    await open(rootB, "suite.robot");
    await run(rootB, () => host.cdp.palette("Robot Companion: Run Suite"), lineB, "B Run Suite ran its .venv interpreter");
    await open(rootA, "suite.robot");
    await run(rootA, async () => {
      await host.cdp.palette("Debug: Select and Start Debugging");
      await host.cdp.wait("document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes('Debug Alpha')");
      // A quick-access list ("debug " prefix): type after the prefix, never select all.
      await host.cdp.text("Debug Alpha");
      await host.cdp.wait("document.querySelector('.quick-input-widget .monaco-list-row.focused')?.textContent.includes('Debug Alpha')");
      await host.cdp.key("Enter");
    }, lineA, "A debug session's Robot worker ran in the selected interpreter");
    await host.cdp.wait("!document.querySelector('.debug-toolbar') || getComputedStyle(document.querySelector('.debug-toolbar')).display === 'none'", 30000);
    for (const root of [rootA, rootB]) fs.rmSync(path.join(root, "last-run.txt"), { force: true });
    await host.cdp.palette("Test: Run All Tests");
    await until(() => lastRun(rootA) && lastRun(rootB), "Test Explorer Run All in both folders", 90000);
    assert.equal(lastRun(rootA), lineA); assert.equal(lastRun(rootB), lineB);
    note("Test Explorer Run All Tests: each folder ran its own interpreter", { A: lastRun(rootA), B: lastRun(rootB) });
    await sleep(1500);

    // Explicit overrides keep precedence and are named.
    fs.writeFileSync(path.join(rootA, ".vscode/settings.json"), JSON.stringify({ "robotCompanion.robotCommand": `${pythonB} -m robot` }));
    await open(rootA, "suite.robot");
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: Setting')`, 20000);
    const overrideLabel = await host.cdp.eval(`${status}.getAttribute('aria-label')`);
    assert(overrideLabel.includes("robotCompanion.robotCommand") && overrideLabel.includes("Saved choice: python. Not used while robotCompanion.robotCommand is set."), overrideLabel);
    await run(rootA, codeLensRunTest, `${pythonB}|${facts.B.robot}`, "A robotCommand override runs the configured command");
    assert.equal(service(rootA, "lsp")?.pid, lspA.pid, "robotCommand changes runs only; A's language process keeps the selected interpreter");
    await retain("4-robotCommand-override");
    const backendA = path.join(path.dirname(pythonA), "robot-companion-backend");
    fs.writeFileSync(path.join(rootB, ".vscode/settings.json"), JSON.stringify({ "robotCompanion.nativeBackendExecutable": backendA }));
    const overriddenB = await until(() => { const p = service(rootB, "lsp"); return p?.argv.includes(backendA) && p; }, "B language process from nativeBackendExecutable");
    await expectStatus([`[Beta Projekt] Environment — robotCompanion.nativeBackendExecutable; selected .venv (${venvB}) is not used: ${identityLine(facts.A, pythonA)}`],
      "B nativeBackendExecutable override is named, with the masked selection and the backend's interpreter");
    await retain("5-nativeBackendExecutable-override");
    for (const root of [rootA, rootB]) fs.writeFileSync(path.join(root, ".vscode/settings.json"), "{}");
    await until(() => { const p = service(rootB, "lsp"); return p?.argv[0] === venvB && p; }, "B back on its .venv interpreter after removing the override");
    await until(() => !alive(overriddenB.pid), "override process gone");
    note("overrides removed: B back on its selected interpreter");

    // Persistence: Ctrl+Q and relaunch with the same profile.
    await host.quit();
    note("Ctrl+Q exit");
    host = await launchHost({ name: "project-environment-relaunch", profile, extensions, targets: [workspace, path.join(rootA, "suite.robot")], ready: `!!${status}` });
    const relaunchA = await until(() => { const p = service(rootA, "lsp"); return p?.argv[0] === pythonA && p; }, "A language process after relaunch");
    const relaunchB = await until(() => { const p = service(rootB, "lsp"); return p?.argv[0] === venvB && p; }, "B language process after relaunch");
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: python (${facts.A.python})')`, 30000);
    note("relaunch: both folders' choices persisted and run their services", { relaunchA, relaunchB });
    await retain("6-relaunch");

    // An interpreter without the backend: A refuses before starting, naming it and its versions; B keeps running.
    await open(rootA, "suite.robot");
    await pickPath(pythonC);
    const refusal = `robot-companion-backend is not installed in ${pythonC} (Python ${facts.C.python}, Robot Framework ${facts.C.robot}). Nothing was started.`;
    await host.cdp.wait(`[...document.querySelectorAll('.notification-toast')].some(el => el.textContent.includes(${JSON.stringify(refusal)}) && el.textContent.includes("Projekt Ä"))`, 30000);
    await until(() => !alive(relaunchA.pid), "A's previous language process stopped");
    assert.equal(backendProcesses(rootA).filter(item => item.service !== "dap").length, 0, "nothing started for A");
    assert.equal(service(rootB, "lsp")?.pid, relaunchB.pid, "B's language process is untouched");
    note("interpreter without backend: refusal notification names interpreter and versions; B untouched", { refusal });
    await retain("7-missing-backend-refusal");
    await host.quit();

    // ---- Stage 3: native workspace trust, Restricted Mode, then Trust ----
    host = await launchHost({ name: "project-environment-restricted", profile, extensions, trust: true, targets: [workspace, path.join(rootB, "suite.robot")], ready: `!!${status}` });
    await host.cdp.wait("[...document.querySelectorAll('.part.banner, .statusbar-item')].some(e => /Restricted Mode/.test(e.textContent || e.getAttribute('aria-label') || ''))", 30000);
    const interpreters = [pythonA, pythonC, pythonB, venvB, path.join(envB, "bin")];
    const seen = [];
    for (const end = Date.now() + 10000; Date.now() < end; await sleep(50)) {
      for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
        try {
          const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
          if (interpreters.some(item => argv[0]?.startsWith(item)) || argv.includes("robot_companion_backend")) seen.push(argv);
        } catch { /* Ended while reading. */ }
      }
    }
    assert.deepStrictEqual(seen, [], "Restricted Mode starts no interpreter, probe or backend");
    await host.cdp.wait(`${status}?.textContent === 'Robot: Trust required'`);
    note("Restricted Mode: 10 s of /proc sampling saw no interpreter, probe or backend process; status says Trust required");
    await retain("8-restricted");
    await host.cdp.click("[...document.querySelectorAll('.part.banner a, .part.banner .monaco-link')].find(a => a.textContent.trim() === 'Manage')");
    await host.cdp.click("[...document.querySelectorAll('.workspace-trust-editor .monaco-button')].find(b => b.textContent.trim() === 'Trust' && b.getClientRects().length)");
    const trustedB = await until(() => { const p = service(rootB, "lsp"); return p?.argv[0] === venvB && p; }, "B language process after Trust");
    assert.deepStrictEqual(trustedB.argv, [venvB, "-m", "robot_companion_backend", "lsp"]);
    await sleep(3000);
    assert.equal(backendProcesses(rootA).length, 0, "A's persisted interpreter without backend still starts nothing");
    note("Trust clicked: B started with its persisted interpreter; A still refused", { trustedB });
    await retain("9-trusted");
    console.log("PROJECT ENVIRONMENT HOST: selected interpreters control language, discovery, debug and runs per folder; overrides, fallback, persistence, refusal and trust verified");
  } catch (error) {
    console.error("Project environment host failed:", error); process.exitCode = 1;
    try { await host?.cdp.retain("project-environment-failure"); } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "project-environment-transcript.json"), JSON.stringify(transcript, null, 2)); }
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

// Onboarding without manual backend setup, in a normal VS Code window driven over CDP with real
// pointer and keyboard input. Fresh profile and extensions directory; synthetic projects whose
// environments stand in for existing ones (Python + Robot Framework + an installed project library):
//   Host 1, "Neues Projekt" (Python 3.11 + RF 7.3.2, no backend, no debugpy): the not-set-up notice,
//     Select Robot Environment, Install Backend (confirmation Cancel, then Install), byte verification,
//     hover and F12 into the project library, Test Explorer Run All and Debug Test at a breakpoint.
//   Host 2, "RobotCode Projekt" (Python 3.13 + RF 7.5 + RobotCode 2.7.0 + debugpy, another build of
//     the same backend version): Update Backend cancelled from its progress notification, then Retry;
//     RobotCode stays installed. "Altes Projekt Ä" (Python 3.11 + RF 7.3.2, backend 0.0.9): Update
//     Backend fails on a read-only site-packages, the user fixes it, Retry succeeds.
// Nothing is downloaded: environments are built offline from /opt wheel directories and the
// extension installs only bundled-backend/. Run under a display (xvfb-run -a).
const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchHost, sleep } = require("./cdp-host");

const SOURCE = path.resolve(__dirname, "../..");
const BUNDLE = path.join(SOURCE, "bundled-backend");
const manifest = JSON.parse(fs.readFileSync(path.join(BUNDLE, "manifest.json"), "utf8"));
const PY311 = "/opt/python3.11/bin/python3.11", PY313 = "/usr/local/bin/python3.13";
const WHEELS311 = "/opt/robot-wheels-py311", WHEELS313 = "/opt/robot-wheels";
const evidence = process.env.ROBOT_COMPANION_EVIDENCE_DIR;
const transcript = [];
const note = (step, data = {}) => { transcript.push({ at: new Date().toISOString(), step, ...data }); console.log(`- ${step}`); };
const run = (file, args, options = {}) => childProcess.execFileSync(file, args, { encoding: "utf8", cwd: os.tmpdir(), ...options });

async function until(predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}

const PROJECT_LIBRARY = [
  "\"\"\"Synthetic project library installed in the project's own environment.\"\"\"",
  "import sys", "", "",
  "def acme_project_keyword():",
  "    \"\"\"Returns the interpreter that imported this project library.\"\"\"",
  "    return sys.executable", ""
].join("\n");

// Stands in for a slow install (a large environment, an antivirus scan): only while the flag file
// exists, `python -m pip install` waits 30 s before pip starts, so a person can cancel it.
const SLOW_PIP = (flag) => `import os, sys, time; (sys.orig_argv[1:4] == ['-m', 'pip', 'install'] and os.path.exists(${JSON.stringify(flag)}) and not getattr(sys, '_slow_pip', False) and (setattr(sys, '_slow_pip', True) or time.sleep(30)))\n`;

// A project environment as a user already has it. `backend` is an optional wheel of another backend build.
function projectEnvironment(venv, { python, wheels, packages, backend }) {
  run(python, ["-m", "venv", venv]);
  const venvPython = path.join(venv, "bin", "python");
  run(venvPython, ["-m", "pip", "install", "--no-index", "--find-links", wheels, "--no-cache-dir", "--disable-pip-version-check", "-q", ...packages]);
  const purelib = run(venvPython, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"]).trim();
  fs.mkdirSync(path.join(purelib, "acme_project_lib"), { recursive: true });
  fs.writeFileSync(path.join(purelib, "acme_project_lib", "__init__.py"), PROJECT_LIBRARY);
  if (backend) run(venvPython, ["-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "-q", backend]);
  return { python: venvPython, purelib };
}

// Another build of the backend: same sources with one change (a comment, or another version).
function otherBuild(scratch, name, change) {
  const copy = path.join(scratch, name);
  fs.cpSync(path.join(SOURCE, "backend"), copy, { recursive: true, filter: file => !file.includes("__pycache__") });
  change(copy);
  run(PY313, ["-B", path.join(copy, "scripts/build_dists.py"), copy, path.join(copy, "dist")]);
  return path.join(copy, "dist", fs.readdirSync(path.join(copy, "dist")).find(file => file.endsWith(".whl")));
}

const packages = python => JSON.parse(run(python, ["-c",
  "import importlib.metadata as m, json; print(json.dumps(sorted(f'{(d.metadata[\"Name\"] or \"(no metadata)\").lower()}=={d.version}' for d in m.distributions())))"]));

// Installed backend facts computed independently of the extension: version from metadata and the
// digest over the installed robot_companion_backend/ files (sorted `path NUL sha256 LF`).
function installed(python) {
  const out = run(python, ["-c", "import importlib.util as u, importlib.metadata as m\ns = u.find_spec('robot_companion_backend')\n" +
    "print(m.version('robot-companion-backend') if s else '-', s.submodule_search_locations[0] if s else '-')"]).trim().split(" ");
  if (out[0] === "-") return undefined;
  const pkg = out.slice(1).join(" "), names = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`); else names.push(`${prefix}/${entry.name}`);
    }
  };
  walk(pkg, "robot_companion_backend");
  const hash = crypto.createHash("sha256");
  for (const name of names.sort()) hash.update(`${name}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(pkg, ...name.split("/").slice(1)))).digest("hex")}\n`);
  return { version: out[0], sha256: hash.digest("hex"), files: names.length };
}

function processes(predicate) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (predicate(argv, pid)) found.push({ pid: Number(pid), argv });
    } catch { /* Ended while reading. */ }
  }
  return found;
}
// Module form (`python -m robot_companion_backend`) or the console script of a .venv backend.
const service = (root, name) => processes((argv, pid) => (argv.includes("robot_companion_backend") || argv.some(arg => arg.endsWith("/robot-companion-backend"))) && argv[argv.length - 1] === name &&
  fs.realpathSync(`/proc/${pid}/cwd`) === root)[0];
const pipRuns = python => processes(argv => argv[0] === python && argv.slice(1, 4).join(" ") === "-m pip install");

function writeProject(root, testName) {
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".vscode/settings.json"), "{}");
  fs.writeFileSync(path.join(root, "suite.robot"), "*** Settings ***\nLibrary    OperatingSystem\nLibrary    acme_project_lib\n\n" +
    `*** Test Cases ***\n${testName}\n    \${python}=    Acme Project Keyword\n` +
    "    ${rf}=    Evaluate    robot.version.VERSION    modules=robot.version\n    Create File    ${CURDIR}/last-run.txt    ${python}|${rf}\n");
}

async function main() {
  for (const required of [PY311, PY313, WHEELS311, WHEELS313]) if (!fs.existsSync(required)) { console.log(`SKIPPED: ${required} not found`); return; }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-backend-onboarding-")));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const rootA = path.join(scratch, "Neues Projekt"), rootB = path.join(scratch, "RobotCode Projekt"), rootC = path.join(scratch, "Altes Projekt Ä");
  const rootD = path.join(scratch, "Venv Projekt");
  const slowFlag = path.join(scratch, "slow-pip");
  let host;
  try {
    // ---- Environments as the projects already have them (offline wheels only) ----
    const envA = projectEnvironment(path.join(scratch, "envs", "neu"), { python: PY311, wheels: WHEELS311, packages: ["robotframework==7.3.2"] });
    const sameVersion = otherBuild(scratch, "earlier-build", dir => fs.appendFileSync(path.join(dir, "src/robot_companion_backend/__init__.py"), "# an earlier build\n"));
    const envB = projectEnvironment(path.join(scratch, "envs", "robotcode"), { python: PY313, wheels: WHEELS313, backend: sameVersion,
      packages: ["robotframework==7.5", "debugpy==1.8.22", "robotcode==2.7.0", "robotcode-language-server==2.7.0", "robotcode-debugger==2.7.0"] });
    const oldVersion = otherBuild(scratch, "old-version", dir => {
      const file = path.join(dir, "pyproject.toml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('version = "0.1.0.dev20"', 'version = "0.0.9"'));
    });
    const envC = projectEnvironment(path.join(scratch, "envs", "alt"), { python: PY311, wheels: WHEELS311, packages: ["robotframework==7.3.2", "debugpy==1.8.22"], backend: oldVersion });
    fs.writeFileSync(path.join(envB.purelib, "slow-pip-fixture.pth"), SLOW_PIP(slowFlag));
    // D: an existing project whose .venv has the older backend 0.0.9; no interpreter is ever selected for it.
    const envD = projectEnvironment(path.join(scratch, "envs", "venv-alt"), { python: PY311, wheels: WHEELS311, packages: ["robotframework==7.3.2", "debugpy==1.8.22"], backend: oldVersion });
    const before = { A: packages(envA.python), B: packages(envB.python), C: packages(envC.python), D: packages(envD.python) };
    const backendBefore = { A: installed(envA.python), B: installed(envB.python), C: installed(envC.python) };
    assert.equal(backendBefore.A, undefined, "no preinstalled backend masks onboarding in A");
    assert(!before.A.some(item => item.startsWith("debugpy==")), "A has no debugpy");
    assert.equal(backendBefore.B.version, "0.1.0.dev20"); assert.notEqual(backendBefore.B.sha256, manifest.backend.installedFiles.sha256);
    assert.equal(backendBefore.C.version, "0.0.9");
    assert(before.B.includes("robotcode==2.7.0"), before.B.join(", "));
    note("environments", { before, backendBefore, bundled: manifest.backend });
    writeProject(rootA, "Onboarding Test"); writeProject(rootB, "RobotCode Test"); writeProject(rootC, "Altes Test"); writeProject(rootD, "Venv Test");
    fs.symlinkSync(path.dirname(path.dirname(envD.python)), path.join(rootD, ".venv"), "dir");
    fs.symlinkSync(path.dirname(path.dirname(envB.python)), path.join(rootB, ".venv"), "dir");

    const status = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
    const toast = text => `[...document.querySelectorAll('.notifications-toasts .notification-list-item')].find(el => el.textContent.includes(${JSON.stringify(text)}))`;
    const toastButton = (text, label) => `[...(${toast(text)}?.querySelectorAll('.monaco-button') || [])].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const dialog = "document.querySelector('.monaco-dialog-box')";
    const dialogButton = label => `[...(${dialog}?.querySelectorAll('.dialog-buttons .monaco-button') || [])].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const retain = name => host.cdp.retain(`backend-onboarding-${name}`);
    // A notification button that opens the confirmation. A click that lands while the toast is
    // still re-laying out only shows the button's tooltip; VS Code closes the notification once a
    // button is actioned, so the click is repeated only while that toast remains and no dialog opened.
    const clickToConfirm = async (text, label) => {
      for (let attempt = 1; ; attempt++) {
        await host.cdp.click(toastButton(text, label));
        try { await host.cdp.wait(`!!${dialog} || !${toast(text)}`, 5000); return; } catch (error) { if (attempt === 3) throw error; }
        note(`repeated the click on ${label}: the notification was still open without a confirmation`);
      }
    };
    // Waits until the toast has finished sliding in, so screenshots show it settled.
    const toastText = async text => { const value = await host.cdp.wait(`${toast(text)}?.textContent`, 60000); await host.cdp.point(toast(text)); return value; };
    const clear = async () => { await host.cdp.palette("Notifications: Clear All Notifications"); await sleep(900); };
    const rawKey = async (key, code, vk) => {
      for (const type of ["keyDown", "keyUp"]) await host.cdp.cdp.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk }, host.cdp.cdp.pageSession);
      await sleep(150);
    };
    const open = async (root, file) => {
      await host.cdp.palette("Go to File");
      await host.cdp.text(path.join(root, file));
      await host.cdp.wait(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(file)})`);
      await host.cdp.key("Enter");
      await host.cdp.wait(`(document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') || '').includes(${JSON.stringify(path.basename(root))})`, 20000).catch(() => {});
      await sleep(400);
    };
    const enterPath = async python => {
      await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Select Robot Environment')");
      await host.cdp.filter("Enter path"); await host.cdp.key("Enter");
      await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Choose executable type')");
      await host.cdp.key("Enter");
      await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Path to Python interpreter')");
      await host.cdp.text(python); await host.cdp.key("Enter");
      await host.cdp.wait("!document.querySelector('.quick-input-widget') || getComputedStyle(document.querySelector('.quick-input-widget')).display === 'none'", 20000);
    };
    // The modal confirmation: its text, then a real click on one of its buttons.
    const confirmation = async (title, parts, shot) => {
      await host.cdp.wait(`${dialog}?.textContent.includes(${JSON.stringify(title)})`, 30000);
      const text = await host.cdp.eval(`${dialog}.textContent`);
      for (const part of parts) assert(text.includes(part), `confirmation names ${part}: ${text}`);
      if (shot) await retain(shot);
      return text;
    };
    const tokenPoint = needle => host.cdp.wait(`(() => {
      for (const line of document.querySelectorAll('.editor-instance .monaco-editor .view-lines .view-line')) {
        const at = line.textContent.replace(/\\u00a0/g, ' ').indexOf(${JSON.stringify(needle)});
        if (at < 0) continue;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let offset = at + 2, node;
        while ((node = walker.nextNode())) { if (offset < node.length) break; offset -= node.length; }
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : false;
      }
      return false;
    })()`, 20000);
    const visibleHover = "[...document.querySelectorAll('.monaco-editor .monaco-hover')].filter(el => el.getClientRects().length && !el.classList.contains('hidden')).map(el => el.textContent).join(' ')";
    const hoverText = async (needle, expected, shot) => {
      const text = await until(async () => {
        await host.cdp.hover(await tokenPoint(needle));
        try { return await host.cdp.wait(`(() => { const t = ${visibleHover}; return t.includes(${JSON.stringify(expected)}) && t; })()`, 5000); } catch { await host.cdp.away().catch(() => {}); return false; }
      }, `hover over ${needle}`, 45000);
      if (shot) await retain(shot);
      await host.cdp.away().catch(() => {});
      await host.cdp.key("Escape");
      return text;
    };
    const activeFile = () => host.cdp.eval("(document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') || '').split(',')[0].trim()");
    const breadcrumbs = () => host.cdp.eval("[...document.querySelectorAll('.editor-group-container.active .breadcrumbs-control .monaco-breadcrumb-item')].map(el => el.textContent).join('/')");
    const lastRun = root => { try { return fs.readFileSync(path.join(root, "last-run.txt"), "utf8").trim(); } catch { return undefined; } };
    // Install or update through the guided flow: the action's notification button, the confirmation, progress, verification.
    const verified = async (root, python, label) => {
      const facts = installed(python);
      assert.deepStrictEqual({ sha256: facts.sha256, files: facts.files }, manifest.backend.installedFiles, `${label}: installed bytes are the bundled build`);
      const lsp = await until(() => { const p = service(root, "lsp"); return p?.argv[0] === python && p; }, `${label}: language service from the selected interpreter`, 60000);
      assert.deepStrictEqual(lsp.argv, [python, "-m", "robot_companion_backend", "lsp"]);
      return { facts, lsp };
    };

    // ===== Host 1: a fresh extension installation and a clean project =====
    host = await launchHost({ name: "backend-onboarding", profile, extensions, targets: [rootA, path.join(rootA, "suite.robot")], ready: `!!${status}` });
    const notSetUp = "No Python interpreter is selected for folder 'Neues Projekt', and the folder has no .venv backend.";
    const first = await toastText(notSetUp);
    assert(first.includes("Select the project's Python interpreter"), first);
    assert.equal(processes(argv => argv.includes("robot_companion_backend")).length, 0, "nothing runs before setup");
    await retain("1-not-set-up");
    note("fresh window: the not-set-up notice asks for the project's Python; no backend process", { toast: first.slice(0, 300) });
    await host.cdp.click(toastButton(notSetUp, "Select Robot Environment"));
    await enterPath(envA.python);
    const missing = `robot-companion-backend is not installed in ${envA.python} (Python 3.11.17, Robot Framework 7.3.2). Nothing was started.`;
    const offer = await toastText(missing);
    assert(offer.includes("Choose Install Backend"), offer);
    await retain("2-install-offer");
    note("selected the project's Python through the notice: Install Backend offered", { toast: offer.slice(0, 400) });
    // The confirmation names the interpreter and the change; Cancel starts nothing.
    const consentParts = [`Interpreter: ${envA.python} (Python 3.11.17, Robot Framework 7.3.2)`,
      `Adds: robot-companion-backend 0.1.0.dev20 (bundled build, sha256 ${manifest.backend.installedFiles.sha256.slice(0, 12)}`, "Adds: debugpy 1.8.22",
      "Unchanged: Python 3.11.17, Robot Framework 7.3.2 and every other installed package.", "--no-index --no-deps", "Nothing is downloaded"];
    await clickToConfirm(missing, "Install Backend");
    const consentA = await confirmation("Install the Robot Companion backend in this Python environment?", consentParts, "3-install-confirmation");
    await host.cdp.click(dialogButton("Cancel"));
    await host.cdp.wait(`!${dialog}`); await sleep(1500);
    assert.deepStrictEqual(packages(envA.python), before.A, "Cancel changes nothing");
    assert.equal(installed(envA.python), undefined);
    note("confirmation Cancel: no pip run, environment unchanged", { confirmation: consentA });
    // The palette command repeats the guided flow; Install Backend installs and verifies.
    await host.cdp.palette("Robot Companion: Install or Update Backend");
    await confirmation("Install the Robot Companion backend in this Python environment?", consentParts);
    await host.cdp.click(dialogButton("Install Backend"));
    const doneA = await toastText(`Robot Companion backend 0.1.0.dev20 is installed in ${envA.python} and matches the bundled build`);
    await retain("4-installed");
    const A = await verified(rootA, envA.python, "A");
    const afterA = packages(envA.python);
    assert.deepStrictEqual(afterA.filter(item => !before.A.includes(item)).sort(), ["debugpy==1.8.22", "robot-companion-backend==0.1.0.dev20"]);
    assert.deepStrictEqual(before.A.filter(item => !afterA.includes(item)), [], "nothing removed or changed");
    note("Install Backend: bundled backend and debugpy added, bytes verified, language service started", { toast: doneA.slice(0, 300), facts: A.facts, lsp: A.lsp.argv, added: afterA.filter(item => !before.A.includes(item)) });
    // Keyword navigation into the project's installed library.
    const doc = await hoverText("Acme Project Keyword", "Returns the interpreter that imported this project library.", "5-library-hover");
    await host.cdp.press(await tokenPoint("Acme Project Keyword"));
    await host.cdp.key("F12");
    await until(async () => await activeFile() === "__init__.py", "F12 opened acme_project_lib/__init__.py", 20000);
    const crumbs = await until(async () => { const c = await breadcrumbs(); return c.includes("acme_project_lib") && c; }, "definition breadcrumbs", 10000);
    assert(crumbs.includes("site-packages"), crumbs);
    await retain("6-library-definition");
    note("hover and F12 resolve the project's installed library", { hover: doc.slice(0, 200), definition: crumbs });
    // Test Explorer: Run All, then Debug Test stopping at a breakpoint.
    await open(rootA, "suite.robot");
    await host.cdp.click(`[...document.querySelectorAll('.activitybar .action-label')].find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))`);
    const row = name => `[...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].find(r => (r.getAttribute('aria-label') || '').toLowerCase().startsWith(${JSON.stringify(name.toLowerCase())}))`;
    await host.cdp.wait(`!!${row("suite")}`, 60000);
    if (!await host.cdp.eval(`!!${row("Onboarding Test")}`)) await host.cdp.click(row("suite"));
    await host.cdp.wait(`!!${row("Onboarding Test")}`, 30000);
    await host.cdp.palette("Test: Run All Tests");
    const lineA = `${envA.python}|7.3.2`;
    await until(() => lastRun(rootA), "Test Explorer Run All wrote last-run.txt", 90000);
    assert.equal(lastRun(rootA), lineA, "the run used the selected interpreter and the project library");
    await host.cdp.wait(`/\\(Passed\\)|Passed/.test(${row("Onboarding Test")}?.getAttribute('aria-label') || '')`, 30000);
    await retain("7-test-explorer-run");
    note("Test Explorer Run All: passed in the selected interpreter through the project library", { lastRun: lastRun(rootA) });
    fs.rmSync(path.join(rootA, "last-run.txt"));
    await host.cdp.press(await tokenPoint("Acme Project Keyword"));
    await rawKey("F9", "F9", 120);
    await host.cdp.wait("!!document.querySelector('.editor-instance .codicon-debug-breakpoint')", 10000);
    const rowPoint = await host.cdp.point(row("Onboarding Test"));
    await host.cdp.hover(rowPoint);
    await host.cdp.click(`[...(${row("Onboarding Test")}?.querySelectorAll('.action-label') || [])].find(a => (a.getAttribute('aria-label') || a.title || '').startsWith('Debug Test'))`);
    await host.cdp.wait("!!document.querySelector('.debug-top-stack-frame-line, .debug-top-stack-frame')", 90000);
    await host.cdp.wait("[...document.querySelectorAll('.debug-toolbar')].some(el => el.getClientRects().length)");
    const debuggers = processes(argv => argv[0] === envA.python && argv.includes("robot_companion_backend"));
    await retain("8-test-explorer-debug-paused");
    assert.equal(lastRun(rootA), undefined, "paused before the step ran");
    note("Test Explorer Debug Test paused at the breakpoint", { processes: debuggers.map(item => item.argv.slice(1).join(" ")) });
    await rawKey("F5", "F5", 116);
    await until(() => lastRun(rootA), "Debug Test finished the test", 60000);
    assert.equal(lastRun(rootA), lineA);
    await host.cdp.wait("![...document.querySelectorAll('.debug-toolbar')].some(el => el.getClientRects().length)", 30000);
    await retain("9-test-explorer-debug-finished");
    note("Continue (F5): the debugged test ran through the project library to the end", { lastRun: lastRun(rootA) });
    await host.quit();
    note("host 1 closed with Ctrl+Q");

    // ===== Host 2: existing projects, one with RobotCode installed =====
    const workspace = path.join(scratch, "existing.code-workspace");
    fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: rootB }, { path: rootC }, { path: rootD }] }));
    host = await launchHost({ name: "backend-onboarding-existing", profile, extensions, targets: [workspace, path.join(rootB, "suite.robot")], ready: `!!${status}` });
    // No interpreter is selected yet: B's and D's default .venv backends are checked against the bundled build.
    const venvDiffers = `The installed robot-companion-backend 0.1.0.dev20 of ${envB.python} (Python 3.13.7, Robot Framework 7.5) (sha256 ${backendBefore.B.sha256.slice(0, 12)}, ${backendBefore.B.files} files) differs from the build bundled with Robot Companion`;
    const venvOlder = `Robot Companion supports robot-companion-backend 0.1.0.dev20; ${envD.python} (Python 3.11.17, Robot Framework 7.3.2) has 0.0.9`;
    // Both notifications are raised; VS Code stacks the earlier one behind the newest toast.
    const defaultB = await host.cdp.wait(`${toast(venvDiffers)}?.textContent`, 60000), defaultD = await toastText(venvOlder);
    for (const text of [defaultB, defaultD]) assert(text.includes("Update Backend") && text.includes("Nothing was started."), text);
    await sleep(3000);
    for (const [root, name] of [[rootB, "B"], [rootD, "D"]]) for (const kind of ["lsp", "discovery"]) assert.equal(service(root, kind), undefined, `${name} .venv ${kind} not started`);
    await retain("10a-venv-default-refused");
    note(".venv backends without a selected interpreter: other bytes (B) and 0.0.9 (D) refused with Update Backend; no language or discovery process", { B: defaultB.slice(0, 300), D: defaultD.slice(0, 300) });
    await clickToConfirm(venvOlder, "Update Backend");
    await confirmation("Update the Robot Companion backend in this Python environment?", [`Interpreter: ${envD.python}`, "Replaces: robot-companion-backend 0.0.9"]);
    await host.cdp.click(dialogButton("Update Backend"));
    await toastText(`Robot Companion backend 0.1.0.dev20 is installed in ${envD.python} and matches the bundled build`);
    assert.deepStrictEqual((({ sha256, files }) => ({ sha256, files }))(installed(envD.python)), manifest.backend.installedFiles);
    const lspD = await until(() => service(rootD, "lsp"), "D language service from its .venv backend", 60000);
    assert(lspD.argv.includes(path.join(rootD, ".venv/bin/robot-companion-backend")), lspD.argv.join(" "));
    await until(() => service(rootD, "discovery"), "D discovery from its .venv backend", 60000);
    await retain("10b-venv-default-updated");
    note("D: Update Backend from the .venv notification without selecting an interpreter; bundled build verified; .venv backend started", { lsp: lspD.argv });
    await open(rootB, "suite.robot");
    await clear();
    await host.cdp.click(status);
    await host.cdp.wait("document.querySelector('.quick-input-widget')?.textContent.includes('Robot Framework 7.5')", 20000);
    await host.cdp.filter(".venv"); await host.cdp.key("Enter");
    const venvB = path.join(rootB, ".venv/bin/python");
    const differs = `The installed robot-companion-backend 0.1.0.dev20 of ${venvB} (Python 3.13.7, Robot Framework 7.5) (sha256 ${backendBefore.B.sha256.slice(0, 12)}, ${backendBefore.B.files} files) differs from the build bundled with Robot Companion`;
    const offerB = await toastText(differs);
    assert(offerB.includes("Choose Update Backend"), offerB);
    assert.equal(service(rootB, "lsp"), undefined, "another build is not started");
    await retain("10-update-offer");
    note("existing RobotCode project: same version, other bytes detected; Update Backend offered", { toast: offerB.slice(0, 400) });
    const updateParts = [`Interpreter: ${venvB} (Python 3.13.7, Robot Framework 7.5)`,
      `Replaces: robot-companion-backend 0.1.0.dev20 (sha256 ${backendBefore.B.sha256.slice(0, 12)}`, "Unchanged: Python 3.13.7, Robot Framework 7.5, debugpy 1.8.22, RobotCode 2.7.0 and every other installed package."];
    await clickToConfirm(differs, "Update Backend");
    await confirmation("Update the Robot Companion backend in this Python environment?", updateParts, "11-update-confirmation");
    fs.writeFileSync(slowFlag, "");
    await host.cdp.click(dialogButton("Update Backend"));
    const progress = `Updating the Robot Companion backend in ${venvB}`;
    await toastText(progress);
    const pip = await until(() => pipRuns(venvB)[0], "the pip install process", 20000);
    await retain("12-update-progress");
    await host.cdp.click(toastButton(progress, "Cancel"));
    const cancelled = await toastText(`Robot Companion backend update in ${venvB} was cancelled.`);
    assert(cancelled.includes("Nothing in that environment was changed."), cancelled);
    await until(() => !pipRuns(venvB).length, "pip stopped", 10000);
    assert.deepStrictEqual(installed(venvB), backendBefore.B, "cancelled before pip changed anything");
    await retain("13-update-cancelled");
    note("progress Cancel: pip stopped, environment unchanged, Retry offered", { pip: pip.argv, toast: cancelled.slice(0, 300) });
    fs.rmSync(slowFlag);
    await clickToConfirm("was cancelled", "Retry");
    await confirmation("Update the Robot Companion backend in this Python environment?", updateParts);
    await host.cdp.click(dialogButton("Update Backend"));
    await toastText(`Robot Companion backend 0.1.0.dev20 is installed in ${venvB} and matches the bundled build`);
    const B = await verified(rootB, venvB, "B");
    assert.deepStrictEqual(packages(venvB), before.B, "only the backend's own files changed; RobotCode and all versions stay");
    await retain("14-updated-robotcode-project");
    await hoverText("Acme Project Keyword", "Returns the interpreter that imported this project library.", "15-robotcode-project-hover");
    note("Retry: update verified; RobotCode 2.7.0 and every package version unchanged; hover from the project library", { facts: B.facts, lsp: B.lsp.argv });

    // Altes Projekt Ä: another backend version; the update fails on a read-only site-packages, then Retry.
    await open(rootC, "suite.robot");
    await clear();
    await host.cdp.click(status);
    await enterPath(envC.python);
    const outdated = `Robot Companion supports robot-companion-backend 0.1.0.dev20; ${envC.python} (Python 3.11.17, Robot Framework 7.3.2) has 0.0.9`;
    const offerC = await toastText(outdated);
    assert(offerC.includes("Choose Update Backend"), offerC);
    await retain("16-version-offer");
    fs.chmodSync(envC.purelib, 0o555);
    await clickToConfirm(outdated, "Update Backend");
    await confirmation("Update the Robot Companion backend in this Python environment?", [`Replaces: robot-companion-backend 0.0.9`]);
    await host.cdp.click(dialogButton("Update Backend"));
    const failed = await toastText(`Could not update the Robot Companion backend in ${envC.python}`);
    // pip had already moved the old metadata files when it hit the read-only directory: the
    // notification reports pip's error and the state pip left, and Retry repairs it.
    assert(/pip exited with code 1: ERROR: Could not install packages due to an OSError: \[Errno 13\] Permission denied/.test(failed), failed);
    assert(failed.includes(`The environment now reports: The installed robot-companion-backend (without version metadata) of ${envC.python} (Python 3.11.17, Robot Framework 7.3.2) is incomplete. Retry installs the bundled build again.`), failed);
    assert.equal(service(rootC, "lsp"), undefined, "a broken backend is not started");
    const brokenC = packages(envC.python);
    await retain("17-update-failed");
    note("failed setup: read-only site-packages; pip's error and the partly removed backend are reported; nothing started", { toast: failed.slice(0, 600), packages: brokenC });
    fs.chmodSync(envC.purelib, 0o755);
    await clickToConfirm("Could not update the Robot Companion backend", "Retry");
    await confirmation("Update the Robot Companion backend in this Python environment?", ["Replaces: robot-companion-backend (without version metadata)"], "18-retry-confirmation");
    await host.cdp.click(dialogButton("Update Backend"));
    await toastText(`Robot Companion backend 0.1.0.dev20 is installed in ${envC.python} and matches the bundled build`);
    const C = await verified(rootC, envC.python, "C");
    const afterC = packages(envC.python);
    // Besides the replaced backend, only the empty 0.0.9 .dist-info directory that pip's failed rollback left remains.
    const stray = path.join(envC.purelib, "robot_companion_backend-0.0.9.dist-info");
    assert.deepStrictEqual(fs.readdirSync(stray), [], "pip's leftover metadata directory is empty");
    assert.deepStrictEqual(afterC.filter(item => !before.C.includes(item)).sort(), ["(no metadata)==None", "robot-companion-backend==0.1.0.dev20"]);
    assert.deepStrictEqual(before.C.filter(item => !afterC.includes(item)), ["robot-companion-backend==0.0.9"]);
    await retain("19-retry-updated");
    note("Retry after the fix: 0.0.9 replaced by the verified bundled build; other packages unchanged; pip left an empty 0.0.9 .dist-info",
      { facts: C.facts, lsp: C.lsp.argv, stray });
    await host.cdp.palette("Robot Companion: Show Language Service Status");
    await sleep(1000);
    await retain("20-status");
    await host.quit();
    assert.equal(run(venvB, ["-c", "import importlib.metadata as m; print(m.version('robotcode'))"]).trim(), "2.7.0", "RobotCode is still installed");
    console.log("BACKEND ONBOARDING HOST: fresh setup, install, navigation, Test Explorer run/debug, update, cancellation, failure and retry verified");
  } catch (error) {
    console.error("Backend onboarding host failed:", error); process.exitCode = 1;
    try { await host?.cdp.retain("backend-onboarding-failure"); } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "backend-onboarding-transcript.json"), JSON.stringify(transcript, null, 2)); }
    await host?.close();
    try { fs.chmodSync(path.join(scratch, "envs"), 0o755); } catch { /* already gone */ }
    childProcess.spawnSync("chmod", ["-R", "u+w", scratch]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

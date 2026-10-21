// Two workspace folders with different supported runtimes stay isolated: imports, diagnostics,
// Test Explorer runs and concurrent debug sessions. A normal VS Code window driven over CDP with
// real pointer and keyboard input; real interpreters and real native backend processes.
//   A "Alpha Projekt" — .venv: Python 3.11 + Robot Framework 7.3.2
//   B "Beta Projekt"  — .venv: Python 3.13 + Robot Framework 7.5
// Both folders hold the same suite.robot. Each environment has its own installed shared_lib with
// different documentation; only B's has `Beta Only Keyword`. So the same text resolves differently:
// hovers and F12 follow the folder's interpreter, `Beta Only Keyword` is an error in A only, and its
// test fails in A and passes in B. A settings change in one folder restarts only that folder's
// services; the other folder's processes and diagnostics stay. Two debug sessions, one per folder,
// pause at the same line at the same time in their own interpreters; stopping one leaves the other
// paused, and it then completes. Run under a display (xvfb-run -a).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchHost, sleep, vscodeExecutable } = require("./cdp-host");
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

// Processes whose working directory is `root`, with the real interpreter binary behind each.
function processes(root) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      if (fs.realpathSync(`/proc/${pid}/cwd`) !== root) continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      found.push({ pid: Number(pid), argv, exe: fs.readlinkSync(`/proc/${pid}/exe`) });
    } catch { /* Ended while reading. */ }
  }
  return found;
}
// A native backend service (module or console-script form).
const service = (root, name) => processes(root).find(item => (item.argv.includes("robot_companion_backend") ||
  item.argv.some(arg => arg.endsWith("/robot-companion-backend"))) && item.argv[item.argv.length - 1] === name);
const worker = root => processes(root).find(item => item.argv.includes("robot_companion_backend.worker"));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const library = (owner, extra = "") => [
  "import sys", "",
  "def shared_keyword():",
  `    """${owner}'s shared_lib, installed only in the ${owner} environment."""`,
  "    return sys.executable", "", extra
].join("\n");
const BETA_ONLY = ["def beta_only_keyword():", "    \"\"\"Only Beta's shared_lib has this keyword.\"\"\"", ""].join("\n");
const SUITE = [
  "*** Settings ***", "Library    OperatingSystem", "Library    shared_lib", "",
  "*** Test Cases ***",
  "Shared Test",
  "    ${python}=    Shared Keyword",
  "    ${rf}=    Evaluate    robot.version.VERSION    modules=robot.version",
  "    Create File    ${CURDIR}/ran.txt    ${python}|${rf}", "",
  "Beta Only Test",
  "    Beta Only Keyword", ""
].join("\n");
const BREAK_LINE = "    ${rf}=    Evaluate    robot.version.VERSION    modules=robot.version";

async function main() {
  // Only a journey that reaches its last check passes (a stalled host must not exit 0).
  process.exitCode = 1;
  const envA = projectEnvironment({ python: "/opt/python3.11/bin/python3.11", wheels: "/opt/robot-wheels-py311",
    libraries: { shared_lib: library("Alpha") } });
  const envB = projectEnvironment({ python: "python3.13", wheels: "/opt/robot-wheels",
    libraries: { shared_lib: library("Beta", BETA_ONLY) } });
  if (envA.skip || envB.skip) { console.log(`SKIPPED: ${envA.skip || envB.skip}`); process.exitCode = 0; return; }
  const product = JSON.parse(fs.readFileSync(path.join(path.dirname(await vscodeExecutable()), "resources/app/product.json"), "utf8"));
  const runtime = env => {
    const exe = fs.realpathSync(env.python);
    const robot = env.receipt.packages.find(item => item.startsWith("robotframework==")).split("==")[1];
    return { exe, robot, minor: path.basename(exe).replace(/^python/, "") };
  };
  const facts = { A: runtime(envA), B: runtime(envB) };
  assert.notEqual(facts.A.minor, facts.B.minor, "the folders use different Python versions");
  assert.notEqual(facts.A.robot, facts.B.robot, "the folders use different Robot Framework versions");
  note("environments", { vscode: { version: product.version, commit: product.commit }, facts, receipts: [envA, envB].map(env => env.receipt.packages) });

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-multi-root-")));
  const profile = path.join(scratch, "profile"), extensions = path.join(scratch, "extensions");
  const roots = { A: path.join(scratch, "Alpha Projekt"), B: path.join(scratch, "Beta Projekt") };
  const names = { A: "Alpha", B: "Beta" };
  for (const [key, root] of Object.entries(roots)) {
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.symlinkSync(key === "A" ? envA.venv : envB.venv, path.join(root, ".venv"), "dir");
    fs.writeFileSync(path.join(root, "suite.robot"), SUITE);
    fs.writeFileSync(path.join(root, "problems.robot"), `*** Keywords ***\nUses Missing Step\n    Undefined Step ${names[key]}\n`);
    fs.writeFileSync(path.join(root, ".vscode/settings.json"), "{}");
    fs.writeFileSync(path.join(root, ".vscode/launch.json"), JSON.stringify({ version: "0.2.0", configurations: [{ type: "robotcompanion",
      request: "launch", name: `Debug ${names[key]}`, target: "${workspaceFolder}/suite.robot", attachPython: false }] }, null, 2));
  }
  const workspace = path.join(scratch, "two-runtimes.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: roots.A }, { path: roots.B }] }));
  const venvPython = key => path.join(roots[key], ".venv/bin/python");
  const ran = key => { try { return fs.readFileSync(path.join(roots[key], "ran.txt"), "utf8").trim(); } catch { return undefined; } };
  const expectedRun = key => `${venvPython(key)}|${facts[key].robot}`;
  const status = "[...document.querySelectorAll('.statusbar-item a')].find(el => el.textContent.startsWith('Robot:'))";
  let host;
  const retain = name => host.cdp.retain(`multi-root-${name}`);

  const open = async (key, file) => {
    await host.cdp.palette("Go to File");
    await host.cdp.text(path.join(roots[key], file));
    await host.cdp.wait(`document.querySelector('.quick-input-widget .monaco-list-row')?.textContent.includes(${JSON.stringify(file)})`);
    await host.cdp.key("Enter");
    await host.cdp.wait(`${status}?.getAttribute('aria-label')?.includes(${JSON.stringify(`Folder: ${require("url").pathToFileURL(roots[key]).href}`)}) && !${status}.textContent.includes('Checking')`, 20000);
    await sleep(300);
  };
  // The centre of the first visible occurrence of `needle` in the active editor (a few characters in).
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
    await host.cdp.hover(await tokenPoint(needle));
    const text = await host.cdp.wait(`(() => { const t = ${visibleHover}; return t.includes(${JSON.stringify(expected)}) && t; })()`, 20000);
    if (shot) await retain(shot);
    await host.cdp.away().catch(() => {});
    await host.cdp.key("Escape");
    return text;
  };
  const errorCount = () => host.cdp.eval("document.querySelectorAll('.editor-instance .monaco-editor .squiggly-error').length");
  const activeFile = () => host.cdp.eval("(document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') || '').split(',')[0].trim()");
  const breadcrumbs = () => host.cdp.eval("[...document.querySelectorAll('.editor-group-container.active .breadcrumbs-control .monaco-breadcrumb-item')].map(el => el.textContent).join('/')");
  const pickVenv = async (key) => {
    await open(key, "suite.robot");
    await host.cdp.click(status);
    // A cold interpreter can exceed the picker's bounded check: choose Refresh, as a user would.
    for (let attempt = 0; ; attempt++) {
      const shown = await host.cdp.wait(`(() => { const t = document.querySelector('.quick-input-widget')?.textContent || '';
        return t.includes('Robot Framework ${facts[key].robot}') ? 'ready' : /\.venvCheck timed out/.test(t) ? 'timedOut' : false; })()`, 30000);
      if (shown === "ready") break;
      assert(attempt < 3, `${key}: the .venv check keeps timing out`);
      note(`${key}: picker check timed out; Refresh`);
      await host.cdp.filter("Refresh"); await host.cdp.key("Enter");
    }
    await host.cdp.filter(".venv"); await host.cdp.key("Enter");
    await host.cdp.wait(`${status}?.textContent.startsWith('Robot: .venv (${facts[key].minor}.')`, 20000);
  };
  const services = key => until(() => {
    const lsp = service(roots[key], "lsp"), discovery = service(roots[key], "discovery");
    return lsp?.argv[0] === venvPython(key) && discovery?.argv[0] === venvPython(key) && { lsp, discovery };
  }, `${key} language and discovery processes on its selected .venv interpreter`);
  // Problems view rows (file rows and their problems), read while the panel is maximized.
  const problems = async () => {
    await host.cdp.palette("View: Focus Problems (Errors, Warnings, Infos)");
    await host.cdp.wait("[...document.querySelectorAll('.markers-panel .monaco-list-row')].some(row => row.getClientRects().length)", 20000);
    await sleep(500);
    return host.cdp.eval("[...document.querySelectorAll('.markers-panel .monaco-list-row')].filter(row => row.getClientRects().length).map(row => row.getAttribute('aria-label') || row.textContent)");
  };

  try {
    host = await launchHost({ name: "multi-root", profile, extensions, timeout: 600000, targets: [workspace, path.join(roots.A, "suite.robot")], ready: `!!${status}` });
    // ---- Each folder selects its own .venv interpreter through the picker ----
    await pickVenv("A");
    const servicesA = await services("A");
    await pickVenv("B");
    const servicesB = await services("B");
    assert(servicesA.lsp.exe.endsWith(`python${facts.A.minor}`) && servicesB.lsp.exe.endsWith(`python${facts.B.minor}`),
      `services run each folder's interpreter: ${servicesA.lsp.exe} / ${servicesB.lsp.exe}`);
    assert.equal(service(roots.A, "lsp")?.pid, servicesA.lsp.pid, "B's selection left A's language service running");
    note("each folder's language and discovery services run its own interpreter", { A: servicesA, B: servicesB });
    await retain("1-selected");

    // ---- Imports: the same `Library    shared_lib` resolves in each folder's environment ----
    for (const key of ["A", "B"]) {
      await open(key, "suite.robot");
      const doc = await hoverText("Shared Keyword", `${names[key]}'s shared_lib, installed only in the ${names[key]} environment.`, `2-${key}-import-hover`);
      assert(!doc.includes(`${names[key === "A" ? "B" : "A"]}'s shared_lib`), `${key}: only its own library is shown: ${doc}`);
      await host.cdp.press(await tokenPoint("Shared Keyword"));
      await host.cdp.key("F12");
      await until(async () => await activeFile() === "shared_lib.py", `${key}: F12 opened shared_lib.py`, 20000);
      const crumbs = await until(async () => { const c = await breadcrumbs(); return c.includes("site-packages") && c; }, `${key}: breadcrumbs`, 10000);
      assert(crumbs.includes(`python${facts[key].minor}`), `${key}: definition in its python${facts[key].minor} site-packages: ${crumbs}`);
      await retain(`2-${key}-import-definition`);
      note(`${key}: hover and F12 on Shared Keyword use its own environment's shared_lib`, { doc: doc.slice(0, 160), crumbs });
    }

    // ---- Diagnostics: Beta Only Keyword is an error in A only ----
    await open("A", "suite.robot");
    await until(async () => await errorCount() === 1, "A: exactly one error in suite.robot", 30000);
    await hoverText("Beta Only Keyword", "No keyword with name 'Beta Only Keyword' found.", "3-A-diagnostic");
    await open("B", "suite.robot");
    await sleep(2500);
    assert.equal(await errorCount(), 0, "B: the same text has no error");
    await retain("3-B-no-diagnostic");
    for (const key of ["A", "B"]) { await open(key, "problems.robot"); await until(async () => await errorCount() === 1, `${key}: problems.robot error`, 30000); }
    const before = await problems();
    note("Problems view before the folder restart", { rows: before });
    assert(before.some(row => row.includes("Undefined Step Alpha")) && before.some(row => row.includes("Undefined Step Beta")), "both folders' diagnostics are listed");
    assert.equal(before.filter(row => row.includes("Beta Only Keyword")).length, 1, "Beta Only Keyword is reported once, for A");
    await retain("4-problems-before");

    // ---- A settings change in A restarts A's services only ----
    const backendA = path.join(envA.venv, "bin", "robot-companion-backend");
    fs.writeFileSync(path.join(roots.A, ".vscode/settings.json"), JSON.stringify({ "robotCompanion.nativeBackendExecutable": backendA }));
    const overriddenA = await until(() => { const p = service(roots.A, "lsp"); return p?.argv.includes(backendA) && p; }, "A language process from nativeBackendExecutable");
    await until(() => !alive(servicesA.lsp.pid) && !alive(servicesA.discovery.pid), "A's previous services stopped");
    for (let i = 0; i < 10; i++) {
      assert.equal(service(roots.B, "lsp")?.pid, servicesB.lsp.pid, "B's language process is untouched by A's setting");
      assert.equal(service(roots.B, "discovery")?.pid, servicesB.discovery.pid, "B's discovery process is untouched by A's setting");
      await sleep(300);
    }
    const during = await problems();
    assert(during.some(row => row.includes("Undefined Step Beta")), `B's diagnostics stay while A restarts: ${JSON.stringify(during)}`);
    await until(async () => (await problems()).some(row => row.includes("Undefined Step Alpha")), "A's diagnostics republished by its restarted service", 30000);
    note("A's nativeBackendExecutable change restarted A only; B's processes and diagnostics stayed", { overriddenA, during });
    await retain("5-scoped-restart");
    fs.writeFileSync(path.join(roots.A, ".vscode/settings.json"), "{}");
    const restoredA = await services("A");
    assert.equal(service(roots.B, "lsp")?.pid, servicesB.lsp.pid, "B still untouched after A's setting is removed");
    note("A back on its selected interpreter; B untouched", { restoredA });

    // ---- Test Explorer: one Run All, each folder's tests in its own interpreter and items ----
    await host.cdp.click("[...document.querySelectorAll('.activitybar .action-label')].find(a => /^Testing/.test(a.getAttribute('aria-label') || ''))");
    await host.cdp.wait("[...document.querySelectorAll('.test-explorer-tree')].some(e => e.getClientRects().length)", 20000);
    // Rows: accessible name ("Shared Test (Passed), in 2.0ms") and visible text ("Suite Alpha Projekt: 2.0ms":
    // a suite's description names its folder).
    const tree = () => host.cdp.eval("[...document.querySelectorAll('.test-explorer-tree .monaco-list-row')].filter(r => r.getClientRects().length).map(r => ({ level: Number(r.getAttribute('aria-level')), label: r.getAttribute('aria-label') || '', text: r.textContent }))");
    // Expand every row (keyboard: focus the tree, then Right on each collapsed row).
    await host.cdp.click("document.querySelector('.test-explorer-tree .monaco-list-row')");
    for (let i = 0; i < 12; i++) { await host.cdp.key("ArrowRight"); await host.cdp.key("ArrowRight"); await host.cdp.key("ArrowDown"); }
    const discovered = await until(async () => { const rows = await tree(); return rows.filter(r => /^Shared Test/.test(r.label)).length === 2 && rows; }, "both folders' Shared Test items", 30000);
    note("Test Explorer items", { rows: discovered });
    for (const key of ["A", "B"]) fs.rmSync(path.join(roots[key], "ran.txt"), { force: true });
    await host.cdp.palette("Test: Run All Tests");
    await until(() => ran("A") && ran("B"), "Run All wrote ran.txt in both folders", 120000);
    assert.equal(ran("A"), expectedRun("A")); assert.equal(ran("B"), expectedRun("B"));
    // Each folder's items carry its own result: Beta Only Test fails in A only.
    const grouped = async () => {
      const rows = await tree(); const groups = {}; let top;
      for (const row of rows) { if (row.level === 1) top = row.text; else (groups[top] ||= []).push(row.label); }
      return groups;
    };
    const results = await until(async () => {
      const groups = await grouped();
      const a = Object.entries(groups).find(([text]) => text.startsWith(`Suite${path.basename(roots.A)}`))?.[1] || [];
      const b = Object.entries(groups).find(([text]) => text.startsWith(`Suite${path.basename(roots.B)}`))?.[1] || [];
      const has = (rows, text) => rows.some(row => row.startsWith(text));
      return has(a, "Shared Test (Passed)") && has(a, "Beta Only Test (Failed)") && has(b, "Shared Test (Passed)") && has(b, "Beta Only Test (Passed)") && groups;
    }, "per-folder results in Test Explorer", 30000).catch(async error => { throw new Error(`${error.message}: ${JSON.stringify(await tree())}`); });
    note("Test Explorer Run All: A ran 3.11/RF 7.3.2 and B 3.13/RF 7.5; Beta Only Test failed in A and passed in B", { A: ran("A"), B: ran("B"), results });
    await retain("6-test-results");

    // ---- Debug: one paused session per folder at the same line, at the same time ----
    for (const key of ["A", "B"]) {
      await open(key, "suite.robot");
      await host.cdp.press(await tokenPoint("Evaluate    robot.version"));
      await host.cdp.key("F9");
      await host.cdp.wait("document.querySelectorAll('.editor-instance .codicon-debug-breakpoint').length >= 1", 10000);
      fs.rmSync(path.join(roots[key], "ran.txt"), { force: true });
    }
    // The Call Stack view: its header state and each visible row's accessible name and text.
    const callStackPane = "[...document.querySelectorAll('.pane')].find(p => /^Call Stack/.test(p.querySelector('.pane-header')?.textContent || ''))";
    const sessions = `[${callStackPane}?.querySelector('.pane-header')?.textContent || '', ...[...(${callStackPane}?.querySelectorAll('.monaco-list-row') || [])].filter(r => r.getClientRects().length).map(r => (r.getAttribute('aria-label') || '') + ' | ' + r.textContent)]`;
    const startDebug = async key => {
      await host.cdp.palette("Debug: Select and Start Debugging");
      await host.cdp.wait(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(row => row.textContent.includes('Debug ${names[key]}'))`);
      await host.cdp.text(`Debug ${names[key]}`);
      await host.cdp.wait(`document.querySelector('.quick-input-widget .monaco-list-row.focused')?.textContent.includes('Debug ${names[key]}')`);
      await host.cdp.key("Enter");
      return until(() => { const dap = service(roots[key], "dap"), work = worker(roots[key]); return dap && work && { dap, worker: work }; }, `${key} debug adapter and Robot worker`, 30000);
    };
    const debugA = await startDebug("A");
    const pausedA = await host.cdp.wait(`(() => { const s = ${sessions}; return s.some(t => /Paused on breakpoint/i.test(t)) && s.some(t => /suite\.robot.*8:1|8:1/.test(t)) && s; })()`, 30000);
    note("A paused on its breakpoint", { callStack: pausedA });
    const debugB = await startDebug("B");
    const pausedRow = name => `s.some(t => /^Session Debug ${name} \\(${name} Projekt\\) Paused on breakpoint/.test(t))`;
    const both = await host.cdp.wait(`(() => { const s = ${sessions}; return ${pausedRow("Alpha")} && ${pausedRow("Beta")} && s; })()`, 30000);
    assert(debugA.dap.exe.endsWith(`python${facts.A.minor}`) && debugA.worker.exe.endsWith(`python${facts.A.minor}`), `A's debug processes run 3.11: ${JSON.stringify(debugA)}`);
    assert(debugB.dap.exe.endsWith(`python${facts.B.minor}`) && debugB.worker.exe.endsWith(`python${facts.B.minor}`), `B's debug processes run 3.13: ${JSON.stringify(debugB)}`);
    note("two concurrent sessions paused on the same line, each in its folder's interpreter", { debugA, debugB, callStack: both });
    await retain("7-two-sessions-paused");
    // Focus A's session by a pointer click on its name in the Call Stack (not on the row's inline
    // actions), check that this click changed nothing, then Shift+F5 stops the focused session.
    await host.cdp.click(`[...(${callStackPane}?.querySelectorAll('.monaco-list-row') || [])].filter(r => r.getClientRects().length && /^Session Debug Alpha/.test(r.getAttribute('aria-label') || ''))
      .map(r => [...r.querySelectorAll('*')].find(el => !el.children.length && el.textContent.startsWith('Debug Alpha') && !el.closest('.actions, .monaco-action-bar')))[0]`);
    await host.cdp.wait(`(() => { const s = ${sessions}; return ${pausedRow("Alpha")} && ${pausedRow("Beta")}; })()`, 5000);
    await host.cdp.key("F5", 8);
    await until(() => !alive(debugA.dap.pid) && !alive(debugA.worker.pid), "A's debug processes ended");
    assert(alive(debugB.dap.pid) && alive(debugB.worker.pid), "B's debug processes keep running");
    // With one session left, the Call Stack shows its frames: B is still paused at line 8.
    const left = await host.cdp.wait(`(() => { const s = ${sessions}; return !s.some(t => /Debug Alpha/.test(t)) && s.some(t => /Paused on breakpoint/.test(t)) && s.some(t => /line 8, suite\\.robot/.test(t)) && s; })()`, 15000);
    assert(!ran("B"), "B is still paused before Create File");
    assert.equal(ran("A"), undefined, "A's stopped session never reached Create File");
    note("stopping A's session left B's session paused", { callStack: left });
    await retain("8-A-stopped-B-paused");
    // F5 continues the remaining (active) session: B completes in its own interpreter.
    await host.cdp.key("F5");
    await until(() => ran("B"), "B's session wrote ran.txt", 60000);
    assert.equal(ran("B"), expectedRun("B"));
    await until(() => !alive(debugB.dap.pid) && !alive(debugB.worker.pid), "B's debug processes ended after its run");
    assert.equal(ran("A"), undefined, "A's stopped run stays stopped");
    note("B's session continued to completion in its own interpreter", { B: ran("B") });
    await retain("9-B-completed");
    await host.quit();
    note("Ctrl+Q exit");
    const leftover = ["A", "B"].flatMap(key => processes(roots[key]));
    assert.deepStrictEqual(leftover, [], "no folder process is left after exit");
    process.exitCode = 0;
    console.log("MULTI-ROOT ISOLATION HOST: imports, diagnostics, scoped restart, Test Explorer runs and concurrent debug sessions stay per folder");
  } catch (error) {
    console.error("Multi-root isolation host failed:", error); process.exitCode = 1;
    try { await host?.cdp.retain("multi-root-failure"); } catch (inner) { console.error("No failure capture:", inner.message); }
  } finally {
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "multi-root-transcript.json"), JSON.stringify(transcript, null, 2)); }
    await host?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

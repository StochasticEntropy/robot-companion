"use strict";

// Test Explorer run engine. No VS Code dependency: one Robot Framework process
// per workspace folder and request, started without a shell in its own process
// group (on Windows, ended as a process tree), with its own output folder.
// Robot builds the folder's suites itself, so every directory's and the
// folder's __init__.robot (suite setups, Test Tags, Default Tags) apply as in a
// run from the command line; a pre-run modifier then keeps only the selected
// tests. Results come only from that process's output.xml, so one run's
// results can never reach another run's tests.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { readTestResults } = require("./robot-results");
const { processGuard } = require("./process-guard");
const { normalizeTag } = require("./robot-tags");

const MODIFIER = path.join(__dirname, "RobotCompanionSelection.py");
const RUN_INPUTS = { arguments: "arguments.txt", selection: "selection.json", selectionResult: "selection-result.json",
  modifier: "RobotCompanionSelection.py", manifest: "robot-companion-run.json" };

// Groups selected tests by workspace folder and execution mode: Robot runs
// tests and tasks only in separate runs (`rpa`: true for tasks, false for
// tests, undefined when the discovery provider does not say). Each test is
// identified by its source file and the 1-based line of its name, which is how
// the selection modifier finds it in Robot's model, so names with variables,
// repeated names and glob characters need no --test pattern.
// selections: [{ folderPath, rpa?, tests: [{ id, name, source, line, occurrence? }] }]
function planFolderRuns(selections) {
  const runs = new Map();
  for (const selection of selections) {
    const folderPath = path.resolve(selection.folderPath);
    const key = `${folderPath}\0${selection.rpa}`;
    const run = runs.get(key) || { folderPath, rpa: selection.rpa, tests: new Map() };
    for (const test of selection.tests) if (test.source && test.line) run.tests.set(test.id, test);
    runs.set(key, run);
  }
  return [...runs.values()].filter(run => run.tests.size).map(run => {
    const tests = [...run.tests.values()];
    return { folderPath: run.folderPath, rpa: run.rpa, tests, files: [...new Set(tests.map(test => path.resolve(test.source)))] };
  });
}

// A --parseinclude value is a glob; brackets make *, ? and [ match only themselves.
const escapeParseInclude = file => file.replace(/[*?[]/g, character => `[${character}]`);

// Robot reads an argument file line by line (Python's line breaks), strips
// each line and splits an option from its value at the first space. A value
// that would not survive that is given on the command line instead.
const PYTHON_LINE_BREAK = /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
const PYTHON_SPACE_EDGE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const argumentFileSafe = value => Boolean(value) && !PYTHON_LINE_BREAK.test(value) && !PYTHON_SPACE_EDGE.test(value);

// Writes a run's inputs into its own folder and returns the Robot arguments
// that use them: the selection (source, name line and name of each selected
// test), a copy
// of the selection modifier, and an argument file with the modifier, one
// --parseinclude per selected file (Robot parses nothing else, init files
// excepted) and, unless a debug adapter chooses the output folder, the output
// folder. `tagOptions` are a profile's --include/--exclude patterns;
// `listeners` are listener files for --listener.
function writeRunInputs(runDir, { tests, files, outputDir = runDir, tagOptions = {}, listeners = [] }) {
  const modifier = path.join(runDir, RUN_INPUTS.modifier);
  fs.copyFileSync(MODIFIER, modifier);
  fs.writeFileSync(path.join(runDir, RUN_INPUTS.selection),
    JSON.stringify({ tests: tests.map(test => [path.resolve(test.source), test.line, test.name]) }, null, 1));
  const options = [
    ...(outputDir ? [["--outputdir", outputDir], ["--output", "output.xml"]] : []),
    ["--prerunmodifier", modifier],
    ...listeners.map(listener => ["--listener", listener]),
    ...files.map(file => ["--parseinclude", escapeParseInclude(file)]),
    ...(tagOptions.include || []).map(pattern => ["--include", pattern]),
    ...(tagOptions.exclude || []).map(pattern => ["--exclude", pattern])
  ];
  const lines = [], direct = [];
  for (const [option, value] of options) {
    if (argumentFileSafe(value)) lines.push(`${option} ${value}`);
    else direct.push(option, value);
  }
  const argumentFile = path.join(runDir, RUN_INPUTS.arguments);
  fs.writeFileSync(argumentFile, lines.join("\n") + "\n", "utf8");
  return ["--argumentfile", argumentFile, ...direct];
}

// Which selected tests Robot found in its model ({ found, missing: [[source, line]] }),
// or undefined when the modifier did not run.
function readSelectionResult(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, RUN_INPUTS.selectionResult), "utf8"));
  } catch {
    return undefined;
  }
}

// What a run did, kept in its folder next to Robot's own files.
function writeRunManifest(runDir, manifest) {
  try {
    fs.writeFileSync(path.join(runDir, RUN_INPUTS.manifest), JSON.stringify(manifest, null, 1));
  } catch { /* The results themselves stay usable without it. */ }
}

// Robot's messages for a test that a stop signal interrupted or never let run.
const STOPPED_MESSAGES = ["Execution terminated by signal", "Test execution stopped due to a fatal error."];
const stoppedBySignal = result => STOPPED_MESSAGES.some(message => String(result?.message || "").includes(message));

const samePath = (left, right) => {
  if (!left || !right) return false;
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
};

// Maps each requested test to its own <test> entry in output.xml: same source
// file (the test's own `source`, else `suitePath`), the same name line (RF
// records it) and the same name under Robot's name normalization, or, without
// lines, the same name and occurrence for a repeated name. A name that Robot
// replaced differently at run time (a variable from the command line) still
// matches when `confirmed` (the selection modifier's check of the written name,
// "source\0line") holds the test. Entries of tests not requested are ignored.
function matchResults(xml, suitePath, tests, confirmed = new Set()) {
  const entries = readTestResults(xml);
  const results = new Map();
  for (const test of tests) {
    const source = test.source || suitePath;
    const own = entries.filter(entry => samePath(entry.source, source));
    const named = own.filter(entry => entry.name === test.name);
    const sameName = entry => normalizeTag(entry.name) === normalizeTag(test.name) ||
      confirmed.has(`${path.resolve(source)}\0${test.line}`);
    const found = (test.line && own.find(entry => entry.line === test.line && sameName(entry))) ||
      (!own.some(entry => entry.line) && named[(test.occurrence || 1) - 1]);
    if (found) results.set(test.id, found);
  }
  return results;
}

// A run's results; with the run folder of its inputs, the selection modifier's
// confirmations count as name checks.
function readRunResults(outputDir, suitePath, tests, runDir = outputDir) {
  let xml;
  try {
    xml = fs.readFileSync(path.join(outputDir, "output.xml"), "utf8");
  } catch {
    return new Map(); // No readable output.xml: the caller reports the exit outcome.
  }
  const selection = runDir && readSelectionResult(runDir);
  const missing = new Set((selection?.missing || []).map(([source, line]) => `${path.resolve(source)}\0${line}`));
  const confirmed = new Set(selection ? tests.map(test => `${path.resolve(test.source || suitePath)}\0${test.line}`)
    .filter(key => !missing.has(key)) : []);
  return matchResults(xml, suitePath, tests, confirmed);
}

// One Robot process and its process group. cancel() signals the whole group:
// SIGTERM first (Robot then stops and writes its results), SIGKILL after
// `graceMs`, so a stop always ends within a bounded time. When Robot exits,
// anything it left in its group is killed, and the run does not wait more
// than `closeMs` for output pipes that a leftover process kept open.
// Robot's Process library starts each process in a new session (POSIX), out of
// the group: cancel() therefore also lists Robot's descendants once and signals
// those outside the group the same way, each only while its PID still has the
// same start time. `cleanup` settles when that is done.
// Windows has no process group to signal and a console process cannot be asked
// to stop: cancel() ends Robot and every process it started at once with
// `taskkill /T /F` (a venv's python.exe starts the real interpreter as its
// child, and a test's Start Process starts more), so the stopped run writes no
// output.xml. `platform` and `taskkill` exist for tests.
class RobotProcess {
  constructor({ executable, args, cwd, env = {}, onOutput = () => {}, closeMs = 2000, platform = process.platform,
    taskkill = windowsTaskkill() }) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onOutput = onOutput;
    this.closeMs = closeMs;
    this.platform = platform;
    this.taskkill = taskkill;
    this.cancelled = false;
    this.cleanup = Promise.resolve();
  }

  start() {
    if (this.done) return this.done;
    this.done = new Promise(resolve => {
      if (this.cancelled) { resolve({ cancelledBeforeStart: true }); return; }
      let child;
      try {
        child = spawn(this.executable, this.args, {
          cwd: this.cwd, shell: false, windowsHide: true, detached: this.platform !== "win32",
          env: { ...process.env, ...this.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        resolve({ spawnError: error });
        return;
      }
      this.child = child;
      this.pid = child.pid;
      // Ended by the process guard if the extension host goes away without stopping it.
      const release = processGuard.register(child.pid, { group: process.platform !== "win32" });
      const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
      child.stdout.on("data", chunk => this.onOutput(out.write(chunk)));
      child.stderr.on("data", chunk => this.onOutput(err.write(chunk)));
      let settled = false, closeTimer;
      const settle = value => {
        if (settled) return;
        settled = true;
        release();
        clearTimeout(this.forceTimer);
        clearTimeout(closeTimer);
        resolve(value);
      };
      child.on("error", error => settle({ spawnError: error }));
      child.on("exit", (exitCode, signal) => {
        this.exited = true;
        this.signalGroup("SIGKILL"); // Leftovers of the run go with it.
        closeTimer = setTimeout(() => settle({ exitCode, signal }), this.closeMs);
      });
      child.on("close", (exitCode, signal) => {
        const rest = out.end() + err.end();
        if (rest) this.onOutput(rest);
        settle({ exitCode, signal });
      });
    });
    return this.done;
  }

  cancel(graceMs = 2000) {
    if (this.cancelled) return this.done || Promise.resolve();
    this.cancelled = true;
    if (!this.child) return this.done || Promise.resolve();
    if (this.exited) { this.signalGroup("SIGKILL"); return this.done; }
    // The listing comes first: once Robot has exited, its escaped processes
    // are no longer below it.
    if (this.platform !== "win32") {
      this.after(async () => { this.escaped = (await descendants(this.pid)).filter(entry => entry.pgid !== this.pid); });
    }
    this.signalGroup("SIGTERM");
    this.forceTimer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    return this.done;
  }

  // Signals the run's group (or, on Windows, ends its tree) and, after a
  // cancel, the processes that left the group. Steps run in order.
  signalGroup(signal) {
    this.after(async () => {
      if (this.platform === "win32") {
        // Only while Robot runs: taskkill /T finds the processes through it.
        if (this.pid && !this.exited) await this.killTree(signal);
        return;
      }
      try {
        if (this.pid) process.kill(-this.pid, signal);
      } catch { /* Group already gone. */ }
      if (this.escaped?.length) await signalProcesses(this.escaped, signal);
    });
  }

  after(step) {
    this.cleanup = this.cleanup.then(step).catch(() => undefined);
  }

  killTree(signal) {
    return new Promise(resolve => {
      const fallback = () => { try { this.child?.kill(signal); } catch { /* Already gone. */ } resolve(); };
      try {
        const killer = spawn(this.taskkill, ["/PID", String(this.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", fallback);
        killer.on("exit", code => { if (code !== 0 && !this.exited) fallback(); else resolve(); });
      } catch {
        fallback();
      }
    });
  }

  // True while any process of this run's group still exists (POSIX only).
  groupAlive() {
    if (!this.pid || this.platform === "win32") return false;
    try { process.kill(-this.pid, 0); return true; } catch { return false; }
  }
}

// One `ps` listing: { pid, ppid, pgid, started } per process, [] when ps fails.
function processTable() {
  return new Promise(resolve => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { timeout: 3000, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        if (error) { resolve([]); return; }
        resolve(stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
          .map(([, pid, ppid, pgid, started]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started })));
      });
  });
}

// Every process below `pid`.
async function descendants(pid) {
  const table = await processTable(), found = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const entry of table) {
      if (entry.ppid === parent && entry.pid !== pid && !found.includes(entry)) { found.push(entry); queue.push(entry.pid); }
    }
  }
  return found;
}

// Signals the listed processes that still run with the same start time.
async function signalProcesses(list, signal) {
  if (!list.length) return;
  const current = new Map((await processTable()).map(entry => [entry.pid, entry.started]));
  for (const entry of list) {
    if (current.get(entry.pid) !== entry.started) continue;
    try { process.kill(entry.pid, signal); } catch { /* Gone meanwhile. */ }
  }
}

function windowsTaskkill() {
  return path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
}

// A fresh output folder per run, keeping the newest `keep` folders and never
// removing a folder in `inUse` (runs still in progress, and the folders that
// hold the latest result of a test listed in Test Explorer).
function createRunDirectory(root, keep = 40, inUse = new Set()) {
  fs.mkdirSync(root, { recursive: true });
  try {
    const old = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => entry.name).sort();
    for (const name of old.slice(0, Math.max(0, old.length - keep + 1))) {
      if (inUse.has(path.join(root, name))) continue;
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch { /* Old results are housekeeping only. */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return fs.mkdtempSync(path.join(root, `${stamp}-`));
}

module.exports = { RUN_INPUTS, planFolderRuns, escapeParseInclude, argumentFileSafe, writeRunInputs, readSelectionResult,
  writeRunManifest, stoppedBySignal, matchResults, readRunResults, RobotProcess, createRunDirectory };

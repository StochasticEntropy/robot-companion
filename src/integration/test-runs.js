"use strict";

// Test Explorer run engine. No VS Code dependency: one Robot Framework process
// per suite file, started without a shell in its own process group, with its
// own output folder. Results come only from that process's output.xml, so one
// run's results can never reach another run's tests.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { escapeRobotNamePattern } = require("../features/run/runner-core");
const { readTestResults } = require("./robot-results");

// Groups selected tests by suite file. A suite selected as a whole runs
// without --test filters; otherwise each selected test name becomes a filter.
// selections: [{ suitePath, whole?, tests: [{ id, name, occurrence? }] }]
function planSuiteRuns(selections) {
  const runs = new Map();
  for (const selection of selections) {
    const key = path.resolve(selection.suitePath);
    const run = runs.get(key) || { suitePath: key, whole: false, tests: new Map() };
    run.whole ||= selection.whole === true;
    for (const test of selection.tests) run.tests.set(test.id, test);
    runs.set(key, run);
  }
  return [...runs.values()].filter(run => run.tests.size).map(run => ({
    suitePath: run.suitePath, tests: [...run.tests.values()],
    testNames: run.whole ? [] : [...new Set([...run.tests.values()].map(test => test.name))]
  }));
}

// --test patterns that match only the literal names (see escapeRobotNamePattern).
const testFilters = (testNames = []) => testNames.flatMap(name => ["--test", escapeRobotNamePattern(name)]);

// Robot's own arguments for one suite run. The results file is always
// output.xml in the run's folder, even if robotArguments set another --output.
function robotArguments({ robotArguments: extra = [], outputDir, testNames = [], suitePath }) {
  return [...extra, "--outputdir", outputDir, "--output", "output.xml", ...testFilters(testNames), suitePath];
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
// file, same name, and the same occurrence for a repeated name. Entries for
// tests that were not requested are ignored.
function matchResults(xml, suitePath, tests) {
  const entries = readTestResults(xml).filter(result => samePath(result.source, suitePath));
  const results = new Map();
  for (const test of tests) {
    const found = entries.filter(entry => entry.name === test.name)[(test.occurrence || 1) - 1];
    if (found) results.set(test.id, found);
  }
  return results;
}

function readRunResults(outputDir, suitePath, tests) {
  try {
    return matchResults(fs.readFileSync(path.join(outputDir, "output.xml"), "utf8"), suitePath, tests);
  } catch {
    return new Map(); // No readable output.xml: the caller reports the exit outcome.
  }
}

// One Robot process and its process group. cancel() signals the whole group:
// SIGTERM first (Robot then stops and writes its results), SIGKILL after
// `graceMs`, so a stop always ends within a bounded time. When Robot exits,
// anything it left in its group is killed, and the run does not wait more
// than `closeMs` for output pipes that a leftover process kept open.
class RobotProcess {
  constructor({ executable, args, cwd, env = {}, onOutput = () => {}, closeMs = 2000 }) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onOutput = onOutput;
    this.closeMs = closeMs;
    this.cancelled = false;
  }

  start() {
    if (this.done) return this.done;
    this.done = new Promise(resolve => {
      if (this.cancelled) { resolve({ cancelledBeforeStart: true }); return; }
      let child;
      try {
        child = spawn(this.executable, this.args, {
          cwd: this.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
          env: { ...process.env, ...this.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        resolve({ spawnError: error });
        return;
      }
      this.child = child;
      this.pid = child.pid;
      const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
      child.stdout.on("data", chunk => this.onOutput(out.write(chunk)));
      child.stderr.on("data", chunk => this.onOutput(err.write(chunk)));
      let settled = false, closeTimer;
      const settle = value => {
        if (settled) return;
        settled = true;
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
    this.signalGroup("SIGTERM");
    this.forceTimer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    return this.done;
  }

  signalGroup(signal) {
    try {
      if (process.platform !== "win32" && this.pid) process.kill(-this.pid, signal);
      else this.child?.kill(signal);
    } catch { /* Group already gone. */ }
  }

  // True while any process of this run's group still exists.
  groupAlive() {
    if (!this.pid || process.platform === "win32") return false;
    try { process.kill(-this.pid, 0); return true; } catch { return false; }
  }
}

// A fresh output folder per suite run, keeping the newest `keep` folders and
// never removing a folder in `inUse` (runs still in progress).
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

module.exports = { planSuiteRuns, testFilters, robotArguments, stoppedBySignal, matchResults, readRunResults, RobotProcess, createRunDirectory };

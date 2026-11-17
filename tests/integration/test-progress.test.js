"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { followProgress } = require("../../src/integration/test-progress");
const { writeRunInputs, readRunResults } = require("../../src/integration/test-runs");

const interpreters = [
  process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python",
  process.env.ROBOT_COMPANION_RF732_PYTHON
];
for (const python of interpreters) {
  test(`Live Robot progress and final suite teardown with ${python || "RF 7.3.2"}`,
    { skip: !python || !fs.existsSync(python) }, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot progress "));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const run = path.join(root, "run");
      fs.mkdirSync(run);
      const source = path.join(root, "sample.robot");
      fs.writeFileSync(source, [
        "*** Settings ***", "Suite Teardown    Fail    teardown",
        "*** Test Cases ***", "Repeated", "    Log    first 🐍", "    Sleep    1s",
        "Repeated", "    Fail    second", "Ambiguous failure",
        "    Run Keyword And Ignore Error    Fail    ambiguous", "    Fail    ambiguous", ""
      ].join("\n"));
      const tests = [4, 7, 9].map(line => ({
        id: String(line), source, line, name: line === 9 ? "Ambiguous failure" : "Repeated"
      }));
      const events = [];
      const progress = followProgress(run, event => events.push(event));
      t.after(() => progress.close());
      const args = writeRunInputs(run, { tests, files: [source], listeners: [progress.listener] });
      const child = spawn(python, ["-m", "robot", ...args, source], { stdio: "ignore" });
      t.after(() => child.kill());
      const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      while (!events.some(event => event.message === "first 🐍") && child.exitCode === null)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(child.exitCode, null);
      assert.deepEqual(events.filter(event => event.event === "start").map(event => event.line), [4]);
      assert.equal(await exit, 3);
      await progress.close();
      const ends = events.filter(event => event.event === "end");
      assert.deepEqual(ends.map(event => [event.source, event.line, event.status]), [[source, 4, "PASS"], [source, 7, "FAIL"], [source, 9, "FAIL"]]);
      assert.deepEqual(ends[1].location, [source, 8]);
      assert.equal(ends[2].location, null);
      const final = readRunResults(run, source, tests);
      assert.equal(final.get("4").status, "FAIL");
      assert.match(final.get("4").message, /teardown/);
    });
}

test("Closing an interrupted journal drains complete UTF-8 records across polling batches", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot progress journal "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const progress = followProgress(root, event => events.push(event));
  t.after(() => progress.close());
  const text = "🛠".repeat(35000);
  const record = JSON.stringify({ event: "log", message: text });
  fs.writeFileSync(path.join(root, "progress.jsonl"), record + "\n" +
    JSON.stringify({ event: "end", line: 4, status: "PASS" }) + '\n{"event":"log"');
  await progress.close();
  assert.deepEqual(events, [{ event: "log", message: text }, { event: "end", line: 4, status: "PASS" }]);
});

for (const python of interpreters) {
  test(`Testing publishes one ordinary failure and honors suite teardown Skip with ${python || "RF 7.3.2"}`,
    { skip: !python || !fs.existsSync(python) }, async t => {
      const Module = require("node:module");
      const load = Module._load;
      const vscode = {
        Uri: { file: value => value },
        Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
        Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        TestMessage: class { constructor(message) { this.message = message; } }
      };
      let TestWorkspace;
      try {
        Module._load = function(request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
        ({ TestWorkspace } = require("../../src/integration/test-workspace"));
      } finally { Module._load = load; }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot final progress "));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const runDir = path.join(root, "output");
      fs.mkdirSync(runDir);
      const tests = ["ordinary", "skipping"].map(id => {
        const source = path.join(root, id + ".robot");
        const settings = id === "skipping" ? ["*** Settings ***", "Suite Teardown    Skip    intentional"] : [];
        fs.writeFileSync(source, [...settings, "*** Test Cases ***", "Case", "    Fail    original", ""].join("\n"));
        return { id, source, name: "Case", line: settings.length + 2, item: { id } };
      });
      const plan = { tests, folderPath: root };
      const output = [], terminal = [];
      const run = {
        started() {},
        appendOutput(text, location, item) { output.push({ text, location, id: item?.id }); },
        passed(item) { terminal.push([item.id, "PASS"]); },
        skipped(item) { terminal.push([item.id, "SKIP"]); },
        failed(item, message) { terminal.push([item.id, "FAIL", message.message]); }
      };
      const workspace = Object.assign(Object.create(TestWorkspace.prototype), { lastRun: [], artifacts: new Map() });
      const token = { isCancellationRequested: false };
      const { live, progress } = workspace.followRun(run, plan, runDir, token);
      t.after(() => progress.close());
      const args = writeRunInputs(runDir, { tests, files: tests.map(test => test.source), listeners: [progress.listener] });
      const child = spawn(python, ["-m", "robot", ...args, root], { stdio: "ignore" });
      const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(exitCode, 1);
      await progress.close();
      assert.equal(live.get("ordinary").status, "FAIL");
      assert.equal(live.get("skipping").pendingTeardown, true);
      assert.deepEqual(terminal, []);
      for (const test of tests) {
        const failure = output.find(entry => entry.id === test.id && entry.text.includes("pending final result"));
        assert.equal(failure.location.uri, test.source);
        assert.equal(failure.location.range.line, test.line); // Zero-based body line follows the declaration.
      }
      workspace.report(run, plan, { live, exit: { exitCode }, outputDir: runDir, runDir }, 100, token);
      assert.deepEqual(terminal, [["ordinary", "FAIL", "original"], ["skipping", "SKIP"]]);
    });
}

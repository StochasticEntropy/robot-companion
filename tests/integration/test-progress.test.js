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
        fs.writeFileSync(source, [...settings, "*** Test Cases ***", "Case", ...(id === "skipping" ? ["    Sleep    1s"] : []), "    Fail    original", ""].join("\n"));
        return { id, source, name: "Case", line: settings.length + 2, item: { id } };
      });
      const plan = { tests, folderPath: root };
      const output = [], terminal = [];
      const run = {
        started(item) { if (item.id === "skipping") terminal.push([item.id, "START"]); },
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
      const completed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      while (!terminal.some(entry => entry[1] === "START") && child.exitCode === null)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(child.exitCode, null);
      assert.deepEqual(terminal, [["ordinary", "FAIL", "original"], ["skipping", "START"]]);
      const exitCode = await completed;
      assert.equal(exitCode, 1);
      await progress.close();
      assert.equal(live.get("ordinary").status, "FAIL");
      assert.equal(live.get("skipping").pendingTeardown, true);
      assert.deepEqual(terminal, [["ordinary", "FAIL", "original"], ["skipping", "START"]]);
      assert.deepEqual(live.get("ordinary").publishedFailure.location, [tests[0].source, tests[0].line + 1]);
      for (const test of tests.filter(entry => entry.id === "skipping")) {
        const failure = output.find(entry => entry.id === test.id && entry.text.includes("pending final result"));
        assert.equal(failure.location.uri, test.source);
        assert.equal(failure.location.range.line, test.line + 1); // The failing step follows Sleep.
      }
      workspace.report(run, plan, { live, exit: { exitCode }, outputDir: runDir, runDir }, 100, token);
      assert.deepEqual(terminal, [["ordinary", "FAIL", "original"], ["skipping", "START"], ["skipping", "SKIP"]]);
    });
}

for (const python of interpreters) {
  test(`Testing restart isolates three Worker runs, then cancels only the active results with ${python || "RF 7.3.2"}`,
    { skip: !python || !fs.existsSync(python), timeout: 20000 }, async t => {
      const Module = require("node:module");
      const load = Module._load;
      const workspaceModule = require.resolve("../../src/integration/test-workspace");
      delete require.cache[workspaceModule];
      let folder;
      const vscode = {
        Uri: { file: value => value },
        workspace: { getWorkspaceFolder: () => folder },
        TestRunRequest: class { constructor(include) { this.include = include; } },
        Location: class {}, Position: class {}, TestMessage: class { constructor(message) { this.message = message; } }
      };
      let TestWorkspace;
      try {
        Module._load = function(request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
        ({ TestWorkspace } = require(workspaceModule));
      } finally { Module._load = load; }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot restart "));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const source = path.join(root, "sample.robot");
      const runDir = path.join(root, "selection");
      fs.mkdirSync(runDir);
      fs.writeFileSync(source, [
        "*** Test Cases ***", "First", "    Run Keyword If    '${GEN}' == 'one'    Fail    first generation",
        "Hold", "    Log    waiting ${GEN}", "    Sleep    30s", ""
      ].join("\n"));
      const tests = ["First", "Hold"].map((name, i) => ({ name, source, line: i ? 4 : 2, id: name, item: { id: name } }));
      const plan = { folderPath: root, tests };
      folder = { uri: root };
      const segments = [];
      const workspace = Object.assign(Object.create(TestWorkspace.prototype), {
        artifacts: new Map(), selections: () => ({ plan: [plan], filtered: [] }),
        controller: { createTestRun(request, name) {
          const events = [], listeners = new Set();
          const run = { request, name, events, listeners, token: {
            onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }
          } };
          for (const method of ["failed", "passed", "skipped", "started", "enqueued", "appendOutput", "end"])
            run[method] = (...args) => events.push([method, ...args]);
          segments.push(run);
          return run;
        } }
      });
      const cancellation = { token: { isCancellationRequested: false }, cancel() { this.token.isCancellationRequested = true; } };
      workspace.debugFolder = async (run, folderRun, folder, token, profile, name, restart) => {
        const tracking = workspace.followRun(run, folderRun, runDir, token);
        const args = writeRunInputs(runDir, { tests, files: [source], listeners: [tracking.progress.listener] });
        let child;
        try {
          for (const generation of ["one", "two", "tri"]) {
            const outputDir = path.join(root, generation);
            if (child) await tracking.restart(restart, outputDir);
            child = spawn(python, ["-m", "robot", ...args, "--outputdir", outputDir, "-v", "GEN:" + generation, source],
              { stdio: "ignore" });
            const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
            const segment = segments.at(-1);
            const until = Date.now() + 4000;
            while (!segment.events.some(([method, text]) => method === "appendOutput" && text.includes("waiting " + generation))) {
              assert.ok(Date.now() < until, "Missing worker INFO: " + generation);
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (generation === "tri") for (const listener of segment.listeners) listener();
            child.kill("SIGKILL");
            await exited;
          }
          return { live: tracking.live, cancelled: token.isCancellationRequested, runDir, exit: {}, executable: python };
        } finally { child?.kill(); await tracking.progress.close(); }
      };
      await workspace.runOnce({}, cancellation.token, { debug: true, cancellationSource: cancellation, name: "Debug tests" });
      assert.deepEqual(segments.map(run => run.name), ["Debug tests", "Debug tests · Restart 1", "Debug tests · Restart 2"]);
      assert.equal(new Set(segments.map(run => run.request)).size, 3);
      for (const [i, segment] of segments.entries()) {
        assert.equal(segment.listeners.size, 0);
        assert.equal(segment.events.filter(([method]) => method === "end").length, 1);
        assert.equal(segment.events.filter(([method]) => method === "failed").length, i ? 0 : 1);
        assert.equal(segment.events.filter(([method, text]) => method === "appendOutput" && /\[INFO\] waiting/.test(text)).length, 1);
      }
      assert.deepEqual(workspace.lastRun.map(row => [row.id, row.robotStatus || row.status]), [["First", "PASS"], ["Hold", "cancelled"]]);
    });
}

test("Equal-length worker journals at two restarts preserve all three INFO messages", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot worker records "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = [];
  const progress = followProgress(root, event => messages.push(event));
  t.after(() => progress.close());
  let generationBytes;
  for (const outputDir of ["one", "two", "tri"]) {
    const record = "\n" + JSON.stringify({ event: "log", level: "INFO", message: "same", outputDir }) + "\n";
    generationBytes ??= Buffer.byteLength(record);
    assert.equal(Buffer.byteLength(record), generationBytes);
    fs.appendFileSync(path.join(root, "progress.jsonl"), record);
    const deadline = Date.now() + 3000;
    while (!messages.some(message => message.outputDir === outputDir)) {
      assert.ok(Date.now() < deadline, "Missing equal-length generation " + outputDir);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  assert.deepEqual(messages.map(event => event.outputDir), ["one", "two", "tri"]);
});

test("Overlapping Debug restarts drain unread failures and route early successor records before closing", async t => {
  const Module = require("node:module");
  const load = Module._load;
  let TestWorkspace;
  try {
    Module._load = function(request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
    ({ TestWorkspace } = require("../../src/integration/test-workspace"));
  } finally { Module._load = load; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot restart backlog "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputs = ["one", "two", "tri"].map(name => path.join(root, name));
  const source = path.join(root, "suite.robot");
  const selected = { id: "a", source, line: 3, item: { id: "a" } };
  const journal = path.join(root, "progress.jsonl");
  const log = (generation, message) => ({ event: "log", outputDir: outputs[generation], level: "INFO", message });
  const end = (generation, status) => ({ event: "end", source, line: 3, outputDir: outputs[generation],
    status, pendingTeardown: false, duration: 4, message: "failure" });
  const append = event => fs.appendFileSync(journal, JSON.stringify(event) + "\n");
  const segments = [];
  function segment() {
    const events = [];
    segments.push(events);
    return {
      failed() { events.push("FAIL"); }, passed() { events.push("PASS"); },
      appendOutput(text) { if (text.length < 100) events.push(text.trim()); }
    };
  }
  const ws = Object.assign(Object.create(TestWorkspace.prototype), { message: () => ({}) });
  const tracking = ws.followRun(segment(), { tests: [selected] }, root, {});
  t.after(() => tracking.progress.close());
  const archived = [], advance = live => { archived.push(live.get(selected.id)?.status); return segment(); };
  // All writes/restart notifications here happen before the first scheduled
  // poll. Early events from the next generation are deliberately interleaved.
  for (let i = 0; i < 110; i++) append(log(0, "x".repeat(8192)));
  append(log(1, "early second"));
  append(end(0, "FAIL"));
  fs.appendFileSync(journal, '{"truncated":');
  const first = tracking.restart(advance, outputs[1], outputs[0]);
  fs.appendFileSync(journal, "\n");
  append(log(2, "early third"));
  append(end(1, "PASS"));
  const second = tracking.restart(advance, outputs[2], outputs[1]);
  append(log(0, "retired late"));
  append(end(2, "PASS"));
  await Promise.all([first, second, tracking.progress.close()]);
  assert.deepEqual(archived, ["FAIL", "PASS"]);
  assert.deepEqual(segments, [["FAIL"], ["[INFO] early second", "PASS"], ["[INFO] early third", "PASS"]]);
  assert.equal(tracking.live.get(selected.id).status, "PASS");
});

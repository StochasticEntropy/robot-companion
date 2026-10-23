"use strict";
// Continuous runs: saves are debounced, runs never overlap (also across
// continuous runs sharing one queue), saves during a run start exactly one
// more run, and stop() ends the debounce, any queued run and, through its
// owner's cancellation, a running Robot process. The live case runs real Robot
// Framework 7.5 from the prepared environment (skipped by name when absent).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContinuousRun, affects } = require("../../src/integration/continuous-runs");
const { planFolderRuns, writeRunInputs, RobotProcess, createRunDirectory } = require("../../src/integration/test-runs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";

// Executions that take `ms` each and record their files, start/end times and concurrency.
function recorder(ms = 0) {
  const state = { runs: [], active: 0, most: 0 };
  state.execute = async files => {
    state.active++;
    state.most = Math.max(state.most, state.active);
    const entry = { files, started: Date.now() };
    state.runs.push(entry);
    await sleep(ms);
    entry.ended = Date.now();
    state.active--;
  };
  return state;
}

// A queue like TestWorkspace.exclusive: one task at a time.
function sharedQueue() {
  let tail = Promise.resolve();
  return (task, watch) => {
    const next = tail.then(() => (watch.isStopped ? undefined : task()));
    tail = next.catch(() => undefined);
    return next;
  };
}

test("saves within the delay become one run with every saved file, once the saves pause", async () => {
  const state = recorder();
  const watch = new ContinuousRun({ delayMs: () => 150, execute: state.execute });
  const first = Date.now();
  watch.changed("/ws/a.robot");
  await sleep(80);
  watch.changed("/ws/b.resource");
  await sleep(80);
  watch.changed("/ws/a.robot");
  assert.equal(state.runs.length, 0, "nothing runs while saves keep coming");
  await sleep(300);
  assert.equal(state.runs.length, 1);
  assert.deepEqual(state.runs[0].files.sort(), ["/ws/a.robot", "/ws/b.resource"]);
  assert.ok(state.runs[0].started - first >= 160 + 150 - 20, "the delay counts from the last save");
  await watch.stop();
});

test("saves during a run start exactly one more run after it; runs never overlap", async () => {
  const state = recorder(300);
  const watch = new ContinuousRun({ delayMs: () => 50, execute: state.execute });
  watch.changed("/ws/a.robot");
  await sleep(100); // The first run is running.
  for (const file of ["/ws/b.robot", "/ws/c.py", "/ws/b.robot"]) { watch.changed(file); await sleep(20); }
  await sleep(800);
  assert.equal(state.runs.length, 2);
  assert.deepEqual(state.runs[1].files.sort(), ["/ws/b.robot", "/ws/c.py"]);
  assert.ok(state.runs[1].started >= state.runs[0].ended, "the follow-up starts after the first run ended");
  assert.equal(state.most, 1);
  await watch.stop();
});

test("two continuous runs on one queue never run at the same time", async () => {
  const state = recorder(200), queue = sharedQueue();
  const one = new ContinuousRun({ delayMs: () => 50, execute: state.execute, queue });
  const two = new ContinuousRun({ delayMs: () => 50, execute: state.execute, queue });
  one.changed("/ws/a.robot");
  two.changed("/ws/a.robot");
  await sleep(700);
  assert.equal(state.runs.length, 2);
  assert.equal(state.most, 1);
  await Promise.all([one.stop(), two.stop()]);
});

test("stop() during the delay starts nothing; stop() during a run waits for it and starts no follow-up", async () => {
  const state = recorder(250);
  const quiet = new ContinuousRun({ delayMs: () => 100, execute: state.execute });
  quiet.changed("/ws/a.robot");
  await quiet.stop();
  await sleep(200);
  assert.equal(state.runs.length, 0);
  quiet.changed("/ws/a.robot");
  await sleep(200);
  assert.equal(state.runs.length, 0, "a stopped continuous run ignores saves");

  const busy = new ContinuousRun({ delayMs: () => 30, execute: state.execute });
  busy.changed("/ws/a.robot");
  await sleep(80);
  busy.changed("/ws/b.robot");
  const stopping = Date.now();
  await busy.stop();
  assert.ok(Date.now() - stopping >= 100, "stop() resolves when the running run ended");
  await sleep(300);
  assert.equal(state.runs.length, 1, "the save during the run starts nothing after stop()");
  let settled = false;
  void busy.stopped.then(() => { settled = true; });
  await sleep(0);
  assert.ok(settled);
});

test("a queued run of a continuous run turned off meanwhile does not start", async () => {
  const state = recorder(200), queue = sharedQueue();
  const first = new ContinuousRun({ delayMs: () => 20, execute: state.execute, queue });
  const second = new ContinuousRun({ delayMs: () => 20, execute: state.execute, queue });
  first.changed("/ws/a.robot");
  await sleep(60);
  second.changed("/ws/b.robot");
  await sleep(60); // second waits behind first in the queue.
  await second.stop();
  await sleep(300);
  assert.deepEqual(state.runs.map(run => run.files), [["/ws/a.robot"]]);
  await first.stop();
});

test("a test file's save affects its tests, an __init__.robot the tests below it, other files every test", () => {
  const root = path.resolve("/ws");
  const file = name => path.join(root, ...name.split("/"));
  assert.equal(affects(file("api/orders.robot"), file("api/orders.robot")), true);
  assert.equal(affects(file("api/orders.robot"), file("api/users.robot")), false);
  assert.equal(affects(file("api/__init__.robot"), file("api/deep/users.robot")), true);
  assert.equal(affects(file("api/__init__.robot"), file("api2/users.robot")), false, "not a sibling folder with the same prefix");
  assert.equal(affects(file("api/__INIT__.robot"), file("ui/basket.robot")), false);
  assert.equal(affects(file("shared.resource"), file("ui/basket.robot")), true);
  assert.equal(affects(file("libraries/OrderLibrary.py"), file("ui/basket.robot")), true);
});

test("live (RF 7.5): turning a continuous run off during its run ends the Robot process group", {
  skip: fs.existsSync(python) ? false : `RF 7.5 environment absent (${python})`
}, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion continuous "));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "Watch Workspace");
  fs.mkdirSync(root);
  const source = path.join(root, "slow.robot");
  fs.writeFileSync(source, "*** Test Cases ***\nSlow Test\n    Sleep    60s\n");
  let robot, cancelled = false, resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  // The owner's run, like TestWorkspace.runFolder: cancelled through the continuous run's token.
  const execute = () => {
    const plan = planFolderRuns([{ folderPath: root, tests: [{ id: "slow", name: "Slow Test", source, line: 2 }] }])[0];
    const outputDir = createRunDirectory(path.join(parent, "runs"));
    robot = new RobotProcess({ executable: python, args: ["-m", "robot", ...writeRunInputs(outputDir, plan), root], cwd: root });
    const done = robot.start();
    resolveStarted();
    return done;
  };
  const watch = new ContinuousRun({ delayMs: () => 50, execute });
  void watch.stopped.then(() => { cancelled = true; void robot?.cancel(); });
  watch.changed(source);
  await started;
  await sleep(1500);
  assert.ok(robot.groupAlive(), "Robot is running");
  const stopping = Date.now();
  await watch.stop();
  await robot.cleanup;
  assert.ok(cancelled);
  assert.equal(robot.groupAlive(), false, "no process of the run is left");
  assert.ok(Date.now() - stopping < 5000, "ended within the stop grace period");
});

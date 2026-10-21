"use strict";
// Test Explorer run engine: folder run planning, run inputs, per-run result
// matching and cancellation of the whole process tree. Live cases run real
// Robot Framework over synthetic workspaces whose paths contain spaces, once
// per available row: RF 7.5 from the prepared environment and RF 7.3.2 from
// ROBOT_COMPANION_RF732_PYTHON. A missing row is skipped by name.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planFolderRuns, escapeParseInclude, argumentFileSafe, writeRunInputs, readSelectionResult, stoppedBySignal,
  matchResults, readRunResults, RobotProcess, createRunDirectory, RUN_INPUTS } = require("../../src/integration/test-runs");
const { selectedByTags } = require("../../src/integration/robot-tags");

const ROWS = [
  { label: "RF 7.5", version: "7.5", python: process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python" },
  { label: "RF 7.3.2", version: "7.3.2", python: process.env.ROBOT_COMPANION_RF732_PYTHON || "" }
].map(row => ({ ...row, options: row.python && fs.existsSync(row.python) ? {}
  : { skip: `${row.label} environment absent (${row.python || "ROBOT_COMPANION_RF732_PYTHON not set"})` } }));
const FIXTURES = path.join(__dirname, "fixtures");
const posix = process.platform !== "win32";

// A copy of a fixture under a temporary folder whose name has spaces.
function workspace(t, fixture) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion runs "));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, path.basename(fixture));
  fs.cpSync(fixture, root, { recursive: true });
  return root;
}

// The selected test `name` (its n-th occurrence) of a file, as Test Explorer holds it.
function selected(root, file, name, occurrence = 1) {
  const source = path.join(root, ...file.split("/"));
  const lines = fs.readFileSync(source, "utf8").split(/\r\n|\r|\n/);
  const indexes = lines.map((line, index) => (line === name ? index : -1)).filter(index => index >= 0);
  assert.ok(indexes[occurrence - 1] !== undefined, `${name} #${occurrence} in ${file}`);
  return { id: `${source}::${name}${occurrence > 1 ? `#${occurrence}` : ""}`, name, source, line: indexes[occurrence - 1] + 1,
    occurrence };
}

function startRun(row, root, tests, { profile, onOutput = () => {}, runs = path.join(root, "..", "runs"), plan } = {}) {
  plan ||= planFolderRuns([{ folderPath: root, tests }])[0];
  const outputDir = createRunDirectory(runs);
  const args = ["-m", "robot", "--console", "verbose", ...(profile?.arguments || []),
    ...writeRunInputs(outputDir, { tests: plan.tests, files: plan.files, tagOptions: profile }), plan.folderPath];
  const robot = new RobotProcess({ executable: row.python, args, cwd: root, onOutput, env: { PYTHONDONTWRITEBYTECODE: "1" } });
  return { robot, plan, outputDir, done: robot.start() };
}

// Every test Robot reports in output.xml: [{ name, source, line, status, tags }].
function reported(row, outputDir) {
  const script = `import json, sys
from robot.api import ExecutionResult
print(json.dumps([{"name": t.name, "source": str(t.source), "line": t.lineno, "status": t.status, "tags": list(t.tags)}
                  for t in ExecutionResult(sys.argv[1]).suite.all_tests]))`;
  return JSON.parse(execFileSync(row.python, ["-c", script, path.join(outputDir, "output.xml")], { encoding: "utf8" }));
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("selections become one run per workspace folder; each test keeps its source and name line; files are listed once", () => {
  const plan = planFolderRuns([
    { folderPath: "/ws", tests: [{ id: "a1", name: "One", source: "/ws/x/a.robot", line: 2 },
      { id: "a2", name: "Two [x]*", source: "/ws/x/a.robot", line: 5 }] },
    { folderPath: "/other", tests: [{ id: "o1", name: "Other", source: "/other/o.robot", line: 2 }] },
    { folderPath: "/ws/", tests: [{ id: "a1", name: "One", source: "/ws/x/a.robot", line: 2 },
      { id: "b1", name: "Three", source: "/ws/b.robot", line: 3 }] },
    { folderPath: "/empty", tests: [] },
    { folderPath: "/ws", tests: [{ id: "error", name: "No line", source: "/ws/c.robot" }] },
    { folderPath: "/ws", rpa: true, tests: [{ id: "k1", name: "Task", source: "/ws/tasks.robot", line: 2 }] }
  ]);
  assert.deepEqual(plan.map(run => [run.folderPath, run.rpa, run.tests.map(t => t.id), run.files]), [
    [path.resolve("/ws"), undefined, ["a1", "a2", "b1"], [path.resolve("/ws/x/a.robot"), path.resolve("/ws/b.robot")]],
    [path.resolve("/other"), undefined, ["o1"], [path.resolve("/other/o.robot")]],
    [path.resolve("/ws"), true, ["k1"], [path.resolve("/ws/tasks.robot")]]
  ], "tasks get their own run: Robot refuses to mix tasks and tests");
});

test("run inputs: selection by source and line, a copy of the modifier, an argument file; globs escaped", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion inputs "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tests = [{ source: path.join(dir, "api tests", "users [v2].robot"), line: 2 }, { source: path.join(dir, "a*?.robot"), line: 7 }];
  const args = writeRunInputs(dir, { tests, files: tests.map(test => test.source),
    tagOptions: { include: ["smoke", " padded "], exclude: ["slow"] } });
  assert.deepEqual(args, ["--argumentfile", path.join(dir, RUN_INPUTS.arguments), "--include", " padded "],
    "a value Robot's argument file would strip goes on the command line");
  assert.deepEqual(fs.readFileSync(path.join(dir, RUN_INPUTS.arguments), "utf8").split("\n"), [
    `--outputdir ${dir}`, "--output output.xml", `--prerunmodifier ${path.join(dir, RUN_INPUTS.modifier)}`,
    `--parseinclude ${path.join(dir, "api tests", "users [[]v2].robot")}`, `--parseinclude ${path.join(dir, "a[*][?].robot")}`,
    "--include smoke", "--exclude slow", ""]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, RUN_INPUTS.selection), "utf8")).tests,
    tests.map(test => [test.source, test.line]));
  assert.equal(fs.readFileSync(path.join(dir, RUN_INPUTS.modifier), "utf8"),
    fs.readFileSync(path.join(__dirname, "../../src/integration/RobotCompanionSelection.py"), "utf8"));
  // Debug runs leave the output folder to the debug adapter.
  assert.doesNotMatch(fs.readFileSync(path.join(dir, RUN_INPUTS.arguments), "utf8").replace(/^--outputdir.*\n/, ""), /--outputdir/);
  writeRunInputs(dir, { tests, files: [], outputDir: null });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, RUN_INPUTS.arguments), "utf8"), /--outputdir|--output /);
  assert.equal(escapeParseInclude("/a b/[x]*?.robot"), "/a b/[[]x][*][?].robot");
  for (const value of ["", " a", "a ", "a\nb", "a\rb", "a\u2028b", "a\x1cb", "a\x85b", "\u3000a"]) {
    assert.equal(argumentFileSafe(value), false, JSON.stringify(value));
  }
  assert.equal(argumentFileSafe("C:/My Tests/a=b #1.robot"), true);
  assert.equal(readSelectionResult(dir), undefined, "no selection result before Robot ran");
});

test("results match source and name line, so names with variables and repeated names keep their own result", () => {
  // `Login On ${ENVIRONMENT}` (line 5) and a literal `Login On staging` (line 8) both report `Login On staging`.
  const both = `<robot generator="Robot 7.5"><suite id="s1" name="W"><suite id="s1-s1" name="N" source="/ws/n.robot">
<test id="s1-s1-t1" name="Login On staging" line="5"><status status="PASS" elapsed="0.010"/></test>
<test id="s1-s1-t2" name="Login On staging" line="8"><status status="FAIL">second &lt;b&gt;</status></test></suite>
<suite id="s1-s2" name="B" source="/ws/b.robot"><test id="s1-s2-t1" name="Other" line="2"><status status="FAIL">b</status></test>
</suite></suite></robot>`;
  const first = { id: "n::Login On staging", name: "Login On staging", source: "/ws/n.robot", occurrence: 1, line: 5 };
  const second = { id: "n::Login On staging#2", name: "Login On staging", source: "/ws/n.robot", occurrence: 2, line: 8 };
  const other = { id: "b::Other", name: "Other", source: "/ws/b.robot", line: 2 };
  const stale = { id: "b::Moved", name: "Other", source: "/ws/b.robot", line: 9 };
  const results = matchResults(both, undefined, [first, second, other, stale]);
  assert.deepEqual([...results.keys()], [first.id, second.id, other.id], "a stale line matches nothing");
  assert.deepEqual([results.get(first.id).status, results.get(first.id).elapsed, results.get(first.id).id], ["PASS", 0.01, "s1-s1-t1"]);
  assert.equal(results.get(second.id).message, "second <b>");
  assert.equal(results.get(other.id).id, "s1-s2-t1");
  // Only a test selected alone in the run: matched by its line, not as the name's first occurrence.
  const alone = both.replace(/<test id="s1-s1-t1"[^\n]*\n/, "");
  assert.deepEqual([...matchResults(alone, undefined, [first, second]).keys()], [second.id]);
  // An output.xml without name lines (older Robot) falls back to name and occurrence.
  const unlined = both.replace(/ line="\d+"/g, "");
  assert.equal(matchResults(unlined, undefined, [second]).get(second.id).message, "second <b>");
  assert.equal(readRunResults("/nonexistent-output-folder", undefined, [first]).size, 0);
});

for (const row of ROWS) {
  test(`live ${row.label}: files and directories with their init files run exactly the selected tests`,
    { ...row.options, timeout: 120000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      const tests = [selected(root, "api tests/orders.robot", "Create Order"),
        selected(root, "api tests/users [v2].robot", "Login *"),
        selected(root, "ui tests/basket.robot", "Basket Passes"), selected(root, "ui tests/basket.robot", "Basket Fails"),
        selected(root, "ui tests/nested dir/deep.robot", "Deep Test")];
      const run = startRun(row, root, tests);
      assert.equal((await run.done).exitCode, 1, "one failed test");
      const results = readRunResults(run.outputDir, undefined, tests);
      assert.deepEqual(tests.map(test => results.get(test.id)?.status), ["PASS", "PASS", "PASS", "FAIL", "PASS"]);
      assert.equal(results.get(tests[3].id).message, "Card declined");
      const ran = reported(row, run.outputDir);
      assert.deepEqual(ran.map(entry => `${path.relative(root, entry.source)}:${entry.line}`).sort(),
        tests.map(test => `${path.relative(root, test.source)}:${test.line}`).sort(), "nothing else ran");
      // Every __init__.robot on the way applied: suite setups once each and Test Tags; [Tags] replaces Default Tags.
      assert.equal(fs.readFileSync(path.join(run.outputDir, "markers.txt"), "utf8"), "root-setup\napi-setup\n");
      assert.deepEqual(ran.find(entry => entry.name === "Create Order").tags.sort(), ["api", "smoke", "workspace"]);
      assert.deepEqual(readSelectionResult(run.outputDir), { found: 5, missing: [] });
      assert.match(fs.readFileSync(path.join(run.outputDir, "output.xml"), "utf8"), new RegExp(`generator="Robot ${row.version.replace(".", "\\.")}`));
      for (const file of ["output.xml", "log.html", "report.html"]) assert.ok(fs.existsSync(path.join(run.outputDir, file)), file);
    });

  test(`live ${row.label}: a profile's tag patterns select the same tests as Robot's --include/--exclude`,
    { ...row.options, timeout: 120000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      const names = [["api tests/orders.robot", "Create Order"], ["api tests/orders.robot", "Cancel Order"],
        ["api tests/orders.robot", "Create Order", 2], ["api tests/users [v2].robot", "Login *"],
        ["api tests/users [v2].robot", "Login Again"], ["ui tests/basket.robot", "Basket Passes"],
        ["ui tests/basket.robot", "Basket Fails"], ["ui tests/nested dir/deep.robot", "Deep Test"],
        ["unrelated.robot", "Unrelated Must Not Run"]];
      const tests = names.map(([file, name, occurrence]) => selected(root, file, name, occurrence));
      // Robot's own tags of every test (init and file Test Tags, Default Tags, [Tags], -tag).
      const all = startRun(row, root, tests);
      await all.done;
      const tagsOf = new Map(reported(row, all.outputDir).map(entry => [`${entry.source}:${entry.line}`, entry.tags]));
      assert.equal(tagsOf.size, tests.length);
      assert.deepEqual(tagsOf.get(`${tests[1].source}:${tests[1].line}`).sort(), ["slow", "workspace"], "-api removes api");
      for (const profile of [{ include: ["smoke"], exclude: ["duplicate"] }, { include: ["api AND NOT slow"], exclude: [] },
        { include: ["ui", "LOGIN*"], exclude: ["sl?w"] }, { include: [], exclude: ["work_space"] }, { include: ["regress*"], exclude: [] }]) {
        const expected = tests.filter(test => selectedByTags(profile, tagsOf.get(`${test.source}:${test.line}`)));
        const run = startRun(row, root, tests, { profile: { ...profile, arguments: [] } });
        const exit = await run.done;
        const ran = exit.exitCode === 252 ? [] : reported(row, run.outputDir);
        assert.deepEqual(ran.map(entry => `${entry.source}:${entry.line}`).sort(),
          expected.map(test => `${test.source}:${test.line}`).sort(), JSON.stringify(profile));
      }
    });

  test(`live ${row.label}: a test whose name has variables or repeats runs alone by its line and gets its own result`,
    { ...row.options, timeout: 60000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      fs.writeFileSync(path.join(root, "names.robot"), "*** Variables ***\n${ENVIRONMENT}    staging\n\n*** Test Cases ***\n" +
        "Login On ${ENVIRONMENT}\n    Log    x\n\nOther\n    Log    y\n\nLogin On staging\n    Fail    literal\n");
      const variable = { ...selected(root, "names.robot", "Login On ${ENVIRONMENT}"), name: "Login On staging" };
      const literal = { ...selected(root, "names.robot", "Login On staging"), id: "names::Login On staging#2", occurrence: 2 };
      const first = startRun(row, root, [variable]);
      assert.equal((await first.done).exitCode, 0);
      assert.equal(readRunResults(first.outputDir, undefined, [variable]).get(variable.id).status, "PASS");
      assert.deepEqual(reported(row, first.outputDir).map(entry => entry.name), ["Login On staging"]);
      const second = startRun(row, root, [literal]);
      await second.done;
      const own = readRunResults(second.outputDir, undefined, [variable, literal]);
      assert.deepEqual([own.has(variable.id), own.get(literal.id).status, own.get(literal.id).message], [false, "FAIL", "literal"]);
      // Same name in two selected files: only the selected one of each runs.
      const twice = [selected(root, "api tests/orders.robot", "Create Order", 2)];
      const third = startRun(row, root, twice);
      await third.done;
      assert.deepEqual(reported(row, third.outputDir).map(entry => entry.line), [twice[0].line]);
    });

  test(`live ${row.label}: tasks and tests selected together run as two Robot runs, each in its own mode`,
    { ...row.options, timeout: 60000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      const task = selected(root, "tasks/nightly tasks.robot", "Rotate Logs");
      const check = selected(root, "ui tests/basket.robot", "Basket Passes");
      const mixed = startRun(row, root, [task, check]);
      assert.equal((await mixed.done).exitCode, 252, "one run of both modes is refused by Robot");
      const plans = planFolderRuns([{ folderPath: root, rpa: true, tests: [task] }, { folderPath: root, rpa: false, tests: [check] }]);
      assert.equal(plans.length, 2);
      for (const plan of plans) {
        const run = startRun(row, root, plan.tests, { plan });
        assert.equal((await run.done).exitCode, 0);
        assert.equal(readRunResults(run.outputDir, undefined, plan.tests).get(plan.tests[0].id).status, "PASS");
      }
    });

  test(`live ${row.label}: a test whose file changed after discovery is reported as not found, not run elsewhere`,
    { ...row.options, timeout: 60000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      const moved = selected(root, "ui tests/basket.robot", "Basket Passes");
      const kept = selected(root, "api tests/orders.robot", "Create Order");
      const file = path.join(root, "ui tests", "basket.robot");
      fs.writeFileSync(file, `\n${fs.readFileSync(file, "utf8")}`);
      const run = startRun(row, root, [moved, kept]);
      assert.equal((await run.done).exitCode, 0);
      assert.deepEqual(readSelectionResult(run.outputDir), { found: 1, missing: [[moved.source, moved.line]] });
      assert.deepEqual([...readRunResults(run.outputDir, undefined, [moved, kept]).keys()], [kept.id]);
    });

  test(`live ${row.label}: concurrent folder runs report only their own tests; a rerun runs only the failed test`,
    { ...row.options, timeout: 120000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer"));
      const checkout = [selected(root, "checkout.robot", "Checkout Passes"), selected(root, "checkout.robot", "Checkout Needs Ready Flag")];
      const billing = [selected(root, "billing.robot", "Billing Passes")];
      const first = startRun(row, root, checkout), other = startRun(row, root, billing);
      const [checkoutExit, billingExit] = await Promise.all([first.done, other.done]);
      assert.deepEqual([checkoutExit.exitCode, billingExit.exitCode], [1, 0]);
      assert.notEqual(first.outputDir, other.outputDir);
      const own = readRunResults(first.outputDir, undefined, [...checkout, ...billing]);
      assert.deepEqual([own.get(checkout[0].id).status, own.get(checkout[1].id).status, own.has(billing[0].id)], ["PASS", "FAIL", false]);
      assert.match(own.get(checkout[1].id).message, /^File '.*checkout\.ready' does not exist\.$/);
      assert.doesNotMatch(fs.readFileSync(path.join(first.outputDir, "output.xml"), "utf8"), /Checkout Not Selected/);
      assert.equal(readRunResults(other.outputDir, undefined, billing).get(billing[0].id).status, "PASS");
      fs.writeFileSync(path.join(root, "checkout.ready"), "");
      const rerun = startRun(row, root, [checkout[1]]);
      assert.equal((await rerun.done).exitCode, 0);
      assert.deepEqual(reported(row, rerun.outputDir).map(entry => [entry.name, entry.status]), [["Checkout Needs Ready Flag", "PASS"]]);
    });

  test(`live ${row.label}: Stop ends Robot and every worker it started, keeps finished results; a later run works`,
    { ...row.options, timeout: 120000 }, async t => {
      const root = workspace(t, path.join(FIXTURES, "test-explorer-selection", "Selection Workspace"));
      const tests = [selected(root, "api tests/orders.robot", "Create Order"),
        selected(root, "workers/long run.robot", "Starts A Worker And Waits"), selected(root, "workers/long run.robot", "Never Reached")];
      let output = "";
      const run = startRun(row, root, tests, { onOutput: text => { output += text; } });
      const pidFile = path.join(run.outputDir, "worker.pid");
      const deadline = Date.now() + 60000;
      const pid = () => { try { return Number(fs.readFileSync(pidFile, "utf8")); } catch { return 0; } };
      let ended = false;
      void run.done.then(() => { ended = true; });
      while (!(pid() > 0) && !ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(pid() > 0, `the worker test wrote its PID before the run ended: ${output.slice(-600)}`);
      await new Promise(resolve => setTimeout(resolve, 300));
      const worker = pid();
      assert.ok(alive(worker), `the worker ${worker} runs before Stop`);
      if (posix) {
        const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(worker)], { encoding: "utf8" }).trim());
        assert.notEqual(group, run.robot.pid, "the worker left the run's process group (new session)");
      }
      const started = Date.now();
      await run.robot.cancel(2000);
      await run.robot.cleanup;
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 8000, `stopped in ${elapsed} ms`);
      const gone = Date.now() + 3000;
      while (alive(worker) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(alive(worker), false, `no orphaned worker ${worker} after Stop`);
      assert.equal(run.robot.groupAlive(), false, "no process of the run's group remains");
      const results = readRunResults(run.outputDir, undefined, tests);
      if (posix) {
        assert.equal(results.get(tests[0].id).status, "PASS", "the finished test keeps its result");
        assert.equal(stoppedBySignal(results.get(tests[1].id)), true, results.get(tests[1].id)?.message);
        assert.ok(!results.get(tests[2].id) || stoppedBySignal(results.get(tests[2].id)));
      } else {
        assert.equal(results.size, 0, "taskkill /F leaves no output.xml; every test is reported Skipped");
      }
      assert.match(output, /Starts A Worker And Waits/);
      const next = startRun(row, root, [tests[0]]);
      assert.equal((await next.done).exitCode, 0);
      assert.equal(readRunResults(next.outputDir, undefined, [tests[0]]).get(tests[0].id).status, "PASS");
    });
}

test("Windows: Stop ends Robot's whole process tree with taskkill /T /F", { skip: posix ? false : "uses a POSIX stand-in for taskkill" },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion taskkill "));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const taskkill = path.join(dir, "taskkill stand-in");
    fs.writeFileSync(taskkill, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(dir, "argv")}"\nkill -9 "$2"\n`, { mode: 0o755 });
    const robot = new RobotProcess({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], cwd: dir,
      platform: "win32", taskkill });
    const done = robot.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    await robot.cancel(10000);
    await robot.cleanup;
    assert.equal((await done).signal, "SIGKILL");
    assert.deepEqual(fs.readFileSync(path.join(dir, "argv"), "utf8").trim().split("\n"), ["/PID", String(robot.pid), "/T", "/F"]);
    assert.equal(robot.escaped, undefined, "no POSIX process listing on Windows");
  });

test("a run ends when Robot exits even if a leftover process keeps its output pipes open", { skip: !posix && "POSIX sessions" },
  async () => {
    // The leftover runs in a new session (outside the group) and holds stdout.
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], " +
      "{ detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref(); console.log('done');";
    const robot = new RobotProcess({ executable: process.execPath, args: ["-e", script], cwd: os.tmpdir(), closeMs: 500 });
    const started = Date.now();
    const result = await robot.start();
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started < 5000, `settled in ${Date.now() - started} ms`);
    robot.child.stdout.destroy();
    for (const pid of execFileSync("pgrep", ["-f", "setTimeout\\(\\(\\) => \\{\\}, 20000\\)"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  });

test("cancel twice and cancel before start are safe", async () => {
  const early = new RobotProcess({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], cwd: os.tmpdir() });
  await early.cancel();
  assert.deepEqual(await early.start(), { cancelledBeforeStart: true });
  assert.equal(early.child, undefined, "nothing was spawned");
  const running = new RobotProcess({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], cwd: os.tmpdir() });
  const done = running.start();
  await Promise.all([running.cancel(300), running.cancel(300)]);
  if (posix) assert.equal((await done).signal, "SIGTERM");
  assert.equal(running.groupAlive(), false);
});

test("a missing executable is reported as a spawn error, not a test result", async () => {
  const result = await new RobotProcess({ executable: "/nonexistent/robot", args: [], cwd: os.tmpdir() }).start();
  assert.equal(result.spawnError.code, "ENOENT");
});

test("old run folders are removed, except the newest and those still in use", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion retention "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ["2026-01-01-a", "2026-01-02-b", "2026-01-03-c", "2026-01-04-d"];
  for (const name of names) fs.mkdirSync(path.join(root, name));
  const fresh = createRunDirectory(root, 2, new Set([path.join(root, names[0])]));
  assert.deepEqual(fs.readdirSync(root).sort(), [names[0], names[3], path.basename(fresh)].sort(),
    "the in-use oldest folder stays; the next oldest go");
});

"use strict";
// Test Explorer run engine: selection planning, per-run result matching and
// process-group cancellation. Live cases run real Robot Framework 7.5 from the
// prepared environment and are skipped by name when it is absent.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planSuiteRuns, writtenTestName, robotArguments, stoppedBySignal, matchResults, readRunResults, RobotProcess, createRunDirectory } =
  require("../../src/integration/test-runs");

const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const robot = path.join(path.dirname(python), "robot");
const live = fs.existsSync(robot) ? {} : { skip: `Robot Framework environment absent at ${robot}` };
const fixture = path.join(__dirname, "fixtures", "test-explorer");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-test-runs-"));
  fs.cpSync(fixture, root, { recursive: true });
  return root;
}

async function runSuite(root, suite, testNames, onOutput = () => {}) {
  const outputDir = createRunDirectory(path.join(root, ".runs"));
  const suitePath = path.join(root, suite);
  const process = new RobotProcess({ executable: robot, cwd: root, onOutput,
    args: robotArguments({ robotArguments: ["--console", "verbose"], outputDir, testNames, suitePath }) });
  return { process, outputDir, suitePath, done: process.start() };
}

const ids = (suitePath, names) => names.map(name => ({ id: `${suitePath}::${name}`, name }));

test("selections become one run per suite file; a whole suite runs without --test filters", () => {
  const plan = planSuiteRuns([
    { suitePath: "/ws/a.robot", tests: [{ id: "a1", name: "One" }, { id: "a2", name: "Two [x]*" }] },
    { suitePath: "/ws/b.robot", whole: true, tests: [{ id: "b1", name: "Three" }] },
    { suitePath: "/ws/a.robot", tests: [{ id: "a1", name: "One" }] },
    { suitePath: "/ws/c.robot", tests: [] }
  ]);
  assert.deepEqual(plan.map(run => [run.suitePath, run.tests.map(t => t.id), run.testNames]), [
    ["/ws/a.robot", ["a1", "a2"], ["One", "Two [x]*"]],
    ["/ws/b.robot", ["b1"], []]
  ]);
  assert.deepEqual(robotArguments({ robotArguments: ["--loglevel", "TRACE"], outputDir: "/out", testNames: plan[0].testNames,
    suitePath: "/ws/a.robot" }),
  ["--loglevel", "TRACE", "--outputdir", "/out", "--output", "output.xml", "--test", "One", "--test", "Two [[]x][*]", "/ws/a.robot"]);
});

test("a test whose written name has variables is selected by that name; its result keeps the replaced name", () => {
  assert.equal(writtenTestName("Login On staging", "Login On ${ENVIRONMENT}"), "Login On ${ENVIRONMENT}");
  assert.equal(writtenTestName("Login On staging", "Login On ${ENVIRONMENT}    [Tags]    x"), "Login On ${ENVIRONMENT}");
  assert.equal(writtenTestName("Size 3", "Size ${SIZE}\tLog    x"), "Size ${SIZE}");
  assert.equal(writtenTestName("Pipe staging", "| Pipe ${ENV} | Log | x |", 2), "Pipe ${ENV}");
  assert.equal(writtenTestName("Plain", "Plain    Log    x"), "Plain");
  // A line that cannot be this test (stale range, a step, nothing) keeps the discovered name.
  assert.equal(writtenTestName("Plain", "Other Test"), "Plain");
  assert.equal(writtenTestName("Plain", "Other ${X}"), "Plain", "a stale line with variables that cannot become the name");
  assert.equal(writtenTestName("Plain", "    Log    ${x}"), "Plain");
  assert.equal(writtenTestName("Plain", undefined), "Plain");
  const [run] = planSuiteRuns([{ suitePath: "/ws/a.robot", tests: [
    { id: "a::Login On staging", name: "Login On staging", written: "Login On ${ENVIRONMENT}" }, { id: "a::Plain", name: "Plain", written: "Plain" }] }]);
  assert.deepEqual(run.testNames, ["Login On ${ENVIRONMENT}", "Plain"]);
  assert.deepEqual(run.tests.map(t => t.name), ["Login On staging", "Plain"], "results are matched by the replaced name");
});

test("a result is matched by its name line first, so a filter that runs only some same-named tests keeps each own result", () => {
  // `Login On ${ENVIRONMENT}` (line 5) and `Login On staging` (line 8) are both reported as `Login On staging`.
  const xml = `<robot generator="Robot 7.5"><suite id="s1" name="N" source="/ws/n.robot">
<test id="t1" name="Login On staging" line="8"><status status="FAIL">second</status></test></suite></robot>`;
  const second = { id: "n::Login On staging#2", name: "Login On staging", occurrence: 2, line: 8 };
  assert.equal(matchResults(xml, "/ws/n.robot", [second]).get(second.id).message, "second");
  // Without a line attribute the occurrence still decides.
  assert.equal(matchResults(xml.replace(' line="8"', ""), "/ws/n.robot", [second]).size, 0);
  const both = `<robot generator="Robot 7.5"><suite id="s1" name="N" source="/ws/n.robot">
<test id="t1" name="Login On staging" line="5"><status status="PASS"/></test>
<test id="t2" name="Login On staging" line="8"><status status="FAIL">second</status></test></suite></robot>`;
  const first = { id: "n::Login On staging", name: "Login On staging", occurrence: 1, line: 5 };
  const results = matchResults(both, "/ws/n.robot", [first, second]);
  assert.deepEqual([results.get(first.id).status, results.get(second.id).status], ["PASS", "FAIL"]);
});

test("live: Robot 7.5 selects a test by its written name and reports the replaced name", { ...live, timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-test-runs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "names.robot"),
    "*** Variables ***\n${ENVIRONMENT}    staging\n\n*** Test Cases ***\nLogin On ${ENVIRONMENT}\n    Log    x\n\nOther\n    Log    y\n");
  const tests = [{ id: "n::Login On staging", name: "Login On staging",
    written: writtenTestName("Login On staging", "Login On ${ENVIRONMENT}") }];
  const [plan] = planSuiteRuns([{ suitePath: path.join(root, "names.robot"), tests }]);
  const run = await runSuite(root, "names.robot", plan.testNames);
  assert.equal((await run.done).exitCode, 0);
  const results = readRunResults(run.outputDir, run.suitePath, plan.tests);
  assert.equal(results.get("n::Login On staging").status, "PASS");
  assert.doesNotMatch(fs.readFileSync(path.join(run.outputDir, "output.xml"), "utf8"), /name="Other"/);
  // A literal `Login On staging` below it is the name's second occurrence; selected alone it runs alone
  // and still gets its own result (matched by its name line, line 11).
  fs.appendFileSync(path.join(root, "names.robot"), "\nLogin On staging\n    Fail    literal\n");
  const literal = { id: "n::Login On staging#2", name: "Login On staging", occurrence: 2, line: 11,
    written: writtenTestName("Login On staging", "Login On staging") };
  const [second] = planSuiteRuns([{ suitePath: path.join(root, "names.robot"), tests: [literal] }]);
  assert.deepEqual(second.testNames, ["Login On staging"]);
  const rerun = await runSuite(root, "names.robot", second.testNames);
  await rerun.done;
  const own = readRunResults(rerun.outputDir, rerun.suitePath, second.tests).get(literal.id);
  assert.deepEqual([own.status, own.message, own.line], ["FAIL", "literal", 11]);
});

test("results match source, name and occurrence; other suites' and unrequested tests are ignored", () => {
  const xml = `<robot generator="Robot 7.5"><suite name="All" id="s1">
<suite id="s1-s1" name="A" source="/ws/a.robot">
<test id="t1" name="Twice" line="2"><status status="PASS" elapsed="0.010"/></test>
<test id="t2" name="Twice" line="4"><status status="FAIL" elapsed="0.020">second &lt;b&gt;</status></test>
<test id="t3" name="Extra" line="6"><status status="PASS"/></test></suite>
<suite id="s1-s2" name="B" source="/ws/b.robot"><test id="t4" name="Other" line="2"><status status="FAIL">b</status></test></suite>
</suite></robot>`;
  const results = matchResults(xml, "/ws/a.robot", [
    { id: "a::Twice", name: "Twice" }, { id: "a::Twice#2", name: "Twice", occurrence: 2 }, { id: "a::Other", name: "Other" }
  ]);
  assert.deepEqual([...results.keys()], ["a::Twice", "a::Twice#2"]);
  assert.equal(results.get("a::Twice").status, "PASS");
  assert.equal(results.get("a::Twice").elapsed, 0.01);
  assert.equal(results.get("a::Twice#2").message, "second <b>");
  assert.equal(readRunResults("/nonexistent-output-folder", "/ws/a.robot", []).size, 0);
});

test("real Robot 7.5: two concurrent suite runs report only their own selected tests", live, async () => {
  const root = workspace();
  try {
    const checkout = await runSuite(root, "checkout.robot", ["Checkout Passes", "Checkout Needs Ready Flag"]);
    const billing = await runSuite(root, "billing.robot", ["Billing Passes"]);
    const [checkoutExit, billingExit] = await Promise.all([checkout.done, billing.done]);
    assert.equal(checkoutExit.exitCode, 1, "one failed test");
    assert.equal(billingExit.exitCode, 0);
    assert.notEqual(checkout.outputDir, billing.outputDir);
    const requested = ids(checkout.suitePath, ["Checkout Passes", "Checkout Needs Ready Flag", "Billing Passes"]);
    const own = readRunResults(checkout.outputDir, checkout.suitePath, requested);
    assert.equal(own.get(requested[0].id).status, "PASS");
    assert.equal(own.get(requested[1].id).status, "FAIL");
    assert.match(own.get(requested[1].id).message, /^File '.*checkout\.ready' does not exist\.$/);
    assert.equal(own.has(requested[2].id), false, "billing results never appear in the checkout run");
    const xml = fs.readFileSync(path.join(checkout.outputDir, "output.xml"), "utf8");
    assert.match(xml, /generator="Robot 7\.5/);
    assert.doesNotMatch(xml, /Checkout Not Selected/, "unselected test did not run");
    const billingResults = readRunResults(billing.outputDir, billing.suitePath, ids(billing.suitePath, ["Billing Passes"]));
    assert.equal([...billingResults.values()][0].status, "PASS");
    assert.equal(readRunResults(billing.outputDir, checkout.suitePath, requested).size, 0);

    // Rerun of the failed test only, after the fix: it now passes.
    fs.writeFileSync(path.join(root, "checkout.ready"), "");
    const rerun = await runSuite(root, "checkout.robot", ["Checkout Needs Ready Flag"]);
    assert.equal((await rerun.done).exitCode, 0);
    const rerunXml = fs.readFileSync(path.join(rerun.outputDir, "output.xml"), "utf8");
    assert.match(rerunXml, /<stat pass="1" fail="0" skip="0">All Tests<\/stat>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real Robot 7.5: cancel ends the whole process group within the bound and a later run works", live, async () => {
  const root = workspace();
  try {
    let output = "";
    const waiting = await runSuite(root, "billing.robot", ["Billing Waits For Stop"], text => { output += text; });
    const deadline = Date.now() + 30000;
    const children = () => {
      try { return execFileSync("pgrep", ["-g", String(waiting.process.pid)], { encoding: "utf8" }).trim().split("\n"); }
      catch { return []; }
    };
    while (!(output.includes("Billing Waits For Stop") && children().length >= 2) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(children().length >= 2, `Robot and its sleep child share the run's process group: ${children()}`);
    const started = Date.now();
    await waiting.process.cancel(2000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `stopped in ${elapsed} ms`);
    assert.equal(waiting.process.cancelled, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(waiting.process.groupAlive(), false, "no process of the run's group remains");
    assert.deepEqual(children(), []);

    const next = await runSuite(root, "billing.robot", ["Billing Passes"]);
    assert.equal((await next.done).exitCode, 0);
    const results = readRunResults(next.outputDir, next.suitePath, ids(next.suitePath, ["Billing Passes"]));
    assert.equal([...results.values()][0].status, "PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real Robot 7.5: a stopped suite run keeps finished results and flags the interrupted test", live, async () => {
  const root = workspace();
  try {
    let output = "";
    const run = await runSuite(root, "billing.robot", [], text => { output += text; });
    const deadline = Date.now() + 30000;
    while (!output.includes("Billing Waits For Stop") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 300));
    await run.process.cancel(2000);
    const tests = ids(run.suitePath, ["Billing Passes", "Billing Waits For Stop"]);
    const results = readRunResults(run.outputDir, run.suitePath, tests);
    assert.equal(results.get(tests[0].id).status, "PASS");
    assert.equal(stoppedBySignal(results.get(tests[0].id)), false);
    assert.equal(stoppedBySignal(results.get(tests[1].id)), true, results.get(tests[1].id)?.message);
    assert.equal(run.process.groupAlive(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run ends when Robot exits even if a leftover process keeps its output pipes open", async () => {
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
  assert.equal((await done).signal, "SIGTERM");
  assert.equal(running.groupAlive(), false);
});

test("a missing executable is reported as a spawn error, not a test result", async () => {
  const result = await new RobotProcess({ executable: "/nonexistent/robot", args: [], cwd: os.tmpdir() }).start();
  assert.equal(result.spawnError.code, "ENOENT");
});

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
const { planSuiteRuns, robotArguments, matchResults, readRunResults, RobotProcess, createRunDirectory } =
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
  ["--loglevel", "TRACE", "--outputdir", "/out", "--test", "One", "--test", "Two [[]x][*]", "/ws/a.robot"]);
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

test("a missing executable is reported as a spawn error, not a test result", async () => {
  const result = await new RobotProcess({ executable: "/nonexistent/robot", args: [], cwd: os.tmpdir() }).start();
  assert.equal(result.spawnError.code, "ENOENT");
});

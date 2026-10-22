"use strict";
// Test Explorer coverage runs: Robot Companion's coverage listener measures the
// workspace's Python lines during real Robot Framework runs of the synthetic
// "Coverage Workspace" (a path with spaces), once per available row: RF 7.5 on
// Python 3.13 from the prepared environment and RF 7.3.2 on Python 3.11 from
// ROBOT_COMPANION_RF732_PYTHON. A missing row is skipped by name. Expected lines
// are found by their text in the fixture, so the assertions name what ran.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planFolderRuns, writeRunInputs, RobotProcess, createRunDirectory } = require("../../src/integration/test-runs");
const { writeCoverageInputs, readCoverage, describeCoverage, COVERAGE_INPUTS } = require("../../src/integration/test-coverage");

const ROWS = [
  { label: "RF 7.5", python: process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python" },
  { label: "RF 7.3.2", python: process.env.ROBOT_COMPANION_RF732_PYTHON || "" }
].map(row => ({ ...row, options: row.python && fs.existsSync(row.python) ? {}
  : { skip: `${row.label} environment absent (${row.python || "ROBOT_COMPANION_RF732_PYTHON not set"})` } }));
const FIXTURE = path.join(__dirname, "fixtures", "test-explorer-coverage", "Coverage Workspace");
const TESTS = ["Small Order Has No Discount", "Large Order Has A Discount", "Background Worker Answers",
  "Separate Process Is Not Measured"];

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion coverage "));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "Coverage Workspace");
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

// 1-based line numbers of the lines of `file` whose text (trimmed) is one of `texts`.
function linesOf(file, ...texts) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return texts.map(text => {
    const index = lines.findIndex(line => line.trim() === text);
    assert.ok(index >= 0, `${text} in ${file}`);
    return index + 1;
  });
}

function selected(root, names = TESTS) {
  const source = path.join(root, "orders.robot");
  return names.map(name => ({ id: `${source}::${name}`, name, source, line: linesOf(source, name)[0] }));
}

// A Test Explorer coverage run of `tests`, as TestWorkspace.runFolder starts it.
async function coverageRun(row, root, tests, { launcher = ["-m", "robot"], robotArguments = [] } = {}) {
  const plan = planFolderRuns([{ folderPath: root, tests }])[0];
  const outputDir = createRunDirectory(path.join(root, "..", "runs"));
  const listeners = [writeCoverageInputs(outputDir, [root])];
  const args = [...launcher, ...robotArguments,
    ...writeRunInputs(outputDir, { tests: plan.tests, files: plan.files, listeners }), plan.folderPath];
  let output = "";
  const robot = new RobotProcess({ executable: row.python, args, cwd: root, env: { PYTHONDONTWRITEBYTECODE: "1" },
    onOutput: text => { output += text; } });
  const exit = await robot.start();
  return { exit, output, outputDir, plan, coverage: readCoverage(outputDir, plan.tests) };
}

for (const row of ROWS) {
  test(`${row.label}: a coverage run measures the workspace's Python lines that ran, and each test's own lines`, row.options, async t => {
    const root = workspace(t);
    const { exit, output, outputDir, plan, coverage } = await coverageRun(row, root, selected(root));
    assert.equal(exit.exitCode, 0, output);
    const arguments_ = fs.readFileSync(path.join(outputDir, "arguments.txt"), "utf8").split("\n");
    assert.ok(arguments_.includes(`--listener ${path.join(outputDir, COVERAGE_INPUTS.listener)}`), "the listener comes from the run folder");
    const library = path.join(root, "libraries", "OrderLibrary.py"), pricing = path.join(root, "libraries", "pricing.py");
    assert.deepEqual(coverage.files.map(file => file.path).sort(), [library, pricing].sort(),
      "only workspace Python files that ran: not the site-packages module, the separate process's script or Robot files");
    assert.deepEqual(coverage.unmeasured, []);
    const file = name => coverage.files.find(entry => entry.path === name);
    const sorted = set => [...set].sort((a, b) => a - b);

    // Every line Python compiles code for, as Python 3.11 and 3.13 both compile this file.
    const [doc, importOs, importSys, importThreading, pathInsert, importVendored, importPricing, store, defOpen, openBody,
      defTotal, toInt, price, ifLarge, minus, returnTotal, defBackground, found, thread, start, join, returnFound, defAnswer,
      return42, defNever, notRun] = linesOf(library, '"""Order keywords of the synthetic coverage workspace."""', "import os",
      "import sys", "import threading", 'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor", "site-packages"))',
      "import vendored  # noqa: E402  A third-party folder: never measured.", "from pricing import discount  # noqa: E402",
      "STORE = {}", "def open_store():", 'STORE["open"] = True', "def order_total(quantity):", "quantity = int(quantity)",
      "price = quantity * 10", "if quantity >= 100:", "price -= discount(price)", "return vendored.identity(price)",
      "def run_in_background():", "found = []", "worker = threading.Thread(target=lambda: found.append(_answer()))",
      "worker.start()", "worker.join()", "return found[0]", "def _answer():", "return 42", "def never_called():", 'return "not run"');
    const all = [doc, importOs, importSys, importThreading, pathInsert, importVendored, importPricing, store, defOpen, openBody,
      defTotal, toInt, price, ifLarge, minus, returnTotal, defBackground, found, thread, start, join, returnFound, defAnswer,
      return42, defNever, notRun];
    assert.deepEqual(sorted(new Set(file(library).lines)), all, "the library's executable lines");
    assert.deepEqual(sorted(file(library).executed), all.filter(line => line !== notRun), "all but never_called's body ran");
    const own = name => sorted(file(library).tests.get(`${path.join(root, "orders.robot")}::${name}`) || []);
    assert.deepEqual(own("Small Order Has No Discount"), [toInt, price, ifLarge, returnTotal], "no discount line for a small order");
    assert.deepEqual(own("Large Order Has A Discount"), [toInt, price, ifLarge, minus, returnTotal]);
    assert.deepEqual(own("Background Worker Answers"), [found, thread, start, join, returnFound, return42],
      "the worker thread's lines (the lambda's and _answer's) belong to the test that started it");
    assert.deepEqual(own("Separate Process Is Not Measured"), [], "a separate process is not measured");
    assert.ok(file(library).executed.has(openBody) && ![...file(library).tests.values()].some(lines => lines.has(openBody)),
      "the suite setup's line ran in the run, in no test");
    assert.deepEqual([...file(library).tests.keys()].sort(), plan.tests.slice(0, 3).map(entry => entry.id).sort());

    const [pricingDoc, defDiscount, ifHigh, fifth, tenth] = linesOf(pricing, '"""Discounts of the synthetic coverage workspace."""',
      "def discount(price):", "if price > 1000:", "return price // 5", "return price // 10");
    assert.deepEqual(sorted(new Set(file(pricing).lines)), [pricingDoc, defDiscount, ifHigh, fifth, tenth]);
    assert.deepEqual(sorted(file(pricing).executed), [pricingDoc, defDiscount, ifHigh, fifth], "the price // 10 branch never ran");
    assert.equal(coverage.covered, 25 + 4);
    assert.equal(coverage.total, 26 + 5);
    assert.match(describeCoverage(coverage), /^Python line coverage \(Python 3\.\d+\.\d+\): 2 files, 29 of 31 lines run \(93\.5%\)\.$/);
  });

  test(`${row.label}: a selection measures only what its tests ran`, row.options, async t => {
    const root = workspace(t);
    const { exit, coverage } = await coverageRun(row, root, selected(root, ["Small Order Has No Discount"]));
    assert.equal(exit.exitCode, 0);
    const library = coverage.files.find(entry => entry.path.endsWith("OrderLibrary.py"));
    const [minus, notRun, return42] = linesOf(library.path, "price -= discount(price)", 'return "not run"', "return 42");
    for (const line of [minus, notRun, return42]) assert.equal(library.executed.has(line), false, `line ${line} did not run`);
    const pricing = coverage.files.find(entry => entry.path.endsWith("pricing.py"));
    const [ifHigh] = linesOf(pricing.path, "if price > 1000:");
    assert.equal(pricing.executed.has(ifHigh), false, "imported, never called");
    assert.equal([...library.tests.keys()].length, 1);
  });

  test(`${row.label}: no coverage next to another Python tracer (Robot run under python -m trace)`, row.options, async t => {
    const root = workspace(t);
    const { exit, coverage } = await coverageRun(row, root, selected(root, ["Small Order Has No Discount"]),
      { launcher: ["-m", "trace", "--count", "--coverdir", path.join(root, "..", "trace"), "--module", "robot"] });
    assert.equal(exit.exitCode, 0);
    assert.match(coverage.unavailable, /another Python tracer .* was already active/);
    assert.equal(coverage.files, undefined, "nothing is reported");
  });

  test(`${row.label}: no coverage when a test replaces the tracer (as a debugger attaching would)`, row.options, async t => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, "untrace.py"), ["import sys", "", "", "def drop_tracer():", "    sys.settrace(None)", ""].join("\n"));
    const source = path.join(root, "untrace.robot");
    fs.writeFileSync(source, ["*** Settings ***", "Library    untrace.py", "", "*** Test Cases ***", "Drops The Tracer",
      "    Drop Tracer", ""].join("\n"));
    const { exit, coverage } = await coverageRun(row, root, [{ id: "drop", name: "Drops The Tracer", source, line: 5 }]);
    assert.equal(exit.exitCode, 0);
    assert.match(coverage.unavailable, /replaced Robot Companion's coverage tracer during the run/);
  });

  test(`${row.label}: a file imported before the listener started or changed during the run is named, not measured`, row.options, async t => {
    const root = workspace(t);
    // A user pre-run modifier is imported before Robot creates listeners; a library calls its function.
    fs.writeFileSync(path.join(root, "early_modifier.py"), [
      "from robot.api import SuiteVisitor", "", "", "class early_modifier(SuiteVisitor):", "    pass", "", "",
      "def early_value():", "    return 'early'", ""].join("\n"));
    fs.writeFileSync(path.join(root, "helpers.py"), [
      "import pathlib", "", "from early_modifier import early_value", "", "",
      "def call_early():", "    return early_value()", "", "",
      "def rewrite_myself():", "    pathlib.Path(__file__).write_text(pathlib.Path(__file__).read_text() + '# changed\\n')", ""].join("\n"));
    const source = path.join(root, "changing.robot");
    fs.writeFileSync(source, ["*** Settings ***", "Library    helpers.py", "", "*** Test Cases ***",
      "Uses Early And Rewrites", "    Call Early", "    Rewrite Myself", ""].join("\n"));
    const tests = [{ id: "rewrite", name: "Uses Early And Rewrites", source, line: 5 }];
    const { exit, output, coverage } = await coverageRun(row, root, tests,
      { robotArguments: ["--pythonpath", root, "--prerunmodifier", path.join(root, "early_modifier.py")] });
    assert.equal(exit.exitCode, 0, output);
    assert.deepEqual(coverage.files, [], "neither file has measured lines");
    assert.deepEqual(coverage.unmeasured.map(entry => [path.basename(entry.path), entry.reason]).sort(), [
      ["early_modifier.py", "imported before Robot Companion's coverage started"], ["helpers.py", "changed during the run"]].sort());
    assert.match(describeCoverage(coverage), /0 files, 0 of 0 lines run; not measured: .*(early_modifier|helpers)\.py \(.*\), .*\.py \(.*\)\.$/);
  });
}

test("readCoverage reads only a coverage.json of this format and keeps lines only for executable lines and selected tests", t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot companion coverage json "));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  assert.equal(readCoverage(runDir), undefined, "no coverage.json: no coverage");
  const write = data => fs.writeFileSync(path.join(runDir, COVERAGE_INPUTS.result), JSON.stringify(data));
  write({ version: 2, files: [] });
  assert.deepEqual(readCoverage(runDir), { unavailable: "coverage.json has an unknown format" });
  write({ version: 1, unavailable: "stopped tracer" });
  assert.deepEqual(readCoverage(runDir), { unavailable: "stopped tracer" });
  const source = path.join(runDir, "a.robot");
  write({ version: 1, python: "3.11.17", tests: [{ source, line: 3, name: "A" }, { source, line: 9, name: "Not selected" }],
    files: [{ path: "/x/lib.py", lines: [1, 2, 3], executed: [1, 2, 7], tests: [[0, [2, 7]], [1, [1]]] },
      { path: "/x/empty.py", lines: [], executed: [], tests: [] }], unmeasured: [] });
  const coverage = readCoverage(runDir, [{ id: "a", source, line: 3 }]);
  assert.deepEqual(coverage.files.map(file => [file.path, [...file.executed], [...file.tests]]),
    [["/x/lib.py", [1, 2], [["a", new Set([2])]]]]);
  assert.deepEqual([coverage.covered, coverage.total], [2, 3]);
});

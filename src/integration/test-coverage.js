"use strict";

// Python line coverage of Test Explorer coverage runs. No VS Code dependency.
// A coverage run is a normal Test Explorer run with one more Robot listener,
// RobotCompanionCoverage.py, copied into the run's folder with its
// configuration (the workspace folder whose Python files are measured). The
// listener writes coverage.json when Robot closes its listeners; only what it
// measured is read back: each file's executable and executed lines, and the
// lines each selected test ran, matched to the test by its source file and name
// line. A run without coverage.json, or whose listener could not measure, has
// no coverage.
const fs = require("node:fs");
const path = require("node:path");

const LISTENER = path.join(__dirname, "RobotCompanionCoverage.py");
const COVERAGE_INPUTS = { listener: "RobotCompanionCoverage.py", config: "coverage-config.json", result: "coverage.json" };

const samePath = (left, right) => {
  if (!left || !right) return false;
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
};

// Copies the listener into the run's folder and returns its path for --listener.
function writeCoverageInputs(runDir, roots) {
  const listener = path.join(runDir, COVERAGE_INPUTS.listener);
  fs.copyFileSync(LISTENER, listener);
  fs.writeFileSync(path.join(runDir, COVERAGE_INPUTS.config), JSON.stringify({ roots: roots.map(root => path.resolve(root)) }));
  return listener;
}

// The run's coverage: { files: [{ path, lines, executed: Set, tests: Map(test id -> Set of lines) }], unmeasured,
// covered, total, python }, { unavailable: reason } when the listener measured nothing, or undefined when it wrote
// no coverage.json (Robot did not start or did not close its listeners).
function readCoverage(runDir, tests = []) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(runDir, COVERAGE_INPUTS.result), "utf8"));
  } catch {
    return undefined;
  }
  if (data?.version !== 1) return { unavailable: "coverage.json has an unknown format" };
  if (data.unavailable) return { unavailable: data.unavailable };
  // The listener's test entries, by index, as the selected tests they ran.
  const ids = (data.tests || []).map(entry => tests.find(test => test.line === entry.line && samePath(test.source, entry.source))?.id);
  let covered = 0, total = 0;
  const files = (data.files || []).filter(file => file.lines?.length).map(file => {
    const lines = new Set(file.lines);
    const executed = new Set(file.executed.filter(line => lines.has(line)));
    const byTest = new Map();
    for (const [index, ran] of file.tests || []) {
      const id = ids[index];
      if (!id) continue;
      const own = byTest.get(id) || new Set();
      for (const line of ran) if (lines.has(line)) own.add(line);
      byTest.set(id, own);
    }
    covered += executed.size;
    total += lines.size;
    return { path: file.path, lines: [...lines], executed, tests: byTest };
  });
  return { files, unmeasured: data.unmeasured || [], covered, total, python: data.python };
}

// One line for the run output.
function describeCoverage(coverage) {
  const percent = coverage.total ? ` (${(100 * coverage.covered / coverage.total).toFixed(1)}%)` : "";
  const unmeasured = coverage.unmeasured.length ? `; not measured: ${coverage.unmeasured.map(file =>
    `${file.path} (${file.reason})`).join(", ")}` : "";
  return `Python line coverage (Python ${coverage.python}): ${coverage.files.length} ` +
    `${coverage.files.length === 1 ? "file" : "files"}, ${coverage.covered} of ${coverage.total} lines run${percent}${unmeasured}.`;
}

module.exports = { COVERAGE_INPUTS, writeCoverageInputs, readCoverage, describeCoverage };

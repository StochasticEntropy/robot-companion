const fs = require("fs");
const path = require("path");
const Mocha = require("mocha");
const { SUITES, suiteName } = require("./suites");

// The test file a runnable (test or hook) belongs to.
function fileOf(runnable) {
  for (let item = runnable; item; item = item.parent) if (item.file) return path.basename(item.file);
  return "(unknown)";
}

// Passes, failures (tests and hooks), pending/skipped and total per test file, plus every test's state.
function countRun(runner, files) {
  const empty = () => ({ passes: 0, failures: 0, pending: 0, total: 0 });
  const counts = { totals: empty(), suites: Object.fromEntries(files.map(file => [file, empty()])), tests: [] };
  const add = (runnable, field, state) => {
    const file = fileOf(runnable);
    const suite = counts.suites[file] || (counts.suites[file] = empty());
    for (const target of [suite, counts.totals]) {
      target[field]++;
      if (runnable.type === "test") target.total++;
    }
    counts.tests.push({ file, title: runnable.fullTitle(), type: runnable.type, state });
  };
  runner.on("pass", test => add(test, "passes", "passed"));
  runner.on("fail", (runnable, error) => {
    add(runnable, "failures", "failed");
    console.error(`UI_FAILURE ${fileOf(runnable)} ${runnable.fullTitle()}\n${error?.stack || error}`);
    counts.tests[counts.tests.length - 1].error = String(error?.message || error).slice(0, 2000);
  });
  runner.on("pending", test => add(test, "pending", "pending"));
  return counts;
}

async function run() {
  const mocha = new Mocha({
    color: true,
    timeout: 90000,
    ui: "tdd",
    // Optional author iteration filter; the full suite runs without it.
    ...(process.env.ROBOT_COMPANION_UI_GREP ? { grep: process.env.ROBOT_COMPANION_UI_GREP } : {})
  });

  // The environment host checks (tests/ui/run-environment-hosts.js) run only the environment suite.
  const suite = process.env.ROBOT_COMPANION_UI_SCOPE === "environment" ? "environment"
    : suiteName(process.env.ROBOT_COMPANION_UI_SUITE) || "all";
  const files = SUITES[suite];
  for (const file of files) mocha.addFile(path.resolve(__dirname, file));

  const countsFile = process.env.ROBOT_COMPANION_UI_COUNTS_FILE;
  const startedAt = new Date().toISOString();
  await new Promise((resolve, reject) => {
    let counts;
    const runner = mocha.run((failures) => {
      if (countsFile) {
        fs.mkdirSync(path.dirname(countsFile), { recursive: true });
        fs.writeFileSync(countsFile, JSON.stringify({ suite, requested: process.env.ROBOT_COMPANION_UI_SUITE || "",
          grep: process.env.ROBOT_COMPANION_UI_GREP || "", files, startedAt, finishedAt: new Date().toISOString(),
          ...counts }, null, 2));
      }
      if (failures > 0) {
        reject(new Error(`${failures} UI test(s) failed.`));
        return;
      }
      resolve();
    });
    counts = countRun(runner, files);
  });
}

module.exports = { run };

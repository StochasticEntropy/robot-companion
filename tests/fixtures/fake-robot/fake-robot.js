#!/usr/bin/env node
// Offline stand-in for the `robot` command in UI tests. It records how it was
// started (argv and cwd) in the run's output directory and behaves like Robot
// Framework would for the synthetic run-robot-sample.robot suite: the exit code
// is the number of failed tests, 252 for invalid input, and it writes
// output.xml, log.html and report.html for runs that executed tests.
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.lastIndexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const outputDir = valueAfter("--outputdir");
const testPattern = valueAfter("--test");
const suitePath = argv[argv.length - 1];

if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "invocation.json"),
    JSON.stringify({ argv, cwd: process.cwd(), pythonUnbuffered: process.env.PYTHONUNBUFFERED || "" }, null, 2)
  );
}

function finish(exitCode, summary) {
  if (outputDir) {
    for (const name of ["output.xml", "log.html", "report.html"]) {
      fs.writeFileSync(path.join(outputDir, name), `<!-- fake ${name} for ${path.basename(suitePath)} -->\n`);
    }
  }
  process.stdout.write(`Fake Robot ${path.basename(suitePath)}\n${summary}\n`);
  process.exit(exitCode);
}

if (testPattern && testPattern.includes("Invalid")) {
  process.stderr.write(`[ ERROR ] Suite contains no tests matching name '${testPattern}'.\n`);
  process.exit(252);
} else if (testPattern && testPattern.includes("Slow")) {
  setTimeout(() => finish(0, "1 test, 1 passed, 0 failed"), 1500);
} else if (testPattern && testPattern.includes("Failing")) {
  finish(1, "1 test, 0 passed, 1 failed");
} else if (testPattern) {
  finish(0, "1 test, 1 passed, 0 failed");
} else {
  finish(2, "6 tests, 4 passed, 2 failed");
}

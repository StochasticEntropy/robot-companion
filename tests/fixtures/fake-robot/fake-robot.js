#!/usr/bin/env node
// Offline stand-in for the `robot` command in UI tests. It records how it was
// started (argv and cwd) in the run's output directory and behaves like Robot
// Framework would for the synthetic run-robot-sample.robot suite: the exit code
// is the number of failed tests, 252 for invalid input, and it writes
// output.xml, log.html and report.html for runs that executed tests.
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
// `--argumentfile <file>` lines are read as Robot reads them: "--option value".
const expanded = argv.flatMap((arg, index) => {
  if (argv[index - 1] === "--argumentfile") return [];
  if (arg !== "--argumentfile") return [arg];
  return fs.readFileSync(argv[index + 1], "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .flatMap(line => (line.includes(" ") ? [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1).trim()] : [line]));
});
const valueAfter = (flag) => {
  const index = expanded.lastIndexOf(flag);
  return index >= 0 ? expanded[index + 1] : undefined;
};
const outputDir = valueAfter("--outputdir");
const testPattern = valueAfter("--test");
const modifier = valueAfter("--prerunmodifier");
const suitePath = argv[argv.length - 1];

if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "invocation.json"),
    JSON.stringify({ argv, expanded, cwd: process.cwd(), pythonUnbuffered: process.env.PYTHONUNBUFFERED || "" }, null, 2)
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

if (modifier) {
  // A Test Explorer run: the selection modifier's tests, all passing.
  const count = JSON.parse(fs.readFileSync(path.join(path.dirname(modifier), "selection.json"), "utf8")).tests.length;
  finish(0, `${count} tests, ${count} passed, 0 failed`);
} else if (testPattern && testPattern.includes("Invalid")) {
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

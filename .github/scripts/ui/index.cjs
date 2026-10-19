"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function run() {
  const Mocha = require(path.join(process.env.WINDOWS_UI_SOURCE, "node_modules", "mocha"));
  const mocha = new Mocha({ ui: "tdd", timeout: 90000, color: false });
  mocha.addFile(path.join(__dirname, "documentation-smoke.cjs"));
  const counts = await new Promise(resolve => {
    const runner = mocha.run(failures => resolve({
      tests: runner.stats.tests, passed: runner.stats.passes,
      failed: failures, skipped: runner.stats.pending
    }));
  });
  fs.writeFileSync(path.join(process.env.WINDOWS_UI_EVIDENCE, "mocha.json"), JSON.stringify(counts, null, 2));
  if (counts.tests !== 1 || counts.passed !== 1 || counts.failed !== 0 || counts.skipped !== 0) {
    throw new Error(`Expected exactly one executed UI smoke and zero skips: ${JSON.stringify(counts)}`);
  }
}

module.exports = { run };

"use strict";
// Robot Framework tag patterns as Test Explorer profiles use them. The parity
// cases compare every pattern and tag set with Robot Framework's own
// TagPatterns: RF 7.5 from the prepared environment, RF 7.3.2 from
// ROBOT_COMPANION_RF732_PYTHON. A missing environment skips its case by name.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { tagPatterns, selectedByTags } = require("../../src/integration/robot-tags");

const PATTERNS = ["smoke", "SMOKE", "smo*", "s?oke", "[st]moke", "[!s]moke", "sm[a-o]ke", "sm[z-a]ke", "[", "a[", "[]]x",
  "[!]]x", "a\\b", "team-[a-c]", "team-[!a]", "x*y?z", "*", "?", "", "none", "NONE", "api AND smoke", "api&smoke",
  "api OR ui", "api AND NOT slow", "NOT slow", "api NOT slow OR deep", "api AND smoke OR ui AND slow", "a b_c", "Ab C",
  "ß", "Grüße", "GRÜSSE", "slowANDapi", "smokeORui", "*NOT*", "x[a-]y", "x[-a]y", "x[a-c-e]y", "[^a]", "[a^]", "x|y", "(a)",
  "a.b", "$", "{1}"];
const TAG_SETS = [[], ["smoke"], ["Smoke Test"], ["api", "smoke"], ["api", "slow"], ["ui"], ["ui", "slow", "deep"],
  ["team-a"], ["team-b"], ["team-d"], ["SS"], ["grüsse"], ["Grüße"], ["]x"], ["a\\b"], ["x1y2z"], ["tmoke"], ["smoke_test"],
  ["a b c"], ["none"], ["x-y"], ["xay"], ["xdy"], ["xby"], ["^"], ["b"], ["x|y"], ["(a)"], ["a.b"], ["axb"], ["$"], ["{1}"],
  ["a[b"], ["["], ["abc"], ["slow", "api"], ["slowandapi"]];

test("tag patterns follow Robot's rules: caseless, no spaces or underscores, globs, NOT < OR < AND", () => {
  const match = (pattern, tags) => tagPatterns([pattern]).match(tags);
  assert.equal(match("Smoke Test", ["smoke_test"]), true);
  assert.equal(match("smo*", ["SMOKE"]), true);
  assert.equal(match("smo*", ["a smoke"]), false, "a glob matches the whole tag");
  assert.equal(match("api AND smoke OR ui", ["ui"]), true, "OR binds looser than AND");
  assert.equal(match("api OR ui NOT slow", ["ui", "slow"]), false, "NOT binds loosest");
  assert.equal(match("NOT slow", []), true);
  assert.equal(match("api and smoke", ["api", "smoke"]), false, "operators are upper case");
  assert.equal(match("ß", ["SS"]), true);
  assert.equal(tagPatterns(["none", ""]).size, 0, "NONE and empty patterns are ignored");
  assert.equal(tagPatterns([]).match(["x"]), false);
  assert.equal(selectedByTags({ include: ["smoke"], exclude: ["slow"] }, ["smoke"]), true);
  assert.equal(selectedByTags({ include: ["smoke"], exclude: ["slow"] }, ["smoke", "slow"]), false);
  assert.equal(selectedByTags({ include: [], exclude: ["slow"] }, []), true);
  assert.equal(selectedByTags({}, ["x"]), true);
});

function parity(python) {
  const script = `import json, sys, warnings
warnings.simplefilter("ignore")
from robot.model import TagPatterns
from robot.version import get_version
cases = json.load(sys.stdin)
print(json.dumps({"version": get_version(), "results": [TagPatterns(c["patterns"]).match(c["tags"]) for c in cases]}))`;
  const cases = [];
  for (const pattern of PATTERNS) for (const tags of TAG_SETS) cases.push({ patterns: [pattern], tags });
  for (const tags of TAG_SETS) cases.push({ patterns: ["smoke", "ui AND deep", "none"], tags });
  const output = JSON.parse(execFileSync(python, ["-c", script], { input: JSON.stringify(cases), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  const differences = cases.filter((entry, index) => tagPatterns(entry.patterns).match(entry.tags) !== output.results[index]);
  assert.deepEqual(differences, [], `differences from Robot Framework ${output.version}`);
  return { version: output.version, cases: cases.length };
}

const rf75 = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const rf732 = process.env.ROBOT_COMPANION_RF732_PYTHON || "";
test("parity with Robot Framework 7.5 TagPatterns", fs.existsSync(rf75) ? {} : { skip: `RF 7.5 environment absent at ${rf75}` },
  () => { assert.equal(parity(rf75).version, "7.5"); });
test("parity with Robot Framework 7.3.2 TagPatterns", rf732 && fs.existsSync(rf732) ? {}
  : { skip: "ROBOT_COMPANION_RF732_PYTHON does not name a Python with Robot Framework 7.3.2" },
() => { assert.equal(parity(rf732).version, "7.3.2"); });

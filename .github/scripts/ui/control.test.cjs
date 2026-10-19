"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { productEnvironment, ownedProcesses, options, FIXTURE } = require("../windows-ui-smoke.cjs");

test("product environment excludes credential and runner command-file channels", () => {
  const clean = productEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
    ACTIONS_RUNTIME_TOKEN: "private", GITHUB_TOKEN: "private", GH_TOKEN: "private", GITHUB_ENV: "command-file",
    ACTIONS_RESULTS_URL: "private", NPM_TOKEN: "private", SECRET: "private", HTTPS_PROXY: "credential-url",
    NODE_OPTIONS: "--require unwanted", PYTHONPATH: "unwanted" });
  assert.deepEqual(clean, { Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
});

test("cleanup follows only the marked process and its descendants", () => {
  const known = new Map();
  const snapshot = [
    { pid: 10, parent: 1, created: "a", command: "Code.exe --user-data-dir=unique-profile" },
    { pid: 11, parent: 10, created: "b", command: "Code.exe --type=renderer" },
    { pid: 12, parent: 11, created: "c", command: "extension-host" },
    { pid: 99, parent: 1, created: "d", command: "Code.exe --user-data-dir=other" },
    { pid: 0, parent: 0, command: "system" }
  ];
  assert.deepEqual(ownedProcesses(snapshot, "unique-profile", known).map(item => item.pid), [10, 11, 12]);
  assert.deepEqual(ownedProcesses([
    { pid: 10, parent: 1, created: "reused", command: "unrelated" },
    { pid: 12, parent: 0, created: "c", command: "reparented child" },
    { pid: 0, parent: 0, command: "system" }
  ], "unique-profile", known).map(item => item.pid), [12]);
});

test("the runner refuses partial revisions, shell fragments and duplicate fields", () => {
  const args = ["--source", "source", "--evidence", "evidence", "--source-sha", "a".repeat(40),
    "--request-id", "00000000-0000-4000-8000-000000000001"];
  assert.equal(options(args)["--source-sha"], "a".repeat(40));
  assert.throws(() => options(args.map(value => value === "a".repeat(40) ? "main; command" : value)));
  assert.throws(() => options([...args, "--runner", "paid"]));
  assert.throws(() => options([...args, "--source", "different"]));
});

test("the source-click fixture uses CRLF and a distinct known target line", () => {
  assert(FIXTURE.includes("\r\n"));
  const lines = FIXTURE.split("\r\n");
  assert.equal(lines[3], "    #> - Click this documented source sentence.");
  assert.equal(lines[5], "    Log    ready");
});

"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { validateDescriptor, selectServices, requireService, ExecutionContexts } = require("../../src/integration/backend-contract");

function fixture(id = "protocol-fixture") {
  return {
    id, version: "1.0", contractVersion: 1,
    workspaceUri: pathToFileURL(process.cwd()).href, cwd: process.cwd(), env: { FIXTURE: "a value" },
    services: { language: { executable: process.execPath, argv: ["fixture.js", "a b", "$(literal)"], transport: "stdio" } }
  };
}

test("descriptor preserves executable/argv boundaries and takes an immutable snapshot", () => {
  const source = fixture();
  const checked = validateDescriptor(source);
  source.services.language.argv.push("changed");
  source.env.FIXTURE = "changed";
  assert.deepEqual(checked.services.language.argv, ["fixture.js", "a b", "$(literal)"]);
  assert.equal(checked.env.FIXTURE, "a value");
  assert.throws(() => checked.services.language.argv.push("changed"), TypeError);
});

test("descriptor errors identify version, transport, argv, URI, cwd and environment failures", () => {
  for (const [change, expected] of [
    [s => { s.contractVersion = 2; }, /contract version/],
    [s => { s.services.language.transport = "socket"; }, /stdio/],
    [s => { s.services.language.argv = "--stdio"; }, /array/],
    [s => { s.services.language.executable = "\0"; }, /NUL/],
    [s => { s.workspaceUri = "https://example.invalid/root"; }, /file URI/],
    [s => { s.cwd = "relative"; }, /absolute/],
    [s => { s.env = { INVALID: 42 }; }, /env/],
    [s => { s.env = { "BAD=KEY": "value" }; }, /env/],
    [s => { s.services.typo = {}; }, /Unknown backend service/],
    [s => { s.services = {}; }, /at least one/]
  ]) {
    const source = fixture(); change(source);
    assert.throws(() => validateDescriptor(source), expected);
  }
});

test("language selection and debug selection do not depend on optional discovery", () => {
  const language = fixture("native-fixture");
  const execution = fixture("robotcode-fixture");
  execution.services = { debug: { executable: "python3", argv: ["bridge.py"], transport: "stdio" } };
  const selected = selectServices({ mode: "owned", language, execution });
  assert.equal(selected.language.id, "native-fixture");
  assert.equal(selected.debug.id, "robotcode-fixture");
  assert.equal(selected.discovery, undefined);
  assert.throws(() => requireService(execution, "discovery", true), /does not support discovery/);
  assert.equal(requireService(execution, "debug", true).executable, "python3");
  execution.workspaceUri = pathToFileURL("/different-root").href;
  assert.throws(() => selectServices({ mode: "owned", language, execution }), /same workspace/);
});

test("coexistence owns no backend services and does not inspect executable settings", () => {
  const forbidden = new Proxy({}, { get() { throw new Error("settings read"); } });
  assert.deepEqual(selectServices({ mode: "coexistence", language: forbidden, execution: forbidden }), {
    language: undefined, debug: undefined, discovery: undefined
  });
  assert.throws(() => selectServices({ mode: "typo" }), /Unknown integration mode/);
});

test("Restricted Mode rejects before reading executable or execution settings", () => {
  const forbidden = new Proxy({}, { get() { throw new Error("settings read"); } });
  assert.throws(() => requireService(forbidden, "language", false), /trusted workspace/);
  assert.throws(() => new ExecutionContexts().forRoot("invalid", forbidden, false), /trusted workspace/);
});

test("execution contexts preserve explicit commands, cache per root and refresh on settings/removal", () => {
  const contexts = new ExecutionContexts();
  const uri = pathToFileURL("/workspace with spaces").href;
  const settings = { robotCommand: '\"/tools with spaces/python\" -m robot', robotArguments: ["--loglevel", "DEBUG"] };
  const first = contexts.forRoot(uri, settings, true);
  assert.equal(first.robot.executable, "/tools with spaces/python");
  assert.deepEqual(first.robot.argv, ["-m", "robot"]);
  assert.equal(first.cwd, "/workspace with spaces");
  assert.equal(contexts.forRoot(uri, settings, true), first);
  assert.notEqual(contexts.forRoot(pathToFileURL("/other").href, settings, true), first);
  settings.robotArguments.push("--dryrun");
  assert.deepEqual(first.robotArguments, ["--loglevel", "DEBUG"]);
  const changed = contexts.forRoot(uri, settings, true);
  assert.notEqual(changed, first);
  contexts.remove(uri);
  assert.notEqual(contexts.forRoot(uri, settings, true), changed);
  contexts.dispose();
  assert.equal(contexts.roots.size, 0);
});

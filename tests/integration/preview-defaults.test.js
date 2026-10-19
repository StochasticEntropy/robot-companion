"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { backendDescriptor } = require("../../src/integration/preview-defaults");
const { requireService } = require("../../src/integration/backend-contract");

const root = path.join(os.tmpdir(), "Projekt mit Leerzeichen ü $(literal)");
const folder = { uri: { fsPath: root, toString: () => pathToFileURL(root).href } };
const config = values => ({ get: (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback });

test("preview defaults select owned mode and preserve restricted executable settings", () => {
  const properties = require("../../package.json").contributes.configuration.properties;
  assert.equal(properties["robotCompanion.integrationMode"].default, "owned");
  assert.equal(properties["robotCompanion.nativeBackendExecutable"].restricted, true);
  assert.equal(properties["robotCompanion.nativeBackendExecutable"].default, "");
});

test("native language, debug and discovery share the exact Windows project environment", () => {
  const language = backendDescriptor(config({}), folder, "languageBackend", "win32");
  const execution = backendDescriptor(config({}), folder, "executionBackend", "win32");
  const executable = path.join(root, ".venv", "Scripts", "robot-companion-backend.exe");
  for (const descriptor of [language, execution]) {
    assert.equal(descriptor.id, "robot-companion-native");
    assert.equal(descriptor.workspaceUri, folder.uri.toString());
    assert.equal(descriptor.cwd, root);
  }
  for (const [service, argv] of [[language.services.language, ["lsp"]],
    [execution.services.debug, ["dap"]], [execution.services.discovery, ["discovery"]]]) {
    assert.equal(service.executable, executable);
    assert.deepEqual(service.argv, argv);
  }
});

test("custom executable paths preserve literal characters and relative paths are folder-scoped", () => {
  const executable = path.join(root, "env custom", "Scripts", "robot-companion-backend.exe");
  for (const value of [executable, path.relative(root, executable)]) {
    const selected = config({ nativeBackendExecutable: value });
    assert.equal(backendDescriptor(selected, folder, "languageBackend").services.language.executable, executable);
    assert.equal(backendDescriptor(selected, folder, "executionBackend").services.debug.executable, executable);
  }
  assert.equal(backendDescriptor(config({}), folder, "languageBackend", "darwin").services.language.executable,
    path.join(root, ".venv", "bin", "robot-companion-backend"));
});

test("an explicit RobotCode or custom descriptor overrides only its own side", () => {
  const robotCode = { id: "robotcode", version: "2.7.0", services: { debug: {} } };
  const selected = config({ executionBackend: robotCode });
  assert.equal(backendDescriptor(selected, folder, "executionBackend"), robotCode);
  assert.equal(backendDescriptor(selected, folder, "languageBackend").id, "robot-companion-native");
  const language = { id: "custom", services: { language: {} } };
  assert.equal(backendDescriptor(config({ languageBackend: language }), folder, "languageBackend"), language);
});

test("missing native executable is refused explicitly without choosing another provider", () => {
  const missing = path.join(root, "missing", "robot-companion-backend.exe");
  assert.equal(fs.existsSync(missing), false);
  const descriptor = backendDescriptor(config({ nativeBackendExecutable: missing }), folder, "executionBackend");
  assert.equal(descriptor.id, "robot-companion-native");
  assert.throws(() => requireService(descriptor, "debug", true), error => error.message.includes(missing));
  assert.throws(() => requireService(descriptor, "debug", false), /trusted workspace/);
});

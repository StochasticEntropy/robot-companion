"use strict";

// robot.toml for Run Test and the debugger: which files count, and every reason the settings
// are not read (no file, coexistence, no native backend, a missing executable) without starting anything.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ProjectFiles, describeProjectFiles, isConfigurationFile } = require("../../src/integration/project-files");

function workspace(t, files) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-project-files-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  const uri = pathToFileURL(directory).href;
  return { directory, folder: { uri: { fsPath: directory, toString: () => uri }, name: "w" } };
}
const settings = values => ({ get: (key, fallback) => key in values ? values[key] : fallback });

test("only the folder's own pyproject.toml, robot.toml and .robot.toml are configuration files", () => {
  assert.equal(isConfigurationFile("/w/robot.toml", "/w"), true);
  assert.equal(isConfigurationFile("/w/.robot.toml", "/w"), true);
  assert.equal(isConfigurationFile("/w/pyproject.toml", "/w"), true);
  assert.equal(isConfigurationFile("/w/sub/robot.toml", "/w"), false);
  assert.equal(isConfigurationFile("/w/other.toml", "/w"), false);
});

test("without settings nothing starts; each reason they are not read is named", async t => {
  const files = new ProjectFiles();
  const none = workspace(t, { "pyproject.toml": "[project]\nname = 'x'\n" });  // no [tool.robot]
  const forbidden = { get() { throw new Error("settings read"); } };
  assert.deepEqual(await files.read(none.folder, forbidden, { owned: true }), { arguments: [], files: [], problems: [] });
  const { directory, folder } = workspace(t, { "robot.toml": 'python-path = ["lib"]\n' });
  const coexistence = await files.read(folder, forbidden, { owned: false });
  assert.deepEqual(describeProjectFiles(coexistence),
    ["robot.toml settings (robot.toml) not applied: coexistence mode starts no Robot Companion backend to read it."]);
  assert.deepEqual([...coexistence.arguments], []);
  const missing = await files.read(folder, settings({ nativeBackendExecutable: path.join(directory, "missing-backend") }),
    { owned: true });
  assert.match(missing.unavailable, /^the native backend executable .*missing-backend does not exist$/);
  const robotcode = { id: "robotcode", version: "2.7.0", contractVersion: 1, workspaceUri: folder.uri.toString(),
    cwd: directory, env: {}, services: { language: { executable: "/usr/bin/python3", argv: ["-m", "robotcode.cli"],
      transport: "stdio" } } };
  const explicit = settings({ languageBackend: robotcode, executionBackend: { ...robotcode, services: { debug:
    robotcode.services.language } }, nativeBackendExecutable: path.join(directory, "missing-backend") });
  assert.equal((await files.read(folder, explicit, { owned: true })).unavailable, "no native backend is configured for this folder");
});

test("the shipped robot.toml JSON schema is the backend's generated schema", () => {
  const { execFileSync } = require("node:child_process");
  const repository = path.resolve(__dirname, "../..");
  // robot_toml uses only the standard library; any Python 3.11+ generates the schema from its table.
  const generated = execFileSync(process.env.ROBOT_COMPANION_NATIVE_PYTHON || "python3.13", ["-c",
    "import json, sys; sys.path.insert(0, sys.argv[1]); from robot_companion_backend import robot_toml; " +
    "print(json.dumps(robot_toml.schema(), indent=2))", path.join(repository, "backend", "src")],
  { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const shipped = fs.readFileSync(path.join(repository, "schemas", "robot-toml.schema.json"), "utf8");
  assert.equal(shipped, generated);
  const contributed = require(path.join(repository, "package.json")).contributes.tomlValidation;
  assert.deepEqual(contributed, [{ fileMatch: "robot.toml", url: "./schemas/robot-toml.schema.json" },
    { fileMatch: ".robot.toml", url: "./schemas/robot-toml.schema.json" }]);
  assert.ok(require(path.join(repository, "package.json")).files.includes("schemas/**"), "the VSIX ships the schema");
});


test("project TOML uses the selected Python module launcher and invalidates its environment cache", async t => {
  const { directory, folder } = workspace(t, { "robot.toml": 'python-path = ["lib"]\n' });
  const module = path.join(directory, "robot_companion_backend");
  fs.mkdirSync(module);
  fs.writeFileSync(path.join(module, "__init__.py"), "");
  fs.writeFileSync(path.join(module, "__main__.py"),
    "import json, os, sys\n" +
    "assert sys.argv[1:] == ['project-config', os.getcwd()]\n" +
    "print(json.dumps({'version': 1, 'arguments': ['--variable', 'ENV:' + os.environ['RC_TOML_ENV']], 'files': [], 'problems': []}))\n");
  const python = process.env.ROBOT_COMPANION_NATIVE_PYTHON || "python3.13";
  const descriptor = { id: "robot-companion-native", version: "0.1.0.dev5", contractVersion: 1,
    workspaceUri: folder.uri.toString(), cwd: directory, env: { RC_TOML_ENV: "first" },
    services: { language: { executable: python, argv: ["-m", "robot_companion_backend", "lsp"], transport: "stdio" } } };
  const config = settings({ nativeBackendExecutable: path.join(directory, "must-not-run") });
  const files = new ProjectFiles();
  const first = await files.read(folder, config, { owned: true, backend: descriptor });
  assert.equal(first.unavailable, undefined);
  assert.deepEqual([...first.arguments], ["--variable", "ENV:first"]);
  const second = await files.read(folder, config, { owned: true, backend: { ...descriptor, env: { RC_TOML_ENV: "second" } } });
  assert.deepEqual([...second.arguments], ["--variable", "ENV:second"], "a changed descriptor environment is not a stale cache hit");
});


test("a refused selected native backend never starts a TOML helper", async t => {
  const { directory, folder } = workspace(t, { "robot.toml": 'python-path = ["lib"]\n' });
  const marker = path.join(directory, "forbidden-start");
  const module = path.join(directory, "robot_companion_backend");
  fs.mkdirSync(module); fs.writeFileSync(path.join(module, "__init__.py"), "");
  fs.writeFileSync(path.join(module, "__main__.py"), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('started')\n`);
  const descriptor = { id: "robot-companion-native", version: "0.1.0.dev5", cwd: directory, env: {}, services: { language: {
    executable: process.env.ROBOT_COMPANION_NATIVE_PYTHON || "python3.13", argv: ["-m", "robot_companion_backend", "lsp"] } } };
  const environments = { backend: async () => ({ input: descriptor, refusal: "Selected backend bytes differ from the bundled build. Nothing was started." }) };
  const result = await new ProjectFiles().read(folder, settings({}), { owned: true, environments });
  assert.match(result.unavailable, /Selected backend bytes differ/);
  assert.deepEqual([...result.arguments], []);
  assert.equal(fs.existsSync(marker), false, "a rejected installed build performed no helper work");
});

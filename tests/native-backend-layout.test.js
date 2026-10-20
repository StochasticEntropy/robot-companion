"use strict";

// Logic coverage only, not Windows evidence: the platform is passed in as a parameter, so this
// checks the win32 and posix venv layout, interpreter lookup and build environment on any host,
// plus the declared UI suite values and the required-mode verdict. Nothing is built or started.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { venvLayout, which, buildEnvironment, defaultPython } = require("./native-backend");
const { SUITES, suiteName } = require("./ui/suite/suites");
const { requiredFailures } = require("./ui/run-ui-tests");

test("win32 venv layout: Scripts\\python.exe and Scripts\\robot-companion-backend.exe", () => {
  assert.deepEqual(venvLayout("C:\\Temp\\robot-companion-native-0123", "win32"), {
    python: "C:\\Temp\\robot-companion-native-0123\\Scripts\\python.exe",
    executable: "C:\\Temp\\robot-companion-native-0123\\Scripts\\robot-companion-backend.exe"
  });
});

test("posix venv layout: bin/python and bin/robot-companion-backend", () => {
  assert.deepEqual(venvLayout("/tmp/robot-companion-native-0123", "linux"), {
    python: "/tmp/robot-companion-native-0123/bin/python",
    executable: "/tmp/robot-companion-native-0123/bin/robot-companion-backend"
  });
});

test("default interpreter: python3.13 on posix, python.exe on win32", () => {
  assert.equal(defaultPython("linux"), "python3.13");
  assert.equal(defaultPython("win32"), "python.exe");
});

test("win32 lookup: an explicit absolute interpreter path is used as given", () => {
  const python = "C:\\hostedtoolcache\\windows\\Python\\3.11.9\\x64\\python.exe";
  assert.equal(which(python, "win32", {}, file => file === python), python);
  assert.equal(which(python, "win32", {}, () => false), undefined);
});

test("win32 lookup: a bare name is found on PATH with PATHEXT", () => {
  const env = { Path: "C:\\Windows\\System32;C:\\Python313", PATHEXT: ".COM;.EXE;.BAT" };
  assert.equal(which("python", "win32", env, file => file === "C:\\Python313\\python.EXE"), "C:\\Python313\\python.EXE");
  assert.equal(which("python.exe", "win32", env, file => file === "C:\\Python313\\python.exe"), "C:\\Python313\\python.exe");
});

test("posix lookup: a bare name is found on PATH, a path is used as given", () => {
  const env = { PATH: "/usr/bin:/usr/local/bin" };
  assert.equal(which("python3.13", "linux", env, file => file === "/usr/local/bin/python3.13"), "/usr/local/bin/python3.13");
  assert.equal(which("/opt/py/bin/python3.11", "linux", env, file => file === "/opt/py/bin/python3.11"), "/opt/py/bin/python3.11");
  assert.equal(which("python3.13", "linux", env, () => false), undefined);
});

test("build environment: posix keys unchanged; win32 adds only its system variables", () => {
  const source = { PATH: "/usr/bin", HOME: "/home/a", HTTPS_PROXY: "http://proxy", PYTHONPATH: "/src", PIP_INDEX_URL: "x",
    SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" };
  const posix = buildEnvironment("linux", source);
  assert.deepEqual(Object.keys(posix).sort(), ["HOME", "LANG", "PATH", "PIP_CONFIG_FILE", "PIP_DISABLE_PIP_VERSION_CHECK",
    "PIP_NO_INPUT", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE"]);
  const windows = buildEnvironment("win32", { ...source, PATH: undefined, Path: "C:\\Windows\\System32" });
  assert.equal(windows.PATH, "C:\\Windows\\System32");
  assert.equal(windows.SystemRoot, "C:\\Windows");
  assert.equal(windows.TEMP, "C:\\Temp");
  assert.equal(windows.PYTHONUTF8, undefined, "the default Windows locale is kept");
  for (const leaked of ["HTTPS_PROXY", "PYTHONPATH", "PIP_INDEX_URL"]) assert.equal(windows[leaked], undefined, leaked);
});

test("UI suite values: native-libraries runs only its file; the existing values keep their files", () => {
  assert.deepEqual(SUITES["native-libraries"], ["native-libraries-ui.test.js"]);
  assert.deepEqual(SUITES["native-discovery"], ["native-discovery-ui.test.js"]);
  assert.deepEqual(SUITES.providers, ["provider-switch-ui.test.js"]);
  assert.deepEqual(SUITES["test-explorer"], ["test-explorer-runs-ui.test.js", "native-discovery-ui.test.js", "provider-switch-ui.test.js"]);
  assert.equal(SUITES.all.length, 18);
  assert.deepEqual(SUITES.language, SUITES.all.slice(7));
  for (const file of SUITES.all) assert.ok(fs.existsSync(path.join(__dirname, "ui", "suite", file)), file);
  assert.equal(suiteName(""), "all");
  assert.equal(suiteName("native-libraries"), "native-libraries");
  assert.equal(suiteName("unknown"), undefined);
  assert.equal(suiteName("toString"), undefined);
});

test("required verdict: any failure, skip, zero executed tests or missing counts fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-required-"));
  const counts = totals => {
    const file = path.join(directory, "ui-test-counts.json");
    fs.writeFileSync(file, JSON.stringify({ totals }));
    return file;
  };
  try {
    assert.deepEqual(requiredFailures(path.join(directory, "absent.json")), ["no UI test counts were written"]);
    assert.deepEqual(requiredFailures(counts({ passes: 5, failures: 0, pending: 0, total: 5 })), []);
    assert.deepEqual(requiredFailures(counts({ passes: 4, failures: 1, pending: 0, total: 5 })), ["1 failure(s)"]);
    assert.deepEqual(requiredFailures(counts({ passes: 0, failures: 0, pending: 5, total: 5 })),
      ["5 skipped/pending test(s)", "zero executed tests"]);
    assert.deepEqual(requiredFailures(counts({ passes: 0, failures: 0, pending: 0, total: 0 })), ["zero executed tests"]);
    assert.deepEqual(requiredFailures(counts({ passes: 0, failures: 1, pending: 0, total: 0 })), ["1 failure(s)", "zero executed tests"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

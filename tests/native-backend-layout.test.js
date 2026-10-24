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
  assert.equal(which("C:/Python311/python.exe", "win32", {}, file => file === "C:/Python311/python.exe"), "C:/Python311/python.exe");
  // Without an extension, PATHEXT applies to an explicit path as it does on PATH.
  assert.equal(which("C:\\Python311\\python", "win32", { PATHEXT: ".EXE" }, file => file === "C:\\Python311\\python.EXE"),
    "C:\\Python311\\python.EXE");
});

test("win32 lookup: a bare name is found on PATH with PATHEXT", () => {
  const env = { Path: "C:\\Windows\\System32;C:\\Python313", PATHEXT: ".COM;.EXE;.BAT" };
  assert.equal(which("python", "win32", env, file => file === "C:\\Python313\\python.EXE"), "C:\\Python313\\python.EXE");
  assert.equal(which("python.exe", "win32", env, file => file === "C:\\Python313\\python.exe"), "C:\\Python313\\python.exe");
  const quoted = { Path: "\"C:\\Program Files\\Python313\";C:\\Windows", PATHEXT: ".EXE" };
  assert.equal(which("python.exe", "win32", quoted, file => file === "C:\\Program Files\\Python313\\python.exe"),
    "C:\\Program Files\\Python313\\python.exe");
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
  assert.deepEqual(buildEnvironment("linux", source), { PATH: "/usr/bin", HOME: "/home/a", LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: os.devNull, PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1" });
  const windows = buildEnvironment("win32", { ...source, PATH: undefined, Path: "C:\\Windows\\System32" });
  assert.equal(windows.PATH, "C:\\Windows\\System32");
  assert.equal(windows.SystemRoot, "C:\\Windows");
  assert.equal(windows.TEMP, "C:\\Temp");
  assert.equal(windows.PYTHONUTF8, undefined, "the default Windows locale is kept");
  assert.equal(windows.LANG, undefined, "the default Windows locale is kept");
  assert.equal(windows.PIP_CONFIG_FILE, "nul", "Python's os.devnull on Windows, so pip reads no configuration file");
  assert.equal(windows.PIP_NO_INPUT, "1");
  for (const leaked of ["HTTPS_PROXY", "PYTHONPATH", "PIP_INDEX_URL"]) assert.equal(windows[leaked], undefined, leaked);
});

test("UI suite values: native-libraries runs only its file; the existing values keep their files", () => {
  assert.deepEqual(SUITES.grammar, ["robot-grammar-ui.test.js"]);
  assert.deepEqual(SUITES["source-declarations"], ["source-declarations-ui.test.js"]);
  assert.deepEqual(SUITES["native-libraries"], ["native-libraries-ui.test.js"]);
  assert.deepEqual(SUITES["native-discovery"], ["native-discovery-ui.test.js"]);
  assert.deepEqual(SUITES.environment, ["run-environment-ui.test.js"]);
  assert.deepEqual(SUITES.keywords, ["keyword-explorer-ui.test.js"]);
  assert.deepEqual(SUITES["code-actions"], ["code-actions-formatting-ui.test.js"]);
  assert.deepEqual(SUITES.providers, ["provider-switch-ui.test.js"]);
  assert.deepEqual(SUITES["test-explorer"], ["test-explorer-runs-ui.test.js", "native-discovery-ui.test.js", "test-explorer-selection-ui.test.js", "test-explorer-coverage-ui.test.js", "provider-switch-ui.test.js"]);
  // Merged with the selected-environment work (run-environment-ui) and the Robot Keywords view (keyword-explorer-ui).
  assert.deepEqual(SUITES.environment, ["run-environment-ui.test.js"]);
  assert.deepEqual(SUITES.keywords, ["keyword-explorer-ui.test.js"]);
  assert.deepEqual(SUITES["code-actions"], ["code-actions-formatting-ui.test.js"]);
  // Robot notebook and REPL sessions (interactive-session-ui) joined the language suite.
  assert.deepEqual(SUITES.interactive, ["interactive-session-ui.test.js"]);
  assert.deepEqual(SUITES["inlay-hints"], ["inlay-hints-ui.test.js"]);
  assert.deepEqual(SUITES["advanced-debug"], ["native-advanced-debug-ui.test.js"]);
  for (const file of ["source-declarations-ui.test.js", "robot-grammar-ui.test.js", "native-debug-controls-ui.test.js", "native-advanced-debug-ui.test.js", "inlay-hints-ui.test.js", "interactive-session-ui.test.js", "test-explorer-selection-ui.test.js", "test-explorer-coverage-ui.test.js"]) {
    assert.equal(SUITES.all.filter(item => item === file).length, 1, `${file} runs once in the full suite`);
  }
  assert.deepEqual(SUITES["return-preview-stability"], ["return-preview-stability-ui.test.js"]);
  assert.equal(SUITES.all.filter(item => item === "return-preview-stability-ui.test.js").length, 1);
  assert.equal(SUITES.all.length, 31);
  for (const [name, file] of [["typing-completion", "typing-completion-ui.test.js"], ["typing-stability", "typing-stability-ui.test.js"]]) {
    assert.deepEqual(SUITES[name], [file]);
    assert.equal(SUITES.all.filter(item => item === file).length, 1, `${file} runs once in the full suite`);
  }
  assert.deepEqual(SUITES.language, SUITES.all.slice(9));
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
    const file = counts({ passes: 5, failures: 0, pending: 0, total: 5 });
    fs.writeFileSync(file, JSON.stringify({ totals: { passes: 5, failures: 0, pending: 0, total: 5 },
      suites: { "a-ui.test.js": { passes: 5, failures: 0, pending: 0, total: 5 }, "b-ui.test.js": { passes: 0, failures: 0, pending: 0, total: 0 } } }));
    assert.deepEqual(requiredFailures(file), ["zero executed tests in b-ui.test.js"]);
    fs.writeFileSync(file, "{");
    assert.match(requiredFailures(file)[0], /^unreadable UI test counts/);
    fs.writeFileSync(file, "{}");
    assert.deepEqual(requiredFailures(file), ["UI test counts have no totals"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

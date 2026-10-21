const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");
const { nativeBackend } = require("../native-backend");
const { SUITES, suiteName } = require("./suite/suites");

// ROBOT_COMPANION_UI_REQUIRE_NATIVE=1: an unavailable native backend, an undeclared suite value, any
// failure, any skipped test or zero executed tests fails the run, with counts and the backend receipt
// in ROBOT_COMPANION_UI_EVIDENCE_DIR.
const REQUIRED = process.env.ROBOT_COMPANION_UI_REQUIRE_NATIVE === "1";
const evidenceDirectory = process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR || "";
// An author iteration filter; recorded in the verdict, since it narrows what a required run executes.
const grep = process.env.ROBOT_COMPANION_UI_GREP || "";

function writeEvidence(name, value) {
  if (!evidenceDirectory) return;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(evidenceDirectory, name), JSON.stringify(value, null, 2));
}

// The reasons a required run fails, from the counts the extension host wrote: any failure, any
// skipped/pending test, or zero executed tests in the run or in any of its test files.
function requiredFailures(countsFile) {
  let counts;
  try {
    counts = JSON.parse(fs.readFileSync(countsFile, "utf8"));
  } catch (error) {
    return [error.code === "ENOENT" ? "no UI test counts were written" : `unreadable UI test counts: ${error.message}`];
  }
  const { totals, suites = {} } = counts || {};
  if (!totals) return ["UI test counts have no totals"];
  const reasons = [];
  if (totals.failures) reasons.push(`${totals.failures} failure(s)`);
  if (totals.pending) reasons.push(`${totals.pending} skipped/pending test(s)`);
  if (totals.total - totals.pending === 0) reasons.push("zero executed tests");
  else {
    for (const [file, suite] of Object.entries(suites)) {
      if (suite.total - suite.pending === 0) reasons.push(`zero executed tests in ${file}`);
    }
  }
  return reasons;
}
const { vscodeExecutable } = require("./cdp-host");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const requestedSuite = process.env.ROBOT_COMPANION_UI_SUITE || "";
  const suite = suiteName(requestedSuite);
  if (REQUIRED && !suite) {
    const reason = `undeclared ROBOT_COMPANION_UI_SUITE value "${requestedSuite}"; declared: ${Object.keys(SUITES).join(", ")}`;
    writeEvidence("ui-run-result.json", { required: true, suite: requestedSuite, grep, passed: false, reasons: [reason] });
    throw new Error(`Required UI run refused: ${reason}.`);
  }
  // The native backend provider's live cases use only this owned venv, built
  // offline from this checkout's backend/ (see tests/native-backend.js).
  let native;
  try {
    native = nativeBackend();
  } catch (error) {
    if (REQUIRED) {
      writeEvidence("native-backend-venv.json", { available: false, required: true, error: String(error.message || error) });
      writeEvidence("ui-run-result.json", { required: true, suite, grep, passed: false, reasons: ["native backend build failed"] });
    }
    throw error;
  }
  if (native.skip) {
    if (REQUIRED) {
      writeEvidence("native-backend-venv.json", { available: false, required: true, skip: native.skip });
      writeEvidence("ui-run-result.json", { required: true, suite, grep, passed: false, reasons: [native.skip] });
      throw new Error(`Required UI run refused: ${native.skip}.`);
    }
    console.log(`Native backend live cases will be skipped: ${native.skip}`);
  } else writeEvidence("native-backend-venv.json", native.receipt);
  const fixturesDirectoryPath = path.resolve(__dirname, "../fixtures");
  const fixtureNames = fs
    .readdirSync(fixturesDirectoryPath)
    .filter((entry) => entry.endsWith(".robot") || entry.endsWith(".py"));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-ui-"));
  // A fresh profile per run. Chromium writes the port of its DevTools endpoint into it, which the
  // webview tests use to hit-test and click the real webviews with trusted input.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-ui-profile-"));
  let shouldCleanup = true;
  // Format Document is Shift+Alt+F on Windows and macOS. On Linux VS Code binds it to
  // Ctrl+Shift+I, which VS Code 1.141's Chat takes first. This test profile adds the
  // Shift+Alt+F binding, so the UI suite presses Shift+Alt+F on every platform.
  fs.mkdirSync(path.join(userDataPath, "User"), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, "User", "keybindings.json"), JSON.stringify([{ key: "shift+alt+f",
    command: "editor.action.formatDocument", when: "editorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly" }], null, 2));

  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixturesDirectoryPath, fixtureName);
    const workspaceFixturePath = path.join(workspacePath, fixtureName);
    fs.copyFileSync(fixturePath, workspaceFixturePath);
  }
  // Documentation/return/folding suites start in coexistence. Each owned-service
  // suite selects its descriptor explicitly; preview-defaults.test.js separately
  // verifies the shipped owned default without inventing a project backend here.
  fs.mkdirSync(path.join(workspacePath, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, ".vscode", "settings.json"),
    JSON.stringify({ "robotCompanion.integrationMode": "coexistence" }));

  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/audit-v1"),
    path.join(workspacePath, "integration-audit-v1"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/test-explorer"),
    path.join(workspacePath, "integration-test-explorer"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/native-discovery"),
    path.join(workspacePath, "integration-native-discovery"), { recursive: true });
  // A saved workspace permits adding/removing nested roots without converting
  // a single-folder window (which may reload the extension host mid-test).
  // The synthetic workspace starts in coexistence: it has no project .venv, so the shipped owned
  // default would only report a missing native backend. Each owned suite selects its mode and
  // descriptors at folder level; clearing them returns here. The owned default itself is checked
  // by tests/integration/preview-defaults.test.js.
  const workspaceFilePath = path.join(workspacePath, "synthetic.code-workspace");
  fs.writeFileSync(workspaceFilePath, JSON.stringify({ folders: [{ path: "." }],
    settings: { "robotCompanion.integrationMode": "coexistence" } }));

  // The extension host writes per-suite counts here; a required run checks them after VS Code exits.
  const countsFile = evidenceDirectory ? path.join(evidenceDirectory, "ui-test-counts.json")
    : path.join(userDataPath, "ui-test-counts.json");
  fs.rmSync(countsFile, { force: true });

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // The prepared offline runtime supplies an explicit executable. Passing it
      // bypasses test-electron's version lookup/download path entirely.
      vscodeExecutablePath: process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE || await vscodeExecutable(),
      launchArgs: [
        workspaceFilePath,
        "--new-window",
        "--skip-welcome",
        "--skip-release-notes",
        `--user-data-dir=${userDataPath}`,
        // Never inherit the user's installed Robot/Python providers.
        `--extensions-dir=${path.join(userDataPath, "extensions")}`,
        "--remote-debugging-port=0"
      ],
      extensionTestsEnv: {
        ROBOT_COMPANION_UI_USER_DATA_DIR: userDataPath,
        ROBOT_COMPANION_UI_SUITE: process.env.ROBOT_COMPANION_UI_SUITE || "all",
        ROBOT_COMPANION_UI_EVIDENCE_DIR: process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR || "",
        ROBOT_COMPANION_UI_GREP: process.env.ROBOT_COMPANION_UI_GREP || "",
        ROBOT_COMPANION_NATIVE_BACKEND: native.executable || "",
        ROBOT_COMPANION_NATIVE_SKIP: native.skip || "",
        ROBOT_COMPANION_UI_REQUIRE_NATIVE: REQUIRED ? "1" : "",
        ROBOT_COMPANION_UI_COUNTS_FILE: countsFile,
        ROBOT_COMPANION_UI_SCOPE: process.env.ROBOT_COMPANION_UI_SCOPE || "",
        ROBOT_COMPANION_EVIDENCE_DIR: process.env.ROBOT_COMPANION_EVIDENCE_DIR || ""
      }
    });
    if (REQUIRED) {
      const reasons = requiredFailures(countsFile);
      writeEvidence("ui-run-result.json", { required: true, suite, grep, passed: reasons.length === 0, reasons });
      if (reasons.length) throw Object.assign(new Error(`Required UI run failed: ${reasons.join("; ")}.`), { recorded: true });
    }
  } catch (error) {
    shouldCleanup = false;
    console.error(`UI test workspace preserved at ${workspacePath}`);
    if (REQUIRED && !error.recorded) {
      writeEvidence("ui-run-result.json", { required: true, suite, grep, passed: false,
        reasons: [String(error.message || error), ...requiredFailures(countsFile)] });
    }
    throw error;
  } finally {
    if (shouldCleanup) {
      fs.rmSync(workspacePath, {
        recursive: true,
        force: true
      });
    }
    fs.rmSync(userDataPath, {
      recursive: true,
      force: true
    });
  }
}

module.exports = { requiredFailures };

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to run Robot Companion UI tests.");
    console.error(error);
    process.exit(1);
  });
}

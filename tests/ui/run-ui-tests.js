const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");
const { nativeBackend } = require("../native-backend");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
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
  // The suites find editor tokens by their rendered line text, which inlay hints (`name=`, `: Record`)
  // would change. The profile turns VS Code's inlay hints off; inlay-hints-ui.test.js turns them on.
  fs.writeFileSync(path.join(userDataPath, "User", "settings.json"), JSON.stringify({ "editor.inlayHints.enabled": "off" }, null, 2));
  fs.writeFileSync(path.join(userDataPath, "User", "keybindings.json"), JSON.stringify([{ key: "shift+alt+f",
    command: "editor.action.formatDocument", when: "editorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly" }], null, 2));

  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixturesDirectoryPath, fixtureName);
    const workspaceFixturePath = path.join(workspacePath, fixtureName);
    fs.copyFileSync(fixturePath, workspaceFixturePath);
  }
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/audit-v1"),
    path.join(workspacePath, "integration-audit-v1"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/test-explorer"),
    path.join(workspacePath, "integration-test-explorer"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/native-discovery"),
    path.join(workspacePath, "integration-native-discovery"), { recursive: true });
  // A saved workspace permits adding/removing nested roots without converting
  // a single-folder window (which may reload the extension host mid-test).
  const workspaceFilePath = path.join(workspacePath, "synthetic.code-workspace");
  fs.writeFileSync(workspaceFilePath, JSON.stringify({ folders: [{ path: "." }] }));

  // The native backend provider's live cases use only this owned venv, built
  // offline from this checkout's backend/ (see tests/native-backend.js).
  const native = nativeBackend();
  if (native.skip) console.log(`Native backend live cases will be skipped: ${native.skip}`);
  else if (process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR, "native-backend-venv.json"), JSON.stringify(native.receipt, null, 2));
  }

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // The prepared offline runtime supplies an explicit executable. Passing it
      // bypasses test-electron's version lookup/download path entirely.
      vscodeExecutablePath: process.env.ROBOT_COMPANION_VSCODE_EXECUTABLE || undefined,
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
        ROBOT_COMPANION_NATIVE_SKIP: native.skip || ""
      }
    });
  } catch (error) {
    shouldCleanup = false;
    console.error(`UI test workspace preserved at ${workspacePath}`);
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

main().catch((error) => {
  console.error("Failed to run Robot Companion UI tests.");
  console.error(error);
  process.exit(1);
});

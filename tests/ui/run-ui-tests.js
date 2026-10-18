const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

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

  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixturesDirectoryPath, fixtureName);
    const workspaceFixturePath = path.join(workspacePath, fixtureName);
    fs.copyFileSync(fixturePath, workspaceFixturePath);
  }
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/audit-v1"),
    path.join(workspacePath, "integration-audit-v1"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../integration/fixtures/test-explorer"),
    path.join(workspacePath, "integration-test-explorer"), { recursive: true });
  // A saved workspace permits adding/removing nested roots without converting
  // a single-folder window (which may reload the extension host mid-test).
  const workspaceFilePath = path.join(workspacePath, "synthetic.code-workspace");
  fs.writeFileSync(workspaceFilePath, JSON.stringify({ folders: [{ path: "." }] }));

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
        ROBOT_COMPANION_UI_EVIDENCE_DIR: process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR || ""
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

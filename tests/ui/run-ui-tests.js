const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

const FIXTURE_NAME = "folding-regression.robot";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const fixturePath = path.resolve(__dirname, "../fixtures", FIXTURE_NAME);
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-ui-"));
  const workspaceFixturePath = path.join(workspacePath, FIXTURE_NAME);
  let shouldCleanup = true;

  fs.copyFileSync(fixturePath, workspaceFixturePath);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, "--new-window", "--skip-welcome", "--skip-release-notes"]
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
  }
}

main().catch((error) => {
  console.error("Failed to run Robot Companion UI tests.");
  console.error(error);
  process.exit(1);
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const fixturesDirectoryPath = path.resolve(__dirname, "../fixtures");
  const fixtureNames = fs.readdirSync(fixturesDirectoryPath).filter((entry) => entry.endsWith(".robot"));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-ui-"));
  let shouldCleanup = true;

  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixturesDirectoryPath, fixtureName);
    const workspaceFixturePath = path.join(workspacePath, fixtureName);
    fs.copyFileSync(fixturePath, workspaceFixturePath);
  }

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

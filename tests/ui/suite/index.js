const path = require("path");
const Mocha = require("mocha");

async function run() {
  const mocha = new Mocha({
    color: true,
    timeout: 90000,
    ui: "tdd",
    // Optional author iteration filter; the full suite runs without it.
    ...(process.env.ROBOT_COMPANION_UI_GREP ? { grep: process.env.ROBOT_COMPANION_UI_GREP } : {})
  });

  if (process.env.ROBOT_COMPANION_UI_SUITE === "test-explorer") {
    mocha.addFile(path.resolve(__dirname, "test-explorer-runs-ui.test.js"));
    mocha.addFile(path.resolve(__dirname, "native-discovery-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "provider-switch-ui.test.js"));
  } else if (process.env.ROBOT_COMPANION_UI_SUITE === "native-discovery") {
    mocha.addFile(path.resolve(__dirname, "native-discovery-ui.test.js"));
  } else if (process.env.ROBOT_COMPANION_UI_SUITE === "providers") {
    mocha.addFile(path.resolve(__dirname, "provider-switch-ui.test.js"));
  } else if (process.env.ROBOT_COMPANION_UI_SUITE === "inlay-hints") {
    mocha.addFile(path.resolve(__dirname, "inlay-hints-ui.test.js"));
  } else {
  if (process.env.ROBOT_COMPANION_UI_SUITE !== "language") {
  mocha.addFile(path.resolve(__dirname, "folding-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "documentation-preview-click-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "documentation-preview-security-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "documentation-webview-restrictions-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "documentation-containment-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "keyword-argument-insert-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "run-robot-ui.test.js"));
  }
  mocha.addFile(path.resolve(__dirname, "language-workspace-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "robotcode-language-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "code-actions-formatting-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "semantic-tokens-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "inlay-hints-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "debug-workspace-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "test-workspace-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "robotcode-debug-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "test-explorer-runs-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "native-discovery-ui.test.js"));
  mocha.addFile(path.resolve(__dirname, "provider-switch-ui.test.js"));
  }

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} UI test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { run };

"use strict";

// The UI suite values accepted by ROBOT_COMPANION_UI_SUITE and the test files each runs, in order.
// Without a value the full suite runs; any other undeclared value also runs it, except in required
// mode (ROBOT_COMPANION_UI_REQUIRE_NATIVE=1), where run-ui-tests.js refuses it.
const DOCUMENTATION = [
  "folding-ui.test.js",
  "documentation-preview-click-ui.test.js",
  "documentation-preview-security-ui.test.js",
  "documentation-webview-restrictions-ui.test.js",
  "documentation-containment-ui.test.js",
  "keyword-argument-insert-ui.test.js",
  "run-robot-ui.test.js",
  "run-environment-ui.test.js"
];
const LANGUAGE = [
  "language-workspace-ui.test.js",
  "robotcode-language-ui.test.js",
  "native-libraries-ui.test.js",
  "keyword-explorer-ui.test.js",
  "code-actions-formatting-ui.test.js",
  "semantic-tokens-ui.test.js",
  "debug-workspace-ui.test.js",
  "test-workspace-ui.test.js",
  "robotcode-debug-ui.test.js",
  "test-explorer-runs-ui.test.js",
  "native-discovery-ui.test.js",
  "provider-switch-ui.test.js"
];
const SUITES = {
  all: [...DOCUMENTATION, ...LANGUAGE],
  language: LANGUAGE,
  "test-explorer": ["test-explorer-runs-ui.test.js", "native-discovery-ui.test.js", "provider-switch-ui.test.js"],
  "native-discovery": ["native-discovery-ui.test.js"],
  "native-libraries": ["native-libraries-ui.test.js"],
  keywords: ["keyword-explorer-ui.test.js"],
  providers: ["provider-switch-ui.test.js"],
  environment: ["run-environment-ui.test.js"]
};

// The declared suite name for a ROBOT_COMPANION_UI_SUITE value, or undefined when it is not declared.
function suiteName(value) {
  const name = value || "all";
  return Object.hasOwn(SUITES, name) ? name : undefined;
}

module.exports = { SUITES, suiteName };

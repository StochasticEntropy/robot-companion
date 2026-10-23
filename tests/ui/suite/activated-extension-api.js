"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

// VS Code can report a lower-case Windows drive while Node cached the activated
// module with an upper-case drive. Requiring that other spelling creates a new,
// unactivated module. Read the already activated module instead; never start a
// second extension or fabricate its workspace managers for a test.
function activatedExtensionApi(extensionPath, cache = require.cache, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path;
  const normalize = value => {
    const normalized = paths.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const requested = normalize(paths.join(extensionPath, "src/core/extension.js"));
  const active = Object.values(cache).filter(entry =>
    typeof entry?.filename === "string" && normalize(entry.filename) === requested &&
    entry.exports?.__test__?.getLanguageWorkspaceForTest?.());
  assert.equal(active.length, 1, "Exactly one activated Companion core module must exist in this extension host");
  return active[0].exports.__test__;
}

module.exports = { activatedExtensionApi };

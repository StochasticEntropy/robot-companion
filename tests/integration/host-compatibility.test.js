"use strict";

// The manifest's host claims match what the checks actually run.
//  - The declared minimum VS Code is the version every UI host here and the Windows CI start.
//  - Robot Companion runs only on the workspace extension host, so executables resolve and
//    start on the machine that has the files (a remote, WSL or container host).
//  - Settings naming an executable are machine-overridable: a local user setting does not
//    follow the window to a remote host; remote user settings and the folder's own settings do.
//  - Every executable setting is restricted in an untrusted workspace.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const EXECUTABLE_SETTINGS = ["robotCommand", "nativeBackendExecutable", "languageBackend", "executionBackend", "discoveryBackend"]
  .map(name => `robotCompanion.${name}`);

test("the declared minimum VS Code is the tested version", () => {
  const declared = /^\^(\d+\.\d+\.\d+)$/.exec(manifest.engines.vscode)?.[1];
  assert(declared, `engines.vscode is a caret range: ${manifest.engines.vscode}`);
  const local = /vscode-linux-arm64-(\d+\.\d+\.\d+)/.exec(read("tests/ui/cdp-host.js"))?.[1];
  const windows = /const VSCODE_VERSION = "(\d+\.\d+\.\d+)"/.exec(read(".github/scripts/windows-ui-smoke.cjs"))?.[1];
  assert.equal(local, declared, "the Linux UI hosts start the declared minimum");
  assert.equal(windows, declared, "the Windows CI UI smoke starts the declared minimum");
});

test("Robot Companion runs on the workspace extension host only", () => {
  assert.deepStrictEqual(manifest.extensionKind, ["workspace"]);
});

test("executable settings are machine-overridable and restricted", () => {
  const properties = manifest.contributes.configuration.properties;
  const restricted = new Set(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations);
  for (const name of EXECUTABLE_SETTINGS) {
    assert.equal(properties[name]?.scope, "machine-overridable", name);
    assert(restricted.has(name) || properties[name].restricted === true, `${name} is restricted in untrusted workspaces`);
  }
});

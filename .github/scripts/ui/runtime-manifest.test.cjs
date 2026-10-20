"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { vscodeRuntimeManifest } = require("../windows-ui-smoke.cjs");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function distribution(t, prefix = "", version = "1.141.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-manifest-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, prefix, "resources", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, "Code.exe"), "fixture executable bytes");
  fs.writeFileSync(path.join(app, "product.json"), JSON.stringify({ version, commit: COMMIT }));
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version }));
  return { root, executable: path.join(root, "Code.exe"), app };
}

test("a versioned Windows resources layout binds actual manifest and executable bytes", t => {
  const { executable, app } = distribution(t, COMMIT.slice(0, 10));
  const manifest = vscodeRuntimeManifest(executable);
  assert.equal(manifest.productPath, fs.realpathSync(path.join(app, "product.json")));
  assert.equal(manifest.vscodeCommit, COMMIT);
  assert.equal(manifest.vscodeVersion, "1.141.0");
  assert.equal(manifest.executableSha256, crypto.createHash("sha256").update("fixture executable bytes").digest("hex"));
  assert.match(manifest.productSha256, /^[0-9a-f]{64}$/);
});

test("the legacy flat layout and an explicit bin launcher resolve the same distribution", t => {
  const { root, executable } = distribution(t);
  fs.mkdirSync(path.join(root, "bin"));
  const launcher = path.join(root, "bin", "code.cmd");
  fs.writeFileSync(launcher, "fixture launcher bytes");
  const manifest = vscodeRuntimeManifest(launcher);
  assert.equal(manifest.executablePath, fs.realpathSync(executable));
  assert.equal(manifest.launchPath, fs.realpathSync(launcher));
  assert.notEqual(manifest.launchSha256, manifest.executableSha256);
});

test("wrong versions and mismatched commit directories are refused", t => {
  const wrongVersion = distribution(t, "", "1.140.0");
  assert.throws(() => vscodeRuntimeManifest(wrongVersion.executable), /exactly one actual/);
  const wrongPrefix = distribution(t, "aaaaaaaaaa");
  assert.throws(() => vscodeRuntimeManifest(wrongPrefix.executable), /resources match/);
});

test("missing or ambiguous product manifests cannot silently omit the receipt", t => {
  const missing = distribution(t);
  fs.unlinkSync(path.join(missing.app, "product.json"));
  assert.throws(() => vscodeRuntimeManifest(missing.executable), /exactly one actual/);
  const ambiguous = distribution(t);
  const second = path.join(ambiguous.root, COMMIT.slice(0, 10), "resources", "app");
  fs.mkdirSync(second, { recursive: true });
  fs.copyFileSync(path.join(ambiguous.app, "product.json"), path.join(second, "product.json"));
  fs.copyFileSync(path.join(ambiguous.app, "package.json"), path.join(second, "package.json"));
  assert.throws(() => vscodeRuntimeManifest(ambiguous.executable), /exactly one actual/);
});

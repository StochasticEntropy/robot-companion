"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { activatedExtensionApi } = require("./ui/suite/activated-extension-api");

const api = { getLanguageWorkspaceForTest: () => ({ queue: Promise.resolve() }) };
const entry = (filename, value = api) => ({ filename, exports: { __test__: value } });

test("Windows drive-case mismatch uses the already activated module", () => {
  const module = entry("D:\\a\\source\\src\\core\\extension.js");
  assert.equal(activatedExtensionApi("d:\\a\\source", { original: module }, "win32"), api);
});

test("Windows separator and directory case differences retain the same module identity", () => {
  assert.equal(activatedExtensionApi("d:/a/Source", { original: entry("D:\\a\\source\\src\\core\\extension.js") }, "win32"), api);
});

test("An accidentally loaded unactivated alias cannot replace the active managers", () => {
  const cache = { original: entry("D:\\a\\source\\src\\core\\extension.js"),
    alias: entry("d:\\a\\source\\src\\core\\extension.js", { getLanguageWorkspaceForTest: () => undefined }) };
  assert.equal(activatedExtensionApi("d:\\a\\source", cache, "win32"), api);
});

test("Linux paths remain case-sensitive", () => {
  assert.throws(() => activatedExtensionApi("/a/source", { other: entry("/a/Source/src/core/extension.js") }, "linux"), /Exactly one activated/);
  assert.equal(activatedExtensionApi("/a/source", { original: entry("/a/source/src/core/extension.js") }, "linux"), api);
});

test("Missing activation and ambiguous active instances fail instead of initializing a substitute", () => {
  assert.throws(() => activatedExtensionApi("D:\\a\\source", {}, "win32"), /Exactly one activated/);
  const cache = { first: entry("D:\\a\\source\\src\\core\\extension.js"), second: entry("d:\\a\\source\\src\\core\\extension.js") };
  assert.throws(() => activatedExtensionApi("d:\\a\\source", cache, "win32"), /Exactly one activated/);
});

test("A different extension checkout never supplies a workspace manager", () => {
  assert.throws(() => activatedExtensionApi("D:\\a\\source", { other: entry("D:\\a\\other\\src\\core\\extension.js") }, "win32"), /Exactly one activated/);
});

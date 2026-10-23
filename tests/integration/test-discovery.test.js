"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LspSession } = require("../../src/integration/lsp-session");
const { DISCOVERY_METHOD, normalizeDiscovery, normalizeDiscoveryErrors } = require("../../src/integration/test-discovery");

const root = path.join(__dirname, "fixtures/audit-v1");
const rootUri = pathToFileURL(root).href;
const fileUri = pathToFileURL(path.join(root, "audit.robot")).href;
const at = line => ({ start: { line, character: 0 }, end: { line, character: 5 } });
const suite = children => ({ version: 1, items: [{ kind: "suite", label: "audit", uri: fileUri, range: at(0), children }] });

test("IDs are derived from source URI and name, with occurrence suffixes for repeated names", () => {
  const [normalized] = normalizeDiscovery(suite([
    { kind: "test", label: "Debug Smoke", uri: fileUri, range: at(8), id: "backend-id-ignored" },
    { kind: "test", label: "Debug Smoke", uri: fileUri, range: at(20) }
  ]), rootUri);
  assert.equal(normalized.id, fileUri);
  assert.deepEqual(normalized.children.map(item => item.id), [`${fileUri}::Debug Smoke`, `${fileUri}::Debug Smoke#2`]);
  assert.deepEqual(normalized.children[0].range, at(8));
});

test("invalid versions, ranges and sources outside the folder are rejected", () => {
  assert.throws(() => normalizeDiscovery({ version: 2, items: [] }, rootUri), /version 1/);
  assert.throws(() => normalizeDiscovery(suite([{ kind: "test", label: "T", uri: fileUri,
    range: { start: { line: 3, character: 0 }, end: { line: 1, character: 0 } } }]), rootUri), /invalid range/);
  assert.throws(() => normalizeDiscovery({ version: 1, items: [{ kind: "suite", label: "x", uri: "file:///etc/x.robot",
    range: at(0), children: [] }] }, rootUri), /outside its workspace folder/);
  assert.throws(() => normalizeDiscovery(suite([{ kind: "test", label: "T", uri: "file:///other.robot", range: at(1) }]), rootUri),
    /in its suite file/);
  assert.throws(() => normalizeDiscovery({ version: 1, items: [{ kind: "suite", label: "x", uri: "https://x/y.robot",
    range: at(0), children: [] }] }, rootUri), /file URI/);
});

test("tags and directory suites are optional, validated and kept; a folder has one name", () => {
  const nested = name => pathToFileURL(path.join(root, ...name.split("/"))).href;
  const file = nested("api tests/orders.robot");
  const item = (uri, parents, tags) => ({ kind: "suite", label: "Orders", uri, range: at(0), parents,
    children: [{ kind: "test", label: "Create", uri, range: at(3), ...(tags === undefined ? {} : { tags }) }] });
  const [plain] = normalizeDiscovery(suite([{ kind: "test", label: "T", uri: fileUri, range: at(1) }]), rootUri);
  assert.deepEqual([plain.parents, plain.children[0].tags], [[], []], "absent fields mean a flat file suite without tags");
  const [orders] = normalizeDiscovery({ version: 1, items: [item(file, [{ label: "API Suites", uri: nested("api tests") }],
    ["smoke", "smoke", "API"])] }, rootUri);
  assert.deepEqual(orders.parents, [{ id: nested("api tests"), label: "API Suites", uri: nested("api tests") }]);
  assert.deepEqual(orders.children[0].tags, ["smoke", "API"]);
  // Two suites in one folder share the folder's directory suite.
  const deep = nested("api tests/v2/users.robot");
  const both = normalizeDiscovery({ version: 1, items: [item(file, [{ label: "API Suites", uri: nested("api tests") }], []),
    item(deep, [{ label: "API Suites", uri: nested("api tests") }, { label: "V2", uri: nested("api tests/v2") }], [])] }, rootUri);
  assert.equal(both[0].parents[0], both[1].parents[0]);
  const refused = (parents, pattern, uri = file) =>
    assert.throws(() => normalizeDiscovery({ version: 1, items: [item(uri, parents, [])] }, rootUri), pattern);
  refused([{ label: "V2", uri: nested("api tests/v2") }], /do not lead to its file/, deep); // skips "api tests"
  refused([{ label: "API Suites", uri: nested("api tests") }], /do not lead to its file/, deep); // stops above the file
  refused([{ label: "Other", uri: nested("other") }], /do not lead to its file/);
  refused([{ label: "Etc", uri: "file:///etc" }], /outside its workspace folder/);
  refused([{ label: "", uri: nested("api tests") }], /needs a label/);
  refused("api tests", /invalid parents/);
  assert.throws(() => normalizeDiscovery({ version: 1, items: [item(file, [{ label: "API Suites", uri: nested("api tests") }], []),
    item(deep, [{ label: "Api Tests", uri: nested("api tests") }, { label: "V2", uri: nested("api tests/v2") }], [])] }, rootUri),
  /has two names/);
  for (const tags of ["smoke", [""], [1], ["a\0b"]]) {
    assert.throws(() => normalizeDiscovery({ version: 1, items: [item(file, [{ label: "API Suites", uri: nested("api tests") }], tags)] },
      rootUri), /invalid tags/);
  }
});

test("a result's errors are kept with their source, so a tree missing tests is never shown silently", () => {
  assert.deepEqual(normalizeDiscoveryErrors(suite([]), rootUri), []);
  const errors = [{ uri: fileUri, range: at(4), message: "Unrecognized section header." }, { uri: rootUri, message: "Unreadable." }];
  assert.deepEqual(normalizeDiscoveryErrors({ ...suite([]), errors }, rootUri), [
    { uri: fileUri, range: at(4), message: "Unrecognized section header." }, { uri: rootUri, message: "Unreadable." }]);
  assert.throws(() => normalizeDiscoveryErrors({ ...suite([]), errors: {} }, rootUri), /must be an array/);
  assert.throws(() => normalizeDiscoveryErrors({ ...suite([]), errors: [{ uri: fileUri }] }, rootUri), /needs a message/);
  assert.throws(() => normalizeDiscoveryErrors({ ...suite([]), errors: [{ uri: "file:///etc/x.robot", message: "x" }] }, rootUri),
    /outside its workspace folder/);
});

test("typed discovery diagnostics preserve severity and reject unknown classifications", () => {
  for (const severity of ["error", "warning", "information"]) {
    assert.equal(normalizeDiscoveryErrors({ errors: [{ uri: rootUri, message: "configuration finding", severity }] }, rootUri)[0].severity, severity);
  }
  assert.throws(() => normalizeDiscoveryErrors({ errors: [{ uri: rootUri, message: "finding", severity: "ignored" }] }, rootUri), /invalid severity/);
});

test("discovery service process negotiates v1, returns source-backed tests and stops", async t => {
  const session = new LspSession({ service: "discovery" }); t.after(() => session.stop());
  const capabilities = await session.start({
    id: "discovery-fixture", version: "1", contractVersion: 1, workspaceUri: rootUri, cwd: root, env: {},
    services: { discovery: { executable: process.execPath,
      argv: [path.join(__dirname, "fixtures/discovery/server.js")], transport: "stdio" } }
  }, true);
  assert.equal(capabilities.robotCompanionDiscovery.version, 1);
  const tree = normalizeDiscovery(await session.request(DISCOVERY_METHOD, { workspaceUri: rootUri }), rootUri);
  const audit = tree.find(item => item.uri === fileUri);
  assert.deepEqual(audit.children.map(item => [item.id, item.range.start.line]), [[`${fileUri}::Debug Smoke`, 8]]);
  const child = session.child;
  await session.stop();
  assert.equal(child.exitCode, 0);
});

test("a JSON-RPC error from discovery rejects the request with its code; the session keeps running", async t => {
  const session = new LspSession({ service: "discovery" }); t.after(() => session.stop());
  await session.start({
    id: "discovery-fixture", version: "1", contractVersion: 1, workspaceUri: rootUri, cwd: root, env: {},
    services: { discovery: { executable: process.execPath,
      argv: [path.join(__dirname, "fixtures/discovery/server.js"), "rpc-error"], transport: "stdio" } }
  }, true);
  await assert.rejects(session.request(DISCOVERY_METHOD, { workspaceUri: rootUri }),
    error => error.code === -32603 && error.message === "fixture discovery failed");
  assert.equal(session.state, "running");
});

test("a descriptor without a discovery service is refused before spawning", async () => {
  const session = new LspSession({ service: "discovery" });
  await assert.rejects(session.start({ id: "x", version: "1", contractVersion: 1, workspaceUri: rootUri, cwd: root, env: {},
    services: { debug: { executable: process.execPath, argv: [], transport: "stdio" } } }, true), /does not support discovery/);
  assert.equal(session.child, undefined);
});

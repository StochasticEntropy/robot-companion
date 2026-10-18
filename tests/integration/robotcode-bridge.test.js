"use strict";
// Pinned RobotCode 2.7.0 bridge. The live cases run the real Python packages
// from the prepared environment and are skipped, by name, when it is absent.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LspSession } = require("../../src/integration/lsp-session");
const { robotCodeDescriptor, verifyLanguageServer, configuration, PINNED_ROBOTCODE_VERSION,
  RobotCodeDiscovery, normalizeRobotCodeTests } = require("../../src/integration/robotcode-bridge");
const { DISCOVERY_METHOD, normalizeDiscovery } = require("../../src/integration/test-discovery");

const python = process.env.ROBOT_COMPANION_ROBOTCODE_PYTHON || "/opt/robot-backend/bin/python";
const live = fs.existsSync(python) ? {} : { skip: `RobotCode ${PINNED_ROBOTCODE_VERSION} environment absent at ${python}` };
const pinned = { name: "RobotCode Language Server", version: "2.7.0" };

test("bridge descriptors are explicit contract-v1 argv with no shell or discovery guess", () => {
  const root = process.cwd();
  const descriptor = robotCodeDescriptor({ workspaceUri: pathToFileURL(root).href, cwd: root, python: "/env/bin/python",
    services: ["language", "debug"] });
  assert.equal(descriptor.id, "robotcode");
  assert.equal(descriptor.version, PINNED_ROBOTCODE_VERSION);
  assert.deepEqual(descriptor.services.language.argv, ["-m", "robotcode.cli", "language-server", "--stdio"]);
  assert.deepEqual(descriptor.services.debug.argv, ["-m", "robotcode.cli", "debug-launch", "--stdio"]);
  assert.equal(descriptor.services.discovery, undefined);
  assert.deepEqual(robotCodeDescriptor({ workspaceUri: pathToFileURL(root).href, cwd: root, python: "/env/bin/python",
    services: ["discovery"] }).services.discovery.argv,
  ["-m", "robotcode.cli", "--format", "json", "--no-color", "--no-pager", "discover", "tests"]);
  assert.throws(() => robotCodeDescriptor({ workspaceUri: pathToFileURL(root).href, cwd: root, python: "/env/bin/python",
    services: ["repl"] }), /does not provide repl/);
});

test("every complete README owned-mode example is the descriptor its provider's builder makes", () => {
  const { nativeDescriptor } = require("../../src/integration/native-backend");
  const readme = fs.readFileSync(path.join(__dirname, "../../README.md"), "utf8");
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1])
    .filter(block => block.includes('"robotCompanion.executionBackend"')).map(block => JSON.parse(block));
  // The RobotCode debug/discovery example, and one complete folder configuration per provider.
  assert.equal(examples.length, 3, "three complete executionBackend examples");
  const providers = new Set();
  for (const example of examples) {
    assert.equal(example["robotCompanion.integrationMode"], "owned");
    assert.equal(typeof example["robotCompanion.robotCommand"], "string");
    for (const setting of ["robotCompanion.languageBackend", "robotCompanion.executionBackend"]) {
      const backend = example[setting];
      if (!backend) continue;
      const base = { workspaceUri: backend.workspaceUri, cwd: backend.cwd, services: Object.keys(backend.services) };
      const first = Object.values(backend.services)[0].executable;
      const built = backend.id === "robotcode" ? robotCodeDescriptor({ ...base, python: first })
        : nativeDescriptor({ ...base, executable: first });
      const { rootPath, ...settings } = JSON.parse(JSON.stringify(built)); // rootPath is derived, not a setting.
      assert.equal(rootPath, "/absolute/workspace");
      assert.deepEqual(backend, settings, `${setting} (${backend.id})`);
      providers.add(`${backend.id}:${setting}`);
    }
  }
  assert.deepEqual([...providers].sort(), ["robot-companion-native:robotCompanion.executionBackend",
    "robot-companion-native:robotCompanion.languageBackend", "robotcode:robotCompanion.executionBackend",
    "robotcode:robotCompanion.languageBackend"]);
});

test("a RobotCode descriptor must declare and run the pinned language server", () => {
  const descriptor = { id: "robotcode", version: "2.7.0" };
  verifyLanguageServer(descriptor, pinned);
  verifyLanguageServer({ id: "other", version: "9" }, undefined);
  assert.throws(() => verifyLanguageServer({ id: "robotcode", version: "2.6.0" }, pinned), /pinned to 2\.7\.0; the descriptor declares 2\.6\.0/);
  assert.throws(() => verifyLanguageServer(descriptor, { name: "RobotCode Language Server", version: "2.6.1" }), /reported RobotCode Language Server 2\.6\.1/);
  assert.throws(() => verifyLanguageServer(descriptor, { name: "", version: "" }), /reported unknown server unknown version/);
});

test("bridge configuration starts RobotCode's documentation server only on demand", () => {
  const robotcode = { id: "robotcode" };
  assert.deepEqual(configuration(robotcode, "robotcode.documentationServer", null), { startOnDemand: true });
  assert.deepEqual(configuration(robotcode, "robotcode.documentationServer", { startPort: 4000, startOnDemand: false }),
    { startPort: 4000, startOnDemand: true });
  assert.deepEqual(configuration(robotcode, "robotcode.robot", { args: ["--dryrun"] }), { args: ["--dryrun"] });
  assert.equal(configuration({ id: "other" }, "robotcode.documentationServer", null), null);
});

const answer = descriptor => async (method, params) => method === "workspace/configuration" ?
  params.items.map(item => configuration(descriptor, item.section, null) ?? null) : null;

// Linux: TCP ports in LISTEN state owned by one process's socket descriptors.
function listeningPorts(pid) {
  const inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).map(fd => {
    try { return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]; } catch { return undefined; }
  }).filter(Boolean));
  return ["tcp", "tcp6"].flatMap(table => fs.readFileSync(`/proc/net/${table}`, "utf8").split("\n").slice(1)
    .map(line => line.trim().split(/\s+/)).filter(cols => cols[3] === "0A" && inodes.has(cols[9]))
    .map(cols => parseInt(cols[1].split(":")[1], 16)));
}

function corpus(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-robotcode-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "fixtures/audit-v1"), directory, { recursive: true });
  return directory;
}

async function definition(session, uri, line, text, keyword) {
  const character = text.split("\n")[line].indexOf(keyword) + 2;
  const result = await session.request("textDocument/definition", { textDocument: { uri }, position: { line, character } });
  return result.map(item => ({ file: path.basename(new URL(item.targetUri).pathname),
    line: item.targetSelectionRange.start.line, character: item.targetSelectionRange.start.character }));
}

test("live RobotCode 2.7.0 language server resolves imported, resource, local and alias keywords", { ...live, timeout: 90000 }, async t => {
  const directory = corpus(t);
  const workspaceUri = pathToFileURL(directory).href;
  const descriptor = robotCodeDescriptor({ workspaceUri, cwd: directory, python });
  const session = new LspSession({ timeoutMs: 60000, onServerRequest: answer(descriptor) });
  t.after(() => session.stop());
  const capabilities = await session.start(descriptor, true);
  verifyLanguageServer(descriptor, session.serverInfo);
  assert.equal(capabilities.positionEncoding, "utf-16");
  assert.equal(capabilities.definitionProvider, true);
  const open = name => {
    const text = fs.readFileSync(path.join(directory, name), "utf8"), uri = pathToFileURL(path.join(directory, name)).href;
    session.notify("textDocument/didOpen", { textDocument: { uri, languageId: "robotframework", version: 1, text } });
    return { uri, text };
  };
  const audit = open("audit.robot");
  // A call site is indented; the keyword's own definition starts at column 0.
  const line = keyword => audit.text.split("\n").findIndex(entry => /^\s/.test(entry) && entry.includes(keyword));
  // AShadow.py also defines "Build Record" but is not imported: never chosen.
  assert.deepEqual(await definition(session, audit.uri, line("Build Record"), audit.text, "Build Record"),
    [{ file: "AuditLibrary.py", line: 11, character: 0 }]);
  assert.deepEqual(await definition(session, audit.uri, line("Resource Step"), audit.text, "Resource Step"),
    [{ file: "shared.resource", line: 1, character: 0 }]);
  assert.deepEqual(await definition(session, audit.uri, line("Local Step"), audit.text, "Local Step"),
    [{ file: "audit.robot", line: 17, character: 0 }]);
  const alias = open("alias.robot");
  const aliasLine = alias.text.split("\n").findIndex(entry => entry.includes("Audit.Build Record"));
  assert.deepEqual(await definition(session, alias.uri, aliasLine, alias.text, "Build Record"),
    [{ file: "AuditLibrary.py", line: 11, character: 0 }]);
  // The alias prefix itself names the library import, not a keyword.
  assert.deepEqual(await definition(session, alias.uri, aliasLine, alias.text, "Audit."),
    [{ file: "alias.robot", line: 1, character: 36 }]);
  const child = session.child;
  if (process.platform === "linux") assert.deepEqual(listeningPorts(child.pid), [], "no documentation server socket was opened");
  const stopped = Date.now();
  await session.stop();
  assert.equal(child.exitCode, 0, "RobotCode exits cleanly after shutdown, exit and stdin EOF");
  assert.ok(Date.now() - stopped < 2000);
});

test("live RobotCode environment with a wrong pinned version declaration is refused before providers", { ...live, timeout: 60000 }, async t => {
  const directory = corpus(t);
  const descriptor = { ...robotCodeDescriptor({ workspaceUri: pathToFileURL(directory).href, cwd: directory, python }), version: "2.6.0" };
  const session = new LspSession({ timeoutMs: 60000, onServerRequest: async (method, params) =>
    method === "workspace/configuration" ? params.items.map(() => null) : null });
  t.after(() => session.stop());
  await session.start(descriptor, true);
  assert.throws(() => verifyLanguageServer(descriptor, session.serverInfo), /pinned to 2\.7\.0/);
});

test("a fixture reporting another RobotCode version is refused by the language-server pin", async t => {
  const descriptor = { id: "robotcode", version: "2.7.0", contractVersion: 1,
    workspaceUri: pathToFileURL(process.cwd()).href, cwd: process.cwd(),
    env: { FIXTURE_SERVER_INFO: JSON.stringify({ name: "RobotCode Language Server", version: "2.8.0" }) },
    services: { language: { executable: process.execPath, argv: [path.join(__dirname, "fixtures/protocol/server.js")], transport: "stdio" } } };
  const session = new LspSession(); t.after(() => session.stop());
  await session.start(descriptor, true);
  assert.deepEqual(session.serverInfo, { name: "RobotCode Language Server", version: "2.8.0" });
  assert.throws(() => verifyLanguageServer(descriptor, session.serverInfo), /reported RobotCode Language Server 2\.8\.0/);
});

test("RobotCode's flat test list becomes normalized suites; other item types are ignored", () => {
  const result = normalizeRobotCodeTests({ items: [
    { type: "test", name: "T1", source: "/ws/a.robot", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } } },
    { type: "suite", name: "A", source: "/ws/a.robot" },
    { type: "test", name: "T2", source: "/ws/a.robot", range: { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } } }
  ] });
  assert.equal(result.version, 1);
  assert.deepEqual(normalizeDiscovery(result, "file:///ws").map(suite => [suite.id, suite.label, suite.children.map(test => test.id)]),
    [["file:///ws/a.robot", "a.robot", ["file:///ws/a.robot::T1", "file:///ws/a.robot::T2"]]]);
  assert.throws(() => normalizeRobotCodeTests({}), /items array/);
});

test("live RobotCode discovery lists the audit tests with source-backed IDs", { ...live, timeout: 90000 }, async t => {
  const directory = corpus(t);
  const workspaceUri = pathToFileURL(directory).href;
  const discovery = new RobotCodeDiscovery();
  t.after(() => discovery.stop());
  const capabilities = await discovery.start(robotCodeDescriptor({ workspaceUri, cwd: directory, python, services: ["discovery"] }), true);
  assert.equal(capabilities.robotCompanionDiscovery.version, 1);
  const tree = normalizeDiscovery(await discovery.request(DISCOVERY_METHOD, { workspaceUri }), workspaceUri);
  const audit = pathToFileURL(path.join(directory, "audit.robot")).href;
  assert.deepEqual(tree.map(suite => suite.label).sort(), ["alias.robot", "audit.robot"]);
  const smoke = tree.find(suite => suite.uri === audit).children;
  assert.deepEqual(smoke.map(test => [test.id, test.range.start.line]), [[`${audit}::Debug Smoke`, 8]]);
  await assert.rejects(new RobotCodeDiscovery().request(DISCOVERY_METHOD, {}), /not running/);
  await assert.rejects(discovery.request("other/method", {}), /Unsupported discovery request/);
});

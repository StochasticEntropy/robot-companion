"use strict";
// Local discovery protocol fixture only. It finds test names with a line scan of
// *.robot files; it runs no Robot Framework and has no Robot parsing semantics.
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { frame, MessageReader } = require("../../../../src/integration/lsp-session");
const mode = process.argv[2] || "normal";
// "stale-failure <n>": the n-th discovery request gets no answer until the next
// one has been answered; then it fails, followed by a fixture/staleFailureSent
// notification. The order comes from the requests, not from timing.
// "rpc-error-after-first": the first discovery request is answered, every later one fails.
const held = mode === "stale-failure" ? Number(process.argv[3]) : 0;
let discoveries = 0, heldId;

function robotFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : robotFiles(full);
    return entry.name.endsWith(".robot") ? [full] : [];
  }).sort();
}

function suiteFor(file) {
  const uri = pathToFileURL(file).href;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const children = [];
  let inTests = false;
  lines.forEach((line, index) => {
    if (/^\*{3}/.test(line)) { inTests = /^\*{3}\s*(Test Cases|Tasks)/i.test(line); return; }
    if (inTests && /^\S/.test(line) && !line.startsWith("#")) {
      const name = line.split(/\s{2,}|\t/)[0].trim();
      children.push({ kind: "test", label: name, uri,
        range: { start: { line: index, character: 0 }, end: { line: index, character: name.length } } });
    }
  });
  return { kind: "suite", label: path.basename(file, ".robot"), uri,
    range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: 0 } }, children };
}

const reader = new MessageReader(message => {
  const reply = result => process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result }));
  const discovery = message.method === "robotCompanion/discoverTests" ? ++discoveries : 0;
  if (message.method === "initialize") {
    reply({ capabilities: mode === "no-discovery" ? {} : { robotCompanionDiscovery: { version: 1 } } });
  } else if (message.method === "shutdown") reply(null);
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "robotCompanion/discoverTests" && (mode === "rpc-error" ||
      (mode === "rpc-error-after-first" && discovery > 1))) {
    process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "fixture discovery failed" } }));
  } else if (message.method === "robotCompanion/discoverTests") {
    if (discovery === held) { heldId = message.id; return; }
    const root = fileURLToPath(message.params.workspaceUri);
    const items = robotFiles(root).map(suiteFor).filter(suite => suite.children.length);
    if (mode === "outside") items.push({ kind: "suite", label: "outside", uri: "file:///etc/outside.robot",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, children: [] });
    reply({ version: 1, items });
    if (heldId !== undefined) {
      process.stdout.write(frame({ jsonrpc: "2.0", id: heldId, error: { code: -32603, message: "fixture stale discovery failed" } }));
      process.stdout.write(frame({ jsonrpc: "2.0", method: "fixture/staleFailureSent", params: { request: held } }));
      heldId = undefined;
    }
  } else if (message.id !== undefined) {
    process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } }));
  }
}, "Discovery");
process.stdin.on("data", chunk => reader.accept(chunk));
process.stdin.on("end", () => process.exit(0));

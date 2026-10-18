"use strict";
// Local protocol fixture only. This does not implement a native Robot backend.
const { frame, MessageReader } = require("../../../../src/integration/lsp-session");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const languageUi = process.argv[2]?.startsWith("language-");
const documents = new Map();
const events = [];
let delayDefinition = 0;
let definitionCount = 0;
let definitionMode = "normal";
const ignoreTerm = process.argv[2] === "ignore-term";
const hangInitialize = process.argv[2] === "hang-initialize";
const hangShutdown = process.argv[2] === "hang-shutdown";
if (ignoreTerm || hangInitialize || hangShutdown) process.on("SIGTERM", () => {});
let unexpectedResponses = 0;
const reader = new MessageReader(message => {
  if (!message.method) { unexpectedResponses++; return; }
  const send = result => process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    process.stderr.write("fixture log, never protocol\n");
    if (hangInitialize) return;
    send({ capabilities: { definitionProvider: process.argv[2] !== "language-no-definition",
      ...(languageUi ? { textDocumentSync: { openClose: true, change: 2, save: { includeText: true } } } : {}),
      positionEncoding: languageUi || ignoreTerm || hangShutdown ? "utf-16" : process.argv[2] || "utf-16" },
      ...(process.env.FIXTURE_SERVER_INFO ? { serverInfo: JSON.parse(process.env.FIXTURE_SERVER_INFO) } : {}) });
  } else if (message.method === "shutdown") { if (!hangShutdown) send(null); }
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "fixture/echo") send(message.params);
  else if (message.method === "fixture/error") process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } }));
  else if (message.method === "fixture/stats") send({ unexpectedResponses });
  else if (message.method === "fixture/serverRequest") process.stdout.write(frame({ jsonrpc: "2.0", id: "server-1", method: "workspace/configuration", params: {} }));
  else if (message.method === "fixture/crash") process.exit(7);
  else if (message.method === "fixture/malformed") process.stdout.write("Content-Length: nope\r\n\r\n");
  else if (message.method === "textDocument/didOpen") documents.set(message.params.textDocument.uri, message.params.textDocument);
  else if (message.method === "textDocument/didClose") documents.delete(message.params.textDocument.uri);
  else if (message.method === "textDocument/didChange") {
    const doc = documents.get(message.params.textDocument.uri);
    for (const change of message.params.contentChanges) {
      if (!change.range) doc.text = change.text;
      else {
        const offset = point => doc.text.split("\n").slice(0, point.line).reduce((sum, line) => sum + line.length + 1, 0) + point.character;
        const start = offset(change.range.start), end = offset(change.range.end);
        doc.text = doc.text.slice(0, start) + change.text + doc.text.slice(end);
      }
    }
    doc.version = message.params.textDocument.version;
  }
  else if (message.method === "fixture/documents") send([...documents.values()]);
  else if (message.method === "fixture/events") send(events);
  else if (message.method === "textDocument/didSave" || message.method === "workspace/didChangeWatchedFiles") events.push(message);
  else if (message.method === "fixture/publishDiagnostics") {
    process.stdout.write(frame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: message.params }));
    send(null);
  }
  else if (message.method === "fixture/delayDefinition") { delayDefinition = message.params; send(null); }
  else if (message.method === "fixture/definitionCount") send(definitionCount);
  else if (message.method === "fixture/definitionMode") { definitionMode = message.params; send(null); }
  else if (message.method === "fixture/closeStdin") {
    send(null);
    fs.closeSync(0);
    setInterval(() => {}, 1000); // Stay alive until the owner handles EPIPE.
  }
  else if (message.method === "textDocument/definition") {
    definitionCount++;
    // Fixed protocol fixture mappings, deliberately not Robot semantics.
    const doc = documents.get(message.params.textDocument.uri);
    const line = doc?.text.split("\n")[message.params.position.line] || "";
    let target;
    if (line.includes("Build Record")) target = ["AuditLibrary.py", 11, 4, 16];
    if (line.includes("Resource Step")) target = ["shared.resource", 1, 0, 13];
    if (line.trim() === "Local Step") target = ["audit.robot", 17, 0, 10];
    const result = target ? [{ targetUri: pathToFileURL(path.join(process.cwd(), "integration-audit-v1", target[0])).href,
      targetRange: { start: { line: target[1], character: 0 }, end: { line: target[1], character: target[3] } },
      targetSelectionRange: { start: { line: target[1], character: target[2] }, end: { line: target[1], character: target[3] } } }] : [];
    const resolved = definitionMode === "missing" ? [] : definitionMode === "ambiguous" && target
      ? result.concat([{ uri: pathToFileURL(path.join(process.cwd(), "integration-audit-v1", "AShadow.py")).href,
        range: { start: { line: 4, character: 4 }, end: { line: 4, character: 26 } } }]) : result;
    setTimeout(() => send(resolved), delayDefinition);
  }
  // fixture/hang intentionally produces no reply for cancellation/timeout tests.
});
process.stdin.on("data", chunk => reader.accept(chunk));

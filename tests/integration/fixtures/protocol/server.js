"use strict";
// Local protocol fixture only. This does not implement a native Robot backend.
const { frame, MessageReader } = require("../../../../src/integration/lsp-session");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const languageUi = process.argv[2]?.startsWith("language-");
// language-features advertises every editor feature; language-features-partial
// leaves out hover, rename, code actions and formatting, which still answer if
// asked (they must not be).
const features = process.argv[2]?.startsWith("language-features");
const partial = process.argv[2] === "language-features-partial";
const featureCounts = {};
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
      ...(features ? { completionProvider: { triggerCharacters: ["{"] }, signatureHelpProvider: { triggerCharacters: [" "] },
        referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
        ...(partial ? {} : { hoverProvider: true, renameProvider: { prepareProvider: true },
          codeActionProvider: { codeActionKinds: ["quickfix"], resolveProvider: true },
          documentFormattingProvider: true, documentRangeFormattingProvider: true }) } : {}),
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
  else if (message.method === "fixture/featureCounts") send(featureCounts);
  else if (["textDocument/hover", "textDocument/prepareRename", "textDocument/rename", "textDocument/completion",
    "textDocument/signatureHelp", "textDocument/references", "textDocument/documentSymbol", "workspace/symbol",
    "textDocument/codeAction", "codeAction/resolve", "textDocument/formatting", "textDocument/rangeFormatting"].includes(message.method)) {
    featureCounts[message.method] = (featureCounts[message.method] || 0) + 1;
    const uri = message.params.textDocument?.uri;
    const at = { start: message.params.position || { line: 0, character: 0 }, end: message.params.position || { line: 0, character: 0 } };
    if (message.method === "textDocument/hover") send({ contents: { kind: "markdown", value: "Protocol fixture hover" }, range: at });
    else if (message.method === "textDocument/prepareRename") send({ range: at, placeholder: "fixture" });
    else if (message.method === "textDocument/rename") send({ changes: { [uri]: [{ range: at, newText: message.params.newName }] } });
    else if (message.method === "textDocument/completion") send([{ label: "Protocol Fixture Keyword", kind: 3 }]);
    else if (message.method === "textDocument/signatureHelp") send({ signatures: [{ label: "fixture(a, b)", parameters: [{ label: "a" }, { label: "b" }] }], activeParameter: 1 });
    else if (message.method === "textDocument/references") send([{ uri, range: at }]);
    else if (message.method === "textDocument/documentSymbol") send([{ name: "Fixture Symbol", kind: 12, range: at, selectionRange: at }]);
    else if (message.method === "textDocument/codeAction") {
      const start = { line: message.params.range.start.line, character: 0 };
      // A direct edit, one resolved later, and a command-only action Companion cannot run.
      send([{ title: "Fixture direct fix", kind: "quickfix", isPreferred: true, diagnostics: message.params.context.diagnostics,
        edit: { changes: { [uri]: [{ range: { start, end: start }, newText: "# direct\n" }] } } },
      { title: "Fixture resolved fix", kind: "quickfix", data: { uri, start } },
      { title: "Fixture command only", command: "fixture.clientCommand", arguments: [] }]);
    }
    else if (message.method === "codeAction/resolve") {
      const { uri: target, start } = message.params.data;
      send({ ...message.params, edit: { changes: { [target]: [{ range: { start, end: start }, newText: "# resolved\n" }] } },
        command: { title: "unsupported", command: "fixture.clientCommand" } });
    }
    else if (message.method === "textDocument/formatting" || message.method === "textDocument/rangeFormatting") {
      const start = message.params.range?.start || { line: 0, character: 0 };
      send([{ range: { start, end: start }, newText: message.method === "textDocument/formatting" ? "# formatted\n" : "# range formatted\n" }]);
    }
    else send([{ name: "Fixture Workspace Symbol", kind: 12, location: { uri: pathToFileURL(path.join(process.cwd(), "integration-audit-v1", "shared.resource")).href, range: at } }]);
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

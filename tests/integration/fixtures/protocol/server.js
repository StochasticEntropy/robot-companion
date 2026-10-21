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
// While held, definition answers wait for fixture/releaseDefinitions, so a
// test orders stale/cancel checks by protocol state instead of a timer.
let holdDefinitions = false;
const heldDefinitions = [];
let definitionCount = 0;
let definitionMode = "normal";
const ignoreTerm = process.argv[2] === "ignore-term";
const hangInitialize = process.argv[2] === "hang-initialize";
const hangShutdown = process.argv[2] === "hang-shutdown";
if (ignoreTerm || hangInitialize || hangShutdown) process.on("SIGTERM", () => {});
let unexpectedResponses = 0;
// Semantic tokens: "valid", "invalid" (a type index outside the legend), and for
// `full/delta`: "badEdits" (an edit past the end of its base), "deltaError" (an
// error answer) or "forgetful" (every previous result unknown: whole results).
let semanticTokensMode = "valid";
const refreshAnswers = [];
// The last whole result per document (the base of its delta), and each token request answered.
const semanticResults = new Map();
const semanticRequests = [];
let semanticResultCounter = 0;
const reader = new MessageReader(message => {
  if (!message.method) {
    if (message.id === "semantic-refresh" || message.id === "inlay-refresh") refreshAnswers.push(message);
    else unexpectedResponses++;
    return;
  }
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
          documentFormattingProvider: true, documentRangeFormattingProvider: true,
          semanticTokensProvider: { legend: { tokenTypes: ["fixtureCall", "fixtureName"], tokenModifiers: ["fixtureModifier"] },
            full: { delta: true }, range: true },
          inlayHintProvider: true }) } : {}),
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
  else if (message.method === "fixture/holdDefinitions") { holdDefinitions = true; send(null); }
  else if (message.method === "fixture/heldDefinitions") send(heldDefinitions.length);
  else if (message.method === "fixture/releaseDefinitions") {
    holdDefinitions = false;
    const released = heldDefinitions.splice(0);
    for (const answer of released) answer();
    send(released.length);
  }
  else if (message.method === "fixture/definitionCount") send(definitionCount);
  else if (message.method === "fixture/definitionMode") { definitionMode = message.params; send(null); }
  else if (message.method === "fixture/closeStdin") {
    send(null);
    fs.closeSync(0);
    setInterval(() => {}, 1000); // Stay alive until the owner handles EPIPE.
  }
  else if (message.method === "fixture/featureCounts") send(featureCounts);
  else if (message.method === "fixture/semanticTokensMode") { semanticTokensMode = message.params; send(null); }
  else if (message.method === "fixture/semanticTokensRefresh") {
    process.stdout.write(frame({ jsonrpc: "2.0", id: "semantic-refresh", method: "workspace/semanticTokens/refresh" }));
    send(null);
  }
  else if (message.method === "fixture/inlayHintRefresh") {
    process.stdout.write(frame({ jsonrpc: "2.0", id: "inlay-refresh", method: "workspace/inlayHint/refresh" }));
    send(null);
  }
  else if (message.method === "fixture/refreshAnswers") send(refreshAnswers);
  else if (message.method === "textDocument/inlayHint") {
    featureCounts[message.method] = (featureCounts[message.method] || 0) + 1;
    // Fixed protocol fixture hints, deliberately not Robot semantics, on each "Build Record" line in the range:
    // a parameter hint, a type hint whose label part carries a command and location, a hint without a kind
    // and two invalid ones (outside the document, no label) that must be skipped.
    const lines = (documents.get(message.params.textDocument.uri)?.text || "").split("\n");
    const { start, end } = message.params.range;
    const hints = [];
    lines.forEach((text, line) => {
      const character = text.indexOf("Build Record");
      if (character < 0 || line < start.line || line > end.line) return;
      const argument = text.indexOf("name=");
      hints.push({ position: { line, character: argument }, label: "fixtureParameter=", kind: 2, tooltip: "Fixture parameter",
        textEdits: [{ range: { start: { line, character: argument }, end: { line, character: argument } }, newText: "edited=" }] },
      { position: { line, character: text.indexOf("}") + 1 }, kind: 1, paddingLeft: true, label: [{ value: ": FixtureType",
        tooltip: { kind: "markdown", value: "Fixture **type**" }, command: { title: "run", command: "fixture.clientCommand" },
        location: { uri: message.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }] },
      { position: { line, character }, label: "Fixture." },
      { position: { line: lines.length + 5, character: 0 }, label: "outside", kind: 2 },
      { position: { line, character }, label: "", kind: 2 });
    });
    send(hints);
  }
  else if (["textDocument/semanticTokens/full", "textDocument/semanticTokens/range", "textDocument/semanticTokens/full/delta"]
    .includes(message.method)) {
    featureCounts[message.method] = (featureCounts[message.method] || 0) + 1;
    const data = semanticTokenData(message.params.textDocument.uri, message.params.range, semanticTokensMode === "invalid");
    const uri = message.params.textDocument.uri;
    const log = { method: message.method, previousResultId: message.params.previousResultId };
    semanticRequests.push(log);
    if (message.method === "textDocument/semanticTokens/range") { log.answer = "data"; send({ data }); return; }
    if (message.method.endsWith("/delta") && semanticTokensMode === "deltaError") {
      log.answer = "error";
      process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "fixture delta failure" } }));
      return;
    }
    const base = semanticResults.get(uri);
    const resultId = `fixture-${++semanticResultCounter}`;
    semanticResults.set(uri, { resultId, data });
    log.resultId = resultId;
    if (!message.method.endsWith("/delta") || semanticTokensMode === "forgetful" || base?.resultId !== message.params.previousResultId) {
      log.answer = "data";
      send({ resultId, data });
      return;
    }
    // One edit between the common prefix and suffix (not token-aligned: any integer edit is valid LSP).
    let start = 0, end = 0;
    while (start < Math.min(base.data.length, data.length) && base.data[start] === data[start]) start++;
    while (end < Math.min(base.data.length, data.length) - start && base.data[base.data.length - 1 - end] === data[data.length - 1 - end]) end++;
    const edits = semanticTokensMode === "badEdits" ? [{ start: base.data.length + 5, deleteCount: 5, data: [0, 0, 1, 0, 0] }]
      : start === base.data.length && start === data.length ? [] : [{ start, deleteCount: base.data.length - start - end, data: data.slice(start, data.length - end) }];
    log.answer = "edits";
    send({ resultId, edits });
  }
  else if (message.method === "fixture/semanticTokenRequests") send(semanticRequests);
  // The current whole-document data, as a fresh full request would answer it (nothing kept).
  else if (message.method === "fixture/currentSemanticTokens") send(semanticTokenData(message.params.uri));
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
    if (holdDefinitions) heldDefinitions.push(() => send(resolved));
    else send(resolved);
  }
  // fixture/hang intentionally produces no reply for cancellation/timeout tests.
});
process.stdin.on("data", chunk => reader.accept(chunk));

// Fixed protocol fixture mappings, deliberately not Robot semantics: each
// "Build Record" is a fixtureCall with fixtureModifier, each "Local Step" a fixtureName.
function semanticTokenData(uri, range, invalid = false) {
  const lines = (documents.get(uri)?.text || "").split("\n");
  const found = [];
  lines.forEach((text, line) => {
    for (const [name, type, modifiers] of [["Build Record", 0, 1], ["Local Step", 1, 0]]) {
      const character = text.indexOf(name);
      if (character >= 0 && (!range || (line >= range.start.line && line <= range.end.line))) found.push([line, character, name.length, type, modifiers]);
    }
  });
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const data = [];
  let previous = [0, 0];
  for (const [line, character, length, type, modifiers] of found) {
    data.push(line - previous[0], line === previous[0] ? character - previous[1] : character, length, invalid ? 7 : type, modifiers);
    previous = [line, character];
  }
  return data;
}

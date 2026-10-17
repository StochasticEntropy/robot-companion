"use strict";
// Local protocol fixture only. This does not implement a native Robot backend.
const { frame, MessageReader } = require("../../../../src/integration/lsp-session");
const ignoreTerm = process.argv[2] === "ignore-term";
const hangInitialize = process.argv[2] === "hang-initialize";
if (ignoreTerm || hangInitialize) process.on("SIGTERM", () => {});
let unexpectedResponses = 0;
const reader = new MessageReader(message => {
  if (!message.method) { unexpectedResponses++; return; }
  const send = result => process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    process.stderr.write("fixture log, never protocol\n");
    if (hangInitialize) return;
    send({ capabilities: { definitionProvider: true, positionEncoding: ignoreTerm ? "utf-16" : process.argv[2] || "utf-16" } });
  } else if (message.method === "shutdown") send(null);
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "fixture/echo") send(message.params);
  else if (message.method === "fixture/error") process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } }));
  else if (message.method === "fixture/stats") send({ unexpectedResponses });
  else if (message.method === "fixture/serverRequest") process.stdout.write(frame({ jsonrpc: "2.0", id: "server-1", method: "workspace/configuration", params: {} }));
  else if (message.method === "fixture/crash") process.exit(7);
  else if (message.method === "fixture/malformed") process.stdout.write("Content-Length: nope\r\n\r\n");
  // fixture/hang intentionally produces no reply for cancellation/timeout tests.
});
process.stdin.on("data", chunk => reader.accept(chunk));

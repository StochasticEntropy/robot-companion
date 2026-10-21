"use strict";
// Local DAP protocol fixture only. It runs no Robot Framework and is not a
// debug backend; it exercises the integration's adapter lifecycle.
const { frame, MessageReader } = require("../../../../src/integration/lsp-session");
const mode = process.argv[2] || "full";
let seq = 1;
if (mode === "hang-disconnect") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // Stay alive after stdin closes, like a stuck backend.
}
const write = message => process.stdout.write(frame({ seq: seq++, ...message }));
const event = (name, body = {}) => write({ type: "event", event: name, body });
const capabilities = mode === "minimal" ? { supportsConfigurationDoneRequest: true } : {
  supportsConfigurationDoneRequest: true, supportsTerminateRequest: true,
  supportsSetVariable: true, supportsEvaluateForHovers: true
};
const reader = new MessageReader(message => {
  if (message.type !== "request") return;
  const respond = (body = {}, success = true, text) => write({ type: "response", request_seq: message.seq,
    command: message.command, success, ...(text ? { message: text } : {}), body });
  const args = message.arguments || {};
  // Started as a prepared session's connector (`dap-connect`) for a stale descriptor: every
  // request fails, as the native connector's do; it ends at end of input.
  if (mode === "dap-connect") return respond({}, false, "Cannot attach to the prepared Robot session: Connection refused");
  switch (message.command) {
    case "initialize":
      process.stderr.write(`dap fixture pid ${process.pid}, log only\n`);
      respond(capabilities);
      event("initialized");
      break;
    case "launch":
      respond();
      event("output", { category: "console", output: `DAP fixture launched target ${args.target}\n` });
      if (mode === "crash-after-launch") setTimeout(() => process.exit(3), 50);
      break;
    case "setBreakpoints":
      respond({ breakpoints: (args.breakpoints || []).map(point => ({ verified: false, line: point.line,
        message: "DAP fixture does not run Robot Framework" })) });
      break;
    case "setExceptionBreakpoints": case "configurationDone": respond(); break;
    case "threads": respond({ threads: [{ id: 1, name: "DAP fixture thread" }] }); break;
    case "terminate": respond(); event("terminated"); break;
    case "disconnect":
      if (mode === "hang-disconnect") break;
      respond();
      setTimeout(() => process.exit(0), 10);
      break;
    default: respond({}, false, `DAP fixture does not implement ${message.command}.`);
  }
}, "DAP");
// A connector reads one line of startup data before DAP framing.
let startup = mode === "dap-connect" ? "" : undefined;
process.stdin.on("data", chunk => {
  if (startup !== undefined) {
    const text = startup + chunk.toString("latin1"), end = text.indexOf("\n");
    if (end < 0) { startup = text; return; }
    startup = undefined;
    chunk = Buffer.from(text.slice(end + 1), "latin1");
  }
  reader.accept(chunk);
});
// End of input without disconnect is the owner's stop request.
process.stdin.on("end", () => { if (mode !== "hang-disconnect") process.exit(0); });

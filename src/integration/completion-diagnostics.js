"use strict";

const PREFIX = "Completion boundary: ";
const MAX_ROWS = 512;
const MAX_REQUESTS = 128;
const DURATION_MS = 120000;
const STAGES = new Set(["provider-enter", "native-request", "native-reply", "native-rejected", "provider-return", "provider-rejected"]);

// Deliberately no document identity, position, text, item labels or exception messages.
// A short opt-in window writes fixed-shape counters directly to the existing channel;
// it retains no request/result history and cannot change a provider's answer.
class CompletionDiagnostics {
  constructor(channel, now = () => performance.now()) {
    this.channel = channel;
    this.now = now;
    this.active = undefined;
  }

  toggle() {
    if (this.active && this.now() - this.active.started >= DURATION_MS) this.stop();
    if (this.active) { this.stop(); return false; }
    this.active = { started: this.now(), rows: 1, requests: 0 };
    this.write({ stage: "enabled", durationMs: DURATION_MS, maxRows: MAX_ROWS, maxRequests: MAX_REQUESTS });
    return true;
  }

  stop() {
    const active = this.active;
    this.active = undefined;
    if (active) this.write({ stage: "disabled" });
  }

  write(row) {
    try { this.channel.appendLine(PREFIX + JSON.stringify(row)); } catch { /* Diagnostics never fail a request. */ }
  }

  begin(document, token) {
    const active = this.active;
    if (!active) return;
    if (this.now() - active.started >= DURATION_MS || active.requests >= MAX_REQUESTS || active.rows >= MAX_ROWS - 1) {
      this.stop(); return;
    }
    const sequence = ++active.requests, started = this.now(), version = document.version;
    const record = (stage, count) => {
      if (this.active !== active || !STAGES.has(stage)) return;
      if (this.now() - active.started >= DURATION_MS || active.rows >= MAX_ROWS - 1) { this.stop(); return; }
      active.rows++;
      const row = { sequence, stage, elapsedMs: Math.max(0, Math.round(this.now() - started)),
        cancelled: token?.isCancellationRequested === true,
        documentCurrent: !document.isClosed && document.version === version };
      if (Number.isSafeInteger(version) && version >= 0) row.documentVersion = version;
      if (Number.isSafeInteger(document.version) && document.version >= 0) row.currentVersion = document.version;
      if (Number.isSafeInteger(count) && count >= 0) row.count = count;
      this.write(row);
    };
    record("provider-enter");
    return { record };
  }

  dispose() { this.active = undefined; }
}

module.exports = { CompletionDiagnostics };

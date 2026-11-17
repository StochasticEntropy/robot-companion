"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Each Robot process owns its journal. Read complete UTF-8 records only and
// drain the last write on exit, including for runs shorter than the poll period.
function followProgress(directory, receive) {
  const listener = path.join(directory, "RobotCompanionProgress.py");
  fs.copyFileSync(path.join(__dirname, "RobotCompanionProgress.py"), listener);
  const journal = path.join(directory, "progress.jsonl");
  let offset = 0, tail = [], tailSize = 0, closed = false;
  function drain() {
    let fd;
    try { fd = fs.openSync(journal, "r"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const end = fs.fstatSync(fd).size;
      const stop = Math.min(end, offset + 128 * 1024);
      while (offset < stop) {
        const chunk = Buffer.allocUnsafe(Math.min(65536, stop - offset));
        const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
        if (!count) break;
        offset += count;
        let start = 0;
        while (start < count) {
          const newline = chunk.subarray(start, count).indexOf(10);
          const next = newline < 0 ? count : start + newline;
          const part = chunk.subarray(start, next);
          tailSize += part.length;
          if (tailSize <= 1024 * 1024) tail.push(part);
          if (newline >= 0) {
            if (tailSize <= 1024 * 1024) {
              try { receive(JSON.parse(Buffer.concat(tail, tailSize).toString("utf8"))); }
              catch { /* One broken record cannot hide the next test's result. */ }
            }
            tail = [];
            tailSize = 0;
          }
          start = next + 1;
        }
      }
      return offset < end;
    } finally { fs.closeSync(fd); }
  }
  function poll() {
    try { return drain(); }
    catch { /* Final output.xml remains authoritative if the journal is unavailable. */ }
  }
  const timer = setInterval(poll, 100);
  return { listener, async close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    while (poll()) await new Promise(resolve => setImmediate(resolve));
  } };
}

module.exports = { followProgress };

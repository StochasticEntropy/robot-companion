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
  function drain(limit = Infinity) {
    let fd;
    try { fd = fs.openSync(journal, "r"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const end = Math.min(limit, fs.fstatSync(fd).size);
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
  function poll(limit) {
    try { return drain(limit); }
    catch { /* Final output.xml remains authoritative if the journal is unavailable. */ }
  }
  let pending = 0, queue = Promise.resolve();
  const timer = setInterval(() => { if (!pending) poll(); }, 100);
  function checkpoint(advance) {
    // Capture the boundary at notification time even if an earlier restart
    // is still draining. The retired worker has finished writing its records.
    let end = 0;
    try { end = fs.statSync(journal).size; } catch { /* Worker never wrote a record. */ }
    pending++;
    queue = queue.then(async () => {
      while (poll(end)) await new Promise(resolve => setImmediate(resolve));
      await advance();
    }).finally(() => { pending--; });
    return queue;
  }
  return { listener, checkpoint, close() {
    if (!closed) {
      closed = true;
      clearInterval(timer);
      checkpoint(() => {});
    }
    return queue;
  } };
}

module.exports = { followProgress };

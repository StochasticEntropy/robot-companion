"use strict";

// The process guard's helper (see process-guard.js). Reads lines from the extension
// host on stdin:
//   +g <pid>   a started process that leads its own process group
//   +p <pid>   a started process
//   - <pid>    that process has closed
// When stdin ends (the host exited, crashed or was killed, or shut down), every
// process still registered is ended and the helper exits. On Linux a pid whose
// start time changed since registration belongs to another process and is left alone,
// as is one whose start time could not be read at registration: that process had
// already ended, so the pid may belong to another one by now.
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const GRACE_MS = 2000;
const owned = new Map();

function startTime(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return undefined; }
}

function handle(line) {
  const match = /^([+-])([gp]?) (\d+)$/.exec(line.trim());
  if (!match) return;
  const pid = Number(match[3]);
  if (match[1] === "-") owned.delete(pid);
  else owned.set(pid, { group: match[2] === "g", start: startTime(pid) });
}

function signal(pid, entry, name) {
  try { process.kill(entry.group ? -pid : pid, name); } catch { /* Already gone. */ }
}

let ending = false;
function endAll() {
  if (ending) return;
  ending = true;
  const targets = [...owned].filter(([pid, entry]) => {
    if (process.platform !== "linux") return true;
    // Never identified as the process that was started: not ours to signal.
    if (entry.start === undefined) return false;
    const now = startTime(pid);
    // The leader was replaced by an unrelated process: its old group cannot exist any more.
    return now === undefined || now === entry.start;
  });
  owned.clear();
  if (!targets.length) process.exit(0);
  if (process.platform === "win32") {
    let left = targets.length;
    for (const [pid] of targets) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => { if (--left === 0) process.exit(0); });
    }
    setTimeout(() => process.exit(0), GRACE_MS * 5).unref();
    return;
  }
  for (const [pid, entry] of targets) signal(pid, entry, "SIGTERM");
  setTimeout(() => {
    for (const [pid, entry] of targets) signal(pid, entry, "SIGKILL");
    process.exit(0);
  }, GRACE_MS);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    handle(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
  }
});
process.stdin.on("end", endAll);
process.stdin.on("close", endAll);
process.stdin.on("error", endAll);
// Detached from any terminal; only the host's pipe decides when to clean up.
for (const name of ["SIGHUP", "SIGINT"]) process.on(name, () => {});

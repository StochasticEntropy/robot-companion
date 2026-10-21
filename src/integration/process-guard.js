"use strict";

// Ends the processes Robot Companion started when its extension host ends without
// deactivating: a remote, WSL or container host whose window disconnected and whose
// reconnection grace ran out, or a local host that crashed or was killed. Graceful
// shutdown still stops everything through deactivate; this is the fallback for the
// host that never gets there.
//
// One small helper per extension host (process-guard-helper.js) runs on that host's
// own JavaScript runtime, never a configured executable, and holds a pipe from it.
// Owned processes are registered on start and released when they close. When the
// pipe closes, the helper ends what is still registered: each process group (POSIX
// sessions started detached) or process, SIGTERM then SIGKILL; on Windows the
// process tree through taskkill. It never touches a process it was not given.
const path = require("node:path");
const { spawn } = require("node:child_process");

const HELPER = path.join(__dirname, "process-guard-helper.js");

class ProcessGuard {
  constructor({ execPath = process.execPath, spawnImpl = spawn, helper = HELPER } = {}) {
    this.execPath = execPath;
    this.spawnImpl = spawnImpl;
    this.helper = helper;
    this.child = undefined;
    this.failed = false;
  }

  // `pid` of a started process; `group: true` when it leads its own process group.
  // Returns the release function to call once the process has closed.
  register(pid, { group = false } = {}) {
    if (!Number.isInteger(pid) || pid <= 0 || !this.ensure()) return () => {};
    this.write(`+${group && process.platform !== "win32" ? "g" : "p"} ${pid}\n`);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.write(`- ${pid}\n`);
    };
  }

  ensure() {
    if (this.child) return true;
    if (this.failed) return false;
    try {
      // A detached session of its own: signals sent to the host's group do not reach it.
      // ELECTRON_RUN_AS_NODE makes the desktop host's Electron binary run plain Node;
      // a remote server's Node ignores it.
      const child = this.spawnImpl(this.execPath, [this.helper], {
        stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32", windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
      child.on("error", () => { if (this.child === child) { this.child = undefined; this.failed = true; } });
      child.on("exit", () => { if (this.child === child) this.child = undefined; });
      child.stdin.on("error", () => { /* The helper ended; nothing more to register. */ });
      // Neither keeps the host alive: the host's own exit is what the helper waits for.
      child.unref();
      child.stdin.unref?.();
      this.child = child;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  write(line) {
    try { this.child?.stdin.write(line); } catch { /* The helper ended. */ }
  }

  // Graceful shutdown: the helper ends whatever is still registered, then exits.
  dispose() {
    const child = this.child;
    this.child = undefined;
    try { child?.stdin.end(); } catch { /* Already closed. */ }
  }
}

// The extension host's one guard.
const processGuard = new ProcessGuard();

module.exports = { ProcessGuard, processGuard, HELPER };

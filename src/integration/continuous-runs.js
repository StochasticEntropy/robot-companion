"use strict";

// Continuous runs of Test Explorer (VS Code's Turn on Continuous Run). No VS
// Code dependency. A ContinuousRun collects changed files; once no change has
// come for `delayMs()`, it hands the collected files to `execute` through
// `queue`, which starts one execution at a time. Changes during an execution
// are collected for one follow-up execution after it. stop() ends the
// debounce and any queued execution; `stopped` settles when stop() is called,
// and stop() resolves once the running execution (cancelled by its owner's
// token) has ended. `affects` decides which selected tests a change can reach.
const fs = require("node:fs");
const path = require("node:path");

class ContinuousRun {
  constructor({ delayMs, execute, queue = task => task(), log = () => {} }) {
    this.delayMs = delayMs;
    this.execute = execute;
    this.queue = queue;
    this.log = log;
    this.pending = new Set();
    this.isStopped = false;
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });
  }

  changed(file) {
    if (this.isStopped) return;
    this.pending.add(file);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.delayMs());
  }

  fire() {
    this.timer = undefined;
    if (this.isStopped || this.executing || !this.pending.size) return;
    const files = [...this.pending];
    this.pending.clear();
    this.executing = Promise.resolve(this.queue(() => (this.isStopped ? undefined : this.execute(files)), this))
      .catch(error => this.log(`Continuous run failed: ${error.message || error}`))
      .finally(() => {
        this.executing = undefined;
        if (this.pending.size && !this.timer) this.fire(); // Changed during the run; quiet since.
      });
  }

  stop() {
    if (!this.isStopped) {
      this.isStopped = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pending.clear();
      this.resolveStopped();
    }
    return this.executing || Promise.resolve();
  }
}

// Whether a change of `file` can affect a test in `source`: a changed test file
// affects its own tests, a changed __init__.robot the tests below its folder,
// and any other file (a resource, a Python library, a variable file) every test.
function affects(file, source) {
  const name = path.basename(file).toLowerCase();
  if (!name.endsWith(".robot")) return true;
  const resolved = path.resolve(source);
  if (name === "__init__.robot") return resolved.startsWith(path.resolve(path.dirname(file)) + path.sep);
  return samePath(file, resolved);
}

const samePath = (left, right) => {
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
};

module.exports = { ContinuousRun, affects };

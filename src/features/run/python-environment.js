"use strict";
const { bounded } = require("./environment-process");
const PYTHON_READINESS_MS = 15000;
const supportedApi = api => ["getActiveEnvironmentPath", "resolveEnvironment", "onDidChangeActiveEnvironmentPath"]
  .every(name => typeof api?.[name] === "function");
class PythonEnvironment {
  constructor(vscode, guard, changed, { readinessMs = PYTHON_READINESS_MS } = {}) {
    this.vscode = vscode; this.guard = guard; this.changed = changed; this.generation = 0; this.readinessMs = readinessMs; this.disposed = false;
  }
  reset() { this.generation++; this.subscription?.dispose(); this.subscription = undefined; this.api = undefined; }
  dispose() { this.disposed = true; this.reset(); }
  async resolve(uri, { isCurrent = () => true } = {}) {
    const generation = this.generation, deadline = Date.now() + this.readinessMs;
    const alive = () => !this.disposed && this.guard() && this.generation === generation;
    const valid = () => alive() && isCurrent();
    let exports;
    // A timeout does not stop Python's own startup. Observe that same work once;
    // never activate or query again here, and never publish a late interpreter.
    const observeLate = (name, pending) => {
      if (!pending || this.lateChangeGeneration === generation) return;
      void pending.then(async result => {
        if (!valid()) return;
        if (name === "activation" || name === "readiness") {
          const readyExports = name === "activation" ? result : exports;
          if (name === "activation" && readyExports?.ready) await readyExports.ready;
          if (!valid() || !supportedApi(readyExports?.environments)) return;
        } else if (name === "environment resolution") {
          const executable = result?.executable?.uri;
          if (executable?.scheme !== "file" || !executable.fsPath) return;
        } else if (result == null) return;
        // Let the bounded unavailable answer settle before invalidating its cache.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!valid() || this.lateChangeGeneration === generation) return;
        this.lateChangeGeneration = generation;
        this.changed();
      }).catch(() => {}); // Late failures preserve the original unavailable result.
    };
    // One budget covers cold activation, readiness and both environment API calls.
    // Retrying later is a new user/event-driven resolution, never an unbounded loop.
    const phase = async (name, operation) => {
      const remaining = deadline - Date.now();
      let pending;
      try {
        if (remaining <= 0) throw new Error("Timed out");
        pending = Promise.resolve(operation());
        return await bounded(pending, remaining);
      } catch (error) {
        if (error.message === "Timed out") observeLate(name, pending);
        const reason = error.message === "Timed out"
          ? `timed out within the ${this.readinessMs / 1000} s total readiness budget. Wait for Python to finish starting, then select the environment again or restart the language service.`
          : error.message;
        throw new Error(`Python extension ${name}: ${reason}`);
      }
    };
    try {
      if (!valid()) throw new Error("Workspace trust required");
      const extension = this.vscode.extensions.getExtension("ms-python.python");
      if (!extension) throw new Error("Python extension is not installed");
      if (!this.api) {
        if (!valid()) throw new Error("Workspace trust required");
        exports = await phase("activation", () => extension.activate());
        if (!valid()) throw new Error("Python environment changed");
        if (exports.ready) await phase("readiness", () => exports.ready);
        if (!valid()) throw new Error("Python environment changed");
        const api = exports.environments;
        if (!supportedApi(api)) throw new Error("Python extension does not expose the supported public environments/follow API");
        if (!this.api) { this.api = api; this.subscription = api.onDidChangeActiveEnvironmentPath(() => { if (alive()) this.changed(); }); }
      }
      if (!valid()) throw new Error("Python environment changed");
      const active = await phase("active environment lookup", () => this.api.getActiveEnvironmentPath(uri));
      if (!valid()) throw new Error("Python environment changed");
      const environment = await phase("environment resolution", () => this.api.resolveEnvironment(active));
      if (!valid()) throw new Error("Python environment changed");
      const executable = environment?.executable?.uri;
      if (executable?.scheme !== "file" || !executable.fsPath) throw new Error("Python extension environment has no local executable URI");
      return { executable: executable.fsPath };
    } catch (error) { return { availability: { state: "unavailable", diagnostic: error.message } }; }
  }
}
module.exports = { PythonEnvironment, PYTHON_READINESS_MS };

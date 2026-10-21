"use strict";
const { bounded } = require("./environment-process");
class PythonEnvironment {
  constructor(vscode, guard, changed) { this.vscode = vscode; this.guard = guard; this.changed = changed; this.generation = 0; }
  reset() { this.generation++; this.subscription?.dispose(); this.subscription = undefined; this.api = undefined; }
  dispose() { this.reset(); }
  async resolve(uri) {
    const generation = this.generation;
    const valid = () => this.guard() && this.generation === generation;
    try {
      if (!valid()) throw new Error("Workspace trust required");
      const extension = this.vscode.extensions.getExtension("ms-python.python");
      if (!extension) throw new Error("Python extension is not installed");
      if (!this.api) {
        if (!valid()) throw new Error("Workspace trust required");
        const exports = await bounded(extension.activate());
        if (!valid()) throw new Error("Python environment changed");
        if (exports.ready) await bounded(exports.ready);
        if (!valid()) throw new Error("Python environment changed");
        const api = exports.environments;
        if (!["getActiveEnvironmentPath", "resolveEnvironment", "onDidChangeActiveEnvironmentPath"].every(name => typeof api?.[name] === "function")) throw new Error("Python extension does not expose the supported public environments/follow API");
        if (!this.api) { this.api = api; this.subscription = api.onDidChangeActiveEnvironmentPath(() => this.changed()); }
      }
      if (!valid()) throw new Error("Python environment changed");
      const active = await bounded(Promise.resolve(this.api.getActiveEnvironmentPath(uri)));
      if (!valid()) throw new Error("Python environment changed");
      const environment = await bounded(Promise.resolve(this.api.resolveEnvironment(active)));
      if (!valid()) throw new Error("Python environment changed");
      const executable = environment?.executable?.uri;
      if (executable?.scheme !== "file" || !executable.fsPath) throw new Error("Python extension environment has no local executable URI");
      return { executable: executable.fsPath };
    } catch (error) { return { availability: { state: "unavailable", diagnostic: error.message } }; }
  }
}
module.exports = { PythonEnvironment };

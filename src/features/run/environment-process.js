"use strict";
const cp = require("child_process");
const { processGuard } = require("../../integration/process-guard");
const PYTHON_PROBE = "import sys,importlib.util,json; s=importlib.util.find_spec('robot'); r=__import__('robot') if s else None; print('ROBOT_COMPANION_ENV:'+json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'robot':getattr(r,'__version__',None),'missing':s is None}))";
function bounded(promise, ms = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), ms); })]).finally(() => clearTimeout(timer));
}
// All children are owned and settle even when a child ignores termination.
// outputLimit bounds probes; installation passes Infinity because pip output is streamed, not parsed.
// A stopped child keeps its caller's slot (probe concurrency, install exclusivity) until it has exited,
// or until releaseMs after the stop when it ignores even the forced kill sent after forceKillMs.
function execute(target, args, cwd, guard, { timeout = 2000, spawn = cp.spawn, token, onOutput, outputLimit = 65536, forceKillMs = 250, releaseMs = 2000 } = {}) {
  return new Promise(resolve => {
    let child, timer, cancelSubscription, force, release, stopped, gone = false, settled = false, bytes = 0, output = "";
    let unguard = () => {};
    const finish = result => {
      if (settled) return;
      settled = true; unguard(); clearTimeout(timer); clearTimeout(force); clearTimeout(release); cancelSubscription?.dispose();
      resolve({ ...result, output });
    };
    const exited = code => finish(stopped ? { state: stopped } : { code });
    const stop = state => {
      if (settled || stopped) return;
      stopped = state; clearTimeout(timer); cancelSubscription?.dispose();
      if (!child || gone) return finish({ state });
      child.kill();
      force = setTimeout(() => child.kill("SIGKILL"), forceKillMs);
      release = setTimeout(() => finish({ state }), releaseMs);
    };
    try {
      if (!guard() || token?.isCancellationRequested) return finish({ state: "cancelled" });
      child = spawn(target.executable, args, { cwd, shell: false, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
      // Probes and installs end with a host that goes away without stopping them.
      unguard = processGuard.register(child.pid);
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", data => {
        if (stopped) return;
        bytes += data.length;
        if (bytes > outputLimit) return stop("checkFailed");
        output += data.toString("utf8"); onOutput?.(data.toString("utf8"));
      });
      // After a stop only the child's exit or the release deadline settles it, never a failed kill.
      child.once("error", error => stopped || finish({ state: ["ENOENT", "EACCES"].includes(error.code) ? "unavailable" : "checkFailed", diagnostic: error.message }));
      // A stopped child counts as gone once it exits, even if a grandchild still holds its output pipes.
      child.once("exit", () => { gone = true; if (stopped) exited(); });
      child.once("close", exited);
      timer = setTimeout(() => stop("timedOut"), timeout);
      cancelSubscription = token?.onCancellationRequested(() => stop("cancelled"));
      if (token?.isCancellationRequested) stop("cancelled");
    } catch (error) { finish({ state: "checkFailed", diagnostic: error.message }); }
  });
}
function parseProbe(target, result) {
  if (result.state) return { state: result.state, diagnostic: result.diagnostic };
  if (target.kind === "python") {
    try {
      if (result.code !== 0) throw new Error("Python import check failed");
      const line = result.output.split(/\r?\n/).find(line => line.startsWith("ROBOT_COMPANION_ENV:"));
      const value = JSON.parse(line.slice("ROBOT_COMPANION_ENV:".length));
      if (typeof value.python !== "string" || typeof value.missing !== "boolean" || (!value.missing && typeof value.robot !== "string")) throw new Error("Unexpected Python response");
      return { state: value.missing ? "missingRobot" : "available", pythonVersion: value.python, robotVersion: value.robot };
    } catch (error) { return { state: "checkFailed", diagnostic: error.message }; }
  }
  const version = result.output.match(/Robot Framework (\d+(?:\.[\w+-]+)+)/);
  return version && [0, 251].includes(result.code) ? { state: "available", robotVersion: version[1] } : { state: "checkFailed" };
}
class ProbePool {
  constructor(guard, options = {}) { this.guard = guard; this.options = options; this.active = 0; this.queue = []; this.cache = new Map(); this.pending = new Map(); this.epoch = 0; this.cancellations = new Set(); this.running = new Set(); }
  invalidate() {
    this.epoch++; this.cache.clear(); this.pending.clear();
    for (const cancel of this.cancellations) cancel();
    for (const job of this.queue.splice(0)) job.resolve({ state: "cancelled" });
  }
  forget(target, cwd) { this.cache.delete(JSON.stringify([cwd, target.kind, target.executable, target.args])); }
  probe(target, cwd) {
    const key = JSON.stringify([cwd, target.kind, target.executable, target.args]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    if (this.pending.has(key)) return this.pending.get(key);
    // Invalidated children still exiting hold one of the two process slots, not a candidate place.
    const current = [...this.running].filter(job => job.epoch === this.epoch).length;
    if (this.queue.length + current >= 8) return Promise.resolve({ state: "checkFailed", diagnostic: "Candidate limit" });
    const epoch = this.epoch;
    const promise = new Promise(resolve => { this.queue.push({ target, cwd, key, epoch, resolve }); this.drain(); });
    this.pending.set(key, promise);
    promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    return promise;
  }
  drain() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); this.active++; this.running.add(job);
      let callback;
      const cancel = () => callback?.();
      const token = { isCancellationRequested: false, onCancellationRequested(fn) { callback = fn; return { dispose() { callback = undefined; } }; } };
      this.cancellations.add(cancel);
      const args = job.target.kind === "python" ? ["-c", PYTHON_PROBE] : [...job.target.args, "--version"];
      execute(job.target, args, job.cwd, () => this.guard() && this.epoch === job.epoch, { ...this.options, token }).then(result => {
        const value = this.epoch === job.epoch && this.guard() ? parseProbe(job.target, result) : { state: "cancelled" };
        if (!["available", "cancelled"].includes(value.state)) this.options.onFailure?.(job.target, result, value);
        if (value.state !== "cancelled") this.cache.set(job.key, { value, until: Date.now() + (value.state === "available" ? 30000 : 5000) });
        job.resolve(value);
      }).finally(() => { this.cancellations.delete(cancel); this.running.delete(job); this.active--; this.drain(); });
    }
  }
}
module.exports = { PYTHON_PROBE, bounded, execute, parseProbe, ProbePool };

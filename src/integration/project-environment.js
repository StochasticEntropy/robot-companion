"use strict";

// The project environment behind a folder's native services. The folder's
// Select Robot Environment choice (a Python interpreter, saved or followed from
// the Python extension) runs the native backend as
// `<python> -m robot_companion_backend lsp|dap|discovery`, the same interpreter
// that runs `<python> -m robot` for Run Test and Run Suite. Explicit descriptors,
// robotCompanion.nativeBackendExecutable and robotCompanion.robotCommand keep
// precedence; with no interpreter selected the project's .venv backend executable
// is the fallback. Before a native service starts, an owned bounded probe of the
// interpreter reports its Python and Robot Framework versions and the installed
// backend's version and file digest, so status and refusals name what runs.
const path = require("node:path");
const vscode = require("vscode");
const { execute } = require("../features/run/environment-process");
const { backendDescriptor, backendOrigin } = require("./preview-defaults");
const { SUPPORTED_NATIVE_VERSION, NATIVE_SERVER_NAME } = require("./native-backend");

const MODULE = "robot_companion_backend";
const PREFIX = "ROBOT_COMPANION_BACKEND:";
// Runs in the interpreter with its normal sys.path (the folder is the cwd, as for
// the services), so a module there that would shadow the installed backend is
// reported. Imports nothing from the backend or Robot Framework. The digest is
// SHA-256 over the sorted `path NUL sha256(bytes) LF` lines of the installed
// robot_companion_backend/ files (no bytecode), as listed in the wheel.
const PROBE = [
  "import sys, os, json, hashlib, importlib.util",
  "import importlib.metadata as m",
  "r = {'python': '.'.join(map(str, sys.version_info[:3])), 'executable': sys.executable, 'robot': None, 'backend': None}",
  "try: r['robot'] = m.version('robotframework')",
  "except Exception: pass",
  "try: d = m.distribution('robot-companion-backend')",
  "except Exception: d = None",
  "if d is not None:",
  "    names = sorted({str(f).replace(os.sep, '/') for f in (d.files or [])})",
  "    names = [n for n in names if n.startswith('robot_companion_backend/') and '__pycache__/' not in n and not n.endswith('.pyc')]",
  "    h = hashlib.sha256(); count = 0; missing = []",
  "    for n in names:",
  "        try:",
  "            with open(d.locate_file(n), 'rb') as f: data = f.read()",
  "        except OSError: missing.append(n); continue",
  "        h.update(n.encode('utf-8') + b'\\0' + hashlib.sha256(data).hexdigest().encode('ascii') + b'\\n'); count += 1",
  "    init = os.path.realpath(str(d.locate_file('robot_companion_backend/__init__.py')))",
  "    s = importlib.util.find_spec('robot_companion_backend')",
  "    origin = os.path.realpath(s.origin) if s is not None and s.origin else None",
  "    r['backend'] = {'version': d.version, 'sha256': h.hexdigest(), 'files': count, 'missing': missing,",
  "                    'package': os.path.dirname(init), 'shadowedBy': origin if origin != init else None}",
  `print('${PREFIX}' + json.dumps(r))`
].join("\n");

// Parses the probe's one result line; undefined for anything else.
function parseIdentity(result) {
  if (result.state || result.code !== 0) return undefined;
  const line = (result.output || "").split(/\r?\n/).find(text => text.startsWith(PREFIX));
  try {
    const value = JSON.parse(line.slice(PREFIX.length));
    return typeof value.python === "string" && typeof value.executable === "string" ? value : undefined;
  } catch { return undefined; }
}

const versions = identity => `Python ${identity.python}, Robot Framework ${identity.robot || "not installed"}`;
const digest = backend => `sha256 ${backend.sha256.slice(0, 12)}, ${backend.files} files`;

// One line naming the interpreter, its versions and the backend bytes.
function describeIdentity(identity) {
  const backend = identity.backend;
  return `${identity.executable} (${versions(identity)}); ` +
    (backend ? `${NATIVE_SERVER_NAME} ${backend.version} (${digest(backend)}) at ${backend.package}` : `no ${NATIVE_SERVER_NAME}`);
}

// Why this interpreter cannot run the supported native backend, or undefined.
function refusal(identity, interpreter) {
  const where = `${interpreter} (${versions(identity)})`;
  const backend = identity.backend;
  if (!backend) return `${NATIVE_SERVER_NAME} is not installed in ${where}.`;
  if (backend.shadowedBy) return `${backend.shadowedBy} shadows the installed ${NATIVE_SERVER_NAME} ${backend.version} of ${where}.`;
  if (backend.missing?.length || !backend.files) return `The installed ${NATIVE_SERVER_NAME} ${backend.version} of ${where} is incomplete` +
    (backend.missing?.length ? `: ${backend.missing[0]} is missing.` : ".");
  if (backend.version !== SUPPORTED_NATIVE_VERSION) {
    return `Robot Companion supports ${NATIVE_SERVER_NAME} ${SUPPORTED_NATIVE_VERSION}; ${where} has ${backend.version} (${digest(backend)}).`;
  }
  if (!identity.robot) return `Robot Framework is not installed in ${where}.`;
  return undefined;
}

class ProjectEnvironments {
  constructor(controller) {
    // RobotEnvironmentController: the accepted per-folder picker and resolver.
    this.controller = controller;
    this.emitter = new vscode.EventEmitter();
    // Fires with the folder URIs whose interpreter changed, after their services last started.
    this.onDidChange = this.emitter.event;
    this.identities = new Map();
    this.started = new Map();
    this.details = new Map();
    this.notified = new Set();
    this.queue = Promise.resolve();
    this.disposed = false;
    this.subscriptions = [controller.onDidChange(event => { void this.reconcile(event); })];
  }

  trusted() { return !this.disposed && vscode.workspace.isTrusted !== false; }

  // The interpreter this folder's choice selects ({ source, label, executable }),
  // or a reason none applies. Spawns nothing.
  async interpreter(folder) {
    if (!this.trusted()) return { source: "trustRequired" };
    return this.controller.interpreter(folder.uri);
  }

  signature(selected) {
    return JSON.stringify([selected.source, selected.executable || selected.notPython || selected.diagnostic || ""]);
  }

  // After a selection/Python-extension/install change: report the folders whose
  // services started with another interpreter. Unaffected folders keep running.
  reconcile(event = {}) {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      this.identities.clear();
      const changed = new Set();
      for (const folder of vscode.workspace.workspaceFolders || []) {
        const key = folder.uri.toString(), previous = this.started.get(key);
        if (previous === undefined) continue;
        const current = this.signature(await this.interpreter(folder));
        if (current !== previous || event.installed === key) { changed.add(key); this.started.delete(key); }
      }
      if (changed.size && !this.disposed) this.emitter.fire(changed);
    }).catch(() => { /* The next change or Restart reconciles again. */ });
    return this.queue;
  }

  // Forgets cached probes (Restart Language Service, Refresh Tests): the next start probes again.
  forget() { this.identities.clear(); }

  // Owned, bounded, trust-checked probe; one at a time per interpreter.
  identify(executable, cwd) {
    const key = JSON.stringify([executable, cwd]);
    if (!this.identities.has(key)) {
      const pending = execute({ executable }, ["-c", PROBE], cwd, () => this.trusted(), { timeout: 15000 })
        .then(result => parseIdentity(result) ? { identity: parseIdentity(result) } :
          { error: result.state === "unavailable" ? `${executable} does not exist or cannot start.` :
            result.state === "timedOut" ? `${executable} did not answer the environment check within 15 s.` :
            `${executable} failed the environment check${result.diagnostic ? `: ${result.diagnostic}` : ""}${result.output?.trim() ? `: ${result.output.trim().split(/\r?\n/).pop()}` : ""}.` });
      pending.then(value => { if (value.error && this.identities.get(key) === pending) this.identities.delete(key); });
      this.identities.set(key, pending);
    }
    return this.identities.get(key);
  }

  // The descriptor a folder's service uses and where it comes from:
  //   { input, origin, interpreter, identity, summary, full, refusal }
  // origin: "descriptor" (an explicit setting), "setting" (nativeBackendExecutable),
  // "interpreter" (the selected project interpreter) or "default" (.venv backend).
  // `refusal` names the interpreter and versions when the native default cannot run.
  async backend(folder, setting) {
    // Callers check trust first; this also holds if trust is not granted yet.
    if (!this.trusted()) throw new Error("Robot Companion native services require a trusted workspace.");
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const selected = await this.interpreter(folder);
    if (setting !== "discoveryBackend") this.started.set(folder.uri.toString(), this.signature(selected));
    const origin = backendOrigin(config, setting, selected.executable);
    const result = { origin, selected, input: backendDescriptor(config, folder, setting, process.platform, origin === "interpreter" ? selected.executable : undefined) };
    if (origin === "descriptor") {
      result.summary = `explicit robotCompanion.${setting}`;
      result.full = `explicit robotCompanion.${setting} descriptor (${result.input.id} ${result.input.version}); ` +
        "the selected Robot environment does not apply to it";
      return result;
    }
    const masked = origin !== "interpreter" && selected.executable ? `; selected ${selected.label} (${selected.executable}) is not used` : "";
    if (origin === "interpreter") {
      result.interpreter = selected.executable;
    } else if (origin === "default" && selected.source === "pythonExtension" && !selected.executable) {
      // An unavailable Python-extension interpreter never falls back to another environment.
      result.refusal = `The Python extension's interpreter for folder '${folder.name}' is unavailable: ${selected.diagnostic || "no interpreter"}.`;
      result.summary = "Python extension interpreter unavailable";
      result.full = result.refusal;
      return result;
    }
    const where = origin === "interpreter" ? `selected ${selected.label}` :
      origin === "setting" ? "robotCompanion.nativeBackendExecutable" :
      selected.notPython ? `default .venv backend (selected ${selected.label} is not a Python interpreter)` : "default .venv backend (no interpreter selected)";
    const service = Object.values(result.input.services)[0];
    if (!result.interpreter) {
      // A backend executable: its environment is identified through the backend's doctor report.
      const doctor = await this.doctor(service.executable, result.input.cwd);
      result.interpreter = doctor;
    }
    const identity = result.interpreter && await this.identify(result.interpreter, result.input.cwd);
    if (identity?.identity) {
      result.identity = identity.identity;
      result.summary = `${where}: Python ${identity.identity.python}, RF ${identity.identity.robot || "missing"}`;
      result.full = `${where}${masked}: ${describeIdentity(identity.identity)}` +
        (identity.identity.backend ? `; backend files sha256 ${identity.identity.backend.sha256}` : "");
      if (origin === "interpreter") {
        const reason = refusal(identity.identity, result.interpreter);
        if (reason) result.refusal = `${reason} Nothing was started.`;
      }
    } else {
      result.summary = `${where}: environment not identified`;
      result.full = `${where}${masked}: ${service.executable} ${service.argv.join(" ")}` +
        (identity?.error ? `; ${identity.error}` : result.interpreter ? "" : "; the backend did not report its interpreter");
      if (origin === "interpreter") result.refusal = `${identity?.error || "The selected interpreter could not be checked."} Nothing was started.`;
    }
    this.details.set(folder.uri.toString(), result.full);
    return result;
  }

  // The interpreter of a backend executable, from `robot-companion-backend doctor`.
  doctor(executable, cwd) {
    const key = JSON.stringify(["doctor", executable, cwd]);
    if (!this.identities.has(key)) {
      const pending = execute({ executable }, ["doctor"], cwd, () => this.trusted(), { timeout: 15000 }).then(result => {
        try { return result.state ? undefined : JSON.parse(result.output).executable || undefined; } catch { return undefined; }
      });
      this.identities.set(key, pending);
    }
    return this.identities.get(key);
  }

  // One notification per folder, interpreter and reason, with the way to change it.
  notify(folder, message) {
    const key = JSON.stringify([folder.uri.toString(), message]);
    if (this.notified.has(key)) return;
    this.notified.add(key);
    void vscode.window.showErrorMessage(`Robot Companion native services for folder '${folder.name}' did not start. ${message}`,
      "Select Robot Environment", "Show Status").then(choice => {
      if (choice === "Select Robot Environment") void vscode.commands.executeCommand("robotCompanion.selectRobotEnvironment");
      if (choice === "Show Status") void vscode.commands.executeCommand("robotCompanion.showLanguageServiceStatus");
    });
  }

  // The full environment line per folder, for Show Language Service Status.
  lines() {
    return (vscode.workspace.workspaceFolders || []).filter(folder => this.details.has(folder.uri.toString()))
      .map(folder => `[${folder.name}] Environment — ${this.details.get(folder.uri.toString())}`);
  }

  dispose() {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.emitter.dispose();
  }
}

module.exports = { ProjectEnvironments, PROBE, MODULE, parseIdentity, describeIdentity, refusal };

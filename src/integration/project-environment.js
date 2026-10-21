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
// The installed backend must be the exact build bundled with this extension
// (bundled-backend/manifest.json); an absent, other-version, incomplete or
// different-bytes backend is refused with Install Backend or Update Backend
// (backend-installer.js), which adds the bundled build after the user confirms.
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { execute } = require("../features/run/environment-process");
const { backendDescriptor, backendOrigin } = require("./preview-defaults");
const { SUPPORTED_NATIVE_VERSION, NATIVE_SERVER_NAME } = require("./native-backend");
const { resolveExecutable } = require("./backend-contract");

const MODULE = "robot_companion_backend";
const PREFIX = "ROBOT_COMPANION_BACKEND:";
const BUNDLE = path.resolve(__dirname, "../../bundled-backend");

// The backend build shipped in the extension: its wheels, pinned digests and supported rows.
let bundle;
function bundledBackend() {
  if (!bundle) bundle = { directory: BUNDLE, ...JSON.parse(fs.readFileSync(path.join(BUNDLE, "manifest.json"), "utf8")) };
  return bundle;
}
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
  // Shown in the install confirmation; Robot Companion never changes them.
  "for name in ('debugpy', 'robotcode'):",
  "    try: r[name] = m.version(name)",
  "    except Exception: r[name] = None",
  "r['pip'] = importlib.util.find_spec('pip') is not None",
  // Files of an interrupted debugpy install are importable without metadata.
  "r['debugpyImport'] = importlib.util.find_spec('debugpy') is not None",
  // An interrupted pip run can leave an empty .dist-info beside a later complete install:
  // the copy with version metadata is the installed one.
  "found = list(m.distributions(name='robot-companion-backend'))",
  "d = next((x for x in found if x.version), found[0] if found else None)",
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
// An interrupted install can leave files without version metadata.
const named = backend => `${NATIVE_SERVER_NAME} ${backend.version || "(without version metadata)"}`;
const digest = backend => `sha256 ${backend.sha256.slice(0, 12)}, ${backend.files} files`;

// One line naming the interpreter, its versions and the backend bytes.
function describeIdentity(identity) {
  const backend = identity.backend;
  return `${identity.executable} (${versions(identity)}); ` +
    (backend ? `${NATIVE_SERVER_NAME} ${backend.version} (${digest(backend)}) at ${backend.package}` : `no ${NATIVE_SERVER_NAME}`);
}

const rows = manifest => manifest.backend.supportedRows.map(row => `Python ${row.python} + Robot Framework ${row.robotframework}`).join(" or ");
const supportedRow = (identity, manifest) => manifest.backend.supportedRows
  .some(row => identity.python.split(".").slice(0, 2).join(".") === row.python && identity.robot === row.robotframework);

// The selected interpreter's backend against the bundled build:
//   { state, reason, action }, state "ready" | "absent" | "incomplete" | "version" | "bytes" |
//   "shadowed" | "robot" | "runtime"; action "install" | "update" when the bundled build fixes it.
// Robot Companion never installs or changes Python or Robot Framework, so an unsupported
// runtime row or a missing Robot Framework offers no action.
function assess(identity, interpreter, manifest = bundledBackend()) {
  const where = `${interpreter} (${versions(identity)})`;
  const backend = identity.backend, expected = manifest.backend.installedFiles;
  const unsupported = identity.robot && !supportedRow(identity, manifest) ?
    `the bundled ${NATIVE_SERVER_NAME} ${manifest.backend.version} supports ${rows(manifest)}, and Robot Companion does not change Python or Robot Framework.` : undefined;
  const runtime = !identity.robot ? `Robot Framework is not installed in ${where}.` :
    unsupported && `${where} is not a supported runtime: ${unsupported}`;
  // A backend problem in an environment the bundled build cannot run in offers no install.
  const blocker = !identity.robot ? "The backend also needs Robot Framework, which Robot Companion does not install." :
    unsupported && `This environment is not a supported runtime: ${unsupported}`;
  const fixable = (state, reason, action) => blocker ? { state, reason: `${reason} ${blocker}` } : { state, reason, action };
  if (!backend) return fixable("absent", `${NATIVE_SERVER_NAME} is not installed in ${where}.`, "install");
  if (backend.shadowedBy) return { state: "shadowed", reason: `${backend.shadowedBy} shadows the installed ${named(backend)} of ${where}.` };
  if (backend.missing?.length || !backend.files || !backend.version) return fixable("incomplete", `The installed ${named(backend)} of ${where} is incomplete` +
    (backend.missing?.length ? `: ${backend.missing[0]} is missing.` : "."), "update");
  if (backend.version !== SUPPORTED_NATIVE_VERSION) {
    return fixable("version", `Robot Companion supports ${NATIVE_SERVER_NAME} ${SUPPORTED_NATIVE_VERSION}; ${where} has ${backend.version || "a copy without version metadata"} (${digest(backend)}).`, "update");
  }
  if (backend.sha256 !== expected.sha256 || backend.files !== expected.files) {
    return fixable("bytes", `The installed ${named(backend)} of ${where} (${digest(backend)}) differs from the build ` +
      `bundled with Robot Companion (${digest(expected)}).`, "update");
  }
  if (runtime) return { state: identity.robot ? "runtime" : "robot", reason: runtime };
  // The bundled dependency: absent, or left without metadata by an interrupted install. It does
  // not stop the services (only Python debugging in Robot runs needs it), but it is not ready.
  if (!identity.debugpy) {
    return { state: "dependency", reason: `debugpy, which Python debugging in Robot runs needs, is not installed (or has no metadata) in ${where}.`, action: "install" };
  }
  return { state: "ready" };
}

// States that start no service. "dependency" starts the services and still offers Install Backend.
const BLOCKING = state => !["ready", "dependency"].includes(state);

// Why this interpreter cannot run the supported native backend, or undefined.
function refusal(identity, interpreter) {
  const verdict = assess(identity, interpreter);
  return BLOCKING(verdict.state) ? verdict.reason : undefined;
}

// The project's own .venv interpreter beside the default .venv backend executable.
function venvPython(folder, platform = process.platform) {
  return path.join(folder.uri.fsPath, ".venv", ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
}

// The next step a refusal offers, shown after it in notifications and status.
const ACTIONS = {
  install: { button: "Install Backend", hint: "Choose Install Backend to add the backend build bundled with Robot Companion to this environment; you confirm first and nothing is downloaded." },
  update: { button: "Update Backend", hint: "Choose Update Backend to replace it with the build bundled with Robot Companion; you confirm first and nothing is downloaded." }
};

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
    // Folder URI -> "install" | "update" offered with the folder's current refusal, or "setup"
    // when no interpreter is selected yet.
    this.actions = new Map();
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
    this.actions.delete(folder.uri.toString());
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
    if (!result.interpreter && origin === "default" && !resolveExecutable(service.executable, result.input)) {
      // A fresh project: no interpreter chosen yet and no .venv backend. Selecting the project's
      // Python is the setup step; Robot Companion then offers its bundled backend there.
      const chosen = selected.notPython ? `Robot runs use ${selected.label}, which is not a Python interpreter` : "No Python interpreter is selected";
      result.refusal = `${chosen} for folder '${folder.name}', and the folder has no .venv backend. Select the project's Python interpreter ` +
        "(Robot Companion: Select Robot Environment); Robot Companion then offers to install its bundled backend in it. Nothing was started.";
      this.actions.set(folder.uri.toString(), "setup");
      result.summary = `${where}: not set up`;
      result.full = `${where}: ${service.executable} does not exist; select the project's Python interpreter`;
      this.details.set(folder.uri.toString(), result.full);
      return result;
    }
    if (!result.interpreter) {
      // A backend executable: its environment is identified through the backend's doctor report.
      // A missing executable starts nothing; requireService reports it before any start.
      const doctor = resolveExecutable(service.executable, result.input) ? await this.doctor(service.executable, result.input.cwd) : undefined;
      result.interpreter = doctor;
      // An older or broken .venv build may not answer doctor: its .venv interpreter is checked instead.
      if (!doctor && origin === "default" && fs.existsSync(venvPython(folder))) result.interpreter = venvPython(folder);
    }
    const identity = result.interpreter && await this.identify(result.interpreter, result.input.cwd);
    if (identity?.identity) {
      result.identity = identity.identity;
      result.summary = `${where}: Python ${identity.identity.python}, RF ${identity.identity.robot || "missing"}`;
      result.full = `${where}${masked}: ${describeIdentity(identity.identity)}` +
        (identity.identity.backend ? `; backend files sha256 ${identity.identity.backend.sha256}` +
          (identity.identity.backend.sha256 === bundledBackend().backend.installedFiles.sha256 ? " (the bundled build)" : " (not the bundled build)") : "");
      // The selected interpreter and the project's .venv backend must both be the bundled build.
      if (origin === "interpreter" || origin === "default") {
        const verdict = assess(identity.identity, result.interpreter);
        if (BLOCKING(verdict.state)) result.refusal = `${verdict.reason} Nothing was started.`;
        else if (verdict.reason) result.full += `. ${verdict.reason}`;
        if (verdict.action) {
          this.actions.set(folder.uri.toString(), verdict.action);
          result.full += `. ${ACTIONS[verdict.action].hint}`;
        }
      }
    } else {
      result.summary = `${where}: environment not identified`;
      result.full = `${where}${masked}: ${service.executable} ${service.argv.join(" ")}` +
        (identity?.error ? `; ${identity.error}` : result.interpreter ? "" : "; the backend did not report its interpreter");
      if (origin === "interpreter") result.refusal = `${identity?.error || "The selected interpreter could not be checked."} Nothing was started.`;
      // A .venv backend whose environment cannot be identified is not known to be the bundled build.
      else if (origin === "default") {
        result.refusal = `The project's .venv backend ${service.executable} could not be checked${identity?.error ? `: ${identity.error}` : ""}. ` +
          "Select the project's Python interpreter (Robot Companion: Select Robot Environment). Nothing was started.";
        this.actions.set(folder.uri.toString(), "setup");
      }
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

  // The selected interpreter's identity without recording a service start: for Install Backend.
  // `interpreter` is the selected one, or for the default .venv backend the interpreter it runs in.
  async inspect(folder) {
    const selected = await this.interpreter(folder);
    const config = vscode.workspace.getConfiguration("robotCompanion", folder.uri);
    const origin = backendOrigin(config, "languageBackend", selected.executable);
    this.forget();
    const interpreter = await this.target(folder, origin, selected);
    if (!interpreter) return { origin, selected };
    const probe = await this.identify(interpreter, folder.uri.fsPath);
    return { origin, selected, interpreter, signature: JSON.stringify([origin, interpreter]), ...probe };
  }

  // The interpreter Install Backend installs into for this folder, or undefined (descriptor/setting origins).
  async target(folder, origin, selected) {
    if (origin === "interpreter") return selected.executable;
    if (origin !== "default") return undefined;
    if (selected.source === "pythonExtension" && !selected.executable) return undefined;
    const input = backendDescriptor(vscode.workspace.getConfiguration("robotCompanion", folder.uri), folder, "languageBackend", process.platform);
    const service = Object.values(input.services)[0];
    const doctor = resolveExecutable(service.executable, input) ? await this.doctor(service.executable, input.cwd) : undefined;
    return doctor || (fs.existsSync(venvPython(folder)) ? venvPython(folder) : undefined);
  }

  // After Install/Update Backend: restart every folder whose services use this interpreter.
  installed(executable) {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      this.identities.clear();
      const changed = new Set();
      for (const folder of vscode.workspace.workspaceFolders || []) {
        const key = folder.uri.toString();
        if (!this.started.has(key)) continue;
        const selected = await this.interpreter(folder);
        const origin = backendOrigin(vscode.workspace.getConfiguration("robotCompanion", folder.uri), "languageBackend", selected.executable);
        if (await this.target(folder, origin, selected) === executable) { changed.add(key); this.started.delete(key); }
      }
      for (const key of changed) for (const item of [...this.notified]) if (JSON.parse(item)[0] === key) this.notified.delete(item);
      if (changed.size && !this.disposed) this.emitter.fire(changed);
    }).catch(() => { /* Restart Language Service starts them again. */ });
    return this.queue;
  }

  // One notification per folder, interpreter and reason, with the way to change it:
  // Install/Update Backend first when the bundled build fixes the refusal.
  notify(folder, message) {
    const key = JSON.stringify([folder.uri.toString(), message]);
    if (this.notified.has(key)) return;
    this.notified.add(key);
    const next = this.actions.get(folder.uri.toString()), action = ACTIONS[next];
    // Setting up (select the Python, install the backend) is a next step, not a failure.
    const show = next ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
    void show(`Robot Companion native services for folder '${folder.name}' did not start. ${message}${action ? ` ${action.hint}` : ""}`,
      ...(action ? [action.button] : []), "Select Robot Environment", "Show Status").then(choice => {
      if (action && choice === action.button) void vscode.commands.executeCommand("robotCompanion.installBackend", folder.uri);
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

module.exports = { ProjectEnvironments, PROBE, MODULE, ACTIONS, BLOCKING, parseIdentity, describeIdentity, refusal, assess, bundledBackend, venvPython };

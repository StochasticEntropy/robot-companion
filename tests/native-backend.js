"use strict";

// Test setup for the native backend provider: builds this checkout's backend/
// and installs it offline into an owned scratch venv, with pip --no-index and
// the approved local wheel directory only. Nothing is fetched. The backend's
// optional `format` extra (Robocop 9.1.0) is installed, so the backend advertises
// document formatting. The venv must not contain RobotCode; that is checked and
// recorded in a receipt. Native live cases use only this venv's
// `robot-companion-backend` executable.
//
// On Windows the venv uses its platform layout (Scripts\python.exe and
// Scripts\robot-companion-backend.exe). Set ROBOT_COMPANION_NATIVE_PYTHON to the
// absolute path of a Python 3.11 or 3.13 interpreter there, and
// ROBOT_COMPANION_ROBOT_WHEELS to the approved wheel directory.
//
//   node tests/native-backend.js --fresh   build (replacing an earlier venv), print the receipt
//   node tests/native-backend.js           reuse the venv for this backend source, or build it
//
// Without the wheel directory or a supported Python, `nativeBackend()` returns a skip reason.
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repository = path.resolve(__dirname, "..");
const backendSource = path.join(repository, "backend");
const WHEELS = process.env.ROBOT_COMPANION_ROBOT_WHEELS || "/opt/robot-wheels";
const PYTHON = process.env.ROBOT_COMPANION_NATIVE_PYTHON || defaultPython(process.platform);
// The backend's requires-python (>=3.11, not 3.12, <3.14).
const SUPPORTED_PYTHON = ["3.11", "3.13"];
const RECEIPT = "robot-companion-receipt.json";
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
// The backend's optional formatter (`robot-companion-backend[format]`), required for its formatting cases.
const EXTRAS = ["format"];
const FORMATTER = { name: "robotframework-robocop", version: "9.1.0" };

function sourceFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

// Content identity of backend/ (paths and bytes), so a changed backend source never reuses an old venv.
function backendTreeHash() {
  const hash = crypto.createHash("sha256");
  for (const file of sourceFiles(backendSource)) {
    hash.update(file).update("\0").update(fs.readFileSync(path.join(backendSource, file))).update("\0");
  }
  return hash.digest("hex");
}

function defaultPython(platform) {
  return platform === "win32" ? "python.exe" : "python3.13";
}

// The venv's interpreter and console script for a platform (passed in, so both layouts are testable anywhere).
function venvLayout(venv, platform = process.platform) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return platform === "win32"
    ? { python: join(venv, "Scripts", "python.exe"), executable: join(venv, "Scripts", "robot-companion-backend.exe") }
    : { python: join(venv, "bin", "python"), executable: join(venv, "bin", "robot-companion-backend") };
}

// A path names a file directly; a bare name is looked up on PATH. On Windows a name without an
// extension also tries PATHEXT, and quoted PATH entries are unquoted.
function which(command, platform = process.platform, env = process.env, exists = isExecutable) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const extensions = windows && !paths.extname(command)
    ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const directories = command.includes("/") || (windows && (command.includes("\\") || paths.isAbsolute(command))) ? [""]
    : (env.PATH || env.Path || "").split(windows ? ";" : ":").map(entry => windows ? entry.replace(/^"(.*)"$/, "$1") : entry)
      .filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? paths.join(directory, command + extension) : command + extension;
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

// "3.13" for the interpreter, or undefined when it does not start.
function pythonVersion(python) {
  const result = childProcess.spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
    { encoding: "utf8", env: buildEnvironment(), timeout: 60000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function unavailable() {
  if (!fs.existsSync(WHEELS)) return `approved wheel directory absent at ${WHEELS}`;
  const python = which(PYTHON);
  if (!python) return `${PYTHON} not found`;
  const version = pythonVersion(python);
  if (!SUPPORTED_PYTHON.includes(version)) {
    return `${python} is Python ${version || "(did not start)"}; the backend needs Python ${SUPPORTED_PYTHON.join(" or ")}`;
  }
  if (!fs.existsSync(path.join(backendSource, "pyproject.toml"))) return "backend/ source absent";
  return undefined;
}

// A small environment: no proxy, user site, source PYTHONPATH or pip configuration leaks into the build.
// Windows also needs its system variables, or Python and pip cannot start. There the default Windows
// locale is kept (no LANG or PYTHONUTF8), as in the owner's projects, and pip's configuration is
// switched off with Python's `nul`: pip ignores its config files only for exactly os.devnull, which
// Node spells `\\.\nul`.
function buildEnvironment(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const windows = {};
    for (const name of ["SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
      "LOCALAPPDATA", "APPDATA", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
      if (env[name]) windows[name] = env[name];
    }
    return { PATH: env.PATH || env.Path || "", HOME: env.HOME || env.USERPROFILE || os.tmpdir(), ...windows,
      PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: "nul", PIP_NO_INPUT: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1", ...(env.SOURCE_DATE_EPOCH ? { SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH } : {}) };
  }
  return { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || os.tmpdir(), LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: os.devNull, PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1", ...(env.SOURCE_DATE_EPOCH ? { SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH } : {}) };
}

function run(commands, executable, args, options = {}) {
  const started = Date.now();
  const result = childProcess.spawnSync(executable, args, { encoding: "utf8", env: buildEnvironment(), timeout: 300000,
    maxBuffer: 32 * 1024 * 1024, ...options });
  const receipt = { argv: [executable, ...args], exitCode: result.status, signal: result.signal,
    durationMs: Date.now() - started };
  commands.push(receipt);
  if (result.error || result.status !== 0) {
    throw new Error(`${[executable, ...args].join(" ")} failed (${result.error?.message || result.signal || result.status}):\n` +
      `${result.stdout || ""}${result.stderr || ""}`);
  }
  return result.stdout;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function build(venv, treeHash) {
  const commands = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-native-build-"));
  try {
    // Build from a copy, so this checkout gains no build output or bytecode.
    const source = path.join(scratch, "backend");
    for (const file of sourceFiles(backendSource)) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.copyFileSync(path.join(backendSource, file), path.join(source, file));
    }
    const dist = path.join(scratch, "dist");
    const basePython = which(PYTHON);
    run(commands, basePython, [path.join(source, "scripts", "build_dists.py"), source, dist]);
    const wheels = fs.readdirSync(dist).filter(name => name.endsWith(".whl"));
    if (wheels.length !== 1) throw new Error(`Expected one backend wheel, found ${wheels.join(", ") || "none"}.`);
    const wheel = path.join(dist, wheels[0]);
    run(commands, basePython, ["-m", "venv", venv]);
    const { python, executable } = venvLayout(venv);
    run(commands, python, ["-m", "pip", "install", "--no-index", "--find-links", WHEELS, "--no-cache-dir",
      `${wheel}[${EXTRAS.join(",")}]`]);
    const packages = JSON.parse(run(commands, python, ["-m", "pip", "list", "--format", "json"]));
    const formatter = packages.find(item => item.name.toLowerCase() === FORMATTER.name);
    if (formatter?.version !== FORMATTER.version) {
      throw new Error(`The native backend venv must contain ${FORMATTER.name} ${FORMATTER.version}: ${JSON.stringify(formatter)}.`);
    }
    const robotCode = packages.filter(item => /^robotcode/i.test(item.name));
    if (robotCode.length) throw new Error(`The native backend venv must not contain RobotCode: ${JSON.stringify(robotCode)}.`);
    const doctor = JSON.parse(run(commands, executable, ["doctor"]));
    if (doctor.robotcodePresent !== false) throw new Error("robot-companion-backend doctor reports RobotCode in the venv.");
    const receipt = {
      purpose: "Native backend provider for Robot Companion tests (offline build/install from this checkout's backend/)",
      createdAt: new Date().toISOString(), venv, executable, python, backendTreeSha256: treeHash,
      wheel: { name: wheels[0], sha256: sha256(wheel) }, extras: EXTRAS, formatter: `${formatter.name}==${formatter.version}`,
      platform: process.platform, basePython, pythonVersion: pythonVersion(python), wheelDirectory: WHEELS, fetched: false,
      packages: packages.map(item => `${item.name}==${item.version}`).sort(),
      robotCodeInVenv: false, doctor, commands
    };
    fs.writeFileSync(path.join(venv, RECEIPT), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function readReceipt(venv, treeHash) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(venv, RECEIPT), "utf8"));
    if (receipt.backendTreeSha256 !== treeHash || !fs.existsSync(receipt.executable) ||
        JSON.stringify(receipt.extras) !== JSON.stringify(EXTRAS)) return undefined;
    // Re-check on reuse: still no RobotCode in the venv.
    const result = childProcess.spawnSync(receipt.executable, ["doctor"], { encoding: "utf8", env: buildEnvironment(), timeout: 60000 });
    if (result.status !== 0 || JSON.parse(result.stdout).robotcodePresent !== false) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The venv for this backend source, built once and shared by concurrent test files.
function nativeBackend({ fresh = false } = {}) {
  const reason = unavailable();
  if (reason) return { skip: `native backend unavailable: ${reason}` };
  const treeHash = backendTreeHash();
  const venv = path.join(os.tmpdir(), `robot-companion-native-${treeHash.slice(0, 16)}`);
  const lock = `${venv}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (!fresh) {
      const receipt = readReceipt(venv, treeHash);
      if (receipt) return { receipt, executable: receipt.executable, venv };
    }
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the native backend build lock ${lock}.`);
      fresh = false; // Another process is building this source: use its venv.
      sleepSync(500);
    }
  }
  try {
    if (!fresh) {
      const receipt = readReceipt(venv, treeHash);
      if (receipt) return { receipt, executable: receipt.executable, venv };
    }
    fs.rmSync(venv, { recursive: true, force: true });
    const receipt = build(venv, treeHash);
    return { receipt, executable: receipt.executable, venv };
  } catch (error) {
    fs.rmSync(venv, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// A further real project environment for the selected-interpreter checks, standing
// in for an existing project environment: `python -m venv` plus, offline from
// `wheels`, Robot Framework, `packages` (for example RobotCode) and a synthetic
// project library module `acme_project_lib` installed into the environment (not the
// workspace), then (unless backend is false) this checkout's backend wheel added.
// Cached per backend source, interpreter and contents; a receipt records the install.
const PROJECT_LIBRARY = [
  "\"\"\"Synthetic project library installed in the project's own environment.\"\"\"",
  "import sys", "", "",
  "def acme_project_keyword():",
  "    \"\"\"Returns the interpreter that imported this project library.\"\"\"",
  "    return sys.executable", ""
].join("\n");
// `libraries` adds further synthetic modules ({ name: source }) installed only in this environment.
function projectEnvironment({ python, wheels, backend = true, packages = [], libraries = {} }) {
  if (!which(python)) return { skip: `${python} not found` };
  if (!fs.existsSync(wheels)) return { skip: `wheel directory absent at ${wheels}` };
  const treeHash = backendTreeHash();
  const key = crypto.createHash("sha256").update(JSON.stringify([treeHash, which(python), wheels, backend, packages, PROJECT_LIBRARY, libraries])).digest("hex").slice(0, 16);
  const venv = path.join(os.tmpdir(), `robot-companion-env-${key}`);
  const receiptFile = path.join(venv, RECEIPT);
  if (fs.existsSync(receiptFile)) return { venv, python: venvLayout(venv).python, receipt: JSON.parse(fs.readFileSync(receiptFile, "utf8")) };
  const commands = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "robot-companion-env-build-"));
  try {
    fs.rmSync(venv, { recursive: true, force: true });
    run(commands, which(python), ["-m", "venv", venv]);
    const venvPython = venvLayout(venv).python;
    run(commands, venvPython, ["-m", "pip", "install", "--no-index", "--find-links", wheels, "--no-cache-dir", "robotframework", ...packages]);
    const purelib = run(commands, venvPython, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"]).trim();
    fs.mkdirSync(path.join(purelib, "acme_project_lib"), { recursive: true });
    fs.writeFileSync(path.join(purelib, "acme_project_lib", "__init__.py"), PROJECT_LIBRARY);
    for (const [name, source] of Object.entries(libraries)) fs.writeFileSync(path.join(purelib, `${name}.py`), source);
    const install = [];
    if (backend) {
      const source = path.join(scratch, "backend");
      for (const file of sourceFiles(backendSource)) {
        fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        fs.copyFileSync(path.join(backendSource, file), path.join(source, file));
      }
      run(commands, which(python), [path.join(source, "scripts", "build_dists.py"), source, path.join(scratch, "dist")]);
      const wheel = fs.readdirSync(path.join(scratch, "dist")).find(name => name.endsWith(".whl"));
      install.push(path.join(scratch, "dist", wheel));
    }
    // Only the backend is added to the existing environment; nothing it already has is reinstalled.
    if (install.length) run(commands, venvPython, ["-m", "pip", "install", "--no-index", "--find-links", wheels, "--no-cache-dir", ...install]);
    const installed = JSON.parse(run(commands, venvPython, ["-m", "pip", "list", "--format", "json"]));
    const receipt = { purpose: "Selected-interpreter project environment for Robot Companion checks", createdAt: new Date().toISOString(),
      venv, python: venvPython, backendTreeSha256: treeHash, backend, extraPackages: packages, projectLibrary: "acme_project_lib", extraLibraries: Object.keys(libraries),
      wheelDirectory: wheels, fetched: false,
      packages: installed.map(item => `${item.name}==${item.version}`).sort(), commands };
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    return { venv, python: venvPython, receipt };
  } catch (error) {
    fs.rmSync(venv, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { nativeBackend, projectEnvironment, backendTreeHash, venvLayout, which, buildEnvironment, defaultPython, WHEELS };

if (require.main === module) {
  const result = nativeBackend({ fresh: process.argv.includes("--fresh") });
  if (result.skip) {
    console.log(`SKIPPED: ${result.skip}`);
  } else {
    console.log(JSON.stringify(result.receipt, null, 2));
    if (process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.ROBOT_COMPANION_UI_EVIDENCE_DIR, "native-backend-venv.json"),
        JSON.stringify(result.receipt, null, 2));
    }
  }
}

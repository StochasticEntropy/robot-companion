"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Writable } = require("node:stream");

const VSCODE_VERSION = "1.141.0";
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FIXTURE = [
  "*** Test Cases ***", "Windows Documentation Smoke",
  "    #> ## Windows UI source click",
  "    #> - Click this documented source sentence.",
  "    #> - Another documented source sentence.",
  "    Log    ready", ""
].join("\r\n");

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--source", "--evidence", "--source-sha", "--request-id", "--powershell-executable", "--host-metadata"].includes(key)
      || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Invalid argument: ${key}`);
    if (result[key]) throw new Error(`Repeated argument: ${key}`);
    result[key] = argv[i + 1];
  }
  for (const key of ["--source", "--evidence", "--source-sha", "--request-id", "--powershell-executable", "--host-metadata"]) {
    if (!result[key]) throw new Error(`Missing ${key}`);
  }
  assert.match(result["--source-sha"], /^[0-9a-f]{40}$/);
  assert.match(result["--request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return result;
}

// Whitelist ordinary runtime variables. Product processes receive no GitHub
// runner command-file paths, credentials, tokens, proxy secrets or user sites.
function productEnvironment(environment) {
  const allowed = new Set([
    "path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp",
    "userprofile", "homedrive", "homepath", "localappdata", "appdata", "programdata",
    "programfiles", "programfiles(x86)", "commonprogramfiles", "commonprogramfiles(x86)",
    "processor_architecture", "processor_identifier", "number_of_processors", "os", "lang", "lc_all"
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toLowerCase())));
}

function inspectionEnvironment(environment, executable, scratch) {
  return { ...environment,
    PSModulePath: [path.join(path.dirname(executable), "Modules"),
      path.join(environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "Modules")].join(path.delimiter),
    PSModuleAnalysisCachePath: path.join(scratch, "powershell-module-cache"),
    POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off"
  };
}

function powershell(script, environment, executable, diagnostics) {
  const started = Date.now();
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", env: environment, timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  });
  diagnostics.push({ executable, operation: "owned-process-snapshot", durationMs: Date.now() - started,
    exitCode: result.status, signal: result.signal, error: result.error?.message,
    stderr: String(result.stderr || "").slice(0, 2048) });
  if (result.error || result.status !== 0) throw new Error(`Windows process inspection failed: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

function processes(environment, executable, diagnostics) {
  const result = powershell("@(Get-CimInstance Win32_Process | ForEach-Object { "
    + "$created = if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''}; "
    + "[pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; name=$_.Name; "
    + "created=$created; command=$_.CommandLine} }) "
    + "| ConvertTo-Json -Compress -Depth 3", environment, executable, diagnostics);
  return Array.isArray(result) ? result : [result];
}

function ownedProcesses(snapshot, marker, known) {
  const owned = new Map();
  for (const item of snapshot) {
    const previous = known.get(item.pid);
    if (String(item.command || "").includes(marker)
      || (previous && item.created && previous.created === item.created)) owned.set(item.pid, item);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const item of snapshot) if (!owned.has(item.pid) && owned.has(item.parent)) {
      owned.set(item.pid, item); changed = true;
    }
  }
  for (const item of owned.values()) known.set(item.pid, item);
  return [...owned.values()];
}

async function main(argv) {
  const args = options(argv);
  const source = path.resolve(args["--source"]);
  const evidence = path.resolve(args["--evidence"]);
  const relativeEvidence = path.relative(source, evidence);
  if (!relativeEvidence || (!relativeEvidence.startsWith(`..${path.sep}`)
    && relativeEvidence !== ".." && !path.isAbsolute(relativeEvidence))) {
    throw new Error("Evidence must be outside the product checkout.");
  }
  fs.mkdirSync(evidence, { recursive: true });
  const receipt = {
    version: 1, kind: "windows-companion-documentation-ui-smoke",
    request_id: args["--request-id"], source_sha: args["--source-sha"],
    platform: process.platform, architecture: process.arch, executed: false,
    infrastructureReady: false, status: "failed", tests: { tests: 0, passed: 0, failed: 0, skipped: 0 },
    runtime: { vscode: VSCODE_VERSION, node: process.versions.node },
    claims: { documentationSourceClick: false, keywordNavigation: false, nativeBackend: false,
      fullWindowsQualification: false }, cleanup: { checked: false }, processInspection: []
  };
  const environment = productEnvironment(process.env);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "companion-windows-ui-"));
  const workspace = path.join(scratch, "workspace with spaces");
  const profile = path.join(scratch, "profile");
  const known = new Map();
  let monitor, logFd, monitorError, inspectionEnv, powershellExecutable;
  let testHostInvoked = false;
  const inspect = () => {
    const owned = ownedProcesses(processes(inspectionEnv, powershellExecutable, receipt.processInspection), profile, known);
    if (owned.length) receipt.executed = true;
    return owned;
  };
  try {
    assert.equal(process.platform, "win32", "this smoke requires a real Windows runner");
    assert.equal(process.arch, "x64", "the bootstrap qualifies Windows x64 only");
    const git = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", env: environment, windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    assert.equal(git.stdout.trim(), args["--source-sha"], "source checkout matches its immutable input");
    // The workflow already runs in PowerShell 7. Reuse that exact executable
    // and its host metadata, instead of cold-starting Windows PowerShell 5.1.
    powershellExecutable = fs.realpathSync(args["--powershell-executable"]);
    assert(path.isAbsolute(powershellExecutable) && path.basename(powershellExecutable).toLowerCase() === "pwsh.exe",
      "process inspection requires the workflow's explicit PowerShell 7 executable");
    receipt.host = JSON.parse(fs.readFileSync(args["--host-metadata"], "utf8").replace(/^\uFEFF/, ""));
    assert.equal(receipt.host.system, "Windows");
    assert(Number(receipt.host.powershellMajor) >= 7, "the workflow host must use PowerShell 7");
    assert.equal(fs.realpathSync(receipt.host.powershellExecutable), powershellExecutable);
    inspectionEnv = inspectionEnvironment(environment, powershellExecutable, scratch);
    const preflight = processes(inspectionEnv, powershellExecutable, receipt.processInspection);
    assert(preflight.length > 0, "PowerShell 7 process inspection must work before launching VS Code");
    receipt.processInspectionPreflight = { passed: true, processes: preflight.length };
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(profile, "User"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "documentation-smoke.robot"), FIXTURE);
    fs.writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify({
      "workbench.startupEditor": "none", "window.restoreWindows": "none",
      "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false, "security.workspace.trust.enabled": false,
      "robotCompanion.enableRunCodeLens": false, "robotCompanion.enableOpenFilePrewarm": false,
      "robotCompanion.integrationMode": "coexistence"
    }));
    const testElectron = require(path.join(source, "node_modules", "@vscode", "test-electron"));
    // Fixed official release only, no latest/stable fallback or Actions cache.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    const executable = await testElectron.downloadAndUnzipVSCode({
      version: VSCODE_VERSION, platform: "win32-x64-archive", cachePath: path.join(scratch, "vscode"), timeout: 60000
    });
    const productFile = path.join(path.dirname(executable), "resources", "app", "product.json");
    if (fs.existsSync(productFile)) {
      const product = JSON.parse(fs.readFileSync(productFile, "utf8"));
      receipt.runtime.vscodeCommit = product.commit;
      receipt.runtime.productSha256 = crypto.createHash("sha256").update(fs.readFileSync(productFile)).digest("hex");
    }
    logFd = fs.openSync(path.join(evidence, "vscode.log"), "w");
    let written = 0;
    const sink = new Writable({ write(chunk, encoding, done) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (written < MAX_LOG_BYTES) written += fs.writeSync(logFd, buffer.subarray(0, MAX_LOG_BYTES - written));
      done();
    } });
    monitor = setInterval(() => { try { inspect(); } catch (error) { monitorError = error.message; } }, 2000);
    testHostInvoked = true;
    receipt.testHostExitCode = await testElectron.runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: source,
      extensionTestsPath: path.join(__dirname, "ui", "index.cjs"), stdout: sink, stderr: sink,
      launchArgs: [workspace, "--new-window", "--skip-welcome", "--skip-release-notes",
        `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, "extensions")}`,
        "--remote-debugging-port=0", "--force-device-scale-factor=1", "--disable-gpu"],
      extensionTestsEnv: { ROBOT_COMPANION_UI_USER_DATA_DIR: profile,
        WINDOWS_UI_SOURCE: source, WINDOWS_UI_EVIDENCE: evidence }
    });
    receipt.tests = JSON.parse(fs.readFileSync(path.join(evidence, "mocha.json"), "utf8"));
    const proof = JSON.parse(fs.readFileSync(path.join(evidence, "ui-proof.json"), "utf8"));
    receipt.executed = true;
    assert.deepEqual(receipt.tests, { tests: 1, passed: 1, failed: 0, skipped: 0 });
    assert.equal(proof.outcome, "passed");
    receipt.claims.documentationSourceClick = true;
    receipt.selected = proof.selected;
    receipt.infrastructureReady = true;
    receipt.status = "passed";
  } catch (error) {
    receipt.error = { name: error.name, message: error.message, stack: error.stack };
    for (const [filename, key] of [["mocha.json", "tests"], ["ui-proof.json", "uiProof"]]) {
      try {
        receipt[key] = JSON.parse(fs.readFileSync(path.join(evidence, filename), "utf8"));
        if (filename === "ui-proof.json") receipt.executed = true;
      } catch { /* Not reached. */ }
    }
  } finally {
    clearInterval(monitor);
    if (logFd !== undefined) fs.closeSync(logFd);
    if (process.platform === "win32" && testHostInvoked) {
      try {
        let remaining = inspect();
        for (let i = 0; remaining.length && i < 10; i++) { await sleep(1000); remaining = inspect(); }
        receipt.cleanup = { checked: true, observedOwnedProcesses: known.size, remainingBeforeForcedCleanup: remaining };
        if (remaining.length) {
          receipt.status = "failed";
          for (const item of remaining) {
            // Recheck creation time immediately before terminating an owned
            // process; a reused PID or unrelated existing VS Code is untouched.
            const current = processes(inspectionEnv, powershellExecutable, receipt.processInspection)
              .find(candidate => candidate.pid === item.pid && candidate.created === item.created);
            if (current) spawnSync("taskkill.exe", ["/PID", String(item.pid), "/T", "/F"], {
              env: environment, encoding: "utf8", windowsHide: true, timeout: 15000
            });
          }
          receipt.cleanup.remainingAfterForcedCleanup = inspect();
        }
        if (monitorError || !known.size) {
          receipt.status = "failed";
          receipt.cleanup.error = monitorError || "No owned VS Code process observed; cleanup proof would be vacuous.";
        }
      } catch (error) { receipt.status = "failed"; receipt.cleanup.error = error.message; }
    } else {
      receipt.cleanup = { checked: false, notApplicable: true, reason: "VS Code was never started." };
    }
    try { fs.rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { receipt.status = "failed"; receipt.cleanup.scratchRemovalError = error.message; }
    fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(receipt, null, 2));
  }
  console.log(JSON.stringify({ status: receipt.status, executed: receipt.executed,
    infrastructureReady: receipt.infrastructureReady, tests: receipt.tests }));
  return receipt.status === "passed" ? 0 : 1;
}

module.exports = { options, productEnvironment, inspectionEnvironment, ownedProcesses, FIXTURE };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });

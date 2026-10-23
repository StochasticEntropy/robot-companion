"use strict";

// The folder's robot.toml settings as Robot arguments for Run Test, Test Explorer Run and the
// debugger. The installed native backend reads them (`robot-companion-backend project-config
// <folder>`): the same reading its language and discovery services apply in-process, so all
// of them see the same options. Robot Companion parses no TOML itself. Callers check trust
// first; without owned mode or a native backend nothing starts and the reason is returned.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { backendDescriptor, backendOrigin } = require("./preview-defaults");
const { resolveExecutable } = require("./backend-contract");
const native = require("./native-backend");

// RobotCode's order: pyproject.toml ([tool.robot]), robot.toml, .robot.toml; a later file wins.
const CONFIGURATION_FILES = Object.freeze(["pyproject.toml", "robot.toml", ".robot.toml"]);
const TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const EMPTY = Object.freeze({ arguments: Object.freeze([]), files: Object.freeze([]), problems: Object.freeze([]) });

const isConfigurationFile = (filePath, folderPath) =>
  CONFIGURATION_FILES.includes(path.basename(filePath)) && path.dirname(filePath) === folderPath;

// The configuration files present in the folder, with what identifies their content.
function presentFiles(folderPath) {
  const found = [];
  for (const name of CONFIGURATION_FILES) {
    const file = path.join(folderPath, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      // A pyproject.toml configures Robot only with a [tool.robot] table.
      if (name === "pyproject.toml" && !/tool\s*\.\s*robot\b|tool\s*=\s*\{[^}]*\brobot\b/.test(fs.readFileSync(file, "utf8"))) continue;
      found.push([name, stat.size, stat.mtimeMs]);
    } catch { /* Absent or unreadable: the backend reports what it cannot read. */ }
  }
  return found;
}

// The folder's native backend executable: the native language or execution descriptor,
// else the default native executable when both name another provider.
function nativeService(config, folder, selected, interpreter) {
  if (selected) {
    if (!native.isNative(selected)) return undefined;
    const service = Object.values(selected.services)[0];
    return { executable: service.executable, argv: service.argv || [], cwd: selected.cwd, env: selected.env || {} };
  }
  for (const setting of ["languageBackend", "executionBackend"]) {
    const descriptor = backendDescriptor(config, folder, setting);
    if (!native.isNative(descriptor)) continue;
    const service = Object.values(descriptor.services)[0];
    if (interpreter && backendOrigin(config, setting) === "default") {
      return { executable: interpreter, argv: ["-m", "robot_companion_backend"], cwd: descriptor.cwd, env: descriptor.env || {} };
    }
    return { executable: service.executable, argv: service.argv || [], cwd: descriptor.cwd, env: descriptor.env || {} };
  }
  return undefined;
}

function validReport(report) {
  const strings = value => Array.isArray(value) && value.every(item => typeof item === "string" && !item.includes("\0"));
  if (!report || report.version !== 1 || !strings(report.arguments) || !strings(report.files) ||
      !Array.isArray(report.problems)) {
    throw new Error("the native backend returned an invalid project-config reply");
  }
  return Object.freeze({
    arguments: Object.freeze([...report.arguments]), files: Object.freeze([...report.files]),
    problems: Object.freeze(report.problems.map(problem => Object.freeze({
      path: String(problem?.path ?? ""), line: Number(problem?.line) || 0, message: String(problem?.message ?? "")
    })))
  });
}

class ProjectFiles {
  constructor() {
    this.cache = new Map();
  }

  // { arguments, files, problems } of the folder's robot.toml settings, or with `unavailable`
  // (and no arguments) when they cannot be read here.
  async read(folder, config, { owned, backend, interpreter, environments }) {
    const folderPath = folder.uri.fsPath;
    const present = presentFiles(folderPath);
    if (!present.length) return EMPTY;
    const unavailable = reason => Object.freeze({ ...EMPTY, files: Object.freeze(present.map(([name]) => path.join(folderPath, name))),
      unavailable: reason });
    if (!owned) return unavailable("coexistence mode starts no Robot Companion backend to read it");
    let service;
    try {
      if (environments) {
        // Use the same current assessment as the native language/debug services.
        // A refused selected/default build is never started merely to read TOML.
        for (const setting of ["languageBackend", "executionBackend"]) {
          const selected = await environments.backend(folder, setting);
          if (!native.isNative(selected.input)) continue;
          if (selected.refusal) return unavailable(selected.refusal);
          service = nativeService(config, folder, selected.input);
          break;
        }
      } else service = nativeService(config, folder, backend, interpreter);
    } catch (error) { return unavailable(error.message); }
    if (!service) return unavailable("no native backend is configured for this folder");
    const executable = resolveExecutable(service.executable, service);
    if (!executable) return unavailable(`the native backend executable ${service.executable} does not exist`);
    const leading = service.argv?.[0] === "-m" && service.argv?.[1] === "robot_companion_backend" ? service.argv.slice(0, 2) : [];
    const key = JSON.stringify([executable, leading, service.cwd, service.env, present]);
    const cached = this.cache.get(folderPath);
    if (cached?.key === key) return cached.value;
    let value;
    try {
      const stdout = await new Promise((resolve, reject) => {
        childProcess.execFile(executable, [...leading, "project-config", folderPath], {
          cwd: service.cwd, env: { ...process.env, ...service.env }, shell: false, windowsHide: true,
          timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8"
        }, (error, output, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(output));
      });
      value = validReport(JSON.parse(stdout));
    } catch (error) {
      return unavailable(`the native backend could not read it (${error.message})`);
    }
    this.cache.set(folderPath, { key, value });
    return value;
  }
}

// Transcript lines naming what a run applies from robot.toml.
function describeProjectFiles(result) {
  const names = files => files.map(file => path.basename(file)).join(", ");
  if (result.unavailable) return [`robot.toml settings (${names(result.files)}) not applied: ${result.unavailable}.`];
  const lines = result.files.length ? [`robot.toml settings from ${names(result.files)}: ${result.arguments.join(" ") || "none applied"}`] : [];
  return lines.concat(result.problems.map(problem =>
    `robot.toml problem: ${path.basename(problem.path)}:${problem.line + 1}: ${problem.message}`));
}

module.exports = { CONFIGURATION_FILES, ProjectFiles, describeProjectFiles, isConfigurationFile };

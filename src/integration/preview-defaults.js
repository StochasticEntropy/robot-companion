"use strict";

// Preview defaults: native services share the project's environment. The
// folder's selected Python interpreter runs `python -m robot_companion_backend`;
// without one, the project's installed .venv backend executable. Explicit
// contract descriptors remain the advanced provider override and
// robotCompanion.nativeBackendExecutable the explicit backend executable.
// Callers read this only after checking workspace trust and owned mode.
const path = require("node:path");
const { nativeDescriptor } = require("./native-backend");

const MODULE_ARGV = Object.freeze(["-m", "robot_companion_backend"]);

// Where a folder's service descriptor comes from, in precedence order.
function backendOrigin(config, setting, interpreter) {
  if (config.get(setting)) return "descriptor";
  if (config.get("nativeBackendExecutable", "")) return "setting";
  return interpreter ? "interpreter" : "default";
}

function backendDescriptor(config, folder, setting, platform = process.platform, interpreter) {
  const explicit = config.get(setting);
  if (explicit) return explicit;
  const configured = config.get("nativeBackendExecutable", "");
  if (typeof configured !== "string" || configured.includes("\0")) {
    throw new Error("robotCompanion.nativeBackendExecutable must be an executable path.");
  }
  const services = setting === "languageBackend" ? ["language"] : ["debug", "discovery", "interactive"];
  const base = { workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, services };
  if (!configured && interpreter) return nativeDescriptor({ ...base, executable: interpreter, argvPrefix: MODULE_ARGV });
  const executable = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(folder.uri.fsPath, configured))
    : path.join(folder.uri.fsPath, ".venv", platform === "win32" ? "Scripts" : "bin",
      platform === "win32" ? "robot-companion-backend.exe" : "robot-companion-backend");
  return nativeDescriptor({ ...base, executable });
}

module.exports = { backendDescriptor, backendOrigin, MODULE_ARGV };

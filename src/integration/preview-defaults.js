"use strict";

// Preview defaults: native services share the project's installed backend.
// Explicit contract descriptors remain the advanced provider override. Callers
// read this only after checking workspace trust and owned mode.
const path = require("node:path");
const { nativeDescriptor } = require("./native-backend");

function backendDescriptor(config, folder, setting, platform = process.platform) {
  const explicit = config.get(setting);
  if (explicit) return explicit;
  const configured = config.get("nativeBackendExecutable", "");
  if (typeof configured !== "string" || configured.includes("\0")) {
    throw new Error("robotCompanion.nativeBackendExecutable must be an executable path.");
  }
  const executable = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(folder.uri.fsPath, configured))
    : path.join(folder.uri.fsPath, ".venv", platform === "win32" ? "Scripts" : "bin",
      platform === "win32" ? "robot-companion-backend.exe" : "robot-companion-backend");
  return nativeDescriptor({
    workspaceUri: folder.uri.toString(), cwd: folder.uri.fsPath, executable,
    services: setting === "languageBackend" ? ["language"] : ["debug", "discovery"]
  });
}

module.exports = { backendDescriptor };

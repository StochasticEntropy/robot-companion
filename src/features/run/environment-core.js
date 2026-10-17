"use strict";
const path = require("path");
const { parseRobotCommand } = require("./runner-core");
const STATE_KEY = "robotCompanion.environments.v1";
function settingScope(inspected = {}) {
  for (const [field, label] of [["workspaceFolderValue", "Workspace Folder"], ["workspaceValue", "Workspace"], ["globalValue", "User"]]) {
    if (inspected[field] !== undefined) return label;
  }
}
function selectionTarget(selection) {
  if (!selection || selection.version !== 1) return undefined;
  const label = selection.label || (selection.path && path.basename(path.dirname(selection.path))) || "Custom";
  if (selection.kind === "pythonExtension") return { source: "pythonExtension", kind: "python", label: "Python extension", args: ["-m", "robot"] };
  if (selection.kind === "pathRobot") return { source: "pathRobot", kind: "executable", label: "PATH", executable: "robot", args: [] };
  if (["python", "executable"].includes(selection.kind) && typeof selection.path === "string") {
    return { source: "saved", kind: selection.kind, label, executable: selection.path, args: selection.kind === "python" ? ["-m", "robot"] : [] };
  }
}
function effectiveTarget(config, selection) {
  const scope = settingScope(config.inspect("robotCommand"));
  if (scope) return { ...parseRobotCommand(config.get("robotCommand")), source: "setting", kind: "executable", label: "Setting", settingScope: scope, maskedSelection: selectionTarget(selection) };
  return selectionTarget(selection) || { source: "default", kind: "executable", label: "PATH", executable: "robot", args: [] };
}
function interpreterPath(root, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.join(root, ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
}
function pathError(value, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!value || !paths.isAbsolute(value) || value.includes("\0")) return "Enter an absolute executable path without arguments or surrounding quotes.";
  if (platform === "win32" && /\.(cmd|bat)$/i.test(value)) return "Choose a Python interpreter or native executable (.exe); .cmd/.bat require a shell and are unsupported.";
}
function identity(target) { return JSON.stringify([target.source, target.kind, target.executable, target.args]); }
function availabilityText(a = { state: "checking" }) {
  if (a.state === "available") return `${a.pythonVersion ? `Python ${a.pythonVersion} · ` : ""}Robot Framework ${a.robotVersion}`;
  return { checking: "Checking Robot Framework…", missingRobot: "Robot Framework not installed", unavailable: "Unavailable — executable not found or cannot start", checkFailed: "Could not check Robot Framework", timedOut: "Check timed out", trustRequired: "Trust required" }[a.state] || "Unavailable";
}
module.exports = { STATE_KEY, settingScope, selectionTarget, effectiveTarget, interpreterPath, pathError, identity, availabilityText };

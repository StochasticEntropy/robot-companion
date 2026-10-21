"use strict";

// Which provider a contract-v1 descriptor selects: the native backend, the
// pinned RobotCode bridge, or another contract-v1 backend. Provider-specific
// checks run here before any process starts; workspaces, providers and UI see
// only the normalized result (label, version, debug bridge).
const robotCode = require("./robotcode-bridge");
const native = require("./native-backend");

function providerOf(descriptor) {
  if (native.isNative(descriptor)) return Object.freeze({ kind: "native", label: "Native backend", version: descriptor.version });
  if (robotCode.isRobotCode(descriptor)) return Object.freeze({ kind: "robotcode", label: "RobotCode", version: descriptor.version });
  return Object.freeze({ kind: "custom", label: descriptor.id, version: descriptor.version });
}

const describe = descriptor => `${providerOf(descriptor).label} ${descriptor.version}`;

// Declared version pins; the caller refuses the selection before starting anything.
function checkVersion(descriptor) {
  native.checkVersion(descriptor);
  robotCode.checkVersion(descriptor);
}

// After initialize: the running server must be the provider the descriptor declares.
function verifyLanguageServer(descriptor, serverInfo) {
  native.verifyLanguageServer(descriptor, serverInfo);
  robotCode.verifyLanguageServer(descriptor, serverInfo);
}

// Whether the provider's language and discovery services take the folder's
// project Robot configuration (robotArguments). RobotCode reads its own
// robot.toml instead; its debug launches still receive robotArguments.
const appliesRobotConfiguration = descriptor => native.isNative(descriptor);

// A provider-specific code action command that only selects a range in an
// edited document: { uri, range, rename } (LSP values), else undefined.
function codeActionSelection(descriptor, command) {
  return robotCode.codeActionSelection(descriptor, command);
}

// The provider's debug bridge behind the one execution adapter API; undefined
// for a plain contract-v1 DAP backend.
function debugBridge(descriptor, service) {
  checkVersion(descriptor);
  if (native.isNative(descriptor)) return new native.NativeDebugBridge();
  if (robotCode.isRobotCode(descriptor)) return new robotCode.RobotCodeDebugBridge({ python: service.executable });
  return undefined;
}

module.exports = { providerOf, describe, checkVersion, verifyLanguageServer, appliesRobotConfiguration, codeActionSelection,
  debugBridge };

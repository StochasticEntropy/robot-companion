"use strict";

// Integration-owned bridge to the pinned RobotCode 2.7.0 Python packages. The
// RobotCode VS Code extension is not used; RobotCode-specific names, versions
// and protocol details stay in this module and never reach providers or UI.
const { validateDescriptor } = require("./backend-contract");

const ROBOTCODE_BACKEND_ID = "robotcode";
const PINNED_ROBOTCODE_VERSION = "2.7.0";
const LANGUAGE_SERVER_NAME = "RobotCode Language Server";

// Builds a contract-v1 descriptor from an explicit interpreter of a prepared
// environment (robotframework + robotcode[all]==2.7.0). No interpreter discovery.
function robotCodeDescriptor({ workspaceUri, cwd, python, env = {}, services = ["language"] }) {
  const argv = {
    language: ["-m", "robotcode.cli", "language-server", "--stdio"],
    debug: ["-m", "robotcode.cli", "debug-launch", "--stdio"]
  };
  const entries = services.map(name => {
    if (!argv[name]) throw new Error(`The RobotCode bridge does not provide ${name}.`);
    return [name, { executable: python, argv: argv[name], transport: "stdio" }];
  });
  return validateDescriptor({
    id: ROBOTCODE_BACKEND_ID, version: PINNED_ROBOTCODE_VERSION, contractVersion: 1,
    workspaceUri, cwd, env, services: Object.fromEntries(entries)
  });
}

const isRobotCode = descriptor => descriptor?.id === ROBOTCODE_BACKEND_ID;

// A descriptor naming RobotCode must declare and actually run the pinned version.
function verifyLanguageServer(descriptor, serverInfo) {
  if (!isRobotCode(descriptor)) return;
  if (descriptor.version !== PINNED_ROBOTCODE_VERSION) {
    throw new Error(`The RobotCode bridge is pinned to ${PINNED_ROBOTCODE_VERSION}; the descriptor declares ${descriptor.version}.`);
  }
  const name = serverInfo?.name || "unknown server", version = serverInfo?.version || "unknown version";
  if (name !== LANGUAGE_SERVER_NAME || version !== PINNED_ROBOTCODE_VERSION) {
    throw new Error(`The RobotCode bridge requires ${LANGUAGE_SERVER_NAME} ${PINNED_ROBOTCODE_VERSION}; ` +
      `the backend reported ${name} ${version}. Point the descriptor at an environment with robotcode==${PINNED_ROBOTCODE_VERSION}.`);
  }
}

// Bridge-owned answers to RobotCode's workspace/configuration sections. The
// documentation HTTP server serves RobotCode extension views only: start it on
// demand so the bridge opens no unrequested listening socket (and shutdown does
// not wait for its 0.5 s poll loop).
const CONFIGURATION_OVERRIDES = Object.freeze({
  "robotcode.documentationServer": Object.freeze({ startOnDemand: true })
});

function configuration(descriptor, section, userValue) {
  const override = isRobotCode(descriptor) ? CONFIGURATION_OVERRIDES[section] : undefined;
  if (!override) return userValue;
  return { ...(userValue && typeof userValue === "object" ? userValue : {}), ...override };
}

// Debug: `robotcode debug-launch` speaks DAP plus RobotCode-specific launch
// arguments, custom events and the `robot/sync` handshake. The adapter consults
// this object so none of that reaches VS Code, providers or the UI.
class RobotCodeDebugBridge {
  constructor({ python }) {
    this.python = python;
  }

  // Translate a robotcompanion launch configuration plus the folder's execution
  // context into RobotCode launch arguments. Output stays on the protocol
  // (internalConsole: no terminal, no shell); debugpy gets a free loopback port.
  launchArguments(config, context = {}) {
    if (typeof config?.target !== "string" || !config.target) throw new Error("The launch configuration needs a target file.");
    return {
      request: "launch", name: config.name, python: this.python,
      cwd: context.cwd || config.cwd, target: config.target,
      args: [...(context.robotArguments || []), ...(Array.isArray(config.args) ? config.args : [])],
      env: { ...(context.env || {}) },
      ...(context.outputDir ? { outputDir: context.outputDir } : {}),
      console: "internalConsole", attachPython: config.attachPython !== false, attachPythonPort: 0,
      outputMessages: false, outputLog: false, stopOnEntry: config.stopOnEntry === true,
      ...(config.noDebug ? { noDebug: true } : {})
    };
  }

  // Classify a backend event: synced events need a `robot/sync` answer before
  // RobotCode continues (it otherwise waits 15 s per event); `debugpyStarted`
  // becomes a normalized Python child request; RobotCode custom events stay here.
  event(message) {
    const body = message.body || {};
    const result = { forward: true, sync: body.synced === true };
    if (message.event === "debugpyStarted") {
      const host = Array.isArray(body.addresses) && body.addresses[0] || "127.0.0.1";
      if (!Number.isInteger(body.port) || body.port <= 0 || !["127.0.0.1", "localhost", "::1"].includes(host)) {
        throw new Error("RobotCode reported an invalid debugpy endpoint.");
      }
      result.pythonChild = { host, port: body.port, processId: body.processId };
    }
    if (message.event === "debugpyStarted" || /^robot[A-Z]/.test(message.event)) result.forward = false;
    if (message.event === "robotExited") result.exited = { exitCode: body.exitCode, outputFile: body.outputFile };
    return result;
  }
}

module.exports = {
  ROBOTCODE_BACKEND_ID, PINNED_ROBOTCODE_VERSION, LANGUAGE_SERVER_NAME,
  robotCodeDescriptor, isRobotCode, verifyLanguageServer, configuration, RobotCodeDebugBridge
};

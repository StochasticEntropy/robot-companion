"use strict";

// Integration-owned bridge to the independent native backend distribution
// (`robot-companion-backend`, built from backend/). Robot Companion never
// imports its Python code: it launches the installed executable through a
// contract-v1 descriptor. Native-specific names, versions and the debugpy
// handoff v1 stay in this module and never reach providers or UI.
const path = require("node:path");
const { validateDescriptor } = require("./backend-contract");

const NATIVE_BACKEND_ID = "robot-companion-native";
const SUPPORTED_NATIVE_VERSION = "0.1.0.dev2";
const NATIVE_SERVER_NAME = "robot-companion-backend";
const HANDOFF_VERSION = 1;
const LOOPBACK = Object.freeze(["127.0.0.1", "localhost", "::1"]);

// Builds a descriptor for an explicit installed `robot-companion-backend`
// executable. No interpreter or install discovery. Its `discovery` service
// serves the normalized discovery API v1 itself, so it needs no bridge.
function nativeDescriptor({ workspaceUri, cwd, executable, env = {}, services = ["language"], version = SUPPORTED_NATIVE_VERSION }) {
  const argv = { language: ["lsp"], debug: ["dap"], discovery: ["discovery"] };
  const entries = services.map(name => {
    if (!argv[name]) throw new Error(`The native backend does not provide ${name}.`);
    return [name, { executable, argv: argv[name], transport: "stdio" }];
  });
  return validateDescriptor({
    id: NATIVE_BACKEND_ID, version, contractVersion: 1, workspaceUri, cwd, env, services: Object.fromEntries(entries)
  });
}

const isNative = descriptor => descriptor?.id === NATIVE_BACKEND_ID;

// Before anything starts: a native descriptor must declare the supported version.
function checkVersion(descriptor) {
  if (isNative(descriptor) && descriptor.version !== SUPPORTED_NATIVE_VERSION) {
    throw new Error(`Robot Companion supports the native backend ${SUPPORTED_NATIVE_VERSION}; ` +
      `the descriptor declares ${descriptor.version}.`);
  }
}

// After initialize: the running language server must be the declared native backend.
function verifyLanguageServer(descriptor, serverInfo) {
  if (!isNative(descriptor)) return;
  checkVersion(descriptor);
  const name = serverInfo?.name || "unknown server", version = serverInfo?.version || "unknown version";
  if (name !== NATIVE_SERVER_NAME || version !== SUPPORTED_NATIVE_VERSION) {
    throw new Error(`The native backend descriptor requires ${NATIVE_SERVER_NAME} ${SUPPORTED_NATIVE_VERSION}; ` +
      `the backend reported ${name} ${version}.`);
  }
}

const isRobotSource = source => typeof source?.path === "string" && /\.(robot|resource)$/i.test(source.path);

// Requests about the Robot worker's current stop. VS Code may still send one
// after the run moved on (the rest of the call stack after a quick Continue);
// the backend's refusal is then routine, not an error for the user.
const PAUSED_REQUESTS = new Set(["stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn"]);
const NOT_PAUSED = "Robot worker is not paused";
// The backend's end-of-child line when the Python session closes normally.
const ROUTINE_PYTHON_END = /^Python session ended: (Python DAP client disconnected|Python adapter closed its DAP stream)\n?$/;

// Debug: `robot-companion-backend dap` speaks DAP plus the versioned debugpy
// handoff v1 (`robotCompanion/pythonSession`, `robotCompanion/pythonConnected`).
// The adapter consults this object, which turns the handoff into the same
// normalized Python child endpoint the RobotCode bridge produces.
class NativeDebugBridge {
  constructor() {
    this.pythonRequested = false;
    this.pythonConnected = false;
    this.childConfigured = false;
  }

  // A robotcompanion launch configuration plus the folder's execution context
  // become native launch arguments: Robot arguments, the run's own output
  // folder and, unless attachPython is false, the Python handoff v1.
  launchArguments(config, context = {}) {
    if (typeof config?.target !== "string" || !config.target) throw new Error("The launch configuration needs a target file.");
    this.outputDir = context.outputDir;
    this.pythonRequested = config.attachPython !== false;
    return {
      name: config.name, target: config.target, cwd: context.cwd || config.cwd,
      args: [...(context.robotArguments || []), ...(Array.isArray(config.args) ? config.args : []),
        ...(context.outputDir ? ["--outputdir", context.outputDir] : [])],
      ...(this.pythonRequested ? { pythonDebug: { handoffVersion: HANDOFF_VERSION } } : {})
    };
  }

  // A request the adapter answers itself instead of forwarding. Python
  // breakpoints belong to the Python child session; the Robot backend only
  // verifies Robot sources.
  answer(request) {
    if (request.command === "setBreakpoints" && !isRobotSource(request.arguments?.source)) {
      const breakpoints = Array.isArray(request.arguments?.breakpoints) ? request.arguments.breakpoints : [];
      return { breakpoints: breakpoints.map(item => ({ verified: false, line: item?.line,
        message: "Set in the Python child session." })) };
    }
    return undefined;
  }

  // Handoff v1 order: the Robot configurationDone waits until the Python child
  // is attached and configured and the worker reports Python connected.
  hold(request) {
    return request.command === "configurationDone" && this.pythonRequested && !this.ready();
  }

  ready() {
    return this.pythonConnected && this.childConfigured;
  }

  childReady() {
    this.childConfigured = true;
    return this.ready();
  }

  // A "not paused" refusal still fails the request, without a notification.
  response(message) {
    const error = message.body?.error;
    if (message.success !== false || message.message !== NOT_PAUSED || !PAUSED_REQUESTS.has(message.command) || !error?.showUser) return undefined;
    return { ...message, body: { ...message.body, error: { ...error, showUser: false } } };
  }

  event(message) {
    const body = message.body || {};
    const result = { forward: true, sync: false };
    // The routine end of the Python child is a Debug Console line, not a popup.
    if (message.event === "output" && body.category === "important" && ROUTINE_PYTHON_END.test(body.output)) {
      result.message = { ...message, body: { ...body, category: "console" } };
    }
    if (message.event === "process" && Number.isInteger(body.systemProcessId)) result.ownedProcessGroups = [body.systemProcessId];
    if (message.event === "robotCompanion/pythonSession" && body.phase === "start") {
      const host = body.connect?.host, port = body.connect?.port, configuration = body.configuration || {};
      if (body.version !== HANDOFF_VERSION || !LOOPBACK.includes(host) || !Number.isInteger(port) || port <= 0 ||
          configuration.request !== "attach") {
        throw new Error("The native backend reported an invalid Python handoff.");
      }
      const { request: _request, ...attach } = configuration;
      result.pythonChild = { host, port, processId: body.owner?.debuggeeProcessId, attach };
      result.ownedProcessGroups = [body.adapter?.processId, body.owner?.debuggeeProcessId].filter(Number.isInteger);
    }
    if (message.event === "robotCompanion/pythonConnected") {
      this.pythonConnected = true;
      result.release = this.ready();
    }
    if (message.event === "exited") {
      result.exited = { exitCode: body.exitCode, outputFile: this.outputDir ? path.join(this.outputDir, "output.xml") : undefined };
    }
    if (typeof message.event === "string" && message.event.startsWith("robotCompanion/")) result.forward = false;
    return result;
  }
}

module.exports = {
  NATIVE_BACKEND_ID, SUPPORTED_NATIVE_VERSION, NATIVE_SERVER_NAME, HANDOFF_VERSION,
  nativeDescriptor, isNative, checkVersion, verifyLanguageServer, NativeDebugBridge
};

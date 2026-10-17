"use strict";

// Integration-owned contract. No VS Code, Python package, or sibling checkout
// dependency: descriptors can be checked before any process is allowed to start.
const path = require("path");
const { fileURLToPath } = require("url");
const { parseRobotCommand, normalizeRobotArguments } = require("../features/run/runner-core");

const CONTRACT_VERSION = 1;
const SERVICE_NAMES = Object.freeze(["language", "debug", "discovery"]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without NUL characters.`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || [...value].some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
    throw new Error(`${label} must be an array of strings without NUL characters.`);
  }
  return Object.freeze([...value]);
}

function environment(value) {
  record(value, "env");
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (!key || /[=\0]/.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw new Error("env must map valid environment names to strings without NUL characters.");
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function workspacePath(uri) {
  text(uri, "workspaceUri");
  let result;
  try {
    result = fileURLToPath(uri);
  } catch {
    throw new Error("workspaceUri must be a file URI on the workspace host.");
  }
  return result;
}

function validateDescriptor(input) {
  record(input, "Backend descriptor");
  if (input.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Unsupported backend contract version: ${input.contractVersion}. Expected ${CONTRACT_VERSION}.`);
  }
  const id = text(input.id, "id");
  const version = text(input.version, "version");
  const rootPath = workspacePath(input.workspaceUri);
  const cwd = text(input.cwd, "cwd");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be absolute on the workspace host.");
  const env = environment(input.env);
  const services = Object.create(null);
  record(input.services, "services");
  for (const [name, service] of Object.entries(input.services)) {
    if (!SERVICE_NAMES.includes(name)) throw new Error(`Unknown backend service: ${name}.`);
    record(service, name);
    if (service.transport !== "stdio") throw new Error(`${name}: only stdio transport is supported by contract v1.`);
    services[name] = Object.freeze({
      executable: text(service.executable, `${name}.executable`),
      argv: stringArray(service.argv, `${name}.argv`),
      transport: "stdio"
    });
  }
  if (!Object.keys(services).length) throw new Error("A backend descriptor must expose at least one service.");
  return Object.freeze({
    id, version, contractVersion: CONTRACT_VERSION,
    workspaceUri: input.workspaceUri, rootPath, cwd, env,
    services: Object.freeze(services)
  });
}

// Language and execution selections are deliberately independent. An absent
// optional discovery service must never disable language or debug startup.
function selectServices({ mode, language, execution }) {
  if (!["coexistence", "owned"].includes(mode)) throw new Error(`Unknown integration mode: ${mode}.`);
  if (mode === "coexistence") {
    return Object.freeze({ language: undefined, debug: undefined, discovery: undefined });
  }
  const languageDescriptor = language ? validateDescriptor(language) : undefined;
  const executionDescriptor = execution ? validateDescriptor(execution) : undefined;
  if (languageDescriptor && executionDescriptor && languageDescriptor.workspaceUri !== executionDescriptor.workspaceUri) {
    throw new Error("Language and execution descriptors must refer to the same workspace URI.");
  }
  return Object.freeze({
    language: languageDescriptor?.services.language ? languageDescriptor : undefined,
    debug: executionDescriptor?.services.debug ? executionDescriptor : undefined,
    discovery: executionDescriptor?.services.discovery ? executionDescriptor : undefined
  });
}

function requireService(descriptor, name, trusted) {
  // Check trust before inspecting executable configuration. The eventual
  // process owner must call this again immediately before spawn, not at activation.
  if (trusted !== true) throw new Error("Backend processes require a trusted workspace.");
  const checked = validateDescriptor(descriptor);
  if (!SERVICE_NAMES.includes(name) || !checked.services[name]) {
    throw new Error(`Backend '${checked.id}' does not support ${name}.`);
  }
  const service = checked.services[name];
  return Object.freeze({
    executable: service.executable, argv: service.argv,
    cwd: checked.cwd, env: checked.env, transport: service.transport
  });
}

// Keep the existing explicit robotCommand grammar. No interpreter inference or
// environment probes: a later accepted resolver can replace this narrow input.
class ExecutionContexts {
  constructor() {
    this.roots = new Map();
  }

  forRoot(workspaceUri, settings, trusted) {
    if (trusted !== true) throw new Error("Execution configuration requires a trusted workspace.");
    const rootPath = workspacePath(workspaceUri);
    const command = parseRobotCommand(settings.robotCommand ?? "robot");
    const robotArguments = normalizeRobotArguments(settings.robotArguments);
    const signature = JSON.stringify([command, robotArguments]);
    const previous = this.roots.get(workspaceUri);
    if (previous?.signature === signature) return previous.context;
    const context = Object.freeze({
      workspaceUri, cwd: rootPath,
      robot: Object.freeze({ executable: command.executable, argv: Object.freeze(command.args) }),
      robotArguments: Object.freeze(robotArguments)
    });
    this.roots.set(workspaceUri, { signature, context });
    return context;
  }

  remove(workspaceUri) {
    this.roots.delete(workspaceUri);
  }

  dispose() {
    this.roots.clear();
  }
}

module.exports = { CONTRACT_VERSION, validateDescriptor, selectServices, requireService, ExecutionContexts };

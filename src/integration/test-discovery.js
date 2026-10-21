"use strict";

const path = require("path");
const { fileURLToPath } = require("url");

// Integration-owned normalized discovery API, version 1. A backend answers
// `robotCompanion/discoverTests` with { version: 1, items: [suite...] } where a
// suite is { kind: "suite", label, uri, range, children: [test...] } and a test
// is { kind: "test", label, uri, range }. Backend-specific shapes stay in the
// backend's adapter; the UI only sees this normalized tree. A result may also
// carry an additive `errors: [{ uri, range, message }]` array for files it
// could not read or parse completely (see normalizeDiscoveryErrors). Two more
// additive fields are optional: a test's `tags` (its Robot tags), a suite's
// `parents` ([{ label, uri }]: the directory suites between the workspace
// folder and the file, outermost first, with Robot's suite names) and a suite's
// `rpa` (true for a file of tasks).
const DISCOVERY_METHOD = "robotCompanion/discoverTests";
const DISCOVERY_VERSION = 1;

function position(value, label) {
  if (!value || !Number.isSafeInteger(value.line) || value.line < 0 ||
      !Number.isSafeInteger(value.character) || value.character < 0) {
    throw new Error(`${label} has an invalid position.`);
  }
  return { line: value.line, character: value.character };
}

function range(value, label) {
  const start = position(value?.start, label), end = position(value?.end, label);
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    throw new Error(`${label} has an invalid range.`);
  }
  return { start, end };
}

function sourceUri(value, rootPath, label, { allowRoot = false } = {}) {
  let file;
  try {
    file = fileURLToPath(value);
  } catch {
    throw new Error(`${label} must have a file URI on the workspace host.`);
  }
  const relative = path.relative(rootPath, file);
  if ((!relative && !allowRoot) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside its workspace folder.`);
  }
  return value;
}

function label(value, what) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${what} needs a label.`);
  return value;
}

// IDs are derived here from source, never taken from the backend: a suite is
// its file URI and a test is that URI plus its name (with an occurrence suffix
// for a repeated name), so IDs stay stable across backends and restarts.
function tags(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(tag => typeof tag === "string" && tag.length && !tag.includes("\0"))) {
    throw new Error(`Test '${name}' has invalid tags.`);
  }
  return [...new Set(value)];
}

// A suite's directory suites: the first a folder directly inside the
// workspace folder, each next one directly inside the one before, the last
// holding the suite's file; one name per folder across all suites. Paths are
// compared with path.relative, which ignores case on Windows (drive letters).
function parents(value, fileUri, rootPath, directories, what) {
  if (value === undefined || (Array.isArray(value) && !value.length)) return [];
  if (!Array.isArray(value)) throw new Error(`${what} has invalid parents.`);
  const same = (left, right) => path.relative(left, right) === "";
  const refuse = () => new Error(`The directory suites of ${what} do not lead to its file.`);
  let previous = rootPath;
  const result = value.map(parent => {
    const uri = sourceUri(parent?.uri, rootPath, `A directory suite of ${what}`);
    const name = label(parent.label, `A directory suite of ${what}`);
    const directory = fileURLToPath(uri);
    if (!same(path.dirname(directory), previous)) throw refuse();
    previous = directory;
    const key = process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
    if (directories.has(key) && directories.get(key).label !== name) throw new Error(`Directory suite ${uri} has two names.`);
    if (!directories.has(key)) directories.set(key, { id: uri, label: name, uri });
    return directories.get(key);
  });
  if (!same(path.dirname(fileURLToPath(fileUri)), previous)) throw refuse();
  return result;
}

function normalizeDiscovery(result, workspaceUri) {
  if (!result || result.version !== DISCOVERY_VERSION || !Array.isArray(result.items)) {
    throw new Error(`Discovery result must be version ${DISCOVERY_VERSION} with an items array.`);
  }
  const rootPath = fileURLToPath(workspaceUri);
  const suites = new Map(), directories = new Map();
  for (const suite of result.items) {
    if (suite?.kind !== "suite") throw new Error("Top-level discovery items must be suites.");
    const uri = sourceUri(suite.uri, rootPath, `Suite '${suite.label}'`);
    if (suites.has(uri)) throw new Error(`Suite ${uri} is reported twice.`);
    const seen = new Map();
    const tests = (Array.isArray(suite.children) ? suite.children : []).map(test => {
      const name = label(test?.label, "A test");
      if (test.kind !== "test" || test.uri !== uri) throw new Error(`Test '${name}' must be a test in its suite file.`);
      const occurrence = (seen.get(name) || 0) + 1;
      seen.set(name, occurrence);
      return { id: `${uri}::${name}${occurrence > 1 ? `#${occurrence}` : ""}`, kind: "test", label: name, uri,
        range: range(test.range, `Test '${name}'`), tags: tags(test.tags, name) };
    });
    suites.set(uri, { id: uri, kind: "suite", label: label(suite.label, "A suite"), uri,
      range: range(suite.range, `Suite '${suite.label}'`), children: tests,
      parents: parents(suite.parents, uri, rootPath, directories, `suite '${suite.label}'`),
      ...(typeof suite.rpa === "boolean" ? { rpa: suite.rpa } : {}) });
  }
  return [...suites.values()];
}

// The result's errors, so that a tree missing tests of an unreadable or broken
// file is never shown without saying so. Each error names a source inside the
// folder (a file, a directory or the folder itself) and its message.
function normalizeDiscoveryErrors(result, workspaceUri) {
  if (result?.errors === undefined) return [];
  if (!Array.isArray(result.errors)) throw new Error("Discovery errors must be an array.");
  const rootPath = fileURLToPath(workspaceUri);
  return result.errors.map(error => {
    if (typeof error?.message !== "string" || !error.message.trim()) throw new Error("A discovery error needs a message.");
    return { uri: sourceUri(error.uri, rootPath, "A discovery error", { allowRoot: true }), message: error.message,
      ...(error.range === undefined ? {} : { range: range(error.range, "A discovery error") }) };
  });
}

module.exports = { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery, normalizeDiscoveryErrors };

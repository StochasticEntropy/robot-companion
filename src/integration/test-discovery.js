"use strict";

const path = require("path");
const { fileURLToPath } = require("url");

// Integration-owned normalized discovery API, version 1. A backend answers
// `robotCompanion/discoverTests` with { version: 1, items: [suite...] } where a
// suite is { kind: "suite", label, uri, range, children: [test...] } and a test
// is { kind: "test", label, uri, range }. Backend-specific shapes stay in the
// backend's adapter; the UI only sees this normalized tree.
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

function sourceUri(value, rootPath, label) {
  let file;
  try {
    file = fileURLToPath(value);
  } catch {
    throw new Error(`${label} must have a file URI on the workspace host.`);
  }
  const relative = path.relative(rootPath, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
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
function normalizeDiscovery(result, workspaceUri) {
  if (!result || result.version !== DISCOVERY_VERSION || !Array.isArray(result.items)) {
    throw new Error(`Discovery result must be version ${DISCOVERY_VERSION} with an items array.`);
  }
  const rootPath = fileURLToPath(workspaceUri);
  const suites = new Map();
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
        range: range(test.range, `Test '${name}'`) };
    });
    suites.set(uri, { id: uri, kind: "suite", label: label(suite.label, "A suite"), uri,
      range: range(suite.range, `Suite '${suite.label}'`), children: tests });
  }
  return [...suites.values()];
}

module.exports = { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery };

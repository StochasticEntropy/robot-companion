"use strict";

const path = require("path");
const { randomUUID } = require("node:crypto");
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
const CANCEL_DISCOVERY_METHOD = "robotCompanion/cancelDiscovery";
const MAX_DISCOVERY_BYTES = 64 * 1024 * 1024;
const DISCOVERY_BUDGET_MS = 5 * 60 * 1000;
const MAX_DISCOVERY_BATCHES = 10000;

// A cold scan can legitimately outlast one LSP request. Only a backend that
// advertises batch v1 gets paged requests; each request keeps the normal timeout.
// Callers apply the returned complete tree once, never these intermediate pages.
async function collectDiscovery(session, params, { signal, current = () => true, progress = () => {},
  now = Date.now, budgetMs = DISCOVERY_BUDGET_MS } = {}) {
  const usable = () => !signal?.aborted && current();
  if (!usable()) return;
  if (session.capabilities?.robotCompanionDiscovery?.batch !== 1) {
    const result = await session.request(DISCOVERY_METHOD, params, { signal });
    return usable() ? result : undefined;
  }
  const scanId = randomUUID();
  let complete = false, cancelled = false;
  const cancel = () => {
    if (cancelled || complete) return;
    cancelled = true;
    try { session.notify(CANCEL_DISCOVERY_METHOD, { workspaceUri: params.workspaceUri, scanId }); }
    catch { /* A stopped service has already released its continuation. */ }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const deadline = now() + budgetMs, items = [], errors = [], tokens = new Set();
  let continuation, previous = { scanned: 0, files: 0, suites: 0, tests: 0 };
  let bytes = Buffer.byteLength('{"version":1,"items":[]}'), pages = 0;
  try {
    while (usable()) {
      if (++pages > MAX_DISCOVERY_BATCHES) throw new Error("Discovery exceeded its maximum number of batches; no partial tree was applied.");
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("Discovery exceeded its overall deadline; no partial tree was applied.");
      const result = await session.request(DISCOVERY_METHOD, { ...params, batch: 1, scanId,
        ...(continuation === undefined ? {} : { continuation }) },
      { signal, timeoutMs: Math.min(session.timeoutMs || 10000, remaining) });
      if (!usable()) return;
      if (now() > deadline) throw new Error("Discovery exceeded its overall deadline; no partial tree was applied.");
      // Validate sources, ranges and diagnostics before retaining a page. The
      // final normalization also checks directory names/duplicates across pages.
      const page = normalizeDiscovery(result, params.workspaceUri);
      normalizeDiscoveryErrors(result, params.workspaceUri);
      const batch = result.batch;
      if (!batch || !["scanned", "files", "suites", "tests"].every(key =>
        Number.isSafeInteger(batch[key]) && batch[key] >= previous[key]) ||
        batch.files > batch.scanned || batch.suites > batch.files ||
        batch.suites !== items.length + page.length ||
        batch.tests !== previous.tests + page.reduce((count, suite) => count + suite.children.length, 0)) {
        throw new Error("Discovery returned invalid batch progress; no partial tree was applied.");
      }
      continuation = batch.continuation;
      if (continuation !== null && (typeof continuation !== "string" || !continuation.length ||
          continuation.length > 256 || continuation.includes("\0") || tokens.has(continuation) ||
          batch.scanned <= previous.scanned)) {
        throw new Error("Discovery returned an invalid or repeated continuation; no partial tree was applied.");
      }
      const pageErrors = result.errors || [];
      if (!errors.length && pageErrors.length) bytes += Buffer.byteLength(',"errors":[]');
      result.items.forEach((item, index) => { bytes += Buffer.byteLength(JSON.stringify(item)) + (items.length + index ? 1 : 0); });
      pageErrors.forEach((error, index) => { bytes += Buffer.byteLength(JSON.stringify(error)) + (errors.length + index ? 1 : 0); });
      if (bytes > MAX_DISCOVERY_BYTES) throw new Error("Discovery result exceeds 64 MiB; no partial tree was applied.");
      for (const item of result.items) items.push(item);
      for (const error of pageErrors) errors.push(error);
      previous = batch;
      progress({ scanned: batch.scanned, files: batch.files, suites: batch.suites, tests: batch.tests,
        complete: continuation === null });
      if (continuation === null) {
        complete = true;
        return { version: DISCOVERY_VERSION, items, ...(errors.length ? { errors } : {}) };
      }
      tokens.add(continuation);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
  }
}

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
    if (error.severity !== undefined && !["error", "warning", "information"].includes(error.severity)) {
      throw new Error("A discovery diagnostic has an invalid severity.");
    }
    return { uri: sourceUri(error.uri, rootPath, "A discovery error", { allowRoot: true }), message: error.message,
      ...(error.severity === undefined ? {} : { severity: error.severity }),
      ...(error.range === undefined ? {} : { range: range(error.range, "A discovery error") }) };
  });
}

module.exports = { DISCOVERY_METHOD, DISCOVERY_VERSION, normalizeDiscovery, normalizeDiscoveryErrors,
  collectDiscovery, CANCEL_DISCOVERY_METHOD };

"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

function realPath(file) {
  try { return fs.realpathSync.native(file); } catch { return undefined; }
}

function realFileUriPath(uri) {
  try { return realPath(fileURLToPath(uri)); } catch { return undefined; }
}

function indexedSourcePath(byPath, file, workspacePath) {
  if (byPath.has(file)) return file;
  const canonicalFile = realPath(file);
  if (!canonicalFile) return undefined;
  if (byPath.has(canonicalFile)) return canonicalFile;

  // A symlinked workspace root (such as macOS /var) keeps its editor spelling
  // in the index even though the language service returns a canonical path.
  const canonicalWorkspace = realPath(workspacePath);
  if (!canonicalWorkspace || canonicalWorkspace === workspacePath) return undefined;
  const indexed = path.resolve(workspacePath, path.relative(canonicalWorkspace, canonicalFile));
  if (byPath.has(indexed) && realPath(indexed) === canonicalFile) return indexed;
}

// Consume normalized standard LSP definitions. Names (including aliases) are
// intentionally absent from identity: only the backend's source range decides.
function definitionIdentity(definitions) {
  const targets = new Map();
  for (const item of definitions || []) {
    const uri = (item.targetUri || item.uri).toString();
    const range = item.targetSelectionRange || item.range;
    const key = JSON.stringify([uri, range.start.line, range.start.character, range.end.line, range.end.character]);
    const previous = targets.get(key);
    // A declaration marker cannot be upgraded by a duplicate ordinary location.
    targets.set(key, { uri, range, ...(item.sourceKind === "declaration" || previous?.sourceKind === "declaration"
      ? { sourceKind: "declaration" } : {}) });
  }
  if (!targets.size) return { status: "unresolved" };
  if (targets.size !== 1) return { status: "ambiguous" };
  return { status: "resolved", ...targets.values().next().value };
}

function metadataAtDefinition(byName, identity) {
  if (identity.status !== "resolved") return undefined;
  // Preserve an exact URI match first. A different URI can only join if it
  // resolves to the same full file path and the selection is on the same line.
  const sameLine = [];
  for (const candidates of byName?.values() || []) {
    for (const candidate of candidates) {
      if (candidate.sourceLine !== identity.range.start.line) continue;
      if (candidate.sourceUri === identity.uri) return candidate;
      sameLine.push(candidate);
    }
  }
  if (!sameLine.length) return undefined;
  const canonical = realFileUriPath(identity.uri);
  if (canonical) return sameLine.find(candidate => realFileUriPath(candidate.sourceUri) === canonical);
}

module.exports = { definitionIdentity, indexedSourcePath, metadataAtDefinition };

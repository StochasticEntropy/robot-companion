"use strict";

// Consume normalized standard LSP definitions. Names (including aliases) are
// intentionally absent from identity: only the backend's source range decides.
function definitionIdentity(definitions) {
  const targets = new Map();
  for (const item of definitions || []) {
    const uri = (item.targetUri || item.uri).toString();
    const range = item.targetSelectionRange || item.range;
    const key = JSON.stringify([uri, range.start.line, range.start.character, range.end.line, range.end.character]);
    targets.set(key, { uri, range });
  }
  if (!targets.size) return { status: "unresolved" };
  if (targets.size !== 1) return { status: "ambiguous" };
  return { status: "resolved", ...targets.values().next().value };
}

function metadataAtDefinition(byName, identity) {
  if (identity.status !== "resolved") return undefined;
  // Do not choose a same-name definition, or a different function in the same
  // file. The index's function line must agree with the resolved selection.
  for (const candidates of byName?.values() || []) {
    const match = candidates.find(candidate => candidate.sourceUri === identity.uri &&
      candidate.sourceLine === identity.range.start.line);
    if (match) return match;
  }
}

module.exports = { definitionIdentity, metadataAtDefinition };

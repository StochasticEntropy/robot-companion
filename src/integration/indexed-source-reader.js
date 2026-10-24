"use strict";
const fs = require("node:fs/promises");
const vscode = require("vscode");
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Read only selected indexed sources. Exact content, including an unsaved editor
// overlay, is the freshness proof; size/mtime and watcher events are not.
async function readIndexedSource(uri, byteLimit = MAX_FILE_BYTES) {
  const limit = Math.max(0, Math.min(MAX_FILE_BYTES, byteLimit));
  const open = vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString());
  if (open) {
    const text = open.getText();
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error("Selected metadata source exceeds the selected source read budget.");
    return text;
  }
  const handle = await fs.open(uri.fsPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Selected metadata source is not a bounded regular file.");
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return bytes.subarray(0, offset).toString("utf8");
      offset += bytesRead;
    }
    // If the file grew after stat, refuse instead of validating a truncated prefix.
    throw new Error("Selected metadata source changed while being read.");
  } finally { await handle.close(); }
}
module.exports = { readIndexedSource, MAX_FILE_BYTES };

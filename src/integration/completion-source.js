"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash } = require("node:crypto");
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 64;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// onDidSave supplies the editor's saved text; a watcher alone is never a save witness.
function rememberCompletionSave(root, document) {
  const uri = document.uri.toString();
  root.completionSaves?.delete(uri);
  if (!root.documents.has(uri) || document.isClosed) return;
  root.completionSaves ||= new Map();
  try {
    const text = document.getText();
    if (text.length > MAX_BYTES || Buffer.byteLength(text, "utf8") > MAX_BYTES) return;
    root.completionSaves.set(uri, { document, version: document.version, digest: digest(text) });
  } catch { /* An unproved save retains the normal source invalidation. */ }
}

async function diskMatchesSave(path, saved) {
  let file;
  try {
    const named = await fs.lstat(path);
    if (!named.isFile() || named.size > MAX_BYTES + 3) return false;
    // Never let a replaced POSIX FIFO block an input-proof worker. Windows
    // ordinary-file paths use the regular-file precheck without POSIX flags.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 :
      (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
    file = await fs.open(path, flags);
    const before = await file.stat();
    if (!sameFile(named, before) || before.size > MAX_BYTES + 3) return false;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return false;
      offset += read.bytesRead;
    }
    if (!sameFile(before, await file.stat()) || !sameFile(before, await fs.stat(path))) return false;
    const body = bytes.subarray(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0);
    return digest(body) === saved.digest;
  } catch { return false; }
  finally { await file?.close().catch(() => {}); }
}

function recordCompletionWatch(root, uri, type, current) {
  const saved = root.completionSaves?.get(uri.toString());
  if (type !== 2 || !saved || saved.document.isClosed || !root.documents.has(uri.toString()) ||
      (root.completionSaveChecks || 0) >= 4) return;
  const event = { revision: root.completionSourceRevision, document: saved.document, verified: false };
  root.completionOwnSaveEvents ||= [];
  root.completionOwnSaveEvents.push(event);
  if (root.completionOwnSaveEvents.length > MAX_EVENTS) root.completionOwnSaveEvents.shift();
  // Keep global invalidation immediate. Only a finished, current content proof may
  // later permit the existing exact same-cell append guard to inspect this reply.
  root.completionSaveChecks = (root.completionSaveChecks || 0) + 1;
  void diskMatchesSave(uri.fsPath, saved).then(matches => {
    if (matches && current() && root.completionSaves?.get(uri.toString()) === saved && !saved.document.isClosed) event.verified = true;
  }).catch(() => {}).finally(() => { root.completionSaveChecks--; });
}

function completionSourcesCurrent(root, revision, document) {
  const changed = (root.completionSourceRevision || 0) - revision;
  if (!changed) return true;
  if (changed < 0 || changed > MAX_EVENTS) return false;
  const own = (root.completionOwnSaveEvents || []).filter(event => event.revision > revision);
  return own.length === changed && own.every(event => event.document === document && event.verified);
}

function forgetCompletionSource(root, uri) {
  const saved = root.completionSaves?.get(uri);
  root.completionSaves?.delete(uri);
  if (saved) root.completionOwnSaveEvents = root.completionOwnSaveEvents?.filter(event => event.document !== saved.document);
}

module.exports = { rememberCompletionSave, recordCompletionWatch, completionSourcesCurrent, forgetCompletionSource };

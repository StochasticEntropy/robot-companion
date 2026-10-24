"use strict";

// Async suggestion results keep request-time ranges: VS Code shifts and filters
// these while the user finishes the same cell. Never extend this to other edits.
function safeCompletionAppend(result, original, position, current, cursor) {
  if (typeof original !== "string" || typeof current !== "string" || original.length > 4 * 1024 * 1024 ||
      !position || !cursor || !Number.isInteger(position.line) || position.line < 0 ||
      cursor.line !== position.line || !Number.isInteger(position.character) || position.character < 0 ||
      result?.isIncomplete !== true || !Array.isArray(result.items) || !result.items.length || result.items.length > 10000) return false;
  let lineStart = 0;
  for (let line = 0; line < position.line; line++) {
    const next = original.indexOf("\n", lineStart);
    if (next < 0) return false;
    lineStart = next + 1;
  }
  const offset = lineStart + position.character;
  const added = current.length - original.length;
  if (added <= 0 || added > 1024 || cursor.character !== position.character + added ||
      !current.startsWith(original.slice(0, offset)) || !current.endsWith(original.slice(offset))) return false;
  const insertion = current.slice(offset, offset + added);
  // A tab, >=2 spaces, pipe, newline, '=' or variable/member syntax changes
  // Robot context. Letters and one internal keyword space do not.
  if (!/^[\p{L}\p{N}_ -]+$/u.test(insertion)) return false;
  const first = result.items[0], range = first?.textEdit?.range;
  if (!range || !Number.isInteger(range.start?.character) || range.start.character < 0 ||
      range.start.line !== position.line || range.end?.line !== position.line ||
      range.end.character !== position.character || range.start.character > position.character) return false;
  const cell = current.slice(lineStart + range.start.character, offset + added);
  if (/ {2,}|[\t\r\n|=\[\]{}$@&%]/u.test(cell)) return false;
  const keyword = first.kind === 3;
  if (!keyword && /\s/u.test(cell)) return false;
  if (!keyword && !(first.kind === 6 && /^[\p{L}_][\p{L}\p{N}_]*=$/u.test(first.label))) return false;
  return result.items.every(item => item && item.kind === first.kind && typeof item.label === "string" &&
    (keyword || /^[\p{L}_][\p{L}\p{N}_]*=$/u.test(item.label)) &&
    !item.command && !item.additionalTextEdits?.length && !item.commitCharacters?.length &&
    item.insertTextFormat !== 2 && typeof item.textEdit?.newText === "string" &&
    item.textEdit.range?.start?.line === range.start.line &&
    item.textEdit.range.start.character === range.start.character &&
    item.textEdit.range.end?.line === range.end.line && item.textEdit.range.end.character === range.end.character);
}

module.exports = { safeCompletionAppend };

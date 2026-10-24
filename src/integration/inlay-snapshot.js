"use strict";

// Reuse only annotations outside a changed literal test-body statement. Anything
// that could change declaration/import/variable resolution needs a fresh answer.
function offsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function offset(starts, position) { return starts[position.line] + position.character; }
function position(starts, value) {
  let line = starts.length - 1;
  while (line && starts[line] > value) line--;
  return { line, character: value - starts[line] };
}
const continuation = line => /^\s*\.\.\.(?:\s|$)/.test(line);
function statement(lines, first, last) {
  while (first > 0 && continuation(lines[first])) first--;
  while (last + 1 < lines.length && continuation(lines[last + 1])) last++;
  return { first, last };
}
function localBody(lines, { first, last }) {
  let section = "";
  for (let line = 0; line <= first; line++) if (/^\*{3}/.test(lines[line])) section = lines[line];
  if (!/^\*{3}\s*(test cases|tasks|keywords)\s*\*{3}\s*$/i.test(section)) return false;
  return lines.slice(first, last + 1).every(line => !line.trim() || /^\s+/.test(line) &&
    !/^\s*(?:\[|\*{3})|^\s*VAR(?:\s|$)|\bimport\s+(?:library|resource|variables)\b|\bset\s+(?:test|task|suite|global|local)\s+variable\b/i.test(line));
}

function changedSnapshot(snapshot, document, changes) {
  if (document.version !== snapshot.version + 1 || !changes.length) return;
  const old = snapshot.text, starts = offsets(old), edits = changes.map(change => ({
    start: offset(starts, change.range.start), end: offset(starts, change.range.end), text: change.text,
    first: change.range.start.line, last: change.range.end.line
  })).sort((a, b) => a.start - b.start);
  if (edits.some((edit, i) => !Number.isFinite(edit.start) || !Number.isFinite(edit.end) ||
    edit.start > edit.end || i && edit.start < edits[i - 1].end)) return;
  const oldLines = old.split(/\r?\n/), excluded = edits.map(edit => statement(oldLines, edit.first, edit.last));
  if (excluded.some(span => !localBody(oldLines, span))) return;
  let text = old;
  for (const edit of [...edits].reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  if (text !== document.getText()) return;
  const next = offsets(text), newLines = text.split(/\r?\n/);
  let delta = 0;
  const newExcluded = edits.map(edit => {
    const start = edit.start + delta;
    delta += edit.text.length - (edit.end - edit.start);
    return statement(newLines, position(next, start).line, position(next, start + edit.text.length).line);
  });
  if (newExcluded.some(span => !localBody(newLines, span))) return;
  const map = value => {
    let shift = 0;
    for (const edit of edits) {
      if (value >= edit.start && value <= edit.end) return;
      if (value > edit.end) shift += edit.text.length - (edit.end - edit.start);
    }
    return value + shift;
  };
  const items = snapshot.items.flatMap(item => {
    if (excluded.some(span => item.position.line >= span.first && item.position.line <= span.last)) return [];
    const mapped = map(offset(starts, item.position));
    if (mapped === undefined) return [];
    const point = position(next, mapped);
    if (newExcluded.some(span => point.line >= span.first && point.line <= span.last)) return [];
    return [{ ...item, position: point }];
  });
  return { text, version: document.version, items, dirty: true };
}

function within(point, range) {
  const after = (a, b) => a.line > b.line || a.line === b.line && a.character >= b.character;
  return after(point, range.start) && after(range.end, point);
}

module.exports = { changedSnapshot, within };

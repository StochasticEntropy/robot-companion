"use strict";

// Owned-mode precedence rules for features that both Robot Companion and the
// language backend provide. No VS Code or backend dependency, so the rules are
// checked by plain Node tests and apply to any backend.
//
// Hover: Companion's sections (documentation preview, return, enum/argument,
// variable value) come first and keep their links. The backend hover follows
// in the same hover, without the paragraphs whose text Companion already
// shows; a heading whose paragraphs were all left out is left out too. A
// heading without paragraphs is treated as a paragraph.
//
// Completion: Companion's items come first. A backend item whose label or
// inserted text equals a Companion item's is left out.

const HEADING = /^ {0,3}(#{1,6})\s/;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_~#>|\\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Headings become their own blocks; other lines group into paragraphs between
// blank lines. Fenced code stays together with its fence lines.
function markdownBlocks(markdown) {
  const blocks = [];
  let current = [], fenced = false;
  const flush = () => { if (current.length) blocks.push(current.join("\n")); current = []; };
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (!fenced) flush();
      current.push(line);
      fenced = !fenced;
      if (!fenced) flush();
      continue;
    }
    if (fenced) { current.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if (HEADING.test(line)) { flush(); blocks.push(line); continue; }
    current.push(line);
  }
  flush();
  return blocks;
}

// Returns the backend markdown without what Companion's markdown already says,
// or "" when nothing new remains.
function backendHoverRemainder(companionMarkdown, backendMarkdown) {
  const shown = normalizeText(Array.isArray(companionMarkdown) ? companionMarkdown.join("\n") : companionMarkdown);
  const blocks = markdownBlocks(backendMarkdown).map(block => ({ block, level: HEADING.exec(block)?.[1].length }));
  // A heading with no paragraph of its own below it is content itself, such
  // as RobotCode's "### Local Variable `${record}`".
  const hasBody = index => {
    for (const next of blocks.slice(index + 1)) {
      if (!next.level) return true;
      if (next.level <= blocks[index].level) return false;
    }
    return false;
  };
  const kept = [], pending = [];
  for (const [index, { block, level }] of blocks.entries()) {
    if (level && hasBody(index)) {
      while (pending.length && pending[pending.length - 1].level >= level) pending.pop();
      pending.push({ level, block });
      continue;
    }
    if (level) while (pending.length && pending[pending.length - 1].level >= level) pending.pop();
    const text = normalizeText(block);
    if (!text || (shown && shown.includes(text))) continue;
    kept.push(...pending.splice(0).map(entry => entry.block), block);
  }
  return kept.join("\n\n");
}

function completionKeys(item) {
  const label = typeof item?.label === "string" ? item.label : item?.label?.label;
  const insert = typeof item?.insertText === "string" ? item.insertText : item?.insertText?.value;
  return [label, insert].filter(value => typeof value === "string" && value.trim())
    .map(value => value.trim().toLowerCase());
}

// Backend items that do not repeat a Companion item.
function uniqueBackendCompletions(companionItems, backendItems) {
  const seen = new Set((companionItems || []).flatMap(completionKeys));
  return (backendItems || []).filter(item => !completionKeys(item).some(key => seen.has(key)));
}

module.exports = { normalizeText, markdownBlocks, backendHoverRemainder, uniqueBackendCompletions };

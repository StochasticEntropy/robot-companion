"use strict";

// Per-test results from Robot Framework's output.xml (RF 4+ schema). Only the
// status element that is a direct child of a <test> counts; keyword statuses
// nested inside it are ignored. No VS Code or backend dependency.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const unescape = text => text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
  if (entity[0] !== "#") return ENTITIES[entity] ?? match;
  const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : match;
});

function attributes(text) {
  const result = {};
  for (const [, name, value] of text.matchAll(/([A-Za-z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) result[name] = unescape(value);
  return result;
}

function readTestResults(xml) {
  const results = [], stack = [];
  let message;
  for (const [, closing, name, attrs, selfClosing, text] of
    xml.matchAll(/<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (text !== undefined) { if (message) message.text += text; continue; }
    if (name === "status" && !closing && stack.at(-1)?.name === "test") {
      const test = stack.at(-1);
      test.status = attributes(attrs).status;
      if (!selfClosing) { message = { text: "" }; test.message = message; }
      continue;
    }
    if (name === "status" && closing && message) { message = undefined; continue; }
    if (closing) {
      const element = stack.pop();
      if (element?.name === "test") {
        const suite = [...stack].reverse().find(entry => entry.name === "suite" && entry.attrs.source);
        results.push({ source: suite?.attrs.source, name: element.attrs.name, line: Number(element.attrs.line) || undefined,
          status: element.status, message: element.message ? unescape(element.message.text).trim() : "" });
      }
      continue;
    }
    if (!selfClosing && (name === "suite" || name === "test" || stack.length)) stack.push({ name, attrs: attributes(attrs) });
  }
  return results;
}

module.exports = { readTestResults };

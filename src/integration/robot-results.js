"use strict";

// Per-test results from Robot Framework's output.xml (RF 4+ schema). Includes Robot's post-run propagation
// of a failed or skipped suite teardown to that suite's descendant tests. No VS Code or backend dependency.
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
    const parent = stack.at(-1);
    if (name === "status" && !closing && (parent?.name === "test" || parent?.suiteTeardown)) {
      const test = parent;
      const status = attributes(attrs);
      test.status = status.status;
      if (status.elapsed !== undefined && Number.isFinite(Number(status.elapsed))) test.elapsed = Number(status.elapsed);
      if (!selfClosing) { message = { text: "" }; test.message = message; }
      continue;
    }
    if (name === "status" && closing && message) { message = undefined; continue; }
    if (closing) {
      const element = stack.pop();
      if (element?.name === "test") {
        const suite = [...stack].reverse().find(entry => entry.name === "suite" && entry.attrs.source);
        results.push({ source: suite?.attrs.source, name: element.attrs.name, id: element.attrs.id,
          line: Number(element.attrs.line) || undefined,
          status: element.status, message: element.message ? unescape(element.message.text).trim() : "",
          ...(element.elapsed !== undefined ? { elapsed: element.elapsed } : {}) });
      }
      if (element?.suiteTeardown && ["FAIL", "SKIP"].includes(element.status)) {
        const reason = unescape(element.message?.text || "").trim();
        for (let index = stack.at(-1).firstTest; index < results.length; index++) {
          const test = results[index];
          if (element.status === "SKIP") {
            test.status = "SKIP";
            test.message = `Skipped in parent suite teardown:\n${reason}` +
              (test.message ? `\n\nEarlier message:\n${test.message}` : "");
          } else {
            if (test.status !== "SKIP") test.status = "FAIL";
            test.message = (test.message ? `${test.message}\n\nAlso parent` : "Parent") + ` suite teardown failed:\n${reason}`;
          }
        }
      }
      continue;
    }
    if (!selfClosing && (name === "suite" || name === "test" || stack.length)) {
      const element = { name, attrs: attributes(attrs) };
      if (name === "suite") element.firstTest = results.length;
      if (name === "kw" && element.attrs.type === "TEARDOWN" && parent?.name === "suite") element.suiteTeardown = true;
      stack.push(element);
    }
  }
  return results;
}

module.exports = { readTestResults };

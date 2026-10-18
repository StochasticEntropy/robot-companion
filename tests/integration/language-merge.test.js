"use strict";
// Owned-mode precedence rules for hover and completion (no VS Code needed).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { markdownBlocks, backendHoverRemainder, uniqueBackendCompletions } = require("../../src/integration/language-merge");

// The pinned RobotCode 2.7.0 hover for Local Step, as the live server returns it.
const backendLocalStep = "### Keyword *Local Step*\n\n#### Documentation:\n" +
  "A local keyword used to verify native definition navigation.\n\n";

test("markdown blocks split headings, paragraphs and fenced code", () => {
  assert.deepEqual(markdownBlocks("# A\ntext\nmore\n\n```py\nx\n\ny\n```\n## B"),
    ["# A", "text\nmore", "```py\nx\n\ny\n```", "## B"]);
});

test("a backend paragraph Companion already shows is left out, with its now empty heading", () => {
  const companion = "### Robot Documentation Preview\n\n**Title:** Local Step  \n**Owner:** Local Step\n\n---\n\n" +
    "A local keyword used to verify **native** definition navigation.";
  assert.equal(backendHoverRemainder([companion], backendLocalStep), "");
  // A heading stays only if something under it remains.
  assert.equal(backendHoverRemainder([companion], backendLocalStep + "\n#### Arguments:\n\nvalue"),
    "### Keyword *Local Step*\n\n#### Arguments:\n\nvalue");
});

test("backend documentation stays when Companion shows other content", () => {
  const companion = "### Robot Return Hint\n\n**Variable:** ${record}  \n**Keyword:** Build Record";
  const backend = "### Keyword *Build Record*\n\n#### Arguments: \n\n| | | | |\n|:--|:--|:--|:--|\n| `name`| : `str` | = | `Ada` |\n\n" +
    "**Return Type**: `Record`\n\n\n#### Documentation:\nBuild a record for the isolated editor audit.\n";
  const remainder = backendHoverRemainder([companion], backend);
  assert.match(remainder, /^### Keyword \*Build Record\*/);
  assert.match(remainder, /#### Documentation:\n\nBuild a record for the isolated editor audit\./);
  assert.match(remainder, /\| `name`\| : `str`/);
  assert.equal(backendHoverRemainder([], backend).split("Build a record").length, 2, "nothing is repeated");
  assert.equal(backendHoverRemainder(["anything"], ""), "");
});

test("a server hover that is only a heading is content, unless Companion shows it", () => {
  assert.equal(backendHoverRemainder(["### Robot Return Hint\n\n**Variable:** ${record}"], "### Local Variable `${record}`\n\n\n"),
    "### Local Variable `${record}`");
  assert.equal(backendHoverRemainder(["### Local Variable `${record}`"], "### Local Variable `${record}`"), "");
  assert.equal(backendHoverRemainder([], "## A\n### B\n## C\ntext"), "## A\n\n### B\n\n## C\n\ntext");
});

test("backend completions repeating a Companion completion are left out", () => {
  const companion = [{ label: "${record}", insertText: "${record}" }, { label: "OPEN" }];
  const backend = [{ label: "${record}" }, { label: { label: "open" } }, { label: "${SUITE_VALUE}" },
    { label: "Build Record", insertText: { value: "Build Record" } }];
  assert.deepEqual(uniqueBackendCompletions(companion, backend).map(item => item.label), ["${SUITE_VALUE}", "Build Record"]);
  assert.deepEqual(uniqueBackendCompletions([], backend), backend);
  assert.deepEqual(uniqueBackendCompletions(undefined, undefined), []);
});

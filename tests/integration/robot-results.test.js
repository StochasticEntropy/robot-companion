"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readTestResults } = require("../../src/integration/robot-results");

test("output.xml per-test status uses the test's own status, not nested keyword statuses", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<robot generator="Robot 7.5"><suite id="s1" name="B" source="/ws/b.robot">
<test id="s1-t1" name="A &amp; B" line="3"><kw name="Fail"><msg>x</msg><status status="FAIL">inner</status></kw>
<status status="FAIL" start="2026">x &lt; 1</status></test>
<test id="s1-t2" name="Skipped" line="7"><status status="SKIP"/></test>
<suite id="s1-s1" name="Nested" source="/ws/n/c.robot"><test id="s1-s1-t1" name="Ä Pass" line="2">
<kw name="Log"><status status="PASS"></status></kw><status status="PASS"></status></test></suite>
<status status="FAIL"/></suite><statistics><suite><stat id="s1" name="B">B</stat></suite></statistics></robot>`;
  assert.deepEqual(readTestResults(xml), [
    { source: "/ws/b.robot", name: "A & B", id: "s1-t1", line: 3, status: "FAIL", message: "x < 1" },
    { source: "/ws/b.robot", name: "Skipped", id: "s1-t2", line: 7, status: "SKIP", message: "" },
    { source: "/ws/n/c.robot", name: "Ä Pass", id: "s1-s1-t1", line: 2, status: "PASS", message: "" }
  ]);
  assert.deepEqual(readTestResults("<robot></robot>"), []);
});

const assert = require("assert");
const path = require("path");
const core = require("../src/features/run/runner-core");

// Mirrors Robot Framework's name matcher (robot.utils.match.Matcher): the
// pattern and the name are compared case- and space-insensitively, and the
// pattern is a glob translated like Python's fnmatch.translate.
function robotNameMatches(pattern, name) {
  const normalize = (value) => value.toLowerCase().replace(/\s+/g, "");
  const glob = normalize(pattern);
  let regex = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      regex += ".*";
    } else if (character === "?") {
      regex += ".";
    } else if (character === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        regex += "\\[";
      } else {
        let set = glob.slice(index + 1, close);
        set = set.startsWith("!") ? `^${set.slice(1)}` : set;
        regex += `[${set.replace(/\\/g, "\\\\")}]`;
        index = close;
      }
    } else {
      regex += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`, "s").test(normalize(name));
}

function runCommandParsingTests() {
  assert.deepStrictEqual(core.parseRobotCommand("robot"), { executable: "robot", args: [] });
  assert.deepStrictEqual(core.parseRobotCommand("  python3 -m robot  "), {
    executable: "python3",
    args: ["-m", "robot"]
  });
  assert.deepStrictEqual(core.parseRobotCommand('"/opt/my tools/venv/bin/robot"'), {
    executable: "/opt/my tools/venv/bin/robot",
    args: []
  });
  assert.deepStrictEqual(core.parseRobotCommand("'/opt/my tools/python' -m robot"), {
    executable: "/opt/my tools/python",
    args: ["-m", "robot"]
  });
  assert.deepStrictEqual(core.parseRobotCommand('"C:\\Program Files\\Python\\python.exe" -m robot'), {
    executable: "C:\\Program Files\\Python\\python.exe",
    args: ["-m", "robot"]
  });
  assert.deepStrictEqual(core.parseRobotCommand("/usr/local/bin/robot"), {
    executable: "/usr/local/bin/robot",
    args: []
  });
  assert.throws(() => core.parseRobotCommand(""), /robotCompanion\.robotCommand is empty/);
  assert.throws(() => core.parseRobotCommand("   "), /robotCompanion\.robotCommand is empty/);
  assert.throws(() => core.parseRobotCommand(undefined), /is empty/);
  assert.throws(() => core.parseRobotCommand('"/opt/robot'), /unclosed " quote/);
  assert.throws(() => core.parseRobotCommand('"" -m robot'), /does not name an executable/);
}

function runArgumentBuildingTests() {
  const suitePath = path.join("/work", "suite with space.robot");
  const single = core.buildRobotRunInvocation({
    command: "python3 -m robot",
    robotArguments: ["--loglevel", "DEBUG", 7, ""],
    outputDir: "/results/run-1",
    testName: "Login Works",
    suitePath
  });
  assert.deepStrictEqual(single, {
    executable: "python3",
    args: ["-m", "robot", "--loglevel", "DEBUG", "--outputdir", "/results/run-1", "--test", "Login Works", suitePath]
  });

  const suite = core.buildRobotRunInvocation({
    command: "robot",
    robotArguments: undefined,
    outputDir: "/results/run-2",
    testName: undefined,
    suitePath
  });
  assert.deepStrictEqual(suite.args, ["--outputdir", "/results/run-2", suitePath]);
  assert(!suite.args.includes("--test"), "a suite run selects no single test");

  // Shell metacharacters stay one literal argument: there is no shell.
  const hostile = core.buildRobotRunInvocation({
    command: "robot",
    outputDir: "/r",
    testName: "Name; rm -rf ~ && $(whoami) `id` | cat",
    suitePath
  });
  assert.strictEqual(hostile.args[hostile.args.indexOf("--test") + 1], "Name; rm -rf ~ && $(whoami) `id` | cat");

  assert.strictEqual(core.escapeRobotNamePattern("Sum * Check"), "Sum [*] Check");
  assert.strictEqual(core.escapeRobotNamePattern("What?"), "What[?]");
  assert.strictEqual(core.escapeRobotNamePattern("Option [x]"), "Option [[]x]");
  assert.strictEqual(core.escapeRobotNamePattern("Plain Name"), "Plain Name");
}

function runSpecialNameSelectionTests() {
  const names = [
    "Sum * Check",
    "Sum Total Check",
    "Option [x]",
    "Option x",
    "What?",
    "Whats",
    "Login Works",
    "Login Works Again",
    "Brackets ] only"
  ];
  for (const name of names) {
    const pattern = core.escapeRobotNamePattern(name);
    const selected = names.filter((candidate) => robotNameMatches(pattern, candidate));
    assert.deepStrictEqual(selected, [name], `--test ${pattern} must select only "${name}"`);
  }
  // The unescaped names really are patterns that would select other tests.
  assert(robotNameMatches("Sum * Check", "Sum Total Check"));
  assert(robotNameMatches("Option [x]", "Option x"));
  assert(robotNameMatches("What?", "Whats"));
}

function runExitInterpretationTests() {
  const test = { testName: "Login Works", suiteLabel: "login.robot" };
  const suite = { testName: undefined, suiteLabel: "login.robot" };

  let result = core.interpretRobotRunExit({ exitCode: 0, producedResults: true, target: test, commandText: "robot" });
  assert.strictEqual(result.outcome, "passed");
  assert.strictEqual(result.message, 'Test "Login Works" passed.');

  result = core.interpretRobotRunExit({ exitCode: 0, producedResults: true, target: suite, commandText: "robot" });
  assert.strictEqual(result.message, 'Suite "login.robot" passed.');

  result = core.interpretRobotRunExit({ exitCode: 1, producedResults: true, target: test, commandText: "robot" });
  assert.strictEqual(result.outcome, "failed");
  assert.strictEqual(result.failedCount, 1);
  assert.strictEqual(result.message, 'Test "Login Works": 1 test failed.');

  result = core.interpretRobotRunExit({ exitCode: 3, producedResults: true, target: suite, commandText: "robot" });
  assert.strictEqual(result.message, 'Suite "login.robot": 3 tests failed.');

  result = core.interpretRobotRunExit({ exitCode: 250, producedResults: true, target: suite, commandText: "robot" });
  assert.strictEqual(result.outcome, "failed");
  assert.strictEqual(result.message, 'Suite "login.robot": 250 or more tests failed.');

  for (const [exitCode, hint] of [
    [251, "help or version information was printed"],
    [252, "invalid test data or command line options"],
    [253, "execution was stopped by the user"],
    [255, "unexpected internal error"]
  ]) {
    result = core.interpretRobotRunExit({ exitCode, producedResults: false, target: test, commandText: "robot" });
    assert.strictEqual(result.outcome, "error");
    assert.strictEqual(
      result.message,
      `Robot Framework could not run test "Login Works": exit code ${exitCode} (${hint}). See the output for details.`
    );
  }
  result = core.interpretRobotRunExit({ exitCode: 254, producedResults: false, target: suite, commandText: "robot" });
  assert.strictEqual(result.message, 'Robot Framework could not run suite "login.robot": exit code 254. See the output for details.');

  // `python3 -m robot` without robotframework exits 1 but writes no results.
  result = core.interpretRobotRunExit({ exitCode: 1, producedResults: false, target: test, commandText: "python3" });
  assert.strictEqual(result.outcome, "error");
  assert.match(result.message, /exit code 1 and no results were written/);

  result = core.interpretRobotRunExit({ exitCode: null, signal: "SIGTERM", target: suite, commandText: "robot" });
  assert.strictEqual(result.outcome, "error");
  assert.strictEqual(result.message, 'Robot Framework run of suite "login.robot" was stopped by signal SIGTERM.');

  const enoent = Object.assign(new Error("spawn robot ENOENT"), { code: "ENOENT" });
  result = core.interpretRobotRunExit({ spawnError: enoent, target: test, commandText: "robot" });
  assert.strictEqual(result.outcome, "error");
  assert.strictEqual(
    result.message,
    "Robot Framework command 'robot' was not found. Install robotframework (pip install robotframework) or set robotCompanion.robotCommand."
  );

  const eacces = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  result = core.interpretRobotRunExit({ spawnError: eacces, target: test, commandText: "/opt/robot" });
  assert.strictEqual(result.message, "Robot Framework command '/opt/robot' could not be started (EACCES). Check robotCompanion.robotCommand.");
}

function runTestCaseDiscoveryTests() {
  const source = [
    "*** Settings ***",
    "Documentation    Suite docs",
    "",
    "*** Test Cases ***",
    "Login Works",
    "    [Documentation]    Logs in",
    "    Log    ok",
    "",
    "# a comment in column one",
    "Sum * Check\t[Tags]    smoke",
    "    Log    sum",
    "...    continued",
    "",
    "*** Keywords ***",
    "Helper Keyword",
    "    Log    helper",
    "",
    "*** Tasks ***",
    "Nightly Task",
    "    Log    task",
    "| Pipe Test | Log | piped |",
    "|           | Log | step  |"
  ].join("\n");
  const { sections, tests } = core.findRobotTestCases(source);
  assert.deepStrictEqual(sections, [{ line: 3 }, { line: 17 }]);
  assert.deepStrictEqual(
    tests.map((test) => [test.name, test.line, test.endLine]),
    [
      ["Login Works", 4, 8],
      ["Sum * Check", 9, 12],
      ["Nightly Task", 18, 19],
      ["Pipe Test", 20, 21]
    ]
  );
  assert.strictEqual(core.findTestAtLine(tests, 6).name, "Login Works");
  assert.strictEqual(core.findTestAtLine(tests, 11).name, "Sum * Check");
  assert.strictEqual(core.findTestAtLine(tests, 3), undefined, "the header line is not inside a test");
  assert.strictEqual(core.findTestAtLine(tests, 15), undefined, "a keyword body is not inside a test");
  assert.strictEqual(core.findTestAtLine(tests, 1), undefined);

  const variants = core.findRobotTestCases("\uFEFF***Test Case***\nOnly Test\n    No Operation\n*** comments ***\nNot A Test\n");
  assert.deepStrictEqual(variants.tests.map((test) => test.name), ["Only Test"]);
  assert.deepStrictEqual(variants.tests[0].endLine, 2);

  const resourceLike = core.findRobotTestCases("*** Keywords ***\nHelper\n    Log    x\n");
  assert.deepStrictEqual(resourceLike, { sections: [], tests: [] });
  assert.deepStrictEqual(core.findRobotTestCases("*** Test Cases ***\n\n"), { sections: [{ line: 0 }], tests: [] });

  assert(core.isRobotSuitePath("/a/b/suite.robot"));
  assert(core.isRobotSuitePath("C:\\a\\Suite.ROBOT"));
  assert(!core.isRobotSuitePath("/a/b/keywords.resource"));
}

function runWorkingDirectoryAndDisplayTests() {
  assert.strictEqual(core.resolveRunWorkingDirectory("/workspace", "/workspace/tests/a.robot"), "/workspace");
  assert.strictEqual(core.resolveRunWorkingDirectory(undefined, "/elsewhere/tests/a.robot"), "/elsewhere/tests");
  assert.strictEqual(
    core.formatCommandLine("robot", ["--outputdir", "/r/1", "--test", "Sum [*] Check", "/w/it's.robot"]),
    "robot --outputdir /r/1 --test 'Sum [*] Check' '/w/it'\\''s.robot'"
  );
  assert.strictEqual(core.buildRunDirectoryName(new Date(2026, 9, 15, 9, 5, 7, 42)), "20261015-090507-042");
}

runCommandParsingTests();
runArgumentBuildingTests();
runSpecialNameSelectionTests();
runExitInterpretationTests();
runTestCaseDiscoveryTests();
runWorkingDirectoryAndDisplayTests();
console.log("run-robot tests passed");

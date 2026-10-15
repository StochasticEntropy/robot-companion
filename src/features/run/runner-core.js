"use strict";

// Pure helpers for running Robot Framework from the editor. Nothing here
// touches VS Code or starts a process, so plain node tests can cover the
// command parsing, argument building and exit-code rules on their own.

const path = require("path");

const DEFAULT_ROBOT_COMMAND = "robot";
const ROBOT_COMMAND_SETTING = "robotCompanion.robotCommand";
const ROBOT_MAX_FAILED_EXIT_CODE = 250;
const ROBOT_EXIT_CODE_HINTS = Object.freeze({
  251: "help or version information was printed",
  252: "invalid test data or command line options",
  253: "execution was stopped by the user",
  255: "unexpected internal error"
});
const TEST_SECTION_NAMES = new Set(["test cases", "test case", "tasks", "task"]);

// Splits the robotCommand setting into an executable and its leading
// arguments. Whitespace separates words; single or double quotes keep a word
// with spaces together. Backslashes are literal so Windows paths survive.
function parseRobotCommand(commandText) {
  const text = String(commandText ?? "").trim();
  if (!text) {
    throw new Error(`${ROBOT_COMMAND_SETTING} is empty. Set it to a Robot Framework command such as 'robot'.`);
  }

  const words = [];
  let current = "";
  let inWord = false;
  let quote = "";
  for (const character of text) {
    if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += character;
    inWord = true;
  }
  if (quote) {
    throw new Error(`${ROBOT_COMMAND_SETTING} has an unclosed ${quote} quote: ${text}`);
  }
  if (inWord) {
    words.push(current);
  }
  if (!words[0]) {
    throw new Error(`${ROBOT_COMMAND_SETTING} does not name an executable: ${text}`);
  }
  return {
    executable: words[0],
    args: words.slice(1)
  };
}

function normalizeRobotArguments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string" && entry.length > 0);
}

// Robot Framework treats --test values as glob patterns (`*`, `?`, `[...]`).
// Wrapping each special character in brackets makes it match only itself, so
// the selection names exactly one test instead of a family of them.
function escapeRobotNamePattern(name) {
  return String(name ?? "").replace(/[*?[]/g, (character) => `[${character}]`);
}

function buildRobotRunInvocation({ command, robotArguments, outputDir, testName, suitePath }) {
  const parsed = typeof command === "string" ? parseRobotCommand(command) : command;
  const args = [...parsed.args, ...normalizeRobotArguments(robotArguments), "--outputdir", outputDir];
  if (testName !== undefined && testName !== null) {
    args.push("--test", escapeRobotNamePattern(testName));
  }
  args.push(suitePath);
  return {
    executable: parsed.executable,
    args
  };
}

function quoteCommandLineWord(word) {
  const text = String(word);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// Display form only: the process itself is started without a shell.
function formatCommandLine(executable, args) {
  return [executable, ...args].map(quoteCommandLineWord).join(" ");
}

function resolveRunWorkingDirectory(workspaceFolderPath, suitePath) {
  return workspaceFolderPath || path.dirname(suitePath);
}

function describeRunTarget(target) {
  return target.testName !== undefined && target.testName !== null
    ? `test "${target.testName}"`
    : `suite "${target.suiteLabel}"`;
}

function formatFailedCount(exitCode) {
  if (exitCode >= ROBOT_MAX_FAILED_EXIT_CODE) {
    return `${ROBOT_MAX_FAILED_EXIT_CODE} or more tests failed`;
  }
  return exitCode === 1 ? "1 test failed" : `${exitCode} tests failed`;
}

// Turns a finished (or failed-to-start) process into the one result the user
// sees. Robot Framework's exit code is the number of failed tests up to 250;
// 251 and above mean it could not run the tests at all.
function interpretRobotRunExit({ exitCode, signal, spawnError, producedResults, target, commandText }) {
  const subject = describeRunTarget(target);
  const capitalSubject = subject.charAt(0).toUpperCase() + subject.slice(1);

  if (spawnError) {
    const errorCode = spawnError.code || "";
    if (errorCode === "ENOENT") {
      return {
        outcome: "error",
        message: `Robot Framework command '${commandText}' was not found. Install robotframework (pip install robotframework) or set ${ROBOT_COMMAND_SETTING}.`
      };
    }
    return {
      outcome: "error",
      message: `Robot Framework command '${commandText}' could not be started (${errorCode || spawnError.message}). Check ${ROBOT_COMMAND_SETTING}.`
    };
  }

  if (signal) {
    return {
      outcome: "error",
      message: `Robot Framework run of ${subject} was stopped by signal ${signal}.`
    };
  }

  if (exitCode === 0) {
    return {
      outcome: "passed",
      failedCount: 0,
      message: `${capitalSubject} passed.`
    };
  }

  if (Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= ROBOT_MAX_FAILED_EXIT_CODE) {
    if (!producedResults) {
      // A missing interpreter module (`python3 -m robot` without robotframework)
      // also exits with 1; without any result file it is not a test failure.
      return {
        outcome: "error",
        message: `Robot Framework could not run ${subject}: exit code ${exitCode} and no results were written. See the output for details.`
      };
    }
    return {
      outcome: "failed",
      failedCount: exitCode,
      message: `${capitalSubject}: ${formatFailedCount(exitCode)}.`
    };
  }

  const hint = ROBOT_EXIT_CODE_HINTS[exitCode];
  return {
    outcome: "error",
    message: `Robot Framework could not run ${subject}: exit code ${exitCode}${hint ? ` (${hint})` : ""}. See the output for details.`
  };
}

function isRobotSuitePath(filePath) {
  return path.extname(String(filePath || "")).toLowerCase() === ".robot";
}

function splitRobotCells(line) {
  if (/^\|(\s|$)/.test(line)) {
    return line
      .replace(/^\|\s*/, "")
      .split(/\s+\|(?:\s+|$)/)
      .map((cell) => cell.trim());
  }
  return line.split(/\t| {2,}/).map((cell) => cell.trim());
}

function readSectionName(firstCell) {
  if (!firstCell.startsWith("*")) {
    return undefined;
  }
  return firstCell.replace(/^[*\s]+|[*\s]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}

// Finds the runnable tests of a .robot file: every name line in a
// `*** Test Cases ***` or `*** Tasks ***` section, with the line range the
// test body covers. Section headers are returned for the "Run Suite" lens.
function findRobotTestCases(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const sections = [];
  const tests = [];
  let inTestSection = false;
  let currentTest;

  const closeCurrentTest = (endLine) => {
    if (currentTest) {
      currentTest.endLine = Math.max(currentTest.line, endLine);
      tests.push(currentTest);
      currentTest = undefined;
    }
  };

  lines.forEach((rawLine, lineIndex) => {
    const line = lineIndex === 0 ? rawLine.replace(/^﻿/, "") : rawLine;
    const firstCell = splitRobotCells(line)[0] || "";
    const sectionName = readSectionName(firstCell);
    if (sectionName !== undefined) {
      closeCurrentTest(lineIndex - 1);
      inTestSection = TEST_SECTION_NAMES.has(sectionName);
      if (inTestSection) {
        sections.push({ line: lineIndex });
      }
      return;
    }
    if (!inTestSection) {
      return;
    }
    const startsInFirstColumn = /^\|\s*[^\s|]/.test(line) || /^[^\s|]/.test(line);
    if (!startsInFirstColumn || firstCell.startsWith("#") || firstCell === "..." || !firstCell) {
      return;
    }
    closeCurrentTest(lineIndex - 1);
    currentTest = { name: firstCell, line: lineIndex, endLine: lineIndex };
  });
  closeCurrentTest(lines.length - 1);

  return { sections, tests };
}

function findTestAtLine(tests, line) {
  return tests.find((test) => line >= test.line && line <= test.endLine);
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function buildRunDirectoryName(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  );
}

module.exports = {
  DEFAULT_ROBOT_COMMAND,
  ROBOT_COMMAND_SETTING,
  parseRobotCommand,
  normalizeRobotArguments,
  escapeRobotNamePattern,
  buildRobotRunInvocation,
  formatCommandLine,
  resolveRunWorkingDirectory,
  describeRunTarget,
  interpretRobotRunExit,
  isRobotSuitePath,
  findRobotTestCases,
  findTestAtLine,
  buildRunDirectoryName
};

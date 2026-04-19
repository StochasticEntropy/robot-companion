const path = require("path");
const crypto = require("crypto");
const os = require("os");
const vscode = require("vscode");

const EXT_CONFIG_ROOT = "robotCompanion";
const VIEW_ID = "robotCompanion.view";
const RETURN_VIEW_ID = "robotCompanion.returnView";

const CMD_TOGGLE = "robotCompanion.toggle";
const CMD_OPEN_CURRENT_BLOCK = "robotCompanion.openCurrentBlock";
const CMD_OPEN_BLOCK_AT = "robotCompanion.openBlockAt";
const CMD_INVALIDATE_CACHES = "robotCompanion.invalidateCaches";
const CMD_OPEN_LOCATION = "robotCompanion.openLocation";
const CMD_PREVIEW_KEYWORD_ARGUMENT = "robotCompanion.previewKeywordArgument";
const CMD_INSERT_KEYWORD_ARGUMENT = "robotCompanion.insertKeywordArgument";
const CMD_EXPORT_DOCUMENTATION_MARKDOWN = "robotCompanion.exportDocumentationMarkdown";
const CMD_EXPORT_DOCUMENTATION_PDF = "robotCompanion.exportDocumentationPdf";
const CMD_EXPORT_DOCUMENTATION_SELECTED_MARKDOWN = "robotCompanion.exportDocumentationSelectedMarkdown";
const CMD_EXPORT_DOCUMENTATION_SELECTED_PDF = "robotCompanion.exportDocumentationSelectedPdf";
const CMD_SHOW_OUTPUT = "robotCompanion.showOutput";
const CMD_USE_AS_DEFAULT_FOLDING_PROVIDER = "robotCompanion.useAsDefaultFoldingProvider";
const CMD_FOLD_DOCUMENTATION_TO_HEADLINES = "robotCompanion.foldDocumentationToHeadlines";
const CMD_FOLD_DOCUMENTATION_TO_STEPS = "robotCompanion.foldDocumentationToSteps";
const CMD_FOLD_DOCUMENTATION_TO_FIRST_LEVEL = "robotCompanion.foldDocumentationToFirstLevel";
const CMD_FOLD_DOCUMENTATION_TO_SECOND_LEVEL = "robotCompanion.foldDocumentationToSecondLevel";
const CMD_UNFOLD_DOCUMENTATION = "robotCompanion.unfoldDocumentation";
const CMD_FOLD_DOCUMENTATION_OVERVIEW = "robotCompanion.foldDocumentationOverview";
const CMD_UNFOLD_DOCUMENTATION_OVERVIEW = "robotCompanion.unfoldDocumentationOverview";
const ROBOT_COMPANION_EXTENSION_ID = "StochasticEntropy.robot-markdown-companion";
const DOCUMENTATION_BODY_FOLD_TIER = Object.freeze({
  HEADLINES: 1,
  FIRST_LEVEL: 2,
  SECOND_LEVEL: 3,
  STEPS: 4
});
const DOCUMENTATION_FOLDING_REFRESH_DELAY_MS = 20;
let activeDocumentationBodyFoldState = {
  documentUri: "",
  tier: null
};

const ROBOT_SELECTOR = [
  { language: "robotframework" },
  { pattern: "**/*.robot" },
  { pattern: "**/*.resource" }
];
const ARROW_INDENT_TOKEN_PATTERN = /\[\[RDP_INDENT_(\d+)\]\]/g;
const DOCUMENTATION_COLOR_SEMANTIC_TAGS = Object.freeze([
  "note",
  "question",
  "warning",
  "error",
  "success"
]);
const DOCUMENTATION_COLOR_NAMED_VALUES = Object.freeze({
  red: "#b42318",
  orange: "#c2410c",
  yellow: "#a16207",
  green: "#15803d",
  blue: "#1d4ed8",
  purple: "#7e22ce",
  gray: "#4b5563"
});
const ROBOT_CONTROL_CELLS = new Set([
  "if",
  "else",
  "else if",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "return",
  "continue",
  "break",
  "end"
]);
const PYTHON_IGNORED_TYPE_TOKENS = new Set([
  "any",
  "annotated",
  "bool",
  "bytes",
  "callable",
  "classvar",
  "date",
  "datetime",
  "decimal",
  "deque",
  "dict",
  "float",
  "frozenset",
  "generic",
  "int",
  "iterable",
  "iterator",
  "list",
  "literal",
  "mapping",
  "nocheck",
  "no_check",
  "none",
  "optional",
  "relation",
  "self",
  "sequence",
  "set",
  "str",
  "tuple",
  "type",
  "typealias",
  "typing",
  "unset",
  "unsetcamunda",
  "sentinel",
  "baseconfig",
  "camelcasebase",
  "union"
]);
const SIMPLE_RETURN_IGNORED_FIELD_NAMES = new Set([
  "additional_properties",
  "field_dict",
  "note",
  "todo",
  "validierungen",
  "validation"
]);
const DEFAULT_INDEX_IMPORT_FOLDER_PATTERNS = ["**"];
const DEFAULT_INDEX_EXCLUDE_FOLDER_PATTERNS = [
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "tests"
];
const CONVERT_UMLAUT_DECORATION_FILE_SUFFIX = "/Common/Libs/common/decoration.py";
const FALLBACK_CONVERT_UMLAUT_EXCLUDE_KEYS = Object.freeze([
  "aktuell",
  "erwarteteAnzahl",
  "dauer",
  "erneuern",
  "erneuerung",
  "faedn",
  "individuell",
  "manuell",
  "quell",
  "quelldaten",
  "request",
  "steuer",
  "updateAm",
  "uvaErfuellt",
  "value",
  "bruttoentgelt",
  "neuer"
]);
const CONVERT_UMLAUT_REPLACEMENTS = Object.freeze({
  ae: "ä",
  oe: "ö",
  ue: "ü",
  Ae: "Ä",
  Oe: "Ö",
  Ue: "Ü"
});
const GLOB_MAGIC_PATTERN = /[*?\[\]{}]/;
const RETURN_SUBTYPE_RESOLUTION_MODES = new Set(["always", "never", "include", "exclude"]);
const RETURN_FIELD_NAME_STYLES = new Set(["camelcase", "snake_case", "both"]);
const UNLIMITED_RETURN_FIELDS_PER_TYPE = Number.MAX_SAFE_INTEGER;
const ENUM_COMPLETION_DISPLAY_MODES = new Set(["name", "value", "both"]);
const ROBOT_COMPANION_LOG_LEVELS = new Set(["off", "error", "warn", "info", "debug", "trace"]);
const ROBOT_COMPANION_LOG_LEVEL_RANKS = new Map([
  ["off", -1],
  ["error", 0],
  ["warn", 1],
  ["info", 2],
  ["debug", 3],
  ["trace", 4]
]);
const BUILTIN_INDEXABLE_RETURN_CONTAINERS = new Set([
  "list",
  "tuple",
  "set",
  "frozenset",
  "sequence",
  "iterable",
  "iterator",
  "deque",
  "listwrapper"
]);
const PREWARM_MODES = new Set(["active", "allOpen"]);
const PREWARM_IDLE_REQUIRED_MS = 350;
const PREWARM_RESUME_CHECK_MS = 80;
const PREWARM_DEFAULT_DELAY_MS = 25;
const INTERACTIVE_IDLE_WAIT_MS = 2800;
const BACKGROUND_TASK_MAX_WAIT_MS = 15000;
const HOVER_CACHE_MISS_FALLBACK_DELAY_MS = 45;
const RUNTIME_CACHE_MAX_ENTRIES_PER_BUCKET = 1200;
const RUNTIME_HTML_CACHE_MAX_ENTRIES = 400;
const MEMBER_COMPLETION_MEMO_MAX_ENTRIES = 800;
const ENUM_COMPLETION_MAX_ITEMS = 240;
const RETURN_TYPE_CACHE_DIR = "return-type-cache";
const RETURN_TYPE_DISK_CACHE_SCHEMA_VERSION = 2;
const RETURN_TYPE_DISK_WRITE_DEBOUNCE_MS = 450;
const RETURN_TYPE_CACHE_MAX_ENTRIES_DEFAULT = 400;
const DEBUG_PAUSED_INFO_MESSAGE =
  "Robot Companion editor actions are limited while a Robot debug session is active. Hovers, preview, documentation views, and keyword argument Insert remain available.";
let ROBOT_DEBUG_PAUSED = false;
let ROBOT_COMPANION_OUTPUT_CHANNEL = undefined;

function getRobotCompanionOutputChannel() {
  if (!ROBOT_COMPANION_OUTPUT_CHANNEL) {
    ROBOT_COMPANION_OUTPUT_CHANNEL = vscode.window.createOutputChannel("Robot Companion");
  }
  return ROBOT_COMPANION_OUTPUT_CHANNEL;
}

function appendRobotCompanionOutput(level, message, details = undefined) {
  if (!isRobotCompanionLogLevelEnabled(level)) {
    return;
  }
  const channel = getRobotCompanionOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`[${timestamp}] [${String(level || "INFO").toUpperCase()}] ${String(message || "")}`);
  const formattedDetails = formatRobotCompanionLogDetails(details);
  if (formattedDetails) {
    for (const line of formattedDetails.split(/\r?\n/)) {
      channel.appendLine(`  ${line}`);
    }
  }
}

function isRobotCompanionLogLevelEnabled(level) {
  const requestedLevel = String(level || "info").trim().toLowerCase();
  const configuredLevel = getRobotCompanionLogLevel();
  const requestedRank = ROBOT_COMPANION_LOG_LEVEL_RANKS.get(requestedLevel);
  const configuredRank = ROBOT_COMPANION_LOG_LEVEL_RANKS.get(configuredLevel);
  if (!Number.isFinite(requestedRank) || !Number.isFinite(configuredRank)) {
    return true;
  }
  return configuredRank >= requestedRank;
}

function formatRobotCompanionLogDetails(details) {
  if (details === undefined || details === null || details === "") {
    return "";
  }
  if (details instanceof Error) {
    return details.stack || details.message || String(details);
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(
      details,
      (_key, value) => {
        if (value instanceof Map) {
          return Object.fromEntries(value);
        }
        if (value instanceof Set) {
          return [...value];
        }
        if (value instanceof Error) {
          return {
            message: value.message,
            stack: value.stack
          };
        }
        return value;
      },
      2
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function logRobotCompanionInfo(message, details = undefined) {
  appendRobotCompanionOutput("info", message, details);
}

function logRobotCompanionDebug(message, details = undefined) {
  appendRobotCompanionOutput("debug", message, details);
}

function logRobotCompanionTrace(message, details = undefined) {
  appendRobotCompanionOutput("trace", message, details);
}

function logRobotCompanionWarning(message, details = undefined) {
  appendRobotCompanionOutput("warn", message, details);
  if (details instanceof Error) {
    console.warn(`[robot-companion] ${message}:`, details.stack || details.message);
    return;
  }
  if (details !== undefined) {
    console.warn(`[robot-companion] ${message}:`, details);
    return;
  }
  console.warn(`[robot-companion] ${message}`);
}

function logRobotCompanionError(message, error, details = undefined) {
  appendRobotCompanionOutput("error", message, {
    ...(details && typeof details === "object" ? details : details ? { details: String(details) } : {}),
    error:
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack
          }
        : String(error || "")
  });
  console.warn(`[robot-companion] ${message}:`, error instanceof Error ? error.stack || error.message : error);
}

function showRobotCompanionOutput(preserveFocus = true) {
  getRobotCompanionOutputChannel().show(Boolean(preserveFocus));
}

async function useRobotCompanionAsDefaultFoldingProvider() {
  const hasWorkspace = Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 0;
  const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const configuration = vscode.workspace.getConfiguration();
  const existingOverride = configuration.get("[robotframework]", {});
  const nextOverride =
    existingOverride && typeof existingOverride === "object" && !Array.isArray(existingOverride)
      ? { ...existingOverride }
      : {};

  nextOverride["editor.foldingStrategy"] = "auto";
  nextOverride["editor.defaultFoldingRangeProvider"] = ROBOT_COMPANION_EXTENSION_ID;

  await configuration.update("[robotframework]", nextOverride, target);
  const scopeLabel = target === vscode.ConfigurationTarget.Workspace ? "workspace" : "user";
  void vscode.window.showInformationMessage(
    `Robot Companion is now the default folding provider for Robot files in this ${scopeLabel}.`
  );
}

function uniqueSortedNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => Math.max(0, Number(value) || 0)))].sort(
    (left, right) => left - right
  );
}

function getDocumentationBodyFoldTierForCandidate(candidate) {
  if (String(candidate?.kind || "") === "heading" || String(candidate?.sourceKind || "") === "documentation") {
    return DOCUMENTATION_BODY_FOLD_TIER.HEADLINES;
  }
  return (Number(candidate?.markerDepth) || 0) > 0
    ? DOCUMENTATION_BODY_FOLD_TIER.SECOND_LEVEL
    : DOCUMENTATION_BODY_FOLD_TIER.FIRST_LEVEL;
}

function normalizeDocumentationBodyFoldTier(tier) {
  const numericTier = Number(tier);
  if (!Number.isFinite(numericTier)) {
    return null;
  }

  return Math.min(
    DOCUMENTATION_BODY_FOLD_TIER.STEPS,
    Math.max(DOCUMENTATION_BODY_FOLD_TIER.HEADLINES, Math.trunc(numericTier))
  );
}

function buildDocumentationBodyFoldingRanges(blocks, targetTier = null) {
  const normalizedTargetTier = normalizeDocumentationBodyFoldTier(targetTier);
  const ranges = [];
  const seenKeys = new Set();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const normalizedCandidates = normalizeDocumentationFoldingCandidates(getDocumentationFoldingCandidates(block));
    for (const candidate of normalizedCandidates) {
      const currentTier = normalizeDocumentationBodyFoldTier(getDocumentationBodyFoldTierForCandidate(candidate));
      const shouldInclude =
        normalizedTargetTier === null ||
        normalizedTargetTier === currentTier ||
        (normalizedTargetTier === DOCUMENTATION_BODY_FOLD_TIER.STEPS &&
          (currentTier === DOCUMENTATION_BODY_FOLD_TIER.FIRST_LEVEL ||
            currentTier === DOCUMENTATION_BODY_FOLD_TIER.SECOND_LEVEL));
      if (!shouldInclude) {
        continue;
      }
      pushDocumentationFoldingRange(ranges, seenKeys, candidate.startLine, candidate.endLine);
    }
  }

  return ranges.sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    return left.endLine - right.endLine;
  });
}

function buildAllDocumentationBodyFoldingRanges(blocks) {
  const ranges = [];
  const seenKeys = new Set();

  for (const tier of [
    DOCUMENTATION_BODY_FOLD_TIER.HEADLINES,
    DOCUMENTATION_BODY_FOLD_TIER.FIRST_LEVEL,
    DOCUMENTATION_BODY_FOLD_TIER.SECOND_LEVEL
  ]) {
    for (const range of buildDocumentationBodyFoldingRanges(blocks, tier)) {
      pushDocumentationFoldingRange(ranges, seenKeys, range.startLine, range.endLine);
    }
  }

  return ranges.sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    return left.endLine - right.endLine;
  });
}

function buildDocumentationOverviewRanges(blocks) {
  return buildAllDocumentationBodyFoldingRanges(blocks);
}

function getActiveDocumentationBodyFoldTier(documentUri) {
  const safeDocumentUri = String(documentUri || "");
  if (!safeDocumentUri || activeDocumentationBodyFoldState.documentUri !== safeDocumentUri) {
    return null;
  }

  const tier = Number(activeDocumentationBodyFoldState.tier);
  return Number.isFinite(tier) ? tier : null;
}

function setActiveDocumentationBodyFoldTier(documentUri, tier) {
  const safeDocumentUri = String(documentUri || "");
  const numericTier = Number(tier);
  if (!safeDocumentUri || !Number.isFinite(numericTier)) {
    activeDocumentationBodyFoldState = {
      documentUri: "",
      tier: null
    };
    return;
  }

  activeDocumentationBodyFoldState = {
    documentUri: safeDocumentUri,
    tier: Math.max(DOCUMENTATION_BODY_FOLD_TIER.HEADLINES, Math.trunc(numericTier))
  };
}

function buildDocumentationWrapperFoldingRanges(blocks) {
  const ranges = [];
  const seenKeys = new Set();
  const sortedBlocks = (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      ...block,
      ownerStartLine: Math.max(0, Number(block?.ownerStartLine) || 0),
      ownerEndLine: Math.max(0, Number(block?.ownerEndLine) || 0),
      section: String(block?.section || "").trim().toLowerCase()
    }))
    .sort((left, right) => left.ownerStartLine - right.ownerStartLine);

  let currentSectionRange = null;

  const flushCurrentSectionRange = () => {
    if (!currentSectionRange) {
      return;
    }
    pushDocumentationFoldingRange(
      ranges,
      seenKeys,
      currentSectionRange.startLine,
      currentSectionRange.endLine
    );
    currentSectionRange = null;
  };

  for (const block of sortedBlocks) {
    pushDocumentationFoldingRange(ranges, seenKeys, block.ownerStartLine, block.ownerEndLine);

    const sectionStartLine = Math.max(0, block.ownerStartLine - 1);
    if (!currentSectionRange) {
      currentSectionRange = {
        section: block.section,
        startLine: sectionStartLine,
        endLine: block.ownerEndLine
      };
      continue;
    }

    const sameSection = currentSectionRange.section === block.section;
    const stillContiguous = sectionStartLine <= currentSectionRange.endLine + 2;
    if (sameSection && stillContiguous) {
      currentSectionRange.endLine = Math.max(currentSectionRange.endLine, block.ownerEndLine);
      continue;
    }

    flushCurrentSectionRange();
    currentSectionRange = {
      section: block.section,
      startLine: sectionStartLine,
      endLine: block.ownerEndLine
    };
  }

  flushCurrentSectionRange();

  return ranges.sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    return left.endLine - right.endLine;
  });
}

function extendDocumentationProviderRangesAcrossBlankLines(ranges, document) {
  if (!document || typeof document.lineAt !== "function") {
    return Array.isArray(ranges) ? ranges : [];
  }

  const sortedRanges = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      startLine: Math.max(0, Number(range?.startLine) || 0),
      endLine: Math.max(0, Number(range?.endLine) || 0)
    }))
    .sort((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return left.endLine - right.endLine;
    });
  const documentLastLine = Math.max(0, Number(document.lineCount) - 1);
  const expandedRanges = [];
  const seenKeys = new Set();

  for (const currentRange of sortedRanges) {
    let nextBlockingStartLine = documentLastLine + 1;
    for (const candidateRange of sortedRanges) {
      if (candidateRange.startLine > currentRange.endLine) {
        nextBlockingStartLine = candidateRange.startLine;
        break;
      }
    }

    let expandedEndLine = currentRange.endLine;
    while (expandedEndLine < documentLastLine && expandedEndLine + 1 < nextBlockingStartLine) {
      const nextLineText = String(document.lineAt(expandedEndLine + 1)?.text || "");
      if (nextLineText.trim().length > 0) {
        break;
      }
      expandedEndLine += 1;
    }

    pushDocumentationFoldingRange(expandedRanges, seenKeys, currentRange.startLine, expandedEndLine);
  }

  return expandedRanges;
}

function buildDocumentationProviderRanges(blocks, document = undefined) {
  const ranges = [];
  const seenKeys = new Set();

  for (const range of buildDocumentationWrapperFoldingRanges(blocks)) {
    pushDocumentationFoldingRange(ranges, seenKeys, range.startLine, range.endLine);
  }

  for (const range of buildDocumentationFoldingRanges(blocks)) {
    pushDocumentationFoldingRange(ranges, seenKeys, range.startLine, range.endLine);
  }

  return extendDocumentationProviderRangesAcrossBlankLines(
    ranges.sort((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return left.endLine - right.endLine;
    }),
    document
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function refreshDocumentationFoldingProvider(foldingRangeProvider) {
  foldingRangeProvider?.refresh?.();
  await delay(DOCUMENTATION_FOLDING_REFRESH_DELAY_MS);
}

async function setDocumentationBodyFoldTierState(documentUri, tier, foldingRangeProvider) {
  setActiveDocumentationBodyFoldTier(documentUri, tier);
  await refreshDocumentationFoldingProvider(foldingRangeProvider);
}

function normalizeProviderCommandRanges(rawRanges, lineOffset = 0) {
  return (Array.isArray(rawRanges) ? rawRanges : [])
    .map((range) => ({
      startLine: Math.max(
        0,
        Number(range?.startLine ?? range?.start) + Number(lineOffset || 0)
      ),
      endLine: Math.max(
        0,
        Number(range?.endLine ?? range?.end) + Number(lineOffset || 0)
      )
    }))
    .filter((range) => Number.isInteger(range.startLine) && Number.isInteger(range.endLine))
    .sort((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return left.endLine - right.endLine;
    });
}

function areDocumentationRangesEqual(leftRanges, rightRanges) {
  if (!Array.isArray(leftRanges) || !Array.isArray(rightRanges) || leftRanges.length !== rightRanges.length) {
    return false;
  }

  for (let index = 0; index < leftRanges.length; index += 1) {
    const left = leftRanges[index];
    const right = rightRanges[index];
    if (left.startLine !== right.startLine || left.endLine !== right.endLine) {
      return false;
    }
  }

  return true;
}

async function runRecursiveFoldAtLines(editor, lines) {
  if (!editor?.document) {
    return;
  }

  const normalizedLines = uniqueSortedNumbers(lines);
  if (normalizedLines.length === 0) {
    return;
  }

  const originalSelections =
    Array.isArray(editor.selections) && editor.selections.length > 0
      ? editor.selections.slice()
      : editor.selection
        ? [editor.selection]
        : [];

  try {
    for (const line of normalizedLines) {
      const focusedEditor = (await focusTextEditor(editor)) || editor;
      const position = new vscode.Position(Math.max(0, line), 0);
      const selection = new vscode.Selection(position, position);
      focusedEditor.selections = [selection];
      focusedEditor.selection = selection;
      await delay(20);
      await vscode.commands.executeCommand("editor.foldRecursively");
      await delay(40);
    }
  } finally {
    if (originalSelections.length > 0) {
      editor.selections = originalSelections;
      editor.selection = originalSelections[0];
      await delay(20);
    }
  }
}

async function waitForDocumentationProviderRanges(editor, expectedRanges, foldingRangeProvider) {
  if (!editor?.document) {
    return false;
  }

  const normalizedExpectedRanges = extendDocumentationProviderRangesAcrossBlankLines(expectedRanges, editor.document);
  if (normalizedExpectedRanges.length === 0) {
    return true;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const rawRanges = await vscode.commands.executeCommand("_executeFoldingRangeProvider", editor.document.uri);
      const normalizedRawRanges = normalizeProviderCommandRanges(rawRanges, 0);
      const normalizedMinusOneRanges = normalizeProviderCommandRanges(rawRanges, -1);
      if (
        areDocumentationRangesEqual(normalizedExpectedRanges, normalizedRawRanges) ||
        areDocumentationRangesEqual(normalizedExpectedRanges, normalizedMinusOneRanges)
      ) {
        return true;
      }
    } catch {
      await delay(25);
      continue;
    }

    foldingRangeProvider?.refresh?.();
    await delay(40);
  }

  return false;
}

async function setDocumentationExactFoldState(foldingRangeProvider, targetTier, targetDocumentUri = "") {
  const resolvedEditor = await resolveRobotEditorForFolding(targetDocumentUri);
  if (
    !resolvedEditor ||
    !isRobotDocument(resolvedEditor.document) ||
    shouldPauseRobotCompanionEditorManipulationForDebug()
  ) {
    return;
  }

  const editor = (await focusTextEditor(resolvedEditor)) || resolvedEditor;
  const documentUri = editor.document.uri?.toString?.() || "";
  const parsed = foldingRangeProvider?._parser?.getParsed?.(editor.document);
  const expectedRanges = buildDocumentationBodyFoldingRanges(parsed?.blocks, targetTier);
  const selectionLines = uniqueSortedNumbers(expectedRanges.map((range) => range?.startLine));
  await setDocumentationBodyFoldTierState("", null, foldingRangeProvider);
  await resetEditorFoldingState(editor);
  await setDocumentationBodyFoldTierState(documentUri, targetTier, foldingRangeProvider);
  await waitForDocumentationProviderRanges(editor, expectedRanges, foldingRangeProvider);
  if (selectionLines.length === 0) {
    return;
  }
  await focusTextEditor(editor);
  await vscode.commands.executeCommand("editor.fold", {
    levels: 1,
    direction: "down",
    selectionLines
  });
  const documentLastLine = Math.max(0, Number(editor.document.lineCount) - 1);
  const terminalSelectionLines = uniqueSortedNumbers(
    expectedRanges
      .filter((range) => Number(range?.endLine) >= documentLastLine)
      .map((range) => range?.startLine)
  );
  if (terminalSelectionLines.length > 0) {
    await runRecursiveFoldAtLines(editor, terminalSelectionLines);
  }
  await delay(75);
}

async function unfoldDocumentationBuiltInState(foldingRangeProvider, targetDocumentUri = "") {
  const resolvedEditor = await resolveRobotEditorForFolding(targetDocumentUri);
  if (
    !resolvedEditor ||
    !isRobotDocument(resolvedEditor.document) ||
    shouldPauseRobotCompanionEditorManipulationForDebug()
  ) {
    return;
  }

  const editor = (await focusTextEditor(resolvedEditor)) || resolvedEditor;
  await setDocumentationBodyFoldTierState("", null, foldingRangeProvider);
  await resetEditorFoldingState(editor);
}

function normalizeCommandDocumentUri(documentUri) {
  if (documentUri instanceof vscode.Uri) {
    return documentUri.toString();
  }
  if (typeof documentUri === "string") {
    return documentUri.trim();
  }
  if (documentUri && typeof documentUri.toString === "function") {
    return String(documentUri.toString() || "").trim();
  }
  return "";
}

async function focusTextEditor(editor) {
  if (!editor?.document) {
    return editor;
  }

  try {
    const focusedEditor = await vscode.window.showTextDocument(editor.document, {
      viewColumn: editor.viewColumn,
      preserveFocus: false,
      preview: false
    });
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await delay(75);
    return focusedEditor;
  } catch {
    return editor;
  }
}

async function resetEditorFoldingState(editor) {
  if (!editor?.document) {
    return;
  }

  await focusTextEditor(editor);

  try {
    await vscode.commands.executeCommand("editor.removeManualFoldingRanges");
  } catch {
    // Older VS Code versions may not expose manual folding range commands.
  }

  await focusTextEditor(editor);
  await vscode.commands.executeCommand("editor.unfoldAll");
  await delay(50);
}

async function resolveRobotEditorForFolding(targetDocumentUri = "") {
  const normalizedTargetDocumentUri = normalizeCommandDocumentUri(targetDocumentUri);

  if (normalizedTargetDocumentUri) {
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (candidate) =>
        candidate?.document &&
        isRobotDocument(candidate.document) &&
        candidate.document.uri.toString() === normalizedTargetDocumentUri
    );
    if (visibleEditor) {
      return visibleEditor;
    }

    let targetDocument = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === normalizedTargetDocumentUri
    );
    if (!targetDocument) {
      try {
        targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(normalizedTargetDocumentUri));
      } catch {
        return undefined;
      }
    }

    if (!isRobotDocument(targetDocument)) {
      return undefined;
    }

    try {
      return await vscode.window.showTextDocument(targetDocument, {
        preview: false,
        preserveFocus: false
      });
    } catch {
      return undefined;
    }
  }

  if (vscode.window.activeTextEditor?.document && isRobotDocument(vscode.window.activeTextEditor.document)) {
    return vscode.window.activeTextEditor;
  }

  return vscode.window.visibleTextEditors.find(
    (candidate) => candidate?.document && isRobotDocument(candidate.document)
  );
}


function shouldTraceReturnResolution(rootTypeNames, simpleAccess, technicalStructureLines) {
  const normalizedTypeNames = uniqueStrings(
    (Array.isArray(rootTypeNames) ? rootTypeNames : [])
      .map((value) => normalizeComparableToken(value))
      .filter(Boolean)
  );
  if (["debug", "trace"].includes(getRobotCompanionLogLevel())) {
    return true;
  }
  if (normalizedTypeNames.length === 0) {
    return true;
  }
  if (normalizedTypeNames.some((value) => value.includes("processinstance"))) {
    return true;
  }
  const firstLevelCount = Array.isArray(simpleAccess?.firstLevel) ? simpleAccess.firstLevel.length : 0;
  const secondLevelCount = Array.isArray(simpleAccess?.secondLevel) ? simpleAccess.secondLevel.length : 0;
  const technicalCount = Array.isArray(technicalStructureLines) ? technicalStructureLines.length : 0;
  return firstLevelCount === 0 && secondLevelCount === 0 && technicalCount === 0;
}

function logReturnResolutionTrace(scope, details) {
  const rootTypeNames = Array.isArray(details?.rootTypeNames) ? details.rootTypeNames : [];
  if (!shouldTraceReturnResolution(rootTypeNames, details?.simpleAccess, details?.technicalStructureLines)) {
    return;
  }
  logRobotCompanionInfo(`Return resolution trace (${scope})`, details);
}

function buildReturnResolutionTypeDebug(index, rootTypeNames, typePreferencesByName) {
  const summaries = [];
  for (const rawTypeName of uniqueStrings(Array.isArray(rootTypeNames) ? rootTypeNames : [])) {
    const typeName = String(rawTypeName || "").trim();
    if (!typeName) {
      continue;
    }
    const candidates = index?.structuredTypesByName?.get(typeName) || [];
    const preferredQualifiedNames = getPreferredQualifiedNamesForType(typePreferencesByName, typeName);
    const selectedType = choosePreferredStructuredTypeDefinition(candidates, {
      preferredQualifiedNames
    });
    summaries.push({
      typeName,
      preferredQualifiedNames,
      candidateCount: candidates.length,
      selectedQualifiedName: String(selectedType?.qualifiedName || ""),
      selectedFieldCount: Array.isArray(selectedType?.fields) ? selectedType.fields.length : 0,
      selectedPropertyCount: Array.isArray(selectedType?.properties) ? selectedType.properties.length : 0,
      selectedBaseTypeNames: uniqueStrings((selectedType?.baseTypeNames || []).map((value) => String(value || ""))),
      selectedBaseTypeRefs: (Array.isArray(selectedType?.baseTypeRefs) ? selectedType.baseTypeRefs : []).map((ref) => ({
        typeName: String(ref?.typeName || ""),
        preferredQualifiedNames: uniqueStrings(
          (Array.isArray(ref?.preferredQualifiedNames) ? ref.preferredQualifiedNames : [])
            .map((value) => String(value || ""))
            .filter(Boolean)
        )
      }))
    });
  }
  return summaries;
}

function normalizeDebugToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isRobotDebugSession(session) {
  if (!session) {
    return false;
  }
  const typeToken = normalizeDebugToken(session.type || session.configuration?.type);
  const nameToken = normalizeDebugToken(session.name || session.configuration?.name);
  return typeToken.includes("robot") || nameToken.includes("robot");
}

function computeRobotDebugPauseState() {
  const sessions = [];
  if (vscode.debug.activeDebugSession) {
    sessions.push(vscode.debug.activeDebugSession);
  }
  for (const session of vscode.debug.sessions || []) {
    sessions.push(session);
  }
  return sessions.some((session) => isRobotDebugSession(session));
}

function updateRobotDebugPauseState() {
  ROBOT_DEBUG_PAUSED = computeRobotDebugPauseState();
  return ROBOT_DEBUG_PAUSED;
}

function isRobotCompanionPausedForDebug() {
  return ROBOT_DEBUG_PAUSED;
}

function shouldPauseRobotCompanionInteractiveUiForDebug() {
  return false;
}

function shouldPauseRobotCompanionEditorManipulationForDebug() {
  return ROBOT_DEBUG_PAUSED;
}

function shouldPauseRobotCompanionKeywordArgumentInsertForDebug() {
  return false;
}

function shouldPauseRobotCompanionPassiveEditorFeaturesForDebug() {
  return false;
}

function shouldPauseRobotCompanionPrewarmForDebug() {
  return ROBOT_DEBUG_PAUSED;
}

function activate(context) {
  updateRobotDebugPauseState();
  const outputChannel = getRobotCompanionOutputChannel();
  const parser = new RobotDocumentationService();
  const enumHintService = new RobotEnumHintService();
  const returnComputeWorker = new RobotReturnComputeWorker(enumHintService, context);
  const runtimeCacheService = new RobotRuntimeCacheService(enumHintService, returnComputeWorker);
  const previewProvider = new RobotDocPreviewViewProvider();
  const controller = new RobotDocPreviewController(parser, previewProvider);
  previewProvider.setMessageHandler((message) => controller.handlePreviewMessage(message));
  const returnPreviewProvider = new RobotReturnPreviewViewProvider(runtimeCacheService);
  const returnController = new RobotReturnExplorerController(
    parser,
    enumHintService,
    returnPreviewProvider,
    runtimeCacheService,
    returnComputeWorker
  );
  const codeLensProvider = new RobotDocCodeLensProvider(parser);
  const foldingRangeProvider = new RobotDocFoldingRangeProvider(parser);
  const typedVariableCompletionProvider = new RobotTypedVariableCompletionProvider(
    parser,
    enumHintService,
    runtimeCacheService,
    returnComputeWorker
  );
  const handleDebugStateChange = () => {
    const wasPaused = ROBOT_DEBUG_PAUSED;
    const isPaused = updateRobotDebugPauseState();
    if (wasPaused === isPaused) {
      return;
    }
    codeLensProvider.refresh();
    controller.refresh();
    void returnController.refresh();
  };

  context.subscriptions.push(
    outputChannel,
    parser,
    enumHintService,
    runtimeCacheService,
    previewProvider,
    controller,
    returnPreviewProvider,
    returnController,
    codeLensProvider,
    foldingRangeProvider,
    typedVariableCompletionProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, previewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(RETURN_VIEW_ID, returnPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerCodeLensProvider(ROBOT_SELECTOR, codeLensProvider),
    vscode.languages.registerFoldingRangeProvider(ROBOT_SELECTOR, foldingRangeProvider),
    vscode.languages.registerHoverProvider(
      ROBOT_SELECTOR,
      new RobotDocHoverProvider(parser, enumHintService, runtimeCacheService, returnComputeWorker)
    ),
    vscode.languages.registerCompletionItemProvider(
      ROBOT_SELECTOR,
      typedVariableCompletionProvider,
      "=",
      ".",
      "}",
      "$",
      "@",
      "&",
      "%",
      "{"
    ),
    vscode.commands.registerCommand(CMD_TOGGLE, async () => {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.robotCompanionContainer");
      } catch {
        // no-op
      }

      try {
        await vscode.commands.executeCommand(`${RETURN_VIEW_ID}.focus`);
      } catch {
        // no-op
      }
    }),
    vscode.commands.registerCommand(CMD_OPEN_CURRENT_BLOCK, () => controller.openCurrentBlock()),
    vscode.commands.registerCommand(CMD_OPEN_BLOCK_AT, (uriString, blockId) =>
      controller.openBlockAt(uriString, blockId)
    ),
    vscode.commands.registerCommand(CMD_OPEN_LOCATION, async (uriString, line, character = 0, metadata) => {
      const editor = await openTextDocumentAtLocation(uriString, line, character);
      if (metadata && metadata.kind === "keywordArgumentPreview" && metadata.payload) {
        await returnController.previewKeywordArgument(metadata.payload, {
          skipOpen: true,
          editor
        });
        return;
      }
      await returnController.refresh();
    }),
    vscode.commands.registerCommand(CMD_PREVIEW_KEYWORD_ARGUMENT, async (payload) => {
      await returnController.previewKeywordArgument(payload);
    }),
    vscode.commands.registerCommand(CMD_INSERT_KEYWORD_ARGUMENT, async (payload) => {
      await insertKeywordArgumentFromPayload(payload, returnController);
    }),
    vscode.commands.registerCommand(CMD_EXPORT_DOCUMENTATION_MARKDOWN, async (uriString, blockId) => {
      await controller.exportDocumentationMarkdown(uriString, blockId);
    }),
    vscode.commands.registerCommand(CMD_EXPORT_DOCUMENTATION_PDF, async (uriString, blockId) => {
      await controller.exportDocumentationPdf(uriString, blockId);
    }),
    vscode.commands.registerCommand(CMD_EXPORT_DOCUMENTATION_SELECTED_MARKDOWN, async (uriString) => {
      await controller.exportDocumentationSelectedMarkdown(uriString);
    }),
    vscode.commands.registerCommand(CMD_EXPORT_DOCUMENTATION_SELECTED_PDF, async (uriString) => {
      await controller.exportDocumentationSelectedPdf(uriString);
    }),
    vscode.commands.registerCommand(CMD_SHOW_OUTPUT, () => {
      showRobotCompanionOutput(false);
    }),
    vscode.commands.registerCommand(CMD_USE_AS_DEFAULT_FOLDING_PROVIDER, async () => {
      try {
        await useRobotCompanionAsDefaultFoldingProvider();
      } catch (error) {
        logRobotCompanionError("Failed to set Robot Companion as the default folding provider", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not update the Robot folding provider setting. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_FOLD_DOCUMENTATION_TO_HEADLINES, async (documentUri) => {
      try {
        await setDocumentationExactFoldState(foldingRangeProvider, DOCUMENTATION_BODY_FOLD_TIER.HEADLINES, documentUri);
      } catch (error) {
        logRobotCompanionError("Failed to fold documentation to level 3", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not fold documentation to level 3. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_FOLD_DOCUMENTATION_TO_STEPS, async (documentUri) => {
      try {
        await setDocumentationExactFoldState(foldingRangeProvider, DOCUMENTATION_BODY_FOLD_TIER.STEPS, documentUri);
      } catch (error) {
        logRobotCompanionError("Failed to fold documentation to steps", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not fold documentation to steps. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_FOLD_DOCUMENTATION_TO_FIRST_LEVEL, async (documentUri) => {
      try {
        await setDocumentationExactFoldState(foldingRangeProvider, DOCUMENTATION_BODY_FOLD_TIER.STEPS, documentUri);
      } catch (error) {
        logRobotCompanionError("Failed to fold documentation to level 4", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not fold documentation to level 4. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_FOLD_DOCUMENTATION_TO_SECOND_LEVEL, async (documentUri) => {
      try {
        await setDocumentationExactFoldState(foldingRangeProvider, DOCUMENTATION_BODY_FOLD_TIER.STEPS, documentUri);
      } catch (error) {
        logRobotCompanionError("Failed to fold documentation to level 5", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not fold documentation to level 5. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_UNFOLD_DOCUMENTATION, async (documentUri) => {
      try {
        await unfoldDocumentationBuiltInState(foldingRangeProvider, documentUri);
      } catch (error) {
        logRobotCompanionError("Failed to unfold documentation", error);
        await vscode.window.showErrorMessage(
          "Robot Companion could not unfold documentation. See the Robot Companion output for details."
        );
      }
    }),
    vscode.commands.registerCommand(CMD_FOLD_DOCUMENTATION_OVERVIEW, async () =>
      setDocumentationExactFoldState(foldingRangeProvider, DOCUMENTATION_BODY_FOLD_TIER.HEADLINES)
    ),
    vscode.commands.registerCommand(CMD_UNFOLD_DOCUMENTATION_OVERVIEW, async () =>
      unfoldDocumentationBuiltInState(foldingRangeProvider)
    ),
    vscode.commands.registerCommand(CMD_INVALIDATE_CACHES, async () => {
      parser.clearAll();
      enumHintService.invalidateAll();
      returnComputeWorker.invalidateAll();
      await returnComputeWorker.clearPersistedCaches();
      runtimeCacheService.invalidateAll();
      codeLensProvider.refresh();
      controller.refresh();
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && isRobotDocument(activeEditor.document)) {
        try {
          await enumHintService.getIndexForDocument(activeEditor.document);
        } catch {
          // no-op
        }
      }
      await returnController.refresh();
      runtimeCacheService.schedulePrewarmForOpenDocuments(parser, activeEditor?.document?.uri?.toString() || "");
      logRobotCompanionInfo("All Robot Companion caches invalidated by command.");
      void vscode.window.showInformationMessage("Robot Companion caches invalidated.");
    }),
    parser.onDidChange(() => {
      codeLensProvider.refresh();
      foldingRangeProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(EXT_CONFIG_ROOT)) {
        return;
      }
      if (
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.indexImportFolderPatterns`) ||
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.indexExcludeFolderPatterns`)
      ) {
        enumHintService.invalidateAll();
        returnComputeWorker.invalidateAll();
      }
      if (
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.enableReturnTypeDiskCache`) ||
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.returnTypeCacheMaxEntries`)
      ) {
        returnComputeWorker.invalidateAll();
      }
      runtimeCacheService.invalidateAll();
      codeLensProvider.refresh();
      controller.refresh();
      returnController.refresh();
      runtimeCacheService.schedulePrewarmForOpenDocuments(
        parser,
        vscode.window.activeTextEditor?.document?.uri?.toString() || ""
      );
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isRobotDocument(document)) {
        return;
      }
      runtimeCacheService.schedulePrewarmForOpenDocuments(parser, document.uri.toString());
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isRobotDocument(event.document)) {
        return;
      }
      runtimeCacheService.invalidateOnRobotDocumentChange(event);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isPythonDocument(document)) {
        const updatePromise = enumHintService.applyPythonDocumentSave(document).catch((error) => {
          logRobotCompanionError("Incremental Python save index update failed", error, {
            uri: document.uri.toString()
          });
        });
        void updatePromise.finally(() => {
          void returnController.refresh();
        });
        returnComputeWorker.invalidateTypePreviewByFileUris([document.uri]);
        runtimeCacheService.invalidateAll();
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      const pythonFiles = event.files.filter((file) => isPythonPath(file.path));
      if (pythonFiles.length > 0) {
        const updatePromises = [];
        for (const file of pythonFiles) {
          const updatePromise = enumHintService.applyPythonFileCreate(file).catch((error) => {
            logRobotCompanionError("Incremental Python create index update failed", error, {
              uri: file.toString()
            });
          });
          updatePromises.push(updatePromise);
        }
        void Promise.allSettled(updatePromises).finally(() => {
          void returnController.refresh();
        });
        if (pythonFiles[0]?.uri) {
          returnComputeWorker.invalidateForUri(pythonFiles[0].uri);
        } else {
          returnComputeWorker.invalidateAll();
        }
        runtimeCacheService.invalidateAll();
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      const pythonFiles = event.files.filter((file) => isPythonPath(file.path));
      if (pythonFiles.length > 0) {
        const updatePromises = [];
        for (const file of pythonFiles) {
          const updatePromise = enumHintService.applyPythonFileDelete(file).catch((error) => {
            logRobotCompanionError("Incremental Python delete index update failed", error, {
              uri: file.toString()
            });
          });
          updatePromises.push(updatePromise);
        }
        void Promise.allSettled(updatePromises).finally(() => {
          void returnController.refresh();
        });
        if (pythonFiles[0]?.uri) {
          returnComputeWorker.invalidateForUri(pythonFiles[0].uri);
        } else {
          returnComputeWorker.invalidateAll();
        }
        runtimeCacheService.invalidateAll();
      }
    }),
    vscode.debug.onDidStartDebugSession(() => handleDebugStateChange()),
    vscode.debug.onDidTerminateDebugSession(() => handleDebugStateChange()),
    vscode.debug.onDidChangeActiveDebugSession(() => handleDebugStateChange()),
    {
      dispose() {
        ROBOT_DEBUG_PAUSED = false;
        returnComputeWorker.dispose();
      }
    }
  );

  runtimeCacheService.schedulePrewarmForOpenDocuments(
    parser,
    vscode.window.activeTextEditor?.document?.uri?.toString() || ""
  );
}

function deactivate() {
  // no-op
}

class RobotDocumentationService {
  constructor() {
    this._cache = new Map();
    this._onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this._onDidChangeEmitter.event;
  }

  dispose() {
    this._cache.clear();
    this._onDidChangeEmitter.dispose();
  }

  clear(uri) {
    this._cache.delete(uri.toString());
    this._onDidChangeEmitter.fire(uri);
  }

  clearAll() {
    this._cache.clear();
    this._onDidChangeEmitter.fire(undefined);
  }

  getParsed(document) {
    const key = document.uri.toString();
    const cached = this._cache.get(key);
    if (cached && cached.version === document.version) {
      return cached;
    }
    return this.parse(document);
  }

  parse(document) {
    const lines = document.getText().split(/\r?\n/);
    const { owners, ownerByLine } = buildOwnerScopes(lines);
    const blocks = buildDocumentationBlocks(lines, owners, ownerByLine);
    const branchPathByLine = buildConditionalBranchPathByLine(lines, ownerByLine);

    const variableAssignments = parseVariableAssignments(lines, ownerByLine, branchPathByLine);
    const keywordCallAssignments = parseKeywordCallAssignments(lines, ownerByLine, branchPathByLine);
    const variableAssignmentsByOwnerId = new Map();
    const keywordCallAssignmentsByOwnerId = new Map();
    for (const assignment of variableAssignments) {
      const ownerId = String(assignment?.ownerId || "");
      if (!ownerId) {
        continue;
      }
      const ownerAssignments = variableAssignmentsByOwnerId.get(ownerId) || [];
      ownerAssignments.push(assignment);
      variableAssignmentsByOwnerId.set(ownerId, ownerAssignments);
    }
    for (const assignment of keywordCallAssignments) {
      const ownerId = String(assignment?.ownerId || "");
      if (!ownerId) {
        continue;
      }
      const ownerAssignments = keywordCallAssignmentsByOwnerId.get(ownerId) || [];
      ownerAssignments.push(assignment);
      keywordCallAssignmentsByOwnerId.set(ownerId, ownerAssignments);
    }
    const enrichedBlocks = blocks.map((block) => ({
      ...block,
      variableAssignments: [...(variableAssignmentsByOwnerId.get(block.ownerId) || [])].sort(
        (left, right) => Number(left?.startLine) - Number(right?.startLine)
      ),
      keywordCallAssignments: [...(keywordCallAssignmentsByOwnerId.get(block.ownerId) || [])].sort(
        (left, right) => Number(left?.startLine) - Number(right?.startLine)
      )
    }));
    const parsed = {
      uri: document.uri.toString(),
      version: document.version,
      fileName: path.basename(document.uri.fsPath || document.uri.path || document.uri.toString()),
      blocks: enrichedBlocks,
      owners,
      branchPathByLine,
      variableAssignments,
      keywordCallAssignments
    };

    this._cache.set(parsed.uri, parsed);
    this._onDidChangeEmitter.fire(document.uri);

    return parsed;
  }
}

class RobotEnumHintService {
  constructor() {
    this._workspaceStates = new Map();
    this._generationByWorkspace = new Map();
  }

  dispose() {
    this._workspaceStates.clear();
    this._generationByWorkspace.clear();
  }

  invalidateAll() {
    const workspaceKeys = new Set([
      ...this._generationByWorkspace.keys(),
      ...this._workspaceStates.keys(),
      ...((vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.toString()) || [])
    ]);
    for (const key of workspaceKeys) {
      this._bumpWorkspaceGeneration(key);
    }
    this._workspaceStates.clear();
  }

  invalidateForUri(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }
    const key = workspaceFolder.uri.toString();
    this._bumpWorkspaceGeneration(key);
    this._workspaceStates.delete(key);
  }

  async applyPythonDocumentSave(document) {
    if (!isPythonDocument(document)) {
      return false;
    }
    return await this._applyPythonSourceForUri(document.uri, document.getText());
  }

  async applyPythonFileCreate(fileOrUri) {
    const uri = fileOrUri?.uri || fileOrUri;
    if (!uri || !isPythonPath(uri.path)) {
      return false;
    }
    return await this._applyPythonSourceForUri(uri);
  }

  async applyPythonFileDelete(fileOrUri) {
    const uri = fileOrUri?.uri || fileOrUri;
    if (!uri || !isPythonPath(uri.path)) {
      return false;
    }
    return await this._removePythonContributionForUri(uri);
  }

  getGenerationForDocument(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return 0;
    }
    return Number(this._generationByWorkspace.get(workspaceFolder.uri.toString()) || 0);
  }

  _bumpWorkspaceGeneration(workspaceKey) {
    const key = String(workspaceKey || "").trim();
    if (!key) {
      return;
    }
    const currentGeneration = Number(this._generationByWorkspace.get(key) || 0);
    this._generationByWorkspace.set(key, currentGeneration + 1);
  }

  async getIndexForDocument(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const state = this._getOrCreateWorkspaceState(workspaceFolder);
    await this._ensureWorkspaceInitialized(state);
    await state.updateQueue;
    return state.derivedIndex;
  }

  _getOrCreateWorkspaceState(workspaceFolder) {
    const workspaceKey = workspaceFolder.uri.toString();
    const existing = this._workspaceStates.get(workspaceKey);
    if (existing) {
      return existing;
    }

    const state = {
      workspaceFolder,
      workspaceKey,
      pythonFileContribByPath: new Map(),
      resourceKeywordContribByPath: new Map(),
      workspaceFileSets: {
        python: new Set(),
        resourceKeyword: new Set()
      },
      derivedIndex: undefined,
      updateQueue: Promise.resolve(),
      initialized: false,
      initializingPromise: undefined
    };
    this._workspaceStates.set(workspaceKey, state);
    return state;
  }

  _enqueueWorkspaceUpdate(state, actionLabel, updater) {
    if (!state || typeof updater !== "function") {
      return Promise.resolve(undefined);
    }
    const safeLabel = String(actionLabel || "workspace index update");
    const previous = state.updateQueue || Promise.resolve();
    const run = async () => {
      try {
        return await updater(state);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn(`[robot-companion] ${safeLabel} failed:`, message);
        return undefined;
      }
    };
    const next = previous.then(run, run);
    state.updateQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async _ensureWorkspaceInitialized(state) {
    if (!state) {
      return;
    }
    if (state.initialized && state.derivedIndex) {
      return;
    }
    if (state.initializingPromise) {
      await state.initializingPromise;
      return;
    }

    state.initializingPromise = this._enqueueWorkspaceUpdate(
      state,
      "initial workspace index build",
      async (targetState) => {
        if (targetState.initialized && targetState.derivedIndex) {
          return targetState.derivedIndex;
        }
        await this._loadInitialWorkspaceContributions(targetState);
        this._recomputeDerivedIndexFromContributions(targetState);
        targetState.initialized = true;
        return targetState.derivedIndex;
      }
    );
    try {
      await state.initializingPromise;
    } finally {
      state.initializingPromise = undefined;
    }
  }

  async _applyPythonSourceForUri(uri, sourceText = undefined) {
    if (!uri || !isPythonPath(uri.path)) {
      return false;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    const state = this._getOrCreateWorkspaceState(workspaceFolder);
    await this._ensureWorkspaceInitialized(state);

    return await this._enqueueWorkspaceUpdate(
      state,
      "incremental python file update",
      async (targetState) => {
        const content =
          sourceText !== undefined ? String(sourceText || "") : await readWorkspaceText(uri);
        const contribution = this._parsePythonFileContribution(
          targetState.workspaceFolder,
          uri,
          content
        );
        if (!contribution) {
          return false;
        }
        targetState.pythonFileContribByPath.set(contribution.filePath, contribution);
        targetState.workspaceFileSets.python.add(contribution.filePath);
        this._recomputeDerivedIndexFromContributions(targetState);
        this._bumpWorkspaceGeneration(targetState.workspaceKey);
        return true;
      }
    );
  }

  async _removePythonContributionForUri(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    const state = this._getOrCreateWorkspaceState(workspaceFolder);
    await this._ensureWorkspaceInitialized(state);
    const filePath = String(uri?.fsPath || uri?.path || "").trim();
    if (!filePath) {
      return false;
    }

    return await this._enqueueWorkspaceUpdate(
      state,
      "incremental python file removal",
      async (targetState) => {
        const removed = targetState.pythonFileContribByPath.delete(filePath);
        targetState.workspaceFileSets.python.delete(filePath);
        if (!removed) {
          return false;
        }
        this._recomputeDerivedIndexFromContributions(targetState);
        this._bumpWorkspaceGeneration(targetState.workspaceKey);
        return true;
      }
    );
  }

  async _loadInitialWorkspaceContributions(state) {
    const workspaceFolder = state.workspaceFolder;
    const importFolderPatterns = getIndexImportFolderPatterns();
    const excludeFolderPatterns = getIndexExcludeFolderPatterns();
    const includePatterns = buildIndexIncludeFilePatterns(importFolderPatterns, "**/*.py");
    const resourceIncludePatterns = buildIndexIncludeFilePatterns(importFolderPatterns, "**/*.resource");
    const keywordRobotIncludePatterns = buildIndexIncludeFilePatterns(
      importFolderPatterns,
      "**/*[Kk]eywords*/**/*.robot"
    );
    const excludePattern = buildCompositeIndexExcludePattern(excludeFolderPatterns);
    const [pythonFiles, resourceFiles, keywordRobotFiles] = await Promise.all([
      findWorkspaceFilesByPatterns(workspaceFolder, includePatterns, excludePattern),
      findWorkspaceFilesByPatterns(workspaceFolder, resourceIncludePatterns, excludePattern),
      findWorkspaceFilesByPatterns(workspaceFolder, keywordRobotIncludePatterns, excludePattern)
    ]);

    const robotKeywordFiles = uniqueUrisByString(resourceFiles.concat(keywordRobotFiles));
    const pythonFileContribByPath = new Map();
    const resourceKeywordContribByPath = new Map();
    const pythonFileSet = new Set();
    const resourceKeywordFileSet = new Set();

    for (const fileUri of pythonFiles) {
      let fileContent = "";
      try {
        fileContent = await readWorkspaceText(fileUri);
      } catch {
        continue;
      }

      const contribution = this._parsePythonFileContribution(workspaceFolder, fileUri, fileContent);
      if (!contribution) {
        continue;
      }
      pythonFileContribByPath.set(contribution.filePath, contribution);
      pythonFileSet.add(contribution.filePath);
    }

    for (const fileUri of robotKeywordFiles) {
      let fileContent = "";
      try {
        fileContent = await readWorkspaceText(fileUri);
      } catch {
        continue;
      }

      const contribution = this._parseRobotKeywordContribution(fileUri, fileContent);
      if (!contribution) {
        continue;
      }
      resourceKeywordContribByPath.set(contribution.filePath, contribution);
      resourceKeywordFileSet.add(contribution.filePath);
    }

    state.pythonFileContribByPath = pythonFileContribByPath;
    state.resourceKeywordContribByPath = resourceKeywordContribByPath;
    state.workspaceFileSets = {
      python: pythonFileSet,
      resourceKeyword: resourceKeywordFileSet
    };
  }

  _parsePythonFileContribution(workspaceFolder, fileUri, sourceText) {
    const filePath = String(fileUri?.fsPath || fileUri?.path || "").trim();
    if (!filePath) {
      return undefined;
    }

    const moduleInfo = derivePythonModuleInfo(workspaceFolder, fileUri);
    const parsedImports = parsePythonImportAliasesFromSource(sourceText, moduleInfo.packagePath);
    const enumImportAliases = parseFromImportAliasesFromPythonSource(sourceText);

    const enumDefinitions = parseEnumDefinitionsFromPythonSource(sourceText, filePath).map((enumDefinition) => {
      const qualifiedName = moduleInfo.modulePath
        ? `${moduleInfo.modulePath}.${enumDefinition.name}`
        : enumDefinition.name;
      return {
        ...enumDefinition,
        modulePath: moduleInfo.modulePath,
        qualifiedName
      };
    });

    const parsedStructuredTypeDefinitions = parseStructuredTypesFromPythonSource(sourceText, filePath);
    const localStructuredTypeNames = new Set(
      parsedStructuredTypeDefinitions.map((structuredTypeDefinition) => structuredTypeDefinition.name)
    );
    const structuredTypeResolutionContext = {
      sourceFilePath: filePath,
      modulePath: moduleInfo.modulePath,
      packagePath: moduleInfo.packagePath,
      localStructuredTypeNames,
      localEnumNames: new Set(enumDefinitions.map((enumDefinition) => enumDefinition.name)),
      typeImportAliases: cloneTypeImportAliasesMap(parsedImports.typeImportAliases),
      moduleImportAliases: new Map(parsedImports.moduleImportAliases || [])
    };
    const structuredTypeDefinitions = parsedStructuredTypeDefinitions.map((structuredTypeDefinition) => {
      const qualifiedName = moduleInfo.modulePath
        ? `${moduleInfo.modulePath}.${structuredTypeDefinition.name}`
        : structuredTypeDefinition.name;
      return {
        ...structuredTypeDefinition,
        modulePath: moduleInfo.modulePath,
        qualifiedName,
        baseTypeRefs: resolveStructuredBaseTypeReferences(
          structuredTypeDefinition.baseTypeNames,
          structuredTypeResolutionContext
        )
      };
    });

    const keywordDefinitions = sourceText.includes("@keyword")
      ? parseKeywordEnumHintsFromPythonSource(sourceText, filePath)
      : [];
    const umlautDecoratorConfig = parseConvertUmlautDecoratorConfigFromPythonSource(sourceText, filePath);

    return {
      filePath,
      moduleInfo,
      enumDefinitions,
      structuredTypeDefinitions,
      localEnumNames: new Set(enumDefinitions.map((enumDefinition) => enumDefinition.name)),
      localStructuredTypeNames,
      enumImportAliases,
      typeImportAliases: parsedImports.typeImportAliases,
      moduleImportAliases: parsedImports.moduleImportAliases,
      keywordDefinitions,
      umlautDecoratorConfig
    };
  }

  _parseRobotKeywordContribution(fileUri, sourceText) {
    if (!/\*{3}\s*keywords?\s*\*{3}/i.test(String(sourceText || ""))) {
      return undefined;
    }
    const filePath = String(fileUri?.fsPath || fileUri?.path || "").trim();
    if (!filePath) {
      return undefined;
    }
    return {
      filePath,
      robotKeywordDefinitions: parseRobotKeywordDefinitionsFromSource(sourceText, filePath)
    };
  }

  _recomputeDerivedIndexFromContributions(state) {
    const enumsByName = new Map();
    const enumsByQualifiedName = new Map();
    const structuredTypesByName = new Map();
    const structuredTypesByQualifiedName = new Map();
    const localEnumNamesByFile = new Map();
    const localStructuredTypeNamesByFile = new Map();
    const enumImportAliasesByFile = new Map();
    const typeImportAliasesByFile = new Map();
    const moduleImportAliasesByFile = new Map();
    const moduleInfoByFile = new Map();
    const keywordDefinitions = [];
    const robotKeywordDefinitions = [];

    for (const contribution of state.pythonFileContribByPath.values()) {
      if (!contribution) {
        continue;
      }
      const filePath = String(contribution.filePath || "").trim();
      if (!filePath) {
        continue;
      }

      moduleInfoByFile.set(filePath, contribution.moduleInfo || { modulePath: "", packagePath: "" });
      typeImportAliasesByFile.set(filePath, cloneTypeImportAliasesMap(contribution.typeImportAliases));
      moduleImportAliasesByFile.set(filePath, new Map(contribution.moduleImportAliases || []));
      enumImportAliasesByFile.set(filePath, new Map(contribution.enumImportAliases || []));
      localEnumNamesByFile.set(filePath, new Set(contribution.localEnumNames || []));
      localStructuredTypeNamesByFile.set(filePath, new Set(contribution.localStructuredTypeNames || []));

      for (const enumDefinition of contribution.enumDefinitions || []) {
        const existing = enumsByName.get(enumDefinition.name) || [];
        existing.push(enumDefinition);
        enumsByName.set(enumDefinition.name, existing);
        const existingQualified = enumsByQualifiedName.get(enumDefinition.qualifiedName) || [];
        existingQualified.push(enumDefinition);
        enumsByQualifiedName.set(enumDefinition.qualifiedName, existingQualified);
      }

      for (const structuredTypeDefinition of contribution.structuredTypeDefinitions || []) {
        const existing = structuredTypesByName.get(structuredTypeDefinition.name) || [];
        existing.push(structuredTypeDefinition);
        structuredTypesByName.set(structuredTypeDefinition.name, existing);
        const existingQualified = structuredTypesByQualifiedName.get(structuredTypeDefinition.qualifiedName) || [];
        existingQualified.push(structuredTypeDefinition);
        structuredTypesByQualifiedName.set(structuredTypeDefinition.qualifiedName, existingQualified);
      }

      keywordDefinitions.push(...(contribution.keywordDefinitions || []));
    }

    for (const contribution of state.resourceKeywordContribByPath.values()) {
      if (!contribution) {
        continue;
      }
      robotKeywordDefinitions.push(...(contribution.robotKeywordDefinitions || []));
    }

    const enumNameSet = new Set(enumsByName.keys());
    const keywordArgs = new Map();
    const keywordArgAnnotations = new Map();
    const keywordReturns = new Map();
    const keywordReturnDefinitions = new Map();
    const keywordDocsByName = new Map();
    const workspaceConvertUmlautConfig = resolveWorkspaceConvertUmlautDecoratorConfig(
      state.pythonFileContribByPath.values()
    );

    for (const rawKeywordDefinition of keywordDefinitions) {
      const keywordDefinition = finalizePythonKeywordDefinitionForIndex(rawKeywordDefinition, {
        defaultExcludeKeys: workspaceConvertUmlautConfig.defaultExcludeKeys
      });
      const normalizedKeyword = normalizeKeywordName(keywordDefinition.keywordName);
      if (!normalizedKeyword) {
        continue;
      }

      let argsMap = keywordArgs.get(normalizedKeyword);
      if (!argsMap) {
        argsMap = new Map();
        keywordArgs.set(normalizedKeyword, argsMap);
      }
      let argAnnotationsMap = keywordArgAnnotations.get(normalizedKeyword);
      if (!argAnnotationsMap) {
        argAnnotationsMap = new Map();
        keywordArgAnnotations.set(normalizedKeyword, argAnnotationsMap);
      }

      const returnAnnotation = String(keywordDefinition.returnAnnotation || "").trim();
      if (returnAnnotation && !keywordReturns.has(normalizedKeyword)) {
        keywordReturns.set(normalizedKeyword, returnAnnotation);
      }
      const sourceFilePath = String(keywordDefinition.sourceFilePath || "");
      const sourceModuleInfo = moduleInfoByFile.get(sourceFilePath) || { modulePath: "", packagePath: "" };
      const returnDefinition = {
        keywordName: String(keywordDefinition.keywordName || "").trim(),
        normalizedKeyword,
        returnAnnotation,
        sourceFilePath,
        sourceUri: sourceFilePath ? vscode.Uri.file(sourceFilePath).toString() : "",
        sourceLine: Number.isFinite(Number(keywordDefinition.sourceLine)) ? Number(keywordDefinition.sourceLine) : 0,
        functionName: String(keywordDefinition.functionName || "").trim(),
        modulePath: String(sourceModuleInfo.modulePath || ""),
        packagePath: String(sourceModuleInfo.packagePath || ""),
        localStructuredTypeNames: new Set(localStructuredTypeNamesByFile.get(sourceFilePath) || []),
        localEnumNames: new Set(localEnumNamesByFile.get(sourceFilePath) || []),
        typeImportAliases: cloneTypeImportAliasesMap(typeImportAliasesByFile.get(sourceFilePath)),
        moduleImportAliases: new Map(moduleImportAliasesByFile.get(sourceFilePath) || [])
      };
      const existingReturnDefinitions = keywordReturnDefinitions.get(normalizedKeyword) || [];
      existingReturnDefinitions.push(returnDefinition);
      keywordReturnDefinitions.set(normalizedKeyword, existingReturnDefinitions);

      const sourceLine = Number(keywordDefinition.sourceLine);
      const sourceUri = sourceFilePath ? vscode.Uri.file(sourceFilePath).toString() : "";
      const keywordDocCandidate = {
        keywordName: String(keywordDefinition.keywordName || "").trim(),
        normalizedKeyword,
        sourceFilePath,
        sourceUri,
        sourceLine: Number.isFinite(sourceLine) ? sourceLine : 0,
        functionName: String(keywordDefinition.functionName || "").trim(),
        rawDocstring: String(keywordDefinition.rawDocstring || ""),
        normalizedDocstring: String(keywordDefinition.normalizedDocstring || ""),
        docWarnings: uniqueStrings((keywordDefinition.docWarnings || []).map((warning) => String(warning || "").trim()))
      };
      const existingDocs = keywordDocsByName.get(normalizedKeyword) || [];
      existingDocs.push(keywordDocCandidate);
      keywordDocsByName.set(normalizedKeyword, existingDocs);

      const localEnumNames = localEnumNamesByFile.get(sourceFilePath) || new Set();
      const importAliasMap = enumImportAliasesByFile.get(sourceFilePath) || new Map();

      for (const [argumentName, annotation] of keywordDefinition.parameters.entries()) {
        const normalizedArg = normalizeArgumentName(argumentName);
        const annotationText = String(annotation || "").trim();
        if (annotationText.length > 0) {
          const existingAnnotations = argAnnotationsMap.get(normalizedArg) || [];
          argAnnotationsMap.set(normalizedArg, uniqueStrings(existingAnnotations.concat(annotationText)));
        }

        const enumNames = resolveEnumNamesFromAnnotation(annotation, {
          enumNameSet,
          localEnumNames,
          importAliasMap
        });
        if (enumNames.length === 0) {
          continue;
        }
        const existingEnums = argsMap.get(normalizedArg) || [];
        argsMap.set(normalizedArg, uniqueStrings(existingEnums.concat(enumNames)));
      }
    }

    propagateRobotKeywordHints(robotKeywordDefinitions, keywordArgs, keywordArgAnnotations);

    const indexableStructuredTypeNames = new Set();
    for (const [typeName, candidates] of structuredTypesByName.entries()) {
      if ((candidates || []).some((candidate) => candidate.isIndexableWrapper)) {
        indexableStructuredTypeNames.add(normalizeComparableToken(typeName));
      }
    }

    finalizeStructuredTypeCamelCaseAccess(structuredTypesByName);

    state.derivedIndex = {
      enumsByName,
      enumsByQualifiedName,
      keywordArgs,
      keywordArgAnnotations,
      keywordReturns,
      keywordReturnDefinitions,
      keywordDocsByName,
      localEnumNamesByFile,
      localStructuredTypeNamesByFile,
      enumImportAliasesByFile,
      typeImportAliasesByFile,
      moduleImportAliasesByFile,
      moduleInfoByFile,
      structuredTypesByName,
      structuredTypesByQualifiedName,
      indexableStructuredTypeNames
    };
    return state.derivedIndex;
  }
}

class RobotReturnComputeWorker {
  constructor(enumHintService, extensionContext) {
    this._enumHintService = enumHintService;
    this._worker = undefined;
    this._requestId = 0;
    this._pendingById = new Map();
    this._snapshotGenerationByWorkspace = new Map();
    this._snapshotFingerprintByWorkspace = new Map();
    this._persistedTypeCacheByWorkspace = new Map();
    this._persistTimersByWorkspace = new Map();
    this._isAvailable = false;
    this._storageRootUri = extensionContext?.globalStorageUri
      ? vscode.Uri.joinPath(extensionContext.globalStorageUri, RETURN_TYPE_CACHE_DIR)
      : undefined;

    try {
      const workerThreads = require("worker_threads");
      const workerPath = path.join(__dirname, "return-worker.js");
      this._worker = new workerThreads.Worker(workerPath);
      this._worker.on("message", (message) => this._handleWorkerMessage(message));
      this._worker.on("error", (error) => this._handleWorkerFailure(error));
      this._worker.on("exit", (code) => this._handleWorkerExit(code));
      this._isAvailable = true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-companion] Return worker disabled:", message);
    }
  }

  dispose() {
    this.invalidateAll();
    this._clearPersistTimers();
    if (this._worker) {
      void this._worker.terminate().catch(() => undefined);
      this._worker = undefined;
    }
    this._isAvailable = false;
  }

  invalidateAll() {
    this._snapshotGenerationByWorkspace.clear();
    this._snapshotFingerprintByWorkspace.clear();
    this._persistedTypeCacheByWorkspace.clear();
    this._clearPersistTimers();
    if (this._worker) {
      void this._postRequest("clearAll", {}).catch(() => undefined);
    }
  }

  async clearPersistedCaches() {
    this._persistedTypeCacheByWorkspace.clear();
    this._snapshotFingerprintByWorkspace.clear();
    this._clearPersistTimers();
    if (!this._storageRootUri) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(this._storageRootUri, {
        recursive: true,
        useTrash: false
      });
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-companion] Failed to clear persisted return type cache:", message);
      }
    }
  }

  invalidateForUri(uri) {
    if (!uri) {
      return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }
    const workspaceKey = workspaceFolder.uri.toString();
    this._snapshotGenerationByWorkspace.delete(workspaceKey);
    this._snapshotFingerprintByWorkspace.delete(workspaceKey);
    this._persistedTypeCacheByWorkspace.delete(workspaceKey);
    this._clearPersistTimerForWorkspace(workspaceKey);
    if (this._worker) {
      void this._postRequest("clearWorkspace", { workspaceKey }).catch(() => undefined);
    }
  }

  invalidateTypePreviewByFileUris(uris) {
    if (!Array.isArray(uris) || uris.length === 0) {
      return;
    }
    const groupedByWorkspace = new Map();
    for (const uri of uris) {
      if (!uri) {
        continue;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!workspaceFolder) {
        continue;
      }
      const workspaceKey = workspaceFolder.uri.toString();
      const normalizedFilePath = normalizeCacheDependencyFilePath(uri.fsPath || uri.path || "");
      if (!normalizedFilePath) {
        continue;
      }
      let fileSet = groupedByWorkspace.get(workspaceKey);
      if (!fileSet) {
        fileSet = new Set();
        groupedByWorkspace.set(workspaceKey, fileSet);
      }
      fileSet.add(normalizedFilePath);
    }

    for (const [workspaceKey, fileSet] of groupedByWorkspace.entries()) {
      const filePaths = [...fileSet];
      if (filePaths.length === 0) {
        continue;
      }
      this._removePersistedTypeCacheEntriesByFilePaths(workspaceKey, filePaths);
      if (this._worker) {
        void this._postRequest("invalidateTypePreviewByFiles", {
          workspaceKey,
          filePaths
        }).catch(() => undefined);
      }
    }
  }

  async computeReturnPreview(document, index, payload = {}) {
    if (!this._isAvailable || !this._worker || !document || !index) {
      return undefined;
    }
    const target = await this._ensureWorkspaceSnapshot(document, index);
    if (!target) {
      return undefined;
    }

    try {
      const result = await this._postRequest("computeReturnPreview", {
        workspaceKey: target.workspaceKey,
        generation: target.generation,
        payload
      });
      if (result?.cacheWrite && isReturnTypeDiskCacheEnabled()) {
        this._recordPersistedTypeCacheWrite(
          target.workspaceKey,
          target.cacheFingerprint,
          result.cacheWrite
        );
      }
      return result;
    } catch (error) {
      logRobotCompanionError("Return worker computation failed", error, {
        workspaceKey: target.workspaceKey,
        generation: target.generation,
        payload
      });
      this._snapshotGenerationByWorkspace.delete(target.workspaceKey);
      this._snapshotFingerprintByWorkspace.delete(target.workspaceKey);
      return undefined;
    }
  }

  async computeReturnMemberCompletions(document, index, payload = {}) {
    if (!this._isAvailable || !this._worker || !document || !index) {
      return undefined;
    }
    const target = await this._ensureWorkspaceSnapshot(document, index);
    if (!target) {
      return undefined;
    }

    try {
      const result = await this._postRequest("computeReturnMemberCompletions", {
        workspaceKey: target.workspaceKey,
        generation: target.generation,
        payload
      });
      if (result?.cacheWrite && isReturnTypeDiskCacheEnabled()) {
        this._recordPersistedTypeCacheWrite(
          target.workspaceKey,
          target.cacheFingerprint,
          result.cacheWrite
        );
      }
      return result;
    } catch (error) {
      logRobotCompanionError("Return member completion worker computation failed", error, {
        workspaceKey: target.workspaceKey,
        generation: target.generation,
        payload
      });
      this._snapshotGenerationByWorkspace.delete(target.workspaceKey);
      this._snapshotFingerprintByWorkspace.delete(target.workspaceKey);
      return undefined;
    }
  }

  async _ensureWorkspaceSnapshot(document, index) {
    if (!this._isAvailable || !this._worker) {
      return undefined;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const workspaceKey = workspaceFolder.uri.toString();
    const generation = Number(this._enumHintService?.getGenerationForDocument(document) || 0);
    const loadedGeneration = Number(this._snapshotGenerationByWorkspace.get(workspaceKey) || -1);
    if (loadedGeneration === generation) {
      return {
        workspaceKey,
        generation,
        cacheFingerprint: String(this._snapshotFingerprintByWorkspace.get(workspaceKey) || "")
      };
    }

    const snapshot = serializeReturnWorkerIndexSnapshot(index);
    const cacheFingerprint = computeReturnWorkerSnapshotFingerprint(snapshot);
    const maxTypeCacheEntries = getReturnTypeCacheMaxEntries();
    await this._postRequest("setWorkspaceIndex", {
      workspaceKey,
      generation,
      snapshot,
      cacheFingerprint,
      maxTypeCacheEntries
    });
    this._snapshotGenerationByWorkspace.set(workspaceKey, generation);
    this._snapshotFingerprintByWorkspace.set(workspaceKey, cacheFingerprint);

    if (isReturnTypeDiskCacheEnabled()) {
      await this._hydrateWorkspaceTypeCacheFromDisk(
        workspaceKey,
        generation,
        cacheFingerprint,
        maxTypeCacheEntries
      );
    }

    return { workspaceKey, generation, cacheFingerprint };
  }

  async _hydrateWorkspaceTypeCacheFromDisk(
    workspaceKey,
    generation,
    cacheFingerprint,
    maxTypeCacheEntries
  ) {
    if (!this._worker || !this._storageRootUri || !cacheFingerprint) {
      return;
    }
    const persisted = await this._loadPersistedTypeCache(workspaceKey);
    const persistedFingerprint = String(persisted?.cacheFingerprint || "");
    if (persistedFingerprint !== cacheFingerprint) {
      this._persistedTypeCacheByWorkspace.set(workspaceKey, {
        cacheFingerprint,
        entries: new Map()
      });
      return;
    }

    const entries = sanitizePersistedTypeCacheEntries(persisted?.entries || []).slice(
      0,
      Math.max(50, Number(maxTypeCacheEntries) || 50)
    );
    if (entries.length === 0) {
      this._persistedTypeCacheByWorkspace.set(workspaceKey, {
        cacheFingerprint,
        entries: new Map()
      });
      return;
    }

    await this._postRequest("hydrateTypePreviewCache", {
      workspaceKey,
      generation,
      cacheFingerprint,
      maxTypeCacheEntries,
      entries
    });
    this._persistedTypeCacheByWorkspace.set(workspaceKey, {
      cacheFingerprint,
      entries: new Map(entries.map((entry) => [String(entry.key || ""), entry]))
    });
  }

  async _loadPersistedTypeCache(workspaceKey) {
    const cacheFileUri = this._getWorkspaceTypeCacheFileUri(workspaceKey);
    if (!cacheFileUri) {
      return undefined;
    }
    let raw;
    try {
      raw = await vscode.workspace.fs.readFile(cacheFileUri);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-companion] Failed to read persisted return type cache:", message);
      }
      return undefined;
    }

    try {
      const payload = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (Number(payload?.version) !== RETURN_TYPE_DISK_CACHE_SCHEMA_VERSION) {
        return undefined;
      }
      const entries = sanitizePersistedTypeCacheEntries(payload?.entries || []);
      return {
        cacheFingerprint: String(payload?.cacheFingerprint || ""),
        entries
      };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-companion] Failed to parse persisted return type cache:", message);
      return undefined;
    }
  }

  _recordPersistedTypeCacheWrite(workspaceKey, cacheFingerprint, cacheWrite) {
    if (!this._storageRootUri || !isReturnTypeDiskCacheEnabled()) {
      return;
    }
    const cacheKey = String(cacheWrite?.key || "");
    const sanitizedEntry = sanitizePersistedTypeCacheEntry(cacheWrite?.entry);
    if (!cacheKey || !sanitizedEntry) {
      return;
    }
    let state = this._persistedTypeCacheByWorkspace.get(workspaceKey);
    if (!state || state.cacheFingerprint !== cacheFingerprint) {
      state = {
        cacheFingerprint,
        entries: new Map()
      };
      this._persistedTypeCacheByWorkspace.set(workspaceKey, state);
    }

    if (state.entries.has(cacheKey)) {
      state.entries.delete(cacheKey);
    }
    state.entries.set(cacheKey, {
      key: cacheKey,
      entry: sanitizedEntry
    });
    this._trimPersistedTypeCacheEntries(state.entries, getReturnTypeCacheMaxEntries());
    this._schedulePersistedTypeCacheWrite(workspaceKey);
  }

  _removePersistedTypeCacheEntriesByFilePaths(workspaceKey, filePaths) {
    const state = this._persistedTypeCacheByWorkspace.get(workspaceKey);
    if (!state || !(state.entries instanceof Map)) {
      return;
    }
    const normalizedFilePaths = new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .map((value) => normalizeCacheDependencyFilePath(value))
        .filter(Boolean)
    );
    if (normalizedFilePaths.size === 0) {
      return;
    }

    let removedAny = false;
    for (const [cacheKey, cacheEntry] of state.entries.entries()) {
      const dependencyFilePaths = new Set(
        (cacheEntry?.entry?.dependencyFilePaths || [])
          .map((value) => normalizeCacheDependencyFilePath(value))
          .filter(Boolean)
      );
      if (dependencyFilePaths.size === 0) {
        continue;
      }
      const intersects = [...dependencyFilePaths].some((dependencyPath) =>
        normalizedFilePaths.has(dependencyPath)
      );
      if (!intersects) {
        continue;
      }
      state.entries.delete(cacheKey);
      removedAny = true;
    }

    if (removedAny) {
      this._schedulePersistedTypeCacheWrite(workspaceKey);
    }
  }

  _schedulePersistedTypeCacheWrite(workspaceKey) {
    const key = String(workspaceKey || "");
    if (!key) {
      return;
    }
    this._clearPersistTimerForWorkspace(key);
    const timer = setTimeout(() => {
      this._persistTimersByWorkspace.delete(key);
      void this._flushPersistedTypeCache(key);
    }, RETURN_TYPE_DISK_WRITE_DEBOUNCE_MS);
    this._persistTimersByWorkspace.set(key, timer);
  }

  async _flushPersistedTypeCache(workspaceKey) {
    if (!this._storageRootUri || !isReturnTypeDiskCacheEnabled()) {
      return;
    }
    const state = this._persistedTypeCacheByWorkspace.get(workspaceKey);
    if (!state) {
      return;
    }
    const cacheFileUri = this._getWorkspaceTypeCacheFileUri(workspaceKey);
    if (!cacheFileUri) {
      return;
    }

    const entries = [...state.entries.values()].slice(-Math.max(50, getReturnTypeCacheMaxEntries()));
    const payload = {
      version: RETURN_TYPE_DISK_CACHE_SCHEMA_VERSION,
      workspaceKey,
      cacheFingerprint: state.cacheFingerprint,
      updatedAt: new Date().toISOString(),
      entries
    };
    try {
      await vscode.workspace.fs.createDirectory(this._storageRootUri);
      await vscode.workspace.fs.writeFile(
        cacheFileUri,
        Buffer.from(JSON.stringify(payload), "utf8")
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-companion] Failed to persist return type cache:", message);
    }
  }

  _trimPersistedTypeCacheEntries(entryMap, maxEntries) {
    if (!(entryMap instanceof Map)) {
      return;
    }
    const limit = Math.max(50, Number(maxEntries) || 50);
    while (entryMap.size > limit) {
      const firstKey = entryMap.keys().next().value;
      entryMap.delete(firstKey);
    }
  }

  _getWorkspaceTypeCacheFileUri(workspaceKey) {
    if (!this._storageRootUri) {
      return undefined;
    }
    const normalizedWorkspaceKey = String(workspaceKey || "").trim();
    if (!normalizedWorkspaceKey) {
      return undefined;
    }
    const workspaceHash = crypto
      .createHash("sha1")
      .update(normalizedWorkspaceKey)
      .digest("hex");
    return vscode.Uri.joinPath(this._storageRootUri, `${workspaceHash}.json`);
  }

  _clearPersistTimerForWorkspace(workspaceKey) {
    const key = String(workspaceKey || "");
    if (!key) {
      return;
    }
    const timer = this._persistTimersByWorkspace.get(key);
    if (timer) {
      clearTimeout(timer);
      this._persistTimersByWorkspace.delete(key);
    }
  }

  _clearPersistTimers() {
    for (const timer of this._persistTimersByWorkspace.values()) {
      clearTimeout(timer);
    }
    this._persistTimersByWorkspace.clear();
  }

  async _postRequest(type, payload) {
    if (!this._worker) {
      throw new Error("worker unavailable");
    }
    const id = ++this._requestId;
    const timeoutMs = 30000;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingById.delete(id);
        reject(new Error(`worker request timeout: ${type}`));
      }, timeoutMs);

      this._pendingById.set(id, { resolve, reject, timeout });
      this._worker.postMessage({ id, type, payload });
    });
  }

  _handleWorkerMessage(message) {
    const id = Number(message?.id);
    if (!Number.isFinite(id)) {
      return;
    }
    const pending = this._pendingById.get(id);
    if (!pending) {
      return;
    }
    this._pendingById.delete(id);
    clearTimeout(pending.timeout);
    if (message && message.error) {
      pending.reject(new Error(String(message.error)));
      return;
    }
    pending.resolve(message ? message.result : undefined);
  }

  _handleWorkerFailure(error) {
    const message = error && error.message ? error.message : String(error);
    console.warn("[robot-companion] Return worker failed:", message);
    this._failAllPendingRequests(new Error(message));
  }

  _handleWorkerExit(code) {
    if (code !== 0) {
      console.warn(`[robot-companion] Return worker exited with code ${code}`);
    }
    this._worker = undefined;
    this._isAvailable = false;
    this._failAllPendingRequests(new Error("return worker exited"));
  }

  _failAllPendingRequests(error) {
    for (const [id, pending] of this._pendingById.entries()) {
      this._pendingById.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

class RobotRuntimeCacheService {
  constructor(enumHintService, returnComputeWorker) {
    this._enumHintService = enumHintService;
    this._returnComputeWorker = returnComputeWorker;
    this._stateByUri = new Map();
    this._prewarmQueue = [];
    this._prewarmQueuedUris = new Set();
    this._prewarmRunning = false;
    this._prewarmTimer = undefined;
    this._lastInteractiveAt = 0;
    this._prewarmAbortRequested = false;
    this._backgroundTaskKeys = new Set();
    this._backgroundTaskTimers = new Map();
  }

  dispose() {
    this.invalidateAll();
  }

  invalidateAll() {
    this._stateByUri.clear();
    this._prewarmQueue = [];
    this._prewarmQueuedUris.clear();
    if (this._prewarmTimer) {
      clearTimeout(this._prewarmTimer);
      this._prewarmTimer = undefined;
    }
    this._prewarmRunning = false;
    this._prewarmAbortRequested = false;
    for (const timer of this._backgroundTaskTimers.values()) {
      clearTimeout(timer);
    }
    this._backgroundTaskTimers.clear();
    this._backgroundTaskKeys.clear();
  }

  markInteractiveActivity() {
    this._lastInteractiveAt = Date.now();
    this._prewarmAbortRequested = true;
  }

  async runWhenInteractiveIdle(task, maxWaitMs = INTERACTIVE_IDLE_WAIT_MS) {
    if (typeof task !== "function") {
      return undefined;
    }
    const startedAt = Date.now();
    const timeoutMs = Math.max(0, Number(maxWaitMs) || 0);
    while (this._isInteractiveHot()) {
      if (Date.now() - startedAt >= timeoutMs) {
        return undefined;
      }
      await delay(PREWARM_RESUME_CHECK_MS);
    }
    return await task();
  }

  scheduleBackgroundTask(taskKey, task, options = {}) {
    const key = String(taskKey || "").trim();
    if (!key || typeof task !== "function") {
      return false;
    }
    if (this._backgroundTaskKeys.has(key)) {
      return false;
    }

    this._backgroundTaskKeys.add(key);
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    const maxWaitMs = Math.max(
      PREWARM_RESUME_CHECK_MS,
      Number(options.maxWaitMs) || BACKGROUND_TASK_MAX_WAIT_MS
    );
    const timer = setTimeout(async () => {
      this._backgroundTaskTimers.delete(key);
      try {
        await this.runWhenInteractiveIdle(task, maxWaitMs);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-companion] Background cache task failed:", message);
      } finally {
        this._backgroundTaskKeys.delete(key);
      }
    }, delayMs);
    this._backgroundTaskTimers.set(key, timer);
    return true;
  }

  invalidateForUri(uri) {
    if (!uri) {
      return;
    }
    const key = uri.toString();
    this._stateByUri.delete(key);
    this._prewarmQueuedUris.delete(key);
    this._prewarmQueue = this._prewarmQueue.filter((item) => item.uri !== key);
    for (const [taskKey, timer] of this._backgroundTaskTimers.entries()) {
      if (!taskKey.includes(key)) {
        continue;
      }
      clearTimeout(timer);
      this._backgroundTaskTimers.delete(taskKey);
      this._backgroundTaskKeys.delete(taskKey);
    }
  }

  invalidateOnRobotDocumentChange(event) {
    if (!event || !event.document || !isRobotDocument(event.document)) {
      return;
    }
    const uriKey = event.document.uri.toString();
    const state = this._stateByUri.get(uriKey);
    if (!state) {
      return;
    }

    const minChangedLine = getMinChangedLine(event.contentChanges || []);
    const structural = isStructuralRobotDocumentChange(event.contentChanges || []);
    if (structural || !Number.isFinite(minChangedLine)) {
      state.pendingInvalidateAll = true;
      state.pendingInvalidateFromLine = 0;
      return;
    }
    const previousMin = Number.isFinite(state.pendingInvalidateFromLine)
      ? Number(state.pendingInvalidateFromLine)
      : Number.MAX_SAFE_INTEGER;
    state.pendingInvalidateFromLine = Math.max(0, Math.min(previousMin, minChangedLine));
  }

  ensureState(document, parsed) {
    if (!document || !parsed) {
      return undefined;
    }
    const uriKey = document.uri.toString();
    const indexGeneration = this._enumHintService
      ? this._enumHintService.getGenerationForDocument(document)
      : 0;
    const settingsSignature = getRuntimeCacheSettingsSignature();
    let state = this._stateByUri.get(uriKey);
    if (!state) {
      state = this._createState(parsed, indexGeneration, settingsSignature);
      this._stateByUri.set(uriKey, state);
      return state;
    }

    const settingsChanged =
      state.indexGeneration !== indexGeneration || state.settingsSignature !== settingsSignature;
    if (settingsChanged) {
      this._clearStateBuckets(state);
      state.indexGeneration = indexGeneration;
      state.settingsSignature = settingsSignature;
      state.pendingInvalidateAll = false;
      state.pendingInvalidateFromLine = undefined;
    }

    if (state.pendingInvalidateAll) {
      this._clearStateBuckets(state);
      state.pendingInvalidateAll = false;
      state.pendingInvalidateFromLine = undefined;
    } else if (Number.isFinite(state.pendingInvalidateFromLine)) {
      this._invalidateStateBucketsFromLine(state, Number(state.pendingInvalidateFromLine));
      state.pendingInvalidateFromLine = undefined;
    }

    if (state.parsedVersion !== parsed.version) {
      state.lookups = this._buildLookups(parsed);
      state.parsedVersion = parsed.version;
    }

    return state;
  }

  async getOrCompute(state, bucketName, cacheKey, computeFn, metadata = {}) {
    if (!state || !bucketName || !cacheKey || typeof computeFn !== "function") {
      return await computeFn();
    }
    const bucket = this._getBucket(state, bucketName);
    const existingEntry = bucket.get(cacheKey);
    if (existingEntry) {
      return await existingEntry.value;
    }

    const valuePromise = Promise.resolve().then(computeFn);
    bucket.set(cacheKey, {
      value: valuePromise,
      metadata: {
        referenceLine: Number.isFinite(Number(metadata.referenceLine))
          ? Math.max(0, Number(metadata.referenceLine))
          : undefined
      }
    });
    this._trimBucket(bucket, RUNTIME_CACHE_MAX_ENTRIES_PER_BUCKET);

    try {
      const resolved = await valuePromise;
      bucket.set(cacheKey, {
        value: resolved,
        metadata: {
          referenceLine: Number.isFinite(Number(metadata.referenceLine))
            ? Math.max(0, Number(metadata.referenceLine))
            : undefined
        }
      });
      return resolved;
    } catch (error) {
      bucket.delete(cacheKey);
      throw error;
    }
  }

  getLookupState(document, parsed) {
    const state = this.ensureState(document, parsed);
    return state ? state.lookups : undefined;
  }

  getCachedValue(state, bucketName, cacheKey, options = {}) {
    if (!state || !bucketName || !cacheKey) {
      return undefined;
    }
    const bucket = this._getBucket(state, bucketName);
    const entry = bucket.get(cacheKey);
    if (!entry) {
      return undefined;
    }
    const allowPending = options.allowPending !== false;
    if (!allowPending && entry.value && typeof entry.value.then === "function") {
      return undefined;
    }
    return entry.value;
  }

  getCachedHtml(cacheKey) {
    const key = String(cacheKey || "");
    if (!key) {
      return "";
    }
    const state = this._stateByUri.get("__html__");
    if (!state) {
      return "";
    }
    const bucket = state.buckets?.html;
    if (!(bucket instanceof Map)) {
      return "";
    }
    return String(bucket.get(key) || "");
  }

  setCachedHtml(cacheKey, value) {
    const key = String(cacheKey || "");
    if (!key) {
      return;
    }
    let state = this._stateByUri.get("__html__");
    if (!state) {
      state = {
        buckets: {
          html: new Map()
        }
      };
      this._stateByUri.set("__html__", state);
    }
    const bucket = state.buckets?.html;
    if (!(bucket instanceof Map)) {
      return;
    }
    bucket.set(key, String(value || ""));
    this._trimBucket(bucket, RUNTIME_HTML_CACHE_MAX_ENTRIES);
  }

  schedulePrewarmForOpenDocuments(parser, preferredDocumentUri = "") {
    if (!isOpenFilePrewarmEnabled() || shouldPauseRobotCompanionPrewarmForDebug()) {
      return;
    }
    const mode = getOpenFilePrewarmMode();
    const docs = vscode.workspace.textDocuments.filter((document) => isRobotDocument(document));
    const preferredUri = String(preferredDocumentUri || "");
    const activeUri = vscode.window.activeTextEditor?.document?.uri?.toString() || "";
    const orderedDocs = docs
      .slice()
      .sort((left, right) => {
        const leftUri = left.uri.toString();
        const rightUri = right.uri.toString();
        const leftScore = leftUri === preferredUri ? 3 : leftUri === activeUri ? 2 : 0;
        const rightScore = rightUri === preferredUri ? 3 : rightUri === activeUri ? 2 : 0;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return leftUri.localeCompare(rightUri);
      });

    const targetDocs = mode === "active" ? orderedDocs.slice(0, 1) : orderedDocs;
    for (const document of targetDocs) {
      this._enqueuePrewarmDocument(document.uri.toString());
    }
    this._schedulePrewarmRun(parser, PREWARM_DEFAULT_DELAY_MS);
  }

  _enqueuePrewarmDocument(uri) {
    const key = String(uri || "").trim();
    if (!key || this._prewarmQueuedUris.has(key)) {
      return;
    }
    this._prewarmQueuedUris.add(key);
    this._prewarmQueue.push({
      uri: key,
      enqueuedAt: Date.now()
    });
  }

  _schedulePrewarmRun(parser, delayMs = PREWARM_DEFAULT_DELAY_MS) {
    if (this._prewarmRunning || this._prewarmTimer) {
      return;
    }
    this._prewarmTimer = setTimeout(() => {
      this._prewarmTimer = undefined;
      void this._runPrewarm(parser);
    }, Math.max(0, Number(delayMs) || 0));
  }

  async _runPrewarm(parser) {
    if (this._prewarmRunning || !parser) {
      return;
    }
    this._prewarmRunning = true;
    this._prewarmAbortRequested = false;
    try {
      while (this._prewarmQueue.length > 0) {
        if (this._shouldPausePrewarm()) {
          this._schedulePrewarmRun(parser, PREWARM_RESUME_CHECK_MS);
          break;
        }
        const next = this._prewarmQueue.shift();
        const uri = String(next?.uri || "");
        this._prewarmQueuedUris.delete(uri);
        if (!uri) {
          continue;
        }
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.toString() === uri && isRobotDocument(candidate)
        );
        if (!document) {
          continue;
        }
        const completed = await this._prewarmDocument(document, parser);
        if (!completed) {
          this._enqueuePrewarmDocument(uri);
          this._schedulePrewarmRun(parser, PREWARM_RESUME_CHECK_MS);
          break;
        }
        await delay(0);
      }
    } finally {
      this._prewarmRunning = false;
      if (this._prewarmQueue.length > 0 && !this._prewarmTimer) {
        const nextDelay = this._shouldPausePrewarm() ? PREWARM_RESUME_CHECK_MS : PREWARM_DEFAULT_DELAY_MS;
        this._schedulePrewarmRun(parser, nextDelay);
      }
    }
  }

  async _prewarmDocument(document, parser) {
    if (this._shouldPausePrewarm()) {
      return false;
    }
    const parsed = parser.getParsed(document);
    const state = this.ensureState(document, parsed);
    if (!state) {
      return true;
    }
    const prewarmSignature = `${state.parsedVersion}|${state.indexGeneration}|${state.settingsSignature}`;
    if (state.lastPrewarmSignature === prewarmSignature) {
      return true;
    }

    const index = await this._enumHintService.getIndexForDocument(document);
    if (!index) {
      return true;
    }

    const maxDepth = getReturnPreviewMaxDepth();
    const maxFieldsPerType = getReturnMaxFieldsPerType();
    let processed = 0;
    for (const assignment of parsed.keywordCallAssignments || []) {
      if (this._shouldPausePrewarm()) {
        return false;
      }
      const owner = state.lookups.ownerById.get(assignment.ownerId);
      if (!owner) {
        continue;
      }
      const returnVariables = Array.isArray(assignment.returnVariables) ? assignment.returnVariables : [];
      for (const returnVariable of returnVariables) {
        if (this._shouldPausePrewarm()) {
          return false;
        }
        const variableToken = String(returnVariable || "").trim();
        if (!variableToken) {
          continue;
        }
        const variableContext = {
          owner,
          variableToken: {
            token: variableToken,
            start: 0,
            end: variableToken.length
          },
          assignment
        };
        const cacheKey = buildReturnContextCacheKey(
          variableContext,
          maxDepth,
          maxFieldsPerType,
          true
        );
        await this.getOrCompute(
          state,
          "returnPreview",
          cacheKey,
          () =>
            resolveKeywordReturnPreviewFromVariableContext(
              document,
              parsed,
              variableContext,
              this._enumHintService,
              {
                maxDepth,
                maxFieldsPerType,
                includeTechnical: true,
                runtimeCache: this,
                precomputedIndex: index,
                returnComputeWorker: this._returnComputeWorker
              }
            ),
          { referenceLine: assignment.startLine }
        );
        processed += 1;
        if (processed % 20 === 0) {
          if (this._shouldPausePrewarm()) {
            return false;
          }
          await delay(0);
        }
      }
    }

    state.lastPrewarmSignature = prewarmSignature;
    return true;
  }

  _isInteractiveHot() {
    if (!this._lastInteractiveAt) {
      return false;
    }
    return Date.now() - this._lastInteractiveAt < PREWARM_IDLE_REQUIRED_MS;
  }

  _shouldPausePrewarm() {
    if (shouldPauseRobotCompanionPrewarmForDebug()) {
      return true;
    }
    if (!this._prewarmAbortRequested) {
      return this._isInteractiveHot();
    }
    if (this._isInteractiveHot()) {
      return true;
    }
    this._prewarmAbortRequested = false;
    return false;
  }

  _buildLookups(parsed) {
    const ownerById = new Map();
    for (const owner of parsed.owners || []) {
      if (owner && owner.id) {
        ownerById.set(owner.id, owner);
      }
    }

    const variableAssignmentsByOwnerAndVariable = new Map();
    for (const assignment of parsed.variableAssignments || []) {
      const ownerId = String(assignment.ownerId || "");
      const normalizedVariable = String(assignment.normalizedVariable || "");
      if (!ownerId || !normalizedVariable) {
        continue;
      }
      let ownerMap = variableAssignmentsByOwnerAndVariable.get(ownerId);
      if (!ownerMap) {
        ownerMap = new Map();
        variableAssignmentsByOwnerAndVariable.set(ownerId, ownerMap);
      }
      const items = ownerMap.get(normalizedVariable) || [];
      items.push(assignment);
      ownerMap.set(normalizedVariable, items);
    }

    const keywordAssignmentsByOwner = new Map();
    const keywordAssignmentsByOwnerAndVariable = new Map();
    for (const assignment of parsed.keywordCallAssignments || []) {
      const ownerId = String(assignment.ownerId || "");
      if (!ownerId) {
        continue;
      }
      const byOwner = keywordAssignmentsByOwner.get(ownerId) || [];
      byOwner.push(assignment);
      keywordAssignmentsByOwner.set(ownerId, byOwner);

      let ownerMap = keywordAssignmentsByOwnerAndVariable.get(ownerId);
      if (!ownerMap) {
        ownerMap = new Map();
        keywordAssignmentsByOwnerAndVariable.set(ownerId, ownerMap);
      }
      const normalizedVariables = Array.isArray(assignment.normalizedReturnVariables)
        ? assignment.normalizedReturnVariables
        : [];
      for (const normalizedVariable of normalizedVariables) {
        if (!normalizedVariable) {
          continue;
        }
        const items = ownerMap.get(normalizedVariable) || [];
        items.push(assignment);
        ownerMap.set(normalizedVariable, items);
      }
    }

    for (const ownerMap of variableAssignmentsByOwnerAndVariable.values()) {
      for (const items of ownerMap.values()) {
        items.sort((left, right) => Number(left.startLine) - Number(right.startLine));
      }
    }
    for (const items of keywordAssignmentsByOwner.values()) {
      items.sort((left, right) => Number(left.startLine) - Number(right.startLine));
    }
    for (const ownerMap of keywordAssignmentsByOwnerAndVariable.values()) {
      for (const items of ownerMap.values()) {
        items.sort((left, right) => Number(left.startLine) - Number(right.startLine));
      }
    }

    return {
      ownerById,
      variableAssignmentsByOwnerAndVariable,
      keywordAssignmentsByOwner,
      keywordAssignmentsByOwnerAndVariable
    };
  }

  _createState(parsed, indexGeneration, settingsSignature) {
    return {
      uri: String(parsed.uri || ""),
      parsedVersion: Number(parsed.version) || 0,
      indexGeneration,
      settingsSignature,
      lookups: this._buildLookups(parsed),
      buckets: {
        returnPreview: new Map(),
        returnHint: new Map(),
        enumPreview: new Map(),
        variableValue: new Map(),
        typedVariableCompletion: new Map(),
        returnMemberCompletion: new Map()
      },
      pendingInvalidateAll: false,
      pendingInvalidateFromLine: undefined,
      lastPrewarmSignature: ""
    };
  }

  _clearStateBuckets(state) {
    if (!state || !state.buckets) {
      return;
    }
    for (const bucket of Object.values(state.buckets)) {
      if (bucket instanceof Map) {
        bucket.clear();
      }
    }
    state.lastPrewarmSignature = "";
  }

  _invalidateStateBucketsFromLine(state, minLine) {
    if (!state || !state.buckets) {
      return;
    }
    const threshold = Math.max(0, Number(minLine) || 0);
    for (const bucket of Object.values(state.buckets)) {
      if (!(bucket instanceof Map)) {
        continue;
      }
      for (const [key, entry] of bucket.entries()) {
        const referenceLine = Number(entry?.metadata?.referenceLine);
        if (!Number.isFinite(referenceLine)) {
          continue;
        }
        if (referenceLine >= threshold) {
          bucket.delete(key);
        }
      }
    }
    state.lastPrewarmSignature = "";
  }

  _getBucket(state, bucketName) {
    if (!state.buckets[bucketName]) {
      state.buckets[bucketName] = new Map();
    }
    return state.buckets[bucketName];
  }

  _trimBucket(bucket, maxEntries) {
    if (!(bucket instanceof Map)) {
      return;
    }
    const limit = Math.max(100, Number(maxEntries) || 100);
    while (bucket.size > limit) {
      const firstKey = bucket.keys().next().value;
      bucket.delete(firstKey);
    }
  }
}

class RobotDocCodeLensProvider {
  constructor(parser) {
    this._parser = parser;
    this._onDidChangeCodeLensesEmitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLensesEmitter.event;
  }

  dispose() {
    this._onDidChangeCodeLensesEmitter.dispose();
  }

  refresh() {
    this._onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(document) {
    if (
      !isRobotDocument(document) ||
      !isCodeLensEnabled() ||
      shouldPauseRobotCompanionPassiveEditorFeaturesForDebug()
    ) {
      return [];
    }

    const parsed = this._parser.getParsed(document);
    return parsed.blocks.map(
      (block) =>
        new vscode.CodeLens(new vscode.Range(block.startLine, 0, block.startLine, 0), {
          title: "Open rendered documentation preview",
          command: CMD_OPEN_BLOCK_AT,
          arguments: [document.uri.toString(), block.id]
        })
    );
  }
}

class RobotDocFoldingRangeProvider {
  constructor(parser) {
    this._parser = parser;
    this._onDidChangeFoldingRangesEmitter = new vscode.EventEmitter();
    this.onDidChangeFoldingRanges = this._onDidChangeFoldingRangesEmitter.event;
  }

  refresh() {
    this._onDidChangeFoldingRangesEmitter.fire();
  }

  provideFoldingRanges(document) {
    if (!isRobotDocument(document) || shouldPauseRobotCompanionPassiveEditorFeaturesForDebug()) {
      return [];
    }

    const parsed = this._parser.getParsed(document);
    const foldingTrace = buildDocumentationFoldingTrace(parsed.blocks);
    const documentUri = document.uri?.toString?.() || "";
    const activeBodyFoldTier = getActiveDocumentationBodyFoldTier(documentUri);
    const bodyRanges = buildAllDocumentationBodyFoldingRanges(parsed.blocks);
    const providerRanges =
      activeBodyFoldTier === null
        ? buildDocumentationProviderRanges(parsed.blocks, document)
        : extendDocumentationProviderRangesAcrossBlankLines(
            buildDocumentationBodyFoldingRanges(parsed.blocks, activeBodyFoldTier),
            document
          );
    if (getRobotCompanionLogLevel() === "trace") {
      logRobotCompanionTrace("Documentation folding trace", {
        documentUri,
        lineCount: Number(document.lineCount) || 0,
        blockCount: Array.isArray(parsed.blocks) ? parsed.blocks.length : 0,
        activeBodyFoldTier,
        blocks: foldingTrace.blocks,
        bodyRanges,
        ranges: providerRanges
      });
    }
    return providerRanges.map(
      (range) => new vscode.FoldingRange(range.startLine, range.endLine, vscode.FoldingRangeKind.Region)
    );
  }
}

class RobotDocHoverProvider {
  constructor(parser, enumHintService, runtimeCacheService, returnComputeWorker) {
    this._parser = parser;
    this._enumHintService = enumHintService;
    this._runtimeCacheService = runtimeCacheService;
    this._returnComputeWorker = returnComputeWorker;
  }

  async provideHover(document, position, token) {
    if (!isRobotDocument(document) || shouldPauseRobotCompanionPassiveEditorFeaturesForDebug()) {
      return undefined;
    }
    this._runtimeCacheService?.markInteractiveActivity();
    if (isHoverCancellationRequested(token)) {
      return undefined;
    }

    const parsed = this._parser.getParsed(document);
    const runtimeLookups = this._runtimeCacheService?.getLookupState(document, parsed);
    const namedArgumentContext = isEnumValueHoverEnabled()
      ? getNamedArgumentValueContextAtPosition(document, position)
      : undefined;
    if (namedArgumentContext) {
      try {
        const enumHover = await createEnumValueHover(
          document,
          position,
          this._enumHintService,
          parsed,
          this._runtimeCacheService,
          {
            cacheOnly: true,
            cancellationToken: token,
            returnComputeWorker: this._returnComputeWorker
          }
        );
        if (isHoverCancellationRequested(token)) {
          return undefined;
        }
        if (enumHover) {
          return enumHover;
        }
      } catch (error) {
        logRobotCompanionError("Enum hover failed", error, {
          documentUri: document.uri.toString(),
          line: position.line,
          character: position.character,
          stage: "cacheOnly"
        });
      }

      const shouldContinueWithFallback = await waitForHoverFallbackWindow(token);
      if (!shouldContinueWithFallback) {
        return undefined;
      }
      try {
        const enumHover = await createEnumValueHover(
          document,
          position,
          this._enumHintService,
          parsed,
          this._runtimeCacheService,
          {
            cacheOnly: false,
            cancellationToken: token,
            returnComputeWorker: this._returnComputeWorker
          }
        );
        if (isHoverCancellationRequested(token)) {
          return undefined;
        }
        if (enumHover) {
          return enumHover;
        }
      } catch (error) {
        logRobotCompanionError("Enum hover fallback compute failed", error, {
          documentUri: document.uri.toString(),
          line: position.line,
          character: position.character,
          stage: "compute"
        });
      }
    }

    if (isVariableValueHoverEnabled()) {
      const variableHover = createVariableValueHover(document, parsed, position, this._runtimeCacheService);
      if (variableHover) {
        return variableHover;
      }
    }

    const returnVariableContext = isReturnValueHoverEnabled()
      ? getKeywordReturnVariableContextAtPosition(document, parsed, position, runtimeLookups)
      : undefined;
    if (returnVariableContext) {
      try {
        const returnHover = await createKeywordReturnHover(
          document,
          parsed,
          position,
          this._enumHintService,
          this._runtimeCacheService,
          {
            cacheOnly: true,
            cancellationToken: token,
            returnComputeWorker: this._returnComputeWorker
          }
        );
        if (isHoverCancellationRequested(token)) {
          return undefined;
        }
        if (returnHover) {
          return returnHover;
        }
      } catch (error) {
        logRobotCompanionError("Return hover failed", error, {
          documentUri: document.uri.toString(),
          line: position.line,
          character: position.character,
          stage: "cacheOnly"
        });
      }

      const shouldContinueWithFallback = await waitForHoverFallbackWindow(token);
      if (!shouldContinueWithFallback) {
        return undefined;
      }
      try {
        const returnHover = await createKeywordReturnHover(
          document,
          parsed,
          position,
          this._enumHintService,
          this._runtimeCacheService,
          {
            cacheOnly: false,
            cancellationToken: token,
            returnComputeWorker: this._returnComputeWorker
          }
        );
        if (isHoverCancellationRequested(token)) {
          return undefined;
        }
        if (returnHover) {
          return returnHover;
        }
      } catch (error) {
        logRobotCompanionError("Return hover fallback compute failed", error, {
          documentUri: document.uri.toString(),
          line: position.line,
          character: position.character,
          stage: "compute"
        });
      }
    }

    if (!isHoverPreviewEnabled()) {
      return undefined;
    }
    if (isHoverCancellationRequested(token)) {
      return undefined;
    }

    const block = parsed.blocks.find((candidate) => getContainingBlockSpan(candidate, position.line));

    if (!block) {
      return undefined;
    }

    const containingSpan = getContainingBlockSpan(block, position.line) || {
      startLine: block.startLine,
      endLine: block.endLine
    };

    const hoverLineLimit = getHoverLineLimit();
    const hoverSourceLines = block.markdown.split(/\r?\n/);
    const isTruncated = hoverLineLimit > 0 && hoverSourceLines.length > hoverLineLimit;
    const shownLines = isTruncated ? hoverSourceLines.slice(0, hoverLineLimit) : hoverSourceLines;

    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = {
      enabledCommands: [CMD_OPEN_BLOCK_AT]
    };
    markdown.supportHtml = false;

    markdown.appendMarkdown("### Robot Documentation Preview\n\n");
    markdown.appendMarkdown("**Title:** ");
    markdown.appendText(block.title);
    markdown.appendMarkdown("  \n");
    markdown.appendMarkdown("**Owner:** ");
    markdown.appendText(block.ownerName);
    markdown.appendMarkdown("\n\n---\n\n");

    if (shownLines.join("\n").trim().length === 0) {
      markdown.appendMarkdown("_No documentation content in this block._");
    } else {
      markdown.appendMarkdown(stripArrowIndentTokens(formatMarkdownForDisplay(shownLines.join("\n"))));
    }

    if (isTruncated) {
      markdown.appendMarkdown(
        `\n\n---\n\n_Showing first ${hoverLineLimit} of ${hoverSourceLines.length} lines in hover._`
      );
    }

    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), block.id]));
    markdown.appendMarkdown(`\n\n[Open full rendered preview](command:${CMD_OPEN_BLOCK_AT}?${args})`);

    const endLine = Math.max(containingSpan.startLine, containingSpan.endLine);
    const range = new vscode.Range(
      containingSpan.startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length
    );
    return new vscode.Hover(markdown, range);
  }
}

class RobotTypedVariableCompletionProvider {
  constructor(parser, enumHintService, runtimeCacheService, returnComputeWorker) {
    this._parser = parser;
    this._enumHintService = enumHintService;
    this._runtimeCacheService = runtimeCacheService;
    this._returnComputeWorker = returnComputeWorker;
    this._memberCompletionMemo = new Map();
  }

  dispose() {
    this._memberCompletionMemo.clear();
  }

  async provideCompletionItems(document, position) {
    if (!isRobotDocument(document) || shouldPauseRobotCompanionPassiveEditorFeaturesForDebug()) {
      return undefined;
    }
    this._runtimeCacheService?.markInteractiveActivity();

    const parsed = this._parser.getParsed(document);
    const argumentContext = getNamedArgumentValueContextAtPosition(document, position);
    if (!argumentContext) {
      return undefined;
    }

    if (
      !Number.isFinite(argumentContext.valueStart) ||
      !Number.isFinite(argumentContext.valueEnd) ||
      position.character < argumentContext.valueStart
    ) {
      return undefined;
    }

    const owner = findOwnerForLine(parsed.owners, position.line);
    if (!owner) {
      return undefined;
    }
    const runtimeState = this._runtimeCacheService?.ensureState(document, parsed);
    const runtimeLookups = runtimeState?.lookups;

    const memberContext = parseNamedArgumentMemberCompletionContext(argumentContext, position);
    if (memberContext) {
      if (!isReturnMemberCompletionsEnabled()) {
        return undefined;
      }
      const memberItems = await this._provideReturnMemberCompletions(
        document,
        parsed,
        position,
        owner,
        runtimeState,
        runtimeLookups,
        memberContext
      );
      if (memberItems.length > 0) {
        return new vscode.CompletionList(memberItems, false);
      }
      return undefined;
    }

    const enumCompletionItems = await this._provideEnumValueCompletions(
      document,
      parsed,
      position,
      argumentContext
    );

    if (!isTypedVariableCompletionsEnabled()) {
      return enumCompletionItems.length > 0
        ? new vscode.CompletionList(enumCompletionItems, false)
        : undefined;
    }

    const normalizedKeyword = normalizeKeywordName(argumentContext.keywordName);
    const normalizedArgument = normalizeArgumentName(argumentContext.argumentName);
    const completionCacheKey = buildTypedVariableCompletionCacheKey(
      owner,
      position.line,
      normalizedKeyword,
      normalizedArgument,
      []
    );
    const cachedMatchingVariables = runtimeState
      ? this._runtimeCacheService?.getCachedValue(runtimeState, "typedVariableCompletion", completionCacheKey, {
          allowPending: false
        })
      : undefined;

    if (!Array.isArray(cachedMatchingVariables)) {
      this._runtimeCacheService?.scheduleBackgroundTask(
        `typed-completion|${document.uri.toString()}|${document.version}|${completionCacheKey}`,
        async () => {
          const latestParsed = this._parser.getParsed(document);
          const latestState = this._runtimeCacheService?.ensureState(document, latestParsed);
          if (!latestState) {
            return;
          }
          await this._runtimeCacheService.getOrCompute(
            latestState,
            "typedVariableCompletion",
            completionCacheKey,
            async () => {
              const index = await this._enumHintService.getIndexForDocument(document);
              if (!index) {
                return [];
              }
              const expectedTypeNames = resolveExpectedArgumentTypeNames(
                index,
                normalizedKeyword,
                normalizedArgument
              );
              if (expectedTypeNames.size === 0) {
                return [];
              }
              const latestOwner = findOwnerForLine(latestParsed.owners, position.line);
              if (!latestOwner) {
                return [];
              }
              return collectMatchingTypedReturnVariables(
                latestParsed,
                index,
                latestOwner,
                position.line,
                expectedTypeNames,
                latestState.lookups
              );
            },
            { referenceLine: position.line }
          );
        },
        { maxWaitMs: BACKGROUND_TASK_MAX_WAIT_MS }
      );
      return enumCompletionItems.length > 0
        ? new vscode.CompletionList(enumCompletionItems, false)
        : undefined;
    }

    if (cachedMatchingVariables.length === 0) {
      return enumCompletionItems.length > 0
        ? new vscode.CompletionList(enumCompletionItems, false)
        : undefined;
    }

    const replaceStart = Math.max(0, Number(argumentContext.valueStart) || 0);
    const replaceEnd = Math.max(replaceStart, Number(argumentContext.valueEnd) || replaceStart);
    const replacementRange = new vscode.Range(position.line, replaceStart, position.line, replaceEnd);

    const typedVariableItems = cachedMatchingVariables.map((candidate) => {
      const item = new vscode.CompletionItem(candidate.variableToken, vscode.CompletionItemKind.Variable);
      item.textEdit = vscode.TextEdit.replace(replacementRange, candidate.variableToken);
      item.detail = `Type-matched variable for ${argumentContext.argumentName}`;
      item.documentation = new vscode.MarkdownString(
        `From keyword \`${candidate.keywordName}\` (line ${candidate.assignmentLine + 1})\n\n` +
          `Return types: \`${candidate.typeNamesOriginal.join(" | ")}\``
      );
      item.sortText = `${String(999999 - candidate.assignmentLine).padStart(6, "0")}_${candidate.variableToken.toLowerCase()}`;
      return item;
    });

    const combinedItems = enumCompletionItems.concat(typedVariableItems);
    return combinedItems.length > 0 ? new vscode.CompletionList(combinedItems, false) : undefined;
  }

  async _provideEnumValueCompletions(document, parsed, position, argumentContext) {
    if (!isEnumValueHoverEnabled()) {
      return [];
    }

    const argumentValue = String(argumentContext?.argumentValue || "").trim();
    if (/^[@$&%]\{/.test(argumentValue)) {
      return [];
    }

    const enumContext = await resolveEnumValuePreviewFromContext(
      document,
      this._enumHintService,
      argumentContext,
      {
        parsed,
        runtimeCache: this._runtimeCacheService,
        referenceLine: position.line,
        showArgumentAssignment: false,
        showResolvedCurrentValue: false,
        showCurrentMemberMarker: false,
        maxEnums: Math.max(12, getEnumHoverMaxEnums()),
        maxMembers: Math.max(200, getEnumHoverMaxMembers())
      }
    );
    if (!enumContext || !Array.isArray(enumContext.shownEnums) || enumContext.shownEnums.length === 0) {
      return [];
    }

    const valueStart = Math.max(0, Number(argumentContext.valueStart) || 0);
    const valueEnd = Math.max(valueStart, Number(argumentContext.valueEnd) || valueStart);
    const replacementRange = new vscode.Range(position.line, valueStart, position.line, valueEnd);
    const normalizedPrefix = String(argumentValue || "").trim().toLowerCase();
    const completionDisplayMode = getEnumCompletionDisplayMode();
    const seen = new Set();
    const items = [];

    const pushItem = (insertText, enumName, memberName, valueLiteral, kind) => {
      const normalizedInsertText = String(insertText || "").trim();
      if (!normalizedInsertText) {
        return;
      }
      const lookupText = normalizedInsertText.toLowerCase();
      const aliasLookup = `${String(memberName || "").trim().toLowerCase()} ${String(valueLiteral || "")
        .trim()
        .toLowerCase()}`.trim();
      if (normalizedPrefix && !lookupText.startsWith(normalizedPrefix) && !aliasLookup.startsWith(normalizedPrefix)) {
        return;
      }
      const dedupeKey = `${kind}|${lookupText}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      const item = new vscode.CompletionItem(
        normalizedInsertText,
        vscode.CompletionItemKind.EnumMember
      );
      item.textEdit = vscode.TextEdit.replace(replacementRange, normalizedInsertText);
      item.sortText = `000_${String(enumName || "").toLowerCase()}_${lookupText}`;
      item.filterText = uniqueStrings(
        [normalizedInsertText, memberName, valueLiteral].map((value) => String(value || "").trim()).filter(Boolean)
      ).join(" ");
      const enumLabel = String(enumName || "").trim();
      if (kind === "value" && valueLiteral && valueLiteral !== memberName) {
        item.detail = enumLabel ? `${enumLabel} value (${memberName} = ${valueLiteral})` : "Enum value";
      } else {
        item.detail = enumLabel ? `${enumLabel} member` : "Enum member";
      }
      const docs = [];
      if (enumLabel) {
        docs.push(`Enum: \`${escapeMarkdownInline(enumLabel)}\``);
      }
      if (memberName) {
        docs.push(`Member: \`${escapeMarkdownInline(memberName)}\``);
      }
      if (valueLiteral && valueLiteral !== memberName) {
        docs.push(`Value: \`${escapeMarkdownInline(valueLiteral)}\``);
      }
      if (docs.length > 0) {
        item.documentation = new vscode.MarkdownString(docs.join("\n\n"));
      }
      items.push(item);
    };

    for (const enumEntry of enumContext.shownEnums) {
      const enumName = String(enumEntry?.name || "").trim();
      const members = Array.isArray(enumEntry?.members) ? enumEntry.members : [];
      for (const member of members) {
        const memberName = String(member?.name || "").trim();
        const valueLiteral = String(member?.valueLiteral || "").trim();
        const canShowName = completionDisplayMode === "name" || completionDisplayMode === "both";
        const canShowValue = completionDisplayMode === "value" || completionDisplayMode === "both";
        if (canShowName && memberName) {
          pushItem(memberName, enumName, memberName, valueLiteral, "name");
        }
        if (canShowValue && valueLiteral && (completionDisplayMode === "both" ? valueLiteral !== memberName : true)) {
          pushItem(valueLiteral, enumName, memberName, valueLiteral, "value");
        } else if (completionDisplayMode === "value" && !valueLiteral && memberName) {
          pushItem(memberName, enumName, memberName, valueLiteral, "value");
        }
        if (items.length >= ENUM_COMPLETION_MAX_ITEMS) {
          return items;
        }
      }
    }

    return items;
  }

  async _provideReturnMemberCompletions(
    document,
    parsed,
    position,
    owner,
    runtimeState,
    runtimeLookups,
    memberContext
  ) {
    const normalizedRootVariable = normalizeVariableLookupToken(memberContext.rootVariableToken);
    if (!normalizedRootVariable) {
      return [];
    }
    const selectedAssignment = runtimeLookups
      ? findLatestKeywordCallAssignmentForOwnerFromLookups(
          runtimeLookups,
          owner.id,
          normalizedRootVariable,
          position.line
        )
      : findLatestKeywordCallAssignmentForOwner(parsed, owner.id, normalizedRootVariable, position.line);
    if (!selectedAssignment) {
      return [];
    }

    const completionMaxDepth = getReturnMemberCompletionMaxDepth();
    const normalizedPathPrefix = memberContext.pathSegments.concat([memberContext.activeSegment]).join(".");
    const generation = Number(this._enumHintService?.getGenerationForDocument(document) || 0);
    const memoKey = [
      String(document.uri.toString() || ""),
      Number(document.version) || 0,
      generation,
      String(owner.id || ""),
      String(selectedAssignment.id || ""),
      normalizedRootVariable,
      normalizedPathPrefix,
      completionMaxDepth,
      getReturnFieldNameStyle(),
      getReturnIncludeProperties() ? "1" : "0"
    ].join("|");
    const memoHit = this._memberCompletionMemo.get(memoKey);
    if (Array.isArray(memoHit)) {
      return this._buildReturnMemberCompletionItems(memoHit, memberContext, selectedAssignment);
    }

    const completionCacheKey = buildReturnMemberCompletionCacheKey(
      owner,
      position.line,
      selectedAssignment,
      normalizedRootVariable,
      memberContext.pathSegments,
      memberContext.activeSegment,
      completionMaxDepth
    );
    let cachedCandidates = runtimeState
      ? this._runtimeCacheService?.getCachedValue(runtimeState, "returnMemberCompletion", completionCacheKey, {
          allowPending: false
        })
      : undefined;

    if (!Array.isArray(cachedCandidates)) {
      const computeCandidates = async () => {
        const index = await this._enumHintService.getIndexForDocument(document);
        if (!index) {
          return [];
        }
        return await resolveReturnMemberCompletionCandidatesForAssignment(
          document,
          index,
          selectedAssignment,
          memberContext,
          completionMaxDepth,
          this._returnComputeWorker
        );
      };

      if (runtimeState && this._runtimeCacheService) {
        cachedCandidates = await this._runtimeCacheService.getOrCompute(
          runtimeState,
          "returnMemberCompletion",
          completionCacheKey,
          computeCandidates,
          { referenceLine: Math.max(0, Number(selectedAssignment.startLine) || 0) }
        );
      } else {
        cachedCandidates = await computeCandidates();
      }
    }

    const candidates = Array.isArray(cachedCandidates) ? cachedCandidates : [];
    this._memberCompletionMemo.set(memoKey, candidates);
    this._trimMemberCompletionMemo();
    return this._buildReturnMemberCompletionItems(candidates, memberContext, selectedAssignment);
  }

  _buildReturnMemberCompletionItems(candidates, memberContext, assignment) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return [];
    }
    const replacementRange = new vscode.Range(
      memberContext.line,
      memberContext.replaceStart,
      memberContext.line,
      memberContext.replaceEnd
    );
    return candidates.map((candidate) => {
      const insertText = String(candidate?.insertText || candidate?.label || "").trim();
      if (!insertText) {
        return undefined;
      }
      const detailFromWorker =
        String(candidate?.detail || "").trim() || `Member of ${memberContext.rootVariableToken}`;
      const item = new vscode.CompletionItem(insertText, vscode.CompletionItemKind.Field);
      item.textEdit = vscode.TextEdit.replace(replacementRange, insertText);
      item.filterText = String(candidate?.filterText || insertText);
      item.sortText = `000_${String(candidate?.sortText || insertText).toLowerCase()}`;
      item.detail = detailFromWorker;
      const annotation = String(candidate?.annotation || "").trim();
      const typeDisplay = String(candidate?.typeDisplay || "").trim();
      const lines = [];
      if (typeDisplay) {
        lines.push(`Type: \`${escapeMarkdownInline(typeDisplay)}\``);
      }
      if (annotation) {
        lines.push(`Annotation: \`${escapeMarkdownInline(annotation)}\``);
      }
      if (assignment) {
        lines.push(
          `From keyword \`${escapeMarkdownInline(String(assignment.keywordName || ""))}\` (line ${
            Number(assignment.startLine) + 1
          })`
        );
      }
      if (lines.length > 0) {
        item.documentation = new vscode.MarkdownString(lines.join("\n\n"));
      }
      return item;
    }).filter(Boolean);
  }

  _trimMemberCompletionMemo() {
    while (this._memberCompletionMemo.size > MEMBER_COMPLETION_MEMO_MAX_ENTRIES) {
      const firstKey = this._memberCompletionMemo.keys().next().value;
      this._memberCompletionMemo.delete(firstKey);
    }
  }
}

class RobotDocPreviewViewProvider {
  constructor() {
    this._view = undefined;
    this._renderSequence = 0;
    this._state = createEmptyPreviewState();
    this._messageDisposable = undefined;
    this._messageHandler = undefined;
  }

  dispose() {
    this._messageDisposable?.dispose?.();
    this._messageDisposable = undefined;
    this._view = undefined;
  }

  setMessageHandler(handler) {
    this._messageHandler = typeof handler === "function" ? handler : undefined;
  }

  resolveWebviewView(webviewView) {
    this._messageDisposable?.dispose?.();
    this._view = webviewView;
    this._view.webview.options = {
      enableCommandUris: true,
      enableScripts: true
    };
    this._messageDisposable = this._view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type !== "executeCommandUri") {
        if (this._messageHandler) {
          try {
            await this._messageHandler(message);
          } catch (error) {
            logRobotCompanionError("Documentation-preview message handling failed", error, {
              messageType: String(message.type || "")
            });
          }
        }
        return;
      }

      try {
        await executeManagedCommandUri(message.commandUri);
      } catch (error) {
        logRobotCompanionError("Managed documentation-preview command execution failed", error, {
          commandUri: String(message.commandUri || "")
        });
      }
    });
    void this.render();
  }

  isVisible() {
    return Boolean(this._view && this._view.visible);
  }

  update(state) {
    this._state = state;
    void this.render();
  }

  async render() {
    if (!this._view) {
      return;
    }

    const currentSequence = ++this._renderSequence;

    const selectedBlock = getSelectedBlock(this._state);
    const returnedVariablesVisibleByBlockId = this._state.returnedVariablesVisibleByBlockId || {};
    const renderedMarkdownHtml = selectedBlock
      ? await renderDocumentationBlockHtml(this._state.documentUri, selectedBlock, {
          returnedVariablesVisible: returnedVariablesVisibleByBlockId[selectedBlock.id] === true,
          returnedVariablesToggleEnabled: true
        })
      : "<p class=\"muted\">No documentation block selected.</p>";

    if (!this._view || currentSequence !== this._renderSequence) {
      return;
    }

    this._view.webview.html = this._buildHtml(selectedBlock, renderedMarkdownHtml);
  }

  _buildHtml(selectedBlock, renderedMarkdownHtml) {
    const hasBlocks = this._state.blocks.length > 0;
    const hasKeywordBlocks = this._state.blocks.some((block) => block && block.section === "keywords");

    const blockItems = this._state.blocks
      .map((block) => {
        const overviewSection = escapeHtmlAttribute(String(block.section || ""));
        if (!this._state.documentUri) {
          return `<li class=\"list-item\" data-doc-overview-section=\"${overviewSection}\">${escapeHtml(
            block.ownerName || block.title
          )}</li>`;
        }

        const args = encodeURIComponent(JSON.stringify([this._state.documentUri, block.id]));
        const commandUri = `command:${CMD_OPEN_BLOCK_AT}?${args}`;
        const ownerJumpCommand = buildOpenLocationCommandUri(
          this._state.documentUri,
          Number.isFinite(Number(block.ownerStartLine)) ? Number(block.ownerStartLine) : Number(block.startLine) || 0
        );
        const ownerJumpLabel = getDocumentationOwnerJumpLabel(block);
        const isActive = selectedBlock && selectedBlock.id === block.id;
        const activeClass = isActive ? " active" : "";

        return `<li class=\"list-item${activeClass}\" data-doc-overview-section=\"${overviewSection}\"><div class=\"list-item-row\"><a href=\"${commandUri}\">${escapeHtml(
          block.ownerName || block.title
        )}</a>${
          ownerJumpCommand ? `<a class=\"testcase-jump\" href=\"${ownerJumpCommand}\">${escapeHtml(ownerJumpLabel)}</a>` : ""
        }</div></li>`;
      })
      .join("\n");

    const fileInfo = this._state.fileName
      ? `<div class=\"file\">${escapeHtml(this._state.fileName)}</div>`
      : "<div class=\"file muted\">Open a .robot file to start.</div>";

    const metadata = selectedBlock
      ? `<div class=\"meta\">Owner: ${escapeHtml(selectedBlock.ownerName)} | Lines: ${
          selectedBlock.startLine + 1
        }-${selectedBlock.endLine + 1}</div>`
      : "<div class=\"meta muted\">Move cursor into documentation or inline #> docs, or use command palette.</div>";
    const previewActions = buildDocumentationPreviewActionsHtml(this._state.documentUri, selectedBlock?.id || "");

    const message = this._state.infoMessage
      ? `<div class=\"notice\">${escapeHtml(this._state.infoMessage)}</div>`
      : "";

    const overviewKeywordToggle =
      hasBlocks && hasKeywordBlocks
        ? `<label class=\"overview-filter\"><input type=\"checkbox\" data-doc-overview-keyword-toggle checked /> <span>Show keywords</span></label>`
        : "";

    const listContent = hasBlocks
      ? `${overviewKeywordToggle}<ul class=\"list\">${blockItems}</ul>`
      : "<div class=\"muted\">No documentation or inline #> docs found in Test Cases/Tasks/Keywords.</div>";

    const selectedOwnerJumpCommand =
      selectedBlock && this._state.documentUri
        ? buildOpenLocationCommandUri(
            this._state.documentUri,
            Number.isFinite(Number(selectedBlock.ownerStartLine))
              ? Number(selectedBlock.ownerStartLine)
              : Number(selectedBlock.startLine) || 0
          )
        : "";
    const selectedOwnerJumpLabel = getDocumentationOwnerJumpLabel(selectedBlock);
    const previewTitle = selectedBlock
      ? `<h2 class=\"preview-title\">${escapeHtml(selectedBlock.ownerName || selectedBlock.title)}</h2>`
      : "<h2 class=\"preview-title\">Documentation Preview</h2>";
    const previewSubtitle =
      selectedBlock && selectedOwnerJumpCommand
        ? `<div class=\"preview-subtitle\"><a href=\"${selectedOwnerJumpCommand}\">${escapeHtml(
            selectedOwnerJumpLabel
          )}</a></div>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }
    .preview-title {
      margin: 0 0 8px 0;
      font-size: 1.05em;
    }
    .preview-subtitle {
      margin: 0 0 10px 0;
      font-size: 0.9em;
    }
    .preview-subtitle a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .preview-subtitle a:hover {
      text-decoration: underline;
    }
    .preview-actions {
      margin: 0 0 10px 0;
      font-size: 0.9em;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .preview-actions a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .preview-actions a:hover {
      text-decoration: underline;
    }
    .preview-action-button {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      font: inherit;
      margin: 0;
      padding: 0;
      cursor: pointer;
    }
    .preview-action-button:hover {
      text-decoration: underline;
    }
    .preview-actions-label {
      color: var(--vscode-descriptionForeground);
    }
    .preview-actions-separator {
      color: var(--vscode-descriptionForeground);
    }
    .file {
      font-weight: 600;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .meta {
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    .notice {
      border-left: 3px solid var(--vscode-focusBorder);
      padding: 6px 8px;
      margin: 0 0 10px 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-focusBorder));
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .list {
      list-style: none;
      margin: 0 0 12px 0;
      padding: 0;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .overview-filter {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin: 0 0 8px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      user-select: none;
    }
    .overview-filter input {
      margin: 0;
    }
    .list-item {
      display: grid;
      grid-template-columns: 1fr;
      gap: 2px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .list-item[hidden] {
      display: none;
    }
    .list-item-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .list-item:last-child {
      border-bottom: none;
    }
    .list-item a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .list-item a:hover {
      text-decoration: underline;
    }
    .list-item a.testcase-jump {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      white-space: nowrap;
    }
    .list-item.active {
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, var(--vscode-focusBorder));
    }
    .owner {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .preview {
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 10px;
    }
    .preview h1 {
      font-size: 1.6em;
    }
    .preview h2 {
      font-size: 1.35em;
    }
    .preview h3 {
      font-size: 1.2em;
    }
    .preview h4 {
      font-size: 1.1em;
    }
    .preview h5 {
      font-size: 1em;
    }
    .preview h6 {
      font-size: 0.95em;
    }
    .preview :is(h1, h2, h3, h4, h5, h6) {
      margin-top: 0.8em;
      margin-bottom: 0.35em;
      line-height: 1.3;
    }
    .preview .robot-render-line {
      display: block;
    }
    .preview .doc-target-marker {
      display: none !important;
    }
    .preview .robot-arrow-line {
      display: flex;
      align-items: baseline;
      column-gap: 1ch;
      padding-left: var(--robot-arrow-indent, 0ch);
    }
    .preview .robot-arrow-marker {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .preview .robot-arrow-marker-placeholder {
      visibility: hidden;
    }
    .preview .robot-arrow-body {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: break-word;
    }
    .preview .doc-clickable-line-group {
      display: block;
    }
    .preview pre {
      padding: 8px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .preview .doc-clickable {
      cursor: pointer;
      border-radius: 4px;
      transition: background-color 120ms ease;
    }
    .preview .doc-clickable-surface-li {
      display: inline;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .preview .doc-clickable:hover {
      background: color-mix(in srgb, var(--vscode-editor-background) 78%, var(--vscode-focusBorder));
    }
    .preview .doc-clickable:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .preview .doc-variable-section {
      margin-top: 10px;
    }
    .preview .doc-variable-section-secondary {
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border);
    }
    .preview .doc-variable-section-title {
      margin: 0 0 4px 0;
      font-size: 1.15em;
      line-height: 1.3;
    }
    .preview .doc-variable-section-title a {
      color: inherit;
      text-decoration: none;
    }
    .preview .doc-variable-section-title a:hover {
      text-decoration: underline;
    }
    .preview .doc-variable-list {
      list-style: disc;
      margin: 0 0 4px 0;
      padding-left: 18px;
    }
    .preview .doc-variable-row {
      margin: 0 0 1px 0;
      padding: 0 2px 0 0;
      border-radius: 4px;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .preview .doc-variable-value {
      overflow-wrap: anywhere;
    }
    .preview .doc-variable-value-link {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .preview .doc-variable-value-link:hover {
      color: var(--vscode-textLink-foreground);
    }
    .preview .doc-variable-value-separator {
      color: var(--vscode-descriptionForeground);
    }
    .preview .doc-variable-hint {
      display: inline-block;
      margin-right: 8px;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 0.78em;
      line-height: 1.5;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      vertical-align: baseline;
    }
    .preview .doc-variable-toggle-row {
      margin-top: 6px;
    }
    .preview .doc-variable-toggle-button {
      font-size: 0.95em;
    }
    .preview .doc-color-span {
      border-radius: 3px;
      padding: 0 0.18em;
      font-weight: 600;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .preview .doc-color-note {
      color: var(--vscode-textLink-foreground, #1d4ed8);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, #1d4ed8);
    }
    .preview .doc-color-question {
      color: var(--vscode-charts-purple, #7e22ce);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, #7e22ce);
    }
    .preview .doc-color-warning {
      color: var(--vscode-editorWarning-foreground, #c2410c);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, #c2410c);
    }
    .preview .doc-color-error {
      color: var(--vscode-editorError-foreground, #b42318);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, #b42318);
    }
    .preview .doc-color-success {
      color: var(--vscode-testing-iconPassed, #15803d);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, #15803d);
    }
    .preview .doc-color-custom {
      font-weight: 600;
    }
    .preview .doc-inline-heading {
      margin-bottom: 0.4em;
    }
    .preview .doc-inline-chunk {
      margin-bottom: 0.8em;
    }
    .preview .doc-inline-chunk:last-child {
      margin-bottom: 0;
    }
    .preview code {
      font-family: var(--vscode-editor-font-family);
    }
  </style>
</head>
<body>
  ${fileInfo}
  ${metadata}
  ${previewActions}
  ${message}
  ${listContent}
  <div class="preview">
    ${previewTitle}
    ${previewSubtitle}
    ${renderedMarkdownHtml}
  </div>
  <script>
    (() => {
      const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
      const previewRoot = document.querySelector('.preview');
      if (!previewRoot) {
        return;
      }

      const getPreviewWebviewState = () => {
        if (vscodeApi && typeof vscodeApi.getState === 'function') {
          return vscodeApi.getState() || {};
        }
        return {};
      };

      const setPreviewWebviewState = (nextState) => {
        if (vscodeApi && typeof vscodeApi.setState === 'function') {
          vscodeApi.setState(nextState || {});
        }
      };

      const getShowKeywordOverview = () => getPreviewWebviewState().showKeywordOverview !== false;

      const applyKeywordOverviewFilter = (showKeywords) => {
        const shouldShowKeywords = showKeywords !== false;
        const toggle = document.querySelector('[data-doc-overview-keyword-toggle]');
        if (toggle instanceof HTMLInputElement) {
          toggle.checked = shouldShowKeywords;
        }
        const keywordRows = document.querySelectorAll('[data-doc-overview-section="keywords"]');
        for (const row of keywordRows) {
          if (row instanceof HTMLElement) {
            row.hidden = !shouldShowKeywords;
          }
        }
      };

      const attachKeywordOverviewFilter = () => {
        const toggle = document.querySelector('[data-doc-overview-keyword-toggle]');
        if (!(toggle instanceof HTMLInputElement)) {
          return;
        }

        applyKeywordOverviewFilter(getShowKeywordOverview());
        toggle.addEventListener('change', () => {
          const nextState = {
            ...getPreviewWebviewState(),
            showKeywordOverview: toggle.checked
          };
          setPreviewWebviewState(nextState);
          applyKeywordOverviewFilter(toggle.checked);
        });
      };

      const candidates = previewRoot.querySelectorAll('p, li');
      const buildArrowLineContent = (cleaned) => {
        const arrowMatch = String(cleaned || '').match(/^(-&gt;|=&gt;|->|=>)(?:\\s|&nbsp;|\\u00A0)*([\\s\\S]*)$/);
        if (arrowMatch) {
          return (
            '<span class=\"robot-arrow-marker\">' +
            arrowMatch[1] +
            '</span><span class=\"robot-arrow-body\">' +
            arrowMatch[2] +
            '</span>'
          );
        }
        return (
          '<span class=\"robot-arrow-marker robot-arrow-marker-placeholder\" aria-hidden=\"true\">-&gt;</span>' +
          '<span class=\"robot-arrow-body\">' +
          String(cleaned || '') +
          '</span>'
        );
      };

      for (const element of candidates) {
        if (!/\\[\\[RDP_INDENT_\\d+\\]\\]/.test(element.innerHTML)) {
          continue;
        }

        const lines = element.innerHTML.split(/<br\\s*\\/?>/i);
        const rebuilt = [];

        for (const line of lines) {
          const match = line.match(/\\[\\[RDP_INDENT_(\\d+)\\]\\]/);
          if (!match) {
            rebuilt.push('<span class=\"robot-render-line\">' + line + '</span>');
            continue;
          }

          const indentWidth = Math.max(0, Number(match[1]) || 0);
          const cleaned = line
            .replace(/\\[\\[RDP_INDENT_\\d+\\]\\]/g, '')
            .replace(/^[\\s\\u00A0]+/, '');

          rebuilt.push(
            '<span class=\"robot-render-line robot-arrow-line\" style=\"--robot-arrow-indent:' +
              String(indentWidth) +
              'ch\">' +
              buildArrowLineContent(cleaned) +
              '</span>'
          );
        }

        element.innerHTML = rebuilt.join('');
      }

      const syncPreviewToggleButtons = () => {
        const toggleButtons = document.querySelectorAll('[data-preview-toggle-target]');
        for (const button of toggleButtons) {
          const targetKey = String(button.getAttribute('data-preview-toggle-target') || '').trim();
          if (!targetKey) {
            continue;
          }

          const targetSection = document.querySelector('[data-preview-toggle-section="' + targetKey + '"]');
          const isExpanded = targetSection instanceof HTMLElement ? !targetSection.hidden : false;
          const showLabel = String(button.getAttribute('data-preview-toggle-show-label') || 'Show');
          const hideLabel = String(button.getAttribute('data-preview-toggle-hide-label') || 'Hide');
          button.textContent = isExpanded ? hideLabel : showLabel;
          button.setAttribute('aria-expanded', String(isExpanded));
          button.setAttribute('aria-pressed', String(isExpanded));
        }
      };

      const getClosestElement = (target, selector) => {
        if (!selector) {
          return null;
        }
        if (target instanceof Element) {
          return target.closest(selector);
        }
        if (target && target.parentElement instanceof Element) {
          return target.parentElement.closest(selector);
        }
        return null;
      };

      const attachPreviewToggleHandlers = () => {
        const toggleButtons = document.querySelectorAll('[data-preview-toggle-target]');
        for (const button of toggleButtons) {
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const targetKey = String(button.getAttribute('data-preview-toggle-target') || '').trim();
            if (!targetKey) {
              return;
            }
            const targetSections = document.querySelectorAll('[data-preview-toggle-section="' + targetKey + '"]');
            let nextExpanded = false;
            for (const section of targetSections) {
              if (!(section instanceof HTMLElement)) {
                continue;
              }
              nextExpanded = section.hidden;
              section.hidden = !section.hidden;
            }
            if (!nextExpanded && targetSections.length === 0) {
              return;
            }
            if (targetKey === 'returned-variables' && vscodeApi && typeof vscodeApi.postMessage === 'function') {
              vscodeApi.postMessage({
                type: 'setReturnedVariablesVisible',
                documentUri: String(button.getAttribute('data-preview-toggle-document-uri') || ''),
                blockId: String(button.getAttribute('data-preview-toggle-block-id') || ''),
                visible: nextExpanded
              });
            }
            syncPreviewToggleButtons();
          });
        }
      };

      const attachDocumentationSourceTargets = () => {
        const blockSelector = 'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, table';
        const wrapperSelector = 'div, section, article, main, body, ol, ul';

        const ensureMarkerTargetSurfaces = (element) => {
          if (!element || !(element instanceof HTMLElement)) {
            return [];
          }

          if (element.dataset.docMarkerTargetsReady === 'true') {
            return Array.from(element.children).filter(
              (child) =>
                child instanceof HTMLElement &&
                child.classList.contains('doc-clickable-line-group') &&
                child.getAttribute('data-doc-marker-surface') === 'true'
            );
          }

          const directMarkers = Array.from(element.childNodes).filter(
            (child) => child instanceof HTMLElement && child.classList.contains('doc-target-marker')
          );
          if (directMarkers.length <= 1) {
            return [];
          }

          element.dataset.docMarkerTargetsReady = 'true';
          const surfaces = [];
          let currentMarker = directMarkers[0];

          while (currentMarker instanceof HTMLElement) {
            const surface = document.createElement('span');
            surface.className = 'doc-clickable-line-group';
            surface.setAttribute('data-doc-marker-surface', 'true');
            element.insertBefore(surface, currentMarker);

            let cursor = currentMarker;
            while (cursor) {
              const nextSibling = cursor.nextSibling;
              if (
                cursor !== currentMarker &&
                cursor instanceof HTMLElement &&
                cursor.classList.contains('doc-target-marker')
              ) {
                currentMarker = cursor;
                break;
              }
              if (cursor instanceof HTMLElement && (cursor.tagName === 'UL' || cursor.tagName === 'OL')) {
                currentMarker = undefined;
                break;
              }
              surface.appendChild(cursor);
              cursor = nextSibling;
              if (!cursor) {
                currentMarker = undefined;
              }
            }

            surfaces.push(surface);
          }

          return surfaces;
        };

        const ensureLineTargetSurfaces = (element) => {
          if (!element || !(element instanceof HTMLElement)) {
            return [];
          }

          if (element.dataset.docLineTargetsReady === 'true') {
            return Array.from(element.children).filter(
              (child) =>
                child instanceof HTMLElement &&
                (child.classList.contains('doc-clickable-line-group') ||
                  child.classList.contains('robot-arrow-line'))
            );
          }

          const lineNodes = Array.from(element.children).filter(
            (child) => child instanceof HTMLElement && child.classList.contains('robot-render-line')
          );
          if (lineNodes.length === 0) {
            return [];
          }

          element.dataset.docLineTargetsReady = 'true';
          const surfaces = [];
          let pendingGroup = [];

          const flushPendingGroup = () => {
            if (pendingGroup.length === 0) {
              return;
            }

            const surface = document.createElement('span');
            surface.className = 'doc-clickable-line-group';
            element.insertBefore(surface, pendingGroup[0]);
            for (const lineNode of pendingGroup) {
              surface.appendChild(lineNode);
            }
            surfaces.push(surface);
            pendingGroup = [];
          };

          for (const lineNode of lineNodes) {
            if (lineNode.classList.contains('robot-arrow-line')) {
              flushPendingGroup();
              surfaces.push(lineNode);
              continue;
            }
            pendingGroup.push(lineNode);
          }

          flushPendingGroup();
          return surfaces;
        };

        const collectTargetableBlocks = (container) => {
          if (!container || !(container instanceof HTMLElement)) {
            return [];
          }

          const blocks = [];
          for (const child of container.children) {
            if (!(child instanceof HTMLElement)) {
              continue;
            }

            if (child.matches(blockSelector)) {
              const lineSurfaces = ensureLineTargetSurfaces(child);
              if (lineSurfaces.length > 0) {
                blocks.push(...lineSurfaces);
              } else if (child instanceof HTMLLIElement) {
                blocks.push(ensureListItemClickableSurface(child));
              } else {
                blocks.push(child);
              }

              // Some block elements such as <li> can legitimately contain nested
              // lists. We keep parent-first ordering, but still descend so deeper
              // items remain independently clickable.
              if (child instanceof HTMLLIElement) {
                for (const nestedList of Array.from(child.children)) {
                  if (nestedList instanceof HTMLElement && (nestedList.tagName === 'UL' || nestedList.tagName === 'OL')) {
                    blocks.push(...collectTargetableBlocks(nestedList));
                  }
                }
              }
              continue;
            }

            if (child.matches(wrapperSelector)) {
              blocks.push(...collectTargetableBlocks(child));
            }
          }
          return blocks;
        };

        const ensureListItemClickableSurface = (listItem) => {
          if (!(listItem instanceof HTMLLIElement)) {
            return listItem;
          }

          for (const child of listItem.children) {
            if (child instanceof HTMLElement && child.classList.contains('doc-clickable-surface-li')) {
              return child;
            }
          }

          const surface = document.createElement('span');
          surface.className = 'doc-clickable-surface-li';
          const nodesToWrap = [];

          for (const node of Array.from(listItem.childNodes)) {
            if (node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) {
              break;
            }
            nodesToWrap.push(node);
          }

          if (nodesToWrap.length === 0) {
            return listItem;
          }

          for (const node of nodesToWrap) {
            surface.appendChild(node);
          }

          listItem.insertBefore(surface, listItem.firstChild);
          return surface;
        };

        const resolveClickableSurfaceForMarker = (marker) => {
          if (!(marker instanceof HTMLElement)) {
            return undefined;
          }

          const parentBlock = marker.closest(blockSelector);
          if (parentBlock instanceof HTMLElement) {
            const markerTargetSurfaces = ensureMarkerTargetSurfaces(parentBlock);
            if (markerTargetSurfaces.length > 0) {
              const markerSurface = marker.closest('[data-doc-marker-surface="true"]');
              if (markerSurface instanceof HTMLElement) {
                return markerSurface;
              }
            }
            ensureLineTargetSurfaces(parentBlock);
          }

          const lineSurface = marker.closest('.robot-arrow-line, .doc-clickable-line-group, .doc-clickable-surface-li');
          if (lineSurface instanceof HTMLElement) {
            return lineSurface;
          }

          if (parentBlock instanceof HTMLLIElement) {
            return ensureListItemClickableSurface(parentBlock);
          }

          return parentBlock instanceof HTMLElement ? parentBlock : undefined;
        };

        const flows = previewRoot.querySelectorAll('[data-doc-render-targets]');
        for (const flow of flows) {
          const rawTargets = String(flow.getAttribute('data-doc-render-targets') || '').trim();
          if (!rawTargets) {
            continue;
          }

          let targets;
          try {
            targets = JSON.parse(decodeURIComponent(rawTargets));
          } catch {
            continue;
          }

          const targetMarkers = Array.from(flow.querySelectorAll('.doc-target-marker[data-doc-target-index]'));
          const boundTargetIndexes = new Set();

          for (const marker of targetMarkers) {
            const targetIndex = Math.max(0, Number(marker.getAttribute('data-doc-target-index')) || 0);
            const targetData = targets[targetIndex];
            const clickableSurface = resolveClickableSurfaceForMarker(marker);
            if (!clickableSurface || !targetData?.commandUri) {
              continue;
            }

            boundTargetIndexes.add(targetIndex);
            clickableSurface.classList.add('doc-clickable');
            clickableSurface.setAttribute('data-source-command', String(targetData.commandUri));
            clickableSurface.setAttribute('tabindex', '0');
            clickableSurface.setAttribute('role', 'link');
            if (targetData.label) {
              clickableSurface.setAttribute('title', String(targetData.label));
            }
          }

          if (boundTargetIndexes.size >= targets.length) {
            continue;
          }

          const blockElements = collectTargetableBlocks(flow);
          for (let index = 0; index < Math.min(blockElements.length, targets.length); index += 1) {
            if (boundTargetIndexes.has(index)) {
              continue;
            }

            const targetElement = blockElements[index];
            const targetData = targets[index];
            if (!targetElement || !targetData?.commandUri) {
              continue;
            }

            const clickableSurface = ensureListItemClickableSurface(targetElement);
            clickableSurface.classList.add('doc-clickable');
            clickableSurface.setAttribute('data-source-command', String(targetData.commandUri));
            clickableSurface.setAttribute('tabindex', '0');
            clickableSurface.setAttribute('role', 'link');
            if (targetData.label) {
              clickableSurface.setAttribute('title', String(targetData.label));
            }
          }
        }
      };

      attachDocumentationSourceTargets();
      attachPreviewToggleHandlers();
      attachKeywordOverviewFilter();
      syncPreviewToggleButtons();

      const openSourceTarget = (commandUri) => {
        if (!commandUri) {
          return;
        }

        if (vscodeApi) {
          vscodeApi.postMessage({
            type: 'executeCommandUri',
            commandUri
          });
          return;
        }

        const anchor = document.createElement('a');
        anchor.href = commandUri;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      };

      const getManagedKeywordDocCommandUri = (anchor) => {
        if (!anchor) {
          return '';
        }

        const sourceCommand = String(anchor.getAttribute('data-source-command') || '').trim();
        if (sourceCommand && anchor.hasAttribute('data-managed-keyword-doc-command')) {
          return sourceCommand;
        }

        const rawHref = String(anchor.getAttribute('href') || anchor.getAttribute('data-href') || '').trim();
        const managedPrefixes = [
          'command:${CMD_PREVIEW_KEYWORD_ARGUMENT}?',
          'command:${CMD_INSERT_KEYWORD_ARGUMENT}?'
        ];
        for (const prefix of managedPrefixes) {
          if (rawHref.startsWith(prefix)) {
            return rawHref;
          }
        }

        return '';
      };

      const shouldPreserveAnchorNavigation = (anchor) => {
        if (!anchor) {
          return false;
        }

        const rawHref = String(anchor.getAttribute('href') || anchor.getAttribute('data-href') || '').trim();
        if (!rawHref) {
          return false;
        }

        if (rawHref.startsWith('#')) {
          return false;
        }

        return /^[a-z][a-z0-9+.-]*:/i.test(rawHref);
      };

      previewRoot.addEventListener('click', (event) => {
        const interactiveAnchor = getClosestElement(event.target, 'a[href], a[data-href]');
        if (interactiveAnchor && previewRoot.contains(interactiveAnchor)) {
          const managedCommandUri = getManagedKeywordDocCommandUri(interactiveAnchor);
          if (managedCommandUri) {
            event.preventDefault();
            event.stopPropagation();
            openSourceTarget(managedCommandUri);
            return;
          }
        }

        const clickable = getClosestElement(event.target, '[data-source-command]');
        if (!clickable || !previewRoot.contains(clickable)) {
          return;
        }

        const nestedAnchor = getClosestElement(event.target, 'a[href], a[data-href]');
        if (nestedAnchor && previewRoot.contains(nestedAnchor)) {
          if (shouldPreserveAnchorNavigation(nestedAnchor)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
        }

        openSourceTarget(clickable.getAttribute('data-source-command'));
      });

      previewRoot.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }

        const interactiveAnchor = getClosestElement(event.target, 'a[href], a[data-href]');
        if (interactiveAnchor && previewRoot.contains(interactiveAnchor)) {
          const managedCommandUri = getManagedKeywordDocCommandUri(interactiveAnchor);
          if (managedCommandUri) {
            event.preventDefault();
            openSourceTarget(managedCommandUri);
            return;
          }
        }

        const clickable = getClosestElement(event.target, '[data-source-command]');
        if (!clickable || !previewRoot.contains(clickable)) {
          return;
        }

        event.preventDefault();
        openSourceTarget(clickable.getAttribute('data-source-command'));
      });
    })();
  </script>
</body>
</html>`;
  }
}

function getDocumentationOwnerJumpLabel(blockOrSection) {
  const section =
    typeof blockOrSection === "string"
      ? blockOrSection
      : String(blockOrSection?.section || "");
  if (String(section || "").trim().toLowerCase() === "keywords") {
    return "Jump to keyword";
  }
  return "Jump to testcase";
}

function buildDocumentationPreviewActionsHtml(documentUri, blockId = "") {
  if (!String(documentUri || "").trim()) {
    return "";
  }

  const commandArgs = encodeURIComponent(JSON.stringify([String(documentUri)]));
  const blockCommandArgs = encodeURIComponent(JSON.stringify([String(documentUri), String(blockId || "")]));
  const foldDocumentationHeadlinesCommand = `command:${CMD_FOLD_DOCUMENTATION_TO_HEADLINES}?${commandArgs}`;
  const foldDocumentationStepsCommand = `command:${CMD_FOLD_DOCUMENTATION_TO_STEPS}?${commandArgs}`;
  const unfoldDocumentationCommand = `command:${CMD_UNFOLD_DOCUMENTATION}?${commandArgs}`;
  const exportMarkdownCommand = `command:${CMD_EXPORT_DOCUMENTATION_MARKDOWN}?${blockCommandArgs}`;
  const exportPdfCommand = `command:${CMD_EXPORT_DOCUMENTATION_PDF}?${blockCommandArgs}`;
  const exportSelectedMarkdownCommand = `command:${CMD_EXPORT_DOCUMENTATION_SELECTED_MARKDOWN}?${commandArgs}`;
  const exportSelectedPdfCommand = `command:${CMD_EXPORT_DOCUMENTATION_SELECTED_PDF}?${commandArgs}`;
  return `<div class=\"preview-actions\">
          <span class=\"preview-actions-label\">Fold To:</span>
          <a href=\"${foldDocumentationHeadlinesCommand}\">Headlines</a>
          <span class=\"preview-actions-separator\">|</span>
          <a href=\"${foldDocumentationStepsCommand}\">Steps</a>
          <span class=\"preview-actions-separator\">|</span>
          <a href=\"${unfoldDocumentationCommand}\">Unfold</a>
          <span class=\"preview-actions-separator\">|</span>
          <span class=\"preview-actions-label\">Export:</span>
          <a href=\"${exportMarkdownCommand}\">Current MD</a>
          <span class=\"preview-actions-separator\">|</span>
          <a href=\"${exportPdfCommand}\">Current PDF</a>
          <span class=\"preview-actions-separator\">|</span>
          <a href=\"${exportSelectedMarkdownCommand}\">Selected MD</a>
          <span class=\"preview-actions-separator\">|</span>
          <a href=\"${exportSelectedPdfCommand}\">Selected PDF</a>
        </div>`;
}

class RobotDocPreviewController {
  constructor(parser, previewProvider) {
    this._parser = parser;
    this._previewProvider = previewProvider;
    this._selectedBlockByUri = new Map();
    this._returnedVariablesVisibleByBlockKey = new Map();
    this._debounceTimers = new Map();
    this._disposables = [];

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this._onActiveEditorChanged(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this._onSelectionChanged(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this._onDocumentChanged(event)),
      vscode.workspace.onDidCloseTextDocument((document) => this._onDocumentClosed(document))
    );

    this._syncFromActiveEditor();
  }

  dispose() {
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }

  refresh() {
    this._syncFromActiveEditor();
  }

  async togglePreview() {
    if (this._previewProvider.isVisible()) {
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      return;
    }

    await this._focusPreviewView();
    await this.openCurrentBlock();
  }

  async openCurrentBlock() {
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      await this._focusPreviewView();
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || !isRobotDocument(editor.document)) {
      this._previewProvider.update(
        createEmptyPreviewState("Open a .robot file and move the cursor into documentation or inline #> docs.")
      );
      await this._focusPreviewView();
      return;
    }

    const parsed = this._parser.getParsed(editor.document);
    const nearest = findNearestBlock(parsed.blocks, editor.selection.active.line);

    if (nearest) {
      this._selectedBlockByUri.set(parsed.uri, nearest.id);
    }

    this._updatePreview(editor.document);
    await this._focusPreviewView();
  }

  async openBlockAt(uriString, blockId) {
    if (!uriString || !blockId) {
      return;
    }

    let targetUri;
    try {
      targetUri = vscode.Uri.parse(uriString);
    } catch {
      return;
    }

    let document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === targetUri.toString()
    );

    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(targetUri);
      } catch {
        return;
      }
    }

    if (!isRobotDocument(document)) {
      return;
    }

    const parsed = this._parser.getParsed(document);
    const block = parsed.blocks.find((candidate) => candidate.id === blockId) || parsed.blocks[0];

    if (!block) {
      this._updatePreview(document);
      await this._focusPreviewView();
      return;
    }

    this._selectedBlockByUri.set(parsed.uri, block.id);
    this._updatePreview(document);
    await this._focusPreviewView();
  }

  handlePreviewMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type !== "setReturnedVariablesVisible") {
      return;
    }

    const documentUri = String(message.documentUri || "").trim();
    const blockId = String(message.blockId || "").trim();
    if (!documentUri || !blockId) {
      return;
    }

    this._setReturnedVariablesVisible(documentUri, blockId, message.visible === true);
  }

  async exportDocumentationMarkdown(uriString = "", blockId = "") {
    const context = await this._resolveDocumentationExportContext(uriString, blockId);
    if (!context) {
      return;
    }

    const includeReturnedVariables = this._isReturnedVariablesVisible(
      context.document.uri.toString(),
      context.block.id
    );
    const markdown = buildDocumentationExportMarkdown(context.document.uri.toString(), context.block, {
      includeReturnedVariables
    });
    const defaultUri = buildDocumentationExportDefaultUri(context.document.uri, context.block, "md");
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        Markdown: ["md"],
        "All Files": ["*"]
      },
      saveLabel: "Export Documentation"
    });
    if (!targetUri) {
      return;
    }

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(markdown, "utf8"));
    try {
      const exportedDocument = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(exportedDocument, {
        preview: false,
        preserveFocus: false
      });
    } catch {
      // The file was written successfully; opening it is just a convenience.
    }
    await vscode.window.showInformationMessage(`Exported documentation to ${targetUri.fsPath || targetUri.toString()}`);
  }

  async exportDocumentationPdf(uriString = "", blockId = "") {
    const context = await this._resolveDocumentationExportContext(uriString, blockId);
    if (!context) {
      return;
    }

    const includeReturnedVariables = this._isReturnedVariablesVisible(
      context.document.uri.toString(),
      context.block.id
    );
    const renderedHtml = await renderDocumentationBlockHtml(context.document.uri.toString(), context.block, {
      includeReturnedVariables,
      returnedVariablesVisible: includeReturnedVariables,
      returnedVariablesToggleEnabled: false
    });
    const title = context.block.ownerName || context.block.title || "Documentation";
    const bodyHtml = buildDocumentationPdfExportPageHtml(title, renderedHtml, 0);
    const webviewHtml = buildDocumentationPdfExportHtml(context.document, {
      title,
      bodyHtml,
      browserMode: false
    });
    const panel = vscode.window.createWebviewPanel(
      "robotCompanion.documentationPdfExport",
      `PDF Export: ${title}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true
      }
    );
    registerDocumentationPdfExportPanelHandlers(panel, context.document, title, bodyHtml);
    panel.webview.html = webviewHtml;
  }

  async exportDocumentationSelectedMarkdown(uriString = "") {
    const context = await this._resolveDocumentationExportDocumentContext(uriString);
    if (!context) {
      return;
    }

    const selectedBlocks = await this._pickDocumentationExportBlocks(context.parsed);
    if (!selectedBlocks) {
      return;
    }
    if (selectedBlocks.length === 0) {
      await vscode.window.showWarningMessage("Select at least one testcase to export.");
      return;
    }

    const markdown = buildDocumentationExportMarkdownForBlocks(
      context.document.uri.toString(),
      selectedBlocks,
      {
        includeReturnedVariablesByBlockId: this._buildReturnedVariablesVisibilityByBlockId(
          context.document.uri.toString(),
          selectedBlocks
        )
      }
    );
    const defaultUri = buildDocumentationSelectedExportDefaultUri(context.document.uri, "md");
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        Markdown: ["md"],
        "All Files": ["*"]
      },
      saveLabel: "Export Selected Documentation"
    });
    if (!targetUri) {
      return;
    }

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(markdown, "utf8"));
    try {
      const exportedDocument = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(exportedDocument, {
        preview: false,
        preserveFocus: false
      });
    } catch {
      // The file was written successfully; opening it is just a convenience.
    }
    await vscode.window.showInformationMessage(`Exported selected documentation to ${targetUri.fsPath || targetUri.toString()}`);
  }

  async exportDocumentationSelectedPdf(uriString = "") {
    const context = await this._resolveDocumentationExportDocumentContext(uriString);
    if (!context) {
      return;
    }

    const selectedBlocks = await this._pickDocumentationExportBlocks(context.parsed);
    if (!selectedBlocks) {
      return;
    }
    if (selectedBlocks.length === 0) {
      await vscode.window.showWarningMessage("Select at least one testcase to export.");
      return;
    }

    const bodyHtml = await buildDocumentationPdfExportPagesHtml(
      context.document.uri.toString(),
      selectedBlocks,
      {
        includeReturnedVariablesByBlockId: this._buildReturnedVariablesVisibilityByBlockId(
          context.document.uri.toString(),
          selectedBlocks
        )
      }
    );
    const title = `${path.basename(context.document.uri.fsPath || context.parsed.fileName || "Documentation")} Documentation`;
    const panel = vscode.window.createWebviewPanel(
      "robotCompanion.documentationPdfExport",
      `PDF Export: ${selectedBlocks.length} Testcases`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true
      }
    );
    registerDocumentationPdfExportPanelHandlers(panel, context.document, title, bodyHtml);
    panel.webview.html = buildDocumentationPdfExportHtml(context.document, {
      title,
      bodyHtml,
      browserMode: false
    });
  }

  async _resolveDocumentationExportContext(uriString = "", blockId = "") {
    const documentContext = await this._resolveDocumentationExportDocumentContext(uriString);
    if (!documentContext) {
      return undefined;
    }

    const { document, parsed } = documentContext;
    const requestedBlockId = String(blockId || "").trim();
    let block = requestedBlockId ? parsed.blocks.find((candidate) => candidate.id === requestedBlockId) : undefined;
    if (!block) {
      const selectedBlockId = this._selectedBlockByUri.get(parsed.uri);
      block = selectedBlockId ? parsed.blocks.find((candidate) => candidate.id === selectedBlockId) : undefined;
    }
    if (!block) {
      const activeEditor = vscode.window.activeTextEditor;
      const activeLine =
        activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
          ? activeEditor.selection.active.line
          : 0;
      block = findNearestBlock(parsed.blocks, activeLine) || parsed.blocks[0];
    }

    if (!block) {
      await vscode.window.showWarningMessage("No documentation block found to export.");
      return undefined;
    }

    this._selectedBlockByUri.set(parsed.uri, block.id);
    return {
      document,
      parsed,
      block
    };
  }

  async _resolveDocumentationExportDocumentContext(uriString = "") {
    let document;
    const normalizedUriString = String(uriString || "").trim();
    if (normalizedUriString) {
      try {
        const targetUri = vscode.Uri.parse(normalizedUriString);
        document =
          vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === targetUri.toString()) ||
          (await vscode.workspace.openTextDocument(targetUri));
      } catch (error) {
        logRobotCompanionError("Failed to open document for documentation export", error, {
          uri: normalizedUriString
        });
      }
    }

    if (!document) {
      const editor = vscode.window.activeTextEditor;
      if (editor && isRobotDocument(editor.document)) {
        document = editor.document;
      }
    }

    if (!document || !isRobotDocument(document)) {
      await vscode.window.showWarningMessage("Open a .robot or .resource file before exporting documentation.");
      return undefined;
    }

    return {
      document,
      parsed: this._parser.getParsed(document)
    };
  }

  async _pickDocumentationExportBlocks(parsed) {
    const items = buildDocumentationExportQuickPickItems(parsed?.blocks || []);
    if (items.length === 0) {
      await vscode.window.showWarningMessage("No testcase documentation blocks found to export.");
      return undefined;
    }

    const pickedItems = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      ignoreFocusOut: true,
      placeHolder: "Select testcases to export",
      title: "Export Documentation"
    });
    if (!pickedItems) {
      return undefined;
    }

    const selectedIds = new Set(pickedItems.map((item) => item.blockId));
    return items.filter((item) => selectedIds.has(item.blockId)).map((item) => item.block);
  }

  _getReturnedVariablesVisibilityKey(documentUri, blockId) {
    return `${String(documentUri || "").trim()}::${String(blockId || "").trim()}`;
  }

  _setReturnedVariablesVisible(documentUri, blockId, visible) {
    if (!String(documentUri || "").trim() || !String(blockId || "").trim()) {
      return;
    }
    const key = this._getReturnedVariablesVisibilityKey(documentUri, blockId);
    if (visible) {
      this._returnedVariablesVisibleByBlockKey.set(key, true);
    } else {
      this._returnedVariablesVisibleByBlockKey.delete(key);
    }
  }

  _isReturnedVariablesVisible(documentUri, blockId) {
    return this._returnedVariablesVisibleByBlockKey.get(
      this._getReturnedVariablesVisibilityKey(documentUri, blockId)
    ) === true;
  }

  _buildReturnedVariablesVisibilityByBlockId(documentUri, blocks) {
    const visibility = {};
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.id && this._isReturnedVariablesVisible(documentUri, block.id)) {
        visibility[block.id] = true;
      }
    }
    return visibility;
  }

  _onActiveEditorChanged(editor) {
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      return;
    }

    if (!editor) {
      this._previewProvider.update(createEmptyPreviewState("Open a .robot file to preview documentation."));
      return;
    }

    this._syncFromActiveEditor(editor);
  }

  _onSelectionChanged(event) {
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      return;
    }

    if (!isAutoSyncSelectionEnabled()) {
      return;
    }

    if (!event.textEditor || !isRobotDocument(event.textEditor.document)) {
      return;
    }

    const parsed = this._parser.getParsed(event.textEditor.document);
    const nearest = findNearestBlock(parsed.blocks, event.selections[0].active.line);

    if (!nearest) {
      this._updatePreview(event.textEditor.document);
      return;
    }

    const currentSelected = this._selectedBlockByUri.get(parsed.uri);
    if (currentSelected !== nearest.id) {
      this._selectedBlockByUri.set(parsed.uri, nearest.id);
      this._updatePreview(event.textEditor.document);
    }
  }

  _onDocumentChanged(event) {
    if (!isRobotDocument(event.document)) {
      return;
    }

    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      return;
    }

    const key = event.document.uri.toString();
    const previousTimer = this._debounceTimers.get(key);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(key);
      if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
        return;
      }
      this._parser.parse(event.document);

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === key) {
        if (isAutoSyncSelectionEnabled()) {
          const parsed = this._parser.getParsed(activeEditor.document);
          const nearest = findNearestBlock(parsed.blocks, activeEditor.selection.active.line);
          if (nearest) {
            this._selectedBlockByUri.set(parsed.uri, nearest.id);
          }
        }
        this._updatePreview(activeEditor.document);
      }
    }, getDebounceMs());

    this._debounceTimers.set(key, timer);
  }

  _onDocumentClosed(document) {
    const key = document.uri.toString();
    const timer = this._debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(key);
    }

    this._selectedBlockByUri.delete(key);
    this._parser.clear(document.uri);

    if (!vscode.window.activeTextEditor) {
      this._previewProvider.update(createEmptyPreviewState("Open a .robot file to preview documentation."));
    }
  }

  _syncFromActiveEditor(editor = vscode.window.activeTextEditor) {
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      return;
    }

    if (!editor || !isRobotDocument(editor.document)) {
      this._previewProvider.update(createEmptyPreviewState("Open a .robot file to preview documentation."));
      return;
    }

    const parsed = this._parser.getParsed(editor.document);

    let selectedBlockId = this._selectedBlockByUri.get(parsed.uri);
    const hasSelectedBlock = selectedBlockId && parsed.blocks.some((block) => block.id === selectedBlockId);

    if (isAutoSyncSelectionEnabled() || !hasSelectedBlock) {
      const nearest = findNearestBlock(parsed.blocks, editor.selection.active.line);
      selectedBlockId = nearest ? nearest.id : undefined;
      if (selectedBlockId) {
        this._selectedBlockByUri.set(parsed.uri, selectedBlockId);
      }
    }

    this._updatePreview(editor.document);
  }

  _updatePreview(document) {
    if (!isRobotDocument(document)) {
      this._previewProvider.update(createEmptyPreviewState("Open a .robot file to preview documentation."));
      return;
    }

    const parsed = this._parser.getParsed(document);
    let selectedBlockId = this._selectedBlockByUri.get(parsed.uri);

    if (!selectedBlockId || !parsed.blocks.some((block) => block.id === selectedBlockId)) {
      selectedBlockId = parsed.blocks[0] ? parsed.blocks[0].id : undefined;
      if (selectedBlockId) {
        this._selectedBlockByUri.set(parsed.uri, selectedBlockId);
      }
    }

    this._previewProvider.update({
      documentUri: parsed.uri,
      fileName: parsed.fileName,
      selectedBlockId,
      blocks: parsed.blocks,
      returnedVariablesVisibleByBlockId: this._buildReturnedVariablesVisibilityByBlockId(parsed.uri, parsed.blocks),
      infoMessage:
        parsed.blocks.length === 0
          ? "No documentation or inline #> docs found in Test Cases/Tasks/Keywords sections."
          : ""
    });
  }

  async _focusPreviewView() {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.robotCompanionContainer");
    } catch {
      // no-op
    }

    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch {
      try {
        await vscode.commands.executeCommand("workbench.view.explorer");
      } catch {
        // no-op
      }
    }
  }
}

class RobotReturnPreviewViewProvider {
  constructor(runtimeCacheService) {
    this._view = undefined;
    this._renderSequence = 0;
    this._state = createEmptyReturnPreviewState();
    this._runtimeCacheService = runtimeCacheService;
    this._messageDisposable = undefined;
  }

  dispose() {
    this._messageDisposable?.dispose?.();
    this._messageDisposable = undefined;
    this._view = undefined;
  }

  resolveWebviewView(webviewView) {
    this._messageDisposable?.dispose?.();
    this._view = webviewView;
    this._view.webview.options = {
      enableCommandUris: true,
      enableScripts: true
    };
    this._messageDisposable = this._view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type !== "executeCommandUri") {
        return;
      }

      try {
        await executeManagedCommandUri(message.commandUri);
      } catch (error) {
        logRobotCompanionError("Managed return-preview command execution failed", error, {
          commandUri: String(message.commandUri || "")
        });
      }
    });
    void this.render();
  }

  isVisible() {
    return Boolean(this._view && this._view.visible);
  }

  update(state) {
    this._state = state;
    void this.render();
  }

  async render() {
    if (!this._view) {
      return;
    }

    const currentSequence = ++this._renderSequence;
    let renderedDetailsHtml = "<p class=\"muted\">No return structure selected.</p>";
    if (this._state.detailsMarkdown) {
      const htmlCacheKey = `${this._state.contextKind || "unknown"}\u0000${this._state.detailsMarkdown}`;
      const cached = this._runtimeCacheService?.getCachedHtml(htmlCacheKey);
      if (cached) {
        renderedDetailsHtml = cached;
      } else {
        renderedDetailsHtml = await renderMarkdownToHtml(this._state.detailsMarkdown);
        this._runtimeCacheService?.setCachedHtml(htmlCacheKey, renderedDetailsHtml);
      }
    }

    if (!this._view || currentSequence !== this._renderSequence) {
      return;
    }

    this._view.webview.html = this._buildHtml(renderedDetailsHtml);
  }

  _buildHtml(renderedDetailsHtml) {
    const isEnumContext = this._state.contextKind === "enum";
    const isKeywordDocContext = this._state.contextKind === "keyword-doc";
    const isEnumLikeContext =
      isEnumContext || /###\s+What This Argument Accepts/.test(String(this._state.detailsMarkdown || ""));
    const targetLabel = isEnumContext ? "Argument" : isKeywordDocContext ? "Keyword call" : "Variable";
    const targetValue = isKeywordDocContext ? this._state.keywordName || "-" : this._state.variableToken || "-";
    const detailsHtml = isEnumLikeContext
      ? styleEnumDetailsForPanel(renderedDetailsHtml)
      : renderedDetailsHtml;
    const fileInfo = this._state.fileName
      ? `<div class=\"file\">${escapeHtml(this._state.fileName)}</div>`
      : "<div class=\"file muted\">Open a .robot file to inspect keyword return structures.</div>";
    const metadata = this._state.keywordName
      ? `<div class=\"meta\">
          <div class=\"meta-row\"><span class=\"meta-label\">Testcase:</span> ${escapeHtml(this._state.ownerName || "-")}</div>
          <div class=\"meta-row\"><span class=\"meta-label\">Keyword:</span> ${escapeHtml(this._state.keywordName)}</div>
          ${
            !isKeywordDocContext
              ? `<div class=\"meta-row\"><span class=\"meta-label\">${targetLabel}:</span> ${escapeHtml(targetValue)}</div>`
              : ""
          }
        </div>`
      : "<div class=\"meta muted\">Place cursor on a keyword token, return variable, or named argument value.</div>";
    const notice = this._state.infoMessage
      ? `<div class=\"notice\">${escapeHtml(this._state.infoMessage)}</div>`
      : "";
    const hasCurrentValue = String(this._state.currentValue || "").length > 0;
    const hasCurrentValueSourceLine =
      Number.isFinite(Number(this._state.currentValueSourceLine)) &&
      Number(this._state.currentValueSourceLine) >= 0;
    const currentValueSourceLabel = getLocalVariableAssignmentSourceLabel(this._state);
    const currentValueSourceLineNumber = hasCurrentValueSourceLine
      ? Number(this._state.currentValueSourceLine) + 1
      : undefined;
    const currentValueSourceCommand =
      hasCurrentValueSourceLine && this._state.documentUri
        ? buildOpenLocationCommandUri(this._state.documentUri, Number(this._state.currentValueSourceLine))
        : "";
    const currentValueSummary = hasCurrentValue && !isEnumLikeContext
      ? `<div class=\"current-value-box\">
          <div class=\"current-value-title\">Resolved current value</div>
          <div class=\"current-value-content\"><code>${escapeHtml(this._state.currentValue)}</code></div>
          ${
            isLocalVariableCurrentValueSource(this._state.currentValueSource) && hasCurrentValueSourceLine
              ? `<div class=\"current-value-source\">
                  From <code>${escapeHtml(currentValueSourceLabel)}</code> line ${currentValueSourceLineNumber}
                  ${
                    currentValueSourceCommand
                      ? `&nbsp;&middot;&nbsp;<a href=\"${currentValueSourceCommand}\">Jump to assignment</a>`
                      : ""
                  }
                </div>`
              : ""
          }
        </div>`
      : "";
    const returnAnnotation = !isEnumContext && this._state.returnAnnotation
      ? `<div class=\"annotation\"><span class=\"label\">Return:</span> <code>${escapeHtml(
          this._state.returnAnnotation
        )}</code></div>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }
    .file {
      font-weight: 600;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .meta {
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    .meta-row {
      margin-bottom: 2px;
      word-break: break-word;
    }
    .meta-row:last-child {
      margin-bottom: 0;
    }
    .meta-row a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .meta-row a:hover {
      text-decoration: underline;
    }
    .meta-label {
      color: var(--vscode-foreground);
      font-weight: 600;
      margin-right: 4px;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .notice {
      border-left: 3px solid var(--vscode-focusBorder);
      padding: 6px 8px;
      margin: 0 0 10px 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-focusBorder));
    }
    .annotation {
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      word-break: break-word;
    }
    .current-value-box {
      margin-bottom: 10px;
      border: 1px solid var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
      border-radius: 6px;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-testing-iconPassed));
    }
    .current-value-title {
      font-size: 0.82em;
      font-weight: 700;
      color: var(--vscode-testing-iconPassed);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 4px;
    }
    .current-value-content code {
      color: var(--vscode-testing-iconPassed);
      font-weight: 700;
      font-size: 1.05em;
    }
    .current-value-source {
      margin-top: 6px;
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
    }
    .current-value-source a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .current-value-source a:hover {
      text-decoration: underline;
    }
    .label {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .details {
      border-top: 1px solid var(--vscode-widget-border);
      padding-top: 10px;
    }
    .details pre {
      padding: 8px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .details code {
      font-family: var(--vscode-editor-font-family);
    }
    .details .resolved-current-value-note {
      color: var(--vscode-foreground);
      font-weight: 700;
      font-size: 1.04em;
    }
    .details .resolved-current-value-chip {
      color: var(--vscode-testing-iconPassed, #3fb950);
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, var(--vscode-testing-iconPassed, #3fb950));
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 1.08em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family);
    }
    .details .resolved-current-value-note code {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .details .resolved-current-source-note {
      color: var(--vscode-descriptionForeground);
    }
    .details .enum-current-marker {
      color: var(--vscode-testing-iconPassed, #3fb950);
      font-weight: 700;
    }
    .details .inline-expand-code-block details {
      margin: 0 0 6px 0;
    }
    .details .inline-expand-code-block summary {
      cursor: pointer;
      user-select: none;
    }
    .details .inline-expand-code-block .inline-expand-tail {
      display: none;
    }
    .details .inline-expand-code-block details[open] ~ pre .inline-expand-tail {
      display: inline;
    }
    .details a.doc-keyword-argument-link,
    .details a.doc-keyword-argument-insert-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .details a.doc-keyword-argument-link:hover,
    .details a.doc-keyword-argument-insert-link:hover {
      opacity: 0.9;
    }
    .details a.doc-keyword-argument-link code {
      color: inherit;
    }
  </style>
</head>
<body>
  ${fileInfo}
  ${currentValueSummary}
  ${metadata}
  ${notice}
  ${returnAnnotation}
  <div class="details">
    ${detailsHtml}
  </div>
  <script>
    (() => {
      const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
      if (!vscodeApi) {
        return;
      }

      const handleManagedKeywordDocAnchor = (anchor, event) => {
        if (!anchor) {
          return;
        }

        const commandUri = String(anchor.getAttribute('data-source-command') || '').trim();
        if (!commandUri) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        vscodeApi.postMessage({
          type: 'executeCommandUri',
          commandUri
        });
      };

      document.body.addEventListener('click', (event) => {
        const anchor = event.target.closest('a[data-managed-keyword-doc-command]');
        if (!anchor) {
          return;
        }
        handleManagedKeywordDocAnchor(anchor, event);
      });

      document.body.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        const anchor = event.target.closest('a[data-managed-keyword-doc-command]');
        if (!anchor) {
          return;
        }
        handleManagedKeywordDocAnchor(anchor, event);
      });
    })();
  </script>
</body>
</html>`;
  }
}

class RobotReturnExplorerController {
  constructor(parser, enumHintService, previewProvider, runtimeCacheService, returnComputeWorker) {
    this._parser = parser;
    this._enumHintService = enumHintService;
    this._previewProvider = previewProvider;
    this._runtimeCacheService = runtimeCacheService;
    this._returnComputeWorker = returnComputeWorker;
    this._syncSequence = 0;
    this._suspendAutoSyncUntil = 0;
    this._debounceTimers = new Map();
    this._disposables = [];

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this._onActiveEditorChanged(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this._onSelectionChanged(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this._onDocumentChanged(event)),
      vscode.workspace.onDidOpenTextDocument((document) => this._onDocumentOpened(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this._onDocumentClosed(document))
    );

    void this._syncFromActiveEditor();
  }

  dispose() {
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }

  async refresh() {
    await this._syncFromActiveEditor();
    this._runtimeCacheService?.schedulePrewarmForOpenDocuments(
      this._parser,
      vscode.window.activeTextEditor?.document?.uri?.toString() || ""
    );
  }

  async previewKeywordArgument(payload = {}, options = {}) {
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyReturnPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      return;
    }
    this._runtimeCacheService?.markInteractiveActivity();

    this._suspendAutoSyncUntil = Date.now() + 400;
    const uriString = String(payload?.documentUri || "").trim();
    const argumentName = String(payload?.argumentName || "").trim();
    if (!uriString || !argumentName) {
      return;
    }

    const preferredLine = Number.isFinite(Number(payload?.line))
      ? Number(payload.line)
      : Number.isFinite(Number(payload?.keywordLine))
      ? Number(payload.keywordLine)
      : 0;
    const preferredCharacter = Number.isFinite(Number(payload?.character))
      ? Number(payload.character)
      : Number.isFinite(Number(payload?.keywordCharacter))
      ? Number(payload.keywordCharacter)
      : 0;

    let editor = options.editor;
    if (!options.skipOpen) {
      editor = await openTextDocumentAtLocation(uriString, preferredLine, preferredCharacter);
    }
    if (!editor) {
      editor = vscode.window.activeTextEditor;
    }
    if (!editor || editor.document.uri.toString() !== uriString || !isRobotDocument(editor.document)) {
      return;
    }

    const parsed = this._parser.getParsed(editor.document);
    const referenceLine = Number.isFinite(Number(payload?.line))
      ? Number(payload.line)
      : Number.isFinite(Number(payload?.keywordLine))
      ? Number(payload.keywordLine)
      : editor.selection.active.line;
    const keywordName = String(payload?.keywordName || "").trim();
    const argumentValue = String(payload?.argumentValue || "").trim();
    const context = {
      keywordName,
      argumentName,
      argumentValue,
      valueStart: 0,
      valueEnd: Math.max(0, argumentValue.length),
      hoverStart: 0,
      hoverEnd: Math.max(1, argumentName.length)
    };
    const backToKeywordCommandUri =
      Number.isFinite(Number(payload?.keywordLine)) && Number(payload.keywordLine) >= 0
        ? buildOpenLocationCommandUri(
            uriString,
            Number(payload.keywordLine),
            Math.max(0, Number(payload?.keywordCharacter) || 0)
          )
        : "";

    let enumContext = undefined;
    try {
      enumContext = await resolveEnumValuePreviewFromContext(editor.document, this._enumHintService, context, {
        parsed,
        referenceLine,
        maxEnums: getEnumHoverMaxEnums(),
        maxMembers: getEnumHoverMaxMembers(),
        showArgumentAssignment: false,
        showResolvedCurrentValue: false,
        showCurrentMemberMarker: false,
        backToKeywordCommandUri,
        runtimeCache: this._runtimeCacheService,
        returnComputeWorker: this._returnComputeWorker
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-companion] Keyword-doc argument preview failed:", message);
    }

    if (!enumContext) {
      this._suspendAutoSyncUntil = Date.now() + 250;
      await this._syncFromActiveEditor(editor);
      return;
    }

    const owner = findOwnerForLine(parsed.owners, referenceLine);
    this._previewProvider.update({
      contextKind: "enum",
      documentUri: parsed.uri,
      fileName: parsed.fileName,
      ownerName: owner ? owner.name : "",
      variableToken: enumContext.argumentName,
      keywordName: enumContext.keywordName,
      returnAnnotation: "",
      currentValue: String(enumContext.currentValue || enumContext.argumentValue || ""),
      currentValueSource: enumContext.currentValueSource || "",
      currentValueSourceLabel: enumContext.currentValueSourceLabel || "",
      currentValueSourceLine: enumContext.currentValueSourceLine,
      sourceUri: "",
      sourceLine: undefined,
      sourceFilePath: "",
      sourceFunctionName: "",
      detailsMarkdown: buildEnumPreviewMarkdown(enumContext),
      infoMessage: ""
    });
    this._suspendAutoSyncUntil = Date.now() + 250;
  }

  _onActiveEditorChanged(editor) {
    this._runtimeCacheService?.markInteractiveActivity();
    if (Date.now() < this._suspendAutoSyncUntil) {
      return;
    }
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyReturnPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      return;
    }
    if (editor && isRobotDocument(editor.document)) {
      this._runtimeCacheService?.schedulePrewarmForOpenDocuments(this._parser, editor.document.uri.toString());
    }
    void this._syncFromActiveEditor(editor);
  }

  _onDocumentOpened(document) {
    if (!isRobotDocument(document) || shouldPauseRobotCompanionInteractiveUiForDebug()) {
      return;
    }
    this._runtimeCacheService?.schedulePrewarmForOpenDocuments(this._parser, document.uri.toString());
  }

  _onSelectionChanged(event) {
    this._runtimeCacheService?.markInteractiveActivity();
    if (Date.now() < this._suspendAutoSyncUntil) {
      return;
    }
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      return;
    }
    if (!isAutoSyncSelectionEnabled()) {
      return;
    }

    if (!event.textEditor || !isRobotDocument(event.textEditor.document)) {
      return;
    }

    void this._syncFromActiveEditor(event.textEditor);
  }

  _onDocumentChanged(event) {
    this._runtimeCacheService?.markInteractiveActivity();
    if (!isRobotDocument(event.document)) {
      return;
    }

    this._runtimeCacheService?.invalidateOnRobotDocumentChange(event);

    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      return;
    }

    const key = event.document.uri.toString();
    const previousTimer = this._debounceTimers.get(key);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(key);
      if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
        return;
      }
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || activeEditor.document.uri.toString() !== key) {
        return;
      }
      void this._syncFromActiveEditor(activeEditor);
      this._runtimeCacheService?.schedulePrewarmForOpenDocuments(this._parser, key);
    }, getDebounceMs());

    this._debounceTimers.set(key, timer);
  }

  _onDocumentClosed(document) {
    const key = document.uri.toString();
    const timer = this._debounceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(key);
    }

    this._runtimeCacheService?.invalidateForUri(document.uri);

    if (!vscode.window.activeTextEditor) {
      this._previewProvider.update(
        createEmptyReturnPreviewState(
          "Open a .robot file and place cursor on a keyword token, return variable, or named argument."
        )
      );
    }
  }

  async _syncFromActiveEditor(editor = vscode.window.activeTextEditor) {
    const currentSequence = ++this._syncSequence;
    this._runtimeCacheService?.markInteractiveActivity();
    if (shouldPauseRobotCompanionInteractiveUiForDebug()) {
      this._previewProvider.update(createEmptyReturnPreviewState(DEBUG_PAUSED_INFO_MESSAGE));
      return;
    }

    if (!isReturnExplorerEnabled()) {
      this._previewProvider.update(createEmptyReturnPreviewState("Return explorer is disabled in settings."));
      return;
    }

    if (!editor || !isRobotDocument(editor.document)) {
      this._previewProvider.update(
        createEmptyReturnPreviewState(
          "Open a .robot file and place cursor on a keyword token, return variable, or named argument."
        )
      );
      return;
    }

    const parsed = this._parser.getParsed(editor.document);
    const runtimeState = this._runtimeCacheService?.ensureState(editor.document, parsed);

    let enumContext = undefined;
    if (isEnumValueHoverEnabled()) {
      try {
        enumContext = await resolveEnumValuePreview(editor.document, editor.selection.active, this._enumHintService, {
          parsed,
          maxEnums: getEnumHoverMaxEnums(),
          maxMembers: getEnumHoverMaxMembers(),
          runtimeCache: this._runtimeCacheService,
          returnComputeWorker: this._returnComputeWorker
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-companion] Enum side preview refresh failed:", message);
      }
    }

    if (currentSequence !== this._syncSequence) {
      return;
    }

    if (enumContext) {
      const owner = findOwnerForLine(parsed.owners, editor.selection.active.line);
      this._previewProvider.update({
        contextKind: "enum",
        documentUri: parsed.uri,
        fileName: parsed.fileName,
        ownerName: owner ? owner.name : "",
        variableToken: enumContext.argumentName,
        keywordName: enumContext.keywordName,
        returnAnnotation: "",
        currentValue: String(enumContext.currentValue || enumContext.argumentValue || ""),
        currentValueSource: enumContext.currentValueSource || "",
        currentValueSourceLabel: enumContext.currentValueSourceLabel || "",
        currentValueSourceLine: enumContext.currentValueSourceLine,
        sourceUri: "",
        sourceLine: undefined,
        sourceFilePath: "",
        sourceFunctionName: "",
        detailsMarkdown: buildEnumPreviewMarkdown(enumContext),
        infoMessage: ""
      });
      return;
    }

    const returnVariableContext = getKeywordReturnVariableContextAtPosition(
      editor.document,
      parsed,
      editor.selection.active,
      runtimeState?.lookups
    );
    if (returnVariableContext) {
      const returnResolveOptions = {
        maxDepth: getReturnPreviewMaxDepth(),
        maxFieldsPerType: getReturnMaxFieldsPerType(),
        runtimeCache: this._runtimeCacheService,
        returnComputeWorker: this._returnComputeWorker
      };
      let returnContext = undefined;
      try {
        returnContext = await resolveKeywordReturnPreview(
          editor.document,
          parsed,
          editor.selection.active,
          this._enumHintService,
          {
            ...returnResolveOptions,
            includeTechnical: true,
            cacheOnly: true
          }
        );
      } catch (error) {
        logRobotCompanionError("Return explorer cache lookup failed", error, {
          documentUri: editor.document.uri.toString(),
          line: editor.selection.active.line,
          character: editor.selection.active.character
        });
      }

      if (currentSequence !== this._syncSequence) {
        return;
      }

      if (returnContext) {
        this._applyReturnPreviewContext(parsed, returnContext);
        return;
      }

      try {
        returnContext = await resolveKeywordReturnPreview(
          editor.document,
          parsed,
          editor.selection.active,
          this._enumHintService,
          {
            ...returnResolveOptions,
            includeTechnical: false,
            cacheOnly: true
          }
        );
      } catch (error) {
        logRobotCompanionError("Return explorer simple cache lookup failed", error, {
          documentUri: editor.document.uri.toString(),
          line: editor.selection.active.line,
          character: editor.selection.active.character
        });
      }

      if (currentSequence !== this._syncSequence) {
        return;
      }

      if (returnContext) {
        this._applyReturnPreviewContext(parsed, returnContext);
        if (returnContext.technicalPending) {
          void this._refreshReturnTechnicalDetails(editor, parsed, currentSequence);
        }
        return;
      }

      this._previewProvider.update(createReturnLoadingPreviewState(parsed.fileName, returnVariableContext));
      void this._resolveReturnPreviewWhenIdle(editor, parsed, currentSequence);
      return;
    }

    let returnContext;
    try {
      returnContext = await resolveKeywordReturnPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService,
        {
          maxDepth: getReturnPreviewMaxDepth(),
          maxFieldsPerType: getReturnMaxFieldsPerType(),
          includeTechnical: false,
          runtimeCache: this._runtimeCacheService,
          returnComputeWorker: this._returnComputeWorker
        }
      );
    } catch (error) {
      logRobotCompanionError("Return explorer refresh failed", error, {
        documentUri: editor.document.uri.toString(),
        line: editor.selection.active.line,
        character: editor.selection.active.character
      });
      if (currentSequence !== this._syncSequence) {
        return;
      }
      this._previewProvider.update(
        createEmptyReturnPreviewState("Failed to resolve return structure. See Robot Companion output.")
      );
      return;
    }

    if (returnContext) {
      this._applyReturnPreviewContext(parsed, returnContext);
      if (returnContext.technicalPending) {
        void this._refreshReturnTechnicalDetails(editor, parsed, currentSequence);
      }
      return;
    }

    let keywordDocContext = undefined;
    try {
      keywordDocContext = await resolveKeywordDocumentationPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService
      );
    } catch (error) {
      logRobotCompanionError("Keyword doc preview refresh failed", error, {
        documentUri: editor.document.uri.toString(),
        line: editor.selection.active.line,
        character: editor.selection.active.character
      });
    }

    if (currentSequence !== this._syncSequence) {
      return;
    }

    if (keywordDocContext) {
      this._previewProvider.update({
        contextKind: "keyword-doc",
        documentUri: parsed.uri,
        fileName: parsed.fileName,
        ownerName: keywordDocContext.owner ? keywordDocContext.owner.name : "",
        variableToken: keywordDocContext.keywordToken.keywordName,
        keywordName: keywordDocContext.keywordToken.keywordName,
        returnAnnotation: "",
        currentValue: "",
        currentValueSource: "",
        currentValueSourceLine: undefined,
        sourceUri: keywordDocContext.primaryCandidate ? keywordDocContext.primaryCandidate.sourceUri : "",
        sourceLine: keywordDocContext.primaryCandidate ? keywordDocContext.primaryCandidate.sourceLine : undefined,
        sourceFilePath: keywordDocContext.primaryCandidate ? keywordDocContext.primaryCandidate.sourceFilePath : "",
        sourceFunctionName: keywordDocContext.primaryCandidate ? keywordDocContext.primaryCandidate.functionName : "",
        detailsMarkdown: buildKeywordDocPreviewMarkdown(keywordDocContext),
        infoMessage: keywordDocContext.warningMessage || ""
      });
      return;
    }

    this._previewProvider.update(
      createEmptyReturnPreviewState("Place cursor on a keyword token, variable, or named argument in a keyword call.")
    );
  }

  async _resolveReturnPreviewWhenIdle(editor, parsed, expectedSequence) {
    if (!editor || !parsed || expectedSequence !== this._syncSequence) {
      return;
    }

    const refreshTask = async () => {
      if (!editor || !parsed || expectedSequence !== this._syncSequence) {
        return;
      }
      const fullContext = await resolveKeywordReturnPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService,
        {
          maxDepth: getReturnPreviewMaxDepth(),
          maxFieldsPerType: getReturnMaxFieldsPerType(),
          includeTechnical: true,
          runtimeCache: this._runtimeCacheService,
          returnComputeWorker: this._returnComputeWorker
        }
      );
      if (!fullContext || expectedSequence !== this._syncSequence) {
        return;
      }
      this._applyReturnPreviewContext(parsed, fullContext);
    };

    if (this._runtimeCacheService) {
      this._runtimeCacheService.scheduleBackgroundTask(
        `return-preview-idle|${editor.document.uri.toString()}|${expectedSequence}|${editor.selection.active.line}|${editor.selection.active.character}`,
        async () => {
          try {
            await refreshTask();
          } catch (error) {
            logRobotCompanionError("Deferred return preview refresh failed", error, {
              documentUri: editor.document.uri.toString(),
              line: editor.selection.active.line,
              character: editor.selection.active.character
            });
            if (expectedSequence !== this._syncSequence) {
              return;
            }
            this._previewProvider.update(
              createEmptyReturnPreviewState("Failed to resolve return structure. See Robot Companion output.")
            );
          }
        },
        { maxWaitMs: BACKGROUND_TASK_MAX_WAIT_MS }
      );
      return;
    }

    try {
      await refreshTask();
    } catch (error) {
      logRobotCompanionError("Deferred return preview refresh failed", error, {
        documentUri: editor.document.uri.toString(),
        line: editor.selection.active.line,
        character: editor.selection.active.character
      });
      if (expectedSequence !== this._syncSequence) {
        return;
      }
      this._previewProvider.update(
        createEmptyReturnPreviewState("Failed to resolve return structure. See Robot Companion output.")
      );
    }
  }

  async _refreshReturnTechnicalDetails(editor, parsed, expectedSequence) {
    if (!editor || !parsed || expectedSequence !== this._syncSequence) {
      return;
    }
    const refreshTask = async () => {
      if (!editor || !parsed || expectedSequence !== this._syncSequence) {
        return;
      }
      const fullContext = await resolveKeywordReturnPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService,
        {
          maxDepth: getReturnPreviewMaxDepth(),
          maxFieldsPerType: getReturnMaxFieldsPerType(),
          includeTechnical: true,
          runtimeCache: this._runtimeCacheService,
          returnComputeWorker: this._returnComputeWorker
        }
      );
      if (!fullContext || expectedSequence !== this._syncSequence) {
        return;
      }
      this._applyReturnPreviewContext(parsed, fullContext);
    };

    if (this._runtimeCacheService) {
      this._runtimeCacheService.scheduleBackgroundTask(
        `return-technical-idle|${editor.document.uri.toString()}|${expectedSequence}|${editor.selection.active.line}|${editor.selection.active.character}`,
        async () => {
          try {
            await refreshTask();
          } catch (error) {
            logRobotCompanionError("Return technical refresh failed", error, {
              documentUri: editor.document.uri.toString(),
              line: editor.selection.active.line,
              character: editor.selection.active.character,
              stage: "background"
            });
          }
        },
        { maxWaitMs: BACKGROUND_TASK_MAX_WAIT_MS }
      );
      return;
    }

    try {
      await refreshTask();
    } catch (error) {
      logRobotCompanionError("Return technical refresh failed", error, {
        documentUri: editor.document.uri.toString(),
        line: editor.selection.active.line,
        character: editor.selection.active.character,
        stage: "foreground"
      });
    }
  }

  _applyReturnPreviewContext(parsed, context) {
    if (!context) {
      return;
    }
    this._previewProvider.update({
      contextKind: "return",
      fileName: parsed.fileName,
      ownerName: context.owner.name,
      variableToken: context.variableToken.token,
      keywordName: context.assignment.keywordName,
      returnAnnotation: context.returnAnnotation,
      sourceUri: "",
      sourceLine: undefined,
      sourceFilePath: "",
      sourceFunctionName: "",
      detailsMarkdown: buildReturnPreviewMarkdown(context),
      infoMessage:
        context.returnAnnotation.length === 0
          ? "No return annotation found for this keyword in indexed Python sources."
          : context.simpleAccess.firstLevel.length === 0 && context.technicalStructureLines.length === 0
          ? "No indexed structured return type resolved from this annotation."
          : ""
    });
  }
}

function buildReturnPreviewMarkdown(context) {
  const lines = [];
  const accessLevels = getSimpleAccessLevels(context.simpleAccess, getReturnPreviewMaxDepth());

  lines.push("### What You Can Access");
  lines.push("");
  if (context.returnAnnotation) {
    lines.push("```python");
    lines.push(context.returnAnnotation);
    lines.push("```");
    lines.push("");
  }

  if (accessLevels.length === 0) {
    lines.push("_No structured type details available for this return annotation._");
    return lines.join("\n");
  }

  for (let levelIndex = 0; levelIndex < accessLevels.length; levelIndex += 1) {
    const levelPaths = accessLevels[levelIndex];
    if (levelPaths.length === 0) {
      continue;
    }
    lines.push(`#### ${formatAccessDepthLabel(levelIndex + 1)}`);
    lines.push("```robotframework");
    lines.push(levelPaths.join("\n"));
    lines.push("```");
    lines.push("");
  }

  if (context.technicalStructureLines.length > 0) {
    lines.push("### Technical Details (Developer)");
    lines.push("");
    lines.push("```text");
    lines.push(context.technicalStructureLines.join("\n"));
    lines.push("```");
  } else if (context.technicalPending) {
    lines.push("### Technical Details (Developer)");
    lines.push("");
    lines.push("_Loading technical details..._");
  }

  return lines.join("\n");
}

function buildKeywordDocPreviewMarkdown(context) {
  const lines = [];

  if (context.warningMessage) {
    lines.push(`> ${context.warningMessage}`);
    lines.push("");
  }

  if (context.primaryCandidate) {
    const sourceFileLabel = context.primaryCandidate.sourceFilePath
      ? path.basename(context.primaryCandidate.sourceFilePath)
      : "Python source";
    const hasSourceLine =
      Number.isFinite(Number(context.primaryCandidate.sourceLine)) &&
      Number(context.primaryCandidate.sourceLine) >= 0;
    const sourceLineNumber = hasSourceLine ? Number(context.primaryCandidate.sourceLine) + 1 : undefined;
    const sourceJumpCommand =
      context.primaryCandidate.sourceUri && hasSourceLine
        ? buildOpenLocationCommandUri(
            context.primaryCandidate.sourceUri,
            Number(context.primaryCandidate.sourceLine)
          )
        : "";

    lines.push("### Keyword Definition");
    lines.push("");
    if (hasSourceLine) {
      lines.push(`Definition: \`${sourceFileLabel} line ${sourceLineNumber}\``);
    } else {
      lines.push(`Definition: \`${sourceFileLabel}\``);
    }
    if (context.primaryCandidate.functionName) {
      lines.push(`Function: \`${context.primaryCandidate.functionName}\``);
    }
    if (sourceJumpCommand) {
      lines.push(`[Jump to keyword definition](${sourceJumpCommand})`);
    }
    lines.push("");
  }

  lines.push("### Keyword Documentation");
  lines.push("");

  if (context.primaryCandidate && context.primaryCandidate.normalizedDocstring) {
    const documentedArgumentEntries =
      Array.isArray(context.documentedArgumentEntries) && context.documentedArgumentEntries.length > 0
        ? context.documentedArgumentEntries
        : extractKeywordDocArgumentEntriesFromMarkdown(context.primaryCandidate.normalizedDocstring);
    const markdownWithArgumentLinks = injectKeywordDocArgumentNavigationLinks(
      context.primaryCandidate.normalizedDocstring,
      {
        callArgumentNavigationMap: context.callArgumentNavigationMap,
        insertCommandBuilder: ({ argumentName, normalizedArgumentName, target }) => {
          if (target) {
            return "";
          }
          return buildInsertKeywordArgumentCommandUri({
            documentUri: context.documentUri,
            keywordLine: context.keywordToken?.line,
            keywordCharacter: context.keywordToken?.start,
            keywordName: context.keywordToken?.keywordName || "",
            argumentName,
            normalizedArgumentName,
            documentedArgumentNames: documentedArgumentEntries.map((entry) => entry.argumentName),
            headerIndent: context.callHeaderIndent || ""
          });
        },
        commandBuilder: ({ argumentName, normalizedArgumentName, target }) =>
          buildPreviewKeywordArgumentCommandUri({
            documentUri: context.documentUri,
            keywordLine: context.keywordToken?.line,
            keywordCharacter: context.keywordToken?.start,
            keywordName: context.keywordToken?.keywordName || "",
            argumentName,
            normalizedArgumentName,
            line: target?.line,
            character: target?.character,
            argumentValue: String(target?.argumentValue || "")
          })
      }
    );
    lines.push(
      "_Tip: Click argument names in **Args** to preview that argument and jump to it when present. Use **Insert** for missing named arguments._"
    );
    lines.push("");
    lines.push(markdownWithArgumentLinks);
  } else if (context.primaryCandidate && context.primaryCandidate.rawDocstring) {
    lines.push("#### Raw Docstring");
    lines.push("");
    lines.push("```text");
    lines.push(context.primaryCandidate.rawDocstring);
    lines.push("```");
  } else {
    lines.push("_No indexed docstring content found for this keyword._");
  }

  const additionalWarnings = uniqueStrings(
    []
      .concat(context.primaryCandidate?.docWarnings || [])
      .concat(context.additionalWarnings || [])
      .map((warning) => String(warning || "").trim())
      .filter(Boolean)
  );
  if (additionalWarnings.length > 0) {
    lines.push("");
    lines.push("#### Parsing Notes");
    lines.push("");
    for (const warning of additionalWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  if ((context.candidates || []).length > 1) {
    lines.push("");
    lines.push("#### Other Matching Definitions");
    lines.push("");
    for (const candidate of context.candidates) {
      if (!context.primaryCandidate || buildKeywordDocCandidateKey(candidate) === buildKeywordDocCandidateKey(context.primaryCandidate)) {
        continue;
      }
      const fileLabel = candidate.sourceFilePath ? path.basename(candidate.sourceFilePath) : "Python source";
      const lineNumber = Number.isFinite(Number(candidate.sourceLine)) ? Number(candidate.sourceLine) + 1 : 1;
      const link = candidate.sourceUri ? buildOpenLocationCommandUri(candidate.sourceUri, Number(candidate.sourceLine) || 0) : "";
      const descriptor = `${fileLabel}:${lineNumber}${candidate.functionName ? ` (${candidate.functionName})` : ""}`;
      if (link) {
        lines.push(`- [${descriptor}](${link})`);
      } else {
        lines.push(`- ${descriptor}`);
      }
    }
  }

  return lines.join("\n").trim();
}

function buildManagedKeywordDocAnchorHtml(commandUri, innerHtml, options = {}) {
  const safeCommandUri = String(commandUri || "").trim();
  if (!safeCommandUri) {
    return String(innerHtml || "");
  }

  const attributes = [
    'href="#"',
    `data-source-command="${escapeHtmlAttribute(safeCommandUri)}"`,
    'data-managed-keyword-doc-command="true"'
  ];
  const className = String(options.className || "").trim();
  if (className) {
    attributes.push(`class="${escapeHtmlAttribute(className)}"`);
  }
  const title = String(options.title || "").trim();
  if (title) {
    attributes.push(`title="${escapeHtmlAttribute(title)}"`);
  }

  return `<a ${attributes.join(" ")}>${String(innerHtml || "")}</a>`;
}

function injectKeywordDocArgumentNavigationLinks(markdown, options = {}) {
  const callArgumentNavigationMap =
    options.callArgumentNavigationMap instanceof Map ? options.callArgumentNavigationMap : new Map();
  const commandBuilder =
    typeof options.commandBuilder === "function" ? options.commandBuilder : undefined;
  const insertCommandBuilder =
    typeof options.insertCommandBuilder === "function" ? options.insertCommandBuilder : undefined;
  if (!commandBuilder && !insertCommandBuilder) {
    return String(markdown || "");
  }

  const lines = String(markdown || "").split(/\r?\n/);
  const linkedLines = lines.map((line) => {
    const match = line.match(/^(\s*[-*]\s+)`([^`]+)`([\s\S]*)$/);
    if (!match) {
      return line;
    }

    const prefix = match[1];
    const argumentName = String(match[2] || "").trim();
    const suffix = String(match[3] || "");
    const normalizedArgument = normalizeArgumentName(argumentName);
    const target = callArgumentNavigationMap.get(normalizedArgument);
    const commandUri = commandBuilder
      ? String(
          commandBuilder({
            argumentName,
            normalizedArgumentName: normalizedArgument,
            target
          }) || ""
        )
      : "";
    const insertCommandUri =
      !target && insertCommandBuilder
        ? String(
            insertCommandBuilder({
              argumentName,
              normalizedArgumentName: normalizedArgument,
              target
            }) || ""
          )
        : "";

    const renderedArgumentName = commandUri
      ? buildManagedKeywordDocAnchorHtml(
          commandUri,
          `<code>${escapeHtml(argumentName)}</code>`,
          {
            className: "doc-keyword-argument-link",
            title: target
              ? `Preview argument ${argumentName} at line ${Math.max(0, Number(target.line) || 0) + 1}`
              : `Preview argument ${argumentName}`
          }
        )
      : `\`${escapeMarkdownInline(argumentName)}\``;
    let renderedLine = `${prefix}${renderedArgumentName}${suffix}`;
    if (insertCommandUri) {
      renderedLine += ` · ${buildManagedKeywordDocAnchorHtml(insertCommandUri, "Insert", {
        className: "doc-keyword-argument-insert-link",
        title: `Insert named argument ${argumentName}`
      })}`;
    }
    return renderedLine;
  });

  return linkedLines.join("\n");
}

function extractKeywordDocArgumentEntriesFromMarkdown(markdown) {
  const entries = [];
  const seen = new Set();
  let currentSection = "summary";

  for (const line of String(markdown || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const normalizedSectionHeader = trimmed.replace(/^#{1,6}\s+/, "");
    const renderedSectionMatch = normalizedSectionHeader.match(/^(Args?|Arguments?|Returns?|Raises?)\s*:?\s*$/i);
    const section = renderedSectionMatch
      ? parseKeywordDocSectionHeader(`${String(renderedSectionMatch[1] || "")}:`)
      : parseKeywordDocSectionHeader(trimmed);
    if (section) {
      currentSection = section;
      continue;
    }

    if (currentSection !== "Args") {
      continue;
    }

    const match = line.match(/^\s*[-*]\s+`([^`]+)`(?:\s+\(([^)]+)\))?(?::\s*(.*))?$/);
    if (!match) {
      continue;
    }

    const argumentName = String(match[1] || "").trim();
    const normalizedArgumentName = normalizeArgumentName(argumentName);
    if (!normalizedArgumentName || seen.has(normalizedArgumentName)) {
      continue;
    }

    seen.add(normalizedArgumentName);
    entries.push({
      argumentName,
      normalizedArgumentName,
      typeName: String(match[2] || "").trim(),
      description: String(match[3] || "").trim()
    });
  }

  return entries;
}

function buildNamedArgumentNavigationMapForKeywordCall(document, headerLine) {
  const map = new Map();
  if (!document || !Number.isFinite(Number(headerLine)) || Number(headerLine) < 0) {
    return map;
  }

  const startLine = Number(headerLine);
  for (let lineIndex = startLine; lineIndex < document.lineCount; lineIndex += 1) {
    const lineText = document.lineAt(lineIndex).text;
    if (lineIndex > startLine && !lineText.trimStart().startsWith("...")) {
      break;
    }

    const namedArguments = extractNamedArgumentsWithRangesFromRobotCallLine(lineText);
    for (const namedArgument of namedArguments) {
      const normalizedArgumentName = normalizeArgumentName(namedArgument.name);
      if (!normalizedArgumentName || map.has(normalizedArgumentName)) {
        continue;
      }

      map.set(normalizedArgumentName, {
        argumentName: namedArgument.name,
        line: lineIndex,
        character: namedArgument.nameStart,
        argumentValue: String(namedArgument.value || "")
      });
    }
  }

  return map;
}

function buildKeywordArgumentInsertPlan(document, payload = {}) {
  if (!document) {
    return undefined;
  }

  const headerLine = Math.max(0, Number(payload?.keywordLine) || 0);
  if (headerLine >= document.lineCount) {
    return undefined;
  }

  const argumentName = String(payload?.argumentName || "").trim();
  const normalizedArgumentName = normalizeArgumentName(
    String(payload?.normalizedArgumentName || argumentName)
  );
  if (!argumentName || !normalizedArgumentName) {
    return undefined;
  }

  const headerText = document.lineAt(headerLine).text;
  const headerIndent = getLeadingWhitespacePrefix(headerText);
  let callEndLine = headerLine;
  while (callEndLine + 1 < document.lineCount && document.lineAt(callEndLine + 1).text.trimStart().startsWith("...")) {
    callEndLine += 1;
  }

  const existingArguments = buildNamedArgumentNavigationMapForKeywordCall(document, headerLine);
  const existingTarget = existingArguments.get(normalizedArgumentName);
  const insertLineText = `${headerIndent}...    ${argumentName}=`;

  if (existingTarget) {
    return {
      kind: "existing",
      headerLine,
      callEndLine,
      headerIndent,
      insertLineText,
      existingTarget
    };
  }

  const orderedArgumentEntries = [];
  const seenNormalizedNames = new Set();
  for (const candidateName of Array.isArray(payload?.documentedArgumentNames) ? payload.documentedArgumentNames : []) {
    const safeCandidateName = String(candidateName || "").trim();
    const normalizedCandidateName = normalizeArgumentName(safeCandidateName);
    if (!safeCandidateName || !normalizedCandidateName || seenNormalizedNames.has(normalizedCandidateName)) {
      continue;
    }
    seenNormalizedNames.add(normalizedCandidateName);
    orderedArgumentEntries.push({
      argumentName: safeCandidateName,
      normalizedArgumentName: normalizedCandidateName
    });
  }

  const targetOrderIndex = orderedArgumentEntries.findIndex(
    (entry) => entry.normalizedArgumentName === normalizedArgumentName
  );
  let laterArgumentPresentOnHeaderLine = false;
  let beforeLine = undefined;

  if (targetOrderIndex >= 0) {
    for (let index = targetOrderIndex + 1; index < orderedArgumentEntries.length; index += 1) {
      const existingLaterArgument = existingArguments.get(orderedArgumentEntries[index].normalizedArgumentName);
      if (!existingLaterArgument) {
        continue;
      }
      if (existingLaterArgument.line > headerLine) {
        beforeLine = existingLaterArgument.line;
        break;
      }
      laterArgumentPresentOnHeaderLine = true;
      break;
    }
  }

  if (Number.isInteger(beforeLine)) {
    return {
      kind: "insertBeforeLine",
      headerLine,
      callEndLine,
      beforeLine,
      insertLine: beforeLine,
      headerIndent,
      insertLineText
    };
  }

  if (laterArgumentPresentOnHeaderLine && callEndLine > headerLine) {
    return {
      kind: "insertBeforeLine",
      headerLine,
      callEndLine,
      beforeLine: headerLine + 1,
      insertLine: headerLine + 1,
      headerIndent,
      insertLineText
    };
  }

  return {
    kind: "appendAfterCallEnd",
    headerLine,
    callEndLine,
    insertAfterLine: callEndLine,
    insertLine: callEndLine + 1,
    headerIndent,
    insertLineText
  };
}

async function insertKeywordArgumentFromPayload(payload = {}, returnController) {
  if (shouldPauseRobotCompanionKeywordArgumentInsertForDebug()) {
    return;
  }

  const uriString = String(payload?.documentUri || "").trim();
  if (!uriString) {
    return;
  }

  const preferredLine = Number.isFinite(Number(payload?.keywordLine)) ? Math.max(0, Number(payload.keywordLine)) : 0;
  const preferredCharacter = Number.isFinite(Number(payload?.keywordCharacter))
    ? Math.max(0, Number(payload.keywordCharacter))
    : 0;

  await openTextDocumentAtLocation(uriString, preferredLine, preferredCharacter);
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uriString || !isRobotDocument(editor.document)) {
    return;
  }

  editor = (await focusTextEditor(editor)) || editor;
  const insertPlan = buildKeywordArgumentInsertPlan(editor.document, payload);
  if (!insertPlan) {
    return;
  }

  if (insertPlan.kind === "existing") {
    await openTextDocumentAtLocation(
      uriString,
      Number(insertPlan.existingTarget.line) || 0,
      Number(insertPlan.existingTarget.character) || 0
    );
    await returnController?.refresh?.();
    return;
  }

  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  let insertionPosition;
  let insertionText;
  if (insertPlan.kind === "insertBeforeLine") {
    insertionPosition = new vscode.Position(insertPlan.beforeLine, 0);
    insertionText = `${insertPlan.insertLineText}${eol}`;
  } else {
    insertionPosition = new vscode.Position(
      insertPlan.insertAfterLine,
      editor.document.lineAt(insertPlan.insertAfterLine).text.length
    );
    insertionText = `${eol}${insertPlan.insertLineText}`;
  }

  const editSucceeded = await editor.edit((editBuilder) => {
    editBuilder.insert(insertionPosition, insertionText);
  });
  if (!editSucceeded) {
    return;
  }

  const caretPosition = new vscode.Position(insertPlan.insertLine, insertPlan.insertLineText.length);
  editor.selection = new vscode.Selection(caretPosition, caretPosition);
  editor.revealRange(
    new vscode.Range(caretPosition, caretPosition),
    vscode.TextEditorRevealType.InCenter
  );
  await vscode.commands.executeCommand("editor.action.triggerSuggest");
  await delay(50);
  await returnController?.refresh?.();
}

async function resolveKeywordDocumentationPreview(document, parsed, position, enumHintService) {
  if (!document || !parsed || !enumHintService) {
    return undefined;
  }

  const keywordToken = getKeywordTokenContextAtPosition(document, position);
  if (!keywordToken) {
    return undefined;
  }

  const owner = findOwnerForLine(parsed.owners, position.line);
  const index = await enumHintService.getIndexForDocument(document);
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(keywordToken.keywordName);
  const allCandidates = dedupeKeywordDocCandidates(index.keywordDocsByName?.get(normalizedKeyword) || []);
  const sortedCandidates = sortKeywordDocCandidates(allCandidates);
  const primaryCandidate = sortedCandidates[0];
  const callArgumentNavigationMap = buildNamedArgumentNavigationMapForKeywordCall(document, keywordToken.line);
  const documentedArgumentEntries = primaryCandidate?.normalizedDocstring
    ? extractKeywordDocArgumentEntriesFromMarkdown(primaryCandidate.normalizedDocstring)
    : [];
  const warnings = [];

  if (sortedCandidates.length === 0) {
    warnings.push("No indexed @keyword docstring found for this keyword.");
  } else {
    if (sortedCandidates.length > 1) {
      warnings.push(
        `Multiple keyword definitions found (${sortedCandidates.length}); showing best match first.`
      );
    }
    if (!primaryCandidate.normalizedDocstring && !primaryCandidate.rawDocstring) {
      warnings.push("Keyword definition found, but no docstring content is available.");
    }
    if ((primaryCandidate.docWarnings || []).length > 0) {
      warnings.push(
        `Doc parsing warnings detected (${primaryCandidate.docWarnings.length}); see Parsing Notes below.`
      );
    }
  }

  return {
    documentUri: parsed.uri,
    owner,
    keywordToken,
    normalizedKeyword,
    candidates: sortedCandidates,
    primaryCandidate,
    callArgumentNavigationMap,
    documentedArgumentEntries,
    callHeaderIndent: getLeadingWhitespacePrefix(document.lineAt(keywordToken.line).text),
    warningMessage: uniqueStrings(warnings).join(" "),
    additionalWarnings: uniqueStrings(warnings)
  };
}

function dedupeKeywordDocCandidates(candidates) {
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const key = buildKeywordDocCandidateKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function buildKeywordDocCandidateKey(candidate) {
  const sourceFilePath = String(candidate?.sourceFilePath || "");
  const sourceLine = Number.isFinite(Number(candidate?.sourceLine)) ? Number(candidate.sourceLine) : -1;
  const functionName = String(candidate?.functionName || "");
  const keywordName = String(candidate?.keywordName || "");
  return `${sourceFilePath}|${sourceLine}|${functionName}|${keywordName}`;
}

function sortKeywordDocCandidates(candidates) {
  return [...(candidates || [])].sort((left, right) => {
    const leftHasMarkdown = String(left?.normalizedDocstring || "").trim().length > 0 ? 1 : 0;
    const rightHasMarkdown = String(right?.normalizedDocstring || "").trim().length > 0 ? 1 : 0;
    if (leftHasMarkdown !== rightHasMarkdown) {
      return rightHasMarkdown - leftHasMarkdown;
    }

    const leftHasRaw = String(left?.rawDocstring || "").trim().length > 0 ? 1 : 0;
    const rightHasRaw = String(right?.rawDocstring || "").trim().length > 0 ? 1 : 0;
    if (leftHasRaw !== rightHasRaw) {
      return rightHasRaw - leftHasRaw;
    }

    const leftWarnings = Array.isArray(left?.docWarnings) ? left.docWarnings.length : 0;
    const rightWarnings = Array.isArray(right?.docWarnings) ? right.docWarnings.length : 0;
    if (leftWarnings !== rightWarnings) {
      return leftWarnings - rightWarnings;
    }

    const leftPath = String(left?.sourceFilePath || "");
    const rightPath = String(right?.sourceFilePath || "");
    if (leftPath !== rightPath) {
      return leftPath.localeCompare(rightPath);
    }

    const leftLine = Number.isFinite(Number(left?.sourceLine)) ? Number(left.sourceLine) : Number.MAX_SAFE_INTEGER;
    const rightLine = Number.isFinite(Number(right?.sourceLine)) ? Number(right.sourceLine) : Number.MAX_SAFE_INTEGER;
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }

    const leftFunctionName = String(left?.functionName || "");
    const rightFunctionName = String(right?.functionName || "");
    if (leftFunctionName !== rightFunctionName) {
      return leftFunctionName.localeCompare(rightFunctionName);
    }

    const leftKeywordName = String(left?.keywordName || "");
    const rightKeywordName = String(right?.keywordName || "");
    return leftKeywordName.localeCompare(rightKeywordName);
  });
}

function buildEnumPreviewMarkdown(context) {
  const lines = [];
  const showArgumentAssignment = context.showArgumentAssignment !== false;
  const showResolvedCurrentValue = context.showResolvedCurrentValue !== false;
  const showCurrentMemberMarker = context.showCurrentMemberMarker !== false;
  const currentValueKind = String(context.currentValueKind || "single").trim().toLowerCase();
  const currentValueCandidates = Array.isArray(context.currentValueCandidates) ? context.currentValueCandidates : [];
  const currentValue = String(context.currentValue || context.argumentValue || "").trim();
  const argumentValue = String(context.argumentValue || "").trim();
  const normalizedCurrentValue = currentValue.toLowerCase();
  let resolvedCurrentValueDisplay = currentValue;
  if (currentValue.length > 0) {
    for (const enumEntry of context.shownEnums || []) {
      const matchingMembers = getEnumMatchingMembers(enumEntry, normalizedCurrentValue);
      if (matchingMembers.length === 0) {
        continue;
      }
      const member = matchingMembers[0];
      const memberName = String(member?.name || "").trim();
      const memberValue = String(member?.valueLiteral || "").trim();
      if (
        memberName.length > 0 &&
        memberValue.length > 0 &&
        memberName.toLowerCase() !== memberValue.toLowerCase()
      ) {
        if (normalizedCurrentValue === memberName.toLowerCase()) {
          resolvedCurrentValueDisplay = `${currentValue} (= ${memberValue})`;
        } else if (normalizedCurrentValue === memberValue.toLowerCase()) {
          resolvedCurrentValueDisplay = `${currentValue} (= ${memberName})`;
        } else {
          resolvedCurrentValueDisplay = `${currentValue} (${memberName} = ${memberValue})`;
        }
      }
      break;
    }
  }
  lines.push("### What This Argument Accepts");
  lines.push("");
  lines.push("```robotframework");
  lines.push(showArgumentAssignment ? `${context.argumentName}=${context.argumentValue}` : `${context.argumentName}`);
  lines.push("```");
  lines.push("");

  if (context.backToKeywordCommandUri) {
    lines.push(`[Jump back to keyword](${context.backToKeywordCommandUri})`);
    lines.push("");
  }

  if (showResolvedCurrentValue) {
    if (currentValueKind === "conditional" && currentValueCandidates.length > 0) {
      lines.push("Current value (conditional):");
      for (const candidate of currentValueCandidates) {
        const sourceLineNumber =
          Number.isFinite(Number(candidate?.sourceLine)) && Number(candidate.sourceLine) >= 0
            ? Number(candidate.sourceLine) + 1
            : undefined;
        const displayValue = String(candidate?.value || "").trim() || "(empty)";
        let line = `- \`${displayValue}\``;
        if (sourceLineNumber) {
          line += ` from \`${getLocalVariableAssignmentSourceLabel(candidate)}\` line ${sourceLineNumber}`;
        }
        lines.push(line);
        const sourceCommand =
          sourceLineNumber && context.documentUri
            ? buildOpenLocationCommandUri(context.documentUri, Number(candidate.sourceLine))
            : "";
        if (sourceCommand) {
          lines.push(`  [Jump to ${getLocalVariableAssignmentSourceLabel(candidate)} line ${sourceLineNumber}](${sourceCommand})`);
        }
      }
      lines.push("");
    } else if (currentValue.length > 0) {
      if (argumentValue.length > 0 && argumentValue !== currentValue) {
        lines.push(`Resolved current value: \`${resolvedCurrentValueDisplay}\` (from \`${argumentValue}\`).`);
      } else {
        lines.push(`Resolved current value: \`${resolvedCurrentValueDisplay}\`.`);
      }
      lines.push("");
    }

    if (
      currentValueKind !== "conditional" &&
      isLocalVariableCurrentValueSource(context.currentValueSource) &&
      Number.isFinite(Number(context.currentValueSourceLine)) &&
      Number(context.currentValueSourceLine) >= 0
    ) {
      const sourceLineNumber = Number(context.currentValueSourceLine) + 1;
      const currentValueSourceLabel = getLocalVariableAssignmentSourceLabel(context);
      lines.push(`Resolved from local \`${currentValueSourceLabel}\` at line ${sourceLineNumber}.`);
      const setVariableCommand = buildOpenLocationCommandUri(context.documentUri, Number(context.currentValueSourceLine));
      if (setVariableCommand) {
        lines.push(`[Jump to ${currentValueSourceLabel} line ${sourceLineNumber}](${setVariableCommand})`);
      }
      lines.push("");
    }
  }

  const provenanceNote = getEnumMatchProvenanceNote(context);
  if (provenanceNote) {
    lines.push(provenanceNote);
    lines.push("");
  }
  if ((Number(context.duplicateCandidateCount) || 0) > 0) {
    const duplicateCount = Number(context.duplicateCandidateCount) || 0;
    lines.push(
      `_Collapsed ${duplicateCount} duplicate enum definition${duplicateCount === 1 ? "" : "s"} with identical members._`
    );
    lines.push("");
  }

  const annotationHints = context.annotationHints || [];
  if (annotationHints.length > 0) {
    lines.push(annotationHints.length > 1 ? "#### Type Hints" : "#### Type Hint");
    lines.push("```python");
    lines.push(annotationHints.join("\n"));
    lines.push("```");
    lines.push("");
  }

  for (const enumEntry of context.shownEnums || []) {
    lines.push(`#### ${enumEntry.name}`);
    lines.push("```text");
    const members = enumEntry.members || [];
    const shownMembers = members.slice(0, context.maxMembers);
    if (shownMembers.length === 0) {
      lines.push("(no indexed enum members)");
    } else {
      lines.push(
        ...shownMembers.map((member) => {
          const display = formatEnumMemberForDisplay(member);
          if (showCurrentMemberMarker && isEnumMemberMatch(member, normalizedCurrentValue)) {
            return `${display}  <= current`;
          }
          return display;
        })
      );
    }
    lines.push("```");

    if (members.length > shownMembers.length) {
      lines.push(
        `_Showing first ${shownMembers.length} of ${members.length} members for ${enumEntry.name}._`
      );
    }
    if (showResolvedCurrentValue && !doesEnumContainValue(enumEntry, normalizedCurrentValue)) {
      lines.push("_Current value is not an exact member match in this enum._");
    }
    lines.push("");
  }

  if ((context.candidates || []).length > (context.shownEnums || []).length) {
    lines.push(
      `_Showing ${(context.shownEnums || []).length} of ${(context.candidates || []).length} matching enum candidates._`
    );
  }

  if ((context.shownEnums || []).length === 0 && annotationHints.length === 0) {
    lines.push("_No matching enum candidates found in indexed Python sources._");
  }

  const isRedundantReturnHintSection = isRedundantReturnHint(context);

  if (showResolvedCurrentValue && context.returnHintContext && !isRedundantReturnHintSection) {
    lines.push("");
    lines.push("### Return Hint For Argument Value");
    lines.push("");
    lines.push(`Keyword: \`${context.returnHintContext.assignment.keywordName}\``);
    const sourceLine = Number(context.returnHintContext.sourceLine);
    if (Number.isFinite(sourceLine) && sourceLine >= 0) {
      const sourceLineNumber = sourceLine + 1;
      lines.push(`Set at line: \`${sourceLineNumber}\``);
      const shouldSuppressReturnHintJump =
        isLocalVariableCurrentValueSource(context.currentValueSource) &&
        Number.isFinite(Number(context.currentValueSourceLine)) &&
        Number(context.currentValueSourceLine) >= 0 &&
        sourceLine === Number(context.currentValueSourceLine);
      const locationCommand = buildOpenLocationCommandUri(
        context.returnHintContext.sourceUri || context.documentUri,
        sourceLine
      );
      if (locationCommand && !shouldSuppressReturnHintJump) {
        lines.push(`[Jump to assignment line ${sourceLineNumber}](${locationCommand})`);
      }
    }
    if (context.returnHintContext.returnAnnotation) {
      lines.push("");
      lines.push("```python");
      lines.push(context.returnHintContext.returnAnnotation);
      lines.push("```");
    }
    const returnHintAccessLevels = getSimpleAccessLevels(
      context.returnHintContext.simpleAccess,
      getReturnHintArgumentMaxDepth()
    );
    for (let levelIndex = 0; levelIndex < returnHintAccessLevels.length; levelIndex += 1) {
      const levelPaths = returnHintAccessLevels[levelIndex];
      const accessDepthLabel = formatAccessDepthLabel(levelIndex + 1);
      lines.push("");
      lines.push(`**${accessDepthLabel}:**`);
      lines.push("```robotframework");
      lines.push(levelPaths.join("\n"));
      lines.push("```");
    }
  }

  return lines.join("\n");
}

function isRedundantReturnHint(context) {
  const returnHintSourceLine = Number(context?.returnHintContext?.sourceLine);
  const currentValueSourceLine = Number(context?.currentValueSourceLine);
  const returnHintKeywordName = String(context?.returnHintContext?.assignment?.keywordName || "")
    .trim()
    .toLowerCase();
  return (
    Boolean(context?.returnHintContext) &&
    isLocalVariableCurrentValueSource(context?.currentValueSource) &&
    Number.isFinite(returnHintSourceLine) &&
    returnHintSourceLine >= 0 &&
    Number.isFinite(currentValueSourceLine) &&
    currentValueSourceLine >= 0 &&
    returnHintSourceLine === currentValueSourceLine &&
    returnHintKeywordName === "set variable"
  );
}

function getSimpleAccessLevels(simpleAccess, maxDepth = 2) {
  const safeMaxDepth = Math.max(1, Math.min(12, Number(maxDepth) || 2));
  if (Array.isArray(simpleAccess?.levels) && simpleAccess.levels.length > 0) {
    return simpleAccess.levels
      .slice(0, safeMaxDepth)
      .map((level) => uniqueStrings((level || []).filter(Boolean)))
      .filter((level) => level.length > 0);
  }

  const fallbackLevels = [];
  if (Array.isArray(simpleAccess?.firstLevel) && simpleAccess.firstLevel.length > 0) {
    fallbackLevels.push(uniqueStrings(simpleAccess.firstLevel));
  }
  if (Array.isArray(simpleAccess?.secondLevel) && simpleAccess.secondLevel.length > 0) {
    fallbackLevels.push(uniqueStrings(simpleAccess.secondLevel));
  }
  return fallbackLevels.slice(0, safeMaxDepth);
}

function formatAccessDepthLabel(depth) {
  const safeDepth = Math.max(1, Number(depth) || 1);
  if (safeDepth === 1) {
    return "First-level access";
  }
  if (safeDepth === 2) {
    return "Second-level access";
  }
  if (safeDepth === 3) {
    return "Third-level access";
  }
  return `${safeDepth}th-level access`;
}

function getEnumMatchProvenanceNote(context) {
  const provenance = String(context?.matchProvenance || "");
  if (provenance === "argument-fallback") {
    return "_Match confidence: lower (fallback by argument name across keywords)._";
  }
  if (provenance === "annotation-only") {
    return "_Match confidence: lower (no enum mapping found; showing type hint only)._";
  }
  return "";
}

function isRobotDocument(document) {
  if (!document) {
    return false;
  }

  if (document.languageId === "robotframework") {
    return true;
  }

  const normalizedPath = document.uri.path.toLowerCase();
  return normalizedPath.endsWith(".robot") || normalizedPath.endsWith(".resource");
}

function isSectionHeader(trimmedLine) {
  return /^\*{3}\s*([^*]+?)\s*\*{3}$/.test(String(trimmedLine || ""));
}

function getRelevantSection(trimmedLine) {
  const match = trimmedLine.match(/^\*{3}\s*([^*]+?)\s*\*{3}$/);
  if (!match) {
    return null;
  }

  const normalized = match[1].trim().toLowerCase().replace(/\s+/g, " ");
  if (
    normalized === "test case" ||
    normalized === "test cases" ||
    normalized === "task" ||
    normalized === "tasks"
  ) {
    return "tests";
  }

  if (normalized === "keyword" || normalized === "keywords") {
    return "keywords";
  }

  return null;
}

function getOwnerName(line) {
  if (!line || /^[ \t]/.test(line)) {
    return null;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("***") ||
    trimmed.startsWith("...") ||
    trimmed.startsWith("[")
  ) {
    return null;
  }

  const cells = line.trimStart().split(/\s{2,}|\t+/).map((cell) => cell.trim()).filter(Boolean);
  return cells[0] || null;
}

function parseDocumentationHeader(line) {
  const trimmed = line.trimStart();
  if (!trimmed.toLowerCase().startsWith("[documentation]")) {
    return null;
  }

  return {
    inlineText: stripRobotCellSeparator(trimmed.slice("[Documentation]".length))
  };
}

function parseInlineDocumentationLine(line) {
  const trimmed = String(line || "").trimStart();
  const match = trimmed.match(/^#(>+)(.*)$/);
  if (!match) {
    return null;
  }

  const marker = String(match[1] || ">");
  const nestingLevel = Math.max(0, marker.length - 1);
  let text = String(match[2] || "");
  if (text.startsWith(" ") || text.startsWith("\t")) {
    text = text.slice(1);
  }

  if (nestingLevel > 0 && text.length > 0) {
    text = `${"  ".repeat(nestingLevel)}${text}`;
  }

  return {
    text,
    nestingLevel
  };
}

function parseContinuationLine(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("...")) {
    return {
      isContinuation: false,
      text: ""
    };
  }

  return {
    isContinuation: true,
    text: stripRobotCellSeparator(trimmed.slice(3))
  };
}

function stripRobotCellSeparator(textAfterPrefix) {
  if (!textAfterPrefix) {
    return "";
  }

  // Robot tables in this codebase commonly use 4 spaces as cell separator.
  // Strip that first so only intentional relative indentation remains.
  if (textAfterPrefix.startsWith("    ")) {
    return textAfterPrefix.slice(4);
  }

  if (textAfterPrefix.startsWith("\t")) {
    return textAfterPrefix.slice(1);
  }

  if (textAfterPrefix.startsWith("  ")) {
    return textAfterPrefix.slice(2);
  }

  if (textAfterPrefix.startsWith(" ")) {
    return textAfterPrefix.slice(1);
  }

  return textAfterPrefix;
}

function isMarkdownHeadingLine(line) {
  return getMarkdownHeadingLevel(line) > 0;
}

function getMarkdownHeadingLevel(line) {
  const match = String(line || "").match(/^\s{0,3}(#{1,6})\s+\S/);
  return match ? String(match[1] || "").length : 0;
}

function mergeDocumentationFragmentsToMarkdown(fragments) {
  const safeFragments = Array.isArray(fragments) ? fragments : [];
  const mergedLines = [];
  let hasMeaningfulContent = false;

  for (let index = 0; index < safeFragments.length; index += 1) {
    const fragmentMarkdown = String(safeFragments[index]?.markdown || "");
    const fragmentLines = fragmentMarkdown.split(/\r?\n/);
    mergedLines.push(...fragmentLines);
    if (fragmentLines.some((line) => String(line || "").trim().length > 0)) {
      hasMeaningfulContent = true;
    }
  }

  const mergedMarkdown = collapseMarkdownBlankLines(mergedLines.join("\n")).trim();
  if (mergedMarkdown.length > 0 || hasMeaningfulContent) {
    return mergedMarkdown;
  }
  return "";
}

function createDocumentationFragment(sourceKind, owner, startLine, endLine, markdownLines, options = {}) {
  const safeMarkdownLines = Array.isArray(markdownLines) ? markdownLines.map((line) => String(line || "")) : [];
  const safeStartLine = Math.max(0, Number(startLine) || 0);
  const safeEndLine = Math.max(safeStartLine, Number(endLine) || safeStartLine);
  const lineEntries = (Array.isArray(options.lineEntries) ? options.lineEntries : []).map((entry) => {
    const text = String(entry?.text || "");
    const headingLevel = Math.max(0, Number(entry?.headingLevel) || getMarkdownHeadingLevel(text));
    return {
      text,
      sourceLine: Math.max(0, Number(entry?.sourceLine) || safeStartLine),
      isHeading: headingLevel > 0 || Boolean(entry?.isHeading),
      headingLevel,
      nestingLevel: Math.max(0, Number(entry?.nestingLevel) || 0)
    };
  });

  return {
    id: `${String(owner?.id || "owner")}:${sourceKind}:${safeStartLine}`,
    sourceKind,
    startLine: safeStartLine,
    endLine: safeEndLine,
    markdown: safeMarkdownLines.join("\n"),
    lineEntries,
    ownerId: String(owner?.id || ""),
    ownerName: String(owner?.name || ""),
    section: String(owner?.section || "")
  };
}

function ensureDocumentationBlockBuilder(buildersByOwnerId, owner) {
  const ownerId = String(owner?.id || "");
  if (!ownerId) {
    return undefined;
  }

  const existing = buildersByOwnerId.get(ownerId);
  if (existing) {
    return existing;
  }

  const created = {
    owner,
    fragments: []
  };
  buildersByOwnerId.set(ownerId, created);
  return created;
}

function getLineLength(lines, line) {
  const safeLine = Math.max(0, Number(line) || 0);
  return String(lines?.[safeLine] || "").length;
}

function buildDocumentationBlocks(lines, owners, ownerByLine) {
  const buildersByOwnerId = new Map();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const owner = ownerByLine[lineIndex];
    if (!owner) {
      continue;
    }

    const docHeader = parseDocumentationHeader(lines[lineIndex]);
    if (docHeader) {
      const markdownLines = [];
      const lineEntries = [];
      if (docHeader.inlineText.length > 0) {
        markdownLines.push(docHeader.inlineText);
        lineEntries.push({
          text: docHeader.inlineText,
          sourceLine: lineIndex,
          isHeading: isMarkdownHeadingLine(docHeader.inlineText),
          headingLevel: getMarkdownHeadingLevel(docHeader.inlineText),
          nestingLevel: 0
        });
      }

      let endLine = lineIndex;
      for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
        const continuation = parseContinuationLine(lines[nextLine]);
        const nextOwner = ownerByLine[nextLine];
        if (!continuation.isContinuation || !nextOwner || nextOwner.id !== owner.id) {
          break;
        }
        markdownLines.push(continuation.text);
        lineEntries.push({
          text: continuation.text,
          sourceLine: nextLine,
          isHeading: isMarkdownHeadingLine(continuation.text),
          headingLevel: getMarkdownHeadingLevel(continuation.text),
          nestingLevel: 0
        });
        endLine = nextLine;
      }

      const builder = ensureDocumentationBlockBuilder(buildersByOwnerId, owner);
      if (builder) {
        builder.fragments.push(
          createDocumentationFragment("documentation", owner, lineIndex, endLine, markdownLines, {
            lineEntries
          })
        );
      }
      lineIndex = endLine;
      continue;
    }

    const inlineDoc = parseInlineDocumentationLine(lines[lineIndex]);
    if (!inlineDoc) {
      continue;
    }

    const markdownLines = [inlineDoc.text];
    const lineEntries = [
      {
        text: inlineDoc.text,
        sourceLine: lineIndex,
        isHeading: isMarkdownHeadingLine(inlineDoc.text),
        headingLevel: getMarkdownHeadingLevel(inlineDoc.text),
        nestingLevel: inlineDoc.nestingLevel
      }
    ];

    let endLine = lineIndex;
    for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
      const nextOwner = ownerByLine[nextLine];
      if (!nextOwner || nextOwner.id !== owner.id) {
        break;
      }
      const nextInlineDoc = parseInlineDocumentationLine(lines[nextLine]);
      if (!nextInlineDoc) {
        break;
      }
      markdownLines.push(nextInlineDoc.text);
      lineEntries.push({
        text: nextInlineDoc.text,
        sourceLine: nextLine,
        isHeading: isMarkdownHeadingLine(nextInlineDoc.text),
        headingLevel: getMarkdownHeadingLevel(nextInlineDoc.text),
        nestingLevel: nextInlineDoc.nestingLevel
      });
      endLine = nextLine;
    }

    const builder = ensureDocumentationBlockBuilder(buildersByOwnerId, owner);
    if (builder) {
      builder.fragments.push(
        createDocumentationFragment("inline", owner, lineIndex, endLine, markdownLines, {
          lineEntries
        })
      );
    }
    lineIndex = endLine;
  }

  const blocks = [];
  for (const owner of owners || []) {
    const builder = buildersByOwnerId.get(owner.id);
    if (!builder || !Array.isArray(builder.fragments) || builder.fragments.length === 0) {
      continue;
    }

    const fragments = [...builder.fragments].sort((left, right) => Number(left.startLine) - Number(right.startLine));
    const markdown = mergeDocumentationFragmentsToMarkdown(fragments);
    const title = deriveTitle(owner.name, markdown);
    const startLine = Math.min(...fragments.map((fragment) => Number(fragment.startLine) || owner.startLine));
    const endLine = Math.max(...fragments.map((fragment) => Number(fragment.endLine) || owner.startLine));
    const lineSpans = fragments.map((fragment) => ({
      startLine: Math.max(0, Number(fragment.startLine) || 0),
      endLine: Math.max(0, Number(fragment.endLine) || 0)
    }));

    blocks.push({
      id: `${owner.id}:documentation`,
      ownerName: owner.name,
      ownerId: owner.id,
      ownerStartLine: owner.startLine,
      ownerEndLine: owner.endLine,
      section: owner.section,
      title,
      markdown,
      fragments,
      lineSpans,
      startLine,
      endLine,
      range: new vscode.Range(startLine, 0, endLine, getLineLength(lines, endLine))
    });
  }

  return blocks;
}

function deriveTitle(ownerName, markdown) {
  const lines = markdown.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/, "").trim();
      if (heading) {
        return heading;
      }
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  }

  return ownerName;
}

function getBlockLineSpans(block) {
  const spans = Array.isArray(block?.lineSpans) ? block.lineSpans : [];
  if (spans.length > 0) {
    return spans
      .map((span) => ({
        startLine: Math.max(0, Number(span?.startLine) || 0),
        endLine: Math.max(0, Number(span?.endLine) || 0)
      }))
      .sort((left, right) => left.startLine - right.startLine);
  }

  return [
    {
      startLine: Math.max(0, Number(block?.startLine) || 0),
      endLine: Math.max(0, Number(block?.endLine) || 0)
    }
  ];
}

function getDocumentationFragmentLineEntries(fragment) {
  const safeStartLine = Math.max(0, Number(fragment?.startLine) || 0);
  const rawEntries =
    Array.isArray(fragment?.lineEntries) && fragment.lineEntries.length > 0
      ? fragment.lineEntries
      : String(fragment?.markdown || "")
          .split(/\r?\n/)
          .map((text, index) => ({
            text,
            sourceLine: safeStartLine + index
          }));

  return rawEntries
    .map((entry) => {
      const text = String(entry?.text || "");
      const headingLevel = Math.max(0, Number(entry?.headingLevel) || getMarkdownHeadingLevel(text));
      return {
        text,
        sourceLine: Math.max(0, Number(entry?.sourceLine) || safeStartLine),
        isHeading: headingLevel > 0 || Boolean(entry?.isHeading),
        headingLevel,
        nestingLevel: Math.max(0, Number(entry?.nestingLevel) || 0)
      };
    })
    .sort((left, right) => left.sourceLine - right.sourceLine);
}

function getContiguousDocumentationFragmentGroups(fragments) {
  const sorted = (Array.isArray(fragments) ? fragments : [])
    .map((fragment) => ({
      ...fragment,
      startLine: Math.max(0, Number(fragment?.startLine) || 0),
      endLine: Math.max(0, Number(fragment?.endLine) || 0)
    }))
    .sort((left, right) => left.startLine - right.startLine);

  const groups = [];
  let currentGroup = [];

  for (const fragment of sorted) {
    const previous = currentGroup[currentGroup.length - 1];
    if (!previous || fragment.startLine <= previous.endLine + 1) {
      currentGroup.push(fragment);
      continue;
    }
    groups.push(currentGroup);
    currentGroup = [fragment];
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function isMarkdownListItemLine(line) {
  return /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/.test(String(line || ""));
}

function getDocumentationFoldingCandidates(block) {
  const fragments = (Array.isArray(block?.fragments) ? block.fragments : [])
    .map((fragment) => ({
      ...fragment,
      startLine: Math.max(0, Number(fragment?.startLine) || 0)
    }))
    .sort((left, right) => left.startLine - right.startLine);

  const candidates = [];

  for (const fragment of fragments) {
    const sourceKind = String(fragment?.sourceKind || "");
    const entries = getDocumentationFragmentLineEntries(fragment);
    const hasHeading = entries.some((entry) => entry.headingLevel > 0);
    let fragmentFallbackAdded = false;

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      if (entry.text.trim().length === 0) {
        continue;
      }

      const markerDepth = Math.max(0, Number(entry.nestingLevel) || 0);
      if (entry.headingLevel > 0) {
        candidates.push({
          kind: "heading",
          sourceKind,
          startLine: entry.sourceLine,
          markerDepth,
          headingLevel: entry.headingLevel
        });
        continue;
      }

      if (sourceKind === "documentation") {
        if (hasHeading || fragmentFallbackAdded) {
          continue;
        }
        candidates.push({
          kind: "plain",
          sourceKind,
          startLine: entry.sourceLine,
          markerDepth: 0,
          headingLevel: 0
        });
        fragmentFallbackAdded = true;
        continue;
      }

      const looksStructural = isMarkdownListItemLine(entry.text);
      if (!looksStructural && (hasHeading || fragmentFallbackAdded)) {
        continue;
      }
      candidates.push({
        kind: "plain",
        sourceKind,
        startLine: entry.sourceLine,
        markerDepth,
        headingLevel: 0
      });
      if (!looksStructural) {
        fragmentFallbackAdded = true;
      }
    }
  }

  const ownerEndLine = Math.max(
    0,
    Number(block?.ownerEndLine) || 0,
    Number(block?.endLine) || 0
  );
  const sortedCandidates = candidates.sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    if (left.markerDepth !== right.markerDepth) {
      return left.markerDepth - right.markerDepth;
    }
    if (left.kind !== right.kind) {
      return left.kind === "heading" ? -1 : 1;
    }
    return left.headingLevel - right.headingLevel;
  });

  return sortedCandidates.map((candidate, index) => {
    let endLine = ownerEndLine;
    for (let nextIndex = index + 1; nextIndex < sortedCandidates.length; nextIndex += 1) {
      const nextCandidate = sortedCandidates[nextIndex];
      if (candidate.kind === "heading") {
        const closesHeadingTier =
          nextCandidate.kind === "heading" &&
          nextCandidate.markerDepth === candidate.markerDepth;
        const isShallowerHeading =
          nextCandidate.kind === "heading" &&
          nextCandidate.markerDepth < candidate.markerDepth;
        if (closesHeadingTier || isShallowerHeading) {
          endLine = nextCandidate.startLine - 1;
          break;
        }
        continue;
      }

      if (nextCandidate.markerDepth <= candidate.markerDepth) {
        endLine = nextCandidate.startLine - 1;
        break;
      }
    }

    return {
      ...candidate,
      endLine
    };
  });
}

function pushDocumentationFoldingRange(ranges, seenKeys, startLine, endLine) {
  const safeStartLine = Math.max(0, Number(startLine) || 0);
  const safeEndLine = Math.max(0, Number(endLine) || 0);
  if (safeEndLine <= safeStartLine) {
    return;
  }

  const key = `${safeStartLine}:${safeEndLine}`;
  if (seenKeys.has(key)) {
    return;
  }

  seenKeys.add(key);
  ranges.push({
    startLine: safeStartLine,
    endLine: safeEndLine
  });
}

function normalizeDocumentationFoldingCandidates(candidates) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      startLine: Math.max(0, Number(candidate?.startLine) || 0),
      endLine: Math.max(0, Number(candidate?.endLine) || 0)
    }))
    .sort((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return right.endLine - left.endLine;
    });
  const maxEndLine = normalized.reduce((maximumEnd, candidate) => Math.max(maximumEnd, candidate.endLine), 0);

  let changed = true;
  while (changed) {
    changed = false;

    for (let index = 0; index < normalized.length; index += 1) {
      const current = normalized[index];
      let nearestParent = null;

      for (let parentIndex = 0; parentIndex < normalized.length; parentIndex += 1) {
        if (parentIndex === index) {
          continue;
        }
        const candidateParent = normalized[parentIndex];
        if (candidateParent.startLine >= current.startLine || candidateParent.endLine < current.endLine) {
          continue;
        }
        if (!nearestParent) {
          nearestParent = candidateParent;
          continue;
        }
        const candidateSpan = candidateParent.endLine - candidateParent.startLine;
        const nearestSpan = nearestParent.endLine - nearestParent.startLine;
        if (candidateSpan < nearestSpan) {
          nearestParent = candidateParent;
        }
      }

      if (!nearestParent || nearestParent.endLine !== current.endLine) {
        continue;
      }

      const isOwnerEndPlainUnderHeading =
        current.endLine === maxEndLine &&
        current.kind === "plain" &&
        nearestParent.kind === "heading";
      if (isOwnerEndPlainUnderHeading) {
        continue;
      }

      const adjustedEnd = current.endLine - 1;
      if (adjustedEnd <= current.startLine) {
        continue;
      }

      current.endLine = adjustedEnd;
      changed = true;
    }
  }

  return normalized.filter((candidate) => !candidate.skip);
}

function buildDocumentationFoldingTrace(blocks) {
  const ranges = [];
  const seenKeys = new Set();
  const blockTraces = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const rawCandidates = getDocumentationFoldingCandidates(block);
    const normalizedCandidates = normalizeDocumentationFoldingCandidates(rawCandidates);

    for (const candidate of normalizedCandidates) {
      pushDocumentationFoldingRange(ranges, seenKeys, candidate.startLine, candidate.endLine);
    }

    blockTraces.push({
      ownerName: String(block?.ownerName || ""),
      ownerId: String(block?.ownerId || ""),
      ownerStartLine: Math.max(0, Number(block?.ownerStartLine) || 0),
      ownerEndLine: Math.max(0, Number(block?.ownerEndLine) || 0),
      fragments: (Array.isArray(block?.fragments) ? block.fragments : []).map((fragment) => ({
        sourceKind: String(fragment?.sourceKind || ""),
        startLine: Math.max(0, Number(fragment?.startLine) || 0),
        endLine: Math.max(0, Number(fragment?.endLine) || 0),
        lineEntries: getDocumentationFragmentLineEntries(fragment).map((entry) => ({
          sourceLine: entry.sourceLine,
          headingLevel: entry.headingLevel,
          nestingLevel: entry.nestingLevel,
          text: entry.text
        }))
      })),
      rawCandidates: rawCandidates.map((candidate) => ({
        kind: candidate.kind,
        sourceKind: candidate.sourceKind,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        markerDepth: candidate.markerDepth,
        headingLevel: candidate.headingLevel
      })),
      normalizedCandidates: normalizedCandidates.map((candidate) => ({
        kind: candidate.kind,
        sourceKind: candidate.sourceKind,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        markerDepth: candidate.markerDepth,
        headingLevel: candidate.headingLevel
      }))
    });
  }

  return {
    ranges: ranges.sort((left, right) => {
      if (left.startLine !== right.startLine) {
        return left.startLine - right.startLine;
      }
      return left.endLine - right.endLine;
    }),
    blocks: blockTraces
  };
}

function buildDocumentationFoldingRanges(blocks) {
  return buildDocumentationFoldingTrace(blocks).ranges;
}

function getContainingBlockSpan(block, line) {
  const safeLine = Math.max(0, Number(line) || 0);
  for (const span of getBlockLineSpans(block)) {
    if (safeLine >= span.startLine && safeLine <= span.endLine) {
      return span;
    }
  }
  return undefined;
}

function getDistanceToBlock(block, line) {
  const safeLine = Math.max(0, Number(line) || 0);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const span of getBlockLineSpans(block)) {
    if (safeLine >= span.startLine && safeLine <= span.endLine) {
      return 0;
    }
    const distance = safeLine < span.startLine ? span.startLine - safeLine : safeLine - span.endLine;
    if (distance < bestDistance) {
      bestDistance = distance;
    }
  }
  return bestDistance;
}

function findNearestBlock(blocks, line) {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  const containing = blocks.find((block) => getContainingBlockSpan(block, line));
  if (containing) {
    return containing;
  }

  let nearest = blocks[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    const distance = getDistanceToBlock(block, line);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = block;
    }
  }

  return nearest;
}

function getSelectedBlock(state) {
  if (!state.blocks || state.blocks.length === 0) {
    return undefined;
  }

  if (state.selectedBlockId) {
    const selected = state.blocks.find((block) => block.id === state.selectedBlockId);
    if (selected) {
      return selected;
    }
  }

  return state.blocks[0];
}

function createEmptyPreviewState(infoMessage = "") {
  return {
    documentUri: "",
    fileName: "",
    selectedBlockId: undefined,
    blocks: [],
    infoMessage
  };
}

function createEmptyReturnPreviewState(infoMessage = "") {
  return {
    contextKind: "",
    documentUri: "",
    fileName: "",
    ownerName: "",
    variableToken: "",
    keywordName: "",
    returnAnnotation: "",
    currentValue: "",
    currentValueSource: "",
    currentValueSourceLabel: "",
    currentValueSourceLine: undefined,
    sourceUri: "",
    sourceLine: undefined,
    sourceFilePath: "",
    sourceFunctionName: "",
    detailsMarkdown: "",
    infoMessage
  };
}

function createReturnLoadingPreviewState(fileName, variableContext) {
  return {
    contextKind: "return",
    documentUri: "",
    fileName: String(fileName || ""),
    ownerName: String(variableContext?.owner?.name || ""),
    variableToken: String(variableContext?.variableToken?.token || ""),
    keywordName: String(variableContext?.assignment?.keywordName || ""),
    returnAnnotation: "",
    currentValue: "",
    currentValueSource: "",
    currentValueSourceLabel: "",
    currentValueSourceLine: undefined,
    sourceUri: "",
    sourceLine: undefined,
    sourceFilePath: "",
    sourceFunctionName: "",
    detailsMarkdown: "### What You Can Access\n\n_Loading return details..._",
    infoMessage: ""
  };
}

function buildOwnerScopes(lines) {
  const owners = [];
  const ownerByLine = new Array(lines.length).fill(undefined);
  let currentSection = null;
  let currentOwner = undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (isSectionHeader(trimmed)) {
      currentSection = getRelevantSection(trimmed);
      currentOwner = undefined;
      continue;
    }

    if (!currentSection) {
      currentOwner = undefined;
      continue;
    }

    const ownerCandidate = getOwnerName(line);
    if (ownerCandidate) {
      currentOwner = {
        id: `${lineIndex}:${ownerCandidate}`,
        name: ownerCandidate,
        section: currentSection,
        startLine: lineIndex,
        endLine: lineIndex
      };
      owners.push(currentOwner);
    }

    if (currentOwner) {
      currentOwner.endLine = lineIndex;
      ownerByLine[lineIndex] = currentOwner;
    }
  }

  return {
    owners,
    ownerByLine
  };
}

function cloneBranchPath(branchPath) {
  return (Array.isArray(branchPath) ? branchPath : []).map((frame) => ({
    groupId: String(frame?.groupId || ""),
    branchId: String(frame?.branchId || "")
  }));
}

function parseConditionalBranchMarker(line) {
  const cells = splitRobotCellsWithRanges(String(line || ""));
  if (cells.length === 0) {
    return undefined;
  }

  let cursor = 0;
  while (cursor < cells.length && String(cells[cursor]?.text || "").trim() === "...") {
    cursor += 1;
  }

  const keyword = String(cells[cursor]?.text || "")
    .trim()
    .toUpperCase();
  if (keyword === "IF") {
    return { kind: "if" };
  }
  if (keyword === "FOR") {
    return { kind: "for" };
  }
  if (keyword === "WHILE") {
    return { kind: "while" };
  }
  if (keyword === "TRY") {
    return { kind: "try" };
  }
  if (keyword === "ELSE IF") {
    return { kind: "else-if" };
  }
  if (keyword === "ELSE") {
    return { kind: "else" };
  }
  if (keyword === "END") {
    return { kind: "end" };
  }
  return undefined;
}

function buildConditionalBranchPathByLine(lines, ownerByLine) {
  const branchPathByLine = Array.from({ length: lines.length }, () => []);
  const ownerStates = new Map();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const owner = ownerByLine[lineIndex];
    if (!owner?.id) {
      continue;
    }

    let ownerState = ownerStates.get(owner.id);
    if (!ownerState) {
      ownerState = {
        branchStack: [],
        controlStack: [],
        groupSequence: 0,
        branchSequence: 0
      };
      ownerStates.set(owner.id, ownerState);
    }

    branchPathByLine[lineIndex] = cloneBranchPath(
      ownerState.branchStack.map((frame) => ({
        groupId: frame.groupId,
        branchId: frame.branchId
      }))
    );

    const marker = parseConditionalBranchMarker(lines[lineIndex]);
    if (!marker) {
      continue;
    }

    if (marker.kind === "if") {
      ownerState.groupSequence += 1;
      ownerState.branchSequence += 1;
      const groupId = `${owner.id}:if:${ownerState.groupSequence}`;
      ownerState.controlStack.push({
        kind: "if",
        groupId
      });
      ownerState.branchStack.push({
        groupId,
        branchId: `${groupId}:branch:${ownerState.branchSequence}`
      });
      continue;
    }

    if (marker.kind === "for" || marker.kind === "while" || marker.kind === "try") {
      ownerState.controlStack.push({
        kind: marker.kind,
        groupId: ""
      });
      continue;
    }

    if (marker.kind === "else-if" || marker.kind === "else") {
      const currentControl = ownerState.controlStack[ownerState.controlStack.length - 1];
      if (!currentControl || currentControl.kind !== "if") {
        continue;
      }
      const currentFrame = ownerState.branchStack[ownerState.branchStack.length - 1];
      if (!currentFrame || currentFrame.groupId !== currentControl.groupId) {
        continue;
      }
      ownerState.branchSequence += 1;
      currentFrame.branchId = `${currentFrame.groupId}:branch:${ownerState.branchSequence}`;
      continue;
    }

    if (marker.kind === "end") {
      const endedControl = ownerState.controlStack.pop();
      if (endedControl?.kind === "if") {
        ownerState.branchStack.pop();
      }
    }
  }

  return branchPathByLine;
}

function parseVariableAssignments(lines, ownerByLine, branchPathByLine = []) {
  const assignments = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const owner = ownerByLine[lineIndex];
    if (!owner) {
      continue;
    }

    const assignment = parseLocalVariableAssignment(lines, lineIndex);
    if (!assignment) {
      continue;
    }

    assignments.push({
      ...assignment,
      ownerId: owner.id,
      ownerName: owner.name,
      section: owner.section,
      branchPath: cloneBranchPath(branchPathByLine[lineIndex]),
      branchGroupId: String(branchPathByLine[lineIndex]?.[branchPathByLine[lineIndex].length - 1]?.groupId || ""),
      branchId: String(branchPathByLine[lineIndex]?.[branchPathByLine[lineIndex].length - 1]?.branchId || "")
    });
  }

  return assignments;
}

function parseKeywordCallAssignments(lines, ownerByLine, branchPathByLine = []) {
  const assignments = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const owner = ownerByLine[lineIndex];
    if (!owner) {
      continue;
    }

    const assignment = parseKeywordCallAssignment(lines, lineIndex);
    if (!assignment) {
      continue;
    }

    assignments.push({
      ...assignment,
      ownerId: owner.id,
      ownerName: owner.name,
      section: owner.section,
      branchPath: cloneBranchPath(branchPathByLine[lineIndex]),
      branchGroupId: String(branchPathByLine[lineIndex]?.[branchPathByLine[lineIndex].length - 1]?.groupId || ""),
      branchId: String(branchPathByLine[lineIndex]?.[branchPathByLine[lineIndex].length - 1]?.branchId || "")
    });

    lineIndex = assignment.endLine;
  }

  return assignments;
}

function parseKeywordCallAssignment(lines, lineIndex) {
  const line = String(lines[lineIndex] || "");
  const cells = splitRobotCellsWithRanges(line);
  if (cells.length === 0) {
    return null;
  }

  let cursor = 0;
  while (cursor < cells.length && cells[cursor].text.trim() === "...") {
    cursor += 1;
  }

  const returnVariables = [];
  while (cursor < cells.length) {
    const token = cells[cursor].text.trim();
    const variableWithEqualsMatch = token.match(/^([@$&%]\{[^}\r\n]+\})\s*=$/);
    if (variableWithEqualsMatch) {
      returnVariables.push(variableWithEqualsMatch[1]);
      cursor += 1;
      break;
    }

    if (/^[@$&%]\{[^}\r\n]+\}$/.test(token)) {
      returnVariables.push(token);
      cursor += 1;
      continue;
    }

    if (token === "=") {
      cursor += 1;
      break;
    }

    return null;
  }

  if (returnVariables.length === 0) {
    return null;
  }

  while (cursor < cells.length && cells[cursor].text.trim() === "=") {
    cursor += 1;
  }

  const keywordName = cells[cursor]?.text.trim() || "";
  if (!keywordName) {
    return null;
  }
  if (keywordName.startsWith("[") || ROBOT_CONTROL_CELLS.has(keywordName.toLowerCase())) {
    return null;
  }

  let endLine = lineIndex;
  for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
    const continuation = parseContinuationLine(lines[nextLine]);
    if (!continuation.isContinuation) {
      break;
    }
    endLine = nextLine;
  }

  return {
    id: `${lineIndex}:${returnVariables.join("|")}`,
    keywordName,
    returnVariables,
    normalizedReturnVariables: returnVariables.map((variable) => normalizeVariableLookupToken(variable)),
    startLine: lineIndex,
    endLine,
    range: new vscode.Range(lineIndex, 0, endLine, lines[endLine] ? lines[endLine].length : 0)
  };
}

function parseSetVariableAssignment(lines, lineIndex) {
  const line = String(lines[lineIndex] || "");
  const trimmed = line.trimStart();
  const lhsMatch = trimmed.match(/^([@$&%]\{[^}\r\n]+\})\s*=\s*(.+)$/);
  if (!lhsMatch) {
    return null;
  }

  const variableToken = lhsMatch[1];
  const rightSide = lhsMatch[2].trimStart();
  const setVariableMatch = rightSide.match(/^Set Variable(?:(?:\s{2,}|\t+)(.*))?$/i);
  if (!setVariableMatch) {
    return null;
  }

  const valueLines = [];
  if (typeof setVariableMatch[1] === "string") {
    valueLines.push(stripInlineRobotComment(setVariableMatch[1]));
  }

  let endLine = lineIndex;
  for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
    const continuation = parseContinuationLine(lines[nextLine]);
    if (!continuation.isContinuation) {
      break;
    }
    valueLines.push(stripInlineRobotComment(continuation.text));
    endLine = nextLine;
  }

  return {
    id: `${lineIndex}:${variableToken}`,
    variableToken,
    normalizedVariable: normalizeVariableLookupToken(variableToken),
    valueRaw: valueLines.join("\n"),
    sourceLabel: "Set Variable",
    startLine: lineIndex,
    endLine,
    range: new vscode.Range(lineIndex, 0, endLine, lines[endLine] ? lines[endLine].length : 0)
  };
}

function parseVarAssignment(lines, lineIndex) {
  const line = String(lines[lineIndex] || "");
  const trimmed = line.trimStart();
  if (!/^VAR(?:\s{2,}|\t+)/.test(trimmed)) {
    return null;
  }

  const cells = trimmed.split(/\s{2,}|\t+/);
  if (cells.length < 2) {
    return null;
  }

  let cursor = 1;
  let variableToken = "";
  const variableCell = String(cells[cursor] || "").trim();
  const variableWithEqualsMatch = variableCell.match(/^([@$&%]\{[^}\r\n]+\})\s*=$/);
  if (variableWithEqualsMatch) {
    variableToken = variableWithEqualsMatch[1];
    cursor += 1;
  } else if (/^[@$&%]\{[^}\r\n]+\}$/.test(variableCell)) {
    variableToken = variableCell;
    cursor += 1;
    while (cursor < cells.length && String(cells[cursor] || "").trim() === "=") {
      cursor += 1;
    }
  } else {
    return null;
  }

  const valueCells = [];
  while (cursor < cells.length) {
    const cell = String(cells[cursor] || "");
    const trimmedCell = cell.trim();
    cursor += 1;
    if (!trimmedCell) {
      continue;
    }
    if (trimmedCell.startsWith("#")) {
      break;
    }
    if (/^scope=/i.test(trimmedCell)) {
      continue;
    }
    valueCells.push(stripInlineRobotComment(cell));
  }

  const valueLines = [];
  if (valueCells.length > 0) {
    valueLines.push(valueCells.join("    "));
  }

  let endLine = lineIndex;
  for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
    const continuation = parseContinuationLine(lines[nextLine]);
    if (!continuation.isContinuation) {
      break;
    }
    const continuationText = stripInlineRobotComment(continuation.text);
    if (!/^scope=/i.test(continuationText.trim())) {
      valueLines.push(continuationText);
    }
    endLine = nextLine;
  }

  return {
    id: `${lineIndex}:${variableToken}`,
    variableToken,
    normalizedVariable: normalizeVariableLookupToken(variableToken),
    valueRaw: valueLines.join("\n"),
    sourceLabel: "VAR",
    startLine: lineIndex,
    endLine,
    range: new vscode.Range(lineIndex, 0, endLine, lines[endLine] ? lines[endLine].length : 0)
  };
}

function parseLocalVariableAssignment(lines, lineIndex) {
  return parseVarAssignment(lines, lineIndex) || parseSetVariableAssignment(lines, lineIndex);
}

function buildLocalVariableConditionalCandidates(selection) {
  return (selection?.candidates || []).map((candidate) => {
    const assignment = candidate?.assignment;
    if (String(assignment?.assignmentKind || "") === "keyword-return") {
      return {
        value: `Return from ${String(assignment?.keywordName || "").trim() || "keyword"}`,
        source: "keyword-return-variable",
        sourceLabel: "Keyword return",
        sourceLine: Number.isFinite(Number(assignment?.startLine)) ? Number(assignment.startLine) : undefined,
        assignment
      };
    }
    const value = extractCurrentValueFromSetVariableAssignment(assignment?.valueRaw);
    return {
      value,
      source: "local-variable",
      sourceLabel: getLocalVariableAssignmentSourceLabel(assignment),
      sourceLine: Number.isFinite(Number(assignment?.startLine)) ? Number(assignment.startLine) : undefined,
      assignment
    };
  });
}

function buildLocalVariableCurrentValueResultFromSelection(selection, fallbackValue = "") {
  if (!selection) {
    return {
      kind: "fallback",
      value: String(fallbackValue || ""),
      source: "argument",
      sourceLine: undefined,
      sourceLabel: "",
      candidates: []
    };
  }

  if (selection.kind === "single" && selection.assignment) {
    if (String(selection.assignment?.assignmentKind || "") === "keyword-return") {
      return {
        kind: "fallback",
        value: String(fallbackValue || ""),
        source: "argument",
        sourceLine: undefined,
        sourceLabel: "",
        candidates: []
      };
    }
    return {
      kind: "single",
      value: extractCurrentValueFromSetVariableAssignment(selection.assignment.valueRaw),
      source: "local-variable",
      sourceLabel: getLocalVariableAssignmentSourceLabel(selection.assignment),
      sourceLine: selection.assignment.startLine,
      assignment: selection.assignment,
      candidates: []
    };
  }

  if (selection.kind === "conditional") {
    return {
      kind: "conditional",
      value: "",
      source: "local-variable-conditional",
      sourceLine: undefined,
      sourceLabel: "",
      candidates: buildLocalVariableConditionalCandidates(selection)
    };
  }

  return {
    kind: "fallback",
    value: String(fallbackValue || ""),
    source: "argument",
    sourceLine: undefined,
    sourceLabel: "",
    candidates: []
  };
}

function createVariableValueHover(document, parsed, position, runtimeCacheService) {
  if (!parsed || !Array.isArray(parsed.owners) || !Array.isArray(parsed.variableAssignments)) {
    return undefined;
  }

  const line = document.lineAt(position.line).text;
  const variableToken = getVariableTokenAtPosition(line, position.character);
  if (!variableToken) {
    return undefined;
  }

  const owner = findOwnerForLine(parsed.owners, position.line);
  if (!owner) {
    return undefined;
  }

  const normalizedVariable = normalizeVariableLookupToken(variableToken.token);
  const runtimeLookups = runtimeCacheService?.getLookupState(document, parsed);
  const selectedResolution = resolveVariableAssignmentSelection(
    parsed,
    runtimeLookups,
    owner.id,
    normalizedVariable,
    position.line
  );
  if (!selectedResolution) {
    return undefined;
  }
  const currentValueResolution = buildLocalVariableCurrentValueResultFromSelection(
    selectedResolution,
    variableToken.token
  );
  if (currentValueResolution.kind === "fallback") {
    return undefined;
  }

  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: [CMD_OPEN_LOCATION]
  };
  markdown.supportHtml = false;
  markdown.appendMarkdown("### Robot Variable Value\n\n");
  markdown.appendMarkdown("**Variable:** ");
  markdown.appendText(variableToken.token);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Owner:** ");
  markdown.appendText(owner.name);
  markdown.appendMarkdown("\n\n");

  if (currentValueResolution.kind === "conditional") {
    markdown.appendMarkdown("**Current value (conditional):**\n");
    for (const candidate of currentValueResolution.candidates || []) {
      const sourceLineNumber =
        Number.isFinite(Number(candidate.sourceLine)) && Number(candidate.sourceLine) >= 0
          ? Number(candidate.sourceLine) + 1
          : undefined;
      const displayValue = String(candidate.value || "").length > 0 ? String(candidate.value) : "(empty)";
      markdown.appendMarkdown(`- \`${escapeMarkdownInline(displayValue)}\``);
      if (sourceLineNumber) {
        markdown.appendMarkdown(
          ` from \`${escapeMarkdownInline(candidate.sourceLabel)}\` line ${sourceLineNumber}`
        );
        const sourceCommand = buildOpenLocationCommandUri(document.uri.toString(), Number(candidate.sourceLine));
        if (sourceCommand) {
          markdown.appendMarkdown(
            `  \n  [Jump to ${escapeMarkdownInline(candidate.sourceLabel)} line ${sourceLineNumber}](${sourceCommand})`
          );
        }
      }
      markdown.appendMarkdown("\n");
    }
  } else {
    const selectedAssignment = currentValueResolution.assignment;
    const valueLines =
      selectedAssignment?.valueRaw?.length > 0 ? selectedAssignment.valueRaw.split(/\r?\n/) : [];
    const lineLimit = getVariableHoverLineLimit();
    const isTruncated = lineLimit > 0 && valueLines.length > lineLimit;
    const shownLines = isTruncated ? valueLines.slice(0, lineLimit) : valueLines;
    const currentValueSummary = shownLines.length > 0 ? shownLines[0] : "";
    const assignmentSourceLabel = getLocalVariableAssignmentSourceLabel(currentValueResolution);

    if (currentValueSummary.length > 0) {
      markdown.appendMarkdown("**Current value (resolved):**  \n");
      markdown.appendMarkdown(`🟢 \`${escapeMarkdownInline(currentValueSummary)}\`\n\n`);
    } else {
      markdown.appendMarkdown("**Current value (resolved):**  \n");
      markdown.appendMarkdown("🟢 `(empty)`\n\n");
    }
    markdown.appendMarkdown(`**Source:** \`${escapeMarkdownInline(assignmentSourceLabel)}\` at line ${selectedAssignment.startLine + 1}  \n`);
    const sourceCommand = buildOpenLocationCommandUri(document.uri.toString(), selectedAssignment.startLine);
    if (sourceCommand) {
      markdown.appendMarkdown(
        `[Jump to ${escapeMarkdownInline(assignmentSourceLabel)} line ${selectedAssignment.startLine + 1}](${sourceCommand})\n\n`
      );
    } else {
      markdown.appendMarkdown("\n");
    }

    if (shownLines.length === 0) {
      markdown.appendMarkdown("_Assigned empty value._");
    } else if (shownLines.length > 1) {
      markdown.appendMarkdown("**Assigned value (full):**\n");
      markdown.appendCodeblock(shownLines.join("\n"), "robotframework");
    }

    if (isTruncated) {
      markdown.appendMarkdown(
        `\n\n_Showing first ${lineLimit} of ${valueLines.length} value lines in hover._`
      );
    }
  }

  const range = new vscode.Range(position.line, variableToken.start, position.line, variableToken.end);
  return new vscode.Hover(markdown, range);
}

async function createKeywordReturnHover(
  document,
  parsed,
  position,
  enumHintService,
  runtimeCacheService,
  options = {}
) {
  if (isHoverCancellationRequested(options.cancellationToken)) {
    return undefined;
  }
  const context = await resolveKeywordReturnPreview(document, parsed, position, enumHintService, {
    maxDepth: getReturnHoverMaxDepth(),
    maxFieldsPerType: getReturnMaxFieldsPerType(),
    includeTechnical: false,
    runtimeCache: runtimeCacheService,
    cacheOnly: options.cacheOnly === true,
    cancellationToken: options.cancellationToken,
    returnComputeWorker: options.returnComputeWorker
  });
  if (isHoverCancellationRequested(options.cancellationToken)) {
    return undefined;
  }
  if (!context) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = false;
  markdown.appendMarkdown("### Robot Return Hint\n\n");
  markdown.appendMarkdown("**Variable:** ");
  markdown.appendText(context.variableToken.token);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Owner:** ");
  markdown.appendText(context.owner.name);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Keyword:** ");
  markdown.appendText(context.assignment.keywordName);
  markdown.appendMarkdown("\n\n");

  if (context.returnAnnotation) {
    markdown.appendMarkdown("**Return annotation:**\n");
    markdown.appendCodeblock(context.returnAnnotation, "python");
    markdown.appendMarkdown("\n");
  } else {
    markdown.appendMarkdown("_No return annotation found for this keyword in indexed Python sources._\n\n");
  }

  if (context.simpleAccess.firstLevel.length > 0) {
    markdown.appendMarkdown("**First-level access:**\n");
    markdown.appendCodeblock(context.simpleAccess.firstLevel.join("\n"), "robotframework");
    if (context.simpleAccess.secondLevel.length > 0) {
      markdown.appendMarkdown("\n**Second-level access:**\n");
      markdown.appendCodeblock(context.simpleAccess.secondLevel.join("\n"), "robotframework");
    }
    markdown.appendMarkdown("\n\n_Open **Robot Return Explorer** for full technical details._");
  } else if (context.returnAnnotation) {
    markdown.appendMarkdown("_No indexed structured return type resolved from annotation._");
  }

  const range = new vscode.Range(
    position.line,
    context.variableToken.start,
    position.line,
    context.variableToken.end
  );
  return new vscode.Hover(markdown, range);
}

async function resolveKeywordReturnPreview(document, parsed, position, enumHintService, options = {}) {
  if (!parsed || !enumHintService) {
    return undefined;
  }
  const cancellationToken = options.cancellationToken;
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const runtimeCacheService = options.runtimeCache;
  const runtimeState = runtimeCacheService?.ensureState(document, parsed);
  const variableContext = getKeywordReturnVariableContextAtPosition(
    document,
    parsed,
    position,
    runtimeState?.lookups
  );
  if (!variableContext) {
    return undefined;
  }
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const includeTechnical = options.includeTechnical !== false;
  const cacheKey = buildReturnContextCacheKey(
    variableContext,
    options.maxDepth,
    options.maxFieldsPerType,
    includeTechnical
  );
  if (runtimeState && runtimeCacheService) {
    if (options.cacheOnly === true) {
      return runtimeCacheService.getCachedValue(runtimeState, "returnPreview", cacheKey, {
        allowPending: false
      });
    }
    const resolved = await runtimeCacheService.getOrCompute(
      runtimeState,
      "returnPreview",
      cacheKey,
      () =>
        resolveKeywordReturnPreviewFromVariableContext(document, parsed, variableContext, enumHintService, options),
      { referenceLine: variableContext.assignment.startLine }
    );
    if (isHoverCancellationRequested(cancellationToken)) {
      return undefined;
    }
    return resolved;
  }

  const resolved = await resolveKeywordReturnPreviewFromVariableContext(
    document,
    parsed,
    variableContext,
    enumHintService,
    options
  );
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  return resolved;
}

async function resolveKeywordReturnPreviewFromVariableContext(
  document,
  parsed,
  variableContext,
  enumHintService,
  options = {}
) {
  const cancellationToken = options.cancellationToken;
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  const includeTechnical = options.includeTechnical !== false;
  const index = options.precomputedIndex || (await enumHintService.getIndexForDocument(document));
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(variableContext.assignment.keywordName);
  const returnDefinition = getKeywordReturnDefinition(index, normalizedKeyword);
  const returnAnnotation = String(
    returnDefinition?.returnAnnotation || index.keywordReturns?.get(normalizedKeyword) || ""
  ).trim();
  const returnResolutionContext = buildTypeResolutionContextFromReturnDefinition(index, returnDefinition);
  const subtypePolicy = getReturnSubtypeResolutionPolicy(index);
  const returnTypeResolution = resolveIndexedTypesFromAnnotation(returnAnnotation, index, {
    policy: subtypePolicy,
    resolutionContext: returnResolutionContext
  });
  const rootTypeNames = returnTypeResolution.typeNames;
  const maxDepth = Math.max(1, Number(options.maxDepth) || 1);
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(options.maxFieldsPerType, 0);
  const technicalMaxDepth = getReturnTechnicalMaxDepth();
  const technicalMaxFieldsPerType = getReturnTechnicalMaxFieldsPerType();
  let simpleAccess = undefined;
  let technicalStructureLines = undefined;
  const returnComputeWorker = options.returnComputeWorker;
  if (returnComputeWorker && rootTypeNames.length > 0) {
    const workerResult = await returnComputeWorker.computeReturnPreview(document, index, {
      variableToken: variableContext.variableToken.token,
      rootTypeNames,
      rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
      typePreferencesByName: serializeTypePreferenceMapEntries(returnTypeResolution.typePreferencesByName),
      fieldNameStyle: getReturnFieldNameStyle(),
      includeProperties: getReturnIncludeProperties(),
      maxDepth,
      maxFieldsPerType,
      includeTechnical,
      technicalMaxDepth,
      technicalMaxFieldsPerType,
      subtypePolicy: serializeSubtypePolicy(subtypePolicy)
    });
    if (isHoverCancellationRequested(cancellationToken)) {
      return undefined;
    }
    if (workerResult) {
      simpleAccess = workerResult.simpleAccess;
      technicalStructureLines = includeTechnical
        ? Array.isArray(workerResult.technicalStructureLines)
          ? workerResult.technicalStructureLines
          : []
        : [];
    }
  }

  if (!simpleAccess) {
    simpleAccess = buildSimpleReturnAccessPaths(variableContext.variableToken.token, rootTypeNames, index, {
      rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
      subtypePolicy,
      typePreferencesByName: returnTypeResolution.typePreferencesByName,
      resolutionContext: returnResolutionContext,
      maxDepth,
      maxFieldsPerType,
      includeProperties: getReturnIncludeProperties()
    });
  }

  if (!technicalStructureLines) {
    technicalStructureLines = includeTechnical
      ? buildReturnStructureLines(
          rootTypeNames,
          index,
          {
            maxDepth: technicalMaxDepth,
            maxFieldsPerType: technicalMaxFieldsPerType,
            typePreferencesByName: returnTypeResolution.typePreferencesByName,
            resolutionContext: returnResolutionContext,
            includeProperties: getReturnIncludeProperties()
          },
          "technical"
        )
      : [];
  }

  logReturnResolutionTrace("variable-context", {
    documentUri: document.uri.toString(),
    variableToken: variableContext.variableToken.token,
    keywordName: variableContext.assignment.keywordName,
    normalizedKeyword,
    returnAnnotation,
    sourceFilePath: String(returnDefinition?.sourceFilePath || ""),
    sourceLine: Number.isFinite(Number(returnDefinition?.sourceLine)) ? Number(returnDefinition.sourceLine) : undefined,
    rootTypeNames,
    typePreferencesByName: serializeTypePreferenceMapEntries(returnTypeResolution.typePreferencesByName),
    typeDebug: buildReturnResolutionTypeDebug(index, rootTypeNames, returnTypeResolution.typePreferencesByName),
    includeTechnical,
    simpleAccessCounts: {
      firstLevel: Array.isArray(simpleAccess?.firstLevel) ? simpleAccess.firstLevel.length : 0,
      secondLevel: Array.isArray(simpleAccess?.secondLevel) ? simpleAccess.secondLevel.length : 0
    },
    technicalLineCount: Array.isArray(technicalStructureLines) ? technicalStructureLines.length : 0
  });

  return {
    ...variableContext,
    normalizedKeyword,
    returnAnnotation,
    returnDefinition,
    rootTypeNames,
    simpleAccess,
    technicalStructureLines,
    technicalPending: !includeTechnical && rootTypeNames.length > 0
  };
}

function getKeywordReturnVariableContextAtPosition(document, parsed, position, runtimeLookups) {
  if (!parsed || !Array.isArray(parsed.keywordCallAssignments) || !Array.isArray(parsed.owners)) {
    return undefined;
  }

  const lineText = document.lineAt(position.line).text;
  const variableToken = getVariableTokenAtPosition(lineText, position.character);
  if (!variableToken) {
    return undefined;
  }

  const owner = findOwnerForLine(parsed.owners, position.line);
  if (!owner) {
    return undefined;
  }

  const normalizedVariable = normalizeVariableLookupToken(variableToken.token);
  const selectedAssignment = runtimeLookups
    ? findLatestKeywordCallAssignmentForOwnerFromLookups(runtimeLookups, owner.id, normalizedVariable, position.line)
    : findLatestKeywordCallAssignmentForOwner(parsed, owner.id, normalizedVariable, position.line);

  if (!selectedAssignment) {
    return undefined;
  }

  return {
    owner,
    variableToken,
    assignment: selectedAssignment
  };
}

function getHoveredVariableTokenFromArgumentValueContext(argumentContext, positionOrCharacter) {
  const rawValue = String(argumentContext?.argumentValue || "").trim();
  if (!rawValue) {
    return undefined;
  }

  const valueStart = Math.max(0, Number(argumentContext?.valueStart) || 0);
  const rawCharacter =
    typeof positionOrCharacter === "number"
      ? positionOrCharacter
      : Number(positionOrCharacter?.character);
  let relativeCharacter = undefined;
  if (Number.isFinite(rawCharacter) && rawCharacter >= valueStart) {
    relativeCharacter = Math.max(0, Math.min(Math.max(0, rawValue.length - 1), rawCharacter - valueStart));
  } else if (/^[@$&%]\{[^}\r\n]+\}$/.test(rawValue)) {
    relativeCharacter = 0;
  }

  if (!Number.isFinite(relativeCharacter)) {
    return undefined;
  }

  const variableToken = getVariableTokenAtPosition(rawValue, Number(relativeCharacter));
  if (!variableToken) {
    return undefined;
  }

  return {
    token: variableToken.token,
    start: valueStart + variableToken.start,
    end: valueStart + variableToken.end
  };
}

function resolveNamedArgumentCurrentValueFromSetVariable(argumentContext, parsed, line, runtimeLookups, hoverCharacter) {
  const normalizedContext =
    argumentContext && typeof argumentContext === "object"
      ? argumentContext
      : {
          argumentValue: argumentContext,
          valueStart: 0
        };
  const rawValue = String(normalizedContext?.argumentValue || "").trim();
  const hoveredVariableToken = getHoveredVariableTokenFromArgumentValueContext(normalizedContext, hoverCharacter);
  const lookupToken =
    hoveredVariableToken?.token || (/^[@$&%]\{[^}\r\n]+\}$/.test(rawValue) ? rawValue : "");
  const fallback = {
    kind: "fallback",
    value: hoveredVariableToken?.token || rawValue,
    source: "argument",
    sourceLine: undefined,
    sourceLabel: ""
  };

  if (!lookupToken) {
    return fallback;
  }

  if (!parsed || !Array.isArray(parsed.owners) || !Array.isArray(parsed.variableAssignments)) {
    return fallback;
  }

  const owner = findOwnerForLine(parsed.owners, line);
  if (!owner) {
    return fallback;
  }

  const normalizedVariable = normalizeVariableLookupToken(lookupToken);
  const selectedResolution = resolveVariableAssignmentSelection(parsed, runtimeLookups, owner.id, normalizedVariable, line);
  if (!selectedResolution) {
    return fallback;
  }

  const resolvedResult = buildLocalVariableCurrentValueResultFromSelection(
    selectedResolution,
    hoveredVariableToken?.token || rawValue
  );
  if (resolvedResult.kind === "fallback") {
    return fallback;
  }

  return resolvedResult;
}

function extractCurrentValueFromSetVariableAssignment(valueRaw) {
  const valueLines = String(valueRaw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (valueLines.length === 0) {
    return "";
  }
  return parsePythonLiteral(valueLines[0]);
}

async function resolveReturnHintForArgumentValue(
  document,
  parsed,
  context,
  position,
  enumHintService,
  runtimeCacheService,
  returnComputeWorker,
  cancellationToken
) {
  if (!document || !parsed || !context || !position || !enumHintService) {
    return undefined;
  }
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const rawArgumentValue = String(context.argumentValue || "").trim();
  if (!rawArgumentValue) {
    return undefined;
  }
  const hoveredVariableReference = getHoveredVariableTokenFromArgumentValueContext(context, position);
  const rawVariableToken =
    hoveredVariableReference?.token || (/^[@$&%]\{[^}\r\n]+\}$/.test(rawArgumentValue) ? rawArgumentValue : "");
  if (!rawVariableToken) {
    return undefined;
  }

  if (!Array.isArray(parsed.keywordCallAssignments) || !Array.isArray(parsed.owners)) {
    return undefined;
  }

  const owner = findOwnerForLine(parsed.owners, position.line);
  if (!owner) {
    return undefined;
  }

  const normalizedVariable = normalizeVariableLookupToken(rawVariableToken);
  const runtimeState = runtimeCacheService?.ensureState(document, parsed);
  const runtimeLookups = runtimeState?.lookups;
  const selectedAssignment = runtimeLookups
    ? findLatestKeywordCallAssignmentForOwnerFromLookups(runtimeLookups, owner.id, normalizedVariable, position.line)
    : findLatestKeywordCallAssignmentForOwner(parsed, owner.id, normalizedVariable, position.line);

  if (!selectedAssignment) {
    return undefined;
  }
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const cacheKey = buildReturnHintContextCacheKey(
    owner.id,
    normalizedVariable,
    selectedAssignment.id,
    getReturnHintArgumentMaxDepth()
  );
  if (runtimeState && runtimeCacheService) {
    const resolved = await runtimeCacheService.getOrCompute(
      runtimeState,
      "returnHint",
      cacheKey,
      () =>
        resolveReturnHintForArgumentValueFromAssignment(
          document,
          rawVariableToken,
          context,
          position,
          owner,
          selectedAssignment,
          enumHintService,
          returnComputeWorker,
          cancellationToken,
          hoveredVariableReference
        ),
      { referenceLine: position.line }
    );
    if (isHoverCancellationRequested(cancellationToken)) {
      return undefined;
    }
    return resolved;
  }

  const resolved = await resolveReturnHintForArgumentValueFromAssignment(
    document,
    rawVariableToken,
    context,
    position,
    owner,
    selectedAssignment,
    enumHintService,
    returnComputeWorker,
    cancellationToken,
    hoveredVariableReference
  );
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  return resolved;
}

async function resolveReturnHintForArgumentValueFromAssignment(
  document,
  rawArgumentValue,
  context,
  position,
  owner,
  selectedAssignment,
  enumHintService,
  returnComputeWorker,
  cancellationToken,
  hoveredVariableReference
) {
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  const index = await enumHintService.getIndexForDocument(document);
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(selectedAssignment.keywordName);
  const returnDefinition = getKeywordReturnDefinition(index, normalizedKeyword);
  const returnAnnotation = String(
    returnDefinition?.returnAnnotation || index.keywordReturns?.get(normalizedKeyword) || ""
  ).trim();
  const returnResolutionContext = buildTypeResolutionContextFromReturnDefinition(index, returnDefinition);
  const subtypePolicy = getReturnSubtypeResolutionPolicy(index);
  const returnTypeResolution = resolveIndexedTypesFromAnnotation(returnAnnotation, index, {
    policy: subtypePolicy,
    resolutionContext: returnResolutionContext
  });
  const rootTypeNames = returnTypeResolution.typeNames;
  const maxDepth = getReturnHintArgumentMaxDepth();
  const maxFieldsPerType = getReturnMaxFieldsPerType();
  const technicalMaxDepth = getReturnTechnicalMaxDepth();
  const technicalMaxFieldsPerType = getReturnTechnicalMaxFieldsPerType();
  let simpleAccess = undefined;
  let technicalStructureLines = undefined;

  if (returnComputeWorker && rootTypeNames.length > 0) {
    const workerResult = await returnComputeWorker.computeReturnPreview(document, index, {
      variableToken: rawArgumentValue,
      rootTypeNames,
      rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
      typePreferencesByName: serializeTypePreferenceMapEntries(returnTypeResolution.typePreferencesByName),
      fieldNameStyle: getReturnFieldNameStyle(),
      includeProperties: getReturnIncludeProperties(),
      maxDepth,
      maxFieldsPerType,
      includeTechnical: true,
      technicalMaxDepth,
      technicalMaxFieldsPerType,
      subtypePolicy: serializeSubtypePolicy(subtypePolicy)
    });
    if (isHoverCancellationRequested(cancellationToken)) {
      return undefined;
    }
    if (workerResult) {
      simpleAccess = workerResult.simpleAccess;
      technicalStructureLines = Array.isArray(workerResult.technicalStructureLines)
        ? workerResult.technicalStructureLines
        : [];
    }
  }

  if (!simpleAccess) {
    simpleAccess = buildSimpleReturnAccessPaths(rawArgumentValue, rootTypeNames, index, {
      rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
      subtypePolicy,
      typePreferencesByName: returnTypeResolution.typePreferencesByName,
      resolutionContext: returnResolutionContext,
      maxDepth,
      maxFieldsPerType,
      includeProperties: getReturnIncludeProperties()
    });
  }

  if (!technicalStructureLines) {
    technicalStructureLines = buildReturnStructureLines(
      rootTypeNames,
      index,
      {
        maxDepth: technicalMaxDepth,
        maxFieldsPerType: technicalMaxFieldsPerType,
        typePreferencesByName: returnTypeResolution.typePreferencesByName,
        resolutionContext: returnResolutionContext,
        includeProperties: getReturnIncludeProperties()
      },
      "technical"
    );
  }

  logReturnResolutionTrace("argument-value", {
    documentUri: document.uri.toString(),
    variableToken: rawArgumentValue,
    keywordName: selectedAssignment.keywordName,
    normalizedKeyword,
    returnAnnotation,
    sourceFilePath: String(returnDefinition?.sourceFilePath || ""),
    sourceLine: Number.isFinite(Number(returnDefinition?.sourceLine)) ? Number(returnDefinition.sourceLine) : undefined,
    rootTypeNames,
    typePreferencesByName: serializeTypePreferenceMapEntries(returnTypeResolution.typePreferencesByName),
    typeDebug: buildReturnResolutionTypeDebug(index, rootTypeNames, returnTypeResolution.typePreferencesByName),
    includeTechnical: true,
    simpleAccessCounts: {
      firstLevel: Array.isArray(simpleAccess?.firstLevel) ? simpleAccess.firstLevel.length : 0,
      secondLevel: Array.isArray(simpleAccess?.secondLevel) ? simpleAccess.secondLevel.length : 0
    },
    technicalLineCount: Array.isArray(technicalStructureLines) ? technicalStructureLines.length : 0
  });

  return {
    owner,
    assignment: selectedAssignment,
    sourceUri: document.uri.toString(),
    sourceLine: selectedAssignment.startLine,
    variableToken: {
      token: rawArgumentValue,
      start: Number.isFinite(Number(hoveredVariableReference?.start))
        ? Number(hoveredVariableReference.start)
        : context.hoverStart,
      end: Number.isFinite(Number(hoveredVariableReference?.end))
        ? Number(hoveredVariableReference.end)
        : context.hoverEnd
    },
    normalizedKeyword,
    returnAnnotation,
    returnDefinition,
    rootTypeNames,
    simpleAccess,
    technicalStructureLines
  };
}

async function resolveReturnMemberCompletionCandidatesForAssignment(
  document,
  index,
  selectedAssignment,
  memberContext,
  completionMaxDepth,
  returnComputeWorker
) {
  if (!document || !index || !selectedAssignment || !memberContext) {
    return [];
  }

  const normalizedKeyword = normalizeKeywordName(selectedAssignment.keywordName);
  const returnDefinition = getKeywordReturnDefinition(index, normalizedKeyword);
  const returnAnnotation = String(
    returnDefinition?.returnAnnotation || index.keywordReturns?.get(normalizedKeyword) || ""
  ).trim();
  if (!returnAnnotation) {
    return [];
  }

  const returnResolutionContext = buildTypeResolutionContextFromReturnDefinition(index, returnDefinition);
  const subtypePolicy = getReturnSubtypeResolutionPolicy(index);
  const returnTypeResolution = resolveIndexedTypesFromAnnotation(returnAnnotation, index, {
    policy: subtypePolicy,
    resolutionContext: returnResolutionContext
  });
  const rootTypeNames = returnTypeResolution.typeNames;
  if (rootTypeNames.length === 0) {
    return [];
  }

  const depthForCache = Math.max(getReturnPreviewMaxDepth(), Math.max(1, Number(completionMaxDepth) || 1));
  const maxFieldsPerType = getReturnMaxFieldsPerType();
  const technicalMaxDepth = getReturnTechnicalMaxDepth();
  const technicalMaxFieldsPerType = getReturnTechnicalMaxFieldsPerType();

  if (returnComputeWorker) {
    const workerResult = await returnComputeWorker.computeReturnMemberCompletions(document, index, {
      variableToken: memberContext.rootVariableToken,
      rootTypeNames,
      rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
      typePreferencesByName: serializeTypePreferenceMapEntries(returnTypeResolution.typePreferencesByName),
      fieldNameStyle: getReturnFieldNameStyle(),
      includeProperties: getReturnIncludeProperties(),
      maxDepth: depthForCache,
      maxFieldsPerType,
      includeTechnical: false,
      technicalMaxDepth,
      technicalMaxFieldsPerType,
      subtypePolicy: serializeSubtypePolicy(subtypePolicy),
      pathSegments: memberContext.pathSegments,
      activeSegmentPrefix: memberContext.activeSegment,
      completionMaxDepth: Math.max(1, Number(completionMaxDepth) || 1)
    });
    if (Array.isArray(workerResult?.members)) {
      return workerResult.members;
    }
  }

  const simpleAccessTemplate = buildSimpleReturnAccessTemplate(rootTypeNames, index, {
    rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
    subtypePolicy,
    typePreferencesByName: returnTypeResolution.typePreferencesByName,
    resolutionContext: returnResolutionContext,
    maxDepth: depthForCache,
    maxFieldsPerType,
    includeProperties: getReturnIncludeProperties()
  });
  return collectReturnMemberCompletionCandidatesFromTemplate(
    simpleAccessTemplate,
    memberContext.pathSegments,
    memberContext.activeSegment,
    completionMaxDepth,
    getReturnFieldNameStyle()
  );
}

function collectReturnMemberCompletionCandidatesFromTemplate(
  template,
  pathSegments,
  activeSegment,
  completionMaxDepth,
  fieldNameStyle = "camelcase"
) {
  if (!template) {
    return [];
  }
  const normalizedPathSegments = sanitizeMemberPathSegments(pathSegments || []);
  const targetDepth = normalizedPathSegments.length + 1;
  const maxDepth = Math.max(1, Number(completionMaxDepth) || 1);
  if (targetDepth > maxDepth) {
    return [];
  }
  const levels = Array.isArray(template?.levels) ? template.levels : [];
  const levelTemplates = Array.isArray(levels[targetDepth - 1]) ? levels[targetDepth - 1] : [];
  const normalizedPrefix = normalizeMemberCompletionToken(activeSegment).toLowerCase();
  const candidateMap = new Map();

  for (const levelTemplate of levelTemplates) {
    if (!isTemplatePathPrefixMatch(levelTemplate, normalizedPathSegments)) {
      continue;
    }
    const segmentName = String(levelTemplate?.segments?.[normalizedPathSegments.length] || "").trim();
    if (!segmentName) {
      continue;
    }
    const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
      levelTemplate?.camelCaseSegmentPositions || [],
      Array.isArray(levelTemplate?.segments) ? levelTemplate.segments.length : 0
    );
    const supportsCamelCaseAccess = camelCaseSegmentPositions.has(normalizedPathSegments.length);
    const visibleSegmentNames = getSegmentNameVariants(segmentName, supportsCamelCaseAccess, fieldNameStyle);
    const visibleInsertTexts = visibleSegmentNames.map((segmentVariant) =>
      levelTemplate?.fieldIsCollectionLike ? `${segmentVariant}[0]` : segmentVariant
    );
    const acceptedInsertTexts = getSegmentNameVariants(segmentName, supportsCamelCaseAccess, "both").map(
      (segmentVariant) => (levelTemplate?.fieldIsCollectionLike ? `${segmentVariant}[0]` : segmentVariant)
    );
    if (
      normalizedPrefix &&
      !acceptedInsertTexts.some((insertText) =>
        normalizeMemberCompletionToken(insertText).toLowerCase().startsWith(normalizedPrefix)
      )
    ) {
      continue;
    }
    const annotation = String(levelTemplate?.fieldAnnotation || "").trim();
    const typeDisplay = uniqueStrings(
      (Array.isArray(levelTemplate?.fieldTypeNames) ? levelTemplate.fieldTypeNames : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ).join(" | ");
    for (const insertText of visibleInsertTexts) {
      const normalizedInsertText = normalizeMemberCompletionToken(insertText).toLowerCase();
      let existing = candidateMap.get(normalizedInsertText);
      if (!existing) {
        existing = {
          label: insertText,
          insertText,
          sortText: normalizedInsertText,
          filterText: uniqueStrings([insertText, ...acceptedInsertTexts]).join(" "),
          detail: "",
          annotation: "",
          typeDisplay: ""
        };
        candidateMap.set(normalizedInsertText, existing);
      }
      if (annotation && !existing.annotation) {
        existing.annotation = annotation;
      }
      if (typeDisplay && !existing.typeDisplay) {
        existing.typeDisplay = typeDisplay;
      }
      if (!existing.detail) {
        existing.detail =
          existing.typeDisplay.length > 0
            ? existing.typeDisplay
            : annotation.length > 0
            ? annotation
            : "Return member";
      }
    }
  }

  return [...candidateMap.values()].sort((left, right) =>
    String(left.insertText || "").localeCompare(String(right.insertText || ""))
  );
}

function isTemplatePathPrefixMatch(levelTemplate, pathSegments) {
  const templateSegments = Array.isArray(levelTemplate?.segments) ? levelTemplate.segments : [];
  if (pathSegments.length > templateSegments.length) {
    return false;
  }

  const indexedSegmentPositions = new Set(levelTemplate?.indexedSegmentPositions || []);
  const camelCaseSegmentPositions = new Set(levelTemplate?.camelCaseSegmentPositions || []);
  for (let index = 0; index < pathSegments.length; index += 1) {
    const parsedTypedSegment = parseMemberPathSegment(pathSegments[index]);
    if (!parsedTypedSegment) {
      return false;
    }
    const matchingSegmentNames = getSegmentMatchVariants(
      templateSegments[index],
      camelCaseSegmentPositions.has(index)
    ).map((value) => normalizeComparableToken(value));
    if (!matchingSegmentNames.includes(parsedTypedSegment.normalizedName)) {
      return false;
    }
    if (parsedTypedSegment.indexed && !indexedSegmentPositions.has(index)) {
      return false;
    }
  }

  return true;
}

function sanitizeMemberPathSegments(pathSegments) {
  return (Array.isArray(pathSegments) ? pathSegments : [])
    .map((segment) => normalizeMemberPathSegment(segment))
    .filter(Boolean);
}

function normalizeMemberPathSegment(segment) {
  const normalized = normalizeMemberCompletionToken(segment);
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[0\])?$/);
  if (!match) {
    return "";
  }
  return match[2] ? `${match[1]}[0]` : match[1];
}

function parseMemberPathSegment(segment) {
  const normalized = normalizeMemberPathSegment(segment);
  if (!normalized) {
    return undefined;
  }
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[0\])?$/);
  if (!match) {
    return undefined;
  }
  return {
    name: String(match[1] || ""),
    normalizedName: normalizeComparableToken(match[1] || ""),
    indexed: Boolean(match[2])
  };
}

function getKeywordReturnDefinition(index, normalizedKeyword) {
  if (!index || !normalizedKeyword) {
    return undefined;
  }
  const definitions = index.keywordReturnDefinitions?.get(normalizedKeyword) || [];
  if (!Array.isArray(definitions) || definitions.length === 0) {
    return undefined;
  }
  return definitions[0];
}

function buildTypeResolutionContextFromSource(
  index,
  sourceFilePath,
  fallbackModulePath = "",
  fallbackPackagePath = ""
) {
  const normalizedSourceFilePath = String(sourceFilePath || "").trim();
  const moduleInfo = normalizedSourceFilePath ? index?.moduleInfoByFile?.get(normalizedSourceFilePath) : undefined;
  const modulePath = String(fallbackModulePath || moduleInfo?.modulePath || "").trim();
  const packagePath = String(fallbackPackagePath || moduleInfo?.packagePath || "").trim();
  const localStructuredTypeNames = normalizedSourceFilePath
    ? new Set(index?.localStructuredTypeNamesByFile?.get(normalizedSourceFilePath) || [])
    : new Set();
  const localEnumNames = normalizedSourceFilePath
    ? new Set(index?.localEnumNamesByFile?.get(normalizedSourceFilePath) || [])
    : new Set();
  const typeImportAliases = normalizedSourceFilePath
    ? cloneTypeImportAliasesMap(index?.typeImportAliasesByFile?.get(normalizedSourceFilePath))
    : new Map();
  const moduleImportAliases = normalizedSourceFilePath
    ? new Map(index?.moduleImportAliasesByFile?.get(normalizedSourceFilePath) || [])
    : new Map();

  return {
    sourceFilePath: normalizedSourceFilePath,
    modulePath,
    packagePath,
    localStructuredTypeNames,
    localEnumNames,
    typeImportAliases,
    moduleImportAliases
  };
}

function buildTypeResolutionContextFromReturnDefinition(index, returnDefinition) {
  if (!returnDefinition) {
    return undefined;
  }

  const sourceFilePath = String(returnDefinition.sourceFilePath || "");
  const modulePath = String(returnDefinition.modulePath || "");
  const packagePath = String(returnDefinition.packagePath || "");
  const baseContext = buildTypeResolutionContextFromSource(index, sourceFilePath, modulePath, packagePath);
  const localStructuredTypeNames =
    returnDefinition.localStructuredTypeNames instanceof Set
      ? returnDefinition.localStructuredTypeNames
      : baseContext.localStructuredTypeNames;
  const localEnumNames =
    returnDefinition.localEnumNames instanceof Set
      ? returnDefinition.localEnumNames
      : baseContext.localEnumNames;
  const typeImportAliases =
    returnDefinition.typeImportAliases instanceof Map
      ? returnDefinition.typeImportAliases
      : baseContext.typeImportAliases;
  const moduleImportAliases =
    returnDefinition.moduleImportAliases instanceof Map
      ? returnDefinition.moduleImportAliases
      : baseContext.moduleImportAliases;

  return {
    sourceFilePath: baseContext.sourceFilePath,
    modulePath: baseContext.modulePath,
    packagePath: baseContext.packagePath,
    localStructuredTypeNames,
    localEnumNames,
    typeImportAliases,
    moduleImportAliases
  };
}

function buildTypeResolutionContextFromStructuredType(index, structuredType) {
  if (!structuredType) {
    return undefined;
  }
  return buildTypeResolutionContextFromSource(
    index,
    structuredType.filePath,
    structuredType.modulePath,
    ""
  );
}

function resolveStructuredBaseTypeReferences(baseTypeNames, resolutionContext) {
  const references = [];
  const seenReferences = new Set();

  for (const rawBaseTypeName of uniqueStrings((baseTypeNames || []).map((value) => String(value || "").trim()))) {
    if (!rawBaseTypeName) {
      continue;
    }

    const preferredQualifiedNames = resolveQualifiedTypeReferencesWithoutIndex(rawBaseTypeName, resolutionContext);
    const typeName = resolveStructuredBaseTypeSimpleName(rawBaseTypeName, resolutionContext, preferredQualifiedNames);
    if (!typeName) {
      continue;
    }

    const key = JSON.stringify({
      typeName: normalizeComparableToken(typeName),
      preferredQualifiedNames
    });
    if (seenReferences.has(key)) {
      continue;
    }
    seenReferences.add(key);
    references.push({
      typeName,
      preferredQualifiedNames
    });
  }

  return references;
}

function resolveStructuredBaseTypeSimpleName(rawBaseTypeName, resolutionContext, preferredQualifiedNames = []) {
  const rawTypeName = String(rawBaseTypeName || "").trim();
  if (!rawTypeName) {
    return "";
  }
  const simpleName = extractTypeSimpleName(rawTypeName);
  if (!resolutionContext) {
    return simpleName;
  }

  const dottedMatch = rawTypeName.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
  if (dottedMatch) {
    const moduleAlias = String(dottedMatch[1] || "").trim();
    const aliasImports = resolutionContext.typeImportAliases?.get(moduleAlias) || [];
    if (aliasImports.length > 0) {
      return extractTypeSimpleName(dottedMatch[2]) || simpleName;
    }
    return extractTypeSimpleName(dottedMatch[2]) || simpleName;
  }

  const directImports = []
    .concat(resolutionContext.typeImportAliases?.get(rawTypeName) || [])
    .concat(resolutionContext.typeImportAliases?.get(simpleName) || []);
  if (directImports.length > 0) {
    const importedSymbolName = String(directImports[0]?.symbolName || "").trim();
    if (importedSymbolName) {
      return importedSymbolName;
    }
  }

  const preferredQualifiedName = String(preferredQualifiedNames[0] || "").trim();
  if (preferredQualifiedName) {
    const preferredSimpleName = extractTypeSimpleName(preferredQualifiedName);
    if (preferredSimpleName && preferredSimpleName.toLowerCase() !== preferredSimpleName) {
      return preferredSimpleName;
    }
  }

  return simpleName;
}

function resolveQualifiedTypeReferencesWithoutIndex(typeToken, resolutionContext) {
  const rawTypeName = String(typeToken || "").trim();
  if (!rawTypeName) {
    return [];
  }

  const simpleName = extractTypeSimpleName(rawTypeName);
  if (!simpleName) {
    return [];
  }

  const preferredQualifiedNames = [];
  const addPreferredQualifiedName = (qualifiedName) => {
    const normalizedQualifiedName = normalizeQualifiedTypeName(qualifiedName);
    if (!normalizedQualifiedName) {
      return;
    }
    preferredQualifiedNames.push(normalizedQualifiedName);
  };

  addPreferredQualifiedName(rawTypeName);

  if (resolutionContext) {
    const dottedMatch = rawTypeName.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
    if (dottedMatch) {
      const moduleAlias = String(dottedMatch[1] || "").trim();
      const remainder = String(dottedMatch[2] || "").trim();
      const modulePath = String(resolutionContext.moduleImportAliases?.get(moduleAlias) || "").trim();
      if (modulePath && remainder) {
        addPreferredQualifiedName(`${modulePath}.${remainder}`);
        addPreferredQualifiedName(`${modulePath}.${extractTypeSimpleName(remainder)}`);
      }
      const aliasImports = resolutionContext.typeImportAliases?.get(moduleAlias) || [];
      for (const importSpec of aliasImports) {
        const importModulePath = String(importSpec?.modulePath || "").trim();
        const importSymbolName = String(importSpec?.symbolName || "").trim();
        if (!importModulePath || !importSymbolName || !remainder) {
          continue;
        }
        addPreferredQualifiedName(`${importModulePath}.${importSymbolName}.${remainder}`);
        addPreferredQualifiedName(
          `${importModulePath}.${importSymbolName}.${extractTypeSimpleName(remainder)}`
        );
      }
    }

    const directImports = []
      .concat(resolutionContext.typeImportAliases?.get(rawTypeName) || [])
      .concat(resolutionContext.typeImportAliases?.get(simpleName) || []);
    for (const importSpec of directImports) {
      addPreferredQualifiedName(
        `${String(importSpec?.modulePath || "").trim()}.${String(importSpec?.symbolName || "").trim()}`
      );
    }

    const isLocalStructuredType = resolutionContext.localStructuredTypeNames?.has(simpleName);
    const isLocalEnumType = resolutionContext.localEnumNames?.has(simpleName);
    if ((isLocalStructuredType || isLocalEnumType) && resolutionContext.modulePath) {
      addPreferredQualifiedName(`${resolutionContext.modulePath}.${simpleName}`);
    }
  }

  return uniqueStrings(preferredQualifiedNames);
}

function extractIndexedTypeNamesFromAnnotation(annotation, index, options = {}) {
  return resolveIndexedTypesFromAnnotation(annotation, index, options).typeNames;
}

function resolveIndexedTypesFromAnnotation(annotation, index, options = {}) {
  if (!annotation || !index) {
    return {
      typeNames: [],
      hasCollectionSubtype: false,
      containerNames: [],
      typePreferencesByName: new Map()
    };
  }

  const nodes = parseTypeAnnotationNodes(annotation);
  if (nodes.length === 0) {
    return {
      typeNames: [],
      hasCollectionSubtype: false,
      containerNames: [],
      typePreferencesByName: new Map()
    };
  }

  const policy = options.policy || getReturnSubtypeResolutionPolicy(index);
  const resolutionContext = options.resolutionContext;
  const typeNames = [];
  const containerNames = new Set();
  const typePreferencesByName = new Map();
  let hasCollectionSubtype = false;

  const visitNode = (node, insideCollectionContainer = false) => {
    if (!node) {
      return;
    }

    if (node.kind === "union" || node.kind === "tuple") {
      for (const item of node.items || []) {
        visitNode(item, insideCollectionContainer);
      }
      return;
    }

    if (node.kind !== "name") {
      return;
    }

    const resolvedType = resolveIndexedTypeReference(node.name, index, resolutionContext);
    if (resolvedType) {
      typeNames.push(resolvedType.simpleName);
      if (resolvedType.preferredQualifiedNames.length > 0) {
        mergeTypePreferenceMap(typePreferencesByName, resolvedType.simpleName, resolvedType.preferredQualifiedNames);
      }
      if (insideCollectionContainer) {
        hasCollectionSubtype = true;
      }
    }

    const args = Array.isArray(node.args) ? node.args : [];
    if (args.length === 0) {
      return;
    }

    const nodeName = extractTypeSimpleName(node.name);
    const normalizedContainerName = normalizeComparableToken(nodeName);
    if (!shouldResolveSubtypeFromContainer(normalizedContainerName, policy)) {
      return;
    }

    containerNames.add(normalizedContainerName);
    const insideChildCollectionContainer =
      insideCollectionContainer || policy.collectionContainers.has(normalizedContainerName);
    for (const argNode of args) {
      visitNode(argNode, insideChildCollectionContainer);
    }
  };

  for (const rootNode of nodes) {
    visitNode(rootNode, false);
  }

  return {
    typeNames: uniqueStrings(typeNames),
    hasCollectionSubtype,
    containerNames: [...containerNames],
    typePreferencesByName
  };
}

function resolveIndexedTypeReference(typeToken, index, resolutionContext) {
  const rawTypeName = String(typeToken || "").trim();
  if (!rawTypeName) {
    return undefined;
  }

  const simpleName = extractTypeSimpleName(rawTypeName);
  if (!simpleName) {
    return undefined;
  }

  const preferredQualifiedNames = [];
  const addPreferredQualifiedName = (qualifiedName) => {
    const normalizedQualifiedName = normalizeQualifiedTypeName(qualifiedName);
    if (!normalizedQualifiedName) {
      return;
    }
    if (!hasIndexedTypeForQualifiedName(index, normalizedQualifiedName)) {
      return;
    }
    preferredQualifiedNames.push(normalizedQualifiedName);
  };

  if (resolutionContext) {
    addPreferredQualifiedName(rawTypeName);

    const dottedMatch = rawTypeName.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/);
    if (dottedMatch) {
      const moduleAlias = String(dottedMatch[1] || "").trim();
      const remainder = String(dottedMatch[2] || "").trim();
      const modulePath = String(resolutionContext.moduleImportAliases?.get(moduleAlias) || "").trim();
      if (modulePath && remainder) {
        addPreferredQualifiedName(`${modulePath}.${remainder}`);
        addPreferredQualifiedName(`${modulePath}.${extractTypeSimpleName(remainder)}`);
      }
      const aliasImports = resolutionContext.typeImportAliases?.get(moduleAlias) || [];
      for (const importSpec of aliasImports) {
        const importModulePath = String(importSpec?.modulePath || "").trim();
        const importSymbolName = String(importSpec?.symbolName || "").trim();
        if (!importModulePath || !importSymbolName || !remainder) {
          continue;
        }
        addPreferredQualifiedName(`${importModulePath}.${importSymbolName}.${remainder}`);
        addPreferredQualifiedName(
          `${importModulePath}.${importSymbolName}.${extractTypeSimpleName(remainder)}`
        );
      }
    }

    const directImports = []
      .concat(resolutionContext.typeImportAliases?.get(rawTypeName) || [])
      .concat(resolutionContext.typeImportAliases?.get(simpleName) || []);
    for (const importSpec of directImports) {
      addPreferredQualifiedName(
        `${String(importSpec.modulePath || "").trim()}.${String(importSpec.symbolName || "").trim()}`
      );
    }

    const isLocalStructuredType = resolutionContext.localStructuredTypeNames?.has(simpleName);
    const isLocalEnumType = resolutionContext.localEnumNames?.has(simpleName);
    if ((isLocalStructuredType || isLocalEnumType) && resolutionContext.modulePath) {
      addPreferredQualifiedName(`${resolutionContext.modulePath}.${simpleName}`);
    }
  }

  const dedupedPreferredQualifiedNames = uniqueStrings(preferredQualifiedNames);
  if (dedupedPreferredQualifiedNames.length > 0) {
    return {
      simpleName,
      preferredQualifiedNames: dedupedPreferredQualifiedNames
    };
  }

  if (!hasIndexedTypeForName(index, simpleName)) {
    return undefined;
  }

  return {
    simpleName,
    preferredQualifiedNames: []
  };
}

function mergeTypePreferenceMap(targetMap, typeName, qualifiedNames) {
  if (!(targetMap instanceof Map)) {
    return;
  }

  const normalizedTypeName = normalizeComparableToken(typeName);
  if (!normalizedTypeName) {
    return;
  }

  const normalizedQualifiedNames = (qualifiedNames || [])
    .map((value) => normalizeQualifiedTypeName(value))
    .filter(Boolean);
  if (normalizedQualifiedNames.length === 0) {
    return;
  }
  const existing = targetMap.get(normalizedTypeName) || [];
  targetMap.set(normalizedTypeName, uniqueStrings(existing.concat(normalizedQualifiedNames)));
}

function cloneTypePreferenceMap(sourceMap) {
  const cloned = new Map();
  if (!(sourceMap instanceof Map)) {
    return cloned;
  }
  for (const [typeName, qualifiedNames] of sourceMap.entries()) {
    const normalizedTypeName = normalizeComparableToken(typeName);
    if (!normalizedTypeName) {
      continue;
    }
    const normalizedQualifiedNames = (qualifiedNames || [])
      .map((value) => normalizeQualifiedTypeName(value))
      .filter(Boolean);
    if (normalizedQualifiedNames.length > 0) {
      cloned.set(normalizedTypeName, uniqueStrings(normalizedQualifiedNames));
    }
  }
  return cloned;
}

function mergeTypePreferenceMaps(targetMap, sourceMap) {
  if (!(targetMap instanceof Map) || !(sourceMap instanceof Map)) {
    return targetMap;
  }
  for (const [typeName, qualifiedNames] of sourceMap.entries()) {
    mergeTypePreferenceMap(targetMap, typeName, qualifiedNames);
  }
  return targetMap;
}

function getPreferredQualifiedNamesForType(typePreferencesByName, typeName) {
  if (!(typePreferencesByName instanceof Map)) {
    return [];
  }
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (!normalizedTypeName) {
    return [];
  }
  return uniqueStrings(
    (typePreferencesByName.get(normalizedTypeName) || [])
      .map((value) => normalizeQualifiedTypeName(value))
      .filter(Boolean)
  );
}

function parseTypeAnnotationNodes(annotation) {
  const tokens = tokenizeTypeAnnotation(annotation);
  if (tokens.length === 0) {
    return [];
  }

  let pointer = 0;

  const parseSequence = (stopType = "") => {
    const nodes = [];
    while (pointer < tokens.length) {
      const token = tokens[pointer];
      if (stopType && token.type === stopType) {
        break;
      }
      if (token.type === ",") {
        pointer += 1;
        continue;
      }
      const node = parseUnion();
      if (node) {
        nodes.push(node);
      } else {
        pointer += 1;
      }
    }
    return nodes;
  };

  const parseUnion = () => {
    let left = parsePrimary();
    if (!left) {
      return null;
    }

    const unionItems = [left];
    while (pointer < tokens.length && tokens[pointer].type === "|") {
      pointer += 1;
      const right = parsePrimary();
      if (right) {
        unionItems.push(right);
      }
    }

    if (unionItems.length === 1) {
      return unionItems[0];
    }

    return {
      kind: "union",
      items: unionItems
    };
  };

  const parsePrimary = () => {
    const token = tokens[pointer];
    if (!token) {
      return null;
    }

    if (token.type === "name") {
      pointer += 1;
      const node = {
        kind: "name",
        name: token.value,
        args: []
      };
      if (pointer < tokens.length && tokens[pointer].type === "[") {
        pointer += 1;
        node.args = parseSequence("]");
        if (pointer < tokens.length && tokens[pointer].type === "]") {
          pointer += 1;
        }
      }
      return node;
    }

    if (token.type === "(") {
      pointer += 1;
      const innerNodes = parseSequence(")");
      if (pointer < tokens.length && tokens[pointer].type === ")") {
        pointer += 1;
      }
      if (innerNodes.length === 1) {
        return innerNodes[0];
      }
      if (innerNodes.length > 1) {
        return {
          kind: "tuple",
          items: innerNodes
        };
      }
      return null;
    }

    return null;
  };

  return parseSequence();
}

function tokenizeTypeAnnotation(annotation) {
  const source = String(annotation || "");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "[" || char === "]" || char === "(" || char === ")" || char === "|" || char === ",") {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let endIndex = index + 1;
      while (endIndex < source.length) {
        if (source[endIndex] === quote && source[endIndex - 1] !== "\\") {
          break;
        }
        endIndex += 1;
      }
      const quotedValue = source.slice(index + 1, Math.min(endIndex, source.length));
      const parsedQuotedName = parseQuotedTypeAnnotationName(quotedValue);
      if (parsedQuotedName) {
        tokens.push({ type: "name", value: parsedQuotedName });
      }
      index = Math.min(endIndex + 1, source.length);
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) {
        index += 1;
      }
      tokens.push({ type: "name", value: source.slice(start, index) });
      continue;
    }

    index += 1;
  }

  return tokens;
}

function parseQuotedTypeAnnotationName(value) {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }
  const match = source.match(/[A-Za-z_][A-Za-z0-9_.]*/);
  return match ? match[0] : "";
}

function extractTypeSimpleName(typeName) {
  const source = String(typeName || "").trim();
  if (!source) {
    return "";
  }
  const segments = source.split(".");
  return String(segments[segments.length - 1] || "").trim();
}

function normalizeQualifiedTypeName(value) {
  const source = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".");
  if (!source) {
    return "";
  }
  return source
    .split(".")
    .map((segment) => String(segment || "").trim())
    .filter(Boolean)
    .join(".")
    .toLowerCase();
}

function hasIndexedTypeForQualifiedName(index, qualifiedName) {
  const normalizedQualifiedName = normalizeQualifiedTypeName(qualifiedName);
  if (!normalizedQualifiedName) {
    return false;
  }

  for (const [key] of index?.structuredTypesByQualifiedName || []) {
    if (normalizeQualifiedTypeName(key) === normalizedQualifiedName) {
      return true;
    }
  }
  for (const [key] of index?.enumsByQualifiedName || []) {
    if (normalizeQualifiedTypeName(key) === normalizedQualifiedName) {
      return true;
    }
  }
  return false;
}

function hasIndexedTypeForName(index, typeName) {
  const simpleName = extractTypeSimpleName(typeName);
  if (!simpleName) {
    return false;
  }
  return Boolean(index.structuredTypesByName?.has(simpleName) || index.enumsByName?.has(simpleName));
}

function getReturnSubtypeResolutionPolicy(index) {
  const rawMode = String(getReturnSubtypeResolutionMode() || "always").trim().toLowerCase();
  const mode = RETURN_SUBTYPE_RESOLUTION_MODES.has(rawMode) ? rawMode : "always";
  const includeSet = normalizeContainerNameSet(getReturnSubtypeIncludeContainers());
  const excludeSet = normalizeContainerNameSet(getReturnSubtypeExcludeContainers());

  const collectionContainers = new Set(BUILTIN_INDEXABLE_RETURN_CONTAINERS);
  for (const includedContainer of includeSet) {
    collectionContainers.add(includedContainer);
  }
  for (const indexableTypeName of index?.indexableStructuredTypeNames || []) {
    const normalizedTypeName = normalizeComparableToken(indexableTypeName);
    if (normalizedTypeName) {
      collectionContainers.add(normalizedTypeName);
    }
  }

  return {
    mode,
    includeSet,
    excludeSet,
    collectionContainers
  };
}

function normalizeContainerNameSet(values) {
  const normalized = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalizedValue = normalizeComparableToken(value);
    if (normalizedValue) {
      normalized.add(normalizedValue);
    }
  }
  return normalized;
}

function shouldResolveSubtypeFromContainer(normalizedContainerName, policy) {
  if (!normalizedContainerName || !policy) {
    return false;
  }

  if (policy.mode === "never") {
    return false;
  }
  if (policy.mode === "always") {
    return true;
  }
  if (policy.mode === "exclude") {
    return !policy.excludeSet.has(normalizedContainerName);
  }

  if (policy.includeSet.size > 0) {
    return policy.includeSet.has(normalizedContainerName);
  }
  return policy.collectionContainers.has(normalizedContainerName);
}

function normalizeReturnFieldNameStyle(value) {
  const normalized = String(value || "camelcase").trim().toLowerCase();
  if (RETURN_FIELD_NAME_STYLES.has(normalized)) {
    return normalized;
  }
  return "camelcase";
}

function snakeToCamelCaseAccessSegment(segment) {
  const rawSegment = String(segment || "").trim();
  if (!rawSegment) {
    return "";
  }
  if (!rawSegment.includes("_")) {
    return `${rawSegment[0].toLowerCase()}${rawSegment.slice(1)}`;
  }
  const parts = rawSegment
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const trimmedPart = String(part || "").trim();
      return trimmedPart || "";
    })
    .filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `${parts[0][0].toLowerCase()}${parts[0].slice(1)}${parts
    .slice(1)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")}`;
}

function getCamelCaseAccessAlias(segment, supportsCamelCaseAccess) {
  if (!supportsCamelCaseAccess) {
    return String(segment || "").trim();
  }
  return snakeToCamelCaseAccessSegment(segment) || String(segment || "").trim();
}

function getSegmentNameVariants(segment, supportsCamelCaseAccess, fieldNameStyle) {
  const rawSegment = String(segment || "").trim();
  if (!rawSegment) {
    return [];
  }
  const preferredSegment = getCamelCaseAccessAlias(rawSegment, supportsCamelCaseAccess);
  const normalizedStyle = normalizeReturnFieldNameStyle(fieldNameStyle);
  if (normalizedStyle === "snake_case") {
    return [rawSegment];
  }
  if (normalizedStyle === "both") {
    return uniqueStrings([rawSegment, preferredSegment]);
  }
  return uniqueStrings([preferredSegment]);
}

function getSegmentMatchVariants(segment, supportsCamelCaseAccess) {
  return uniqueStrings([
    String(segment || "").trim(),
    getCamelCaseAccessAlias(segment, supportsCamelCaseAccess)
  ]);
}

function buildVisibleTemplateSegmentVariants(levelTemplate, fieldNameStyle) {
  const segments = (Array.isArray(levelTemplate?.segments) ? levelTemplate.segments : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return [];
  }

  const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
    levelTemplate?.camelCaseSegmentPositions || [],
    segments.length
  );
  const preferredSegments = segments.map((segment, index) =>
    camelCaseSegmentPositions.has(index) ? getCamelCaseAccessAlias(segment, true) : segment
  );
  const normalizedStyle = normalizeReturnFieldNameStyle(fieldNameStyle);
  const candidates =
    normalizedStyle === "snake_case"
      ? [segments]
      : normalizedStyle === "both"
      ? [segments, preferredSegments]
      : [preferredSegments];
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = (Array.isArray(candidate) ? candidate : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (normalizedCandidate.length !== segments.length) {
      continue;
    }
    const key = normalizedCandidate.join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalizedCandidate);
  }
  return result;
}

function sanitizeSimpleAccessTemplate(template) {
  const levels = (template?.levels || []).map((levelTemplates) =>
    (Array.isArray(levelTemplates) ? levelTemplates : [])
      .map((levelTemplate) => {
        const segments = (levelTemplate?.segments || [])
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (segments.length === 0) {
          return undefined;
        }
        const indexedSegmentPositions = normalizeIndexedSegmentPositions(
          levelTemplate?.indexedSegmentPositions || [],
          segments.length
        );
        const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
          levelTemplate?.camelCaseSegmentPositions || [],
          segments.length
        );
        return {
          includeRootIndexed: Boolean(levelTemplate?.includeRootIndexed),
          segments,
          camelCaseSegmentPositions: [...camelCaseSegmentPositions].sort((left, right) => left - right),
          indexedSegmentPositions: [...indexedSegmentPositions].sort((left, right) => left - right),
          fieldAnnotation: String(levelTemplate?.fieldAnnotation || ""),
          fieldTypeNames: uniqueStrings(
            (Array.isArray(levelTemplate?.fieldTypeNames) ? levelTemplate.fieldTypeNames : [])
              .map((value) => String(value || "").trim())
              .filter(Boolean)
          ),
          fieldIsCollectionLike: Boolean(levelTemplate?.fieldIsCollectionLike)
        };
      })
      .filter(Boolean)
  );
  return {
    levels,
    firstLevel: levels[0] || [],
    secondLevel: levels[1] || []
  };
}

function buildSimpleReturnAccessTemplate(rootTypeNames, index, options = {}) {
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(options.maxFieldsPerType, 0);
  const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || 2));
  const rootCollectionLike = Boolean(options.rootCollectionLike);
  const subtypePolicy = options.subtypePolicy || getReturnSubtypeResolutionPolicy(index);
  const rootTypePreferences = cloneTypePreferenceMap(options.typePreferencesByName);
  const levels = [];
  let currentNodes = [
    {
      segments: [],
      camelCaseSegmentPositions: new Set(),
      indexedSegmentPositions: new Set(),
      typeNames: uniqueStrings(rootTypeNames || []),
      typePreferencesByName: rootTypePreferences
    }
  ];

  for (let levelIndex = 1; levelIndex <= maxDepth && currentNodes.length > 0; levelIndex += 1) {
    const levelPathTemplatesBySignature = new Map();
    const nextNodesBySegments = new Map();

    for (const node of currentNodes) {
      const fields = collectDeclaredFieldsForTypes(node.typeNames, index, {
        typePreferencesByName: node.typePreferencesByName,
        includeProperties: options.includeProperties !== false
      }).slice(0, getEffectiveReturnMaxFieldsPerType(maxFieldsPerType));
      for (const field of fields) {
        const segments = node.segments.concat(field.name);
        const fieldResolutionContext = buildTypeResolutionContextFromSource(
          index,
          field.sourceFilePath,
          field.sourceModulePath,
          field.sourcePackagePath
        );
        const nestedTypeResolution = resolveIndexedTypesFromAnnotation(field.annotation, index, {
          policy: subtypePolicy,
          resolutionContext: fieldResolutionContext
        });
        const nestedTypeNames = nestedTypeResolution.typeNames;
        const camelCaseSegmentPositions = normalizeIndexedSegmentPositions(
          node.camelCaseSegmentPositions,
          segments.length
        );
        if (field.supportsCamelCaseAccess) {
          camelCaseSegmentPositions.add(segments.length - 1);
        }
        const indexedPositions = normalizeIndexedSegmentPositions(
          node.indexedSegmentPositions,
          segments.length
        );
        const normalizedCamelCasePositions = [...camelCaseSegmentPositions].sort((left, right) => left - right);
        const normalizedIndexedPositions = [...indexedPositions].sort((left, right) => left - right);
        const pathTemplate = {
          includeRootIndexed: rootCollectionLike,
          segments,
          camelCaseSegmentPositions: normalizedCamelCasePositions,
          indexedSegmentPositions: normalizedIndexedPositions,
          fieldAnnotation: String(field.annotation || "").trim(),
          fieldTypeNames: uniqueStrings(nestedTypeNames || []),
          fieldIsCollectionLike: Boolean(nestedTypeResolution.hasCollectionSubtype)
        };
        const pathSignature = `${rootCollectionLike ? "1" : "0"}|${segments.join("\u0000")}|${normalizedIndexedPositions.join(",")}`;
        if (!levelPathTemplatesBySignature.has(pathSignature)) {
          levelPathTemplatesBySignature.set(pathSignature, pathTemplate);
        } else {
          const existing = levelPathTemplatesBySignature.get(pathSignature);
          if (existing) {
            existing.camelCaseSegmentPositions = [
              ...normalizeIndexedSegmentPositions(
                [...(existing.camelCaseSegmentPositions || []), ...normalizedCamelCasePositions],
                segments.length
              )
            ].sort((left, right) => left - right);
            existing.fieldIsCollectionLike =
              Boolean(existing.fieldIsCollectionLike) || Boolean(pathTemplate.fieldIsCollectionLike);
            existing.fieldTypeNames = uniqueStrings([...(existing.fieldTypeNames || []), ...pathTemplate.fieldTypeNames]);
            if (!existing.fieldAnnotation && pathTemplate.fieldAnnotation) {
              existing.fieldAnnotation = pathTemplate.fieldAnnotation;
            }
          }
        }

        if (levelIndex >= maxDepth || nestedTypeNames.length === 0) {
          continue;
        }

        const segmentsKey = segments.join("\u0000");
        let nextNode = nextNodesBySegments.get(segmentsKey);
        if (!nextNode) {
          const nextCamelCaseSegmentPositions = new Set(node.camelCaseSegmentPositions || []);
          if (field.supportsCamelCaseAccess) {
            nextCamelCaseSegmentPositions.add(segments.length - 1);
          }
          const nextIndexedSegmentPositions = new Set(node.indexedSegmentPositions || []);
          if (nestedTypeResolution.hasCollectionSubtype) {
            nextIndexedSegmentPositions.add(segments.length - 1);
          }
          nextNode = {
            segments,
            camelCaseSegmentPositions: nextCamelCaseSegmentPositions,
            indexedSegmentPositions: nextIndexedSegmentPositions,
            typeNames: new Set(),
            typePreferencesByName: new Map()
          };
          mergeTypePreferenceMaps(nextNode.typePreferencesByName, node.typePreferencesByName);
          nextNodesBySegments.set(segmentsKey, nextNode);
        } else if (nestedTypeResolution.hasCollectionSubtype) {
          nextNode.indexedSegmentPositions.add(segments.length - 1);
        }
        if (field.supportsCamelCaseAccess) {
          nextNode.camelCaseSegmentPositions.add(segments.length - 1);
        }
        mergeTypePreferenceMaps(nextNode.typePreferencesByName, nestedTypeResolution.typePreferencesByName);
        for (const nestedTypeName of nestedTypeNames) {
          nextNode.typeNames.add(nestedTypeName);
        }
      }
    }

    levels.push([...levelPathTemplatesBySignature.values()]);
    currentNodes = [...nextNodesBySegments.values()].map((node) => ({
      segments: node.segments,
      camelCaseSegmentPositions: node.camelCaseSegmentPositions,
      indexedSegmentPositions: node.indexedSegmentPositions,
      typeNames: [...node.typeNames],
      typePreferencesByName: cloneTypePreferenceMap(node.typePreferencesByName)
    }));
  }

  return sanitizeSimpleAccessTemplate({
    levels,
    firstLevel: levels[0] || [],
    secondLevel: levels[1] || []
  });
}

function bindSimpleReturnAccessTemplate(variableToken, template, fieldNameStyle = "camelcase") {
  const baseVariableToken = getVariableRootToken(variableToken);
  const levels = Array.isArray(template?.levels) ? template.levels : [];
  const boundLevels = levels.map((levelTemplates) => {
    const boundPaths = [];
    for (const levelTemplate of Array.isArray(levelTemplates) ? levelTemplates : []) {
      const segmentVariants = buildVisibleTemplateSegmentVariants(levelTemplate, fieldNameStyle);
      for (const segments of segmentVariants) {
        const accessToken = buildRobotAttributeAccessTokenWithOptions(baseVariableToken, segments, {
          includeRootIndexed: Boolean(levelTemplate?.includeRootIndexed),
          indexedSegmentPositions: new Set(levelTemplate?.indexedSegmentPositions || [])
        });
        if (accessToken) {
          boundPaths.push(accessToken);
        }
      }
    }
    return uniqueStrings(boundPaths);
  });

  return {
    firstLevel: boundLevels[0] || [],
    secondLevel: boundLevels[1] || [],
    levels: boundLevels
  };
}

function buildSimpleReturnAccessPaths(variableToken, rootTypeNames, index, options = {}) {
  const template = buildSimpleReturnAccessTemplate(rootTypeNames, index, options);
  return bindSimpleReturnAccessTemplate(
    variableToken,
    template,
    options.fieldNameStyle || getReturnFieldNameStyle()
  );
}

function buildRobotAttributeAccessTokenWithOptions(baseVariableToken, segments, options = {}) {
  const match = String(baseVariableToken || "").match(/^([@$&%])\{([^}\r\n]+)\}$/);
  if (!match) {
    return "";
  }

  const normalizedSegments = (segments || []).map((segment) => String(segment || "").trim()).filter(Boolean);
  if (normalizedSegments.length === 0) {
    return "";
  }

  const indexedSegmentPositions = normalizeIndexedSegmentPositions(
    options.indexedSegmentPositions,
    normalizedSegments.length
  );
  const normalizedPathSegments = normalizedSegments.map((segment, index) =>
    indexedSegmentPositions.has(index) ? `${segment}[0]` : segment
  );
  const rootBody = options.includeRootIndexed ? `${match[2]}[0]` : match[2];
  return `${match[1]}{${rootBody}.${normalizedPathSegments.join(".")}}`;
}

function normalizeIndexedSegmentPositions(rawIndexedPositions, segmentCount) {
  const normalized = new Set();
  const values = rawIndexedPositions instanceof Set ? [...rawIndexedPositions] : rawIndexedPositions || [];
  for (const value of values) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      continue;
    }
    const index = Math.trunc(numericValue);
    if (index < 0 || index >= segmentCount) {
      continue;
    }
    normalized.add(index);
  }
  return normalized;
}

function collectDeclaredFieldsForTypes(typeNames, index, options = {}) {
  const combinedFields = [];
  for (const typeName of uniqueStrings(typeNames || [])) {
    combinedFields.push(
      ...collectDeclaredFieldsForType(
        {
          typeName,
          displayName: typeName
        },
        index,
        new Set(),
        options
      )
    );
  }
  return dedupeFieldDescriptorsByName(combinedFields);
}

function getStructuredTypeDeclaredMembers(structuredType, options = {}) {
  const fields = Array.isArray(structuredType?.fields) ? structuredType.fields : [];
  const properties =
    options.includeProperties === false || !Array.isArray(structuredType?.properties)
      ? []
      : structuredType.properties;
  return dedupeStructuredFields(fields.concat(properties));
}

function normalizeStructuredTypeSpecifier(typeSpecifier) {
  if (typeof typeSpecifier === "string") {
    const typeName = String(typeSpecifier || "").trim();
    if (!typeName) {
      return undefined;
    }
    return {
      typeName,
      displayName: typeName,
      preferredQualifiedNames: []
    };
  }

  const typeName = String(typeSpecifier?.typeName || "").trim();
  if (!typeName) {
    return undefined;
  }

  return {
    typeName,
    displayName: String(typeSpecifier?.displayName || typeName).trim() || typeName,
    preferredQualifiedNames: uniqueStrings(
      (Array.isArray(typeSpecifier?.preferredQualifiedNames) ? typeSpecifier.preferredQualifiedNames : [])
        .map((value) => normalizeQualifiedTypeName(value))
        .filter(Boolean)
    )
  };
}

function getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames = []) {
  const selectedQualifiedName = normalizeQualifiedTypeName(selectedType?.qualifiedName || "");
  if (selectedQualifiedName) {
    return selectedQualifiedName;
  }
  const preferredQualifiedName = normalizeQualifiedTypeName(preferredQualifiedNames[0] || "");
  if (preferredQualifiedName) {
    return preferredQualifiedName;
  }
  return normalizeComparableToken(typeName);
}

function resolveInheritedStructuredTypeSpecifiers(selectedType, index) {
  const explicitRefs =
    Array.isArray(selectedType?.baseTypeRefs) && selectedType.baseTypeRefs.length > 0
      ? selectedType.baseTypeRefs
      : uniqueStrings((selectedType?.baseTypeNames || []).map((value) => String(value || "").trim())).map(
          (typeName) => ({
            typeName,
            preferredQualifiedNames: []
          })
        );
  const resolvedRefs = [];
  const seenRefs = new Set();

  for (const baseTypeRef of explicitRefs) {
    const normalizedRef = normalizeStructuredTypeSpecifier(baseTypeRef);
    if (!normalizedRef) {
      continue;
    }
    const structuredTypeCandidates = index?.structuredTypesByName?.get(normalizedRef.typeName) || [];
    const matchingCandidates =
      normalizedRef.preferredQualifiedNames.length > 0
        ? structuredTypeCandidates.filter((candidate) =>
            normalizedRef.preferredQualifiedNames.includes(normalizeQualifiedTypeName(candidate?.qualifiedName || ""))
          )
        : structuredTypeCandidates;
    const usableCandidates = matchingCandidates.length > 0 ? matchingCandidates : structuredTypeCandidates;
    if (!usableCandidates.some((candidate) => candidate?.isDataclass)) {
      continue;
    }
    const key = JSON.stringify({
      typeName: normalizeComparableToken(normalizedRef.typeName),
      preferredQualifiedNames: normalizedRef.preferredQualifiedNames
    });
    if (seenRefs.has(key)) {
      continue;
    }
    seenRefs.add(key);
    resolvedRefs.push(normalizedRef);
  }

  return resolvedRefs;
}

function collectDeclaredFieldsForType(typeSpecifier, index, visited, options = {}) {
  const normalizedSpecifier = normalizeStructuredTypeSpecifier(typeSpecifier);
  if (!normalizedSpecifier) {
    return [];
  }
  const typeName = normalizedSpecifier.typeName;
  const normalizedTypeName = normalizeComparableToken(typeName);

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [];
  }

  const preferredQualifiedNames =
    normalizedSpecifier.preferredQualifiedNames.length > 0
      ? normalizedSpecifier.preferredQualifiedNames
      : getPreferredQualifiedNamesForType(options.typePreferencesByName, typeName);
  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [];
  }
  const fieldAccessSupportsCamelCase =
    typeof options.fieldAccessSupportsCamelCase === "boolean"
      ? options.fieldAccessSupportsCamelCase
      : Boolean(selectedType.supportsCamelCaseAccess);
  const visitedKey = getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames);
  if (visited.has(visitedKey) || visited.has(normalizedTypeName)) {
    return [];
  }
  const nextVisited = new Set(visited);
  nextVisited.add(visitedKey);

  const sourceFilePath = String(selectedType.filePath || "");
  const sourceModulePath = String(selectedType.modulePath || "");
  const sourcePackagePath = String(index?.moduleInfoByFile?.get(sourceFilePath)?.packagePath || "");
  const fields = getStructuredTypeDeclaredMembers(selectedType, options)
    .filter((field) => !SIMPLE_RETURN_IGNORED_FIELD_NAMES.has(normalizeComparableToken(field.name)))
    .map((field) => ({
      ...field,
      supportsCamelCaseAccess: fieldAccessSupportsCamelCase,
      sourceFilePath,
      sourceModulePath,
      sourcePackagePath
    }));

  const inheritedFields = [];
  for (const inheritedTypeSpecifier of resolveInheritedStructuredTypeSpecifiers(selectedType, index)) {
    const inheritedVisitedKey = getStructuredTypeVisitedKey(
      inheritedTypeSpecifier.typeName,
      undefined,
      inheritedTypeSpecifier.preferredQualifiedNames
    );
    if (inheritedVisitedKey === visitedKey) {
      continue;
    }
    inheritedFields.push(
      ...collectDeclaredFieldsForType(inheritedTypeSpecifier, index, nextVisited, {
        ...options,
        fieldAccessSupportsCamelCase
      })
    );
  }

  return dedupeFieldDescriptorsByName(fields.concat(inheritedFields));
}

function dedupeFieldDescriptorsByName(fields) {
  const dedupedFields = [];
  const seenFieldsByName = new Map();
  for (const field of fields || []) {
    const normalizedName = String(field?.name || "").trim();
    if (!normalizedName) {
      continue;
    }
    const existing = seenFieldsByName.get(normalizedName);
    if (!existing) {
      seenFieldsByName.set(normalizedName, field);
      dedupedFields.push(field);
      continue;
    }
    existing.supportsCamelCaseAccess =
      Boolean(existing.supportsCamelCaseAccess) || Boolean(field.supportsCamelCaseAccess);
    if (!existing.annotation && field.annotation) {
      existing.annotation = field.annotation;
    }
  }
  return dedupedFields;
}

function buildReturnStructureLines(rootTypeNames, index, options, mode = "simple") {
  if (!Array.isArray(rootTypeNames) || rootTypeNames.length === 0) {
    return [];
  }

  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const maxDepth = Math.max(0, Number(options.maxDepth) || 0);
  const maxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(options.maxFieldsPerType, 0);
  const typePreferencesByName = cloneTypePreferenceMap(options.typePreferencesByName);
  const subtypePolicy = options.subtypePolicy || getReturnSubtypeResolutionPolicy(index);
  const lines = [];

  for (let indexOfType = 0; indexOfType < rootTypeNames.length; indexOfType += 1) {
    const typeName = rootTypeNames[indexOfType];
    if (indexOfType > 0) {
      lines.push("");
    }
    lines.push(
      ...renderIndexedTypeTree(typeName, index, 0, maxDepth, maxFieldsPerType, new Set(), normalizedMode, {
        typePreferencesByName,
        subtypePolicy,
        includeProperties: options.includeProperties !== false
      })
    );
  }

  return lines;
}

function renderIndexedTypeTree(typeSpecifier, index, depth, maxDepth, maxFieldsPerType, visited, mode, options = {}) {
  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const typePreferencesByName =
    options.typePreferencesByName instanceof Map ? options.typePreferencesByName : new Map();
  const subtypePolicy = options.subtypePolicy || getReturnSubtypeResolutionPolicy(index);
  const effectiveMaxFieldsPerType = getEffectiveReturnMaxFieldsPerType(maxFieldsPerType);
  const normalizedSpecifier = normalizeStructuredTypeSpecifier(typeSpecifier);
  if (!normalizedSpecifier) {
    return [];
  }
  const typeName = normalizedSpecifier.typeName;
  const indent = "  ".repeat(depth);
  const normalizedTypeName = normalizeComparableToken(typeName);
  const preferredQualifiedNames =
    normalizedSpecifier.preferredQualifiedNames.length > 0
      ? normalizedSpecifier.preferredQualifiedNames
      : getPreferredQualifiedNamesForType(typePreferencesByName, typeName);
  const enumCandidates = index.enumsByName?.get(typeName) || [];
  if (enumCandidates.length > 0) {
    const selectedEnum = choosePreferredEnumDefinition(enumCandidates, {
      preferredQualifiedNames
    });
    if (!selectedEnum) {
      return [`${indent}${typeName} (enum)`];
    }
    const lines = [`${indent}${typeName} (enum)`];
    const members = selectedEnum.members || [];
    const shownMembers = members.slice(0, Math.min(effectiveMaxFieldsPerType, 15));
    for (const member of shownMembers) {
      lines.push(
        normalizedMode === "technical"
          ? `${indent}  - ${formatEnumMemberForDisplay(member)}`
          : `${indent}  - ${member.name || formatEnumMemberForDisplay(member)}`
      );
    }
    if (members.length > shownMembers.length) {
      lines.push(`${indent}  ... ${members.length - shownMembers.length} more enum members`);
    }
    return lines;
  }

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [`${indent}${typeName}`];
  }

  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [`${indent}${typeName}`];
  }
  const visitedKey = getStructuredTypeVisitedKey(typeName, selectedType, preferredQualifiedNames);
  if (visited.has(visitedKey)) {
    return [`${indent}${normalizedSpecifier.displayName} (recursive)`];
  }
  const typeLabel =
    normalizedMode === "technical"
      ? `${normalizedSpecifier.displayName} (${selectedType.isDataclass ? "dataclass" : "typed class"})`
      : normalizedSpecifier.displayName;
  const lines = [`${indent}${typeLabel}`];

  const nextVisited = new Set(visited);
  nextVisited.add(visitedKey);

  const fields = getStructuredTypeDeclaredMembers(selectedType, options);
  const shownFields = fields.slice(0, effectiveMaxFieldsPerType);
  for (const field of shownFields) {
    lines.push(
      normalizedMode === "technical"
        ? `${indent}  .${field.name}`
        : `${indent}  - ${field.name}`
    );
    if (depth >= maxDepth) {
      continue;
    }

    const selectedTypeResolutionContext = buildTypeResolutionContextFromStructuredType(index, selectedType);
    const nestedTypeResolution = resolveIndexedTypesFromAnnotation(field.annotation, index, {
      policy: subtypePolicy,
      resolutionContext: selectedTypeResolutionContext
    });
    const nestedTypePreferences = cloneTypePreferenceMap(typePreferencesByName);
    mergeTypePreferenceMaps(nestedTypePreferences, nestedTypeResolution.typePreferencesByName);
    const nestedTypes = uniqueStrings(
      nestedTypeResolution.typeNames.filter(
        (nestedTypeName) => normalizeComparableToken(nestedTypeName) !== normalizedTypeName
      )
    );
    const shownNestedTypes = nestedTypes.slice(0, 2);
    for (const nestedTypeName of shownNestedTypes) {
      lines.push(
        ...renderIndexedTypeTree(
          {
            typeName: nestedTypeName,
            displayName: nestedTypeName
          },
          index,
          depth + 1,
          maxDepth,
          maxFieldsPerType,
          nextVisited,
          normalizedMode,
          {
            typePreferencesByName: nestedTypePreferences,
            subtypePolicy,
            includeProperties: options.includeProperties !== false
          }
        )
      );
    }
  }

  if (fields.length > shownFields.length) {
    lines.push(`${indent}  ... ${fields.length - shownFields.length} more fields`);
  }

  const inheritedTypeSpecifiers = resolveInheritedStructuredTypeSpecifiers(selectedType, index).filter(
    (inheritedTypeSpecifier) =>
      getStructuredTypeVisitedKey(
        inheritedTypeSpecifier.typeName,
        undefined,
        inheritedTypeSpecifier.preferredQualifiedNames
      ) !== visitedKey
  );
  if (inheritedTypeSpecifiers.length > 0) {
    if (depth >= maxDepth) {
      lines.push(
        normalizedMode === "technical"
          ? `${indent}  [inherits] ${inheritedTypeSpecifiers
              .map((inheritedTypeSpecifier) => inheritedTypeSpecifier.displayName)
              .join(", ")}`
          : `${indent}  inherits: ${inheritedTypeSpecifiers
              .map((inheritedTypeSpecifier) => inheritedTypeSpecifier.displayName)
              .join(", ")}`
      );
    } else {
      lines.push(normalizedMode === "technical" ? `${indent}  [inherits]` : `${indent}  inherits`);
      const shownInheritedTypeSpecifiers = inheritedTypeSpecifiers.slice(0, 5);
      for (const inheritedTypeSpecifier of shownInheritedTypeSpecifiers) {
        lines.push(
          ...renderIndexedTypeTree(
            inheritedTypeSpecifier,
            index,
            depth + 1,
            maxDepth,
            maxFieldsPerType,
            nextVisited,
            normalizedMode,
            {
              typePreferencesByName,
              subtypePolicy,
              includeProperties: options.includeProperties !== false
            }
          )
        );
      }
      if (inheritedTypeSpecifiers.length > shownInheritedTypeSpecifiers.length) {
        lines.push(
          `${indent}  ... ${inheritedTypeSpecifiers.length - shownInheritedTypeSpecifiers.length} more inherited types`
        );
      }
    }
  }

  return lines;
}

function choosePreferredStructuredTypeDefinition(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const preferredQualifiedNames = uniqueStrings(options.preferredQualifiedNames || []).map(
    normalizeQualifiedTypeName
  );
  const sorted = [...candidates].sort((left, right) => {
    const leftPreferenceRank = getQualifiedNamePreferenceRank(left, preferredQualifiedNames);
    const rightPreferenceRank = getQualifiedNamePreferenceRank(right, preferredQualifiedNames);
    if (leftPreferenceRank !== rightPreferenceRank) {
      return leftPreferenceRank - rightPreferenceRank;
    }

    const leftDataclassScore = left.isDataclass ? 1 : 0;
    const rightDataclassScore = right.isDataclass ? 1 : 0;
    if (leftDataclassScore !== rightDataclassScore) {
      return rightDataclassScore - leftDataclassScore;
    }

    const leftFieldCount = getStructuredTypeMemberCount(left);
    const rightFieldCount = getStructuredTypeMemberCount(right);
    if (leftFieldCount !== rightFieldCount) {
      return rightFieldCount - leftFieldCount;
    }

    const leftQualifiedName = normalizeQualifiedTypeName(left.qualifiedName);
    const rightQualifiedName = normalizeQualifiedTypeName(right.qualifiedName);
    return leftQualifiedName.localeCompare(rightQualifiedName);
  });
  return sorted[0];
}

function getStructuredTypeMemberCount(structuredType) {
  const fieldCount = Array.isArray(structuredType?.fields) ? structuredType.fields.length : 0;
  const propertyCount = Array.isArray(structuredType?.properties) ? structuredType.properties.length : 0;
  return fieldCount + propertyCount;
}

function finalizeStructuredTypeCamelCaseAccess(structuredTypesByName) {
  if (!(structuredTypesByName instanceof Map)) {
    return;
  }

  const memo = new Map();

  function computeCandidateKey(typeName, candidate) {
    const qualifiedName = normalizeQualifiedTypeName(candidate?.qualifiedName || "");
    if (qualifiedName) {
      return qualifiedName;
    }
    return [
      normalizeComparableToken(typeName),
      normalizeDependencyFilePath(candidate?.filePath || ""),
      normalizeComparableToken(candidate?.name || ""),
      uniqueStrings((candidate?.baseTypeNames || []).map((value) => normalizeComparableToken(value))).join(",")
    ].join("|");
  }

  function resolveBaseCandidates(baseTypeRef) {
    const typeName = String(baseTypeRef?.typeName || "").trim();
    if (!typeName) {
      return [];
    }
    const candidates = structuredTypesByName.get(typeName) || [];
    if (candidates.length === 0) {
      return [];
    }
    const preferredQualifiedNames = uniqueStrings(
      (Array.isArray(baseTypeRef?.preferredQualifiedNames) ? baseTypeRef.preferredQualifiedNames : [])
        .map((value) => normalizeQualifiedTypeName(value))
        .filter(Boolean)
    );
    if (preferredQualifiedNames.length === 0) {
      return candidates;
    }
    const matchingCandidates = candidates.filter((candidate) =>
      preferredQualifiedNames.includes(normalizeQualifiedTypeName(candidate?.qualifiedName || ""))
    );
    return matchingCandidates.length > 0 ? matchingCandidates : candidates;
  }

  function visitCandidate(typeName, candidate, visiting = new Set()) {
    const candidateKey = computeCandidateKey(typeName, candidate);
    if (memo.has(candidateKey)) {
      return Boolean(memo.get(candidateKey));
    }
    if (visiting.has(candidateKey)) {
      return Boolean(candidate?.supportsCamelCaseAccess);
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(candidateKey);
    let supportsCamelCaseAccess = Boolean(candidate?.supportsCamelCaseAccess);
    const baseTypeRefs =
      Array.isArray(candidate?.baseTypeRefs) && candidate.baseTypeRefs.length > 0
        ? candidate.baseTypeRefs
        : uniqueStrings((candidate?.baseTypeNames || []).map((value) => String(value || "").trim())).map((baseTypeName) => ({
            typeName: baseTypeName,
            preferredQualifiedNames: []
          }));

    for (const baseTypeRef of baseTypeRefs) {
      if (supportsCamelCaseAccess) {
        break;
      }
      const baseTypeName = String(baseTypeRef?.typeName || "").trim();
      if (!baseTypeName) {
        continue;
      }
      for (const baseCandidate of resolveBaseCandidates(baseTypeRef)) {
        if (visitCandidate(baseTypeName, baseCandidate, nextVisiting)) {
          supportsCamelCaseAccess = true;
          break;
        }
      }
    }

    candidate.supportsCamelCaseAccess = supportsCamelCaseAccess;
    memo.set(candidateKey, supportsCamelCaseAccess);
    return supportsCamelCaseAccess;
  }

  for (const [typeName, candidates] of structuredTypesByName.entries()) {
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      visitCandidate(typeName, candidate);
    }
  }
}

function choosePreferredEnumDefinition(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const preferredQualifiedNames = uniqueStrings(options.preferredQualifiedNames || []).map(
    normalizeQualifiedTypeName
  );
  const sorted = [...candidates].sort((left, right) => {
    const leftPreferenceRank = getQualifiedNamePreferenceRank(left, preferredQualifiedNames);
    const rightPreferenceRank = getQualifiedNamePreferenceRank(right, preferredQualifiedNames);
    if (leftPreferenceRank !== rightPreferenceRank) {
      return leftPreferenceRank - rightPreferenceRank;
    }

    const leftMembers = Array.isArray(left.members) ? left.members.length : 0;
    const rightMembers = Array.isArray(right.members) ? right.members.length : 0;
    if (leftMembers !== rightMembers) {
      return rightMembers - leftMembers;
    }

    const leftQualifiedName = normalizeQualifiedTypeName(left.qualifiedName);
    const rightQualifiedName = normalizeQualifiedTypeName(right.qualifiedName);
    return leftQualifiedName.localeCompare(rightQualifiedName);
  });
  return sorted[0];
}

function getQualifiedNamePreferenceRank(candidate, preferredQualifiedNames) {
  const normalizedQualifiedName = normalizeQualifiedTypeName(candidate?.qualifiedName || "");
  if (!normalizedQualifiedName || !Array.isArray(preferredQualifiedNames) || preferredQualifiedNames.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const index = preferredQualifiedNames.indexOf(normalizedQualifiedName);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function findOwnerForLine(owners, line) {
  if (!Array.isArray(owners)) {
    return undefined;
  }
  return owners.find((owner) => line >= owner.startLine && line <= owner.endLine);
}

function findLatestAssignmentBeforeLine(assignments, line) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return undefined;
  }
  const targetLine = Number.isFinite(Number(line)) ? Number(line) : Number.MAX_SAFE_INTEGER;
  let left = 0;
  let right = assignments.length - 1;
  let best = -1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const assignmentLine = Number(assignments[middle]?.startLine);
    if (!Number.isFinite(assignmentLine)) {
      left = middle + 1;
      continue;
    }
    if (assignmentLine <= targetLine) {
      best = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return best >= 0 ? assignments[best] : undefined;
}

function getBranchPathForLine(parsed, line) {
  const paths = Array.isArray(parsed?.branchPathByLine) ? parsed.branchPathByLine : [];
  return cloneBranchPath(paths[Math.max(0, Number(line) || 0)]);
}

function getVariableAssignmentsForOwner(parsed, runtimeLookups, ownerId, normalizedVariable) {
  if (!ownerId || !normalizedVariable) {
    return [];
  }
  if (runtimeLookups) {
    const ownerMap = runtimeLookups.variableAssignmentsByOwnerAndVariable?.get(ownerId);
    return [...(ownerMap?.get(normalizedVariable) || [])];
  }

  return (parsed?.variableAssignments || []).filter(
    (assignment) => assignment.ownerId === ownerId && assignment.normalizedVariable === normalizedVariable
  );
}

function getKeywordReturnAssignmentsForOwner(parsed, runtimeLookups, ownerId, normalizedVariable) {
  if (!ownerId || !normalizedVariable) {
    return [];
  }
  if (runtimeLookups) {
    const ownerMap = runtimeLookups.keywordAssignmentsByOwnerAndVariable?.get(ownerId);
    return [...(ownerMap?.get(normalizedVariable) || [])].filter(
      (assignment) => normalizeKeywordName(assignment?.keywordName || "") !== "setvariable"
    );
  }

  return (parsed?.keywordCallAssignments || []).filter(
    (assignment) =>
      assignment.ownerId === ownerId &&
      normalizeKeywordName(assignment.keywordName || "") !== "setvariable" &&
      Array.isArray(assignment.normalizedReturnVariables) &&
      assignment.normalizedReturnVariables.includes(normalizedVariable)
  );
}

function buildVariableDefinitionEntries(parsed, runtimeLookups, ownerId, normalizedVariable) {
  return buildVariableDefinitionEntriesFromSources(
    getVariableAssignmentsForOwner(parsed, runtimeLookups, ownerId, normalizedVariable),
    getKeywordReturnAssignmentsForOwner(parsed, runtimeLookups, ownerId, normalizedVariable),
    normalizedVariable
  );
}

function findBranchFrameByGroupId(branchPath, groupId) {
  return (Array.isArray(branchPath) ? branchPath : []).find((frame) => String(frame?.groupId || "") === String(groupId || ""));
}

function areBranchPathsEqual(left, right) {
  const leftPath = Array.isArray(left) ? left : [];
  const rightPath = Array.isArray(right) ? right : [];
  if (leftPath.length !== rightPath.length) {
    return false;
  }
  for (let index = 0; index < leftPath.length; index += 1) {
    if (
      String(leftPath[index]?.groupId || "") !== String(rightPath[index]?.groupId || "") ||
      String(leftPath[index]?.branchId || "") !== String(rightPath[index]?.branchId || "")
    ) {
      return false;
    }
  }
  return true;
}

function findLatestAssignmentForBranchPathBefore(assignments, branchPath, beforeLine) {
  const safeBeforeLine = Number(beforeLine);
  if (!Number.isFinite(safeBeforeLine)) {
    return undefined;
  }

  let latest = undefined;
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const assignmentLine = Number(assignment?.startLine);
    if (!Number.isFinite(assignmentLine) || assignmentLine >= safeBeforeLine) {
      continue;
    }
    if (!areBranchPathsEqual(assignment?.branchPath, branchPath)) {
      continue;
    }
    if (!latest || assignmentLine > Number(latest?.startLine)) {
      latest = assignment;
    }
  }
  return latest;
}

function isAssignmentCompatibleWithBranchPath(assignment, branchPath) {
  const assignmentPath = Array.isArray(assignment?.branchPath) ? assignment.branchPath : [];
  const activePath = Array.isArray(branchPath) ? branchPath : [];
  for (const frame of assignmentPath) {
    const activeFrame = findBranchFrameByGroupId(activePath, frame.groupId);
    if (activeFrame && String(activeFrame.branchId || "") !== String(frame?.branchId || "")) {
      return false;
    }
  }
  return true;
}

function getDeepestInactiveBranchFrame(branchPath, activePath) {
  const frames = Array.isArray(branchPath) ? branchPath : [];
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    const activeFrame = findBranchFrameByGroupId(activePath, frame.groupId);
    if (!activeFrame) {
      return {
        frame,
        index
      };
    }
  }
  return undefined;
}

function resolveVariableAssignmentSelectionFromAssignments(assignments, line, activeBranchPath) {
  const compatibleAssignments = (Array.isArray(assignments) ? assignments : []).filter(
    (assignment) =>
      Number(assignment?.startLine) <= Number(line) && isAssignmentCompatibleWithBranchPath(assignment, activeBranchPath)
  );
  if (compatibleAssignments.length === 0) {
    return undefined;
  }

  compatibleAssignments.sort((left, right) => Number(left?.startLine) - Number(right?.startLine));
  const latestAssignment = compatibleAssignments[compatibleAssignments.length - 1];
  const inactiveFrameInfo = getDeepestInactiveBranchFrame(latestAssignment?.branchPath, activeBranchPath);
  if (!inactiveFrameInfo?.frame?.groupId) {
    return {
      kind: "single",
      assignment: latestAssignment
    };
  }

  const parentPath = cloneBranchPath((latestAssignment.branchPath || []).slice(0, inactiveFrameInfo.index));
  const branchEntries = new Map();

  for (const assignment of compatibleAssignments) {
    const assignmentPath = Array.isArray(assignment?.branchPath) ? assignment.branchPath : [];
    const targetIndex = assignmentPath.findIndex(
      (frame) => String(frame?.groupId || "") === String(inactiveFrameInfo.frame.groupId || "")
    );
    if (targetIndex < 0) {
      continue;
    }
    if (!areBranchPathsEqual(assignmentPath.slice(0, targetIndex), parentPath)) {
      continue;
    }
    const branchFrame = assignmentPath[targetIndex];
    const branchId = String(branchFrame?.branchId || "");
    if (!branchId) {
      continue;
    }
    const existing = branchEntries.get(branchId);
    if (!existing || Number(branchFrame?.startLine || 0) < Number(existing.orderLine || Number.MAX_SAFE_INTEGER)) {
      branchEntries.set(branchId, {
        branchFrame,
        orderLine: Number(assignment?.startLine) || 0
      });
    }
  }

  const branchResults = [];
  const orderedBranchEntries = [...branchEntries.values()].sort((left, right) => left.orderLine - right.orderLine);
  for (const branchEntry of orderedBranchEntries) {
    const branchResult = resolveVariableAssignmentSelectionFromAssignments(assignments, line, [
      ...parentPath,
      {
        groupId: String(branchEntry.branchFrame?.groupId || ""),
        branchId: String(branchEntry.branchFrame?.branchId || "")
      }
    ]);
    if (!branchResult) {
      continue;
    }
    if (branchResult.kind === "single" && branchResult.assignment) {
      branchResults.push(branchResult.assignment);
      continue;
    }
    for (const candidate of branchResult.candidates || []) {
      if (candidate?.assignment) {
        branchResults.push(candidate.assignment);
      }
    }
  }

  if (orderedBranchEntries.length === 1) {
    const parentFallback = findLatestAssignmentForBranchPathBefore(
      compatibleAssignments,
      parentPath,
      branchResults[0]?.startLine ?? latestAssignment?.startLine
    );
    if (parentFallback) {
      branchResults.push(parentFallback);
    }
  }

  const uniqueAssignments = [];
  const seenAssignmentIds = new Set();
  for (const assignment of branchResults) {
    const key = String(assignment?.id || "");
    if (!key || seenAssignmentIds.has(key)) {
      continue;
    }
    seenAssignmentIds.add(key);
    uniqueAssignments.push(assignment);
  }

  if (uniqueAssignments.length <= 1) {
    return {
      kind: "single",
      assignment: uniqueAssignments[0] || latestAssignment
    };
  }

  return {
    kind: "conditional",
    candidates: uniqueAssignments
      .sort((left, right) => Number(left?.startLine) - Number(right?.startLine))
      .map((assignment) => ({
        assignment
      }))
  };
}

function resolveVariableAssignmentSelection(parsed, runtimeLookups, ownerId, normalizedVariable, line) {
  if (!ownerId || !normalizedVariable) {
    return undefined;
  }
  return resolveVariableAssignmentSelectionFromAssignments(
    buildVariableDefinitionEntries(parsed, runtimeLookups, ownerId, normalizedVariable),
    line,
    getBranchPathForLine(parsed, line)
  );
}

function findLatestVariableAssignmentForOwner(parsed, ownerId, normalizedVariable, line) {
  if (!parsed || !ownerId || !normalizedVariable) {
    return undefined;
  }
  const resolved = resolveVariableAssignmentSelectionFromAssignments(
    getVariableAssignmentsForOwner(parsed, undefined, ownerId, normalizedVariable),
    line,
    getBranchPathForLine(parsed, line)
  );
  return resolved?.kind === "single" ? resolved.assignment : undefined;
}

function findLatestVariableAssignmentForOwnerFromLookups(parsed, runtimeLookups, ownerId, normalizedVariable, line) {
  if (!parsed || !runtimeLookups || !ownerId || !normalizedVariable) {
    return undefined;
  }
  const resolved = resolveVariableAssignmentSelectionFromAssignments(
    getVariableAssignmentsForOwner(parsed, runtimeLookups, ownerId, normalizedVariable),
    line,
    getBranchPathForLine(parsed, line)
  );
  return resolved?.kind === "single" ? resolved.assignment : undefined;
}

function findLatestKeywordCallAssignmentForOwner(parsed, ownerId, normalizedVariable, line) {
  if (!parsed || !ownerId || !normalizedVariable) {
    return undefined;
  }
  let selectedAssignment = undefined;
  for (const assignment of parsed.keywordCallAssignments || []) {
    if (assignment.ownerId !== ownerId) {
      continue;
    }
    if (!Array.isArray(assignment.normalizedReturnVariables)) {
      continue;
    }
    if (!assignment.normalizedReturnVariables.includes(normalizedVariable)) {
      continue;
    }
    if (assignment.startLine > line) {
      continue;
    }
    if (!selectedAssignment || assignment.startLine > selectedAssignment.startLine) {
      selectedAssignment = assignment;
    }
  }
  return selectedAssignment;
}

function findLatestKeywordCallAssignmentForOwnerFromLookups(runtimeLookups, ownerId, normalizedVariable, line) {
  if (!runtimeLookups || !ownerId || !normalizedVariable) {
    return undefined;
  }
  const ownerMap = runtimeLookups.keywordAssignmentsByOwnerAndVariable?.get(ownerId);
  const assignments = ownerMap?.get(normalizedVariable) || [];
  return findLatestAssignmentBeforeLine(assignments, line);
}

function buildReturnContextCacheKey(variableContext, maxDepth, maxFieldsPerType, includeTechnical = true) {
  const normalizedMaxFieldsPerType = normalizeReturnMaxFieldsPerTypeValue(maxFieldsPerType, 0);
  return [
    "return",
    String(variableContext?.owner?.id || ""),
    String(variableContext?.assignment?.id || ""),
    normalizeVariableLookupToken(variableContext?.variableToken?.token || ""),
    Math.max(0, Number(maxDepth) || 0),
    serializeReturnMaxFieldsPerType(normalizedMaxFieldsPerType),
    getReturnFieldNameStyle(),
    getReturnIncludeProperties() ? "1" : "0",
    includeTechnical ? "full" : "simple",
    getReturnTechnicalMaxDepth(),
    getReturnTechnicalMaxFieldsPerType(),
    getReturnSubtypeResolutionMode(),
    getReturnSubtypeIncludeContainers().join(","),
    getReturnSubtypeExcludeContainers().join(",")
  ].join("|");
}

function buildReturnHintContextCacheKey(ownerId, normalizedVariable, assignmentId, maxDepth) {
  return [
    "return-hint",
    String(ownerId || ""),
    String(normalizedVariable || ""),
    String(assignmentId || ""),
    Math.max(1, Number(maxDepth) || 1),
    serializeReturnMaxFieldsPerType(getReturnMaxFieldsPerType()),
    getReturnFieldNameStyle(),
    getReturnIncludeProperties() ? "1" : "0",
    getReturnSubtypeResolutionMode(),
    getReturnSubtypeIncludeContainers().join(","),
    getReturnSubtypeExcludeContainers().join(",")
  ].join("|");
}

function buildEnumPreviewContextCacheKey(context, referenceLine, options = {}) {
  const maxEnums = Math.max(1, Number(options.maxEnums) || getEnumHoverMaxEnums());
  const maxMembers = Math.max(1, Number(options.maxMembers) || getEnumHoverMaxMembers());
  const hoveredVariableToken =
    getHoveredVariableTokenFromArgumentValueContext(
      context,
      Number.isFinite(Number(options.hoverCharacter)) ? Number(options.hoverCharacter) : undefined
    )?.token || "";
  return [
    "enum",
    normalizeKeywordName(context.keywordName),
    normalizeArgumentName(context.argumentName),
    String(context.argumentValue || ""),
    hoveredVariableToken,
    Math.max(0, Number(referenceLine) || 0),
    options.showArgumentAssignment === false ? "0" : "1",
    options.showResolvedCurrentValue === false ? "0" : "1",
    options.showCurrentMemberMarker === false ? "0" : "1",
    isEnumArgumentFallbackEnabled() ? "1" : "0",
    maxEnums,
    maxMembers
  ].join("|");
}

function buildTypedVariableCompletionCacheKey(
  owner,
  line,
  normalizedKeyword,
  normalizedArgument,
  expectedTypeNames
) {
  return [
    "typed-completion",
    String(owner?.id || ""),
    Math.max(0, Number(line) || 0),
    String(normalizedKeyword || ""),
    String(normalizedArgument || ""),
    (expectedTypeNames || []).join(",")
  ].join("|");
}

function buildReturnMemberCompletionCacheKey(
  owner,
  line,
  assignment,
  normalizedRootVariable,
  pathSegments,
  activeSegment,
  completionMaxDepth
) {
  return [
    "return-member-completion",
    String(owner?.id || ""),
    Math.max(0, Number(line) || 0),
    String(assignment?.id || ""),
    String(normalizedRootVariable || ""),
    (Array.isArray(pathSegments) ? pathSegments : []).join("."),
    String(activeSegment || ""),
    Math.max(1, Number(completionMaxDepth) || 1),
    getReturnPreviewMaxDepth(),
    serializeReturnMaxFieldsPerType(getReturnMaxFieldsPerType()),
    getReturnFieldNameStyle(),
    getReturnIncludeProperties() ? "1" : "0",
    getReturnTechnicalMaxDepth(),
    getReturnTechnicalMaxFieldsPerType(),
    getReturnSubtypeResolutionMode(),
    getReturnSubtypeIncludeContainers().join(","),
    getReturnSubtypeExcludeContainers().join(",")
  ].join("|");
}

function serializeTypePreferenceMapEntries(typePreferencesByName) {
  if (!(typePreferencesByName instanceof Map)) {
    return [];
  }
  const entries = [];
  for (const [typeName, qualifiedNames] of typePreferencesByName.entries()) {
    const normalizedTypeName = normalizeComparableToken(typeName);
    if (!normalizedTypeName) {
      continue;
    }
    const normalizedQualifiedNames = uniqueStrings(
      (qualifiedNames || []).map((value) => normalizeQualifiedTypeName(value)).filter(Boolean)
    );
    entries.push([normalizedTypeName, normalizedQualifiedNames]);
  }
  return entries;
}

function serializeSubtypePolicy(policy) {
  return {
    mode: String(policy?.mode || "always"),
    includeSet: [...(policy?.includeSet || [])].map((value) => String(value || "")),
    excludeSet: [...(policy?.excludeSet || [])].map((value) => String(value || "")),
    collectionContainers: [...(policy?.collectionContainers || [])].map((value) => String(value || ""))
  };
}

function serializeReturnWorkerIndexSnapshot(index) {
  return {
    structuredTypesByName: serializeMapEntries(index?.structuredTypesByName, (candidates) =>
      (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
        name: String(candidate?.name || ""),
        filePath: String(candidate?.filePath || ""),
        modulePath: String(candidate?.modulePath || ""),
        qualifiedName: String(candidate?.qualifiedName || ""),
        isDataclass: Boolean(candidate?.isDataclass),
        isIndexableWrapper: Boolean(candidate?.isIndexableWrapper),
        supportsCamelCaseAccess: Boolean(candidate?.supportsCamelCaseAccess),
        baseTypeNames: uniqueStrings((candidate?.baseTypeNames || []).map((value) => String(value || ""))),
        baseTypeRefs: (Array.isArray(candidate?.baseTypeRefs) ? candidate.baseTypeRefs : [])
          .map((baseTypeRef) => {
            const typeName = String(baseTypeRef?.typeName || "").trim();
            const preferredQualifiedNames = uniqueStrings(
              (Array.isArray(baseTypeRef?.preferredQualifiedNames) ? baseTypeRef.preferredQualifiedNames : [])
                .map((value) => String(value || "").trim())
                .filter(Boolean)
            );
            if (!typeName) {
              return undefined;
            }
            return {
              typeName,
              preferredQualifiedNames
            };
          })
          .filter(Boolean),
        fields: (candidate?.fields || []).map((field) => ({
          name: String(field?.name || ""),
          annotation: String(field?.annotation || "")
        })),
        properties: (candidate?.properties || []).map((field) => ({
          name: String(field?.name || ""),
          annotation: String(field?.annotation || "")
        }))
      }))
    ),
    enumsByName: serializeMapEntries(index?.enumsByName, (candidates) =>
      (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
        name: String(candidate?.name || ""),
        filePath: String(candidate?.filePath || ""),
        qualifiedName: String(candidate?.qualifiedName || ""),
        members: (candidate?.members || []).map((member) => ({
          name: String(member?.name || ""),
          valueLiteral: String(member?.valueLiteral || "")
        }))
      }))
    ),
    structuredTypesByQualifiedNameKeys: [...(index?.structuredTypesByQualifiedName?.keys?.() || [])].map((value) =>
      String(value || "")
    ),
    enumsByQualifiedNameKeys: [...(index?.enumsByQualifiedName?.keys?.() || [])].map((value) =>
      String(value || "")
    ),
    moduleInfoByFile: serializeMapEntries(index?.moduleInfoByFile, (moduleInfo) => ({
      modulePath: String(moduleInfo?.modulePath || ""),
      packagePath: String(moduleInfo?.packagePath || "")
    })),
    localStructuredTypeNamesByFile: serializeMapEntries(index?.localStructuredTypeNamesByFile, (names) =>
      uniqueStrings([...(names || [])].map((value) => String(value || "")))
    ),
    localEnumNamesByFile: serializeMapEntries(index?.localEnumNamesByFile, (names) =>
      uniqueStrings([...(names || [])].map((value) => String(value || "")))
    ),
    typeImportAliasesByFile: serializeMapEntries(index?.typeImportAliasesByFile, (aliasMap) =>
      serializeMapEntries(aliasMap, (specs) =>
        (Array.isArray(specs) ? specs : []).map((spec) => ({
          modulePath: String(spec?.modulePath || ""),
          symbolName: String(spec?.symbolName || "")
        }))
      )
    ),
    moduleImportAliasesByFile: serializeMapEntries(index?.moduleImportAliasesByFile, (aliasMap) =>
      serializeMapEntries(aliasMap, (modulePath) => String(modulePath || ""))
    )
  };
}

function serializeMapEntries(source, valueMapper = (value) => value) {
  if (!(source instanceof Map)) {
    return [];
  }
  const entries = [];
  for (const [key, value] of source.entries()) {
    entries.push([String(key || ""), valueMapper(value)]);
  }
  return entries;
}

function computeReturnWorkerSnapshotFingerprint(snapshot) {
  const serializedSnapshot = JSON.stringify(snapshot || {});
  return crypto.createHash("sha256").update(serializedSnapshot).digest("hex");
}

function sanitizePersistedTypeCacheEntries(entries) {
  const sanitizedEntries = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const cacheKey = String(entry?.key || "");
    const cacheEntry = sanitizePersistedTypeCacheEntry(entry?.entry);
    if (!cacheKey || !cacheEntry) {
      continue;
    }
    sanitizedEntries.push({
      key: cacheKey,
      entry: cacheEntry
    });
  }
  return sanitizedEntries;
}

function sanitizePersistedTypeCacheEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const simpleAccessTemplate = sanitizeSimpleAccessTemplate(entry?.simpleAccessTemplate);
  return {
    simpleAccessTemplate,
    technicalStructureLines: (Array.isArray(entry?.technicalStructureLines)
      ? entry.technicalStructureLines
      : []
    ).map((value) => String(value || "")),
    dependencyFilePaths: uniqueStrings(
      (Array.isArray(entry?.dependencyFilePaths) ? entry.dependencyFilePaths : [])
        .map((value) => normalizeCacheDependencyFilePath(value))
        .filter(Boolean)
    )
  };
}

function normalizeCacheDependencyFilePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/");
}

function isFileNotFoundError(error) {
  const code = String(error?.code || "").toLowerCase();
  if (code === "filenotfound" || code === "enoent") {
    return true;
  }
  const message = String(error?.message || "").toLowerCase();
  return message.includes("filenotfound") || message.includes("no such file");
}

function getRuntimeCacheSettingsSignature() {
  return JSON.stringify({
    enumFallback: isEnumArgumentFallbackEnabled(),
    enumMaxEnums: getEnumHoverMaxEnums(),
    enumMaxMembers: getEnumHoverMaxMembers(),
    returnMemberCompletionsEnabled: isReturnMemberCompletionsEnabled(),
    returnSubtypeMode: getReturnSubtypeResolutionMode(),
    returnSubtypeInclude: getReturnSubtypeIncludeContainers(),
    returnSubtypeExclude: getReturnSubtypeExcludeContainers(),
    returnMaxFieldsPerType: getReturnMaxFieldsPerType(),
    returnHintArgumentMaxDepth: getReturnHintArgumentMaxDepth(),
    returnPreviewMaxDepth: getReturnPreviewMaxDepth(),
    returnMemberCompletionMaxDepth: getReturnMemberCompletionMaxDepth(),
    returnTechnicalMaxDepth: getReturnTechnicalMaxDepth(),
    returnTechnicalMaxFieldsPerType: getReturnTechnicalMaxFieldsPerType(),
    returnTypeDiskCacheEnabled: isReturnTypeDiskCacheEnabled(),
    returnTypeCacheMaxEntries: getReturnTypeCacheMaxEntries()
  });
}

function getMinChangedLine(contentChanges) {
  if (!Array.isArray(contentChanges) || contentChanges.length === 0) {
    return undefined;
  }
  let minLine = Number.POSITIVE_INFINITY;
  for (const change of contentChanges) {
    const line = Number(change?.range?.start?.line);
    if (Number.isFinite(line)) {
      minLine = Math.min(minLine, line);
    }
  }
  if (!Number.isFinite(minLine)) {
    return undefined;
  }
  return minLine;
}

function isStructuralRobotDocumentChange(contentChanges) {
  if (!Array.isArray(contentChanges) || contentChanges.length === 0) {
    return false;
  }
  for (const change of contentChanges) {
    const text = String(change?.text || "");
    const startLine = Number(change?.range?.start?.line);
    const endLine = Number(change?.range?.end?.line);
    if (text.includes("\n") || (Number.isFinite(startLine) && Number.isFinite(endLine) && endLine !== startLine)) {
      return true;
    }
    if (/^\s*\*{3}\s*[^*]+\s*\*{3}\s*$/m.test(text)) {
      return true;
    }
    if (/^\s*\[[A-Za-z ]+\]/m.test(text)) {
      return true;
    }
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function isHoverCancellationRequested(token) {
  return Boolean(token && token.isCancellationRequested);
}

async function waitForHoverFallbackWindow(token) {
  if (isHoverCancellationRequested(token)) {
    return false;
  }
  if (HOVER_CACHE_MISS_FALLBACK_DELAY_MS <= 0) {
    return !isHoverCancellationRequested(token);
  }
  await delay(HOVER_CACHE_MISS_FALLBACK_DELAY_MS);
  return !isHoverCancellationRequested(token);
}

function getVariableTokenAtPosition(lineText, character) {
  const source = String(lineText || "");
  const pattern = /[$@&%]\{[^}\r\n]+\}/g;
  let match = pattern.exec(source);

  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character < end) {
      return {
        token: match[0],
        start,
        end
      };
    }
    match = pattern.exec(source);
  }

  return undefined;
}

function normalizeVariableToken(variableToken) {
  return String(variableToken || "").trim().toLowerCase();
}

function isLocalVariableCurrentValueSource(source) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  return normalizedSource === "local-variable" || normalizedSource === "set-variable";
}

function getLocalVariableAssignmentSourceLabel(source) {
  const label = String(source?.sourceLabel || source?.currentValueSourceLabel || "").trim();
  return label || "Set Variable";
}

function getVariableRootToken(variableToken) {
  const source = String(variableToken || "").trim();
  const match = source.match(/^([@$&%]\{)([^}\r\n]+)\}$/);
  if (!match) {
    return source;
  }

  const prefix = match[1];
  const body = match[2].trim();
  if (!body) {
    return source;
  }

  let root = body.split(/[.\[]/, 1)[0].trim();
  const typedRootMatch = root.match(/^(.*?)\s*:\s+.+$/);
  if (typedRootMatch) {
    root = String(typedRootMatch[1] || "").trim();
  }
  if (!root) {
    return source;
  }

  return `${prefix}${root}}`;
}

function normalizeVariableLookupToken(variableToken) {
  return normalizeVariableToken(getVariableRootToken(variableToken));
}

function stripInlineRobotComment(value) {
  return String(value || "").replace(/\s{2,}#.*$/, "");
}

async function createEnumValueHover(
  document,
  position,
  enumHintService,
  parsed,
  runtimeCacheService,
  options = {}
) {
  if (isHoverCancellationRequested(options.cancellationToken)) {
    return undefined;
  }
  const context = await resolveEnumValuePreview(document, position, enumHintService, {
    parsed,
    maxEnums: getEnumHoverMaxEnums(),
    maxMembers: getEnumHoverMaxMembers(),
    runtimeCache: runtimeCacheService,
    cacheOnly: options.cacheOnly === true,
    cancellationToken: options.cancellationToken,
    returnComputeWorker: options.returnComputeWorker
  });
  if (isHoverCancellationRequested(options.cancellationToken)) {
    return undefined;
  }
  if (!context) {
    return undefined;
  }

  const shownEnums = context.shownEnums;
  const annotationHints = context.annotationHints || [];
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: [CMD_OPEN_LOCATION]
  };
  markdown.supportHtml = false;
  const currentValueKind = String(context.currentValueKind || "single").trim().toLowerCase();
  const currentValueCandidates = Array.isArray(context.currentValueCandidates) ? context.currentValueCandidates : [];
  const resolvedCurrentValue = String(context.currentValue || context.argumentValue || "");
  const normalizedCurrentValue = resolvedCurrentValue.toLowerCase();
  const resolvedCurrentValueDisplay = resolvedCurrentValue.length > 0 ? resolvedCurrentValue : "(empty)";
  let resolvedEnumMemberDisplay = "";
  let resolvedMember = undefined;
  for (const enumEntry of shownEnums) {
    const matchingMembers = getEnumMatchingMembers(enumEntry, normalizedCurrentValue);
    if (matchingMembers.length === 0) {
      continue;
    }
    resolvedMember = matchingMembers[0];
    resolvedEnumMemberDisplay = `${enumEntry.name}: ${formatEnumMemberForDisplay(resolvedMember)}`;
    break;
  }
  let topResolvedCurrentValueDisplay = resolvedCurrentValueDisplay;
  if (resolvedMember) {
    const memberName = String(resolvedMember.name || "").trim();
    const memberValue = String(resolvedMember.valueLiteral || "").trim();
    if (
      memberName.length > 0 &&
      memberValue.length > 0 &&
      memberValue.toLowerCase() !== memberName.toLowerCase()
    ) {
      if (normalizedCurrentValue === memberName.toLowerCase()) {
        topResolvedCurrentValueDisplay = `${resolvedCurrentValueDisplay} (= ${memberValue})`;
      } else if (normalizedCurrentValue === memberValue.toLowerCase()) {
        topResolvedCurrentValueDisplay = `${resolvedCurrentValueDisplay} (= ${memberName})`;
      } else {
        topResolvedCurrentValueDisplay = `${resolvedCurrentValueDisplay} (${memberName} = ${memberValue})`;
      }
    }
  }
  markdown.appendMarkdown(shownEnums.length > 0 ? "### Robot Enum Hint\n\n" : "### Robot Argument Hint\n\n");
  if (currentValueKind === "conditional" && currentValueCandidates.length > 0) {
    markdown.appendMarkdown("**Current value (conditional):**\n");
    for (const candidate of currentValueCandidates) {
      const sourceLineNumber =
        Number.isFinite(Number(candidate?.sourceLine)) && Number(candidate.sourceLine) >= 0
          ? Number(candidate.sourceLine) + 1
          : undefined;
      const displayValue = String(candidate?.value || "").trim() || "(empty)";
      markdown.appendMarkdown(`- \`${escapeMarkdownInline(displayValue)}\``);
      if (sourceLineNumber) {
        markdown.appendMarkdown(
          ` from \`${escapeMarkdownInline(getLocalVariableAssignmentSourceLabel(candidate))}\` line ${sourceLineNumber}`
        );
        const sourceCommand = buildOpenLocationCommandUri(document.uri.toString(), Number(candidate.sourceLine));
        if (sourceCommand) {
          markdown.appendMarkdown(
            `  \n  [Jump to ${escapeMarkdownInline(getLocalVariableAssignmentSourceLabel(candidate))} line ${sourceLineNumber}](${sourceCommand})`
          );
        }
      }
      markdown.appendMarkdown("\n");
    }
    markdown.appendMarkdown("\n");
  } else {
    markdown.appendMarkdown("**Current value (resolved):**  \n");
    markdown.appendMarkdown(`🟢 \`${escapeMarkdownInline(topResolvedCurrentValueDisplay)}\`\n\n`);
  }
  markdown.appendMarkdown("**Keyword:** ");
  markdown.appendText(context.keywordName);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Argument:** ");
  markdown.appendText(context.argumentName);
  markdown.appendMarkdown("  \n");
  if (
    currentValueKind !== "conditional" &&
    String(context.currentValue || "").trim() !== String(context.argumentValue || "").trim()
  ) {
    markdown.appendMarkdown("**Argument value:** ");
    markdown.appendText(context.argumentValue);
    markdown.appendMarkdown("  \n");
  }
  if (
    currentValueKind !== "conditional" &&
    isLocalVariableCurrentValueSource(context.currentValueSource) &&
    Number.isFinite(Number(context.currentValueSourceLine)) &&
    Number(context.currentValueSourceLine) >= 0
  ) {
    const sourceLineNumber = Number(context.currentValueSourceLine) + 1;
    const currentValueSourceLabel = getLocalVariableAssignmentSourceLabel(context);
    markdown.appendMarkdown("**Value source:** ");
    markdown.appendMarkdown(`\`${escapeMarkdownInline(currentValueSourceLabel)}\` line ${sourceLineNumber}`);
    const setVariableCommand = buildOpenLocationCommandUri(context.documentUri, Number(context.currentValueSourceLine));
    if (setVariableCommand) {
      markdown.appendMarkdown(`  \n[Jump to ${escapeMarkdownInline(currentValueSourceLabel)} line ${sourceLineNumber}](${setVariableCommand})`);
    }
    markdown.appendMarkdown("\n\n");
  }

  if (resolvedEnumMemberDisplay) {
    markdown.appendMarkdown("**Resolved enum member:** ");
    markdown.appendText(resolvedEnumMemberDisplay);
    markdown.appendMarkdown("\n\n");
  }

  const provenanceNote = getEnumMatchProvenanceNote(context);
  if (provenanceNote) {
    markdown.appendMarkdown(`${provenanceNote}\n\n`);
  }
  if ((Number(context.duplicateCandidateCount) || 0) > 0) {
    const duplicateCount = Number(context.duplicateCandidateCount) || 0;
    markdown.appendMarkdown(
      `_Collapsed ${duplicateCount} duplicate enum definition${duplicateCount === 1 ? "" : "s"} with identical members._\n\n`
    );
  }

  if (annotationHints.length > 0) {
    markdown.appendMarkdown(annotationHints.length > 1 ? "**Type hints:**\n" : "**Type hint:**\n");
    markdown.appendCodeblock(annotationHints.join("\n"), "python");
    markdown.appendMarkdown("\n");
  }

  const maxMembers = context.maxMembers;
  for (const enumEntry of shownEnums) {
    markdown.appendMarkdown("**Enum:** ");
    markdown.appendText(enumEntry.name);
    markdown.appendMarkdown("  \n");

    const members = enumEntry.members || [];
    const shownMembers = members.slice(0, maxMembers);
    const memberLines = shownMembers.map((member) => {
      const display = formatEnumMemberForDisplay(member);
      return isEnumMemberMatch(member, normalizedCurrentValue) ? `${display}  <= current` : display;
    });
    markdown.appendCodeblock(memberLines.join("\n"), "text");

    const matchingMembers = getEnumMatchingMembers(enumEntry, normalizedCurrentValue);
    if (matchingMembers.length > 0) {
      markdown.appendMarkdown(
        `_Current resolves to: \`${formatEnumMemberForDisplay(matchingMembers[0])}\`._\n\n`
      );
    }

    if (members.length > shownMembers.length) {
      markdown.appendMarkdown(
        `_Showing first ${shownMembers.length} of ${members.length} members for ${enumEntry.name}._\n\n`
      );
    } else {
      markdown.appendMarkdown("\n");
    }

    if (!doesEnumContainValue(enumEntry, normalizedCurrentValue)) {
      markdown.appendMarkdown("_Current value is not an exact member match in this enum._\n\n");
    }
  }

  if (shownEnums.length > 0 && context.candidates.length > shownEnums.length) {
    markdown.appendMarkdown(
      `_Showing ${shownEnums.length} of ${context.candidates.length} matching enum candidates._`
    );
  }

  if (context.returnHintContext && !isRedundantReturnHint(context)) {
    markdown.appendMarkdown("\n\n**Return hint for argument value:**  \n");
    markdown.appendMarkdown("**Keyword:** ");
    markdown.appendText(context.returnHintContext.assignment.keywordName);
    markdown.appendMarkdown("  \n");

    const sourceLine = Number(context.returnHintContext.sourceLine);
    if (Number.isFinite(sourceLine) && sourceLine >= 0) {
      const sourceLineNumber = sourceLine + 1;
      markdown.appendMarkdown("**Set at line:** ");
      markdown.appendText(String(sourceLineNumber));
      const locationCommand = buildOpenLocationCommandUri(
        context.returnHintContext.sourceUri || context.documentUri,
        sourceLine
      );
      const shouldSuppressReturnHintJump =
        isLocalVariableCurrentValueSource(context.currentValueSource) &&
        Number.isFinite(Number(context.currentValueSourceLine)) &&
        Number(context.currentValueSourceLine) >= 0 &&
        sourceLine === Number(context.currentValueSourceLine);
      if (locationCommand && !shouldSuppressReturnHintJump) {
        markdown.appendMarkdown(`  \n[Jump to assignment line ${sourceLineNumber}](${locationCommand})`);
      }
      markdown.appendMarkdown("\n\n");
    } else {
      markdown.appendMarkdown("\n\n");
    }

    if (context.returnHintContext.returnAnnotation) {
      markdown.appendMarkdown("**Return annotation:**\n");
      markdown.appendCodeblock(context.returnHintContext.returnAnnotation, "python");
    }

    const returnHintAccessLevels = getSimpleAccessLevels(
      context.returnHintContext.simpleAccess,
      getReturnHintArgumentMaxDepth()
    );
    for (let levelIndex = 0; levelIndex < returnHintAccessLevels.length; levelIndex += 1) {
      const levelPaths = returnHintAccessLevels[levelIndex];
      markdown.appendMarkdown(`\n**${formatAccessDepthLabel(levelIndex + 1)}:**\n`);
      markdown.appendCodeblock(levelPaths.join("\n"), "robotframework");
    }
  }

  const range = new vscode.Range(position.line, context.hoverStart, position.line, context.hoverEnd);
  return new vscode.Hover(markdown, range);
}

async function resolveEnumValuePreview(document, position, enumHintService, options = {}) {
  if (!enumHintService) {
    return undefined;
  }

  const context = getNamedArgumentValueContextAtPosition(document, position);
  if (!context) {
    return undefined;
  }

  return resolveEnumValuePreviewFromContext(document, enumHintService, context, {
    ...options,
    referenceLine: position.line,
    hoverCharacter: position.character
  });
}

async function resolveEnumValuePreviewFromContext(document, enumHintService, context, options = {}) {
  if (!enumHintService || !context) {
    return undefined;
  }
  const cancellationToken = options.cancellationToken;
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const parsed = options.parsed;
  const referenceLine = Number.isFinite(Number(options.referenceLine))
    ? Number(options.referenceLine)
    : 0;
  const runtimeCacheService = options.runtimeCache;
  const runtimeState = parsed ? runtimeCacheService?.ensureState(document, parsed) : undefined;
  if (runtimeState && runtimeCacheService && options.__skipCache !== true) {
    const cacheKey = buildEnumPreviewContextCacheKey(context, referenceLine, options);
    if (options.cacheOnly === true) {
      return runtimeCacheService.getCachedValue(runtimeState, "enumPreview", cacheKey, {
        allowPending: false
      });
    }
    const resolved = await runtimeCacheService.getOrCompute(
      runtimeState,
      "enumPreview",
      cacheKey,
      () =>
        resolveEnumValuePreviewFromContext(document, enumHintService, context, {
          ...options,
          __skipCache: true,
          runtimeCache: runtimeCacheService,
          parsed,
          referenceLine
        }),
      { referenceLine }
    );
    if (isHoverCancellationRequested(cancellationToken)) {
      return undefined;
    }
    return resolved;
  }

  const shouldResolveCurrentValue = options.showResolvedCurrentValue !== false;
  const currentValueResolution = shouldResolveCurrentValue
    ? resolveNamedArgumentCurrentValueFromSetVariable(
        context,
        parsed,
        referenceLine,
        runtimeState?.lookups,
        Number.isFinite(Number(options.hoverCharacter))
          ? Number(options.hoverCharacter)
          : Math.max(0, Number(context.hoverStart) || 0)
      )
      : {
        kind: "fallback",
        value: String(context.argumentValue || "").trim(),
        source: "argument",
        sourceLine: undefined,
        sourceLabel: "",
        candidates: []
      };
  const currentValue =
    currentValueResolution.kind === "single" || currentValueResolution.kind === "fallback"
      ? currentValueResolution.value
      : "";
  const returnHintContext =
    shouldResolveCurrentValue && parsed
      ? await resolveReturnHintForArgumentValue(
          document,
          parsed,
          context,
          {
            line: referenceLine,
            character: Number.isFinite(Number(options.hoverCharacter))
              ? Number(options.hoverCharacter)
              : Math.max(0, Number(context.hoverStart) || 0)
          },
          enumHintService,
          runtimeCacheService,
          options.returnComputeWorker,
          cancellationToken
        )
      : undefined;
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }

  const index = await enumHintService.getIndexForDocument(document);
  if (isHoverCancellationRequested(cancellationToken)) {
    return undefined;
  }
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(context.keywordName);
  const normalizedArgument = normalizeArgumentName(context.argumentName);
  const mappedEnums = index.keywordArgs.get(normalizedKeyword)?.get(normalizedArgument) || [];
  const mappedAnnotations = index.keywordArgAnnotations?.get(normalizedKeyword)?.get(normalizedArgument) || [];
  const allowArgumentFallback = isEnumArgumentFallbackEnabled();
  const hasDirectMapping = mappedEnums.length > 0 || mappedAnnotations.length > 0;
  const mappedEnumsByArgumentName = [];
  const mappedAnnotationsByArgumentName = [];
  if (allowArgumentFallback && !hasDirectMapping) {
    for (const argsMap of index.keywordArgs.values()) {
      const enumNamesForArgument = argsMap.get(normalizedArgument) || [];
      mappedEnumsByArgumentName.push(...enumNamesForArgument);
    }
  }
  if (allowArgumentFallback && !hasDirectMapping) {
    for (const annotationsMap of index.keywordArgAnnotations?.values() || []) {
      const annotationsForArgument = annotationsMap.get(normalizedArgument) || [];
      mappedAnnotationsByArgumentName.push(...annotationsForArgument);
    }
  }
  const argumentFallbackEnums = uniqueStrings(mappedEnumsByArgumentName);
  const argumentFallbackAnnotations = uniqueStrings(mappedAnnotationsByArgumentName);
  const annotationHints =
    mappedAnnotations.length > 0
      ? mappedAnnotations
      : allowArgumentFallback && !hasDirectMapping
      ? argumentFallbackAnnotations
      : [];
  let matchProvenance = "annotation-only";

  let candidates = [];
  if (mappedEnums.length > 0) {
    matchProvenance = "direct";
    for (const enumName of mappedEnums) {
      const enums = index.enumsByName.get(enumName) || [];
      candidates.push(...enums);
    }
  } else if (mappedAnnotations.length > 0) {
    matchProvenance = "direct";
  } else if (allowArgumentFallback && !hasDirectMapping && argumentFallbackEnums.length > 0) {
    matchProvenance = "argument-fallback";
    for (const enumName of argumentFallbackEnums) {
      const enums = index.enumsByName.get(enumName) || [];
      candidates.push(...enums);
    }
  } else if (allowArgumentFallback && !hasDirectMapping && argumentFallbackAnnotations.length > 0) {
    matchProvenance = "argument-fallback";
  }

  if (candidates.length === 0 && annotationHints.length === 0) {
    return undefined;
  }

  const dedupedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = buildEnumCandidateSignatureKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedCandidates.push(candidate);
  }
  const duplicateCandidateCount = Math.max(0, candidates.length - dedupedCandidates.length);

  dedupedCandidates.sort((left, right) => {
    const leftMatch = doesEnumContainValue(left, currentValue.toLowerCase()) ? 1 : 0;
    const rightMatch = doesEnumContainValue(right, currentValue.toLowerCase()) ? 1 : 0;
    if (leftMatch !== rightMatch) {
      return rightMatch - leftMatch;
    }
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    const leftScore = leftName.includes(normalizedArgument) ? 1 : 0;
    const rightScore = rightName.includes(normalizedArgument) ? 1 : 0;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return leftName.localeCompare(rightName);
  });

  const maxEnums = Math.max(1, Number(options.maxEnums) || getEnumHoverMaxEnums());
  const maxMembers = Math.max(1, Number(options.maxMembers) || getEnumHoverMaxMembers());

  return {
    ...context,
    documentUri: document.uri.toString(),
    normalizedKeyword,
    normalizedArgument,
    currentValue,
    currentValueKind: currentValueResolution.kind || "single",
    currentValueCandidates: Array.isArray(currentValueResolution.candidates)
      ? currentValueResolution.candidates
      : [],
    currentValueSource: currentValueResolution.source,
    currentValueSourceLabel: currentValueResolution.sourceLabel || "",
    currentValueSourceLine: currentValueResolution.sourceLine,
    showArgumentAssignment: options.showArgumentAssignment !== false,
    showResolvedCurrentValue: options.showResolvedCurrentValue !== false,
    showCurrentMemberMarker: options.showCurrentMemberMarker !== false,
    backToKeywordCommandUri: String(options.backToKeywordCommandUri || ""),
    annotationHints,
    matchProvenance,
    duplicateCandidateCount,
    returnHintContext,
    candidates: dedupedCandidates,
    shownEnums: dedupedCandidates.slice(0, maxEnums),
    maxEnums,
    maxMembers
  };
}

function doesEnumContainValue(enumEntry, normalizedValue) {
  const target = String(normalizedValue || "").trim().toLowerCase();
  if (!target) {
    return false;
  }
  for (const member of enumEntry.members || []) {
    if (String(member.name || "").toLowerCase() === target) {
      return true;
    }
    if (String(member.valueLiteral || "").toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

function isEnumMemberMatch(member, normalizedValue) {
  const target = String(normalizedValue || "").trim().toLowerCase();
  if (!target) {
    return false;
  }
  if (String(member?.name || "").toLowerCase() === target) {
    return true;
  }
  if (String(member?.valueLiteral || "").toLowerCase() === target) {
    return true;
  }
  return false;
}

function getEnumMatchingMembers(enumEntry, normalizedValue) {
  return (enumEntry?.members || []).filter((member) => isEnumMemberMatch(member, normalizedValue));
}

function formatEnumMemberForDisplay(member) {
  const memberName = String(member.name || "");
  const valueLiteral = member.valueLiteral;
  if (valueLiteral === undefined || valueLiteral === null || valueLiteral.length === 0) {
    return memberName;
  }
  if (valueLiteral === memberName) {
    return memberName;
  }
  return `${memberName} = ${valueLiteral}`;
}

function buildOpenLocationCommandUri(uriString, line, character = 0) {
  if (!uriString) {
    return "";
  }
  const safeLine = Math.max(0, Number(line) || 0);
  const safeCharacter = Math.max(0, Number(character) || 0);
  const args = encodeURIComponent(JSON.stringify([uriString, safeLine, safeCharacter]));
  return `command:${CMD_OPEN_LOCATION}?${args}`;
}

function buildPreviewKeywordArgumentCommandUri(payload) {
  const uriString = String(payload?.documentUri || "").trim();
  const keywordName = String(payload?.keywordName || "").trim();
  const argumentName = String(payload?.argumentName || "").trim();
  if (!uriString || !keywordName || !argumentName) {
    return "";
  }

  const safeLine = Number.isFinite(Number(payload?.line))
    ? Math.max(0, Number(payload.line))
    : Number.isFinite(Number(payload?.keywordLine))
    ? Math.max(0, Number(payload.keywordLine))
    : 0;
  const safeCharacter = Number.isFinite(Number(payload?.character))
    ? Math.max(0, Number(payload.character))
    : Number.isFinite(Number(payload?.keywordCharacter))
    ? Math.max(0, Number(payload.keywordCharacter))
    : 0;
  const metadata = {
    kind: "keywordArgumentPreview",
    payload
  };
  const args = encodeURIComponent(JSON.stringify([uriString, safeLine, safeCharacter, metadata]));
  return `command:${CMD_OPEN_LOCATION}?${args}`;
}

function buildInsertKeywordArgumentCommandUri(payload) {
  const uriString = String(payload?.documentUri || "").trim();
  const keywordName = String(payload?.keywordName || "").trim();
  const argumentName = String(payload?.argumentName || "").trim();
  if (!uriString || !keywordName || !argumentName) {
    return "";
  }

  const safePayload = {
    documentUri: uriString,
    keywordLine: Number.isFinite(Number(payload?.keywordLine)) ? Math.max(0, Number(payload.keywordLine)) : 0,
    keywordCharacter: Number.isFinite(Number(payload?.keywordCharacter))
      ? Math.max(0, Number(payload.keywordCharacter))
      : 0,
    keywordName,
    argumentName,
    normalizedArgumentName: normalizeArgumentName(String(payload?.normalizedArgumentName || argumentName)),
    documentedArgumentNames: uniqueStrings(
      (Array.isArray(payload?.documentedArgumentNames) ? payload.documentedArgumentNames : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
    headerIndent: String(payload?.headerIndent || "")
  };
  const args = encodeURIComponent(JSON.stringify([safePayload]));
  return `command:${CMD_INSERT_KEYWORD_ARGUMENT}?${args}`;
}

function parseManagedCommandUriInvocation(commandUri) {
  const rawCommandUri = String(commandUri || "").trim();
  if (!rawCommandUri.startsWith("command:")) {
    return undefined;
  }

  const queryIndex = rawCommandUri.indexOf("?");
  const commandId = rawCommandUri.slice("command:".length, queryIndex >= 0 ? queryIndex : undefined).trim();
  if (!commandId) {
    return undefined;
  }

  let args = [];
  if (queryIndex >= 0) {
    const rawArgs = rawCommandUri.slice(queryIndex + 1).trim();
    if (rawArgs) {
      try {
        const parsedArgs = JSON.parse(decodeURIComponent(rawArgs));
        args = Array.isArray(parsedArgs) ? parsedArgs : [parsedArgs];
      } catch {
        return undefined;
      }
    }
  }

  return {
    commandId,
    args
  };
}

async function executeManagedCommandUri(commandUri) {
  const invocation = parseManagedCommandUriInvocation(commandUri);
  if (!invocation) {
    return false;
  }

  await vscode.commands.executeCommand(invocation.commandId, ...(Array.isArray(invocation.args) ? invocation.args : []));
  return true;
}

function buildEnumCandidateSignatureKey(enumEntry) {
  const normalizedName = normalizeComparableToken(enumEntry?.name);
  const memberSignatures = (enumEntry?.members || [])
    .map((member) => {
      const normalizedMemberName = normalizeComparableToken(member?.name);
      const normalizedMemberValue = normalizeEnumCandidateLiteral(member?.valueLiteral);
      return `${normalizedMemberName}=${normalizedMemberValue}`;
    })
    .sort();
  return `${normalizedName}::${memberSignatures.join("|")}`;
}

function normalizeEnumCandidateLiteral(valueLiteral) {
  if (valueLiteral === undefined || valueLiteral === null) {
    return "";
  }
  return String(valueLiteral).trim().toLowerCase();
}

function getNamedArgumentValueContextAtPosition(document, position) {
  const lineText = document.lineAt(position.line).text;
  const namedArgument = findNamedArgumentAtPosition(lineText, position.character);
  if (!namedArgument) {
    return undefined;
  }

  const headerLine = findKeywordCallHeaderLine(document, position.line);
  let keywordName = extractKeywordNameFromRobotCallLine(document.lineAt(headerLine).text);
  if (!keywordName && isArgumentsHeaderLine(document.lineAt(headerLine).text)) {
    keywordName = findOwningKeywordNameForArgumentsBlock(document, headerLine);
  }
  if (!keywordName) {
    return undefined;
  }

  return {
    keywordName,
    argumentName: namedArgument.name,
    argumentValue: namedArgument.value,
    valueStart: namedArgument.valueStart,
    valueEnd: namedArgument.valueEnd,
    hoverStart: namedArgument.hoverStart,
    hoverEnd: namedArgument.hoverEnd
  };
}

function parseNamedArgumentMemberCompletionContext(argumentContext, position) {
  if (!argumentContext || !position) {
    return undefined;
  }
  const rawValue = String(argumentContext.argumentValue || "").trim();
  if (!rawValue || !/^[@$&%]\{/.test(rawValue)) {
    return undefined;
  }

  const variableMatch = rawValue.match(/^([@$&%])\{([^}\r\n]*)(\})?$/);
  if (!variableMatch) {
    return undefined;
  }

  const sigil = String(variableMatch[1] || "");
  const body = String(variableMatch[2] || "");
  const valueStart = Math.max(0, Number(argumentContext.valueStart) || 0);
  const valueEnd = Math.max(valueStart, Number(argumentContext.valueEnd) || valueStart);
  const cursorCharacter = Math.max(valueStart, Math.min(Number(position.character) || valueStart, valueEnd));
  const cursorInValue = Math.max(0, Math.min(rawValue.length, cursorCharacter - valueStart));
  const cursorInBody = Math.max(0, Math.min(body.length, cursorInValue - 2));
  const bodyPrefix = body.slice(0, cursorInBody);
  const rootMatch = bodyPrefix.match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
  if (!rootMatch) {
    return undefined;
  }

  const rootName = String(rootMatch[1] || "").trim();
  const remainderPrefix = String(rootMatch[2] || "");
  if (!rootName || (!remainderPrefix.startsWith(".") && !remainderPrefix.startsWith("["))) {
    return undefined;
  }

  let offset = 0;
  const rootIndexMatch = remainderPrefix.match(/^\[\s*\d+\s*\]/);
  if (rootIndexMatch) {
    offset += rootIndexMatch[0].length;
  }
  if (remainderPrefix[offset] !== ".") {
    return undefined;
  }
  offset += 1;

  const pathPrefixRaw = remainderPrefix.slice(offset);
  const rawSegments = pathPrefixRaw.length > 0 ? pathPrefixRaw.split(".") : [""];
  const activeSegmentRaw = rawSegments.length > 0 ? String(rawSegments.pop() || "") : "";
  const committedSegmentsRaw = rawSegments;
  const pathSegments = [];
  for (const segment of committedSegmentsRaw) {
    const normalizedSegment = normalizeMemberCompletionPathSegment(segment);
    if (!normalizedSegment) {
      return undefined;
    }
    pathSegments.push(normalizedSegment);
  }

  const activeSegment = normalizeMemberCompletionToken(activeSegmentRaw);
  const activeSegmentStartInPrefix = pathPrefixRaw.length - activeSegmentRaw.length;
  const activeSegmentStartInBody = rootName.length + offset + Math.max(0, activeSegmentStartInPrefix);
  const activeSegmentEndInBody = activeSegmentStartInBody + activeSegmentRaw.length;
  const replaceStart = valueStart + 2 + activeSegmentStartInBody;
  const replaceEnd = valueStart + 2 + activeSegmentEndInBody;

  return {
    line: Number(position.line),
    rootVariableToken: `${sigil}{${rootName}}`,
    pathSegments,
    activeSegment,
    replaceStart: Math.max(valueStart, replaceStart),
    replaceEnd: Math.max(Math.max(valueStart, replaceStart), replaceEnd)
  };
}

function normalizeMemberCompletionPathSegment(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[\s*\d+\s*\])?$/);
  if (!match) {
    return "";
  }
  const name = String(match[1] || "").trim();
  const hasIndex = Boolean(match[2]);
  return hasIndex ? `${name}[0]` : name;
}

function normalizeMemberCompletionToken(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\[\s*\d+\s*\]/g, "[0]");
}

function getLeadingWhitespacePrefix(lineText) {
  const match = String(lineText || "").match(/^\s*/);
  return match ? String(match[0] || "") : "";
}

function findKeywordCallHeaderLine(document, line) {
  let headerLine = line;
  while (headerLine > 0) {
    const text = document.lineAt(headerLine).text.trimStart();
    if (!text.startsWith("...")) {
      break;
    }
    headerLine -= 1;
  }
  return headerLine;
}

function isArgumentsHeaderLine(lineText) {
  return String(lineText || "").trim().toLowerCase() === "[arguments]";
}

function findOwningKeywordNameForArgumentsBlock(document, fromLine) {
  for (let line = fromLine - 1; line >= 0; line -= 1) {
    const sourceLine = document.lineAt(line).text;
    const trimmed = sourceLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (isSectionHeader(trimmed)) {
      return "";
    }

    if (/^[ \t]/.test(sourceLine)) {
      continue;
    }

    if (trimmed.startsWith("[") || trimmed.startsWith("...")) {
      continue;
    }

    return trimmed;
  }

  return "";
}

function extractKeywordNameFromRobotCallLine(lineText) {
  const keywordToken = extractKeywordTokenFromRobotCallLine(lineText);
  return keywordToken ? keywordToken.keywordName : "";
}

function extractKeywordTokenFromRobotCallLine(lineText) {
  const cells = splitRobotCellsWithRanges(lineText);
  if (cells.length === 0) {
    return undefined;
  }

  let keywordIndex = 0;
  while (keywordIndex < cells.length && cells[keywordIndex].text.trim() === "...") {
    keywordIndex += 1;
  }

  while (
    keywordIndex < cells.length &&
    (/^[@$&%]\{[^}]+\}\s*=$/.test(cells[keywordIndex].text.trim()) ||
      /^[@$&%]\{[^}]+\}$/.test(cells[keywordIndex].text.trim()))
  ) {
    keywordIndex += 1;
  }

  if (keywordIndex < cells.length && cells[keywordIndex].text.trim() === "=") {
    keywordIndex += 1;
  }

  const keywordCell = cells[keywordIndex];
  const keywordName = keywordCell?.text.trim() || "";
  if (!keywordName) {
    return undefined;
  }

  if (ROBOT_CONTROL_CELLS.has(keywordName.toLowerCase())) {
    return undefined;
  }

  return {
    keywordName,
    start: keywordCell.start,
    end: keywordCell.end,
    index: keywordIndex
  };
}

function getKeywordTokenContextAtPosition(document, position) {
  if (!document || !position) {
    return undefined;
  }

  const headerLine = findKeywordCallHeaderLine(document, position.line);
  if (position.line !== headerLine) {
    return undefined;
  }

  const keywordToken = extractKeywordTokenFromRobotCallLine(document.lineAt(headerLine).text);
  if (!keywordToken) {
    return undefined;
  }

  if (position.character < keywordToken.start || position.character > keywordToken.end) {
    return undefined;
  }

  return {
    keywordName: keywordToken.keywordName,
    line: headerLine,
    start: keywordToken.start,
    end: keywordToken.end
  };
}

function findNamedArgumentAtPosition(lineText, character) {
  const namedArguments = extractNamedArgumentsWithRangesFromRobotCallLine(lineText);
  for (const namedArgument of namedArguments) {
    const nameStart = namedArgument.nameStart;
    const nameEnd = namedArgument.nameEnd;
    const valueStart = namedArgument.valueStart;
    const valueEnd = namedArgument.valueEnd;
    const isOnName = character >= nameStart && character < nameEnd;
    const isOnValue = character >= valueStart && character <= valueEnd;

    if (!isOnName && !isOnValue) {
      continue;
    }

    return {
      name: namedArgument.name,
      value: namedArgument.value,
      valueStart,
      valueEnd,
      hoverStart: isOnName ? nameStart : valueStart,
      hoverEnd: isOnName ? nameEnd : valueEnd
    };
  }

  return undefined;
}

function splitRobotCellsWithRanges(lineText) {
  const source = String(lineText || "");
  const cells = [];
  let index = 0;

  while (index < source.length && (source[index] === " " || source[index] === "\t")) {
    index += 1;
  }

  while (index < source.length) {
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === "\t") {
        break;
      }
      if (char === " " && source[index + 1] === " ") {
        break;
      }
      index += 1;
    }

    const end = index;
    const text = source.slice(start, end);
    if (text.length > 0) {
      cells.push({
        text,
        start,
        end
      });
    }

    while (index < source.length && (source[index] === " " || source[index] === "\t")) {
      index += 1;
    }
  }

  return cells;
}

function parseEnumDefinitionsFromPythonSource(source, filePath) {
  const lines = String(source || "").split(/\r?\n/);
  const enums = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const classMatch = lines[lineIndex].match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*Enum[^)]*)\)\s*:/);
    if (!classMatch) {
      continue;
    }

    const classIndent = classMatch[1].length;
    const className = classMatch[2];
    const members = [];

    for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const trimmed = nextLine.trim();
      if (!trimmed) {
        continue;
      }

      const indentLength = (nextLine.match(/^\s*/) || [""])[0].length;
      if (indentLength <= classIndent) {
        lineIndex = nextIndex - 1;
        break;
      }

      const memberMatch = nextLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!memberMatch) {
        continue;
      }

      const memberName = memberMatch[1];
      if (memberName.startsWith("_")) {
        continue;
      }

      const memberValue = stripInlineRobotComment(memberMatch[2]).trim();
      const parsedLiteral = parsePythonLiteral(memberValue);
      members.push({
        name: memberName,
        valueLiteral: parsedLiteral
      });
    }

    if (members.length > 0) {
      enums.push({
        name: className,
        filePath,
        members
      });
    }
  }

  return enums;
}

function stripTrailingPythonComment(line) {
  const source = String(line || "");
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\" && (inSingleQuote || inDoubleQuote)) {
      escapeNext = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return source.slice(0, index);
    }
  }

  return source;
}

function parsePythonClassHeader(lines, startIndex) {
  const firstLine = String(lines?.[startIndex] || "");
  const firstMatch = firstLine.match(/^(\s*)class\b/);
  if (!firstMatch) {
    return null;
  }

  const classIndent = firstMatch[1].length;
  const headerLines = [];
  let parenthesisDepth = 0;
  let headerEndIndex = -1;

  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const currentLine = String(lines[lineIndex] || "");
    headerLines.push(currentLine.trim());

    const currentSource = stripTrailingPythonComment(currentLine);
    for (let charIndex = 0; charIndex < currentSource.length; charIndex += 1) {
      const char = currentSource[charIndex];
      if (char === "(") {
        parenthesisDepth += 1;
        continue;
      }
      if (char === ")") {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        continue;
      }
      if (char === ":" && parenthesisDepth === 0) {
        headerEndIndex = lineIndex;
        break;
      }
    }

    if (headerEndIndex >= 0) {
      break;
    }
  }

  if (headerEndIndex < 0) {
    return null;
  }

  const headerSource = headerLines.join(" ").trim();
  const classMatch = headerSource.match(
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]+\])?\s*(?:\(([\s\S]*?)\))?\s*:/
  );
  if (!classMatch) {
    return null;
  }

  const className = classMatch[1];
  const rawBaseTypeNames = uniqueStrings(String(classMatch[2] || "").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []);
  const supportsCamelCaseAccess = rawBaseTypeNames.some(
    (baseTypeName) => normalizeComparableToken(baseTypeName) === "camelcasebase"
  );
  const baseTypeNames = uniqueStrings(
    rawBaseTypeNames.filter(
      (baseTypeName) =>
        !PYTHON_IGNORED_TYPE_TOKENS.has(String(baseTypeName).toLowerCase()) &&
        normalizeComparableToken(baseTypeName) !== normalizeComparableToken(className)
    )
  );

  return {
    classIndent,
    className,
    baseTypeNames,
    supportsCamelCaseAccess,
    headerEndIndex
  };
}

function parseStructuredTypesFromPythonSource(source, filePath) {
  const lines = String(source || "").split(/\r?\n/);
  const structuredTypes = [];
  let pendingDecorators = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      pendingDecorators.push(trimmed);
      continue;
    }

    const classHeader = parsePythonClassHeader(lines, lineIndex);
    if (!classHeader) {
      if (trimmed.length > 0) {
        pendingDecorators = [];
      }
      continue;
    }

    const { classIndent, className, baseTypeNames, supportsCamelCaseAccess, headerEndIndex } = classHeader;
    const isDataclass = pendingDecorators.some((decorator) => /^@dataclass\b/.test(decorator));
    pendingDecorators = [];

    const fields = [];
    const properties = [];
    let pendingMemberDecorators = [];
    let hasIndexableMethod = false;
    let classBodyIndent = null;
    let inClassDocstring = false;
    let classDocstringDelimiter = "";
    let nextTopLevelIndex = lines.length;
    for (let nextIndex = headerEndIndex + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed) {
        continue;
      }

      const indentLength = (nextLine.match(/^\s*/) || [""])[0].length;
      if (indentLength <= classIndent) {
        nextTopLevelIndex = nextIndex;
        break;
      }

      if (classBodyIndent === null) {
        classBodyIndent = indentLength;
      }

      if (indentLength !== classBodyIndent) {
        continue;
      }

      if (inClassDocstring) {
        if (nextTrimmed.includes(classDocstringDelimiter)) {
          inClassDocstring = false;
          classDocstringDelimiter = "";
        }
        continue;
      }

      if (nextTrimmed.startsWith('"""') || nextTrimmed.startsWith("'''")) {
        const delimiter = nextTrimmed.startsWith('"""') ? '"""' : "'''";
        const delimiterCount = (nextTrimmed.match(new RegExp(delimiter, "g")) || []).length;
        if (delimiterCount < 2) {
          inClassDocstring = true;
          classDocstringDelimiter = delimiter;
        }
        pendingMemberDecorators = [];
        continue;
      }

      if (nextTrimmed.startsWith("#")) {
        pendingMemberDecorators = [];
        continue;
      }

      if (nextTrimmed.startsWith("@")) {
        pendingMemberDecorators.push(nextTrimmed);
        continue;
      }

      if (nextTrimmed.startsWith("def ") || nextTrimmed.startsWith("async def ") || nextTrimmed.startsWith("class ")) {
        if (/^(?:async\s+def|def)\s+(__getitem__|__iter__)\s*\(/.test(nextTrimmed)) {
          hasIndexableMethod = true;
        }
        const propertyDefinition = parsePythonPropertyDefinition(nextTrimmed, pendingMemberDecorators);
        pendingMemberDecorators = [];
        if (propertyDefinition) {
          properties.push(propertyDefinition);
        }
        continue;
      }

      pendingMemberDecorators = [];

      const fieldMatch = nextLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^#=]+?)(?:\s*=\s*.+)?$/);
      if (!fieldMatch) {
        continue;
      }

      const fieldName = fieldMatch[1];
      if (fieldName.startsWith("_")) {
        continue;
      }

      const fieldType = fieldMatch[2].trim().replace(/,$/, "");
      if (!fieldType) {
        continue;
      }

      fields.push({
        name: fieldName,
        annotation: fieldType
      });
    }

    lineIndex = nextTopLevelIndex - 1;

    const uniqueFields = dedupeStructuredFields(fields);
    const parsedClassProperties = parsePythonPropertyDefinitionsFromClassBody(
      lines,
      headerEndIndex + 1,
      nextTopLevelIndex,
      classBodyIndent
    );
    const uniqueProperties = dedupeStructuredFields(properties.concat(parsedClassProperties));

    if (uniqueFields.length === 0 && uniqueProperties.length === 0 && baseTypeNames.length === 0) {
      continue;
    }

    structuredTypes.push({
      name: className,
      filePath,
      isDataclass,
      isIndexableWrapper: hasIndexableMethod,
      supportsCamelCaseAccess: Boolean(supportsCamelCaseAccess),
      baseTypeNames,
      fields: uniqueFields,
      properties: uniqueProperties
    });
  }

  return structuredTypes;
}

function parsePythonPropertyDefinition(definitionLine, decorators = []) {
  const normalizedDecorators = (Array.isArray(decorators) ? decorators : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!normalizedDecorators.some((decorator) => decorator === "@property")) {
    return undefined;
  }

  const match = String(definitionLine || "").match(
    /^(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*self\s*\)\s*->\s*([^:]+)\s*:/
  );
  if (!match) {
    return undefined;
  }

  const name = String(match[1] || "").trim();
  const annotation = String(match[2] || "").trim().replace(/,$/, "");
  if (!name || !annotation || name.startsWith("_")) {
    return undefined;
  }

  return {
    name,
    annotation
  };
}

function parsePythonPropertyDefinitionsFromClassBody(lines, startIndex, endIndex, classBodyIndent) {
  const properties = [];
  const bodyIndent = Number.isFinite(Number(classBodyIndent)) ? Math.max(0, Number(classBodyIndent)) : null;
  if (!Array.isArray(lines) || bodyIndent === null) {
    return properties;
  }

  const classBodySource = lines
    .slice(Math.max(0, Number(startIndex) || 0), Math.max(0, Number(endIndex) || 0))
    .join("\n");
  const indentPattern = `[ \\t]{${bodyIndent}}`;
  const propertyPattern = new RegExp(
    `^${indentPattern}@property\\s*$\\r?\\n^${indentPattern}((?:async\\s+def|def)\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\(\\s*self\\s*\\)\\s*->\\s*[^\\n:]+\\s*:)`,
    "gm"
  );

  for (const match of classBodySource.matchAll(propertyPattern)) {
    const definitionLine = String(match[1] || "").trim();
    const propertyDefinition = parsePythonPropertyDefinition(definitionLine, ["@property"]);
    if (propertyDefinition) {
      properties.push(propertyDefinition);
    }
  }

  return properties;
}

function dedupeStructuredFields(fields) {
  const dedupedFields = [];
  const seenFields = new Set();
  for (const field of fields || []) {
    const normalizedName = String(field?.name || "").trim();
    const normalizedAnnotation = String(field?.annotation || "").trim().replace(/\s+/g, " ");
    if (!normalizedName) {
      continue;
    }
    const key = `${normalizedName}:${normalizedAnnotation}`;
    if (seenFields.has(key)) {
      continue;
    }
    seenFields.add(key);
    dedupedFields.push(field);
  }
  return dedupedFields;
}

function parsePythonLiteral(valueExpression) {
  const value = String(valueExpression || "").trim();
  const quoteMatch = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoteMatch) {
    return quoteMatch[2];
  }
  return value;
}

function derivePythonModuleInfo(workspaceFolder, fileUri) {
  const workspacePath = String(workspaceFolder?.uri?.fsPath || "");
  const filePath = String(fileUri?.fsPath || "");
  let relativePath = "";
  try {
    relativePath = workspacePath && filePath ? path.relative(workspacePath, filePath) : filePath;
  } catch {
    relativePath = filePath;
  }

  const normalizedPath = relativePath.replace(/\\/g, "/");
  const withoutExtension = normalizedPath.replace(/\.py$/i, "");
  const rawParts = withoutExtension
    .split("/")
    .map((segment) => String(segment || "").trim())
    .filter(Boolean);
  const isPackageInit = rawParts.length > 0 && rawParts[rawParts.length - 1] === "__init__";
  const moduleParts = isPackageInit ? rawParts.slice(0, -1) : rawParts;
  const modulePath = moduleParts.join(".");
  const packageParts = isPackageInit ? moduleParts : moduleParts.slice(0, -1);
  const packagePath = packageParts.join(".");

  return {
    modulePath,
    packagePath,
    isPackageInit
  };
}

function parsePythonImportAliasesFromSource(source, packagePath = "") {
  const lines = String(source || "").split(/\r?\n/);
  const typeImportAliases = new Map();
  const moduleImportAliases = new Map();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let statement = lines[lineIndex];
    if (!statement || !/\b(?:from|import)\b/.test(statement)) {
      continue;
    }

    let depth = (statement.match(/\(/g) || []).length - (statement.match(/\)/g) || []).length;
    while (lineIndex + 1 < lines.length && (depth > 0 || /\\\s*$/.test(statement))) {
      lineIndex += 1;
      statement += ` ${lines[lineIndex].trim()}`;
      depth = (statement.match(/\(/g) || []).length - (statement.match(/\)/g) || []).length;
    }

    const withoutComment = stripInlinePythonComment(statement).trim();
    if (!withoutComment) {
      continue;
    }

    const fromMatch = withoutComment.match(
      /^\s*from\s+([A-Za-z0-9_\.]+|\.+[A-Za-z0-9_\.]*)\s+import\s+(.+)$/
    );
    if (fromMatch) {
      const moduleExpression = String(fromMatch[1] || "").trim();
      const importModulePath = resolveImportModulePath(moduleExpression, packagePath);
      if (!importModulePath) {
        continue;
      }

      let importsText = String(fromMatch[2] || "").trim();
      if (importsText.startsWith("(") && importsText.endsWith(")")) {
        importsText = importsText.slice(1, -1).trim();
      }
      if (!importsText) {
        continue;
      }

      const specs = splitTopLevel(importsText, ",");
      for (const rawSpec of specs) {
        const parsedSpec = parseImportedSymbolSpec(rawSpec);
        if (!parsedSpec) {
          continue;
        }
        const existing = typeImportAliases.get(parsedSpec.alias) || [];
        existing.push({
          modulePath: importModulePath,
          symbolName: parsedSpec.originalName
        });
        typeImportAliases.set(parsedSpec.alias, existing);
      }
      continue;
    }

    const importMatch = withoutComment.match(/^\s*import\s+(.+)$/);
    if (!importMatch) {
      continue;
    }
    const specs = splitTopLevel(String(importMatch[1] || ""), ",");
    for (const rawSpec of specs) {
      const parsedSpec = parsePythonModuleImportSpec(rawSpec);
      if (!parsedSpec) {
        continue;
      }
      moduleImportAliases.set(parsedSpec.alias, parsedSpec.modulePath);
    }
  }

  return {
    typeImportAliases,
    moduleImportAliases
  };
}

function parsePythonModuleImportSpec(value) {
  const source = String(value || "").trim();
  if (!source) {
    return undefined;
  }

  const match = source.match(/^([A-Za-z_][A-Za-z0-9_\.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (!match) {
    return undefined;
  }

  const modulePath = String(match[1] || "").trim();
  if (!modulePath) {
    return undefined;
  }

  const alias = String(match[2] || modulePath.split(".").slice(-1)[0] || "").trim();
  if (!alias) {
    return undefined;
  }

  return {
    modulePath,
    alias
  };
}

function resolveImportModulePath(moduleExpression, packagePath = "") {
  const raw = String(moduleExpression || "").trim();
  if (!raw) {
    return "";
  }

  if (!raw.startsWith(".")) {
    return raw;
  }

  const dotMatch = raw.match(/^\.+/);
  const dotCount = dotMatch ? dotMatch[0].length : 0;
  const remainder = raw.slice(dotCount).replace(/^\.+/, "").trim();
  const packageParts = String(packagePath || "")
    .split(".")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const levelsUp = Math.max(0, dotCount - 1);
  const baseParts = packageParts.slice(0, Math.max(0, packageParts.length - levelsUp));
  const remainderParts = remainder
    ? remainder
        .split(".")
        .map((part) => String(part || "").trim())
        .filter(Boolean)
    : [];

  return [...baseParts, ...remainderParts].join(".");
}

function cloneTypeImportAliasesMap(sourceMap) {
  const cloned = new Map();
  for (const [alias, specs] of sourceMap || []) {
    const safeAlias = String(alias || "").trim();
    if (!safeAlias) {
      continue;
    }
    const safeSpecs = [];
    for (const spec of specs || []) {
      const modulePath = String(spec?.modulePath || "").trim();
      const symbolName = String(spec?.symbolName || "").trim();
      if (!modulePath || !symbolName) {
        continue;
      }
      safeSpecs.push({
        modulePath,
        symbolName
      });
    }
    if (safeSpecs.length > 0) {
      cloned.set(safeAlias, safeSpecs);
    }
  }
  return cloned;
}

function parseFromImportAliasesFromPythonSource(source) {
  const lines = String(source || "").split(/\r?\n/);
  const aliases = new Map();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let statement = lines[lineIndex];
    if (!statement || !/\bfrom\b/.test(statement) || !/\bimport\b/.test(statement)) {
      continue;
    }

    let depth = (statement.match(/\(/g) || []).length - (statement.match(/\)/g) || []).length;
    while (
      lineIndex + 1 < lines.length &&
      (depth > 0 || /\\\s*$/.test(statement))
    ) {
      lineIndex += 1;
      statement += ` ${lines[lineIndex].trim()}`;
      depth = (statement.match(/\(/g) || []).length - (statement.match(/\)/g) || []).length;
    }

    const withoutComment = statement.replace(/#.*$/, "");
    const match = withoutComment.match(/^\s*from\s+[A-Za-z0-9_\.]+\s+import\s+(.+)$/);
    if (!match) {
      continue;
    }

    let importsText = String(match[1] || "").trim();
    if (importsText.startsWith("(") && importsText.endsWith(")")) {
      importsText = importsText.slice(1, -1).trim();
    }
    if (!importsText) {
      continue;
    }

    const specs = splitTopLevel(importsText, ",");
    for (const rawSpec of specs) {
      const parsed = parseImportedSymbolSpec(rawSpec);
      if (!parsed) {
        continue;
      }
      aliases.set(parsed.alias, parsed.originalName);
    }
  }

  return aliases;
}

function parseImportedSymbolSpec(value) {
  const source = String(value || "").trim();
  if (!source || source === "*") {
    return undefined;
  }

  const aliasMatch = source.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (!aliasMatch) {
    return undefined;
  }

  const originalName = aliasMatch[1];
  const alias = aliasMatch[2] || originalName;
  return {
    originalName,
    alias
  };
}

function parseRobotKeywordDefinitionsFromSource(source, filePath = "") {
  const lines = String(source || "").split(/\r?\n/);
  const definitions = [];
  let currentSection = null;
  let currentKeywordDefinition = undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (isSectionHeader(trimmed)) {
      currentSection = getRelevantSection(trimmed);
      currentKeywordDefinition = undefined;
      continue;
    }

    if (currentSection !== "keywords") {
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const isIndented = /^[ \t]/.test(line);
    if (!isIndented && !trimmed.startsWith("[") && !trimmed.startsWith("...")) {
      currentKeywordDefinition = {
        keywordName: trimmed,
        sourceFilePath: filePath,
        argumentNames: new Set(),
        calls: []
      };
      definitions.push(currentKeywordDefinition);
      continue;
    }

    if (!currentKeywordDefinition) {
      continue;
    }

    if (trimmed.toLowerCase().startsWith("[arguments]")) {
      for (const argumentName of extractRobotKeywordArgumentNamesFromLine(line)) {
        currentKeywordDefinition.argumentNames.add(argumentName);
      }

      let continuationLine = lineIndex + 1;
      while (continuationLine < lines.length && lines[continuationLine].trimStart().startsWith("...")) {
        for (const argumentName of extractRobotKeywordArgumentNamesFromLine(lines[continuationLine])) {
          currentKeywordDefinition.argumentNames.add(argumentName);
        }
        continuationLine += 1;
      }
      lineIndex = continuationLine - 1;
      continue;
    }

    if (!isIndented || trimmed.startsWith("...") || trimmed.startsWith("[")) {
      continue;
    }

    const calledKeywordName = extractKeywordNameFromRobotCallLine(line);
    if (!calledKeywordName) {
      continue;
    }

    const callNamedArguments = [];
    let callEndLine = lineIndex;
    while (callEndLine + 1 < lines.length && lines[callEndLine + 1].trimStart().startsWith("...")) {
      callEndLine += 1;
    }

    for (let callLine = lineIndex; callLine <= callEndLine; callLine += 1) {
      const parsedNamedArguments = extractNamedArgumentsFromRobotCallLine(lines[callLine]);
      for (const parsedNamedArgument of parsedNamedArguments) {
        const normalizedArgumentName = normalizeArgumentName(parsedNamedArgument.name);
        const normalizedSourceArgumentName = extractForwardedArgumentName(parsedNamedArgument.valueRaw);
        if (!normalizedArgumentName || !normalizedSourceArgumentName) {
          continue;
        }

        callNamedArguments.push({
          normalizedArgumentName,
          normalizedSourceArgumentName
        });
      }
    }

    if (callNamedArguments.length > 0) {
      currentKeywordDefinition.calls.push({
        keywordName: calledKeywordName,
        normalizedKeywordName: normalizeKeywordName(calledKeywordName),
        namedArguments: callNamedArguments
      });
    }

    lineIndex = callEndLine;
  }

  return definitions.map((definition) => ({
    ...definition,
    argumentNames: [...definition.argumentNames]
  }));
}

function extractRobotKeywordArgumentNamesFromLine(lineText) {
  const cells = splitRobotCellsWithRanges(lineText);
  const argumentNames = [];
  for (const cell of cells) {
    let cellText = String(cell.text || "").trim();
    if (!cellText || cellText === "...") {
      continue;
    }
    if (cellText.toLowerCase() === "[arguments]") {
      continue;
    }
    if (cellText.startsWith("#")) {
      break;
    }

    const [withoutDefault] = splitTopLevelOnce(cellText, "=");
    cellText = String(withoutDefault || "").trim();
    if (!/^[$@&%]\{[^}\r\n]+\}$/.test(cellText)) {
      continue;
    }

    const normalizedArgumentName = normalizeArgumentName(getVariableRootToken(cellText));
    if (normalizedArgumentName) {
      argumentNames.push(normalizedArgumentName);
    }
  }
  return uniqueStrings(argumentNames);
}

function extractNamedArgumentsFromRobotCallLine(lineText) {
  return extractNamedArgumentsWithRangesFromRobotCallLine(lineText).map((namedArgument) => ({
    name: namedArgument.name,
    valueRaw: namedArgument.valueRaw
  }));
}

function extractNamedArgumentsWithRangesFromRobotCallLine(lineText) {
  const cells = splitRobotCellsWithRanges(lineText);
  const namedArguments = [];
  for (const cell of cells) {
    const eqIndex = findTopLevelCharIndex(cell.text, "=");
    if (eqIndex <= 0) {
      continue;
    }

    const namePart = cell.text.slice(0, eqIndex);
    const name = namePart.trim();
    if (!name) {
      continue;
    }

    const valuePart = stripInlineRobotComment(cell.text.slice(eqIndex + 1));
    const valueTrimStartLength = valuePart.length - valuePart.replace(/^\s+/, "").length;
    const valueRaw = valuePart.trim();
    const nameStartOffset = namePart.indexOf(name);
    const nameStart = cell.start + Math.max(0, nameStartOffset);
    const nameEnd = nameStart + name.length;
    const valueStart = cell.start + eqIndex + 1 + valueTrimStartLength;
    const valueEnd = valueStart + valueRaw.length;
    namedArguments.push({
      name,
      value: valueRaw,
      valueRaw,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd
    });
  }
  return namedArguments;
}

function extractForwardedArgumentName(valueExpression) {
  const value = stripInlineRobotComment(valueExpression).trim();
  if (!/^[$@&%]\{[^}\r\n]+\}$/.test(value)) {
    return "";
  }

  return normalizeArgumentName(getVariableRootToken(value));
}

function propagateRobotKeywordHints(robotKeywordDefinitions, keywordArgs, keywordArgAnnotations) {
  if (!Array.isArray(robotKeywordDefinitions) || robotKeywordDefinitions.length === 0) {
    return;
  }

  const maxPasses = 12;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (const robotKeywordDefinition of robotKeywordDefinitions) {
      const normalizedKeyword = normalizeKeywordName(robotKeywordDefinition.keywordName);
      if (!normalizedKeyword) {
        continue;
      }

      const availableSourceArguments = new Set(robotKeywordDefinition.argumentNames || []);
      if (availableSourceArguments.size === 0) {
        continue;
      }

      let sourceEnumMap = keywordArgs.get(normalizedKeyword);
      if (!sourceEnumMap) {
        sourceEnumMap = new Map();
        keywordArgs.set(normalizedKeyword, sourceEnumMap);
      }

      let sourceAnnotationMap = keywordArgAnnotations.get(normalizedKeyword);
      if (!sourceAnnotationMap) {
        sourceAnnotationMap = new Map();
        keywordArgAnnotations.set(normalizedKeyword, sourceAnnotationMap);
      }

      for (const call of robotKeywordDefinition.calls || []) {
        const targetKeyword = normalizeKeywordName(call.keywordName || call.normalizedKeywordName || "");
        if (!targetKeyword) {
          continue;
        }

        const targetEnumMap = keywordArgs.get(targetKeyword);
        const targetAnnotationMap = keywordArgAnnotations.get(targetKeyword);
        if (!targetEnumMap && !targetAnnotationMap) {
          continue;
        }

        for (const namedArgument of call.namedArguments || []) {
          const sourceArgument = namedArgument.normalizedSourceArgumentName;
          const targetArgument = namedArgument.normalizedArgumentName;
          if (!sourceArgument || !targetArgument || !availableSourceArguments.has(sourceArgument)) {
            continue;
          }

          if (mergeValuesIntoStringListMap(sourceEnumMap, sourceArgument, targetEnumMap?.get(targetArgument) || [])) {
            changed = true;
          }
          if (
            mergeValuesIntoStringListMap(
              sourceAnnotationMap,
              sourceArgument,
              targetAnnotationMap?.get(targetArgument) || []
            )
          ) {
            changed = true;
          }
        }
      }
    }

    if (!changed) {
      break;
    }
  }
}

function mergeValuesIntoStringListMap(targetMap, key, values) {
  if (!targetMap || !key || !Array.isArray(values) || values.length === 0) {
    return false;
  }

  const existing = targetMap.get(key) || [];
  const merged = uniqueStrings(existing.concat(values));
  if (merged.length === existing.length) {
    return false;
  }

  targetMap.set(key, merged);
  return true;
}

function collectPythonDecoratorExpressions(lines, startLine, definitionLine) {
  const expressions = [];
  let currentExpression = "";
  let depth = 0;

  for (let lineIndex = startLine; lineIndex < definitionLine; lineIndex += 1) {
    const trimmedLine = stripInlinePythonComment(String(lines[lineIndex] || "")).trim();
    if (!currentExpression) {
      if (!trimmedLine.startsWith("@")) {
        continue;
      }
      currentExpression = trimmedLine;
      depth = (trimmedLine.match(/\(/g) || []).length - (trimmedLine.match(/\)/g) || []).length;
      if (depth <= 0) {
        expressions.push(currentExpression);
        currentExpression = "";
        depth = 0;
      }
      continue;
    }

    currentExpression += trimmedLine;
    depth += (trimmedLine.match(/\(/g) || []).length - (trimmedLine.match(/\)/g) || []).length;
    if (depth <= 0) {
      expressions.push(currentExpression);
      currentExpression = "";
      depth = 0;
    }
  }

  if (currentExpression) {
    expressions.push(currentExpression);
  }

  return expressions;
}

function parsePythonKeywordDecoratorMetadata(lines, startLine, definitionLine) {
  const metadata = {
    convertUmlautKwargs: {
      applied: false,
      extraExcludeKeys: [],
      unsupportedExcludeExpression: ""
    }
  };

  for (const expression of collectPythonDecoratorExpressions(lines, startLine, definitionLine)) {
    const convertMetadata = parseConvertUmlautDecoratorMetadataFromExpression(expression);
    if (convertMetadata.applied) {
      metadata.convertUmlautKwargs = convertMetadata;
    }
  }

  return metadata;
}

function parseConvertUmlautDecoratorMetadataFromExpression(expression) {
  const trimmedExpression = String(expression || "").trim();
  if (!/^@convert_umlaut_kwargs\b/.test(trimmedExpression)) {
    return {
      applied: false,
      extraExcludeKeys: [],
      unsupportedExcludeExpression: ""
    };
  }

  const callMatch = trimmedExpression.match(/^@convert_umlaut_kwargs(?:\s*\(([\s\S]*)\))?\s*$/);
  const argumentsText = String(callMatch?.[1] || "").trim();
  if (!argumentsText) {
    return {
      applied: true,
      extraExcludeKeys: [],
      unsupportedExcludeExpression: ""
    };
  }

  let extraExcludeKeys = [];
  let unsupportedExcludeExpression = "";
  for (const argumentPart of splitTopLevel(argumentsText, ",")) {
    const [namePart, valuePart] = splitTopLevelOnce(argumentPart, "=");
    if (!valuePart || String(namePart || "").trim() !== "exclude") {
      continue;
    }

    const excludeResult = parseConvertUmlautDecoratorExcludeExpression(valuePart);
    extraExcludeKeys = excludeResult.extraExcludeKeys || [];
    unsupportedExcludeExpression = String(excludeResult.unsupportedExcludeExpression || "").trim();
    break;
  }

  return {
    applied: true,
    extraExcludeKeys,
    unsupportedExcludeExpression
  };
}

function parseConvertUmlautDecoratorExcludeExpression(expressionText) {
  const expression = String(expressionText || "").trim();
  if (!expression || expression === "_exclude_umlaut_kwargs") {
    return {
      extraExcludeKeys: [],
      unsupportedExcludeExpression: ""
    };
  }

  const aliasPlusLiteralMatch = expression.match(/^_exclude_umlaut_kwargs\s*\+\s*([\[(][\s\S]*[\])])$/);
  if (aliasPlusLiteralMatch) {
    const literalValues = parsePythonStringSequenceLiteralExpression(aliasPlusLiteralMatch[1]);
    if (literalValues) {
      return {
        extraExcludeKeys: literalValues,
        unsupportedExcludeExpression: ""
      };
    }
  }

  const literalValues = parsePythonStringSequenceLiteralExpression(expression);
  if (literalValues) {
    return {
      extraExcludeKeys: literalValues,
      unsupportedExcludeExpression: ""
    };
  }

  return {
    extraExcludeKeys: [],
    unsupportedExcludeExpression: expression
  };
}

function parsePythonStringSequenceLiteralExpression(expressionText) {
  const expression = String(expressionText || "").trim();
  if (!expression || !["[", "("].includes(expression[0])) {
    return undefined;
  }

  const openChar = expression[0];
  const closeChar = openChar === "[" ? "]" : ")";
  const balanced = extractBalancedBracketContent(expression, 0, openChar, closeChar);
  if (!balanced || balanced.endIndex !== expression.length - 1) {
    return undefined;
  }

  const values = [];
  for (const part of splitTopLevel(balanced.content, ",")) {
    const trimmedPart = String(part || "").trim();
    if (!trimmedPart) {
      continue;
    }

    const stringMatch = trimmedPart.match(/^(['"])([\s\S]*)\1$/);
    if (!stringMatch) {
      return undefined;
    }

    values.push(String(stringMatch[2] || ""));
  }

  return values;
}

function extractBalancedBracketContent(sourceText, startIndex, openChar, closeChar) {
  const source = String(sourceText || "");
  if (source[startIndex] !== openChar) {
    return undefined;
  }

  let depth = 0;
  let quote = "";
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") {
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: source.slice(startIndex + 1, index),
          endIndex: index
        };
      }
    }
  }

  return undefined;
}

function parseConvertUmlautDecoratorConfigFromPythonSource(source, sourceFilePath = "") {
  const sourceText = String(source || "");
  if (!sourceText.includes("_exclude_umlaut_kwargs") || !sourceText.includes("def convert_umlaut_kwargs")) {
    return undefined;
  }

  const match = sourceText.match(/_exclude_umlaut_kwargs\s*=\s*\[/);
  if (!match) {
    return undefined;
  }

  const openIndex = match.index + match[0].length - 1;
  const balanced = extractBalancedBracketContent(sourceText, openIndex, "[", "]");
  if (!balanced) {
    return undefined;
  }

  const defaultExcludeKeys = parsePythonStringSequenceLiteralExpression(`[${balanced.content}]`);
  if (!defaultExcludeKeys) {
    return undefined;
  }

  return {
    sourceFilePath: String(sourceFilePath || "").trim(),
    defaultExcludeKeys: uniqueStrings(defaultExcludeKeys.map((value) => String(value || "").trim()).filter(Boolean))
  };
}

function resolveWorkspaceConvertUmlautDecoratorConfig(contributions) {
  let fallbackConfig = undefined;
  for (const contribution of contributions || []) {
    const config = contribution?.umlautDecoratorConfig;
    if (!config || !Array.isArray(config.defaultExcludeKeys) || config.defaultExcludeKeys.length === 0) {
      continue;
    }

    const normalizedSourcePath = String(config.sourceFilePath || "").replace(/\\/g, "/");
    const normalizedConfig = {
      sourceFilePath: config.sourceFilePath,
      defaultExcludeKeys: uniqueStrings(
        config.defaultExcludeKeys.map((value) => String(value || "").trim()).filter(Boolean)
      )
    };
    if (normalizedSourcePath.endsWith(CONVERT_UMLAUT_DECORATION_FILE_SUFFIX)) {
      return normalizedConfig;
    }

    if (!fallbackConfig) {
      fallbackConfig = normalizedConfig;
    }
  }

  return (
    fallbackConfig || {
      sourceFilePath: "",
      defaultExcludeKeys: [...FALLBACK_CONVERT_UMLAUT_EXCLUDE_KEYS]
    }
  );
}

function buildConvertUmlautExcludeKeys(defaultExcludeKeys, decoratorMetadata) {
  return uniqueStrings(
    []
      .concat(defaultExcludeKeys || [])
      .concat(decoratorMetadata?.extraExcludeKeys || [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function isWithinConvertUmlautException(sourceText, startIndex, endIndex, exceptionKeys) {
  const lowerSource = String(sourceText || "").toLowerCase();
  for (const exceptionKey of exceptionKeys || []) {
    const normalizedException = String(exceptionKey || "").trim().toLowerCase();
    if (!normalizedException) {
      continue;
    }

    let matchIndex = lowerSource.indexOf(normalizedException);
    while (matchIndex >= 0) {
      if (startIndex >= matchIndex && endIndex <= matchIndex + normalizedException.length) {
        return true;
      }
      matchIndex = lowerSource.indexOf(normalizedException, matchIndex + 1);
    }
  }

  return false;
}

function applyConvertUmlautParameterDisplayName(sourceName, excludeKeys) {
  const source = String(sourceName || "");
  if (!source) {
    return source;
  }

  return source.replace(/(ae|oe|ue|Ae|Oe|Ue)/g, (match, _token, offset) => {
    const startIndex = Number(offset) || 0;
    const endIndex = startIndex + String(match || "").length;
    if (isWithinConvertUmlautException(source, startIndex, endIndex, excludeKeys)) {
      return match;
    }
    return CONVERT_UMLAUT_REPLACEMENTS[match] || match;
  });
}

function rewriteKeywordDocArgumentNames(markdown, parameterDisplayNamesByNormalizedName) {
  if (!(parameterDisplayNamesByNormalizedName instanceof Map) || parameterDisplayNamesByNormalizedName.size === 0) {
    return String(markdown || "");
  }

  let currentSection = "summary";
  const rewrittenLines = [];
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const normalizedSectionHeader = trimmed.replace(/^#{1,6}\s+/, "");
    const renderedSectionMatch = normalizedSectionHeader.match(/^(Args?|Arguments?|Returns?|Raises?)\s*:?\s*$/i);
    const section = renderedSectionMatch
      ? parseKeywordDocSectionHeader(`${String(renderedSectionMatch[1] || "")}:`)
      : parseKeywordDocSectionHeader(trimmed);
    if (section) {
      currentSection = section;
      rewrittenLines.push(line);
      continue;
    }

    if (currentSection !== "Args") {
      rewrittenLines.push(line);
      continue;
    }

    const bulletMatch = line.match(/^(\s*[-*]\s+)`([^`]+)`([\s\S]*)$/);
    if (!bulletMatch) {
      rewrittenLines.push(line);
      continue;
    }

    const rawArgumentName = String(bulletMatch[2] || "").trim();
    const normalizedArgumentName = normalizeArgumentName(rawArgumentName);
    const displayArgumentName = parameterDisplayNamesByNormalizedName.get(normalizedArgumentName) || rawArgumentName;
    rewrittenLines.push(`${bulletMatch[1]}\`${displayArgumentName}\`${bulletMatch[3]}`);
  }

  return rewrittenLines.join("\n");
}

function finalizePythonKeywordDefinitionForIndex(keywordDefinition, options = {}) {
  if (!keywordDefinition || typeof keywordDefinition !== "object") {
    return keywordDefinition;
  }

  const convertMetadata = keywordDefinition.decoratorMetadata?.convertUmlautKwargs;
  const defaultExcludeKeys = Array.isArray(options.defaultExcludeKeys)
    ? options.defaultExcludeKeys
    : FALLBACK_CONVERT_UMLAUT_EXCLUDE_KEYS;
  const shouldConvert = Boolean(convertMetadata?.applied);
  const excludeKeys = shouldConvert ? buildConvertUmlautExcludeKeys(defaultExcludeKeys, convertMetadata) : [];
  if (shouldConvert && convertMetadata?.unsupportedExcludeExpression) {
    logRobotCompanionTrace(
      "Unsupported convert_umlaut_kwargs exclude expression; falling back to default exclusions.",
      {
        sourceFilePath: keywordDefinition.sourceFilePath,
        functionName: keywordDefinition.functionName,
        excludeExpression: convertMetadata.unsupportedExcludeExpression
      }
    );
  }

  const rawParameterEntries = Array.isArray(keywordDefinition.parameterEntries)
    ? keywordDefinition.parameterEntries
    : [...(keywordDefinition.parameters || new Map()).entries()].map(([name, annotation]) => ({
        name,
        annotation
      }));
  const parameterDisplayNamesByNormalizedName = new Map();
  const exposedParameterEntries = rawParameterEntries.map((entry) => {
    const sourceName = String(entry?.name || "").trim();
    const exposedName = shouldConvert ? applyConvertUmlautParameterDisplayName(sourceName, excludeKeys) : sourceName;
    const normalizedSourceName = normalizeArgumentName(sourceName);
    const normalizedExposedName = normalizeArgumentName(exposedName);
    if (normalizedSourceName) {
      parameterDisplayNamesByNormalizedName.set(normalizedSourceName, exposedName);
    }
    if (normalizedExposedName) {
      parameterDisplayNamesByNormalizedName.set(normalizedExposedName, exposedName);
    }

    return {
      name: exposedName,
      sourceName,
      annotation: String(entry?.annotation || "").trim()
    };
  });

  const exposedParameters = new Map();
  for (const entry of exposedParameterEntries) {
    if (!entry.annotation) {
      continue;
    }
    exposedParameters.set(entry.name, entry.annotation);
  }

  return {
    ...keywordDefinition,
    parameters: exposedParameters,
    parameterEntries: exposedParameterEntries,
    normalizedDocstring: rewriteKeywordDocArgumentNames(
      keywordDefinition.normalizedDocstring,
      parameterDisplayNamesByNormalizedName
    )
  };
}

function parseKeywordEnumHintsFromPythonSource(source, sourceFilePath = "") {
  const lines = String(source || "").split(/\r?\n/);
  const definitions = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/@keyword\s*\(/.test(lines[lineIndex])) {
      continue;
    }

    const keywordNameFromDecorator = parseKeywordDecoratorName(lines, lineIndex);
    let definitionLine = lineIndex + 1;
    while (definitionLine < lines.length && !/^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(lines[definitionLine])) {
      definitionLine += 1;
    }

    if (definitionLine >= lines.length) {
      continue;
    }

    let decoratorStartLine = lineIndex;
    while (decoratorStartLine > 0 && String(lines[decoratorStartLine - 1] || "").trimStart().startsWith("@")) {
      decoratorStartLine -= 1;
    }
    const decoratorMetadata = parsePythonKeywordDecoratorMetadata(lines, decoratorStartLine, definitionLine);
    const signature = collectFunctionSignature(lines, definitionLine);
    if (!signature) {
      continue;
    }

    const parameterEntries = parseFunctionParameterEntries(signature.parametersText);
    const parameters = new Map(
      parameterEntries
        .filter((entry) => String(entry?.annotation || "").trim().length > 0)
        .map((entry) => [entry.name, entry.annotation])
    );
    const returnAnnotation = String(signature.returnAnnotation || "").trim();
    const docstringResult = extractFunctionDocstring(lines, definitionLine, signature.endLine);
    const normalizedDocstring = normalizeKeywordDocstringToMarkdown(docstringResult.docstringRaw || "");

    definitions.push({
      keywordName: keywordNameFromDecorator || signature.functionName.replace(/_/g, " "),
      parameters,
      parameterEntries,
      decoratorMetadata,
      returnAnnotation,
      sourceFilePath,
      sourceLine: definitionLine,
      functionName: signature.functionName,
      rawDocstring: docstringResult.docstringRaw || "",
      normalizedDocstring: normalizedDocstring.markdown || "",
      docWarnings: uniqueStrings(
        []
          .concat(docstringResult.warnings || [])
          .concat(normalizedDocstring.warnings || [])
          .map((warning) => String(warning || "").trim())
          .filter(Boolean)
      )
    });

    lineIndex = signature.endLine;
  }

  return definitions;
}

function parseKeywordDecoratorName(lines, startLine) {
  let collected = "";
  let depth = 0;
  let didStart = false;

  for (let lineIndex = startLine; lineIndex < lines.length && lineIndex <= startLine + 8; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!didStart) {
      const keywordIndex = line.indexOf("@keyword");
      if (keywordIndex < 0) {
        return "";
      }
      const chunk = line.slice(keywordIndex);
      collected += chunk;
      depth += (chunk.match(/\(/g) || []).length;
      depth -= (chunk.match(/\)/g) || []).length;
      didStart = true;
    } else {
      collected += line;
      depth += (line.match(/\(/g) || []).length;
      depth -= (line.match(/\)/g) || []).length;
    }

    if (didStart && depth <= 0) {
      break;
    }
  }

  const match = collected.match(/@keyword\s*\(\s*["']([^"']+)["']/);
  return match ? match[1].trim() : "";
}

function collectFunctionSignature(lines, startLine) {
  let signatureText = stripInlinePythonComment(lines[startLine]).trim();
  let depth = (signatureText.match(/\(/g) || []).length - (signatureText.match(/\)/g) || []).length;
  let endLine = startLine;

  while (depth > 0 && endLine + 1 < lines.length && endLine - startLine < 300) {
    endLine += 1;
    const part = stripInlinePythonComment(lines[endLine]).trim();
    if (part) {
      signatureText += ` ${part}`;
    }
    depth += (part.match(/\(/g) || []).length;
    depth -= (part.match(/\)/g) || []).length;
  }

  const signatureMatch = signatureText.match(
    /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*(?:->\s*([\s\S]*?))?:\s*$/
  );
  if (!signatureMatch) {
    return null;
  }

  return {
    functionName: signatureMatch[1],
    parametersText: signatureMatch[2],
    returnAnnotation: String(signatureMatch[3] || "").trim(),
    endLine
  };
}

function extractFunctionDocstring(lines, definitionLine, signatureEndLine) {
  const definitionSourceLine = String(lines[definitionLine] || "");
  const definitionIndent = getLeadingWhitespaceLength(definitionSourceLine);
  let bodyIndent = undefined;
  let firstStatementLine = undefined;

  for (let lineIndex = signatureEndLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const sourceLine = String(lines[lineIndex] || "");
    const trimmed = sourceLine.trim();
    if (!trimmed) {
      continue;
    }

    const indent = getLeadingWhitespaceLength(sourceLine);
    if (indent <= definitionIndent) {
      break;
    }

    if (bodyIndent === undefined) {
      bodyIndent = indent;
    }

    if (indent !== bodyIndent) {
      continue;
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    firstStatementLine = lineIndex;
    break;
  }

  if (firstStatementLine === undefined) {
    return {
      docstringRaw: "",
      warnings: []
    };
  }

  const firstStatementSource = String(lines[firstStatementLine] || "");
  const firstStatementTrimmed = firstStatementSource.trimStart();
  const tripleStart = findTripleQuotedStringStart(firstStatementTrimmed);
  if (!tripleStart) {
    return {
      docstringRaw: "",
      warnings: []
    };
  }

  const docLines = [];
  const inlineClosingIndex = tripleStart.rest.indexOf(tripleStart.delimiter);
  if (inlineClosingIndex >= 0) {
    docLines.push(tripleStart.rest.slice(0, inlineClosingIndex));
    return {
      docstringRaw: docLines.join("\n"),
      warnings: []
    };
  }

  docLines.push(tripleStart.rest);
  for (let lineIndex = firstStatementLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const currentLine = String(lines[lineIndex] || "");
    const closingIndex = currentLine.indexOf(tripleStart.delimiter);
    if (closingIndex >= 0) {
      docLines.push(currentLine.slice(0, closingIndex));
      return {
        docstringRaw: docLines.join("\n"),
        warnings: []
      };
    }

    const indent = getLeadingWhitespaceLength(currentLine);
    if (currentLine.trim().length > 0 && indent <= definitionIndent) {
      return {
        docstringRaw: docLines.join("\n"),
        warnings: ["Unclosed triple-quoted docstring; rendered partial content."]
      };
    }
    docLines.push(currentLine);
  }

  return {
    docstringRaw: docLines.join("\n"),
    warnings: ["Unclosed triple-quoted docstring; rendered partial content."]
  };
}

function findTripleQuotedStringStart(sourceText) {
  const source = String(sourceText || "");
  const match = source.match(/^(?:[rRuUbBfF]{0,3})("""|''')([\s\S]*)$/);
  if (!match) {
    return undefined;
  }

  return {
    delimiter: match[1],
    rest: String(match[2] || "")
  };
}

function normalizeKeywordDocstringToMarkdown(rawDocstring) {
  const normalizedRaw = normalizeDocstringRawText(rawDocstring);
  if (!normalizedRaw) {
    return {
      markdown: "",
      warnings: []
    };
  }

  const warnings = [];
  const lines = normalizedRaw.split("\n");
  const markdownLines = [];
  let currentSection = "summary";
  const seenSections = new Set();
  let parsedArgsEntries = 0;
  let hasArgsSection = false;
  let hasReturnsSection = false;
  let hasRaisesSection = false;
  let argsBaseIndent = undefined;
  let hasSeenArgsEntry = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineIndent = getLeadingWhitespaceLength(line);
    const section = parseKeywordDocSectionHeader(trimmed);
    if (section) {
      if (seenSections.has(section)) {
        warnings.push(`Duplicate '${section}' section detected; merged best effort.`);
      }
      seenSections.add(section);
      currentSection = section;
      if (section !== "Args") {
        argsBaseIndent = undefined;
        hasSeenArgsEntry = false;
      }
      if (section === "Args") {
        hasArgsSection = true;
      } else if (section === "Returns") {
        hasReturnsSection = true;
      } else if (section === "Raises") {
        hasRaisesSection = true;
      }
      if (markdownLines.length > 0 && markdownLines[markdownLines.length - 1] !== "") {
        markdownLines.push("");
      }
      markdownLines.push(`### ${section}`);
      markdownLines.push("");
      continue;
    }

    if (currentSection === "Args") {
      if (!trimmed) {
        markdownLines.push("");
        continue;
      }

      const argumentLine = parseGoogleStyleArgumentLine(trimmed);
      if (argumentLine) {
        parsedArgsEntries += 1;
        hasSeenArgsEntry = true;
        if (!Number.isFinite(Number(argsBaseIndent))) {
          argsBaseIndent = lineIndent;
        } else {
          argsBaseIndent = Math.min(Number(argsBaseIndent), lineIndent);
        }
        markdownLines.push(argumentLine);
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const normalizedBullet = trimmed.replace(/^\*\s+/, "- ");
        if (hasSeenArgsEntry) {
          const nestedDepth = computeArgsNestedDepth(lineIndent, argsBaseIndent);
          markdownLines.push(`${"  ".repeat(nestedDepth)}${normalizedBullet}`);
        } else {
          markdownLines.push(normalizedBullet);
        }
        continue;
      }

      if (/^\s+/.test(line)) {
        if (hasSeenArgsEntry) {
          const nestedDepth = computeArgsNestedDepth(lineIndent, argsBaseIndent);
          markdownLines.push(`${"  ".repeat(nestedDepth)}${trimmed}`);
        } else {
          markdownLines.push(trimmed);
        }
        continue;
      }

      warnings.push(`Could not fully parse Args line: '${trimmed}'.`);
      markdownLines.push(trimmed);
      continue;
    }

    if (currentSection === "Returns" || currentSection === "Raises") {
      if (!trimmed) {
        markdownLines.push("");
        continue;
      }
      markdownLines.push(trimmed);
      continue;
    }

    markdownLines.push(line);
  }

  if (hasArgsSection && parsedArgsEntries === 0) {
    warnings.push("Args section detected but no argument entries were parsed.");
  }

  return {
    markdown: collapseMarkdownBlankLines(markdownLines.join("\n")).trim(),
    warnings: uniqueStrings(warnings)
  };
}

function computeArgsNestedDepth(lineIndent, argsBaseIndent) {
  const safeLineIndent = Math.max(0, Number(lineIndent) || 0);
  const safeBaseIndent = Math.max(0, Number(argsBaseIndent) || 0);
  if (safeLineIndent <= safeBaseIndent) {
    return 1;
  }

  const relativeIndent = safeLineIndent - safeBaseIndent;
  const depthFromIndent = Math.floor(relativeIndent / 4);
  return Math.max(1, depthFromIndent);
}

function normalizeDocstringRawText(rawDocstring) {
  const source = String(rawDocstring || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let lines = source.split("\n");
  while (lines.length > 0 && lines[0].trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  if (lines.length === 0) {
    return "";
  }

  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const indent = getLeadingWhitespaceLength(line);
    minIndent = Math.min(minIndent, indent);
  }
  const sharedIndent = Number.isFinite(minIndent) ? minIndent : 0;
  return lines.map((line) => line.slice(Math.min(sharedIndent, line.length))).join("\n");
}

function parseKeywordDocSectionHeader(trimmedLine) {
  const match = String(trimmedLine || "").match(/^(Args?|Arguments?|Returns?|Raises?)\s*:\s*$/i);
  if (!match) {
    return "";
  }

  const normalized = String(match[1] || "").trim().toLowerCase();
  if (normalized === "arg" || normalized === "args" || normalized === "argument" || normalized === "arguments") {
    return "Args";
  }
  if (normalized === "return" || normalized === "returns") {
    return "Returns";
  }
  if (normalized === "raise" || normalized === "raises") {
    return "Raises";
  }
  return "";
}

function parseGoogleStyleArgumentLine(trimmedLine) {
  const match = String(trimmedLine || "").match(/^([*]{0,2}[\p{L}_][\p{L}\p{N}_]*)\s*(\(([^)]+)\))?\s*:\s*(.*)$/u);
  if (!match) {
    return "";
  }

  const argName = String(match[1] || "").trim();
  const argType = String(match[3] || "").trim();
  const description = String(match[4] || "").trim();
  let rendered = `- \`${argName}\``;
  if (argType) {
    rendered += ` (${argType})`;
  }
  if (description) {
    rendered += `: ${description}`;
  }
  return rendered;
}

function collapseMarkdownBlankLines(markdownText) {
  return String(markdownText || "").replace(/\n{3,}/g, "\n\n");
}

function getLeadingWhitespaceLength(sourceText) {
  const match = String(sourceText || "").match(/^\s*/);
  return match ? match[0].length : 0;
}

function stripInlinePythonComment(lineText) {
  const source = String(lineText || "");
  let quote = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") {
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "#") {
      return source.slice(0, index);
    }
  }

  return source;
}

function parseFunctionParameterEntries(parametersText) {
  const result = [];
  const chunks = splitTopLevel(parametersText, ",");
  for (const chunk of chunks) {
    const parameter = chunk.trim();
    if (!parameter || parameter === "*" || parameter === "/") {
      continue;
    }

    const [withoutDefault] = splitTopLevelOnce(parameter, "=");
    const annotationSeparatorIndex = findTopLevelCharIndex(withoutDefault, ":");
    const rawNamePart = annotationSeparatorIndex >= 0 ? withoutDefault.slice(0, annotationSeparatorIndex) : withoutDefault;
    const rawName = rawNamePart.trim().replace(/^\*+/, "");
    if (!rawName || rawName === "self" || rawName === "cls") {
      continue;
    }

    const annotation = annotationSeparatorIndex >= 0 ? withoutDefault.slice(annotationSeparatorIndex + 1).trim() : "";
    result.push({
      name: rawName,
      annotation
    });
  }

  return result;
}

function parseFunctionParameters(parametersText) {
  const result = new Map();
  for (const entry of parseFunctionParameterEntries(parametersText)) {
    if (!entry.annotation) {
      continue;
    }
    result.set(entry.name, entry.annotation);
  }

  return result;
}

function resolveEnumNamesFromAnnotation(annotation, context = {}) {
  const tokens = String(annotation || "").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const enumNameSet =
    context.enumNameSet instanceof Set ? context.enumNameSet : new Set(context.enumNameSet || []);
  const localEnumNames =
    context.localEnumNames instanceof Set ? context.localEnumNames : new Set(context.localEnumNames || []);
  const importAliasMap = context.importAliasMap instanceof Map ? context.importAliasMap : new Map();
  const enums = [];

  for (const token of tokens) {
    if (localEnumNames.has(token)) {
      enums.push(token);
      continue;
    }

    const aliasTarget = importAliasMap.get(token);
    if (aliasTarget && enumNameSet.has(aliasTarget)) {
      enums.push(aliasTarget);
      continue;
    }

    if (enumNameSet.has(token)) {
      enums.push(token);
    }
  }

  return uniqueStrings(enums);
}

function splitTopLevel(source, separator) {
  const values = [];
  let current = "";
  let depthParen = 0;
  let depthSquare = 0;
  let depthCurly = 0;
  let quote = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];

    if (quote) {
      current += char;
      if (char === quote && prev !== "\\") {
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depthParen += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depthParen = Math.max(0, depthParen - 1);
      current += char;
      continue;
    }
    if (char === "[") {
      depthSquare += 1;
      current += char;
      continue;
    }
    if (char === "]") {
      depthSquare = Math.max(0, depthSquare - 1);
      current += char;
      continue;
    }
    if (char === "{") {
      depthCurly += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      depthCurly = Math.max(0, depthCurly - 1);
      current += char;
      continue;
    }

    if (char === separator && depthParen === 0 && depthSquare === 0 && depthCurly === 0) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function splitTopLevelOnce(source, separator) {
  const values = splitTopLevel(source, separator);
  if (values.length <= 1) {
    return [source, ""];
  }
  const first = values.shift();
  return [first, values.join(separator)];
}

function findTopLevelCharIndex(source, targetChar) {
  let depthParen = 0;
  let depthSquare = 0;
  let depthCurly = 0;
  let quote = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const prev = source[index - 1];

    if (quote) {
      if (char === quote && prev !== "\\") {
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depthParen += 1;
      continue;
    }
    if (char === ")") {
      depthParen = Math.max(0, depthParen - 1);
      continue;
    }
    if (char === "[") {
      depthSquare += 1;
      continue;
    }
    if (char === "]") {
      depthSquare = Math.max(0, depthSquare - 1);
      continue;
    }
    if (char === "{") {
      depthCurly += 1;
      continue;
    }
    if (char === "}") {
      depthCurly = Math.max(0, depthCurly - 1);
      continue;
    }

    if (char === targetChar && depthParen === 0 && depthSquare === 0 && depthCurly === 0) {
      return index;
    }
  }

  return -1;
}

function normalizeKeywordName(keywordName) {
  return normalizeComparableToken(keywordName);
}

function normalizeArgumentName(argumentName) {
  let normalized = String(argumentName || "").trim();
  const robotVarMatch = normalized.match(/^[$@&%]\{(.+)\}$/);
  if (robotVarMatch) {
    normalized = robotVarMatch[1].trim();
  }

  return normalizeComparableToken(normalized);
}

function normalizeComparableToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_-]+/g, "");
}

function extractComparableTypeNamesFromAnnotation(annotation) {
  if (!annotation) {
    return [];
  }

  const tokens = String(annotation).match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const comparableNames = [];
  for (const token of tokens) {
    const normalizedToken = normalizeComparableToken(token);
    if (!normalizedToken || PYTHON_IGNORED_TYPE_TOKENS.has(normalizedToken)) {
      continue;
    }
    comparableNames.push(normalizedToken);
  }

  return uniqueStrings(comparableNames);
}

function resolveExpectedArgumentTypeNames(index, normalizedKeyword, normalizedArgument) {
  const expectedTypeNames = new Set();
  const annotations = index.keywordArgAnnotations?.get(normalizedKeyword)?.get(normalizedArgument) || [];
  for (const annotation of annotations) {
    for (const comparableTypeName of extractComparableTypeNamesFromAnnotation(annotation)) {
      expectedTypeNames.add(comparableTypeName);
    }
  }

  const enumNames = index.keywordArgs?.get(normalizedKeyword)?.get(normalizedArgument) || [];
  for (const enumName of enumNames) {
    const normalizedEnumName = normalizeComparableToken(enumName);
    if (normalizedEnumName) {
      expectedTypeNames.add(normalizedEnumName);
    }
  }

  return expectedTypeNames;
}

function collectMatchingTypedReturnVariables(
  parsed,
  index,
  owner,
  line,
  expectedTypeNames,
  runtimeLookups = undefined
) {
  if (
    !parsed ||
    !index ||
    !owner ||
    !Number.isFinite(Number(line)) ||
    !(expectedTypeNames instanceof Set) ||
    expectedTypeNames.size === 0
  ) {
    return [];
  }

  const byVariable = new Map();
  const assignments = runtimeLookups
    ? runtimeLookups.keywordAssignmentsByOwner?.get(owner.id) || []
    : parsed.keywordCallAssignments || [];
  for (const assignment of assignments) {
    if (assignment.ownerId !== owner.id || assignment.startLine > line) {
      continue;
    }

    const normalizedKeyword = normalizeKeywordName(assignment.keywordName);
    const returnDefinition = getKeywordReturnDefinition(index, normalizedKeyword);
    const returnAnnotation = String(
      returnDefinition?.returnAnnotation || index.keywordReturns?.get(normalizedKeyword) || ""
    ).trim();
    if (!returnAnnotation) {
      continue;
    }

    const returnResolutionContext = buildTypeResolutionContextFromReturnDefinition(index, returnDefinition);
    const resolvedReturnTypeNames = resolveIndexedTypesFromAnnotation(returnAnnotation, index, {
      resolutionContext: returnResolutionContext
    }).typeNames;
    const comparableTypeNames = uniqueStrings(
      resolvedReturnTypeNames
        .map((typeName) => normalizeComparableToken(typeName))
        .concat(extractComparableTypeNamesFromAnnotation(returnAnnotation))
        .filter(Boolean)
    );
    if (comparableTypeNames.length === 0) {
      continue;
    }

    const matchesExpectedType = comparableTypeNames.some((typeName) => expectedTypeNames.has(typeName));
    if (!matchesExpectedType) {
      continue;
    }

    const returnVariables = assignment.returnVariables || [];
    const normalizedReturnVariables = assignment.normalizedReturnVariables || [];
    for (let indexOfVariable = 0; indexOfVariable < returnVariables.length; indexOfVariable += 1) {
      const variableToken = String(returnVariables[indexOfVariable] || "").trim();
      if (!variableToken) {
        continue;
      }

      const normalizedVariable =
        normalizedReturnVariables[indexOfVariable] || normalizeVariableLookupToken(variableToken);
      const candidate = {
        variableToken,
        normalizedVariable,
        assignmentLine: assignment.startLine,
        keywordName: assignment.keywordName,
        typeNamesOriginal: comparableTypeNames
      };
      const existing = byVariable.get(normalizedVariable);
      if (!existing || candidate.assignmentLine > existing.assignmentLine) {
        byVariable.set(normalizedVariable, candidate);
      }
    }
  }

  return [...byVariable.values()].sort((left, right) => {
    if (left.assignmentLine !== right.assignmentLine) {
      return right.assignmentLine - left.assignmentLine;
    }
    return left.variableToken.localeCompare(right.variableToken);
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readWorkspaceText(fileUri) {
  const uriString = fileUri && typeof fileUri.toString === "function" ? fileUri.toString() : "";
  if (uriString) {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uriString
    );
    if (openDocument) {
      return openDocument.getText();
    }
  }

  const raw = await vscode.workspace.fs.readFile(fileUri);
  return Buffer.from(raw).toString("utf8");
}

async function findWorkspaceFilesByPatterns(workspaceFolder, includePatterns, excludePattern) {
  const uniquePatternValues = uniqueStrings((includePatterns || []).map((value) => String(value || "").trim()));
  const searches = [];
  for (const patternValue of uniquePatternValues) {
    const includePattern = createRelativePatternSafe(workspaceFolder, patternValue);
    if (!includePattern) {
      continue;
    }
    searches.push(
      vscode.workspace.findFiles(includePattern, excludePattern || undefined).catch((error) => {
        console.warn(
          `[Robot Companion] Skipping index include pattern "${patternValue}" due to findFiles error:`,
          error
        );
        return [];
      })
    );
  }

  if (searches.length === 0) {
    return [];
  }

  const groupedResults = await Promise.all(searches);
  return uniqueUrisByString(groupedResults.flat());
}

function createRelativePatternSafe(workspaceFolder, patternValue) {
  try {
    return new vscode.RelativePattern(workspaceFolder, patternValue);
  } catch (error) {
    console.warn(`[Robot Companion] Skipping invalid glob pattern "${patternValue}"`, error);
    return undefined;
  }
}

function buildIndexIncludeFilePatterns(importFolderPatterns, filePattern) {
  const normalizedRoots = normalizeGlobPatternArrayConfigValue(
    importFolderPatterns,
    DEFAULT_INDEX_IMPORT_FOLDER_PATTERNS
  );
  const normalizedFilePattern = normalizeGlobPatternSegment(filePattern, "**/*");
  const combinedPatterns = normalizedRoots
    .map((rootPattern) => joinGlobRootAndSuffix(rootPattern, normalizedFilePattern))
    .filter(Boolean);
  return combinedPatterns.length > 0 ? uniqueStrings(combinedPatterns) : [normalizedFilePattern];
}

function buildCompositeIndexExcludePattern(excludeFolderPatterns) {
  const normalizedFolders = normalizeGlobPatternArrayConfigValue(
    excludeFolderPatterns,
    DEFAULT_INDEX_EXCLUDE_FOLDER_PATTERNS
  );
  const excludePatterns = uniqueStrings(
    normalizedFolders.map((folderPattern) => normalizeExcludeFolderGlob(folderPattern)).filter(Boolean)
  );

  if (excludePatterns.length === 0) {
    return undefined;
  }
  if (excludePatterns.length === 1) {
    return excludePatterns[0];
  }
  return `{${excludePatterns.join(",")}}`;
}

function normalizeExcludeFolderGlob(folderPattern) {
  const normalized = normalizeGlobPatternSegment(folderPattern, "");
  if (!normalized) {
    return "";
  }
  if (normalized.includes(",")) {
    console.warn(`[Robot Companion] Skipping exclude pattern with comma "${normalized}"`);
    return "";
  }
  if (GLOB_MAGIC_PATTERN.test(normalized)) {
    return normalized;
  }
  if (normalized.includes("/")) {
    return `${normalized}/**`;
  }
  return `**/${normalized}/**`;
}

function joinGlobRootAndSuffix(rootPattern, suffixPattern) {
  const normalizedRoot = normalizeGlobPatternSegment(rootPattern, "**");
  const normalizedSuffix = normalizeGlobPatternSegment(suffixPattern, "**/*");

  if (normalizedRoot === "**") {
    return normalizedSuffix;
  }
  if (normalizedRoot.endsWith("/**")) {
    return `${normalizedRoot}/${normalizedSuffix.replace(/^\*\*\//, "")}`;
  }
  return `${normalizedRoot}/${normalizedSuffix}`;
}

function normalizeGlobPatternSegment(patternValue, fallbackValue) {
  const normalized = String(patternValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (normalized.length > 0) {
    return normalized;
  }
  return String(fallbackValue || "").trim();
}

function uniqueUrisByString(values) {
  const uniqueUris = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = value && typeof value.toString === "function" ? value.toString() : "";
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueUris.push(value);
  }
  return uniqueUris;
}

function isPythonDocument(document) {
  if (!document) {
    return false;
  }
  return isPythonPath(document.uri.path);
}

function isPythonPath(pathValue) {
  return String(pathValue || "").toLowerCase().endsWith(".py");
}

async function openTextDocumentAtLocation(uriString, line, character = 0) {
  if (!uriString) {
    return;
  }

  let targetUri;
  try {
    targetUri = vscode.Uri.parse(uriString);
  } catch {
    return;
  }

  let document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === targetUri.toString()
  );

  if (!document) {
    try {
      document = await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return;
    }
  }

  const safeLine = Math.max(0, Math.min(Number(line) || 0, Math.max(0, document.lineCount - 1)));
  const maxCharOnLine = document.lineAt(safeLine).text.length;
  const safeCharacter = Math.max(0, Math.min(Number(character) || 0, maxCharOnLine));
  const targetPosition = new vscode.Position(safeLine, safeCharacter);
  const targetRange = new vscode.Range(targetPosition, targetPosition);

  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
  editor.selection = new vscode.Selection(targetPosition, targetPosition);
  editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
}

async function renderMarkdownToHtml(markdown) {
  try {
    const rendered = await vscode.commands.executeCommand("markdown.api.render", markdown || "");
    if (typeof rendered === "string") {
      return rendered;
    }
  } catch {
    // fallback below
  }

  return `<pre>${escapeHtml(markdown || "")}</pre>`;
}

function buildArrowIndentedRenderedHtmlLines(innerHtml) {
  const lines = String(innerHtml || "").split(/<br\s*\/?>|\r?\n/i);
  const rebuilt = [];

  const buildArrowLineContent = (cleanedHtml) => {
    const match = String(cleanedHtml || "").match(/^(-&gt;|=&gt;|->|=>)(?:\s|&nbsp;|\u00A0)*([\s\S]*)$/);
    if (match) {
      return `<span class="robot-arrow-marker">${match[1]}</span><span class="robot-arrow-body">${match[2]}</span>`;
    }
    return `<span class="robot-arrow-marker robot-arrow-marker-placeholder" aria-hidden="true">-&gt;</span><span class="robot-arrow-body">${String(
      cleanedHtml || ""
    )}</span>`;
  };

  for (const line of lines) {
    const match = String(line || "").match(/\[\[RDP_INDENT_(\d+)\]\]/);
    if (!match) {
      rebuilt.push(`<span class="robot-render-line">${String(line || "")}</span>`);
      continue;
    }

    const indentWidth = Math.max(0, Number(match[1]) || 0);
    const cleaned = String(line || "")
      .replace(/\[\[RDP_INDENT_\d+\]\]/g, "")
      .replace(/^[\s\u00A0]+/, "");

    rebuilt.push(
      `<span class="robot-render-line robot-arrow-line" style="--robot-arrow-indent:${String(
        indentWidth
      )}ch">${buildArrowLineContent(cleaned)}</span>`
    );
  }

  return rebuilt.join("");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDocumentationCustomColorValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DOCUMENTATION_COLOR_NAMED_VALUES, normalized)) {
    return DOCUMENTATION_COLOR_NAMED_VALUES[normalized];
  }
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(normalized)) {
    return normalized;
  }
  return "";
}

function buildDocumentationColorSpanOpenHtml(kind, colorValue = "") {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (DOCUMENTATION_COLOR_SEMANTIC_TAGS.includes(normalizedKind)) {
    return `<span class="doc-color-span doc-color-semantic doc-color-${escapeHtmlAttribute(normalizedKind)}">`;
  }

  const normalizedColor = normalizeDocumentationCustomColorValue(colorValue);
  if (!normalizedColor) {
    return "";
  }
  return `<span class="doc-color-span doc-color-custom" style="color:${escapeHtmlAttribute(normalizedColor)}">`;
}

function prepareDocumentationColorMarkupForRender(markdown) {
  const replacements = new Map();
  let counter = 0;

  const registerReplacement = (openHtml) => {
    const openToken = `@@RMC_DOC_COLOR_OPEN_${counter}@@`;
    const closeToken = `@@RMC_DOC_COLOR_CLOSE_${counter}@@`;
    counter += 1;
    replacements.set(openToken, openHtml);
    replacements.set(closeToken, "</span>");
    return { openToken, closeToken };
  };

  const transformInline = (line) => {
    let transformed = String(line || "");
    for (const tagName of DOCUMENTATION_COLOR_SEMANTIC_TAGS) {
      transformed = transformed.replace(
        new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi"),
        (_match, innerText) => {
          const { openToken, closeToken } = registerReplacement(
            buildDocumentationColorSpanOpenHtml(tagName)
          );
          return `${openToken}${innerText}${closeToken}`;
        }
      );
    }

    transformed = transformed.replace(
      /<color\s+value=(["'])([^"']+)\1\s*>([\s\S]*?)<\/color>/gi,
      (match, _quote, colorValue, innerText) => {
        const openHtml = buildDocumentationColorSpanOpenHtml("custom", colorValue);
        if (!openHtml) {
          return escapeHtml(match);
        }
        const { openToken, closeToken } = registerReplacement(openHtml);
        return `${openToken}${innerText}${closeToken}`;
      }
    );

    return transformed.replace(
      /<\/?(?:note|question|warning|error|success|color)\b[^>]*>/gi,
      (match) => escapeHtml(match)
    );
  };

  let inFence = false;
  const transformedMarkdown = String(markdown || "")
    .split(/\r?\n/)
    .map((line) => {
      const lineForFenceDetection = String(line || "").replace(
        /<span class="doc-target-marker" data-doc-target-index="\d+"><\/span>/g,
        ""
      );
      if (lineForFenceDetection.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : transformInline(line);
    })
    .join("\n");

  return {
    markdown: transformedMarkdown,
    replacements
  };
}

function applyDocumentationColorMarkupPlaceholders(renderedHtml, replacements) {
  let result = String(renderedHtml || "");
  if (!(replacements instanceof Map) || replacements.size === 0) {
    return result;
  }

  for (const [token, replacement] of replacements.entries()) {
    result = result.replace(new RegExp(escapeRegExp(token), "g"), replacement);
  }
  return result;
}

function expandArrowIndentTokensInRenderedHtml(renderedHtml) {
  let result = String(renderedHtml || "");
  if (!/\[\[RDP_INDENT_\d+\]\]/.test(result)) {
    return result;
  }

  const transformTag = (tagName, html) =>
    String(html || "").replace(
      new RegExp(`<${tagName}(\\b[^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi"),
      (match, attributes, innerHtml) => {
        if (!/\[\[RDP_INDENT_\d+\]\]/.test(String(innerHtml || ""))) {
          return match;
        }
        return `<${tagName}${String(attributes || "")}>${buildArrowIndentedRenderedHtmlLines(
          innerHtml
        )}</${tagName}>`;
      }
    );

  result = transformTag("p", result);
  result = transformTag("li", result);
  result = transformTag("pre", result);
  return result;
}

function createDocumentationRenderItem(kind, markdownLines = [], options = {}) {
  return {
    kind,
    markdownLines: Array.isArray(markdownLines) ? markdownLines.map((line) => String(line || "")) : [],
    commandUri: String(options.commandUri || ""),
    label: String(options.label || "")
  };
}

function buildDocumentationTargetMarkerHtml(targetIndex) {
  return `<span class="doc-target-marker" data-doc-target-index="${Math.max(0, Number(targetIndex) || 0)}"></span>`;
}

function injectDocumentationTargetMarker(markdownLines, targetIndex) {
  const lines = Array.isArray(markdownLines) ? markdownLines.map((line) => String(line || "")) : [];
  if (lines.length === 0) {
    return lines;
  }

  const marker = buildDocumentationTargetMarkerHtml(targetIndex);
  const firstLine = lines[0];

  if (/^#{1,6}\s+/.test(firstLine)) {
    lines[0] = firstLine.replace(/^(#{1,6}\s+)/, `$1${marker}`);
    return lines;
  }

  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(firstLine)) {
    lines[0] = firstLine.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/, `$1${marker}`);
    return lines;
  }

  if (/^\[\[RDP_INDENT_\d+\]\]/.test(firstLine)) {
    lines[0] = firstLine.replace(/^(\[\[RDP_INDENT_\d+\]\])/, `$1${marker}`);
    return lines;
  }

  const leadingWhitespace = (firstLine.match(/^[ \t]*/) || [""])[0];
  const arrowPrefix = parseArrowPrefix(firstLine.slice(leadingWhitespace.length));
  if (arrowPrefix) {
    lines[0] = `${leadingWhitespace}${arrowPrefix.marker}${marker}${
      arrowPrefix.rest ? ` ${arrowPrefix.rest}` : ""
    }`;
    return lines;
  }

  if (leadingWhitespace.length > 0) {
    lines[0] = `${leadingWhitespace}${marker}${firstLine.slice(leadingWhitespace.length)}`;
    return lines;
  }

  lines[0] = `${marker}${firstLine}`;
  return lines;
}

function isMarkdownListItemLine(line) {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(String(line || ""));
}

function isDocumentationArrowLine(line) {
  return Boolean(parseArrowPrefix(String(line || "").trimStart()));
}

function getDocumentationFragmentLineEntries(fragment) {
  const fragmentStartLine = Math.max(0, Number(fragment?.startLine) || 0);
  return (
    Array.isArray(fragment?.lineEntries) && fragment.lineEntries.length > 0
      ? fragment.lineEntries
      : String(fragment?.markdown || "")
          .split(/\r?\n/)
          .map((text, index) => ({
            text,
            sourceLine: fragmentStartLine + index,
            isHeading: isMarkdownHeadingLine(text)
          }))
  );
}

function buildInlineDocumentationRenderItems(documentUri, lineEntries, fragmentStartLine) {
  const items = [];
  let paragraphLines = [];
  let paragraphStartLine = fragmentStartLine;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    items.push(
      createDocumentationRenderItem("chunk", paragraphLines, {
        commandUri: buildOpenLocationCommandUri(documentUri, paragraphStartLine),
        label: `Open inline block line ${paragraphStartLine + 1}`
      })
    );
    paragraphLines = [];
  };

  for (const entry of lineEntries) {
    const text = String(entry?.text || "");
    const sourceLine = Math.max(0, Number(entry?.sourceLine) || fragmentStartLine);
    const isHeading = Boolean(entry?.isHeading) || isMarkdownHeadingLine(text);
    const isListItem = isMarkdownListItemLine(text);
    const isArrowLine = isDocumentationArrowLine(text);

    if (text.trim().length === 0) {
      flushParagraph();
      items.push(createDocumentationRenderItem("blank", [""]));
      continue;
    }

    if (isHeading) {
      flushParagraph();
      items.push(
        createDocumentationRenderItem("heading", [text], {
          commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
          label: `Open heading line ${sourceLine + 1}`
        })
      );
      continue;
    }

    if (isListItem) {
      flushParagraph();
      items.push(
        createDocumentationRenderItem("list-item", [text], {
          commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
          label: `Open list item line ${sourceLine + 1}`
        })
      );
      continue;
    }

    if (isArrowLine) {
      flushParagraph();
      items.push(
        createDocumentationRenderItem("arrow-line", [text], {
          commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
          label: `Open arrow line ${sourceLine + 1}`
        })
      );
      continue;
    }

    if (paragraphLines.length === 0) {
      paragraphStartLine = sourceLine;
    }
    paragraphLines.push(text);
  }

  flushParagraph();
  return items;
}

function buildStructuredDocumentationRenderItems(documentUri, lineEntries, fragmentStartLine) {
  const items = [];
  let paragraphLines = [];
  let paragraphStartLine = fragmentStartLine;
  let listItemLines = [];
  let listItemStartLine = fragmentStartLine;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    items.push(
      createDocumentationRenderItem("chunk", paragraphLines, {
        commandUri: buildOpenLocationCommandUri(documentUri, paragraphStartLine),
        label: `Open documentation line ${paragraphStartLine + 1}`
      })
    );
    paragraphLines = [];
  };

  const flushListItem = () => {
    if (listItemLines.length === 0) {
      return;
    }
    items.push(
      createDocumentationRenderItem("list-item", listItemLines, {
        commandUri: buildOpenLocationCommandUri(documentUri, listItemStartLine),
        label: `Open list item line ${listItemStartLine + 1}`
      })
    );
    listItemLines = [];
  };

  for (const entry of lineEntries) {
    const text = String(entry?.text || "");
    const sourceLine = Math.max(0, Number(entry?.sourceLine) || fragmentStartLine);
    const isHeading = Boolean(entry?.isHeading) || isMarkdownHeadingLine(text);
    const isListItem = isMarkdownListItemLine(text);

    if (text.trim().length === 0) {
      flushParagraph();
      flushListItem();
      items.push(createDocumentationRenderItem("blank", [""]));
      continue;
    }

    if (isHeading) {
      flushParagraph();
      flushListItem();
      items.push(
        createDocumentationRenderItem("heading", [text], {
          commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
          label: `Open documentation heading line ${sourceLine + 1}`
        })
      );
      continue;
    }

    if (isListItem) {
      flushParagraph();
      flushListItem();
      listItemStartLine = sourceLine;
      listItemLines = [text];
      continue;
    }

    if (listItemLines.length > 0) {
      listItemLines.push(text);
      continue;
    }

    if (paragraphLines.length === 0) {
      paragraphStartLine = sourceLine;
    }
    paragraphLines.push(text);
  }

  flushParagraph();
  flushListItem();
  return items;
}

function buildDocumentationRenderItemsForFragment(documentUri, fragment) {
  const sourceKind = String(fragment?.sourceKind || "documentation").trim().toLowerCase();
  const fragmentStartLine = Math.max(0, Number(fragment?.startLine) || 0);
  const lineEntries = getDocumentationFragmentLineEntries(fragment);

  if (sourceKind !== "inline") {
    return buildStructuredDocumentationRenderItems(documentUri, lineEntries, fragmentStartLine);
  }

  return buildInlineDocumentationRenderItems(documentUri, lineEntries, fragmentStartLine);
}

function formatDocumentationVariableValuePreview(valueRaw) {
  const normalizedParts = String(valueRaw || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (normalizedParts.length === 0) {
    return "(empty)";
  }
  const collapsed = normalizedParts.join(" | ");
  if (collapsed.length <= 140) {
    return collapsed;
  }
  return `${collapsed.slice(0, 137).trimEnd()}...`;
}

function escapeMarkdownText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/([*_#[\]()<>|])/g, "\\$1");
}

function buildDocumentationLocalVariableReplacementMap(block) {
  const assignmentsByVariable = new Map();
  for (const assignment of Array.isArray(block?.variableAssignments) ? block.variableAssignments : []) {
    const normalizedVariable = String(assignment?.normalizedVariable || "").trim();
    if (!normalizedVariable) {
      continue;
    }
    const items = assignmentsByVariable.get(normalizedVariable) || [];
    items.push(assignment);
    assignmentsByVariable.set(normalizedVariable, items);
  }

  const replacements = new Map();
  for (const [normalizedVariable, assignments] of assignmentsByVariable.entries()) {
    if (
      assignments.some(
        (assignment) => Array.isArray(assignment?.branchPath) && assignment.branchPath.length > 0
      )
    ) {
      continue;
    }

    const values = uniqueStrings(
      assignments
        .map((assignment) => extractCurrentValueFromSetVariableAssignment(assignment?.valueRaw || ""))
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0)
    );
    if (values.length === 1) {
      replacements.set(normalizedVariable, values[0]);
    }
  }

  return replacements;
}

function substituteDocumentationLocalVariableValues(markdown, block) {
  const replacements = buildDocumentationLocalVariableReplacementMap(block);
  if (replacements.size === 0) {
    return String(markdown || "");
  }

  let inFence = false;
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => {
      const lineForFenceDetection = String(line || "").replace(
        /<span class="doc-target-marker" data-doc-target-index="\d+"><\/span>/g,
        ""
      );
      if (lineForFenceDetection.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }

      return String(line || "").replace(/[@$&%]\{[^}\r\n]+\}/g, (variableToken) => {
        const replacement = replacements.get(normalizeVariableLookupToken(variableToken));
        return typeof replacement === "string" ? escapeMarkdownText(replacement) : variableToken;
      });
    })
    .join("\n");
}

function buildDocumentationMarkdownSectionRenderData(rawItems) {
  const markdownLines = [];
  const targets = [];
  const mergedItems = [];

  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    if (item.kind === "blank") {
      const previous = mergedItems[mergedItems.length - 1];
      if (!previous || previous.kind !== "blank") {
        mergedItems.push(createDocumentationRenderItem("blank", [""]));
      }
      continue;
    }

    const previous = mergedItems[mergedItems.length - 1];
    if (item.kind === "chunk" && previous && previous.kind === "chunk") {
      previous.markdownLines.push(...item.markdownLines);
      continue;
    }

    mergedItems.push(createDocumentationRenderItem(item.kind, item.markdownLines, item));
  }

  for (const item of mergedItems) {
    if (item.kind === "blank") {
      if (markdownLines.length === 0 || markdownLines[markdownLines.length - 1] === "") {
        continue;
      }
      markdownLines.push("");
      continue;
    }

    const targetIndex = targets.length;
    targets.push({
      commandUri: item.commandUri,
      label: item.label,
      kind: item.kind
    });
    markdownLines.push(...injectDocumentationTargetMarker(item.markdownLines, targetIndex));
  }

  while (markdownLines.length > 0 && markdownLines[markdownLines.length - 1] === "") {
    markdownLines.pop();
  }

  return {
    markdown: markdownLines.join("\n"),
    targets
  };
}

function buildDocumentationBodyRenderData(documentUri, block) {
  const fragments =
    Array.isArray(block?.fragments) && block.fragments.length > 0
      ? block.fragments
      : [
          {
            sourceKind: "documentation",
            startLine: Number(block?.startLine) || 0,
            markdown: String(block?.markdown || "")
          }
        ];

  const rawItems = [];

  for (const fragment of fragments) {
    const items = buildDocumentationRenderItemsForFragment(documentUri, fragment);
    rawItems.push(...items);
  }
  return buildDocumentationMarkdownSectionRenderData(rawItems);
}

function chooseDocumentationVariableDisplayToken(assignments) {
  const sortedAssignments = [...(Array.isArray(assignments) ? assignments : [])].sort(
    (left, right) => Number(left?.startLine) - Number(right?.startLine)
  );
  const typedAssignment = sortedAssignments.find((assignment) =>
    /[@$&%]\{[^}\r\n]*:\s*[^}\r\n]+\}/.test(String(assignment?.variableToken || "").trim())
  );
  return String(typedAssignment?.variableToken || sortedAssignments[0]?.variableToken || "").trim();
}

function buildDocumentationVariableCurrentValuePreview(assignment) {
  if (!assignment) {
    return "(empty)";
  }
  if (String(assignment?.assignmentKind || "") === "keyword-return") {
    return `Return from ${String(assignment?.keywordName || "").trim() || "keyword"}`;
  }
  return formatDocumentationVariableValuePreview(
    extractCurrentValueFromSetVariableAssignment(assignment.valueRaw || "")
  );
}

function buildDocumentationVariableValueVariants(assignments) {
  const variants = [];
  const seenValues = new Set();
  for (const assignment of [...(Array.isArray(assignments) ? assignments : [])].sort(
    (left, right) => Number(left?.startLine) - Number(right?.startLine)
  )) {
    const displayValue = buildDocumentationVariableCurrentValuePreview(assignment);
    const key = normalizeComparableToken(displayValue);
    if (!key || seenValues.has(key)) {
      continue;
    }
    seenValues.add(key);
    variants.push({
      value: displayValue,
      assignment
    });
  }
  return variants;
}

function summarizeDocumentationConditionalCandidates(selection) {
  const candidates = [];
  const seenValues = new Set();

  for (const candidate of buildLocalVariableConditionalCandidates(selection)) {
    const displayValue = formatDocumentationVariableValuePreview(candidate?.value || "");
    const key = normalizeComparableToken(displayValue);
    if (seenValues.has(key)) {
      continue;
    }
    seenValues.add(key);
    candidates.push(displayValue);
  }

  return candidates;
}

function buildDocumentationValueLinkEntries(documentUri, candidates) {
  const valueLinks = [];
  const seenValues = new Set();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const displayValue = formatDocumentationVariableValuePreview(candidate?.value || "");
    const key = normalizeComparableToken(displayValue);
    if (!key || seenValues.has(key)) {
      continue;
    }
    seenValues.add(key);
    const sourceLine = Math.max(0, Number(candidate?.sourceLine) || 0);
    valueLinks.push({
      value: displayValue,
      sourceLine,
      commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
      label: `Open value source line ${sourceLine + 1}`
    });
  }

  return valueLinks;
}

function buildVariableDefinitionEntriesFromSources(variableAssignments, keywordReturnAssignments, normalizedVariable) {
  const safeNormalizedVariable = String(normalizedVariable || "").trim();
  if (!safeNormalizedVariable) {
    return [];
  }

  const localAssignmentKeys = new Set();
  const entries = [];
  for (const assignment of Array.isArray(variableAssignments) ? variableAssignments : []) {
    if (String(assignment?.normalizedVariable || "").trim() !== safeNormalizedVariable) {
      continue;
    }
    const startLine = Math.max(0, Number(assignment?.startLine) || 0);
    localAssignmentKeys.add(`${startLine}:${safeNormalizedVariable}`);
    entries.push({
      ...assignment,
      assignmentKind: "local"
    });
  }

  for (const assignment of Array.isArray(keywordReturnAssignments) ? keywordReturnAssignments : []) {
    const normalizedReturnVariables = Array.isArray(assignment?.normalizedReturnVariables)
      ? assignment.normalizedReturnVariables
      : [];
    if (!normalizedReturnVariables.includes(safeNormalizedVariable)) {
      continue;
    }
    const startLine = Math.max(0, Number(assignment?.startLine) || 0);
    if (localAssignmentKeys.has(`${startLine}:${safeNormalizedVariable}`)) {
      continue;
    }
    entries.push({
      id: `keyword:${assignment.id}:${safeNormalizedVariable}`,
      assignmentKind: "keyword-return",
      keywordAssignment: assignment,
      keywordName: assignment.keywordName,
      startLine: assignment.startLine,
      endLine: assignment.endLine,
      branchPath: cloneBranchPath(assignment.branchPath),
      branchGroupId: String(assignment.branchGroupId || ""),
      branchId: String(assignment.branchId || ""),
      ownerId: assignment.ownerId,
      ownerName: assignment.ownerName,
      section: assignment.section
    });
  }

  return entries;
}

function buildDocumentationLocalVariableSummaryEntries(documentUri, block) {
  const assignments = [...(Array.isArray(block?.variableAssignments) ? block.variableAssignments : [])].sort(
    (left, right) => Number(left?.startLine) - Number(right?.startLine)
  );
  if (assignments.length === 0) {
    return [];
  }

  const assignmentsByVariable = new Map();
  for (const assignment of assignments) {
    const normalizedVariable = String(assignment?.normalizedVariable || "").trim();
    if (!normalizedVariable) {
      continue;
    }
    const items = assignmentsByVariable.get(normalizedVariable) || [];
    items.push(assignment);
    assignmentsByVariable.set(normalizedVariable, items);
  }

  const referenceLine = Math.max(0, Number(block?.ownerEndLine) || Number(block?.endLine) || 0);
  const summaryEntries = [];

  for (const [normalizedVariable, items] of assignmentsByVariable.entries()) {
    const mixedEntries = buildVariableDefinitionEntriesFromSources(
      block?.variableAssignments,
      block?.keywordCallAssignments,
      normalizedVariable
    );
    const summarySelection = resolveVariableAssignmentSelectionFromAssignments(mixedEntries, referenceLine, []);
    const firstAssignment = items[0];
    const displayToken = chooseDocumentationVariableDisplayToken(items) || String(firstAssignment?.variableToken || "").trim();
    const valueVariants = buildDocumentationVariableValueVariants(mixedEntries);
    const hasMultipleValueVariants = valueVariants.length > 1;
    const primaryAssignment =
      summarySelection?.kind === "single"
        ? summarySelection.assignment
        : summarySelection?.candidates?.[0]?.assignment || firstAssignment;
    const latestAssignment = [...mixedEntries].sort((left, right) => Number(left?.startLine) - Number(right?.startLine)).at(-1);
    const sourceAssignment = hasMultipleValueVariants ? firstAssignment : latestAssignment || primaryAssignment || firstAssignment;
    const sourceLine = Math.max(0, Number(sourceAssignment?.startLine) || Number(firstAssignment?.startLine) || 0);
    const commandUri = buildOpenLocationCommandUri(documentUri, sourceLine);

    if (hasMultipleValueVariants || summarySelection?.kind === "conditional") {
      const valueLinks =
        hasMultipleValueVariants && valueVariants.length > 0
          ? buildDocumentationValueLinkEntries(
              documentUri,
              valueVariants.map((candidate) => ({
                value: candidate.value,
                sourceLine: candidate.assignment?.startLine
              }))
            )
          : buildDocumentationValueLinkEntries(
              documentUri,
              buildLocalVariableConditionalCandidates(summarySelection)
            );
      const candidateValues =
        valueLinks.length > 0
          ? valueLinks.map((candidate) => candidate.value)
          : summarizeDocumentationConditionalCandidates(summarySelection);
      summaryEntries.push({
        normalizedVariable,
        variableToken: displayToken,
        startLine: Math.max(0, Number(firstAssignment?.startLine) || 0),
        sourceLine,
        commandUri,
        label: `Open variable definitions for ${displayToken} starting at line ${sourceLine + 1}`,
        valuePreview: candidateValues.join(" | ") || "(empty)",
        valueLinks,
        hintText: "Ambiguous",
        isConditional: true
      });
      continue;
    }

    summaryEntries.push({
      normalizedVariable,
      variableToken: displayToken,
      startLine: Math.max(0, Number(firstAssignment?.startLine) || 0),
      sourceLine,
      commandUri,
      label: `Open ${getLocalVariableAssignmentSourceLabel(primaryAssignment)} line ${sourceLine + 1}`,
      valuePreview: buildDocumentationVariableCurrentValuePreview(primaryAssignment),
      valueLinks: [],
      hintText: "",
      isConditional: false
    });
  }

  return summaryEntries.sort((left, right) => left.startLine - right.startLine);
}

function buildDocumentationReturnedVariableEntries(documentUri, block) {
  const assignments = [...(Array.isArray(block?.keywordCallAssignments) ? block.keywordCallAssignments : [])].sort(
    (left, right) => Number(left?.startLine) - Number(right?.startLine)
  );
  const localAssignmentKeys = new Set(
    [...(Array.isArray(block?.variableAssignments) ? block.variableAssignments : [])]
      .map((assignment) => {
        const startLine = Math.max(0, Number(assignment?.startLine) || 0);
        const normalizedVariable = String(assignment?.normalizedVariable || "").trim();
        if (!normalizedVariable) {
          return "";
        }
        return `${startLine}:${normalizedVariable}`;
      })
      .filter(Boolean)
  );
  const entries = [];

  for (const assignment of assignments) {
    const returnVariables = Array.isArray(assignment?.returnVariables) ? assignment.returnVariables : [];
    for (const variableToken of returnVariables) {
      const trimmedVariableToken = String(variableToken || "").trim();
      if (!trimmedVariableToken) {
        continue;
      }
      const sourceLine = Math.max(0, Number(assignment?.startLine) || 0);
      const normalizedVariable = normalizeVariableLookupToken(trimmedVariableToken);
      if (normalizedVariable && localAssignmentKeys.has(`${sourceLine}:${normalizedVariable}`)) {
        continue;
      }
      entries.push({
        variableToken: trimmedVariableToken,
        sourceLine,
        commandUri: buildOpenLocationCommandUri(documentUri, sourceLine),
        label: `Open keyword return line ${sourceLine + 1}`,
        valuePreview: `Return from ${String(assignment?.keywordName || "").trim() || "keyword"}`
      });
    }
  }

  return entries;
}

function renderDocumentationReturnedVariablesToggleHtml(toggleKey, options = {}) {
  const safeToggleKey = String(toggleKey || "").trim();
  if (!safeToggleKey) {
    return "";
  }

  const showLabel = String(options.showLabel || "Show Returned Variables").trim() || "Show Returned Variables";
  const hideLabel = String(options.hideLabel || "Hide Returned Variables").trim() || "Hide Returned Variables";
  const documentUri = String(options.documentUri || "").trim();
  const blockId = String(options.blockId || "").trim();

  return `<div class="doc-variable-toggle-row">
            <button
              type="button"
              class="preview-action-button doc-variable-toggle-button"
              data-preview-toggle-target="${escapeHtmlAttribute(safeToggleKey)}"
              data-preview-toggle-show-label="${escapeHtmlAttribute(showLabel)}"
              data-preview-toggle-hide-label="${escapeHtmlAttribute(hideLabel)}"
              data-preview-toggle-document-uri="${escapeHtmlAttribute(documentUri)}"
              data-preview-toggle-block-id="${escapeHtmlAttribute(blockId)}"
              aria-expanded="false"
            >${escapeHtml(showLabel)}</button>
          </div>`;
}

function renderDocumentationVariableSectionHtml(title, entries, options = {}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0) {
    return "";
  }

  const sectionClassName = String(options.sectionClassName || "").trim();
  const sectionAttributes = [];
  const toggleKey = String(options.toggleKey || "").trim();
  if (toggleKey) {
    sectionAttributes.push(`data-preview-toggle-section="${escapeHtmlAttribute(toggleKey)}"`);
    if (options.initiallyVisible !== true) {
      sectionAttributes.push("hidden");
    }
  }

  const firstSourceLine = Math.max(0, Number(safeEntries[0]?.sourceLine) || 0);
  const headingCommandUri = buildOpenLocationCommandUri(String(options.documentUri || ""), firstSourceLine);
  const headingHtml = headingCommandUri
    ? `<a href="${escapeHtmlAttribute(headingCommandUri)}">${escapeHtml(title)}</a>`
    : escapeHtml(title);

  const rowsHtml = safeEntries
    .map((entry) => {
      const commandUri = String(entry?.commandUri || "").trim();
      const rowAttributes = [];
      if (commandUri) {
        rowAttributes.push(`data-source-command="${escapeHtmlAttribute(commandUri)}"`);
        rowAttributes.push('tabindex="0"');
        rowAttributes.push('role="link"');
      }

      const label = String(entry?.label || "").trim();
      if (label) {
        rowAttributes.push(`title="${escapeHtmlAttribute(label)}"`);
      }

      const hintHtml = String(entry?.hintText || "").trim()
        ? `<span class="doc-variable-hint">${escapeHtml(String(entry.hintText))}</span>`
        : "";
      const valueLinks = Array.isArray(entry?.valueLinks) ? entry.valueLinks : [];
      const valueHtml =
        valueLinks.length > 0
          ? valueLinks
              .map((valueLink) => {
                const valueCommandUri = String(valueLink?.commandUri || "").trim();
                const valueLabel = String(valueLink?.label || "").trim();
                if (!valueCommandUri) {
                  return escapeHtml(String(valueLink?.value || ""));
                }
                return `<a class="doc-variable-value-link" href="${escapeHtmlAttribute(valueCommandUri)}"${
                  valueLabel ? ` title="${escapeHtmlAttribute(valueLabel)}"` : ""
                }>${escapeHtml(String(valueLink?.value || ""))}</a>`;
              })
              .join('<span class="doc-variable-value-separator"> | </span>')
          : `${hintHtml}${escapeHtml(String(entry?.valuePreview || "(empty)"))}`;
      const prefixedValueHtml = valueLinks.length > 0 ? `${hintHtml}${valueHtml}` : valueHtml;

      return `<li class="doc-variable-row${commandUri ? " doc-clickable" : ""}" ${rowAttributes.join(" ")}>
                <code class="doc-variable-name">${escapeHtml(String(entry?.variableToken || ""))}</code>: <span class="doc-variable-value">${prefixedValueHtml}</span>
              </li>`;
    })
    .join("\n");

  const footerHtml = String(options.footerHtml || "").trim();
  return `<section class="doc-variable-section ${escapeHtmlAttribute(sectionClassName)}" ${sectionAttributes.join(" ")}>
            <h2 class="doc-variable-section-title">${headingHtml}</h2>
            <ul class="doc-variable-list">
              ${rowsHtml}
            </ul>
            ${footerHtml}
          </section>`;
}

async function renderDocumentationBlockHtml(documentUri, block, options = {}) {
  const includeReturnedVariables = options.includeReturnedVariables !== false;
  const returnedVariablesVisible = options.returnedVariablesVisible === true;
  const returnedVariablesToggleEnabled = options.returnedVariablesToggleEnabled !== false;
  const bodyRenderData = buildDocumentationBodyRenderData(documentUri, block);
  const bodyMarkdown = substituteDocumentationLocalVariableValues(bodyRenderData.markdown, block);
  const colorRenderData = prepareDocumentationColorMarkupForRender(bodyMarkdown);
  const bodyHtml = bodyRenderData.markdown
    ? applyDocumentationColorMarkupPlaceholders(
        expandArrowIndentTokensInRenderedHtml(
          await renderMarkdownToHtml(formatMarkdownForDisplay(colorRenderData.markdown))
        ),
        colorRenderData.replacements
      )
    : "";
  const encodedTargets = escapeHtmlAttribute(encodeURIComponent(JSON.stringify(bodyRenderData.targets || [])));
  const localVariableEntries = buildDocumentationLocalVariableSummaryEntries(documentUri, block);
  const returnedVariableEntries = includeReturnedVariables ? buildDocumentationReturnedVariableEntries(documentUri, block) : [];
  const shouldToggleReturnedVariables =
    returnedVariablesToggleEnabled && localVariableEntries.length > 0 && returnedVariableEntries.length > 0;
  const localVariableSectionHtml = renderDocumentationVariableSectionHtml(
    "Variables",
    localVariableEntries,
    {
      documentUri,
      sectionClassName: "doc-variable-section-primary",
      footerHtml: shouldToggleReturnedVariables
        ? renderDocumentationReturnedVariablesToggleHtml("returned-variables", {
            documentUri,
            blockId: block?.id || ""
          })
        : ""
    }
  );
  const returnedVariableSectionHtml = renderDocumentationVariableSectionHtml(
    "Returned Variables",
    returnedVariableEntries,
    {
      documentUri,
      sectionClassName: "doc-variable-section-secondary",
      toggleKey: shouldToggleReturnedVariables ? "returned-variables" : "",
      initiallyVisible: returnedVariablesVisible
    }
  );

  return [
    `<section class="doc-render-flow" data-doc-render-targets="${encodedTargets}">${bodyHtml}</section>`,
    localVariableSectionHtml,
    returnedVariableSectionHtml
  ]
    .filter((section) => String(section || "").trim().length > 0)
    .join("");
}

function stripDocumentationRenderTargetMarkers(markdown) {
  return String(markdown || "").replace(/<span class="doc-target-marker" data-doc-target-index="\d+"><\/span>/g, "");
}

function shouldIncludeReturnedVariablesForBlock(includeReturnedVariablesByBlockId, block) {
  if (!block || !block.id) {
    return false;
  }
  if (includeReturnedVariablesByBlockId === true) {
    return true;
  }
  if (includeReturnedVariablesByBlockId instanceof Set) {
    return includeReturnedVariablesByBlockId.has(block.id);
  }
  if (includeReturnedVariablesByBlockId instanceof Map) {
    return includeReturnedVariablesByBlockId.get(block.id) === true;
  }
  if (includeReturnedVariablesByBlockId && typeof includeReturnedVariablesByBlockId === "object") {
    return includeReturnedVariablesByBlockId[block.id] === true;
  }
  return false;
}

function buildDocumentationExportMarkdown(documentUri, block, options = {}) {
  const bodyRenderData = buildDocumentationBodyRenderData(documentUri, block);
  const bodyMarkdown = stripDocumentationRenderTargetMarkers(
    substituteDocumentationLocalVariableValues(bodyRenderData.markdown, block)
  ).trim();
  const title = String(block?.ownerName || block?.title || "Documentation").trim() || "Documentation";
  const lines = [`# ${title}`, ""];
  if (bodyMarkdown) {
    lines.push(bodyMarkdown, "");
  }

  const localVariableEntries = buildDocumentationLocalVariableSummaryEntries(documentUri, block);
  if (localVariableEntries.length > 0) {
    lines.push("## Variables", "");
    for (const entry of localVariableEntries) {
      const variableToken = String(entry?.variableToken || "").trim();
      const valuePreview =
        Array.isArray(entry?.valueLinks) && entry.valueLinks.length > 0
          ? entry.valueLinks.map((valueLink) => String(valueLink?.value || "").trim()).filter(Boolean).join(" | ")
          : String(entry?.valuePreview || "(empty)").trim();
      const hintText = String(entry?.hintText || "").trim();
      const hintPrefix = hintText ? ` (${hintText})` : "";
      lines.push(`- \`${variableToken}\`${hintPrefix}: ${valuePreview || "(empty)"}`);
    }
    lines.push("");
  }

  const returnedVariableEntries =
    options.includeReturnedVariables === true ? buildDocumentationReturnedVariableEntries(documentUri, block) : [];
  if (returnedVariableEntries.length > 0) {
    lines.push("## Returned Variables", "");
    for (const entry of returnedVariableEntries) {
      lines.push(`- \`${String(entry?.variableToken || "").trim()}\`: ${String(entry?.valuePreview || "").trim()}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function buildDocumentationExportMarkdownForBlocks(documentUri, blocks, options = {}) {
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  return `${safeBlocks
    .map((block) =>
      buildDocumentationExportMarkdown(documentUri, block, {
        includeReturnedVariables: shouldIncludeReturnedVariablesForBlock(
          options.includeReturnedVariablesByBlockId,
          block
        )
      }).trim()
    )
    .filter(Boolean)
    .join("\n\n<div style=\"page-break-after: always;\"></div>\n\n")}\n`;
}

function isDocumentationTestcaseExportBlock(block) {
  const section = String(block?.section || "").trim().toLowerCase();
  return section === "tests" || section === "tasks";
}

function buildDocumentationExportQuickPickItems(blocks) {
  return [...(Array.isArray(blocks) ? blocks : [])]
    .filter(isDocumentationTestcaseExportBlock)
    .map((block) => ({
      label: String(block.ownerName || block.title || "Documentation").trim() || "Documentation",
      description: `${Number(block.startLine) + 1}-${Number(block.endLine) + 1}`,
      detail: `Lines ${Number(block.startLine) + 1}-${Number(block.endLine) + 1}`,
      picked: true,
      blockId: block.id,
      block
    }));
}

function slugifyDocumentationExportName(value) {
  const slug = String(value || "documentation")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "documentation";
}

function buildDocumentationExportDefaultUri(sourceUri, block, extension) {
  const safeExtension = String(extension || "md").replace(/^\.+/, "") || "md";
  const fileName = `${slugifyDocumentationExportName(block?.ownerName || block?.title || "documentation")}.${safeExtension}`;
  if (sourceUri?.scheme === "file" && sourceUri.fsPath) {
    return vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), fileName));
  }
  return undefined;
}

function buildDocumentationSelectedExportDefaultUri(sourceUri, extension) {
  const safeExtension = String(extension || "md").replace(/^\.+/, "") || "md";
  if (sourceUri?.scheme === "file" && sourceUri.fsPath) {
    const parsedPath = path.parse(sourceUri.fsPath);
    return vscode.Uri.file(path.join(parsedPath.dir, `${parsedPath.name}-documentation.${safeExtension}`));
  }
  return undefined;
}

function buildDocumentationPdfExportPageHtml(title, renderedDocumentationHtml, index = 0) {
  const pageBreakClass = Number(index) > 0 ? " documentation-export-page-break" : "";
  return `<section class="documentation-export-page${pageBreakClass}">
    <h1>${escapeHtml(String(title || "Documentation"))}</h1>
    ${renderedDocumentationHtml}
  </section>`;
}

async function buildDocumentationPdfExportPagesHtml(documentUri, blocks, options = {}) {
  const sections = [];
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  for (let index = 0; index < safeBlocks.length; index += 1) {
    const block = safeBlocks[index];
    const includeReturnedVariables = shouldIncludeReturnedVariablesForBlock(
      options.includeReturnedVariablesByBlockId,
      block
    );
    const renderedHtml = await renderDocumentationBlockHtml(documentUri, block, {
      includeReturnedVariables,
      returnedVariablesVisible: includeReturnedVariables,
      returnedVariablesToggleEnabled: false
    });
    sections.push(
      buildDocumentationPdfExportPageHtml(
        block?.ownerName || block?.title || "Documentation",
        renderedHtml,
        index
      )
    );
  }
  return sections.join("\n");
}

function buildDocumentationPdfExportHtml(document, options = {}) {
  const title = String(options.title || "Documentation").trim() || "Documentation";
  const sourceLabel = document?.uri?.fsPath || document?.uri?.toString?.() || "";
  const bodyHtml = String(options.bodyHtml || "").trim();
  const browserMode = options.browserMode === true;
  const autoPrint = options.autoPrint === true;
  const primaryButtonLabel = browserMode ? "Print / Save as PDF" : "Open in Browser / Save as PDF";
  const toolbarNote = browserMode
    ? "Use the print dialog and choose \"Save as PDF\"."
    : "If VS Code print does nothing, open this in your browser and choose \"Save as PDF\" there.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
    }
    body {
      margin: 0;
      padding: 24px;
      color: #222;
      background: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .export-toolbar {
      position: sticky;
      top: 0;
      z-index: 1;
      margin: -24px -24px 20px -24px;
      padding: 10px 24px;
      border-bottom: 1px solid #ddd;
      background: #f6f6f6;
      color: #333;
    }
    .export-toolbar button {
      margin-right: 10px;
      padding: 4px 10px;
      border: 1px solid #999;
      border-radius: 4px;
      background: #fff;
      color: #222;
      cursor: pointer;
    }
    .export-toolbar .secondary-button {
      opacity: 0.8;
    }
    .source {
      margin: 0 0 12px 0;
      color: #666;
      font-size: 0.9em;
      word-break: break-all;
    }
    .preview {
      max-width: 900px;
    }
    .documentation-export-page {
      break-inside: auto;
      page-break-inside: auto;
    }
    .documentation-export-page-break {
      break-before: page;
      page-break-before: always;
    }
    .preview h1 {
      font-size: 1.65em;
    }
    .preview h2 {
      font-size: 1.35em;
      margin-top: 1.1em;
    }
    .preview h3 {
      font-size: 1.18em;
    }
    .preview :is(h1, h2, h3, h4, h5, h6) {
      line-height: 1.25;
      page-break-after: avoid;
    }
    .preview pre {
      padding: 8px;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      background: #f3f3f3;
      border-radius: 4px;
    }
    .preview code {
      padding: 1px 4px;
      border-radius: 3px;
      background: #eee;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .preview .doc-target-marker {
      display: none !important;
    }
    .preview .doc-clickable {
      cursor: default;
    }
    .preview [hidden] {
      display: block !important;
    }
    .preview .doc-variable-list {
      padding-left: 20px;
    }
    .preview .doc-variable-hint {
      display: inline-block;
      margin-right: 6px;
      padding: 1px 5px;
      border-radius: 999px;
      color: #fff;
      background: #666;
      font-size: 0.78em;
    }
    .preview .doc-color-span {
      border-radius: 3px;
      padding: 0 0.18em;
      font-weight: 600;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .preview .doc-color-note {
      color: #1d4ed8;
      background: #dbeafe;
    }
    .preview .doc-color-question {
      color: #7e22ce;
      background: #f3e8ff;
    }
    .preview .doc-color-warning {
      color: #c2410c;
      background: #ffedd5;
    }
    .preview .doc-color-error {
      color: #b42318;
      background: #fee2e2;
    }
    .preview .doc-color-success {
      color: #15803d;
      background: #dcfce7;
    }
    .preview .doc-color-custom {
      font-weight: 600;
    }
    .preview .robot-render-line {
      display: block;
    }
    .preview .robot-arrow-line {
      display: flex;
      align-items: baseline;
      column-gap: 1ch;
      padding-left: var(--robot-arrow-indent, 0ch);
    }
    .preview .robot-arrow-marker {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .preview .robot-arrow-marker-placeholder {
      visibility: hidden;
    }
    .preview .robot-arrow-body {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: break-word;
    }
    @media print {
      body {
        padding: 0;
      }
      .export-toolbar {
        display: none !important;
      }
      a {
        color: inherit;
        text-decoration: none;
      }
    }
  </style>
</head>
<body>
  <div class="export-toolbar">
    <button type="button" id="primary-print-action">${escapeHtml(primaryButtonLabel)}</button>
    ${browserMode ? "" : '<button type="button" id="try-webview-print" class="secondary-button">Try VS Code Print</button>'}
    <span>${escapeHtml(toolbarNote)}</span>
  </div>
  <main class="preview">
    ${sourceLabel ? `<div class="source">${escapeHtml(sourceLabel)}</div>` : ""}
    ${bodyHtml}
  </main>
  <script>
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    const primaryButton = document.getElementById('primary-print-action');
    if (primaryButton) {
      primaryButton.addEventListener('click', () => {
        if (${browserMode ? "true" : "false"} || !vscodeApi) {
          window.print();
          return;
        }
        vscodeApi.postMessage({ type: 'openDocumentationPdfInBrowser' });
      });
    }
    const webviewPrintButton = document.getElementById('try-webview-print');
    if (webviewPrintButton) {
      webviewPrintButton.addEventListener('click', () => window.print());
    }
    if (${autoPrint ? "true" : "false"}) {
      setTimeout(() => {
        try {
          window.print();
        } catch {
          // The toolbar button remains available.
        }
      }, 250);
    }
  </script>
</body>
</html>`;
}

async function openDocumentationPrintHtmlInBrowser(document, title, bodyHtml) {
  const html = buildDocumentationPdfExportHtml(document, {
    title,
    bodyHtml,
    browserMode: true,
    autoPrint: true
  });
  const filename = `robot-companion-${slugifyDocumentationExportName(title)}-${Date.now()}.html`;
  const targetUri = vscode.Uri.file(path.join(os.tmpdir(), filename));
  await vscode.workspace.fs.writeFile(targetUri, Buffer.from(html, "utf8"));
  await vscode.env.openExternal(targetUri);
}

function registerDocumentationPdfExportPanelHandlers(panel, document, title, bodyHtml) {
  const disposable = panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== "object" || message.type !== "openDocumentationPdfInBrowser") {
      return;
    }
    try {
      await openDocumentationPrintHtmlInBrowser(document, title, bodyHtml);
    } catch (error) {
      logRobotCompanionError("Failed to open documentation PDF export in browser", error);
      try {
        await vscode.window.showErrorMessage(
          "Robot Companion could not open the documentation export in your browser. See the Robot Companion output for details."
        );
      } catch {
        // no-op
      }
    }
  });
  panel.onDidDispose(() => disposable.dispose());
}

function styleEnumDetailsForPanel(renderedHtml) {
  const source = String(renderedHtml || "");
  if (!source) {
    return source;
  }

  let styled = source.replace(
    /<p[^>]*>([\s\S]*?Resolved current value:\s*)<code>([\s\S]*?)<\/code>([\s\S]*?)<\/p>/gi,
    (_match, prefix, currentValue, suffix) => {
      const safePrefix = String(prefix || "").replace(/<\/?em>/g, "");
      const safeSuffix = String(suffix || "").replace(/<\/?em>/g, "");
      return (
        '<p class="resolved-current-value-note">' +
        `${safePrefix}<span class="resolved-current-value-chip">${currentValue}</span>${safeSuffix}` +
        "</p>"
      );
    }
  );

  styled = styled.replace(
    /<p>(?:<em>)?Resolved from local\s*([\s\S]*?)(?:<\/em>)?<\/p>/g,
    '<p class="resolved-current-source-note">Resolved from local $1</p>'
  );

  styled = styled.replace(
    /(&lt;= current|<= current)/g,
    '<span class="enum-current-marker">$1</span>'
  );

  return styled;
}

function formatMarkdownForDisplay(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const normalized = [];
  let inFence = false;
  let previousMeaningfulLine = "";
  let activeArrowContinuationIndentWidth = undefined;

  for (const line of lines) {
    const fenceMatch = line.trimStart().startsWith("```");
    if (fenceMatch) {
      inFence = !inFence;
      normalized.push(line);
      activeArrowContinuationIndentWidth = undefined;
      continue;
    }

    if (inFence) {
      normalized.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      normalized.push(line);
      previousMeaningfulLine = "";
      activeArrowContinuationIndentWidth = undefined;
      continue;
    }

    const leadingWhitespace = (line.match(/^[ \t]*/) || [""])[0];
    const currentTrimmedStart = line.slice(leadingWhitespace.length);
    const currentTrimmed = line.trim();
    const previousTrimmed = previousMeaningfulLine.trim();
    const arrowPrefix = parseArrowPrefix(currentTrimmedStart);
    const currentIsArrowLine = Boolean(arrowPrefix);
    const previousIsBulletLine = /^[-*+](\s+.*)?$/.test(previousTrimmed);
    const currentStartsMarkdownBlock =
      isMarkdownHeadingLine(currentTrimmedStart) || isMarkdownListItemLine(currentTrimmedStart);
    const sourceIndentWidth = whitespaceVisualWidth(leadingWhitespace);

    let displayLine = line;
    if (currentIsArrowLine) {
      let arrowIndentWidth = 0;
      if (previousIsBulletLine) {
        arrowIndentWidth = 2 + Math.max(0, arrowPrefix.level - 1) * 2;
        displayLine = `${makeArrowIndentToken(arrowIndentWidth)}${arrowPrefix.marker}${
          arrowPrefix.rest ? ` ${arrowPrefix.rest}` : ""
        }`;
      } else {
        const nestingIndentWidth = Math.max(0, arrowPrefix.level - 1) * 2;
        const defaultTopLevelArrowIndent = sourceIndentWidth === 0 ? 2 : 0;
        arrowIndentWidth = sourceIndentWidth + nestingIndentWidth + defaultTopLevelArrowIndent;
        displayLine = `${makeArrowIndentToken(arrowIndentWidth)}${arrowPrefix.marker}${
          arrowPrefix.rest ? ` ${arrowPrefix.rest}` : ""
        }`;
      }
      activeArrowContinuationIndentWidth = arrowIndentWidth;
    } else if (
      Number.isFinite(Number(activeArrowContinuationIndentWidth)) &&
      sourceIndentWidth > 0 &&
      !currentStartsMarkdownBlock
    ) {
      displayLine = `${makeArrowIndentToken(activeArrowContinuationIndentWidth)}${currentTrimmedStart}`;
    } else {
      activeArrowContinuationIndentWidth = undefined;
    }

    normalized.push(displayLine.endsWith("  ") ? displayLine : `${displayLine}  `);
    previousMeaningfulLine = displayLine;
  }

  return normalized.join("\n");
}

function parseArrowPrefix(text) {
  const source = String(text || "");
  let cursor = 0;
  let level = 0;
  let marker = "";

  while (true) {
    const token = source.slice(cursor, cursor + 2);
    if (token !== "->" && token !== "=>") {
      break;
    }

    if (!marker) {
      marker = token;
    }
    level += 1;
    cursor += 2;
    while (source[cursor] === " " || source[cursor] === "\t") {
      cursor += 1;
    }
  }

  if (level === 0) {
    return null;
  }

  return {
    level,
    marker: marker || "->",
    rest: source.slice(cursor).trimStart()
  };
}

function whitespaceVisualWidth(whitespace) {
  let width = 0;
  for (const ch of String(whitespace || "")) {
    width += ch === "\t" ? 4 : 1;
  }
  return width;
}

function makeArrowIndentToken(width) {
  const safeWidth = Math.max(0, Number(width) || 0);
  return `[[RDP_INDENT_${safeWidth}]]`;
}

function stripArrowIndentTokens(markdown) {
  return String(markdown || "").replace(ARROW_INDENT_TOKEN_PATTERN, "");
}

function getConfig() {
  return vscode.workspace.getConfiguration(EXT_CONFIG_ROOT);
}

function getIndexImportFolderPatterns() {
  return normalizeGlobPatternArrayConfigValue(
    getConfig().get("indexImportFolderPatterns", DEFAULT_INDEX_IMPORT_FOLDER_PATTERNS),
    DEFAULT_INDEX_IMPORT_FOLDER_PATTERNS
  );
}

function getIndexExcludeFolderPatterns() {
  return normalizeGlobPatternArrayConfigValue(
    getConfig().get("indexExcludeFolderPatterns", DEFAULT_INDEX_EXCLUDE_FOLDER_PATTERNS),
    DEFAULT_INDEX_EXCLUDE_FOLDER_PATTERNS
  );
}

function isCodeLensEnabled() {
  return getConfig().get("enableCodeLens", true);
}

function isHoverPreviewEnabled() {
  return getConfig().get("enableHoverPreview", true);
}

function isEnumValueHoverEnabled() {
  return getConfig().get("enableEnumValueHover", true);
}

function isEnumArgumentFallbackEnabled() {
  return getConfig().get("enableEnumArgumentFallback", false);
}

function getEnumCompletionDisplayMode() {
  const rawMode = String(getConfig().get("enumCompletionDisplayMode", "name") || "name")
    .trim()
    .toLowerCase();
  if (ENUM_COMPLETION_DISPLAY_MODES.has(rawMode)) {
    return rawMode;
  }
  return "name";
}

function getRobotCompanionLogLevel() {
  const rawLevel = String(getConfig().get("logLevel", "warn") || "warn")
    .trim()
    .toLowerCase();
  if (ROBOT_COMPANION_LOG_LEVELS.has(rawLevel)) {
    return rawLevel;
  }
  return "warn";
}

function isVariableValueHoverEnabled() {
  return getConfig().get("enableVariableValueHover", true);
}

function isTypedVariableCompletionsEnabled() {
  return getConfig().get("enableTypedVariableCompletions", true);
}

function isReturnMemberCompletionsEnabled() {
  return getConfig().get("enableReturnMemberCompletions", true);
}

function isReturnValueHoverEnabled() {
  return getConfig().get("enableReturnValueHover", true);
}

function isReturnExplorerEnabled() {
  return getConfig().get("enableReturnExplorer", true);
}

function isAutoSyncSelectionEnabled() {
  return getConfig().get("autoSyncSelection", true);
}

function isOpenFilePrewarmEnabled() {
  return getConfig().get("enableOpenFilePrewarm", true);
}

function getOpenFilePrewarmMode() {
  const rawMode = String(getConfig().get("prewarmMode", "allOpen") || "allOpen")
    .trim()
    .toLowerCase();
  if (PREWARM_MODES.has(rawMode)) {
    return rawMode;
  }
  return "allOpen";
}

function isReturnTypeDiskCacheEnabled() {
  return getConfig().get("enableReturnTypeDiskCache", true);
}

function getReturnTypeCacheMaxEntries() {
  const raw = Number(getConfig().get("returnTypeCacheMaxEntries", RETURN_TYPE_CACHE_MAX_ENTRIES_DEFAULT));
  if (!Number.isFinite(raw)) {
    return RETURN_TYPE_CACHE_MAX_ENTRIES_DEFAULT;
  }
  return Math.max(50, Math.min(5000, Math.round(raw)));
}

function getDebounceMs() {
  const raw = Number(getConfig().get("debounceMs", 200));
  if (!Number.isFinite(raw)) {
    return 200;
  }
  return Math.max(0, Math.min(5000, Math.round(raw)));
}

function getHoverLineLimit() {
  const raw = Number(getConfig().get("hoverLineLimit", 300));
  if (!Number.isFinite(raw)) {
    return 300;
  }
  return Math.max(20, Math.min(500, Math.round(raw)));
}

function getEnumHoverMaxEnums() {
  const raw = Number(getConfig().get("enumHoverMaxEnums", 6));
  if (!Number.isFinite(raw)) {
    return 6;
  }
  return Math.max(1, Math.min(20, Math.round(raw)));
}

function getEnumHoverMaxMembers() {
  const raw = Number(getConfig().get("enumHoverMaxMembers", 30));
  if (!Number.isFinite(raw)) {
    return 30;
  }
  return Math.max(5, Math.min(500, Math.round(raw)));
}

function getReturnFieldNameStyle() {
  const rawStyle = String(getConfig().get("returnFieldNameStyle", "camelcase") || "camelcase")
    .trim()
    .toLowerCase();
  if (RETURN_FIELD_NAME_STYLES.has(rawStyle)) {
    return rawStyle;
  }
  return "camelcase";
}

function getReturnIncludeProperties() {
  return getConfig().get("returnIncludeProperties", true) !== false;
}

function getReturnSubtypeResolutionMode() {
  const rawMode = String(getConfig().get("returnSubtypeResolutionMode", "always") || "always")
    .trim()
    .toLowerCase();
  if (RETURN_SUBTYPE_RESOLUTION_MODES.has(rawMode)) {
    return rawMode;
  }
  return "always";
}

function getReturnSubtypeIncludeContainers() {
  return normalizeStringArrayConfigValue(getConfig().get("returnSubtypeIncludeContainers", []));
}

function getReturnSubtypeExcludeContainers() {
  return normalizeStringArrayConfigValue(getConfig().get("returnSubtypeExcludeContainers", []));
}

function normalizeStringArrayConfigValue(rawValue) {
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return rawValue
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0);
}

function normalizeGlobPatternArrayConfigValue(rawValue, fallbackValue = []) {
  const normalized = uniqueStrings(
    (Array.isArray(rawValue) ? rawValue : []).map((value) => String(value || "").trim()).filter(Boolean)
  );
  if (normalized.length > 0) {
    return normalized;
  }

  const normalizedFallback = uniqueStrings(
    (Array.isArray(fallbackValue) ? fallbackValue : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (normalizedFallback.length > 0) {
    return normalizedFallback;
  }
  return ["**"];
}

function getReturnHoverMaxDepth() {
  const raw = Number(getConfig().get("returnHoverMaxDepth", 1));
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(0, Math.min(8, Math.round(raw)));
}

function getReturnPreviewMaxDepth() {
  const raw = Number(getConfig().get("returnPreviewMaxDepth", 2));
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(0, Math.min(12, Math.round(raw)));
}

function getReturnMemberCompletionMaxDepth() {
  const raw = Number(getConfig().get("returnMemberCompletionMaxDepth", 2));
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(1, Math.min(12, Math.round(raw)));
}

function getReturnHintArgumentMaxDepth() {
  const raw = Number(getConfig().get("returnHintArgumentMaxDepth", 2));
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(1, Math.min(12, Math.round(raw)));
}

function getReturnMaxFieldsPerType() {
  return normalizeReturnMaxFieldsPerTypeValue(getConfig().get("returnMaxFieldsPerType", 0), 0);
}

function normalizeReturnMaxFieldsPerTypeValue(value, fallback = 0) {
  const raw = Number(value);
  const normalizedFallback = Number(fallback);
  if (!Number.isFinite(raw)) {
    return Number.isFinite(normalizedFallback) ? normalizedFallback : 0;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(5000, Math.round(raw)));
}

function getEffectiveReturnMaxFieldsPerType(value) {
  const normalized = normalizeReturnMaxFieldsPerTypeValue(value, 0);
  return normalized === 0 ? UNLIMITED_RETURN_FIELDS_PER_TYPE : normalized;
}

function serializeReturnMaxFieldsPerType(value) {
  const normalized = normalizeReturnMaxFieldsPerTypeValue(value, 0);
  return normalized === 0 ? "all" : String(normalized);
}

function getReturnTechnicalMaxDepth() {
  const raw = Number(getConfig().get("returnTechnicalMaxDepth", 5));
  if (!Number.isFinite(raw)) {
    return 5;
  }
  return Math.max(0, Math.min(12, Math.round(raw)));
}

function getReturnTechnicalMaxFieldsPerType() {
  const raw = Number(getConfig().get("returnTechnicalMaxFieldsPerType", 60));
  if (!Number.isFinite(raw)) {
    return 60;
  }
  return Math.max(1, Math.min(1000, Math.round(raw)));
}

function getVariableHoverLineLimit() {
  const raw = Number(getConfig().get("variableHoverLineLimit", 30));
  if (!Number.isFinite(raw)) {
    return 30;
  }
  return Math.max(1, Math.min(500, Math.round(raw)));
}

function hasLeadingMarkdownHeading(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    return /^#{1,6}\s+/.test(trimmed);
  }
  return false;
}

function escapeMarkdownInline(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function buildDocumentationPreviewWebviewHtmlForTest(state, selectedBlock, renderedMarkdownHtml) {
  const provider = new RobotDocPreviewViewProvider();
  provider._state = {
    ...createEmptyPreviewState(),
    ...(state || {})
  };
  return provider._buildHtml(selectedBlock, renderedMarkdownHtml);
}

module.exports = {
  activate,
  deactivate,
  __test__: {
    RobotDocumentationService,
    buildDocumentationPreviewActionsHtml,
    buildKeywordDocPreviewMarkdown,
    extractKeywordDocArgumentEntriesFromMarkdown,
    buildInsertKeywordArgumentCommandUri,
    parseManagedCommandUriInvocation,
    buildKeywordArgumentInsertPlan,
    findNearestBlock,
    getContainingBlockSpan,
    buildDocumentationFoldingRanges,
    buildDocumentationBodyFoldingRanges,
    buildDocumentationOverviewRanges,
    buildDocumentationBodyRenderData,
    renderDocumentationBlockHtml,
    buildDocumentationExportMarkdown,
    buildDocumentationExportMarkdownForBlocks,
    buildDocumentationExportQuickPickItems,
    buildDocumentationPdfExportPageHtml,
    buildDocumentationPdfExportPagesHtml,
    buildDocumentationPdfExportHtml,
    buildDocumentationPreviewWebviewHtmlForTest,
    expandArrowIndentTokensInRenderedHtml,
    buildOpenLocationCommandUri,
    createVariableValueHover,
    normalizeVariableLookupToken,
    resolveNamedArgumentCurrentValueFromSetVariable,
    resolveEnumValuePreviewFromContext,
    shouldPauseRobotCompanionInteractiveUiForDebug,
    shouldPauseRobotCompanionEditorManipulationForDebug,
    shouldPauseRobotCompanionKeywordArgumentInsertForDebug,
    shouldPauseRobotCompanionPassiveEditorFeaturesForDebug,
    shouldPauseRobotCompanionPrewarmForDebug,
    setRobotDebugPausedForTest(value) {
      ROBOT_DEBUG_PAUSED = Boolean(value);
    },
    parseStructuredTypesFromPythonSource,
    parseKeywordEnumHintsFromPythonSource,
    parseConvertUmlautDecoratorConfigFromPythonSource,
    finalizePythonKeywordDefinitionForIndex,
    finalizeStructuredTypeCamelCaseAccess,
    buildEnumPreviewMarkdown
  }
};

const path = require("path");
const vscode = require("vscode");

const EXT_CONFIG_ROOT = "robotDocPreview";
const VIEW_ID = "robotDocPreview.view";
const RETURN_VIEW_ID = "robotDocPreview.returnView";

const CMD_TOGGLE = "robotDocPreview.toggle";
const CMD_OPEN_CURRENT_BLOCK = "robotDocPreview.openCurrentBlock";
const CMD_OPEN_BLOCK_AT = "robotDocPreview.openBlockAt";
const CMD_INVALIDATE_CACHES = "robotDocPreview.invalidateCaches";
const CMD_OPEN_LOCATION = "robotDocPreview.openLocation";

const ROBOT_SELECTOR = [
  { language: "robotframework" },
  { pattern: "**/*.robot" },
  { pattern: "**/*.resource" }
];
const ARROW_INDENT_TOKEN_PATTERN = /\[\[RDP_INDENT_(\d+)\]\]/g;
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

function activate(context) {
  const parser = new RobotDocumentationService();
  const enumHintService = new RobotEnumHintService();
  const previewProvider = new RobotDocPreviewViewProvider();
  const controller = new RobotDocPreviewController(parser, previewProvider);
  const returnPreviewProvider = new RobotReturnPreviewViewProvider();
  const returnController = new RobotReturnExplorerController(parser, enumHintService, returnPreviewProvider);
  const codeLensProvider = new RobotDocCodeLensProvider(parser);

  context.subscriptions.push(
    parser,
    enumHintService,
    previewProvider,
    controller,
    returnPreviewProvider,
    returnController,
    codeLensProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, previewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(RETURN_VIEW_ID, returnPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerCodeLensProvider(ROBOT_SELECTOR, codeLensProvider),
    vscode.languages.registerHoverProvider(ROBOT_SELECTOR, new RobotDocHoverProvider(parser, enumHintService)),
    vscode.commands.registerCommand(CMD_TOGGLE, () => controller.togglePreview()),
    vscode.commands.registerCommand(CMD_OPEN_CURRENT_BLOCK, () => controller.openCurrentBlock()),
    vscode.commands.registerCommand(CMD_OPEN_BLOCK_AT, (uriString, blockId) =>
      controller.openBlockAt(uriString, blockId)
    ),
    vscode.commands.registerCommand(CMD_OPEN_LOCATION, async (uriString, line, character = 0) => {
      await openTextDocumentAtLocation(uriString, line, character);
    }),
    vscode.commands.registerCommand(CMD_INVALIDATE_CACHES, () => {
      parser.clearAll();
      enumHintService.invalidateAll();
      codeLensProvider.refresh();
      controller.refresh();
      returnController.refresh();
      void vscode.window.showInformationMessage("Robot Companion caches invalidated.");
    }),
    parser.onDidChange(() => codeLensProvider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(EXT_CONFIG_ROOT)) {
        return;
      }
      codeLensProvider.refresh();
      controller.refresh();
      returnController.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isPythonDocument(document)) {
        enumHintService.invalidateForUri(document.uri);
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      if (event.files.some((file) => isPythonPath(file.path))) {
        enumHintService.invalidateAll();
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      if (event.files.some((file) => isPythonPath(file.path))) {
        enumHintService.invalidateAll();
      }
    })
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
    const blocks = [];
    let currentSection = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const trimmed = line.trim();

      if (isSectionHeader(trimmed)) {
        currentSection = getRelevantSection(trimmed);
        continue;
      }

      if (!currentSection) {
        continue;
      }

      const docHeader = parseDocumentationHeader(line);
      if (!docHeader) {
        continue;
      }

      const owner = ownerByLine[lineIndex];
      const ownerName = owner ? owner.name : "Unknown Test/Keyword";
      const markdownLines = [];
      if (docHeader.inlineText.length > 0) {
        markdownLines.push(docHeader.inlineText);
      }

      let endLine = lineIndex;
      for (let nextLine = lineIndex + 1; nextLine < lines.length; nextLine += 1) {
        const continuation = parseContinuationLine(lines[nextLine]);
        if (!continuation.isContinuation) {
          break;
        }
        markdownLines.push(continuation.text);
        endLine = nextLine;
      }

      const markdown = markdownLines.join("\n");
      const title = deriveTitle(ownerName, markdown);
      const id = `${lineIndex}:${ownerName}`;

      blocks.push({
        id,
        ownerName,
        ownerId: owner ? owner.id : "",
        section: currentSection,
        title,
        markdown,
        startLine: lineIndex,
        endLine,
        range: new vscode.Range(lineIndex, 0, endLine, lines[endLine] ? lines[endLine].length : 0)
      });

      lineIndex = endLine;
    }

    const variableAssignments = parseVariableAssignments(lines, ownerByLine);
    const keywordCallAssignments = parseKeywordCallAssignments(lines, ownerByLine);
    const parsed = {
      uri: document.uri.toString(),
      version: document.version,
      fileName: path.basename(document.uri.fsPath || document.uri.path || document.uri.toString()),
      blocks,
      owners,
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
    this._indexByWorkspace = new Map();
  }

  dispose() {
    this._indexByWorkspace.clear();
  }

  invalidateAll() {
    this._indexByWorkspace.clear();
  }

  invalidateForUri(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }
    this._indexByWorkspace.delete(workspaceFolder.uri.toString());
  }

  async getIndexForDocument(document) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const key = workspaceFolder.uri.toString();
    const cached = this._indexByWorkspace.get(key);
    if (cached) {
      return cached;
    }

    const indexPromise = this._buildIndex(workspaceFolder);
    this._indexByWorkspace.set(key, indexPromise);

    try {
      return await indexPromise;
    } catch {
      this._indexByWorkspace.delete(key);
      return undefined;
    }
  }

  async _buildIndex(workspaceFolder) {
    const includePattern = new vscode.RelativePattern(workspaceFolder, "**/*.py");
    const resourceIncludePattern = new vscode.RelativePattern(workspaceFolder, "**/*.resource");
    const keywordRobotIncludePattern = new vscode.RelativePattern(workspaceFolder, "**/*[Kk]eywords*/**/*.robot");
    const excludePattern = "**/{.git,.venv,venv,__pycache__,node_modules,tests}/**";
    const [pythonFiles, resourceFiles, keywordRobotFiles] = await Promise.all([
      vscode.workspace.findFiles(includePattern, excludePattern),
      vscode.workspace.findFiles(resourceIncludePattern, excludePattern),
      vscode.workspace.findFiles(keywordRobotIncludePattern, excludePattern)
    ]);

    const filteredFiles = pythonFiles;
    const robotKeywordFiles = uniqueUrisByString(resourceFiles.concat(keywordRobotFiles));

    const enumsByName = new Map();
    const structuredTypesByName = new Map();
    const localEnumNamesByFile = new Map();
    const enumImportAliasesByFile = new Map();
    const keywordDefinitions = [];
    const robotKeywordDefinitions = [];

    for (const fileUri of filteredFiles) {
      let fileContent = "";
      try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        fileContent = Buffer.from(raw).toString("utf8");
      } catch {
        continue;
      }

      const filePath = fileUri.fsPath || fileUri.path;
      const enumDefinitions = parseEnumDefinitionsFromPythonSource(fileContent, filePath);
      for (const enumDefinition of enumDefinitions) {
        const existing = enumsByName.get(enumDefinition.name) || [];
        existing.push(enumDefinition);
        enumsByName.set(enumDefinition.name, existing);
      }
      localEnumNamesByFile.set(
        filePath,
        new Set(enumDefinitions.map((enumDefinition) => enumDefinition.name))
      );
      enumImportAliasesByFile.set(filePath, parseFromImportAliasesFromPythonSource(fileContent));

      const structuredTypeDefinitions = parseStructuredTypesFromPythonSource(fileContent, filePath);
      for (const structuredTypeDefinition of structuredTypeDefinitions) {
        const existing = structuredTypesByName.get(structuredTypeDefinition.name) || [];
        existing.push(structuredTypeDefinition);
        structuredTypesByName.set(structuredTypeDefinition.name, existing);
      }

      if (fileContent.includes("@keyword")) {
        keywordDefinitions.push(...parseKeywordEnumHintsFromPythonSource(fileContent, filePath));
      }
    }

    for (const fileUri of robotKeywordFiles) {
      let fileContent = "";
      try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        fileContent = Buffer.from(raw).toString("utf8");
      } catch {
        continue;
      }

      if (!/\*{3}\s*keywords?\s*\*{3}/i.test(fileContent)) {
        continue;
      }

      robotKeywordDefinitions.push(
        ...parseRobotKeywordDefinitionsFromSource(fileContent, fileUri.fsPath || fileUri.path)
      );
    }

    const enumNameSet = new Set(enumsByName.keys());
    const keywordArgs = new Map();
    const keywordArgAnnotations = new Map();
    const keywordReturns = new Map();

    for (const keywordDefinition of keywordDefinitions) {
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

    return {
      enumsByName,
      keywordArgs,
      keywordArgAnnotations,
      keywordReturns,
      localEnumNamesByFile,
      enumImportAliasesByFile,
      structuredTypesByName
    };
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
    if (!isRobotDocument(document) || !isCodeLensEnabled()) {
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

class RobotDocHoverProvider {
  constructor(parser, enumHintService) {
    this._parser = parser;
    this._enumHintService = enumHintService;
  }

  async provideHover(document, position) {
    if (!isRobotDocument(document)) {
      return undefined;
    }

    const parsed = this._parser.getParsed(document);
    if (isEnumValueHoverEnabled()) {
      try {
        const enumHover = await createEnumValueHover(document, position, this._enumHintService, parsed);
        if (enumHover) {
          return enumHover;
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-markdown-companion] Enum hover failed:", message);
      }
    }

    if (isVariableValueHoverEnabled()) {
      const variableHover = createVariableValueHover(document, parsed, position);
      if (variableHover) {
        return variableHover;
      }
    }

    if (isReturnValueHoverEnabled()) {
      try {
        const returnHover = await createKeywordReturnHover(
          document,
          parsed,
          position,
          this._enumHintService
        );
        if (returnHover) {
          return returnHover;
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-markdown-companion] Return hover failed:", message);
      }
    }

    if (!isHoverPreviewEnabled()) {
      return undefined;
    }

    const block = parsed.blocks.find(
      (candidate) => position.line >= candidate.startLine && position.line <= candidate.endLine
    );

    if (!block) {
      return undefined;
    }

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

    return new vscode.Hover(markdown, block.range);
  }
}

class RobotDocPreviewViewProvider {
  constructor() {
    this._view = undefined;
    this._renderSequence = 0;
    this._state = createEmptyPreviewState();
  }

  dispose() {
    this._view = undefined;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    this._view.webview.options = {
      enableCommandUris: true,
      enableScripts: true
    };
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
    const renderedMarkdownHtml = selectedBlock
      ? await renderMarkdownToHtml(formatMarkdownForDisplay(selectedBlock.markdown))
      : "<p class=\"muted\">No documentation block selected.</p>";

    if (!this._view || currentSequence !== this._renderSequence) {
      return;
    }

    this._view.webview.html = this._buildHtml(selectedBlock, renderedMarkdownHtml);
  }

  _buildHtml(selectedBlock, renderedMarkdownHtml) {
    const hasBlocks = this._state.blocks.length > 0;

    const blockItems = this._state.blocks
      .map((block) => {
        if (!this._state.documentUri) {
          return `<li class=\"list-item\">${escapeHtml(block.title)}</li>`;
        }

        const args = encodeURIComponent(JSON.stringify([this._state.documentUri, block.id]));
        const commandUri = `command:${CMD_OPEN_BLOCK_AT}?${args}`;
        const isActive = selectedBlock && selectedBlock.id === block.id;
        const activeClass = isActive ? " active" : "";

        return `<li class=\"list-item${activeClass}\"><a href=\"${commandUri}\">${escapeHtml(
          block.title
        )}</a><span class=\"owner\">${escapeHtml(block.ownerName)}</span></li>`;
      })
      .join("\n");

    const fileInfo = this._state.fileName
      ? `<div class=\"file\">${escapeHtml(this._state.fileName)}</div>`
      : "<div class=\"file muted\">Open a .robot file to start.</div>";

    const metadata = selectedBlock
      ? `<div class=\"meta\">Owner: ${escapeHtml(selectedBlock.ownerName)} | Lines: ${
          selectedBlock.startLine + 1
        }-${selectedBlock.endLine + 1}</div>`
      : "<div class=\"meta muted\">Move cursor into a [Documentation] block or use command palette.</div>";

    const message = this._state.infoMessage
      ? `<div class=\"notice\">${escapeHtml(this._state.infoMessage)}</div>`
      : "";

    const listContent = hasBlocks
      ? `<ul class=\"list\">${blockItems}</ul>`
      : "<div class=\"muted\">No [Documentation] blocks found in Test Cases/Tasks/Keywords.</div>";

    const previewTitle = selectedBlock
      ? hasLeadingMarkdownHeading(selectedBlock.markdown)
        ? ""
        : `<h2 class="preview-title">${escapeHtml(selectedBlock.title)}</h2>`
      : "<h2 class=\"preview-title\">Documentation Preview</h2>";

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
    .list-item {
      display: grid;
      grid-template-columns: 1fr;
      gap: 2px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-widget-border);
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
    .preview .robot-arrow-line {
      display: block;
      padding-left: var(--robot-arrow-indent, 0ch);
    }
    .preview pre {
      padding: 8px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .preview code {
      font-family: var(--vscode-editor-font-family);
    }
  </style>
</head>
<body>
  ${fileInfo}
  ${metadata}
  ${message}
  ${listContent}
  <div class="preview">
    ${previewTitle}
    ${renderedMarkdownHtml}
  </div>
  <script>
    (() => {
      const previewRoot = document.querySelector('.preview');
      if (!previewRoot) {
        return;
      }

      const candidates = previewRoot.querySelectorAll('p, li');
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
              cleaned +
              '</span>'
          );
        }

        element.innerHTML = rebuilt.join('');
      }
    })();
  </script>
</body>
</html>`;
  }
}

class RobotDocPreviewController {
  constructor(parser, previewProvider) {
    this._parser = parser;
    this._previewProvider = previewProvider;
    this._selectedBlockByUri = new Map();
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
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isRobotDocument(editor.document)) {
      this._previewProvider.update(
        createEmptyPreviewState("Open a .robot file and move the cursor into a [Documentation] block.")
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

  _onActiveEditorChanged(editor) {
    if (!editor) {
      this._previewProvider.update(createEmptyPreviewState("Open a .robot file to preview documentation."));
      return;
    }

    this._syncFromActiveEditor(editor);
  }

  _onSelectionChanged(event) {
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

    const key = event.document.uri.toString();
    const previousTimer = this._debounceTimers.get(key);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(key);
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
      infoMessage:
        parsed.blocks.length === 0
          ? "No [Documentation] blocks found in Test Cases/Tasks/Keywords sections."
          : ""
    });
  }

  async _focusPreviewView() {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.robotDocPreviewContainer");
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
  constructor() {
    this._view = undefined;
    this._renderSequence = 0;
    this._state = createEmptyReturnPreviewState();
  }

  dispose() {
    this._view = undefined;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    this._view.webview.options = {
      enableCommandUris: true,
      enableScripts: false
    };
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
    const renderedDetailsHtml = this._state.detailsMarkdown
      ? await renderMarkdownToHtml(this._state.detailsMarkdown)
      : "<p class=\"muted\">No return structure selected.</p>";

    if (!this._view || currentSequence !== this._renderSequence) {
      return;
    }

    this._view.webview.html = this._buildHtml(renderedDetailsHtml);
  }

  _buildHtml(renderedDetailsHtml) {
    const isEnumContext = this._state.contextKind === "enum";
    const targetLabel = isEnumContext ? "Argument" : "Variable";
    const fileInfo = this._state.fileName
      ? `<div class=\"file\">${escapeHtml(this._state.fileName)}</div>`
      : "<div class=\"file muted\">Open a .robot file to inspect keyword return structures.</div>";
    const metadata = this._state.keywordName
      ? `<div class=\"meta\">Owner: ${escapeHtml(this._state.ownerName || "-")} | ${targetLabel}: ${escapeHtml(
          this._state.variableToken || "-"
        )} | Keyword: ${escapeHtml(this._state.keywordName)}</div>`
      : "<div class=\"meta muted\">Place cursor on a keyword return variable or named argument value.</div>";
    const notice = this._state.infoMessage
      ? `<div class=\"notice\">${escapeHtml(this._state.infoMessage)}</div>`
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
  </style>
</head>
<body>
  ${fileInfo}
  ${metadata}
  ${notice}
  ${returnAnnotation}
  <div class="details">
    ${renderedDetailsHtml}
  </div>
</body>
</html>`;
  }
}

class RobotReturnExplorerController {
  constructor(parser, enumHintService, previewProvider) {
    this._parser = parser;
    this._enumHintService = enumHintService;
    this._previewProvider = previewProvider;
    this._syncSequence = 0;
    this._debounceTimers = new Map();
    this._disposables = [];

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this._onActiveEditorChanged(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this._onSelectionChanged(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this._onDocumentChanged(event)),
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

  refresh() {
    void this._syncFromActiveEditor();
  }

  _onActiveEditorChanged(editor) {
    void this._syncFromActiveEditor(editor);
  }

  _onSelectionChanged(event) {
    if (!isAutoSyncSelectionEnabled()) {
      return;
    }

    if (!event.textEditor || !isRobotDocument(event.textEditor.document)) {
      return;
    }

    void this._syncFromActiveEditor(event.textEditor);
  }

  _onDocumentChanged(event) {
    if (!isRobotDocument(event.document)) {
      return;
    }

    const key = event.document.uri.toString();
    const previousTimer = this._debounceTimers.get(key);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(key);
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || activeEditor.document.uri.toString() !== key) {
        return;
      }
      void this._syncFromActiveEditor(activeEditor);
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

    if (!vscode.window.activeTextEditor) {
      this._previewProvider.update(
        createEmptyReturnPreviewState("Open a .robot file and place cursor on a keyword return variable or argument.")
      );
    }
  }

  async _syncFromActiveEditor(editor = vscode.window.activeTextEditor) {
    const currentSequence = ++this._syncSequence;
    if (!isReturnExplorerEnabled()) {
      this._previewProvider.update(createEmptyReturnPreviewState("Return explorer is disabled in settings."));
      return;
    }

    if (!editor || !isRobotDocument(editor.document)) {
      this._previewProvider.update(
        createEmptyReturnPreviewState("Open a .robot file and place cursor on a keyword return variable or argument.")
      );
      return;
    }

    const parsed = this._parser.getParsed(editor.document);
    let returnContext;
    try {
      returnContext = await resolveKeywordReturnPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService,
        {
        maxDepth: getReturnPreviewMaxDepth(),
        maxFieldsPerType: getReturnMaxFieldsPerType()
        }
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-markdown-companion] Return explorer refresh failed:", message);
      if (currentSequence !== this._syncSequence) {
        return;
      }
      this._previewProvider.update(
        createEmptyReturnPreviewState("Failed to resolve return structure. Check Extension Host logs.")
      );
      return;
    }

    let enumContext = undefined;
    if (isEnumValueHoverEnabled()) {
      try {
        enumContext = await resolveEnumValuePreview(editor.document, editor.selection.active, this._enumHintService, {
          parsed,
          maxEnums: getEnumHoverMaxEnums(),
          maxMembers: getEnumHoverMaxMembers()
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn("[robot-markdown-companion] Enum side preview refresh failed:", message);
      }
    }

    if (currentSequence !== this._syncSequence) {
      return;
    }

    if (enumContext) {
      const owner = findOwnerForLine(parsed.owners, editor.selection.active.line);
      this._previewProvider.update({
        contextKind: "enum",
        fileName: parsed.fileName,
        ownerName: owner ? owner.name : "",
        variableToken: enumContext.argumentName,
        keywordName: enumContext.keywordName,
        returnAnnotation: "",
        detailsMarkdown: buildEnumPreviewMarkdown(enumContext),
        infoMessage: ""
      });
      return;
    }

    if (returnContext) {
      this._previewProvider.update({
        contextKind: "return",
        fileName: parsed.fileName,
        ownerName: returnContext.owner.name,
        variableToken: returnContext.variableToken.token,
        keywordName: returnContext.assignment.keywordName,
        returnAnnotation: returnContext.returnAnnotation,
        detailsMarkdown: buildReturnPreviewMarkdown(returnContext),
        infoMessage:
          returnContext.returnAnnotation.length === 0
            ? "No return annotation found for this keyword in indexed Python sources."
            : returnContext.simpleAccess.firstLevel.length === 0 && returnContext.technicalStructureLines.length === 0
            ? "No indexed structured return type resolved from this annotation."
            : ""
      });
      return;
    }

    if (!returnContext) {
      this._previewProvider.update(
        createEmptyReturnPreviewState("Place cursor on a variable or named argument in a keyword call.")
      );
      return;
    }
  }
}

function buildReturnPreviewMarkdown(context) {
  const lines = [];

  lines.push("### What You Can Access");
  lines.push("");
  if (context.returnAnnotation) {
    lines.push("```python");
    lines.push(context.returnAnnotation);
    lines.push("```");
    lines.push("");
  }

  if (context.simpleAccess.firstLevel.length === 0) {
    lines.push("_No structured type details available for this return annotation._");
    return lines.join("\n");
  }

  lines.push("#### First-Level Access");
  lines.push("```robotframework");
  lines.push(context.simpleAccess.firstLevel.join("\n"));
  lines.push("```");
  lines.push("");

  if (context.simpleAccess.secondLevel.length > 0) {
    lines.push("#### Second-Level Access");
    lines.push("```robotframework");
    lines.push(context.simpleAccess.secondLevel.join("\n"));
    lines.push("```");
    lines.push("");
  }

  if (context.technicalStructureLines.length > 0) {
    lines.push("### Technical Details (Developer)");
    lines.push("");
    lines.push("```text");
    lines.push(context.technicalStructureLines.join("\n"));
    lines.push("```");
  }

  return lines.join("\n");
}

function buildEnumPreviewMarkdown(context) {
  const lines = [];
  const currentValue = String(context.currentValue || context.argumentValue || "").trim();
  const hasResolvedValue = currentValue.length > 0 && currentValue !== String(context.argumentValue || "").trim();
  lines.push("### What This Argument Accepts");
  lines.push("");
  lines.push("```robotframework");
  lines.push(`${context.argumentName}=${context.argumentValue}`);
  lines.push("```");
  lines.push("");

  if (hasResolvedValue) {
    lines.push(`_Resolved current value: \`${currentValue}\` (from \`${context.argumentValue}\`)._`);
    lines.push("");
  }
  if (
    context.currentValueSource === "set-variable" &&
    Number.isFinite(Number(context.currentValueSourceLine)) &&
    Number(context.currentValueSourceLine) >= 0
  ) {
    const sourceLineNumber = Number(context.currentValueSourceLine) + 1;
    lines.push(`_Resolved from local \`Set Variable\` at line ${sourceLineNumber}._`);
    const setVariableCommand = buildOpenLocationCommandUri(context.documentUri, Number(context.currentValueSourceLine));
    if (setVariableCommand) {
      lines.push(`[Jump to Set Variable line ${sourceLineNumber}](${setVariableCommand})`);
    }
    lines.push("");
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

  const normalizedCurrentValue = currentValue.toLowerCase();
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
          return isEnumMemberMatch(member, normalizedCurrentValue) ? `${display}  <= current` : display;
        })
      );
    }
    lines.push("```");

    const matchingMembers = getEnumMatchingMembers(enumEntry, normalizedCurrentValue);
    if (matchingMembers.length > 0) {
      lines.push(`_Current resolves to: \`${formatEnumMemberForDisplay(matchingMembers[0])}\`._`);
    }

    if (members.length > shownMembers.length) {
      lines.push(
        `_Showing first ${shownMembers.length} of ${members.length} members for ${enumEntry.name}._`
      );
    }
    if (!doesEnumContainValue(enumEntry, normalizedCurrentValue)) {
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

  if (context.returnHintContext) {
    lines.push("");
    lines.push("### Return Hint For Argument Value");
    lines.push("");
    lines.push(`Keyword: \`${context.returnHintContext.assignment.keywordName}\``);
    const sourceLine = Number(context.returnHintContext.sourceLine);
    if (Number.isFinite(sourceLine) && sourceLine >= 0) {
      const sourceLineNumber = sourceLine + 1;
      lines.push(`Set at line: \`${sourceLineNumber}\``);
      const locationCommand = buildOpenLocationCommandUri(
        context.returnHintContext.sourceUri || context.documentUri,
        sourceLine
      );
      if (locationCommand) {
        lines.push(`[Jump to assignment line ${sourceLineNumber}](${locationCommand})`);
      }
    }
    if (context.returnHintContext.returnAnnotation) {
      lines.push("");
      lines.push("```python");
      lines.push(context.returnHintContext.returnAnnotation);
      lines.push("```");
    }
    if (context.returnHintContext.simpleAccess?.firstLevel?.length > 0) {
      const shownFirstLevel = context.returnHintContext.simpleAccess.firstLevel.slice(0, 12);
      lines.push("");
      lines.push("```robotframework");
      lines.push(shownFirstLevel.join("\n"));
      lines.push("```");
      if (context.returnHintContext.simpleAccess.firstLevel.length > shownFirstLevel.length) {
        lines.push(
          `_Showing first ${shownFirstLevel.length} of ${context.returnHintContext.simpleAccess.firstLevel.length} first-level return paths._`
        );
      }
    }
  }

  return lines.join("\n");
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

    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  }

  return ownerName;
}

function findNearestBlock(blocks, line) {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  const containing = blocks.find((block) => line >= block.startLine && line <= block.endLine);
  if (containing) {
    return containing;
  }

  let nearest = blocks[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    const distance = line < block.startLine ? block.startLine - line : line - block.endLine;
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
    fileName: "",
    ownerName: "",
    variableToken: "",
    keywordName: "",
    returnAnnotation: "",
    detailsMarkdown: "",
    infoMessage
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

function parseVariableAssignments(lines, ownerByLine) {
  const assignments = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const owner = ownerByLine[lineIndex];
    if (!owner) {
      continue;
    }

    const assignment = parseSetVariableAssignment(lines, lineIndex);
    if (!assignment) {
      continue;
    }

    assignments.push({
      ...assignment,
      ownerId: owner.id,
      ownerName: owner.name,
      section: owner.section
    });
  }

  return assignments;
}

function parseKeywordCallAssignments(lines, ownerByLine) {
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
      section: owner.section
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
    normalizedVariable: normalizeVariableToken(variableToken),
    valueRaw: valueLines.join("\n"),
    startLine: lineIndex,
    endLine,
    range: new vscode.Range(lineIndex, 0, endLine, lines[endLine] ? lines[endLine].length : 0)
  };
}

function createVariableValueHover(document, parsed, position) {
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
  let selectedAssignment = undefined;
  for (const assignment of parsed.variableAssignments) {
    if (assignment.ownerId !== owner.id) {
      continue;
    }
    if (assignment.normalizedVariable !== normalizedVariable) {
      continue;
    }
    if (assignment.startLine > position.line) {
      continue;
    }
    if (!selectedAssignment || assignment.startLine > selectedAssignment.startLine) {
      selectedAssignment = assignment;
    }
  }

  if (!selectedAssignment) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = false;
  markdown.appendMarkdown("### Robot Variable Value\n\n");
  markdown.appendMarkdown("**Variable:** ");
  markdown.appendText(variableToken.token);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Owner:** ");
  markdown.appendText(owner.name);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown(`**Source:** \`Set Variable\` at line ${selectedAssignment.startLine + 1}\n\n`);

  const valueLines =
    selectedAssignment.valueRaw.length === 0 ? [] : selectedAssignment.valueRaw.split(/\r?\n/);
  const lineLimit = getVariableHoverLineLimit();
  const isTruncated = lineLimit > 0 && valueLines.length > lineLimit;
  const shownLines = isTruncated ? valueLines.slice(0, lineLimit) : valueLines;

  if (shownLines.length === 0) {
    markdown.appendMarkdown("_Assigned empty value._");
  } else {
    markdown.appendCodeblock(shownLines.join("\n"), "robotframework");
  }

  if (isTruncated) {
    markdown.appendMarkdown(
      `\n\n_Showing first ${lineLimit} of ${valueLines.length} value lines in hover._`
    );
  }

  const range = new vscode.Range(position.line, variableToken.start, position.line, variableToken.end);
  return new vscode.Hover(markdown, range);
}

async function createKeywordReturnHover(document, parsed, position, enumHintService) {
  const context = await resolveKeywordReturnPreview(document, parsed, position, enumHintService, {
    maxDepth: getReturnHoverMaxDepth(),
    maxFieldsPerType: getReturnMaxFieldsPerType()
  });
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
      const hoverSecondLevelLimit = 24;
      const shownSecondLevel = context.simpleAccess.secondLevel.slice(0, hoverSecondLevelLimit);
      markdown.appendMarkdown("\n**Second-level access:**\n");
      markdown.appendCodeblock(shownSecondLevel.join("\n"), "robotframework");
      if (context.simpleAccess.secondLevel.length > shownSecondLevel.length) {
        markdown.appendMarkdown(
          `\n_Showing first ${shownSecondLevel.length} of ${context.simpleAccess.secondLevel.length} second-level paths in hover._`
        );
      }
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

  const variableContext = getKeywordReturnVariableContextAtPosition(document, parsed, position);
  if (!variableContext) {
    return undefined;
  }

  const index = await enumHintService.getIndexForDocument(document);
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(variableContext.assignment.keywordName);
  const returnAnnotation = String(index.keywordReturns?.get(normalizedKeyword) || "").trim();
  const rootTypeNames = extractIndexedTypeNamesFromAnnotation(returnAnnotation, index);
  const simpleAccess = buildSimpleReturnAccessPaths(variableContext.variableToken.token, rootTypeNames, index, {
    maxFieldsPerType: Math.max(1, Number(options.maxFieldsPerType) || 1)
  });
  const technicalStructureLines = buildReturnStructureLines(
    rootTypeNames,
    index,
    {
      maxDepth: getReturnTechnicalMaxDepth(),
      maxFieldsPerType: getReturnTechnicalMaxFieldsPerType()
    },
    "technical"
  );

  return {
    ...variableContext,
    normalizedKeyword,
    returnAnnotation,
    rootTypeNames,
    simpleAccess,
    technicalStructureLines
  };
}

function getKeywordReturnVariableContextAtPosition(document, parsed, position) {
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
  let selectedAssignment = undefined;
  for (const assignment of parsed.keywordCallAssignments) {
    if (assignment.ownerId !== owner.id) {
      continue;
    }
    if (!assignment.normalizedReturnVariables.includes(normalizedVariable)) {
      continue;
    }
    if (assignment.startLine > position.line) {
      continue;
    }
    if (!selectedAssignment || assignment.startLine > selectedAssignment.startLine) {
      selectedAssignment = assignment;
    }
  }

  if (!selectedAssignment) {
    return undefined;
  }

  return {
    owner,
    variableToken,
    assignment: selectedAssignment
  };
}

function resolveNamedArgumentCurrentValueFromSetVariable(argumentValue, parsed, line) {
  const rawValue = String(argumentValue || "").trim();
  const fallback = {
    value: rawValue,
    source: "argument",
    sourceLine: undefined
  };

  if (!rawValue || !/^[@$&%]\{[^}\r\n]+\}$/.test(rawValue)) {
    return fallback;
  }

  if (!parsed || !Array.isArray(parsed.owners) || !Array.isArray(parsed.variableAssignments)) {
    return fallback;
  }

  const owner = findOwnerForLine(parsed.owners, line);
  if (!owner) {
    return fallback;
  }

  const normalizedVariable = normalizeVariableLookupToken(rawValue);
  let selectedAssignment = undefined;
  for (const assignment of parsed.variableAssignments) {
    if (assignment.ownerId !== owner.id) {
      continue;
    }
    if (assignment.normalizedVariable !== normalizedVariable) {
      continue;
    }
    if (assignment.startLine > line) {
      continue;
    }
    if (!selectedAssignment || assignment.startLine > selectedAssignment.startLine) {
      selectedAssignment = assignment;
    }
  }

  if (!selectedAssignment) {
    return fallback;
  }

  const resolvedValue = extractCurrentValueFromSetVariableAssignment(selectedAssignment.valueRaw);
  if (!resolvedValue) {
    return fallback;
  }

  return {
    value: resolvedValue,
    source: "set-variable",
    sourceLine: selectedAssignment.startLine,
    assignment: selectedAssignment
  };
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

async function resolveReturnHintForArgumentValue(document, parsed, context, position, enumHintService) {
  if (!document || !parsed || !context || !position || !enumHintService) {
    return undefined;
  }

  const rawArgumentValue = String(context.argumentValue || "").trim();
  if (!rawArgumentValue || !/^[@$&%]\{[^}\r\n]+\}$/.test(rawArgumentValue)) {
    return undefined;
  }

  if (!Array.isArray(parsed.keywordCallAssignments) || !Array.isArray(parsed.owners)) {
    return undefined;
  }

  const owner = findOwnerForLine(parsed.owners, position.line);
  if (!owner) {
    return undefined;
  }

  const normalizedVariable = normalizeVariableLookupToken(rawArgumentValue);
  let selectedAssignment = undefined;
  for (const assignment of parsed.keywordCallAssignments) {
    if (assignment.ownerId !== owner.id) {
      continue;
    }
    if (!Array.isArray(assignment.normalizedReturnVariables)) {
      continue;
    }
    if (!assignment.normalizedReturnVariables.includes(normalizedVariable)) {
      continue;
    }
    if (assignment.startLine > position.line) {
      continue;
    }
    if (!selectedAssignment || assignment.startLine > selectedAssignment.startLine) {
      selectedAssignment = assignment;
    }
  }

  if (!selectedAssignment) {
    return undefined;
  }

  const index = await enumHintService.getIndexForDocument(document);
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(selectedAssignment.keywordName);
  const returnAnnotation = String(index.keywordReturns?.get(normalizedKeyword) || "").trim();
  const rootTypeNames = extractIndexedTypeNamesFromAnnotation(returnAnnotation, index);
  const simpleAccess = buildSimpleReturnAccessPaths(rawArgumentValue, rootTypeNames, index, {
    maxFieldsPerType: getReturnMaxFieldsPerType()
  });

  return {
    owner,
    assignment: selectedAssignment,
    sourceUri: document.uri.toString(),
    sourceLine: selectedAssignment.startLine,
    variableToken: {
      token: rawArgumentValue,
      start: context.hoverStart,
      end: context.hoverEnd
    },
    normalizedKeyword,
    returnAnnotation,
    rootTypeNames,
    simpleAccess,
    technicalStructureLines: buildReturnStructureLines(
      rootTypeNames,
      index,
      {
        maxDepth: getReturnTechnicalMaxDepth(),
        maxFieldsPerType: getReturnTechnicalMaxFieldsPerType()
      },
      "technical"
    )
  };
}

function extractIndexedTypeNamesFromAnnotation(annotation, index) {
  if (!annotation) {
    return [];
  }

  const tokens = String(annotation).match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const names = [];
  for (const token of tokens) {
    const normalizedToken = String(token).toLowerCase();
    if (PYTHON_IGNORED_TYPE_TOKENS.has(normalizedToken)) {
      continue;
    }

    if (index.structuredTypesByName?.has(token) || index.enumsByName?.has(token)) {
      names.push(token);
    }
  }

  return uniqueStrings(names);
}

function buildSimpleReturnAccessPaths(variableToken, rootTypeNames, index, options = {}) {
  const baseVariableToken = getVariableRootToken(variableToken);
  const maxFieldsPerType = Math.max(1, Number(options.maxFieldsPerType) || 1);
  const firstLevelFields = collectDeclaredFieldsForTypes(rootTypeNames, index);
  const firstLevelPaths = [];
  for (const field of firstLevelFields.slice(0, maxFieldsPerType)) {
    const path = buildRobotAttributeAccessToken(baseVariableToken, [field.name]);
    if (path) {
      firstLevelPaths.push(path);
    }
  }

  const secondLevelPaths = [];
  for (const firstField of firstLevelFields.slice(0, maxFieldsPerType)) {
    const nestedTypeNames = extractIndexedTypeNamesFromAnnotation(firstField.annotation, index);
    if (nestedTypeNames.length === 0) {
      continue;
    }
    const secondLevelFields = collectDeclaredFieldsForTypes(nestedTypeNames, index).slice(0, maxFieldsPerType);
    for (const secondField of secondLevelFields) {
      const path = buildRobotAttributeAccessToken(baseVariableToken, [firstField.name, secondField.name]);
      if (path) {
        secondLevelPaths.push(path);
      }
    }
  }

  return {
    firstLevel: uniqueStrings(firstLevelPaths),
    secondLevel: uniqueStrings(secondLevelPaths)
  };
}

function buildRobotAttributeAccessToken(baseVariableToken, segments) {
  const match = String(baseVariableToken || "").match(/^([@$&%])\{([^}\r\n]+)\}$/);
  if (!match) {
    return "";
  }

  const normalizedSegments = (segments || []).map((segment) => String(segment || "").trim()).filter(Boolean);
  if (normalizedSegments.length === 0) {
    return "";
  }

  return `${match[1]}{${match[2]}.${normalizedSegments.join(".")}}`;
}

function collectDeclaredFieldsForTypes(typeNames, index) {
  const combinedFields = [];
  for (const typeName of uniqueStrings(typeNames || [])) {
    combinedFields.push(...collectDeclaredFieldsForType(typeName, index, new Set()));
  }
  return dedupeFieldDescriptorsByName(combinedFields);
}

function collectDeclaredFieldsForType(typeName, index, visited) {
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (visited.has(normalizedTypeName)) {
    return [];
  }

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [];
  }

  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates);
  const nextVisited = new Set(visited);
  nextVisited.add(normalizedTypeName);

  const fields = dedupeStructuredFields(selectedType.fields || []).filter(
    (field) => !SIMPLE_RETURN_IGNORED_FIELD_NAMES.has(normalizeComparableToken(field.name))
  );

  const inheritedTypeNames = (selectedType.baseTypeNames || []).filter(
    (baseTypeName) =>
      normalizeComparableToken(baseTypeName) !== normalizedTypeName &&
      (index.structuredTypesByName?.get(baseTypeName) || []).some((candidate) => candidate.isDataclass)
  );

  const inheritedFields = [];
  for (const inheritedTypeName of inheritedTypeNames) {
    inheritedFields.push(...collectDeclaredFieldsForType(inheritedTypeName, index, nextVisited));
  }

  return dedupeFieldDescriptorsByName(fields.concat(inheritedFields));
}

function dedupeFieldDescriptorsByName(fields) {
  const dedupedFields = [];
  const seenFieldNames = new Set();
  for (const field of fields || []) {
    const normalizedName = normalizeComparableToken(field.name);
    if (!normalizedName || seenFieldNames.has(normalizedName)) {
      continue;
    }
    seenFieldNames.add(normalizedName);
    dedupedFields.push(field);
  }
  return dedupedFields;
}

function buildReturnStructureLines(rootTypeNames, index, options, mode = "simple") {
  if (!Array.isArray(rootTypeNames) || rootTypeNames.length === 0) {
    return [];
  }

  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const maxDepth = Math.max(0, Number(options.maxDepth) || 0);
  const maxFieldsPerType = Math.max(1, Number(options.maxFieldsPerType) || 1);
  const lines = [];

  for (let indexOfType = 0; indexOfType < rootTypeNames.length; indexOfType += 1) {
    const typeName = rootTypeNames[indexOfType];
    if (indexOfType > 0) {
      lines.push("");
    }
    lines.push(
      ...renderIndexedTypeTree(typeName, index, 0, maxDepth, maxFieldsPerType, new Set(), normalizedMode)
    );
  }

  return lines;
}

function renderIndexedTypeTree(typeName, index, depth, maxDepth, maxFieldsPerType, visited, mode) {
  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const indent = "  ".repeat(depth);
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (visited.has(normalizedTypeName)) {
    return [`${indent}${typeName} (recursive)`];
  }

  const enumCandidates = index.enumsByName?.get(typeName) || [];
  if (enumCandidates.length > 0) {
    const firstEnum = enumCandidates[0];
    const lines = [`${indent}${typeName} (enum)`];
    const members = firstEnum.members || [];
    const shownMembers = members.slice(0, Math.min(maxFieldsPerType, 15));
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

  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates);
  const typeLabel =
    normalizedMode === "technical"
      ? `${typeName} (${selectedType.isDataclass ? "dataclass" : "typed class"})`
      : typeName;
  const lines = [`${indent}${typeLabel}`];

  const nextVisited = new Set(visited);
  nextVisited.add(normalizedTypeName);

  const fields = selectedType.fields || [];
  const shownFields = fields.slice(0, maxFieldsPerType);
  for (const field of shownFields) {
    lines.push(
      normalizedMode === "technical"
        ? `${indent}  .${field.name}`
        : `${indent}  - ${field.name}`
    );
    if (depth >= maxDepth) {
      continue;
    }

    const nestedTypes = uniqueStrings(
      extractIndexedTypeNamesFromAnnotation(field.annotation, index).filter(
        (nestedTypeName) => normalizeComparableToken(nestedTypeName) !== normalizedTypeName
      )
    );
    const shownNestedTypes = nestedTypes.slice(0, 2);
    for (const nestedTypeName of shownNestedTypes) {
      lines.push(
        ...renderIndexedTypeTree(
          nestedTypeName,
          index,
          depth + 1,
          maxDepth,
          maxFieldsPerType,
          nextVisited,
          normalizedMode
        )
      );
    }
  }

  if (fields.length > shownFields.length) {
    lines.push(`${indent}  ... ${fields.length - shownFields.length} more fields`);
  }

  const inheritedTypeNames = (selectedType.baseTypeNames || []).filter(
    (baseTypeName) =>
      normalizeComparableToken(baseTypeName) !== normalizedTypeName &&
      (index.enumsByName?.has(baseTypeName) ||
        (index.structuredTypesByName?.get(baseTypeName) || []).some((candidate) => candidate.isDataclass))
  );
  if (inheritedTypeNames.length > 0) {
    if (depth >= maxDepth) {
      lines.push(
        normalizedMode === "technical"
          ? `${indent}  [inherits] ${inheritedTypeNames.join(", ")}`
          : `${indent}  inherits: ${inheritedTypeNames.join(", ")}`
      );
    } else {
      lines.push(normalizedMode === "technical" ? `${indent}  [inherits]` : `${indent}  inherits`);
      const shownInheritedTypeNames = inheritedTypeNames.slice(0, 5);
      for (const inheritedTypeName of shownInheritedTypeNames) {
        lines.push(
          ...renderIndexedTypeTree(
            inheritedTypeName,
            index,
            depth + 1,
            maxDepth,
            maxFieldsPerType,
            nextVisited,
            normalizedMode
          )
        );
      }
      if (inheritedTypeNames.length > shownInheritedTypeNames.length) {
        lines.push(
          `${indent}  ... ${inheritedTypeNames.length - shownInheritedTypeNames.length} more inherited types`
        );
      }
    }
  }

  return lines;
}

function choosePreferredStructuredTypeDefinition(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return undefined;
  }

  const sorted = [...candidates].sort((left, right) => {
    const leftDataclassScore = left.isDataclass ? 1 : 0;
    const rightDataclassScore = right.isDataclass ? 1 : 0;
    if (leftDataclassScore !== rightDataclassScore) {
      return rightDataclassScore - leftDataclassScore;
    }

    const leftFieldCount = Array.isArray(left.fields) ? left.fields.length : 0;
    const rightFieldCount = Array.isArray(right.fields) ? right.fields.length : 0;
    return rightFieldCount - leftFieldCount;
  });
  return sorted[0];
}

function findOwnerForLine(owners, line) {
  if (!Array.isArray(owners)) {
    return undefined;
  }
  return owners.find((owner) => line >= owner.startLine && line <= owner.endLine);
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

  const root = body.split(/[.\[]/, 1)[0].trim();
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

async function createEnumValueHover(document, position, enumHintService, parsed) {
  const context = await resolveEnumValuePreview(document, position, enumHintService, {
    parsed,
    maxEnums: getEnumHoverMaxEnums(),
    maxMembers: getEnumHoverMaxMembers()
  });
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
  markdown.appendMarkdown(shownEnums.length > 0 ? "### Robot Enum Hint\n\n" : "### Robot Argument Hint\n\n");
  markdown.appendMarkdown("**Keyword:** ");
  markdown.appendText(context.keywordName);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Argument:** ");
  markdown.appendText(context.argumentName);
  markdown.appendMarkdown("  \n");
  if (String(context.currentValue || "").trim() !== String(context.argumentValue || "").trim()) {
    markdown.appendMarkdown("**Argument value:** ");
    markdown.appendText(context.argumentValue);
    markdown.appendMarkdown("  \n");
  }
  markdown.appendMarkdown("**Current value:** ");
  markdown.appendText(String(context.currentValue || context.argumentValue || ""));
  markdown.appendMarkdown("\n\n");
  if (
    context.currentValueSource === "set-variable" &&
    Number.isFinite(Number(context.currentValueSourceLine)) &&
    Number(context.currentValueSourceLine) >= 0
  ) {
    const sourceLineNumber = Number(context.currentValueSourceLine) + 1;
    markdown.appendMarkdown("**Value source:** ");
    markdown.appendMarkdown(`\`Set Variable\` line ${sourceLineNumber}`);
    const setVariableCommand = buildOpenLocationCommandUri(context.documentUri, Number(context.currentValueSourceLine));
    if (setVariableCommand) {
      markdown.appendMarkdown(`  \n[Jump to Set Variable line ${sourceLineNumber}](${setVariableCommand})`);
    }
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
  const normalizedCurrentValue = String(context.currentValue || context.argumentValue || "").toLowerCase();
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

  if (context.returnHintContext) {
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
      if (locationCommand) {
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

    const firstLevel = context.returnHintContext.simpleAccess?.firstLevel || [];
    if (firstLevel.length > 0) {
      const shownFirstLevel = firstLevel.slice(0, 12);
      markdown.appendMarkdown("\n**First-level access:**\n");
      markdown.appendCodeblock(shownFirstLevel.join("\n"), "robotframework");
      if (firstLevel.length > shownFirstLevel.length) {
        markdown.appendMarkdown(
          `\n_Showing first ${shownFirstLevel.length} of ${firstLevel.length} first-level return paths._`
        );
      }
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

  const parsed = options.parsed;
  const currentValueResolution = resolveNamedArgumentCurrentValueFromSetVariable(context.argumentValue, parsed, position.line);
  const currentValue = currentValueResolution.value;
  const returnHintContext = await resolveReturnHintForArgumentValue(
    document,
    parsed,
    context,
    position,
    enumHintService
  );

  const index = await enumHintService.getIndexForDocument(document);
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
    currentValueSource: currentValueResolution.source,
    currentValueSourceLine: currentValueResolution.sourceLine,
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
    hoverStart: namedArgument.hoverStart,
    hoverEnd: namedArgument.hoverEnd
  };
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
  const cells = splitRobotCellsWithRanges(lineText);
  if (cells.length === 0) {
    return "";
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

  const keywordName = cells[keywordIndex]?.text.trim() || "";
  if (!keywordName) {
    return "";
  }

  if (ROBOT_CONTROL_CELLS.has(keywordName.toLowerCase())) {
    return "";
  }

  return keywordName;
}

function findNamedArgumentAtPosition(lineText, character) {
  const cells = splitRobotCellsWithRanges(lineText);
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

    const rawValue = cell.text.slice(eqIndex + 1);
    const trimmedValue = rawValue.replace(/^\s+/, "");
    const nameStartOffset = namePart.indexOf(name);
    const nameStart = cell.start + Math.max(0, nameStartOffset);
    const nameEnd = nameStart + name.length;
    const leftTrimmedLength = rawValue.length - trimmedValue.length;
    const valueStart = cell.start + eqIndex + 1 + leftTrimmedLength;
    const valueEnd = valueStart + trimmedValue.length;
    const isOnName = character >= nameStart && character < nameEnd;
    const isOnValue = character >= valueStart && character <= valueEnd;

    if (!isOnName && !isOnValue) {
      continue;
    }

    return {
      name,
      value: trimmedValue,
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

    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/);
    if (!classMatch) {
      if (trimmed.length > 0) {
        pendingDecorators = [];
      }
      continue;
    }

    const classIndent = classMatch[1].length;
    const className = classMatch[2];
    const baseTypeNames = uniqueStrings(
      (String(classMatch[3] || "").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []).filter(
        (baseTypeName) =>
          !PYTHON_IGNORED_TYPE_TOKENS.has(String(baseTypeName).toLowerCase()) &&
          normalizeComparableToken(baseTypeName) !== normalizeComparableToken(className)
      )
    );
    const isDataclass = pendingDecorators.some((decorator) => /^@dataclass\b/.test(decorator));
    pendingDecorators = [];

    const fields = [];
    let classBodyIndent = null;
    let inClassDocstring = false;
    let classDocstringDelimiter = "";
    for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed) {
        continue;
      }

      const indentLength = (nextLine.match(/^\s*/) || [""])[0].length;
      if (indentLength <= classIndent) {
        lineIndex = nextIndex - 1;
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
        continue;
      }

      if (
        nextTrimmed.startsWith("#") ||
        nextTrimmed.startsWith("@") ||
        nextTrimmed.startsWith("def ") ||
        nextTrimmed.startsWith("async def ") ||
        nextTrimmed.startsWith("class ")
      ) {
        continue;
      }

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

    const uniqueFields = dedupeStructuredFields(fields);

    if (uniqueFields.length === 0 && baseTypeNames.length === 0) {
      continue;
    }

    structuredTypes.push({
      name: className,
      filePath,
      isDataclass,
      baseTypeNames,
      fields: uniqueFields
    });
  }

  return structuredTypes;
}

function dedupeStructuredFields(fields) {
  const dedupedFields = [];
  const seenFields = new Set();
  for (const field of fields || []) {
    const key = `${normalizeComparableToken(field.name)}:${normalizeComparableToken(field.annotation)}`;
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
  const cells = splitRobotCellsWithRanges(lineText);
  const namedArguments = [];
  for (const cell of cells) {
    const eqIndex = findTopLevelCharIndex(cell.text, "=");
    if (eqIndex <= 0) {
      continue;
    }

    const name = cell.text.slice(0, eqIndex).trim();
    if (!name) {
      continue;
    }

    const valueRaw = stripInlineRobotComment(cell.text.slice(eqIndex + 1)).trim();
    namedArguments.push({
      name,
      valueRaw
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

    const signature = collectFunctionSignature(lines, definitionLine);
    if (!signature) {
      continue;
    }

    const parameters = parseFunctionParameters(signature.parametersText);
    const returnAnnotation = String(signature.returnAnnotation || "").trim();
    if (parameters.size === 0 && !returnAnnotation) {
      lineIndex = signature.endLine;
      continue;
    }

    definitions.push({
      keywordName: keywordNameFromDecorator || signature.functionName.replace(/_/g, " "),
      parameters,
      returnAnnotation,
      sourceFilePath
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
  let signatureText = lines[startLine].trim();
  let depth = (signatureText.match(/\(/g) || []).length - (signatureText.match(/\)/g) || []).length;
  let endLine = startLine;

  while (depth > 0 && endLine + 1 < lines.length && endLine - startLine < 300) {
    endLine += 1;
    const part = lines[endLine].trim();
    signatureText += ` ${part}`;
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

function parseFunctionParameters(parametersText) {
  const result = new Map();
  const chunks = splitTopLevel(parametersText, ",");
  for (const chunk of chunks) {
    const parameter = chunk.trim();
    if (!parameter || parameter === "*" || parameter === "/") {
      continue;
    }

    const [withoutDefault] = splitTopLevelOnce(parameter, "=");
    const annotationSeparatorIndex = findTopLevelCharIndex(withoutDefault, ":");
    if (annotationSeparatorIndex < 0) {
      continue;
    }

    const rawName = withoutDefault.slice(0, annotationSeparatorIndex).trim().replace(/^\*+/, "");
    const annotation = withoutDefault.slice(annotationSeparatorIndex + 1).trim();
    if (!rawName || !annotation || rawName === "self" || rawName === "cls") {
      continue;
    }

    result.set(rawName, annotation);
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
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

function formatMarkdownForDisplay(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const normalized = [];
  let inFence = false;
  let previousMeaningfulLine = "";

  for (const line of lines) {
    const fenceMatch = line.trimStart().startsWith("```");
    if (fenceMatch) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    if (inFence) {
      normalized.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      normalized.push(line);
      previousMeaningfulLine = "";
      continue;
    }

    const leadingWhitespace = (line.match(/^[ \t]*/) || [""])[0];
    const currentTrimmedStart = line.slice(leadingWhitespace.length);
    const currentTrimmed = line.trim();
    const previousTrimmed = previousMeaningfulLine.trim();
    const arrowPrefix = parseArrowPrefix(currentTrimmedStart);
    const currentIsArrowLine = Boolean(arrowPrefix);
    const previousIsBulletLine = /^[-*+](\s+.*)?$/.test(previousTrimmed);

    let displayLine = line;
    if (currentIsArrowLine) {
      if (previousIsBulletLine) {
        const listIndent = 2 + Math.max(0, arrowPrefix.level - 1) * 2;
        displayLine = `${makeArrowIndentToken(listIndent)}${arrowPrefix.marker}${
          arrowPrefix.rest ? ` ${arrowPrefix.rest}` : ""
        }`;
      } else {
        const sourceIndentWidth = whitespaceVisualWidth(leadingWhitespace);
        const nestingIndentWidth = Math.max(0, arrowPrefix.level - 1) * 2;
        const defaultTopLevelArrowIndent = sourceIndentWidth === 0 ? 2 : 0;
        const totalIndent = sourceIndentWidth + nestingIndentWidth + defaultTopLevelArrowIndent;
        displayLine = `${makeArrowIndentToken(totalIndent)}${arrowPrefix.marker}${
          arrowPrefix.rest ? ` ${arrowPrefix.rest}` : ""
        }`;
      }
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

function isVariableValueHoverEnabled() {
  return getConfig().get("enableVariableValueHover", true);
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

function getReturnHoverMaxDepth() {
  const raw = Number(getConfig().get("returnHoverMaxDepth", 1));
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(0, Math.min(8, Math.round(raw)));
}

function getReturnPreviewMaxDepth() {
  const raw = Number(getConfig().get("returnPreviewMaxDepth", 1));
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(0, Math.min(12, Math.round(raw)));
}

function getReturnMaxFieldsPerType() {
  const raw = Number(getConfig().get("returnMaxFieldsPerType", 12));
  if (!Number.isFinite(raw)) {
    return 12;
  }
  return Math.max(1, Math.min(500, Math.round(raw)));
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  activate,
  deactivate
};

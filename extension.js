const path = require("path");
const vscode = require("vscode");

const EXT_CONFIG_ROOT = "robotDocPreview";
const VIEW_ID = "robotDocPreview.view";

const CMD_TOGGLE = "robotDocPreview.toggle";
const CMD_OPEN_CURRENT_BLOCK = "robotDocPreview.openCurrentBlock";
const CMD_OPEN_BLOCK_AT = "robotDocPreview.openBlockAt";

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

function activate(context) {
  const parser = new RobotDocumentationService();
  const enumHintService = new RobotEnumHintService();
  const previewProvider = new RobotDocPreviewViewProvider();
  const controller = new RobotDocPreviewController(parser, previewProvider);
  const codeLensProvider = new RobotDocCodeLensProvider(parser);

  context.subscriptions.push(
    parser,
    enumHintService,
    previewProvider,
    controller,
    codeLensProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, previewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerCodeLensProvider(ROBOT_SELECTOR, codeLensProvider),
    vscode.languages.registerHoverProvider(ROBOT_SELECTOR, new RobotDocHoverProvider(parser, enumHintService)),
    vscode.commands.registerCommand(CMD_TOGGLE, () => controller.togglePreview()),
    vscode.commands.registerCommand(CMD_OPEN_CURRENT_BLOCK, () => controller.openCurrentBlock()),
    vscode.commands.registerCommand(CMD_OPEN_BLOCK_AT, (uriString, blockId) =>
      controller.openBlockAt(uriString, blockId)
    ),
    parser.onDidChange(() => codeLensProvider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(EXT_CONFIG_ROOT)) {
        return;
      }
      codeLensProvider.refresh();
      controller.refresh();
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
    const parsed = {
      uri: document.uri.toString(),
      version: document.version,
      fileName: path.basename(document.uri.fsPath || document.uri.path || document.uri.toString()),
      blocks,
      owners,
      variableAssignments
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
    const excludePattern = "**/{.git,.venv,venv,__pycache__,node_modules,tests}/**";
    const pythonFiles = await vscode.workspace.findFiles(includePattern, excludePattern, 4000);

    const filteredFiles = pythonFiles.filter((fileUri) => {
      const normalizedPath = fileUri.path.toLowerCase();
      if (normalizedPath.includes("/gen/")) {
        return false;
      }
      if (normalizedPath.includes("/generated/")) {
        return false;
      }
      if (normalizedPath.includes("/xml_models/")) {
        return false;
      }
      if (normalizedPath.includes("/camunda_7_23/")) {
        return false;
      }
      return true;
    });

    const enumsByName = new Map();
    const keywordDefinitions = [];

    for (const fileUri of filteredFiles) {
      let fileContent = "";
      try {
        const raw = await vscode.workspace.fs.readFile(fileUri);
        fileContent = Buffer.from(raw).toString("utf8");
      } catch {
        continue;
      }

      const enumDefinitions = parseEnumDefinitionsFromPythonSource(fileContent, fileUri.fsPath || fileUri.path);
      for (const enumDefinition of enumDefinitions) {
        const existing = enumsByName.get(enumDefinition.name) || [];
        existing.push(enumDefinition);
        enumsByName.set(enumDefinition.name, existing);
      }

      if (fileUri.path.toLowerCase().includes("/keywords/")) {
        keywordDefinitions.push(...parseKeywordEnumHintsFromPythonSource(fileContent));
      }
    }

    const enumNameSet = new Set(enumsByName.keys());
    const keywordArgs = new Map();

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

      for (const [argumentName, annotation] of keywordDefinition.parameters.entries()) {
        const enumNames = extractEnumNamesFromAnnotation(annotation, enumNameSet);
        if (enumNames.length === 0) {
          continue;
        }
        const normalizedArg = normalizeArgumentName(argumentName);
        const existingEnums = argsMap.get(normalizedArg) || [];
        argsMap.set(normalizedArg, uniqueStrings(existingEnums.concat(enumNames)));
      }
    }

    return {
      enumsByName,
      keywordArgs
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
    if (isVariableValueHoverEnabled()) {
      const variableHover = createVariableValueHover(document, parsed, position);
      if (variableHover) {
        return variableHover;
      }
    }

    if (isEnumValueHoverEnabled()) {
      const enumHover = await createEnumValueHover(document, position, this._enumHintService);
      if (enumHover) {
        return enumHover;
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

  const normalizedVariable = normalizeVariableToken(variableToken.token);
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

function stripInlineRobotComment(value) {
  return String(value || "").replace(/\s{2,}#.*$/, "");
}

async function createEnumValueHover(document, position, enumHintService) {
  if (!enumHintService) {
    return undefined;
  }

  const context = getNamedArgumentValueContextAtPosition(document, position);
  if (!context) {
    return undefined;
  }

  const index = await enumHintService.getIndexForDocument(document);
  if (!index) {
    return undefined;
  }

  const normalizedKeyword = normalizeKeywordName(context.keywordName);
  const normalizedArgument = normalizeArgumentName(context.argumentName);
  const mappedEnums = index.keywordArgs.get(normalizedKeyword)?.get(normalizedArgument) || [];

  let candidates = [];
  if (mappedEnums.length > 0) {
    for (const enumName of mappedEnums) {
      const enums = index.enumsByName.get(enumName) || [];
      candidates.push(...enums);
    }
  } else {
    const normalizedValue = context.argumentValue.toLowerCase();
    for (const enums of index.enumsByName.values()) {
      for (const enumEntry of enums) {
        if (doesEnumContainValue(enumEntry, normalizedValue)) {
          candidates.push(enumEntry);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const dedupedCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.name}:${candidate.filePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedCandidates.push(candidate);
  }

  dedupedCandidates.sort((left, right) => {
    const leftMatch = doesEnumContainValue(left, context.argumentValue.toLowerCase()) ? 1 : 0;
    const rightMatch = doesEnumContainValue(right, context.argumentValue.toLowerCase()) ? 1 : 0;
    if (leftMatch !== rightMatch) {
      return rightMatch - leftMatch;
    }
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    const argNorm = normalizedArgument;
    const leftScore = leftName.includes(argNorm) ? 1 : 0;
    const rightScore = rightName.includes(argNorm) ? 1 : 0;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return leftName.localeCompare(rightName);
  });

  const maxEnums = getEnumHoverMaxEnums();
  const shownEnums = dedupedCandidates.slice(0, maxEnums);
  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = false;
  markdown.appendMarkdown("### Robot Enum Hint\n\n");
  markdown.appendMarkdown("**Keyword:** ");
  markdown.appendText(context.keywordName);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Argument:** ");
  markdown.appendText(context.argumentName);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Current value:** ");
  markdown.appendText(context.argumentValue);
  markdown.appendMarkdown("\n\n");

  const maxMembers = getEnumHoverMaxMembers();
  const normalizedCurrentValue = context.argumentValue.toLowerCase();
  for (const enumEntry of shownEnums) {
    markdown.appendMarkdown("**Enum:** ");
    markdown.appendText(enumEntry.name);
    markdown.appendMarkdown("  \n");

    const members = enumEntry.members || [];
    const shownMembers = members.slice(0, maxMembers);
    const memberLines = shownMembers.map((member) => formatEnumMemberForDisplay(member));
    markdown.appendCodeblock(memberLines.join("\n"), "text");

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

  if (dedupedCandidates.length > shownEnums.length) {
    markdown.appendMarkdown(
      `_Showing ${shownEnums.length} of ${dedupedCandidates.length} matching enum candidates._`
    );
  }

  const range = new vscode.Range(position.line, context.valueStart, position.line, context.valueEnd);
  return new vscode.Hover(markdown, range);
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

function getNamedArgumentValueContextAtPosition(document, position) {
  const lineText = document.lineAt(position.line).text;
  const namedArgument = findNamedArgumentAtPosition(lineText, position.character);
  if (!namedArgument) {
    return undefined;
  }

  const headerLine = findKeywordCallHeaderLine(document, position.line);
  const keywordName = extractKeywordNameFromRobotCallLine(document.lineAt(headerLine).text);
  if (!keywordName) {
    return undefined;
  }

  return {
    keywordName,
    argumentName: namedArgument.name,
    argumentValue: namedArgument.value,
    valueStart: namedArgument.valueStart,
    valueEnd: namedArgument.valueEnd
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

function extractKeywordNameFromRobotCallLine(lineText) {
  const cells = splitRobotCellsWithRanges(lineText);
  if (cells.length === 0) {
    return "";
  }

  let keywordIndex = 0;
  if (/^[@$&%]\{[^}]+\}\s*=$/.test(cells[0].text.trim()) && cells.length > 1) {
    keywordIndex = 1;
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

    const name = cell.text.slice(0, eqIndex).trim();
    if (!name) {
      continue;
    }

    const rawValue = cell.text.slice(eqIndex + 1);
    const trimmedValue = rawValue.replace(/^\s+/, "");
    if (!trimmedValue) {
      continue;
    }

    const leftTrimmedLength = rawValue.length - trimmedValue.length;
    const valueStart = cell.start + eqIndex + 1 + leftTrimmedLength;
    const valueEnd = valueStart + trimmedValue.length;

    if (character >= valueStart && character < valueEnd) {
      return {
        name,
        value: trimmedValue,
        valueStart,
        valueEnd
      };
    }
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

function parsePythonLiteral(valueExpression) {
  const value = String(valueExpression || "").trim();
  const quoteMatch = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoteMatch) {
    return quoteMatch[2];
  }
  return value;
}

function parseKeywordEnumHintsFromPythonSource(source) {
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
    if (parameters.size === 0) {
      lineIndex = signature.endLine;
      continue;
    }

    definitions.push({
      keywordName: keywordNameFromDecorator || signature.functionName.replace(/_/g, " "),
      parameters
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

  while (depth > 0 && endLine + 1 < lines.length && endLine - startLine < 30) {
    endLine += 1;
    const part = lines[endLine].trim();
    signatureText += ` ${part}`;
    depth += (part.match(/\(/g) || []).length;
    depth -= (part.match(/\)/g) || []).length;
  }

  const signatureMatch = signatureText.match(
    /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*(?:->[\s\S]*)?:\s*$/
  );
  if (!signatureMatch) {
    return null;
  }

  return {
    functionName: signatureMatch[1],
    parametersText: signatureMatch[2],
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

function extractEnumNamesFromAnnotation(annotation, enumNames) {
  const tokens = String(annotation || "").match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  const enums = [];
  for (const token of tokens) {
    if (enumNames.has(token)) {
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
  return String(keywordName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeArgumentName(argumentName) {
  return String(argumentName || "").trim().toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
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

function isVariableValueHoverEnabled() {
  return getConfig().get("enableVariableValueHover", true);
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

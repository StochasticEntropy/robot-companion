const path = require("path");
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
const DEFAULT_INDEX_IMPORT_FOLDER_PATTERNS = ["**"];
const DEFAULT_INDEX_EXCLUDE_FOLDER_PATTERNS = [
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "tests"
];
const GLOB_MAGIC_PATTERN = /[*?\[\]{}]/;
const RETURN_SUBTYPE_RESOLUTION_MODES = new Set(["always", "never", "include", "exclude"]);
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

function activate(context) {
  const parser = new RobotDocumentationService();
  const enumHintService = new RobotEnumHintService();
  const previewProvider = new RobotDocPreviewViewProvider();
  const controller = new RobotDocPreviewController(parser, previewProvider);
  const returnPreviewProvider = new RobotReturnPreviewViewProvider();
  const returnController = new RobotReturnExplorerController(parser, enumHintService, returnPreviewProvider);
  const codeLensProvider = new RobotDocCodeLensProvider(parser);
  const typedVariableCompletionProvider = new RobotTypedVariableCompletionProvider(parser, enumHintService);

  context.subscriptions.push(
    parser,
    enumHintService,
    previewProvider,
    controller,
    returnPreviewProvider,
    returnController,
    codeLensProvider,
    typedVariableCompletionProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, previewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(RETURN_VIEW_ID, returnPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerCodeLensProvider(ROBOT_SELECTOR, codeLensProvider),
    vscode.languages.registerHoverProvider(ROBOT_SELECTOR, new RobotDocHoverProvider(parser, enumHintService)),
    vscode.languages.registerCompletionItemProvider(
      ROBOT_SELECTOR,
      typedVariableCompletionProvider,
      "=",
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
    vscode.commands.registerCommand(CMD_INVALIDATE_CACHES, async () => {
      parser.clearAll();
      enumHintService.invalidateAll();
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
      void vscode.window.showInformationMessage("Robot Companion caches invalidated.");
    }),
    parser.onDidChange(() => codeLensProvider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(EXT_CONFIG_ROOT)) {
        return;
      }
      if (
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.indexImportFolderPatterns`) ||
        event.affectsConfiguration(`${EXT_CONFIG_ROOT}.indexExcludeFolderPatterns`)
      ) {
        enumHintService.invalidateAll();
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
        ownerStartLine: owner ? owner.startLine : lineIndex,
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

    const filteredFiles = pythonFiles;
    const robotKeywordFiles = uniqueUrisByString(resourceFiles.concat(keywordRobotFiles));

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

    for (const fileUri of filteredFiles) {
      let fileContent = "";
      try {
        fileContent = await readWorkspaceText(fileUri);
      } catch {
        continue;
      }

      const filePath = fileUri.fsPath || fileUri.path;
      const moduleInfo = derivePythonModuleInfo(workspaceFolder, fileUri);
      moduleInfoByFile.set(filePath, moduleInfo);
      const parsedImports = parsePythonImportAliasesFromSource(fileContent, moduleInfo.packagePath);
      typeImportAliasesByFile.set(filePath, parsedImports.typeImportAliases);
      moduleImportAliasesByFile.set(filePath, parsedImports.moduleImportAliases);

      const enumDefinitions = parseEnumDefinitionsFromPythonSource(fileContent, filePath).map((enumDefinition) => {
        const qualifiedName = moduleInfo.modulePath
          ? `${moduleInfo.modulePath}.${enumDefinition.name}`
          : enumDefinition.name;
        return {
          ...enumDefinition,
          modulePath: moduleInfo.modulePath,
          qualifiedName
        };
      });
      for (const enumDefinition of enumDefinitions) {
        const existing = enumsByName.get(enumDefinition.name) || [];
        existing.push(enumDefinition);
        enumsByName.set(enumDefinition.name, existing);
        const existingQualified = enumsByQualifiedName.get(enumDefinition.qualifiedName) || [];
        existingQualified.push(enumDefinition);
        enumsByQualifiedName.set(enumDefinition.qualifiedName, existingQualified);
      }
      localEnumNamesByFile.set(
        filePath,
        new Set(enumDefinitions.map((enumDefinition) => enumDefinition.name))
      );
      enumImportAliasesByFile.set(filePath, parseFromImportAliasesFromPythonSource(fileContent));

      const structuredTypeDefinitions = parseStructuredTypesFromPythonSource(fileContent, filePath).map(
        (structuredTypeDefinition) => {
          const qualifiedName = moduleInfo.modulePath
            ? `${moduleInfo.modulePath}.${structuredTypeDefinition.name}`
            : structuredTypeDefinition.name;
          return {
            ...structuredTypeDefinition,
            modulePath: moduleInfo.modulePath,
            qualifiedName
          };
        }
      );
      for (const structuredTypeDefinition of structuredTypeDefinitions) {
        const existing = structuredTypesByName.get(structuredTypeDefinition.name) || [];
        existing.push(structuredTypeDefinition);
        structuredTypesByName.set(structuredTypeDefinition.name, existing);
        const existingQualified = structuredTypesByQualifiedName.get(structuredTypeDefinition.qualifiedName) || [];
        existingQualified.push(structuredTypeDefinition);
        structuredTypesByQualifiedName.set(structuredTypeDefinition.qualifiedName, existingQualified);
      }
      localStructuredTypeNamesByFile.set(
        filePath,
        new Set(structuredTypeDefinitions.map((structuredTypeDefinition) => structuredTypeDefinition.name))
      );

      if (fileContent.includes("@keyword")) {
        keywordDefinitions.push(...parseKeywordEnumHintsFromPythonSource(fileContent, filePath));
      }
    }

    for (const fileUri of robotKeywordFiles) {
      let fileContent = "";
      try {
        fileContent = await readWorkspaceText(fileUri);
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
    const keywordReturnDefinitions = new Map();
    const keywordDocsByName = new Map();

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

    return {
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
        console.warn("[robot-companion] Enum hover failed:", message);
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
        console.warn("[robot-companion] Return hover failed:", message);
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

class RobotTypedVariableCompletionProvider {
  constructor(parser, enumHintService) {
    this._parser = parser;
    this._enumHintService = enumHintService;
  }

  async provideCompletionItems(document, position) {
    if (!isRobotDocument(document) || !isTypedVariableCompletionsEnabled()) {
      return undefined;
    }

    const parsed = this._parser.getParsed(document);
    const argumentContext = getNamedArgumentValueContextAtPosition(document, position);
    if (!argumentContext) {
      return undefined;
    }

    if (!Number.isFinite(argumentContext.valueStart) || position.character < argumentContext.valueStart) {
      return undefined;
    }

    const owner = findOwnerForLine(parsed.owners, position.line);
    if (!owner) {
      return undefined;
    }

    const index = await this._enumHintService.getIndexForDocument(document);
    if (!index) {
      return undefined;
    }

    const expectedTypeNames = resolveExpectedArgumentTypeNames(
      index,
      normalizeKeywordName(argumentContext.keywordName),
      normalizeArgumentName(argumentContext.argumentName)
    );
    if (expectedTypeNames.size === 0) {
      return undefined;
    }

    const matchingVariables = collectMatchingTypedReturnVariables(
      parsed,
      index,
      owner,
      position.line,
      expectedTypeNames
    );
    if (matchingVariables.length === 0) {
      return undefined;
    }

    const replaceStart = Math.max(0, Number(argumentContext.valueStart) || 0);
    const replaceEnd = Math.max(replaceStart, Number(argumentContext.valueEnd) || replaceStart);
    const replacementRange = new vscode.Range(position.line, replaceStart, position.line, replaceEnd);

    const expectedTypeLabel = [...expectedTypeNames].slice(0, 3).join(" | ");
    const items = matchingVariables.map((candidate) => {
      const item = new vscode.CompletionItem(candidate.variableToken, vscode.CompletionItemKind.Variable);
      item.textEdit = vscode.TextEdit.replace(replacementRange, candidate.variableToken);
      item.detail = expectedTypeLabel
        ? `Type-matched variable for ${argumentContext.argumentName} (${expectedTypeLabel})`
        : `Type-matched variable for ${argumentContext.argumentName}`;
      item.documentation = new vscode.MarkdownString(
        `From keyword \`${candidate.keywordName}\` (line ${candidate.assignmentLine + 1})\n\n` +
          `Return types: \`${candidate.typeNamesOriginal.join(" | ")}\``
      );
      item.sortText = `${String(999999 - candidate.assignmentLine).padStart(6, "0")}_${candidate.variableToken.toLowerCase()}`;
      return item;
    });

    return new vscode.CompletionList(items, false);
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
          return `<li class=\"list-item\">${escapeHtml(block.ownerName || block.title)}</li>`;
        }

        const args = encodeURIComponent(JSON.stringify([this._state.documentUri, block.id]));
        const commandUri = `command:${CMD_OPEN_BLOCK_AT}?${args}`;
        const testcaseCommand = buildOpenLocationCommandUri(
          this._state.documentUri,
          Number.isFinite(Number(block.ownerStartLine)) ? Number(block.ownerStartLine) : Number(block.startLine) || 0
        );
        const isActive = selectedBlock && selectedBlock.id === block.id;
        const activeClass = isActive ? " active" : "";

        return `<li class=\"list-item${activeClass}\"><div class=\"list-item-row\"><a href=\"${commandUri}\">${escapeHtml(
          block.ownerName || block.title
        )}</a>${
          testcaseCommand ? `<a class=\"testcase-jump\" href=\"${testcaseCommand}\">Jump to testcase</a>` : ""
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
      : "<div class=\"meta muted\">Move cursor into a [Documentation] block or use command palette.</div>";

    const message = this._state.infoMessage
      ? `<div class=\"notice\">${escapeHtml(this._state.infoMessage)}</div>`
      : "";

    const listContent = hasBlocks
      ? `<ul class=\"list\">${blockItems}</ul>`
      : "<div class=\"muted\">No [Documentation] blocks found in Test Cases/Tasks/Keywords.</div>";

    const selectedTestcaseJumpCommand =
      selectedBlock && this._state.documentUri
        ? buildOpenLocationCommandUri(
            this._state.documentUri,
            Number.isFinite(Number(selectedBlock.ownerStartLine))
              ? Number(selectedBlock.ownerStartLine)
              : Number(selectedBlock.startLine) || 0
          )
        : "";
    const previewTitle = selectedBlock
      ? `<h2 class=\"preview-title\">${escapeHtml(selectedBlock.ownerName || selectedBlock.title)}</h2>`
      : "<h2 class=\"preview-title\">Documentation Preview</h2>";
    const previewSubtitle =
      selectedBlock && selectedTestcaseJumpCommand
        ? `<div class=\"preview-subtitle\"><a href=\"${selectedTestcaseJumpCommand}\">Jump to testcase</a></div>`
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
    ${previewSubtitle}
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
            String(this._state.currentValueSource || "").toLowerCase() === "set-variable" && hasCurrentValueSourceLine
              ? `<div class=\"current-value-source\">
                  From <code>Set Variable</code> line ${currentValueSourceLineNumber}
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
    this._suspendAutoSyncUntil = 0;
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

  async refresh() {
    await this._syncFromActiveEditor();
  }

  async previewKeywordArgument(payload = {}, options = {}) {
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
        backToKeywordCommandUri
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
    if (Date.now() < this._suspendAutoSyncUntil) {
      return;
    }
    void this._syncFromActiveEditor(editor);
  }

  _onSelectionChanged(event) {
    if (Date.now() < this._suspendAutoSyncUntil) {
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
        createEmptyReturnPreviewState(
          "Open a .robot file and place cursor on a keyword token, return variable, or named argument."
        )
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
        createEmptyReturnPreviewState(
          "Open a .robot file and place cursor on a keyword token, return variable, or named argument."
        )
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
      console.warn("[robot-companion] Return explorer refresh failed:", message);
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

    if (returnContext) {
      this._previewProvider.update({
        contextKind: "return",
        fileName: parsed.fileName,
        ownerName: returnContext.owner.name,
        variableToken: returnContext.variableToken.token,
        keywordName: returnContext.assignment.keywordName,
        returnAnnotation: returnContext.returnAnnotation,
        sourceUri: "",
        sourceLine: undefined,
        sourceFilePath: "",
        sourceFunctionName: "",
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

    let keywordDocContext = undefined;
    try {
      keywordDocContext = await resolveKeywordDocumentationPreview(
        editor.document,
        parsed,
        editor.selection.active,
        this._enumHintService
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn("[robot-companion] Keyword doc preview refresh failed:", message);
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
    const markdownWithArgumentLinks = injectKeywordDocArgumentNavigationLinks(
      context.primaryCandidate.normalizedDocstring,
      {
        callArgumentNavigationMap: context.callArgumentNavigationMap,
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
    lines.push("_Tip: Click argument names in **Args** to preview that argument and jump to it when present._");
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

function injectKeywordDocArgumentNavigationLinks(markdown, options = {}) {
  const callArgumentNavigationMap =
    options.callArgumentNavigationMap instanceof Map ? options.callArgumentNavigationMap : new Map();
  const commandBuilder =
    typeof options.commandBuilder === "function" ? options.commandBuilder : undefined;
  if (!commandBuilder) {
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
    const commandUri = String(
      commandBuilder({
        argumentName,
        normalizedArgumentName: normalizedArgument,
        target
      }) || ""
    );
    if (!commandUri) {
      return line;
    }

    return `${prefix}[\`${escapeMarkdownInline(argumentName)}\`](${commandUri})${suffix}`;
  });

  return linkedLines.join("\n");
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

  if (showResolvedCurrentValue && currentValue.length > 0) {
    if (argumentValue.length > 0 && argumentValue !== currentValue) {
      lines.push(`Resolved current value: \`${resolvedCurrentValueDisplay}\` (from \`${argumentValue}\`).`);
    } else {
      lines.push(`Resolved current value: \`${resolvedCurrentValueDisplay}\`.`);
    }
    lines.push("");
  }

  if (
    showResolvedCurrentValue &&
    context.currentValueSource === "set-variable" &&
    Number.isFinite(Number(context.currentValueSourceLine)) &&
    Number(context.currentValueSourceLine) >= 0
  ) {
    const sourceLineNumber = Number(context.currentValueSourceLine) + 1;
    lines.push(`Resolved from local \`Set Variable\` at line ${sourceLineNumber}.`);
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
        String(context.currentValueSource || "").toLowerCase() === "set-variable" &&
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
      const shownPaths = levelPaths.slice(0, 12);
      lines.push("");
      lines.push(`**${formatAccessDepthLabel(levelIndex + 1)}:**`);
      lines.push("```robotframework");
      lines.push(shownPaths.join("\n"));
      lines.push("```");
      if (levelPaths.length > shownPaths.length) {
        lines.push(
          `_Showing first ${shownPaths.length} of ${levelPaths.length} ${formatAccessDepthLabel(
            levelIndex + 1
          ).toLowerCase()} paths._`
        );
      }
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
    String(context?.currentValueSource || "").toLowerCase() === "set-variable" &&
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
    documentUri: "",
    fileName: "",
    ownerName: "",
    variableToken: "",
    keywordName: "",
    returnAnnotation: "",
    currentValue: "",
    currentValueSource: "",
    currentValueSourceLine: undefined,
    sourceUri: "",
    sourceLine: undefined,
    sourceFilePath: "",
    sourceFunctionName: "",
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

  const valueLines =
    selectedAssignment.valueRaw.length === 0 ? [] : selectedAssignment.valueRaw.split(/\r?\n/);
  const lineLimit = getVariableHoverLineLimit();
  const isTruncated = lineLimit > 0 && valueLines.length > lineLimit;
  const shownLines = isTruncated ? valueLines.slice(0, lineLimit) : valueLines;
  const currentValueSummary = shownLines.length > 0 ? shownLines[0] : "";

  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = {
    enabledCommands: [CMD_OPEN_LOCATION]
  };
  markdown.supportHtml = false;
  markdown.appendMarkdown("### Robot Variable Value\n\n");
  if (currentValueSummary.length > 0) {
    markdown.appendMarkdown("**Current value (resolved):**  \n");
    markdown.appendMarkdown(`🟢 \`${escapeMarkdownInline(currentValueSummary)}\`\n\n`);
  } else {
    markdown.appendMarkdown("**Current value (resolved):**  \n");
    markdown.appendMarkdown("🟢 `(empty)`\n\n");
  }
  markdown.appendMarkdown("**Variable:** ");
  markdown.appendText(variableToken.token);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown("**Owner:** ");
  markdown.appendText(owner.name);
  markdown.appendMarkdown("  \n");
  markdown.appendMarkdown(`**Source:** \`Set Variable\` at line ${selectedAssignment.startLine + 1}  \n`);
  const sourceCommand = buildOpenLocationCommandUri(document.uri.toString(), selectedAssignment.startLine);
  if (sourceCommand) {
    markdown.appendMarkdown(`[Jump to Set Variable line ${selectedAssignment.startLine + 1}](${sourceCommand})\n\n`);
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
  const simpleAccess = buildSimpleReturnAccessPaths(variableContext.variableToken.token, rootTypeNames, index, {
    rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
    subtypePolicy,
    typePreferencesByName: returnTypeResolution.typePreferencesByName,
    resolutionContext: returnResolutionContext,
    maxFieldsPerType: Math.max(1, Number(options.maxFieldsPerType) || 1)
  });
  const technicalStructureLines = buildReturnStructureLines(
    rootTypeNames,
    index,
    {
      maxDepth: getReturnTechnicalMaxDepth(),
      maxFieldsPerType: getReturnTechnicalMaxFieldsPerType(),
      typePreferencesByName: returnTypeResolution.typePreferencesByName,
      resolutionContext: returnResolutionContext
    },
    "technical"
  );

  return {
    ...variableContext,
    normalizedKeyword,
    returnAnnotation,
    returnDefinition,
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
  const simpleAccess = buildSimpleReturnAccessPaths(rawArgumentValue, rootTypeNames, index, {
    rootCollectionLike: returnTypeResolution.hasCollectionSubtype,
    subtypePolicy,
    typePreferencesByName: returnTypeResolution.typePreferencesByName,
    resolutionContext: returnResolutionContext,
    maxDepth: getReturnHintArgumentMaxDepth(),
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
    returnDefinition,
    rootTypeNames,
    simpleAccess,
    technicalStructureLines: buildReturnStructureLines(
      rootTypeNames,
      index,
      {
        maxDepth: getReturnTechnicalMaxDepth(),
        maxFieldsPerType: getReturnTechnicalMaxFieldsPerType(),
        typePreferencesByName: returnTypeResolution.typePreferencesByName,
        resolutionContext: returnResolutionContext
      },
      "technical"
    )
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

function buildSimpleReturnAccessPaths(variableToken, rootTypeNames, index, options = {}) {
  const baseVariableToken = getVariableRootToken(variableToken);
  const maxFieldsPerType = Math.max(1, Number(options.maxFieldsPerType) || 1);
  const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || 2));
  const rootCollectionLike = Boolean(options.rootCollectionLike);
  const subtypePolicy = options.subtypePolicy || getReturnSubtypeResolutionPolicy(index);
  const rootTypePreferences = cloneTypePreferenceMap(options.typePreferencesByName);
  const levels = [];
  let currentNodes = [
    {
      segments: [],
      indexedSegmentPositions: new Set(),
      typeNames: uniqueStrings(rootTypeNames || []),
      typePreferencesByName: rootTypePreferences
    }
  ];

  for (let levelIndex = 1; levelIndex <= maxDepth && currentNodes.length > 0; levelIndex += 1) {
    const levelPaths = [];
    const nextNodesBySegments = new Map();

    for (const node of currentNodes) {
      const fields = collectDeclaredFieldsForTypes(node.typeNames, index, {
        typePreferencesByName: node.typePreferencesByName
      }).slice(0, maxFieldsPerType);
      for (const field of fields) {
        const segments = node.segments.concat(field.name);
        const path = buildRobotAttributeAccessTokenWithOptions(baseVariableToken, segments, {
          includeRootIndexed: rootCollectionLike,
          indexedSegmentPositions: node.indexedSegmentPositions
        });
        if (path) {
          levelPaths.push(path);
        }

        if (levelIndex >= maxDepth) {
          continue;
        }

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
        if (nestedTypeNames.length === 0) {
          continue;
        }

        const segmentsKey = segments.join("\u0000");
        let nextNode = nextNodesBySegments.get(segmentsKey);
        if (!nextNode) {
          const indexedSegmentPositions = new Set(node.indexedSegmentPositions || []);
          if (nestedTypeResolution.hasCollectionSubtype) {
            indexedSegmentPositions.add(segments.length - 1);
          }
          nextNode = {
            segments,
            indexedSegmentPositions,
            typeNames: new Set(),
            typePreferencesByName: new Map()
          };
          mergeTypePreferenceMaps(nextNode.typePreferencesByName, node.typePreferencesByName);
          nextNodesBySegments.set(segmentsKey, nextNode);
        } else if (nestedTypeResolution.hasCollectionSubtype) {
          nextNode.indexedSegmentPositions.add(segments.length - 1);
        }
        mergeTypePreferenceMaps(nextNode.typePreferencesByName, nestedTypeResolution.typePreferencesByName);
        for (const nestedTypeName of nestedTypeNames) {
          nextNode.typeNames.add(nestedTypeName);
        }
      }
    }

    levels.push(uniqueStrings(levelPaths));
    currentNodes = [...nextNodesBySegments.values()].map((node) => ({
      segments: node.segments,
      indexedSegmentPositions: node.indexedSegmentPositions,
      typeNames: [...node.typeNames],
      typePreferencesByName: cloneTypePreferenceMap(node.typePreferencesByName)
    }));
  }

  return {
    firstLevel: levels[0] || [],
    secondLevel: levels[1] || [],
    levels
  };
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
    combinedFields.push(...collectDeclaredFieldsForType(typeName, index, new Set(), options));
  }
  return dedupeFieldDescriptorsByName(combinedFields);
}

function collectDeclaredFieldsForType(typeName, index, visited, options = {}) {
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (visited.has(normalizedTypeName)) {
    return [];
  }

  const structuredTypeCandidates = index.structuredTypesByName?.get(typeName) || [];
  if (structuredTypeCandidates.length === 0) {
    return [];
  }

  const preferredQualifiedNames = getPreferredQualifiedNamesForType(options.typePreferencesByName, typeName);
  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [];
  }
  const nextVisited = new Set(visited);
  nextVisited.add(normalizedTypeName);

  const sourceFilePath = String(selectedType.filePath || "");
  const sourceModulePath = String(selectedType.modulePath || "");
  const sourcePackagePath = String(index?.moduleInfoByFile?.get(sourceFilePath)?.packagePath || "");
  const fields = dedupeStructuredFields(selectedType.fields || [])
    .filter((field) => !SIMPLE_RETURN_IGNORED_FIELD_NAMES.has(normalizeComparableToken(field.name)))
    .map((field) => ({
      ...field,
      sourceFilePath,
      sourceModulePath,
      sourcePackagePath
    }));

  const inheritedTypeNames = (selectedType.baseTypeNames || []).filter(
    (baseTypeName) =>
      normalizeComparableToken(baseTypeName) !== normalizedTypeName &&
      (index.structuredTypesByName?.get(baseTypeName) || []).some((candidate) => candidate.isDataclass)
  );

  const inheritedFields = [];
  for (const inheritedTypeName of inheritedTypeNames) {
    inheritedFields.push(...collectDeclaredFieldsForType(inheritedTypeName, index, nextVisited, options));
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
        subtypePolicy
      })
    );
  }

  return lines;
}

function renderIndexedTypeTree(typeName, index, depth, maxDepth, maxFieldsPerType, visited, mode, options = {}) {
  const normalizedMode = mode === "technical" ? "technical" : "simple";
  const typePreferencesByName =
    options.typePreferencesByName instanceof Map ? options.typePreferencesByName : new Map();
  const subtypePolicy = options.subtypePolicy || getReturnSubtypeResolutionPolicy(index);
  const indent = "  ".repeat(depth);
  const normalizedTypeName = normalizeComparableToken(typeName);
  if (visited.has(normalizedTypeName)) {
    return [`${indent}${typeName} (recursive)`];
  }

  const preferredQualifiedNames = getPreferredQualifiedNamesForType(typePreferencesByName, typeName);
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

  const selectedType = choosePreferredStructuredTypeDefinition(structuredTypeCandidates, {
    preferredQualifiedNames
  });
  if (!selectedType) {
    return [`${indent}${typeName}`];
  }
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
          nestedTypeName,
          index,
          depth + 1,
          maxDepth,
          maxFieldsPerType,
          nextVisited,
          normalizedMode,
          {
            typePreferencesByName: nestedTypePreferences,
            subtypePolicy
          }
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
            normalizedMode,
            {
              typePreferencesByName,
              subtypePolicy
            }
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

    const leftFieldCount = Array.isArray(left.fields) ? left.fields.length : 0;
    const rightFieldCount = Array.isArray(right.fields) ? right.fields.length : 0;
    if (leftFieldCount !== rightFieldCount) {
      return rightFieldCount - leftFieldCount;
    }

    const leftQualifiedName = normalizeQualifiedTypeName(left.qualifiedName);
    const rightQualifiedName = normalizeQualifiedTypeName(right.qualifiedName);
    return leftQualifiedName.localeCompare(rightQualifiedName);
  });
  return sorted[0];
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
  markdown.appendMarkdown("**Current value (resolved):**  \n");
  markdown.appendMarkdown(`🟢 \`${escapeMarkdownInline(topResolvedCurrentValueDisplay)}\`\n\n`);
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
        String(context.currentValueSource || "").toLowerCase() === "set-variable" &&
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
      const shownPaths = levelPaths.slice(0, 12);
      markdown.appendMarkdown(`\n**${formatAccessDepthLabel(levelIndex + 1)}:**\n`);
      markdown.appendCodeblock(shownPaths.join("\n"), "robotframework");
      if (levelPaths.length > shownPaths.length) {
        markdown.appendMarkdown(
          `\n_Showing first ${shownPaths.length} of ${levelPaths.length} ${formatAccessDepthLabel(
            levelIndex + 1
          ).toLowerCase()} paths._`
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

  return resolveEnumValuePreviewFromContext(document, enumHintService, context, {
    ...options,
    referenceLine: position.line
  });
}

async function resolveEnumValuePreviewFromContext(document, enumHintService, context, options = {}) {
  if (!enumHintService || !context) {
    return undefined;
  }

  const parsed = options.parsed;
  const referenceLine = Number.isFinite(Number(options.referenceLine))
    ? Number(options.referenceLine)
    : 0;
  const shouldResolveCurrentValue = options.showResolvedCurrentValue !== false;
  const currentValueResolution = shouldResolveCurrentValue
    ? resolveNamedArgumentCurrentValueFromSetVariable(context.argumentValue, parsed, referenceLine)
    : {
        value: String(context.argumentValue || "").trim(),
        source: "argument",
        sourceLine: undefined
      };
  const currentValue = currentValueResolution.value;
  const returnHintContext =
    shouldResolveCurrentValue && parsed
      ? await resolveReturnHintForArgumentValue(
          document,
          parsed,
          context,
          {
            line: referenceLine,
            character: Math.max(0, Number(context.hoverStart) || 0)
          },
          enumHintService
        )
      : undefined;

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
    let hasIndexableMethod = false;
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
        if (/^(?:async\s+def|def)\s+(__getitem__|__iter__)\s*\(/.test(nextTrimmed)) {
          hasIndexableMethod = true;
        }
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
      isIndexableWrapper: hasIndexableMethod,
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
    const docstringResult = extractFunctionDocstring(lines, definitionLine, signature.endLine);
    const normalizedDocstring = normalizeKeywordDocstringToMarkdown(docstringResult.docstringRaw || "");

    definitions.push({
      keywordName: keywordNameFromDecorator || signature.functionName.replace(/_/g, " "),
      parameters,
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
  const match = String(trimmedLine || "").match(/^([*]{0,2}[A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]+)\))?\s*:\s*(.*)$/);
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

function collectMatchingTypedReturnVariables(parsed, index, owner, line, expectedTypeNames) {
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
  for (const assignment of parsed.keywordCallAssignments || []) {
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

function isVariableValueHoverEnabled() {
  return getConfig().get("enableVariableValueHover", true);
}

function isTypedVariableCompletionsEnabled() {
  return getConfig().get("enableTypedVariableCompletions", true);
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
  const raw = Number(getConfig().get("returnPreviewMaxDepth", 1));
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(0, Math.min(12, Math.round(raw)));
}

function getReturnHintArgumentMaxDepth() {
  const raw = Number(getConfig().get("returnHintArgumentMaxDepth", 2));
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(1, Math.min(12, Math.round(raw)));
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

module.exports = {
  activate,
  deactivate
};

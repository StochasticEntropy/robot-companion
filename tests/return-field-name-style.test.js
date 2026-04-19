const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

function loadExtensionModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return {
        workspace: {
          getConfiguration: () => ({
            get: (_key, fallbackValue) => fallbackValue
          }),
          getWorkspaceFolder: () => undefined,
          workspaceFolders: [],
          onDidChangeConfiguration: () => ({ dispose() {} }),
          onDidOpenTextDocument: () => ({ dispose() {} }),
          onDidSaveTextDocument: () => ({ dispose() {} }),
          onDidCloseTextDocument: () => ({ dispose() {} }),
          onDidChangeTextDocument: () => ({ dispose() {} }),
          findFiles: async () => []
        },
        window: {
          createOutputChannel: () => ({
            appendLine() {},
            show() {},
            dispose() {}
          }),
          visibleTextEditors: [],
          activeTextEditor: undefined,
          onDidChangeActiveTextEditor: () => ({ dispose() {} }),
          showInformationMessage: async () => undefined,
          showWarningMessage: async () => undefined,
          showErrorMessage: async () => undefined
        },
        debug: {
          activeDebugSession: undefined,
          sessions: [],
          onDidStartDebugSession: () => ({ dispose() {} }),
          onDidTerminateDebugSession: () => ({ dispose() {} }),
          onDidChangeActiveDebugSession: () => ({ dispose() {} })
        },
        commands: {
          registerCommand: () => ({ dispose() {} }),
          executeCommand: async () => undefined
        },
        languages: {
          registerCodeLensProvider: () => ({ dispose() {} }),
          registerFoldingRangeProvider: () => ({ dispose() {} }),
          registerHoverProvider: () => ({ dispose() {} }),
          registerCompletionItemProvider: () => ({ dispose() {} })
        },
        EventEmitter: class {
          constructor() {
            this.event = () => undefined;
          }
          fire() {}
          dispose() {}
        },
        MarkdownString: class {
          constructor() {
            this.value = "";
            this.isTrusted = false;
            this.supportHtml = false;
          }
          appendMarkdown(value) {
            this.value += String(value || "");
          }
          appendText(value) {
            this.value += String(value || "");
          }
          appendCodeblock(value, language = "") {
            this.value += `\`\`\`${language}\n${String(value || "")}\n\`\`\``;
          }
        },
        Range: class {
          constructor(startLine, startCharacter, endLine, endCharacter) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
          }
        },
        Hover: class {
          constructor(contents, range) {
            this.contents = Array.isArray(contents) ? contents : [contents];
            this.range = range;
          }
        },
        FoldingRange: class {
          constructor(start, end, kind) {
            this.start = start;
            this.end = end;
            this.kind = kind;
          }
        },
        CompletionItem: class {},
        CodeLens: class {},
        TreeItem: class {},
        ThemeIcon: class {},
        CompletionItemKind: {
          Field: 5,
          Variable: 6,
          Value: 12,
          EnumMember: 20
        },
        TreeItemCollapsibleState: {
          None: 0,
          Collapsed: 1,
          Expanded: 2
        },
        FoldingRangeKind: {
          Region: "region"
        },
        Uri: {
          joinPath: (...parts) => ({
            fsPath: parts
              .map((part) => String(part?.fsPath || part?.path || part || ""))
              .filter(Boolean)
              .join(path.sep)
          })
        },
        Disposable: {
          from: (...disposables) => ({
            dispose() {
              for (const disposable of disposables) {
                disposable?.dispose?.();
              }
            }
          })
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../src/core/extension.js");
  } finally {
    Module._load = originalLoad;
  }
}

const extensionModule = loadExtensionModule();
const workerModule = require("../src/core/return-worker.js");
const extensionTestApi = extensionModule.__test__;
const workerTestApi = workerModule.__test__;

function createMockRobotDocument(source, filePath = "/tmp/mock.robot") {
  const text = String(source || "").replace(/^\n/, "");
  const lines = text.split(/\r?\n/);
  return {
    uri: {
      toString: () => `file://${filePath}`,
      fsPath: filePath,
      path: filePath
    },
    version: 1,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (index) => ({
      text: lines[index] || ""
    })
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCommandUriFromMarkdown(markdown, commandId) {
  const match = String(markdown || "").match(
    new RegExp(`command:${escapeRegExp(commandId)}\\?([^\\)\\s"'<>]+)`)
  );
  assert(match, `Expected markdown to contain command URI for ${commandId}.`);
  const args = JSON.parse(decodeURIComponent(match[1]));
  return Array.isArray(args) ? args : [args];
}

function parseCommandUri(commandUri) {
  const match = String(commandUri || "").match(/^command:([^?]+)(?:\?(.*))?$/);
  assert(match, `Expected command URI but got ${String(commandUri || "")}.`);
  const commandId = decodeURIComponent(match[1]);
  const args = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
  return {
    commandId,
    args: Array.isArray(args) ? args : [args]
  };
}

function createIndex(structuredTypes) {
  const structuredTypesByName = new Map();
  const moduleInfoByFile = new Map();
  for (const structuredType of structuredTypes) {
    const candidate = {
      name: structuredType.name,
      filePath: structuredType.filePath,
      modulePath: structuredType.modulePath,
      qualifiedName: structuredType.qualifiedName,
      isDataclass: structuredType.isDataclass !== false,
      isIndexableWrapper: Boolean(structuredType.isIndexableWrapper),
      supportsCamelCaseAccess: Boolean(structuredType.supportsCamelCaseAccess),
      baseTypeNames: structuredType.baseTypeNames || [],
      baseTypeRefs: structuredType.baseTypeRefs || [],
      fields: structuredType.fields || [],
      properties: structuredType.properties || []
    };
    const existing = structuredTypesByName.get(candidate.name) || [];
    existing.push(candidate);
    structuredTypesByName.set(candidate.name, existing);
    moduleInfoByFile.set(candidate.filePath, {
      modulePath: candidate.modulePath,
      packagePath: structuredType.packagePath || ""
    });
  }

  return {
    structuredTypesByName,
    structuredTypesByQualifiedName: new Map(),
    enumsByName: new Map(),
    enumsByQualifiedName: new Map(),
    moduleInfoByFile,
    localStructuredTypeNamesByFile: new Map(),
    localEnumNamesByFile: new Map(),
    typeImportAliasesByFile: new Map(),
    moduleImportAliasesByFile: new Map()
  };
}

function getOnlyStructuredType(types, name) {
  return types.filter((type) => type.name === name)[0];
}

function runPythonCamelCaseDetectionTests() {
  const source = `
class PlainBase:
    status_code: int

class CamelDirect(CamelCaseBase):
    status_code: int

class CamelChild(CamelDirect):
    business_key: str

class PlainChild(PlainBase):
    raw_field: str
`;
  const parsedTypes = extensionTestApi.parseStructuredTypesFromPythonSource(source, "/tmp/camel_detection.py");
  const structuredTypesByName = new Map();
  for (const parsedType of parsedTypes) {
    const existing = structuredTypesByName.get(parsedType.name) || [];
    existing.push({
      ...parsedType,
      modulePath: "tests.camel_detection",
      qualifiedName: `tests.camel_detection.${parsedType.name}`,
      baseTypeRefs: []
    });
    structuredTypesByName.set(parsedType.name, existing);
  }

  extensionTestApi.finalizeStructuredTypeCamelCaseAccess(structuredTypesByName);

  assert.strictEqual(getOnlyStructuredType(parsedTypes, "CamelDirect").supportsCamelCaseAccess, true);
  assert.strictEqual(structuredTypesByName.get("CamelChild")[0].supportsCamelCaseAccess, true);
  assert.strictEqual(structuredTypesByName.get("PlainBase")[0].supportsCamelCaseAccess, false);
  assert.strictEqual(structuredTypesByName.get("PlainChild")[0].supportsCamelCaseAccess, false);
}

function runPythonPropertyParsingTests() {
  const source = `
class PropertyOnly:
    @property
    def business_key(self) -> str | None:
        return None

    @property
    def process_definition_key(self) -> str | None:
        return self.business_key
`;
  const parsedTypes = extensionTestApi.parseStructuredTypesFromPythonSource(source, "/tmp/property_detection.py");
  const propertyOnly = getOnlyStructuredType(parsedTypes, "PropertyOnly");
  assert(propertyOnly);
  assert.deepStrictEqual(
    propertyOnly.properties.map((property) => property.name),
    ["business_key", "process_definition_key"]
  );
  assert.deepStrictEqual(
    propertyOnly.properties.map((property) => property.annotation),
    ["str | None", "str | None"]
  );
}

function runPythonPropertyAliasParsingTests() {
  const source = `
class Partner:
    @property
    def businesspartner_id(self) -> str:
        return ""

    @property
    def businesspartnerId(self) -> str:
        return ""

    @property
    def arbeitnehmer_nummer(self) -> str:
        return ""

    @property
    def arbeitnehmerNummer(self) -> str:
        return ""

    @property
    def arbeitnehmernummer(self) -> str:
        return ""

    @property
    def sozialversicherungs_nummer(self) -> str:
        return ""

    @property
    def sozialversicherungsNummer(self) -> str:
        return ""

    @property
    def sozialversicherungsnummer(self) -> str:
        return ""

    @property
    def steuer_id(self) -> str:
        return ""

    @property
    def steuerId(self) -> str:
        return ""
`;
  const parsedTypes = extensionTestApi.parseStructuredTypesFromPythonSource(source, "/tmp/property_alias_detection.py");
  const partner = getOnlyStructuredType(parsedTypes, "Partner");
  assert(partner);
  assert.deepStrictEqual(
    partner.properties.map((property) => property.name),
    [
      "businesspartner_id",
      "businesspartnerId",
      "arbeitnehmer_nummer",
      "arbeitnehmerNummer",
      "arbeitnehmernummer",
      "sozialversicherungs_nummer",
      "sozialversicherungsNummer",
      "sozialversicherungsnummer",
      "steuer_id",
      "steuerId"
    ]
  );
}

function runReturnFieldNameStyleTests() {
  const index = createIndex([
    {
      name: "CamelInheritedResponse",
      filePath: "/tmp/models/camel_inherited_response.py",
      modulePath: "tests.models.camel_inherited_response",
      qualifiedName: "tests.models.camel_inherited_response.CamelInheritedResponse",
      supportsCamelCaseAccess: true,
      baseTypeNames: ["InheritedPayload"],
      baseTypeRefs: [{ typeName: "InheritedPayload", preferredQualifiedNames: [] }],
      fields: []
    },
    {
      name: "InheritedPayload",
      filePath: "/tmp/models/inherited_payload.py",
      modulePath: "tests.models.inherited_payload",
      qualifiedName: "tests.models.inherited_payload.InheritedPayload",
      supportsCamelCaseAccess: false,
      fields: [{ name: "process_instance", annotation: "StatusPayload" }]
    },
    {
      name: "CamelResponse",
      filePath: "/tmp/models/camel_response.py",
      modulePath: "tests.models.camel_response",
      qualifiedName: "tests.models.camel_response.CamelResponse",
      supportsCamelCaseAccess: true,
      fields: [
        { name: "status_code", annotation: "StatusPayload" },
        { name: "plain_child", annotation: "PlainChild" }
      ]
    },
    {
      name: "StatusPayload",
      filePath: "/tmp/models/status_payload.py",
      modulePath: "tests.models.status_payload",
      qualifiedName: "tests.models.status_payload.StatusPayload",
      supportsCamelCaseAccess: true,
      fields: [{ name: "business_key", annotation: "str" }]
    },
    {
      name: "PlainChild",
      filePath: "/tmp/models/plain_child.py",
      modulePath: "tests.models.plain_child",
      qualifiedName: "tests.models.plain_child.PlainChild",
      supportsCamelCaseAccess: false,
      fields: [{ name: "raw_field", annotation: "str" }]
    },
    {
      name: "PlainResponse",
      filePath: "/tmp/models/plain_response.py",
      modulePath: "tests.models.plain_response",
      qualifiedName: "tests.models.plain_response.PlainResponse",
      supportsCamelCaseAccess: false,
      fields: [{ name: "status_code", annotation: "str" }]
    }
  ]);

  const camelTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["CamelResponse"], index, {
    maxDepth: 2,
    maxFieldsPerType: 10
  });
  const camelOnly = workerTestApi.bindSimpleReturnAccessTemplate("${resp}", camelTemplate, "camelcase");
  assert(camelOnly.firstLevel.includes("${resp.statusCode}"));
  assert(camelOnly.firstLevel.includes("${resp.plainChild}"));
  assert(!camelOnly.firstLevel.includes("${resp.status_code}"));
  assert(camelOnly.secondLevel.includes("${resp.statusCode.businessKey}"));
  assert(camelOnly.secondLevel.includes("${resp.plainChild.raw_field}"));
  assert(!camelOnly.secondLevel.includes("${resp.plainChild.RawField}"));

  const snakeOnly = workerTestApi.bindSimpleReturnAccessTemplate("${resp}", camelTemplate, "snake_case");
  assert(snakeOnly.firstLevel.includes("${resp.status_code}"));
  assert(snakeOnly.firstLevel.includes("${resp.plain_child}"));
  assert(snakeOnly.secondLevel.includes("${resp.status_code.business_key}"));
  assert(snakeOnly.secondLevel.includes("${resp.plain_child.raw_field}"));
  assert(!snakeOnly.secondLevel.includes("${resp.plainChild.raw_field}"));

  const both = workerTestApi.bindSimpleReturnAccessTemplate("${resp}", camelTemplate, "both");
  assert(both.firstLevel.includes("${resp.statusCode}"));
  assert(both.firstLevel.includes("${resp.status_code}"));
  assert(both.secondLevel.includes("${resp.statusCode.businessKey}"));
  assert(both.secondLevel.includes("${resp.status_code.business_key}"));
  assert(both.secondLevel.includes("${resp.plainChild.raw_field}"));
  assert(both.secondLevel.includes("${resp.plain_child.raw_field}"));
  assert(!both.secondLevel.includes("${resp.statusCode.business_key}"));
  assert(!both.secondLevel.includes("${resp.status_code.businessKey}"));

  const plainTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["PlainResponse"], index, {
    maxDepth: 1,
    maxFieldsPerType: 10
  });
  const plainCamelOnly = workerTestApi.bindSimpleReturnAccessTemplate("${plain}", plainTemplate, "camelcase");
  assert.deepStrictEqual(plainCamelOnly.firstLevel, ["${plain.status_code}"]);

  const inheritedCamelTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["CamelInheritedResponse"], index, {
    maxDepth: 2,
    maxFieldsPerType: 10
  });
  const inheritedCamelOnly = workerTestApi.bindSimpleReturnAccessTemplate(
    "${wrapped}",
    inheritedCamelTemplate,
    "camelcase"
  );
  assert(inheritedCamelOnly.firstLevel.includes("${wrapped.processInstance}"));
  assert(!inheritedCamelOnly.firstLevel.includes("${wrapped.process_instance}"));
  assert(inheritedCamelOnly.secondLevel.includes("${wrapped.processInstance.businessKey}"));
}

function runPropertyInclusionTests() {
  const index = createIndex([
    {
      name: "PropertyPayload",
      filePath: "/tmp/models/property_payload.py",
      modulePath: "tests.models.property_payload",
      qualifiedName: "tests.models.property_payload.PropertyPayload",
      supportsCamelCaseAccess: true,
      fields: [{ name: "status_code", annotation: "str" }],
      properties: [
        { name: "business_key", annotation: "str" },
        { name: "businessKey", annotation: "str" }
      ]
    }
  ]);

  const withPropertiesTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["PropertyPayload"], index, {
    maxDepth: 1,
    maxFieldsPerType: 10,
    includeProperties: true
  });
  const camelOnly = workerTestApi.bindSimpleReturnAccessTemplate(
    "${payload}",
    withPropertiesTemplate,
    "camelcase"
  );
  assert.deepStrictEqual(camelOnly.firstLevel, ["${payload.statusCode}", "${payload.businessKey}"]);

  const snakeOnly = workerTestApi.bindSimpleReturnAccessTemplate(
    "${payload}",
    withPropertiesTemplate,
    "snake_case"
  );
  assert(snakeOnly.firstLevel.includes("${payload.status_code}"));
  assert(snakeOnly.firstLevel.includes("${payload.business_key}"));
  assert(snakeOnly.firstLevel.includes("${payload.businessKey}"));

  const withoutPropertiesTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["PropertyPayload"], index, {
    maxDepth: 1,
    maxFieldsPerType: 10,
    includeProperties: false
  });
  const withoutProperties = workerTestApi.bindSimpleReturnAccessTemplate(
    "${payload}",
    withoutPropertiesTemplate,
    "camelcase"
  );
  assert.deepStrictEqual(withoutProperties.firstLevel, ["${payload.statusCode}"]);

  const technicalWithProperties = workerTestApi.buildReturnStructureLines(
    ["PropertyPayload"],
    index,
    {
      maxDepth: 1,
      maxFieldsPerType: 10,
      includeProperties: true
    },
    "technical"
  );
  assert(technicalWithProperties.some((line) => line.includes(".business_key")));
  assert(technicalWithProperties.some((line) => line.includes(".businessKey")));

  const technicalWithoutProperties = workerTestApi.buildReturnStructureLines(
    ["PropertyPayload"],
    index,
    {
      maxDepth: 1,
      maxFieldsPerType: 10,
      includeProperties: false
    },
    "technical"
  );
  assert(!technicalWithoutProperties.some((line) => line.includes(".business_key")));
  assert(!technicalWithoutProperties.some((line) => line.includes(".businessKey")));

  const unlimitedIndex = createIndex([
    {
      name: "WidePayload",
      filePath: "/tmp/models/wide_payload.py",
      modulePath: "tests.models.wide_payload",
      qualifiedName: "tests.models.wide_payload.WidePayload",
      supportsCamelCaseAccess: false,
      fields: Array.from({ length: 13 }, (_, index) => ({
        name: `field_${index + 1}`,
        annotation: "str"
      }))
    }
  ]);
  const unlimitedTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["WidePayload"], unlimitedIndex, {
    maxDepth: 1,
    maxFieldsPerType: 0
  });
  const unlimitedAccess = workerTestApi.bindSimpleReturnAccessTemplate(
    "${wide}",
    unlimitedTemplate,
    "snake_case"
  );
  assert.strictEqual(unlimitedAccess.firstLevel.length, 13);

  const aliasIndex = createIndex([
    {
      name: "AliasPayload",
      filePath: "/tmp/models/alias_payload.py",
      modulePath: "tests.models.alias_payload",
      qualifiedName: "tests.models.alias_payload.AliasPayload",
      supportsCamelCaseAccess: false,
      properties: [
        { name: "businesspartner_id", annotation: "str" },
        { name: "businesspartnerId", annotation: "str" }
      ]
    }
  ]);
  const aliasTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["AliasPayload"], aliasIndex, {
    maxDepth: 1,
    maxFieldsPerType: 10,
    includeProperties: true
  });
  const aliasCamelOnly = workerTestApi.bindSimpleReturnAccessTemplate(
    "${alias}",
    aliasTemplate,
    "camelcase"
  );
  assert(aliasCamelOnly.firstLevel.includes("${alias.businesspartner_id}"));
  assert(aliasCamelOnly.firstLevel.includes("${alias.businesspartnerId}"));

  const aliasSnakeOnly = workerTestApi.bindSimpleReturnAccessTemplate(
    "${alias}",
    aliasTemplate,
    "snake_case"
  );
  assert(aliasSnakeOnly.firstLevel.includes("${alias.businesspartner_id}"));
  assert(aliasSnakeOnly.firstLevel.includes("${alias.businesspartnerId}"));
}

function runCompletionMatchingTests() {
  const index = createIndex([
    {
      name: "CamelResponse",
      filePath: "/tmp/models/camel_response.py",
      modulePath: "tests.models.camel_response",
      qualifiedName: "tests.models.camel_response.CamelResponse",
      supportsCamelCaseAccess: true,
      fields: [{ name: "status_code", annotation: "StatusPayload" }]
    },
    {
      name: "StatusPayload",
      filePath: "/tmp/models/status_payload.py",
      modulePath: "tests.models.status_payload",
      qualifiedName: "tests.models.status_payload.StatusPayload",
      supportsCamelCaseAccess: true,
      fields: [{ name: "business_key", annotation: "str" }]
    }
  ]);

  const template = workerTestApi.buildSimpleReturnAccessTemplate(["CamelResponse"], index, {
    maxDepth: 2,
    maxFieldsPerType: 10
  });

  const camelPrefix = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    template,
    [],
    "St",
    2,
    "camelcase"
  );
  assert(camelPrefix.some((candidate) => candidate.insertText === "statusCode"));
  assert(!camelPrefix.some((candidate) => candidate.insertText === "status_code"));

  const rawPrefixStillMatchesCamel = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    template,
    [],
    "status_",
    2,
    "camelcase"
  );
  assert.deepStrictEqual(
    rawPrefixStillMatchesCamel.map((candidate) => candidate.insertText),
    ["statusCode"]
  );

  const bothPrefix = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    template,
    [],
    "St",
    2,
    "both"
  );
  assert(bothPrefix.some((candidate) => candidate.insertText === "statusCode"));
  assert(bothPrefix.some((candidate) => candidate.insertText === "status_code"));

  const nestedFromCamelPath = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    template,
    ["statusCode"],
    "Bus",
    2,
    "camelcase"
  );
  assert.deepStrictEqual(
    nestedFromCamelPath.map((candidate) => candidate.insertText),
    ["businessKey"]
  );

  const nestedFromRawPath = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    template,
    ["status_code"],
    "business_",
    2,
    "camelcase"
  );
  assert.deepStrictEqual(
    nestedFromRawPath.map((candidate) => candidate.insertText),
    ["businessKey"]
  );

  const propertyIndex = createIndex([
    {
      name: "PropertyPayload",
      filePath: "/tmp/models/property_payload.py",
      modulePath: "tests.models.property_payload",
      qualifiedName: "tests.models.property_payload.PropertyPayload",
      supportsCamelCaseAccess: true,
      fields: [{ name: "status_code", annotation: "str" }],
      properties: [
        { name: "business_key", annotation: "str" },
        { name: "businessKey", annotation: "str" }
      ]
    }
  ]);

  const propertyTemplate = workerTestApi.buildSimpleReturnAccessTemplate(["PropertyPayload"], propertyIndex, {
    maxDepth: 1,
    maxFieldsPerType: 10,
    includeProperties: true
  });
  const propertyPrefix = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    propertyTemplate,
    [],
    "business",
    1,
    "camelcase"
  );
  assert.deepStrictEqual(
    propertyPrefix.map((candidate) => candidate.insertText),
    ["businessKey"]
  );

  const propertyPrefixSnake = workerTestApi.collectReturnMemberCompletionCandidatesFromTemplate(
    propertyTemplate,
    [],
    "business",
    1,
    "snake_case"
  );
  assert.deepStrictEqual(
    propertyPrefixSnake.map((candidate) => candidate.insertText),
    ["business_key", "businessKey"]
  );
}

function runSecondLevelPreviewRenderingTests() {
  const secondLevelPaths = Array.from({ length: 18 }, (_, index) => `\${value.child_${index + 1}.leaf}`);
  const markdown = extensionTestApi.buildEnumPreviewMarkdown({
    argumentName: "payload",
    argumentValue: "${value}",
    shownEnums: [],
    annotationHints: [],
    duplicateCandidateCount: 0,
    returnHintContext: {
      assignment: { keywordName: "Set Variable" },
      simpleAccess: {
        firstLevel: ["${value.child_1}"],
        secondLevel: secondLevelPaths,
        levels: [["${value.child_1}"], secondLevelPaths]
      }
    }
  });

  for (const path of secondLevelPaths) {
    assert(markdown.includes(path));
  }
  assert(!markdown.includes("Showing first 12"));
}

async function runInlineDocumentationTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case One
    [Documentation]    Intro line
    ...    More intro
    Log    before
    #> ## Inline Head
    #> paragraph line
    #>
    #> - bullet
    Log    between
    # just a normal comment
    #> ## Followup
    #> after followup
Case Two
    #> ## Other Head
    #> other text
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  assert.strictEqual(parsed.blocks.length, 2);

  const firstBlock = parsed.blocks[0];
  assert.strictEqual(firstBlock.ownerName, "Case One");
  assert.strictEqual(firstBlock.title, "Inline Head");
  assert.deepStrictEqual(
    firstBlock.fragments.map((fragment) => fragment.sourceKind),
    ["documentation", "inline", "inline"]
  );
  assert.deepStrictEqual(firstBlock.lineSpans, [
    { startLine: 2, endLine: 3 },
    { startLine: 5, endLine: 8 },
    { startLine: 11, endLine: 12 }
  ]);
  assert(firstBlock.markdown.includes("Intro line"));
  assert(firstBlock.markdown.includes("## Inline Head"));
  assert(firstBlock.markdown.includes("## Followup"));
  assert(!firstBlock.markdown.includes("just a normal comment"));

  const inlineSpan = extensionTestApi.getContainingBlockSpan(firstBlock, 6);
  assert.deepStrictEqual(inlineSpan, { startLine: 5, endLine: 8 });
  assert.strictEqual(extensionTestApi.getContainingBlockSpan(firstBlock, 9), undefined);
  assert.strictEqual(extensionTestApi.findNearestBlock(parsed.blocks, 9).id, firstBlock.id);

  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), firstBlock);
  assert(renderedHtml.includes('data-doc-render-targets="'));
  assert(renderedHtml.includes(encodeURIComponent(extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 2))));
  assert(renderedHtml.includes(encodeURIComponent(extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 5))));
  assert(renderedHtml.includes(encodeURIComponent(extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 11))));
  assert.strictEqual((renderedHtml.match(/<pre>/g) || []).length, 1);
  assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
  assert(!renderedHtml.includes("doc-fragment"));
  assert(!renderedHtml.includes('data-source-command="'));
  const targetMatch = renderedHtml.match(/data-doc-render-targets="([^"]+)"/);
  assert(targetMatch);
  const decodedTargets = JSON.parse(decodeURIComponent(targetMatch[1]));
  assert.strictEqual(decodedTargets.length, 6);
  assert(decodedTargets.some((target) => target.kind === "list-item" && String(target.label).includes("line 9")));

  const secondBlock = parsed.blocks[1];
  assert.strictEqual(secondBlock.ownerName, "Case Two");
  assert.strictEqual(secondBlock.title, "Other Head");
  assert.deepStrictEqual(secondBlock.fragments.map((fragment) => fragment.sourceKind), ["inline"]);
}

async function runIndentedInlineDocumentationTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Nested
    #> - first item
    #>> - second item
    #>>> - third item
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const block = parsed.blocks[0];

  assert(block.markdown.includes("- first item"));
  assert(block.markdown.includes("  - second item"));
  assert(block.markdown.includes("    - third item"));

  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), block);
  assert(renderedHtml.includes("first item"));
  assert(renderedHtml.includes("second item"));
  assert(renderedHtml.includes("third item"));
  assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
  assert(!renderedHtml.includes("doc-fragment"));

  const targetMatch = renderedHtml.match(/data-doc-render-targets="([^"]+)"/);
  assert(targetMatch);
  const decodedTargets = JSON.parse(decodeURIComponent(targetMatch[1]));
  const listTargets = decodedTargets.filter((target) => target.kind === "list-item");
  assert.strictEqual(listTargets.length, 3);
  assert(listTargets.some((target) => String(target.label).includes("line 3")));
  assert(listTargets.some((target) => String(target.label).includes("line 4")));
  assert(listTargets.some((target) => String(target.label).includes("line 5")));
}

function runRenderedArrowIndentHtmlTransformTests() {
  const inputHtml = [
    "<ul>",
    "<li>Base amount = synthetic value<br>",
    "[[RDP_INDENT_2]]-&gt; seizable amount = 0,00 EUR<br>",
    "[[RDP_INDENT_2]]continued explanation line<br>",
    "[[RDP_INDENT_2]]-&gt; protected amount = 1.499,99 EUR</li>",
    "</ul>",
    "<p>[[RDP_INDENT_4]]-&gt; inline proof line</p>",
    "<pre>Heading<br>[[RDP_INDENT_2]]-&gt; fallback proof</pre>"
  ].join("");

  const transformedHtml = extensionTestApi.expandArrowIndentTokensInRenderedHtml(inputHtml);
  assert(!transformedHtml.includes("[[RDP_INDENT_"), "expected raw RDP indent tokens to be removed");
  assert(transformedHtml.includes('class="robot-render-line"'));
  assert(transformedHtml.includes('class="robot-render-line robot-arrow-line" style="--robot-arrow-indent:2ch"'));
  assert(transformedHtml.includes('class="robot-render-line robot-arrow-line" style="--robot-arrow-indent:4ch"'));
  assert(transformedHtml.includes('class="robot-arrow-marker">-&gt;</span>'));
  assert(
    transformedHtml.includes('class="robot-arrow-marker robot-arrow-marker-placeholder" aria-hidden="true">-&gt;</span>')
  );
  assert(transformedHtml.includes('class="robot-arrow-body">seizable amount = 0,00 EUR</span>'));
  assert(transformedHtml.includes('class="robot-arrow-body">continued explanation line</span>'));
  assert(transformedHtml.includes('class="robot-arrow-body">fallback proof</span>'));
  assert(transformedHtml.includes("Base amount = synthetic value"));
  assert(transformedHtml.includes("-&gt;</span><span"));
}

async function runInlineArrowContinuationRenderingTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Arrow Continuation
    #>> -> Arrow first line
    #>>    Arrow second line
    #>> - Bullet first line
    #>>   Bullet second line
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const block = parsed.blocks[0];
  const bodyRenderData = extensionTestApi.buildDocumentationBodyRenderData(document.uri.toString(), block);
  assert.match(
    bodyRenderData.markdown,
    /-><span class="doc-target-marker" data-doc-target-index="0"><\/span> Arrow first line/
  );
  assert.match(
    bodyRenderData.markdown,
    /\s+<span class="doc-target-marker" data-doc-target-index="1"><\/span>Arrow second line/
  );

  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), block);
  assert.strictEqual(
    (renderedHtml.match(/class="robot-render-line robot-arrow-line"/g) || []).length,
    2,
    "expected only the arrow line and its plain continuation to use arrow-line rendering"
  );
  assert(
    renderedHtml.includes('class="robot-arrow-marker robot-arrow-marker-placeholder" aria-hidden="true">-&gt;</span>'),
    "expected the continuation line to reserve hidden arrow-marker width"
  );
  assert(renderedHtml.includes("Arrow second line"));
  assert(renderedHtml.includes("Bullet first line"));
  assert(renderedHtml.includes("Bullet second line"));
}

function runDocumentationPreviewManagedClickBridgeTests() {
  const renderedHtml = extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
    {
      documentUri: "file:///tmp/test.robot",
      fileName: "test.robot",
      blocks: [
        {
          id: "block-1",
          ownerName: "Case One",
          title: "Flow",
          section: "tests",
          startLine: 10,
          endLine: 20,
          ownerStartLine: 2
        }
      ]
    },
    {
      id: "block-1",
      ownerName: "Case One",
      title: "Flow",
      section: "tests",
      startLine: 10,
      endLine: 20,
      ownerStartLine: 2
    },
    '<section class="doc-render-flow" data-doc-render-targets="%5B%7B%22commandUri%22%3A%22command%3ArobotCompanion.openLocation%253Fexample%22%2C%22label%22%3A%22Open%22%2C%22kind%22%3A%22heading%22%7D%5D"><h2>Flow</h2></section>'
  );

  assert(renderedHtml.includes("acquireVsCodeApi"), "expected preview webview to request the VS Code API");
  assert(
    renderedHtml.includes("type: 'executeCommandUri'"),
    "expected preview webview to post executeCommandUri messages for managed clicks"
  );
  assert(
    renderedHtml.includes("vscodeApi.postMessage"),
    "expected preview webview to send managed click commands through the VS Code message bridge"
  );
  assert(
    renderedHtml.includes("setReturnedVariablesVisible"),
    "expected preview webview to report returned-variable toggle state to the extension"
  );
  assert(
    renderedHtml.includes("const getClosestElement = (target, selector) =>"),
    "expected preview webview to normalize text-node click targets before using closest()"
  );
  assert(
    renderedHtml.includes("target && target.parentElement instanceof Element"),
    "expected preview webview to fall back from text nodes to their parent element for click handling"
  );
  assert(
    renderedHtml.includes("querySelectorAll('.doc-target-marker[data-doc-target-index]')"),
    "expected preview webview to bind documentation jumps by explicit rendered target markers"
  );
  assert(
    renderedHtml.includes("display: flex;"),
    "expected arrow lines to use a two-part flex layout"
  );
  assert(
    renderedHtml.includes("column-gap: 1ch;"),
    "expected arrow lines to reserve space between the marker and wrapped body"
  );
  assert(
    renderedHtml.includes("flex: 1 1 auto;"),
    "expected arrow-line body text to wrap inside the remaining preview width"
  );
  assert(
    renderedHtml.includes("padding-left: var(--robot-arrow-indent, 0ch);"),
    "expected arrow lines to keep their existing base indent"
  );
  assert(
    renderedHtml.includes('class="robot-arrow-marker"'),
    "expected fallback preview script to render arrow markers separately"
  );
  assert(
    renderedHtml.includes('class="robot-arrow-body"'),
    "expected fallback preview script to render arrow text in a wrapping body column"
  );
  assert(
    renderedHtml.includes('data-doc-overview-section="tests"'),
    "expected overview rows to include their documentation section"
  );
  assert(
    !renderedHtml.includes('<input type="checkbox" data-doc-overview-keyword-toggle'),
    "expected preview to omit the keyword overview toggle when there are no keyword blocks"
  );

  const keywordRenderedHtml = extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
    {
      documentUri: "file:///tmp/test.robot",
      fileName: "test.robot",
      blocks: [
        {
          id: "keyword-block-1",
          ownerName: "Helper Keyword",
          title: "Keyword Flow",
          section: "keywords",
          startLine: 30,
          endLine: 40,
          ownerStartLine: 25
        }
      ]
    },
    {
      id: "keyword-block-1",
      ownerName: "Helper Keyword",
      title: "Keyword Flow",
      section: "keywords",
      startLine: 30,
      endLine: 40,
      ownerStartLine: 25
    },
    '<section class="doc-render-flow" data-doc-render-targets="%5B%5D"><h2>Keyword Flow</h2></section>'
  );
  assert(keywordRenderedHtml.includes("Jump to keyword"));
  assert(!keywordRenderedHtml.includes("Jump to testcase"));
  assert(
    keywordRenderedHtml.includes('<input type="checkbox" data-doc-overview-keyword-toggle'),
    "expected preview to render a keyword overview visibility switch when keyword blocks exist"
  );
  assert(keywordRenderedHtml.includes("Show keywords"));
  assert(
    keywordRenderedHtml.includes('data-doc-overview-section="keywords"'),
    "expected keyword overview rows to be marked as keyword rows"
  );
  assert(
    keywordRenderedHtml.includes("showKeywordOverview"),
    "expected preview script to persist the keyword overview switch state"
  );
  assert(
    keywordRenderedHtml.includes("const applyKeywordOverviewFilter ="),
    "expected preview script to hide and show keyword overview rows"
  );
  assert(
    keywordRenderedHtml.includes("vscodeApi.setState"),
    "expected preview script to store keyword overview preference in webview state"
  );
}

function decodeDocumentationRenderTargets(renderedHtml) {
  const targetMatch = String(renderedHtml || "").match(/data-doc-render-targets="([^"]+)"/);
  assert(targetMatch, "expected rendered documentation HTML to include encoded source targets");
  return JSON.parse(decodeURIComponent(targetMatch[1]));
}

function extractRenderedSection(renderedHtml, markerFragment) {
  const match = String(renderedHtml || "").match(
    new RegExp(`<section[^>]*${markerFragment}[^>]*>[\\s\\S]*?<\\/section>`)
  );
  assert(match, `expected rendered HTML to include section matching ${markerFragment}`);
  return match[0];
}

async function runLargeFixtureRenderTargetTests() {
  const fixtureExpectations = [
    {
      fixtureName: "folding-regression-large.robot",
      expectedTargets: [
        { line: 27, kind: "heading", labelFragment: "line 28" },
        { line: 29, kind: "heading", labelFragment: "line 30" },
        { line: 30, kind: "list-item", labelFragment: "line 31" },
        { line: 33, kind: "list-item", labelFragment: "line 34" },
        { line: 84, kind: "list-item", labelFragment: "line 85" },
        { line: 139, kind: "arrow-line", labelFragment: "line 140" }
      ]
    },
    {
      fixtureName: "folding-regression-adjustment.robot",
      expectedTargets: [
        { line: 73, kind: "heading", labelFragment: "line 74" },
        { line: 74, kind: "heading", labelFragment: "line 75" },
        { line: 75, kind: "list-item", labelFragment: "line 76" },
        { line: 162, kind: "arrow-line", labelFragment: "line 163" },
        { line: 186, kind: "arrow-line", labelFragment: "line 187" },
        { line: 199, kind: "arrow-line", labelFragment: "line 200" },
        { line: 205, kind: "heading", labelFragment: "line 206" },
        { line: 206, kind: "arrow-line", labelFragment: "line 207" },
        { line: 207, kind: "arrow-line", labelFragment: "line 208" },
        { line: 238, kind: "arrow-line", labelFragment: "line 239" },
        { line: 267, kind: "heading", labelFragment: "line 268" },
        { line: 268, kind: "list-item", labelFragment: "line 269" },
        { line: 311, kind: "heading", labelFragment: "line 312" }
      ]
    },
    {
      fixtureName: "documentation-inline-mixed-simple.robot",
      expectedTargets: [
        { line: 3, kind: "heading", labelFragment: "line 4" },
        { line: 4, kind: "list-item", labelFragment: "line 5" },
        { line: 5, kind: "list-item", labelFragment: "line 6" },
        { line: 7, kind: "heading", labelFragment: "line 8" },
        { line: 8, kind: "chunk", labelFragment: "line 9" },
        { line: 11, kind: "heading", labelFragment: "line 12" },
        { line: 12, kind: "heading", labelFragment: "line 13" },
        { line: 13, kind: "list-item", labelFragment: "line 14" },
        { line: 16, kind: "arrow-line", labelFragment: "line 17" },
        { line: 19, kind: "heading", labelFragment: "line 20" },
        { line: 20, kind: "list-item", labelFragment: "line 21" }
      ],
      expectedTargetLinesInOrder: [3, 4, 5, 7, 8, 11, 12, 13, 16, 19, 20]
    },
    {
      fixtureName: "documentation-inline-mixed-involved.robot",
      expectedTargets: [
        { line: 6, kind: "heading", labelFragment: "line 7" },
        { line: 7, kind: "list-item", labelFragment: "line 8" },
        { line: 8, kind: "list-item", labelFragment: "line 9" },
        { line: 11, kind: "heading", labelFragment: "line 12" },
        { line: 12, kind: "list-item", labelFragment: "line 13" },
        { line: 13, kind: "list-item", labelFragment: "line 14" },
        { line: 14, kind: "list-item", labelFragment: "line 15" },
        { line: 22, kind: "heading", labelFragment: "line 23" },
        { line: 23, kind: "heading", labelFragment: "line 24" },
        { line: 24, kind: "list-item", labelFragment: "line 25" },
        { line: 28, kind: "list-item", labelFragment: "line 29" },
        { line: 33, kind: "arrow-line", labelFragment: "line 34" },
        { line: 38, kind: "arrow-line", labelFragment: "line 39" },
        { line: 43, kind: "heading", labelFragment: "line 44" },
        { line: 44, kind: "list-item", labelFragment: "line 45" },
        { line: 48, kind: "arrow-line", labelFragment: "line 49" },
        { line: 52, kind: "arrow-line", labelFragment: "line 53" },
        { line: 57, kind: "heading", labelFragment: "line 58" },
        { line: 58, kind: "list-item", labelFragment: "line 59" },
        { line: 62, kind: "arrow-line", labelFragment: "line 63" }
      ],
      expectedTargetLinesInOrder: [6, 7, 8, 11, 12, 13, 14, 22, 23, 24, 28, 33, 38, 43, 44, 48, 52, 57, 58, 62]
    },
    {
      fixtureName: "documentation-arrow-indent-drittrecht.robot",
      expectedTargets: [
        { line: 6, kind: "heading", labelFragment: "line 7" },
        { line: 7, kind: "list-item", labelFragment: "line 8" },
        { line: 8, kind: "list-item", labelFragment: "line 9" },
        { line: 19, kind: "heading", labelFragment: "line 20" },
        { line: 20, kind: "heading", labelFragment: "line 21" },
        { line: 21, kind: "list-item", labelFragment: "line 22" },
        { line: 26, kind: "list-item", labelFragment: "line 27" },
        { line: 30, kind: "arrow-line", labelFragment: "line 31" },
        { line: 34, kind: "arrow-line", labelFragment: "line 35" },
        { line: 39, kind: "list-item", labelFragment: "line 40" },
        { line: 43, kind: "arrow-line", labelFragment: "line 44" },
        { line: 48, kind: "arrow-line", labelFragment: "line 49" }
      ],
      expectedTargetLinesInOrder: [6, 7, 8, 19, 20, 21, 26, 30, 34, 39, 43, 48],
      expectedArrowIndentWidths: [2, 2, 2, 2, 2, 2]
    }
  ];

  for (const fixture of fixtureExpectations) {
    const fixturePath = path.resolve(__dirname, "fixtures", fixture.fixtureName);
    const parser = new extensionTestApi.RobotDocumentationService();
    const source = fs.readFileSync(fixturePath, "utf8");
    const document = createMockRobotDocument(source, fixturePath);
    const parsed = parser.parse(document);

    assert.strictEqual(parsed.blocks.length, 1, `${fixture.fixtureName} should parse as a single target block`);

    const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), parsed.blocks[0]);
    const bodyRenderData = extensionTestApi.buildDocumentationBodyRenderData(document.uri.toString(), parsed.blocks[0]);
    assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
    assert(!renderedHtml.includes("doc-fragment"));
    assert(!renderedHtml.includes("[[RDP_INDENT_"), `${fixture.fixtureName} should not leak raw RDP indent tokens`);
    assert(
      bodyRenderData.markdown.includes('class="doc-target-marker"'),
      `${fixture.fixtureName} should inject explicit rendered target markers into the documentation markdown`
    );
    const decodedTargets = decodeDocumentationRenderTargets(renderedHtml);

    if (Array.isArray(fixture.expectedArrowIndentWidths)) {
      for (const indentWidth of fixture.expectedArrowIndentWidths) {
        assert(
          renderedHtml.includes(`class="robot-render-line robot-arrow-line" style="--robot-arrow-indent:${indentWidth}ch"`),
          `${fixture.fixtureName} should render arrow lines with ${indentWidth}ch indentation`
        );
      }
    }

    const expectedArrowLineCount = fixture.expectedTargets.filter((target) => target.kind === "arrow-line").length;
    if (expectedArrowLineCount > 0) {
      const renderedArrowLineCount = (renderedHtml.match(/class="robot-render-line robot-arrow-line"/g) || []).length;
      assert(
        renderedArrowLineCount >= expectedArrowLineCount,
        `${fixture.fixtureName} should render every arrow-line target as a dedicated arrow-line surface`
      );
      assert(
        renderedHtml.includes('class="robot-arrow-body"'),
        `${fixture.fixtureName} should render arrow text in the wrapping arrow body span`
      );
    }

    for (const expectedTarget of fixture.expectedTargets) {
      const expectedCommandUri = extensionTestApi.buildOpenLocationCommandUri(
        document.uri.toString(),
        expectedTarget.line
      );
      assert(
        decodedTargets.some(
          (target) =>
            target.kind === expectedTarget.kind &&
            target.commandUri === expectedCommandUri &&
            String(target.label || "").includes(expectedTarget.labelFragment)
        ),
        `${fixture.fixtureName} should expose a ${expectedTarget.kind} target for ${expectedTarget.labelFragment}`
      );
    }

    if (Array.isArray(fixture.expectedTargetLinesInOrder)) {
      const actualTargetLinesInOrder = decodedTargets
        .map((target) => {
          const parsedCommand = parseCommandUri(String(target.commandUri || ""));
          return parsedCommand.commandId === "robotCompanion.openLocation"
            ? Number(parsedCommand.args[1])
            : Number.NaN;
        })
        .filter((line) => Number.isInteger(line));
      assert.deepStrictEqual(
        actualTargetLinesInOrder,
        fixture.expectedTargetLinesInOrder,
        `${fixture.fixtureName} should keep documentation and inline targets in the expected order`
      );
    }
  }
}

async function runDocumentationVariableSectionRenderTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case With Variables
    [Documentation]    Intro section
    VAR    \${plainDate}    2022-01-01
    VAR    \${typedDate: date}    2022-01-02
    \${computedLabel}=    Set Variable    hello world
    IF    \${flag}
        \${branchMaybe}=    Set Variable    ALPHA
    ELSE
        \${branchMaybe}=    Set Variable    \${None}
    END
    IF    \${checkPdf}
        \${pdfContent}=    Keyword Read Pdf
    ELSE
        \${pdfContent}=    Set Variable    \${None}
    END
    \${timelineDate}=    Set Variable    2025-04-01
    \${timelineDate}=    Set Variable    2025-05-01
    \${repeatedNone}=    Set Variable    \${None}
    \${repeatedNone}=    Set Variable    \${None}
    \${returnedValue}=    Keyword Alpha
    \${returnedValue}=    Keyword Beta
    Log    \${plainDate}
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const block = parsed.blocks[0];

  assert.strictEqual(block.variableAssignments.length, 10);
  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), block);
  assert(renderedHtml.includes("Variables"), "expected rendered documentation to include a Variables section");
  assert(renderedHtml.includes("Returned Variables"), "expected rendered documentation to include a returned section");
  assert(renderedHtml.includes("${plainDate}"));
  assert(renderedHtml.includes("${typedDate: date}"));
  assert(renderedHtml.includes("${computedLabel}"));
  assert(renderedHtml.includes("2022-01-01"));
  assert(renderedHtml.includes("2022-01-02"));
  assert(renderedHtml.includes("hello world"));
  assert(renderedHtml.includes("ALPHA"));
  assert(renderedHtml.includes("Return from Keyword Read Pdf"));
  assert(renderedHtml.includes("2025-04-01"));
  assert(renderedHtml.includes("2025-05-01"));
  assert(renderedHtml.includes("Ambiguous"));
  assert(renderedHtml.includes('data-preview-toggle-section="returned-variables"'));
  assert(renderedHtml.includes("hidden"));
  assert(
    renderedHtml.indexOf("Variables") > renderedHtml.indexOf("Intro section"),
    "expected Variables section to be rendered after the documentation content"
  );

  const localSectionHtml = extractRenderedSection(renderedHtml, "doc-variable-section-primary");
  const returnedSectionHtml = extractRenderedSection(renderedHtml, 'data-preview-toggle-section="returned-variables"');
  const localHeadingCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 3);
  const varCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 3);
  const typedVarCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 4);
  const setVariableCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 5);
  const branchAlphaCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 7);
  const branchNoneCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 9);
  const timelineDateCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 16);
  const timelineDateLatestCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 17);
  const repeatedNoneCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 19);
  const returnedPdfCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 12);
  const returnedPdfNoneCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 14);
  const returnedFirstCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 20);
  const returnedSecondCommandUri = extensionTestApi.buildOpenLocationCommandUri(document.uri.toString(), 21);

  assert(localSectionHtml.includes(localHeadingCommandUri), "expected Variables heading to point to the first local variable definition");
  assert(localSectionHtml.includes(varCommandUri), "expected VAR assignment target in documentation variables section");
  assert(localSectionHtml.includes(typedVarCommandUri), "expected typed VAR assignment target in documentation variables section");
  assert(localSectionHtml.includes(setVariableCommandUri), "expected Set Variable assignment target in documentation variables section");
  assert(localSectionHtml.includes(branchAlphaCommandUri), "expected ambiguous branch value to link to ALPHA assignment");
  assert(localSectionHtml.includes(branchNoneCommandUri), "expected ambiguous branch value to link to None assignment");
  assert(localSectionHtml.includes("${timelineDate}"));
  assert(localSectionHtml.includes("2025-04-01"));
  assert(localSectionHtml.includes("2025-05-01"));
  assert(localSectionHtml.includes(timelineDateCommandUri), "expected ambiguous multi-assignment variables to jump to the first definition");
  assert(localSectionHtml.includes(timelineDateLatestCommandUri), "expected later ambiguous value to keep its own link");
  assert(localSectionHtml.includes(repeatedNoneCommandUri), "expected latest repeated None assignment to be the summary source");
  assert.strictEqual((localSectionHtml.match(/\$\{repeatedNone\}/g) || []).length, 1);
  assert(localSectionHtml.includes("${pdfContent}"));
  assert(localSectionHtml.includes("Return from Keyword Read Pdf"));
  assert(localSectionHtml.includes("${None}"));
  assert(localSectionHtml.includes(returnedPdfCommandUri), "expected mixed keyword-return value link");
  assert(localSectionHtml.includes(returnedPdfNoneCommandUri), "expected mixed None branch value link");
  assert(localSectionHtml.includes("Show Returned Variables"));
  assert(localSectionHtml.includes('data-preview-toggle-target="returned-variables"'));
  assert(localSectionHtml.includes('data-preview-toggle-block-id="'));
  assert(localSectionHtml.includes(`data-preview-toggle-document-uri="${document.uri.toString()}"`));
  assert(!localSectionHtml.includes("Keyword Alpha"));
  assert(!localSectionHtml.includes("Keyword Beta"));

  assert(returnedSectionHtml.includes(returnedPdfCommandUri), "expected mixed keyword-return source link");
  assert(returnedSectionHtml.includes(returnedFirstCommandUri), "expected first returned variable source link");
  assert(returnedSectionHtml.includes(returnedSecondCommandUri), "expected second returned variable source link");
  assert(returnedSectionHtml.includes("Return from Keyword Read Pdf"));
  assert(returnedSectionHtml.includes("Return from Keyword Alpha"));
  assert(returnedSectionHtml.includes("Return from Keyword Beta"));
  assert(
    returnedSectionHtml.indexOf("Return from Keyword Read Pdf") < returnedSectionHtml.indexOf("Return from Keyword Alpha") &&
      returnedSectionHtml.indexOf("Return from Keyword Alpha") < returnedSectionHtml.indexOf("Return from Keyword Beta"),
    "expected returned variables to stay chronological"
  );

  const returnedOnlyDocument = createMockRobotDocument(`
*** Test Cases ***
Case With Returned Variables Only
    [Documentation]    Intro section
    \${fromKeyword}=    Keyword Alpha
    Log    \${fromKeyword}
`);
  const returnedOnlyParsed = parser.parse(returnedOnlyDocument);
  const returnedOnlyHtml = await extensionTestApi.renderDocumentationBlockHtml(
    returnedOnlyDocument.uri.toString(),
    returnedOnlyParsed.blocks[0]
  );
  const returnedOnlyCommandUri = extensionTestApi.buildOpenLocationCommandUri(
    returnedOnlyDocument.uri.toString(),
    3
  );
  assert(!returnedOnlyHtml.includes("doc-variable-section-primary"));
  assert(returnedOnlyHtml.includes("Returned Variables"));
  assert(returnedOnlyHtml.includes(returnedOnlyCommandUri));
  assert(!returnedOnlyHtml.includes("Show Returned Variables"));
  assert(!returnedOnlyHtml.includes('data-preview-toggle-section="returned-variables"'));
  assert(!returnedOnlyHtml.includes("hidden"));
}

async function runDocumentationLocalVariableSubstitutionTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Documentation Variables
    \${datumLeistungsbeginn}=    Set Variable    01.04.2025
    VAR    \${datumAenderungsmeldung}    10.07.2026
    \${sameValue}=    Set Variable    A_B
    \${sameValue}=    Set Variable    A_B
    \${ambiguousDate}=    Set Variable    2025-01-01
    \${ambiguousDate}=    Set Variable    2025-02-01
    #> - Kinder neu: 2 Kinder ab \${datumLeistungsbeginn}, 1 Kind ab \${datumAenderungsmeldung}, 0 Kinder ab 01.09.2035.
    #> - Same value remains literal: \${sameValue}
    #> - Unknown remains variable: \${unknownDate}
    #> - Ambiguous remains variable: \${ambiguousDate}
    #> \`\`\`
    #> fenced \${datumLeistungsbeginn}
    #> \`\`\`
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(
    document.uri.toString(),
    parsed.blocks[0]
  );
  const bodyHtml = extractRenderedSection(renderedHtml, "doc-render-flow");

  assert(bodyHtml.includes("2 Kinder ab 01.04.2025, 1 Kind ab 10.07.2026"));
  assert(!bodyHtml.includes("${datumAenderungsmeldung}"));
  assert(
    bodyHtml.includes("Same value remains literal: A_B") ||
      bodyHtml.includes("Same value remains literal: A\\_B")
  );
  assert(bodyHtml.includes("${unknownDate}"));
  assert(bodyHtml.includes("${ambiguousDate}"));
  assert(bodyHtml.includes("fenced ${datumLeistungsbeginn}"));
}

async function runDocumentationColorMarkupTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Documentation Colors
    #> ## Flow
    #> - Prüfen, ob <question>die Fachregel noch offen ist</question> und <color value="red">rot markiert</color> wird.
    #>> -> Ergebnis ist <error>noch fehlerhaft</error>, siehe <color value="#0f766e">neue Klärung</color> und <pink>pink markiert</pink>.
    #> - Alias colors: <red>rot</red>, <blue>blau</blue>, <gray>grau</gray>.
    #> - Unsupported stays safe: <color value="expression(alert(1))">not styled</color> and <warning class="bad">no attrs</warning> and <pink class="bad">no pink attrs</pink>.
    #> \`\`\`
    #> <success>literal success tag in fence</success>
    #> \`\`\`
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const block = parsed.blocks[0];

  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), block);
  assert(renderedHtml.includes('class="doc-color-span doc-color-semantic doc-color-question"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-semantic doc-color-error"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-custom" style="color:#b42318"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-custom" style="color:#0f766e"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-custom" style="color:#be185d"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-custom" style="color:#1d4ed8"'));
  assert(renderedHtml.includes('class="doc-color-span doc-color-custom" style="color:#4b5563"'));
  assert(!renderedHtml.includes('style="color:expression'));
  assert(!renderedHtml.includes('class="doc-color-span doc-color-semantic doc-color-warning">no attrs'));
  assert(!renderedHtml.includes('style="color:#be185d">no pink attrs'));
  assert(!renderedHtml.includes('class="doc-color-span doc-color-semantic doc-color-success">literal success'));

  const decodedTargets = decodeDocumentationRenderTargets(renderedHtml);
  assert(
    decodedTargets.some((target) => String(target.label || "").includes("line 4")),
    "expected colored bullet text to keep its source target"
  );
  assert(
    decodedTargets.some((target) => String(target.label || "").includes("line 5")),
    "expected colored arrow text to keep its source target"
  );

  const markdown = extensionTestApi.buildDocumentationExportMarkdown(document.uri.toString(), block);
  assert(markdown.includes("<question>die Fachregel noch offen ist</question>"));
  assert(markdown.includes('<color value="red">rot markiert</color>'));
  assert(markdown.includes("<error>noch fehlerhaft</error>"));
  assert(markdown.includes('<color value="#0f766e">neue Klärung</color>'));
  assert(markdown.includes("<pink>pink markiert</pink>"));
  assert(markdown.includes("<red>rot</red>"));
  assert(!markdown.includes("doc-color-span"));

  const pageHtml = extensionTestApi.buildDocumentationPdfExportPageHtml("Case Documentation Colors", renderedHtml, 0);
  const pdfHtml = extensionTestApi.buildDocumentationPdfExportHtml(document, {
    title: "Case Documentation Colors",
    bodyHtml: pageHtml
  });
  assert(pdfHtml.includes("print-color-adjust: exact"));
  assert(pdfHtml.includes("-webkit-print-color-adjust: exact"));
  assert(pdfHtml.includes(".preview .doc-color-error"));
  assert(pdfHtml.includes(".preview .robot-arrow-line"));
  assert(pdfHtml.includes('class="doc-color-span doc-color-semantic doc-color-question"'));
  assert(pdfHtml.includes('style="color:#0f766e"'));

  const previewHtml = extensionTestApi.buildDocumentationPreviewWebviewHtmlForTest(
    {
      documentUri: document.uri.toString(),
      fileName: "colors.robot",
      blocks: [block]
    },
    block,
    renderedHtml
  );
  assert(previewHtml.includes(".preview .doc-color-error"));
  assert(previewHtml.includes(".preview .robot-arrow-line"));
}

function runConditionalVariableResolutionTests() {
  const parser = new extensionTestApi.RobotDocumentationService();

  const ifElseDocument = createMockRobotDocument(`
*** Test Cases ***
Case Conditional Value
    IF    \${flag}
        \${pdfContent}=    Set Variable    PDF_READY
    ELSE
        \${pdfContent}=    Set Variable    \${None}
    END
    Log    \${pdfContent}
`);
  const ifElseParsed = parser.parse(ifElseDocument);
  assert.strictEqual(ifElseParsed.variableAssignments.length, 2);
  assert.strictEqual(ifElseParsed.variableAssignments[0].branchGroupId, ifElseParsed.variableAssignments[1].branchGroupId);
  assert.notStrictEqual(ifElseParsed.variableAssignments[0].branchId, ifElseParsed.variableAssignments[1].branchId);

  const ifElseHover = extensionTestApi.createVariableValueHover(
    ifElseDocument,
    ifElseParsed,
    {
      line: 7,
      character: ifElseDocument.lineAt(7).text.indexOf("${pdfContent}") + 3
    }
  );
  assert(ifElseHover, "expected hover for conditional local variable");
  assert.match(ifElseHover.contents[0].value, /\*\*Current value \(conditional\):\*\*/);
  assert.match(ifElseHover.contents[0].value, /`PDF_READY`/);
  assert.match(ifElseHover.contents[0].value, /`\$\{None\}`/);
  assert.doesNotMatch(ifElseHover.contents[0].value, /Current value \(resolved\)/);

  const conditionalCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${pdfContent}",
      valueStart: 0
    },
    ifElseParsed,
    7
  );
  assert.strictEqual(conditionalCurrentValue.kind, "conditional");
  assert.deepStrictEqual(
    conditionalCurrentValue.candidates.map((candidate) => candidate.value),
    ["PDF_READY", "${None}"]
  );

  const conditionalMarkdown = extensionTestApi.buildEnumPreviewMarkdown({
    argumentName: "pdfContent",
    argumentValue: "${pdfContent}",
    currentValueKind: conditionalCurrentValue.kind,
    currentValueCandidates: conditionalCurrentValue.candidates,
    currentValue: "",
    currentValueSource: "",
    shownEnums: [],
    annotationHints: [],
    documentUri: ifElseDocument.uri.toString(),
    showArgumentAssignment: true,
    showResolvedCurrentValue: true
  });
  assert.match(conditionalMarkdown, /Current value \(conditional\):/);
  assert.match(conditionalMarkdown, /`PDF_READY`/);
  assert.match(conditionalMarkdown, /`\$\{None\}`/);
  assert.doesNotMatch(conditionalMarkdown, /Resolved current value:/);

  const partialBranchDocument = createMockRobotDocument(`
*** Test Cases ***
Case Conditional Partial Branch
    \${statusValue}=    Set Variable    BASE
    IF    \${flag}
        \${statusValue}=    Set Variable    BRANCH
    END
    Keyword Under Test    status=\${statusValue}
`);
  const partialBranchParsed = parser.parse(partialBranchDocument);
  const partialBranchCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${statusValue}",
      valueStart: "    Keyword Under Test    status=".length
    },
    partialBranchParsed,
    7
  );
  assert.strictEqual(partialBranchCurrentValue.kind, "conditional");
  assert.deepStrictEqual(
    partialBranchCurrentValue.candidates.map((candidate) => candidate.value),
    ["BASE", "BRANCH"]
  );

  const keywordBranchDocument = createMockRobotDocument(`
*** Test Cases ***
Case Conditional Keyword Branch
    IF    \${checkPdf}
        \${pdfContent}=    MTEXT PDF Lesen Von TrackingId
        ...    trackingId=\${trackingId}
    ELSE
        \${pdfContent}=    Set Variable    \${None}
    END
    Keyword Under Test    pdfInhalt=\${pdfContent}
`);
  const keywordBranchParsed = parser.parse(keywordBranchDocument);
  const keywordBranchCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${pdfContent}",
      valueStart: "    Keyword Under Test    pdfInhalt=".length
    },
    keywordBranchParsed,
    8
  );
  assert.strictEqual(keywordBranchCurrentValue.kind, "conditional");
  assert.deepStrictEqual(
    keywordBranchCurrentValue.candidates.map((candidate) => candidate.value),
    ["Return from MTEXT PDF Lesen Von TrackingId", "${None}"]
  );

  const keywordBranchMarkdown = extensionTestApi.buildEnumPreviewMarkdown({
    argumentName: "pdfInhalt",
    argumentValue: "${pdfContent}",
    currentValueKind: keywordBranchCurrentValue.kind,
    currentValueCandidates: keywordBranchCurrentValue.candidates,
    currentValue: "",
    currentValueSource: "",
    shownEnums: [],
    annotationHints: [],
    documentUri: keywordBranchDocument.uri.toString(),
    showArgumentAssignment: true,
    showResolvedCurrentValue: true
  });
  assert.match(keywordBranchMarkdown, /Current value \(conditional\):/);
  assert.match(keywordBranchMarkdown, /Return from MTEXT PDF Lesen Von TrackingId/);
  assert.match(keywordBranchMarkdown, /`\$\{None\}`/);

  const elseIfDocument = createMockRobotDocument(`
*** Test Cases ***
Case Else If
    IF    \${mode} == 1
        \${branchValue}=    Set Variable    ALPHA
    ELSE IF    \${mode} == 2
        \${branchValue}=    Set Variable    BETA
    ELSE
        \${branchValue}=    Set Variable    GAMMA
    END
    Log    \${branchValue}
`);
  const elseIfParsed = parser.parse(elseIfDocument);
  const elseIfCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${branchValue}",
      valueStart: 0
    },
    elseIfParsed,
    9
  );
  assert.strictEqual(elseIfCurrentValue.kind, "conditional");
  assert.deepStrictEqual(
    elseIfCurrentValue.candidates.map((candidate) => candidate.value),
    ["ALPHA", "BETA", "GAMMA"]
  );

  const nestedDocument = createMockRobotDocument(`
*** Test Cases ***
Case Nested Conditional
    IF    \${outer}
        IF    \${inner}
            \${nestedValue}=    Set Variable    FIRST
        ELSE
            \${nestedValue}=    Set Variable    SECOND
        END
    ELSE
        \${nestedValue}=    Set Variable    THIRD
    END
    Log    \${nestedValue}
`);
  const nestedParsed = parser.parse(nestedDocument);
  const nestedCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${nestedValue}",
      valueStart: 0
    },
    nestedParsed,
    11
  );
  assert.strictEqual(nestedCurrentValue.kind, "conditional");
  assert.deepStrictEqual(
    nestedCurrentValue.candidates.map((candidate) => candidate.value),
    ["FIRST", "SECOND", "THIRD"]
  );

  const overwriteDocument = createMockRobotDocument(`
*** Test Cases ***
Case Conditional Overwrite
    IF    \${flag}
        \${finalValue}=    Set Variable    BEFORE
    ELSE
        \${finalValue}=    Set Variable    \${None}
    END
    \${finalValue}=    Set Variable    AFTER
    Log    \${finalValue}
`);
  const overwriteParsed = parser.parse(overwriteDocument);
  const overwriteHover = extensionTestApi.createVariableValueHover(
    overwriteDocument,
    overwriteParsed,
    {
      line: 8,
      character: overwriteDocument.lineAt(8).text.indexOf("${finalValue}") + 3
    }
  );
  assert(overwriteHover, "expected hover for overwritten variable");
  assert.match(overwriteHover.contents[0].value, /Current value \(resolved\)/);
  assert.match(overwriteHover.contents[0].value, /`AFTER`/);
  assert.doesNotMatch(overwriteHover.contents[0].value, /Current value \(conditional\)/);
}

function runRobot7VarAssignmentHoverTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Var Assignment
    VAR    \${plainDate}    2022-01-01
    VAR    \${typedDate: date}    2022-01-02
    \${typedFromSet: date}=    Set Variable    2022-01-03
    Log    \${plainDate}
    Log    \${typedDate}
    Log    \${typedFromSet}
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  assert.deepStrictEqual(
    parsed.variableAssignments.map((assignment) => ({
      variableToken: assignment.variableToken,
      normalizedVariable: assignment.normalizedVariable,
      sourceLabel: assignment.sourceLabel,
      startLine: assignment.startLine
    })),
    [
      {
        variableToken: "${plainDate}",
        normalizedVariable: extensionTestApi.normalizeVariableLookupToken("${plainDate}"),
        sourceLabel: "VAR",
        startLine: 2
      },
      {
        variableToken: "${typedDate: date}",
        normalizedVariable: extensionTestApi.normalizeVariableLookupToken("${typedDate}"),
        sourceLabel: "VAR",
        startLine: 3
      },
      {
        variableToken: "${typedFromSet: date}",
        normalizedVariable: extensionTestApi.normalizeVariableLookupToken("${typedFromSet}"),
        sourceLabel: "Set Variable",
        startLine: 4
      }
    ]
  );

  const typedVarHover = extensionTestApi.createVariableValueHover(
    document,
    parsed,
    {
      line: 6,
      character: document.lineAt(6).text.indexOf("${typedDate}") + 3
    }
  );
  assert(typedVarHover, "expected hover for Robot 7 typed VAR assignment");
  assert.strictEqual(typedVarHover.contents.length, 1);
  assert.match(typedVarHover.contents[0].value, /2022-01-02/);
  assert.match(typedVarHover.contents[0].value, /\*\*Source:\*\* `VAR` at line 4/);

  const typedSetVariableHover = extensionTestApi.createVariableValueHover(
    document,
    parsed,
    {
      line: 7,
      character: document.lineAt(7).text.indexOf("${typedFromSet}") + 3
    }
  );
  assert(typedSetVariableHover, "expected hover for typed Set Variable assignment");
  assert.strictEqual(typedSetVariableHover.contents.length, 1);
  assert.match(typedSetVariableHover.contents[0].value, /2022-01-03/);
  assert.match(typedSetVariableHover.contents[0].value, /\*\*Source:\*\* `Set Variable` at line 5/);

  const namedArgumentCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${typedDate}",
      valueStart: 0
    },
    parsed,
    6
  );
  assert.strictEqual(namedArgumentCurrentValue.value, "2022-01-02");
  assert.strictEqual(namedArgumentCurrentValue.source, "local-variable");
  assert.strictEqual(namedArgumentCurrentValue.sourceLabel, "VAR");
  assert.strictEqual(namedArgumentCurrentValue.sourceLine, 3);

  const combinedArgumentCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${plainDate}${typedDate}",
      valueStart: 20
    },
    parsed,
    6,
    undefined,
    20 + "${plainDate}".length + 3
  );
  assert.strictEqual(combinedArgumentCurrentValue.value, "2022-01-02");
  assert.strictEqual(combinedArgumentCurrentValue.source, "local-variable");
  assert.strictEqual(combinedArgumentCurrentValue.sourceLabel, "VAR");
  assert.strictEqual(combinedArgumentCurrentValue.sourceLine, 3);

  const prefixedArgumentCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "ErsterTagDesNächstenMonats ${typedDate}",
      valueStart: 28
    },
    parsed,
    6,
    undefined,
    28 + "ErsterTagDesNächstenMonats ".length + 3
  );
  assert.strictEqual(prefixedArgumentCurrentValue.value, "2022-01-02");
  assert.strictEqual(prefixedArgumentCurrentValue.source, "local-variable");
  assert.strictEqual(prefixedArgumentCurrentValue.sourceLabel, "VAR");
  assert.strictEqual(prefixedArgumentCurrentValue.sourceLine, 3);

  const prefixedArgumentFallback = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "ErsterTagDesNächstenMonats ${typedDate}",
      valueStart: 28
    },
    parsed,
    6,
    undefined,
    28 + 5
  );
  assert.strictEqual(prefixedArgumentFallback.value, "ErsterTagDesNächstenMonats ${typedDate}");
  assert.strictEqual(prefixedArgumentFallback.source, "argument");

  const postfixedArgumentCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "${typedDate} letzterTagDesMonats",
      valueStart: 12
    },
    parsed,
    6,
    undefined,
    12 + 3
  );
  assert.strictEqual(postfixedArgumentCurrentValue.value, "2022-01-02");
  assert.strictEqual(postfixedArgumentCurrentValue.source, "local-variable");
  assert.strictEqual(postfixedArgumentCurrentValue.sourceLabel, "VAR");
  assert.strictEqual(postfixedArgumentCurrentValue.sourceLine, 3);

  const surroundedArgumentCurrentValue = extensionTestApi.resolveNamedArgumentCurrentValueFromSetVariable(
    {
      argumentValue: "Start ${typedDate} Ende",
      valueStart: 44
    },
    parsed,
    6,
    undefined,
    44 + "Start ".length + 3
  );
  assert.strictEqual(surroundedArgumentCurrentValue.value, "2022-01-02");
  assert.strictEqual(surroundedArgumentCurrentValue.source, "local-variable");
  assert.strictEqual(surroundedArgumentCurrentValue.sourceLabel, "VAR");
  assert.strictEqual(surroundedArgumentCurrentValue.sourceLine, 3);
}

async function runEmbeddedVariableArgumentPreviewTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Embedded Keyword Return
    ${"${VertragsPrefix}"}=    Set Variable    PREFIX
    ${"${AD}"}=    BAVL Antragsdaten Schreiben In MockDatenbank
    Demo Keyword    value=prefix${"${VertragsPrefix}"}${"${AD.VertragNr}"}postfix
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const argumentValue = `prefix${"${VertragsPrefix}"}${"${AD.VertragNr}"}postfix`;
  const fakeEnumHintService = {
    async getIndexForDocument() {
      return {
        keywordArgs: new Map(),
        keywordArgAnnotations: new Map([
          [
            "demokeyword",
            new Map([
              ["value", ["str"]]
            ])
          ]
        ]),
        enumsByName: new Map()
      };
    }
  };

  const hoveredReturnVariablePreview = await extensionTestApi.resolveEnumValuePreviewFromContext(
    document,
    fakeEnumHintService,
    {
      keywordName: "Demo Keyword",
      argumentName: "value",
      argumentValue,
      valueStart: 0
    },
    {
      parsed,
      referenceLine: 4,
      hoverCharacter: "prefix${VertragsPrefix}".length + 3
    }
  );
  assert(hoveredReturnVariablePreview, "expected argument preview for embedded return variable");
  assert.strictEqual(hoveredReturnVariablePreview.currentValue, "${AD.VertragNr}");
  assert.strictEqual(hoveredReturnVariablePreview.currentValueKind, "fallback");
  assert.strictEqual(hoveredReturnVariablePreview.argumentValue, argumentValue);

  const hoveredReturnVariableMarkdown = extensionTestApi.buildEnumPreviewMarkdown({
    ...hoveredReturnVariablePreview,
    shownEnums: [],
    annotationHints: ["str"],
    documentUri: document.uri.toString(),
    showArgumentAssignment: true,
    showResolvedCurrentValue: true
  });
  assert.match(hoveredReturnVariableMarkdown, /Resolved current value:/);
  assert.match(hoveredReturnVariableMarkdown, /`\$\{AD\.VertragNr\}`/);
  assert.match(
    hoveredReturnVariableMarkdown,
    /from `prefix\$\{VertragsPrefix\}\$\{AD\.VertragNr\}postfix`/
  );

  const hoveredSetVariablePreview = await extensionTestApi.resolveEnumValuePreviewFromContext(
    document,
    fakeEnumHintService,
    {
      keywordName: "Demo Keyword",
      argumentName: "value",
      argumentValue,
      valueStart: 0
    },
    {
      parsed,
      referenceLine: 4,
      hoverCharacter: "prefix".length + 3
    }
  );
  assert(hoveredSetVariablePreview, "expected argument preview for embedded set variable");
  assert.strictEqual(hoveredSetVariablePreview.currentValue, "PREFIX");
  assert.strictEqual(hoveredSetVariablePreview.currentValueKind, "single");
}

function runDocumentationFoldingTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Headings
    #> ## Start
    #> intro
    Log    top one
    #> ### Child
    #> child text
    Log    child one
    #> ## Next
    #> next text
Case PlainInline
    #> first line
    #> second line
    Log    gap
Case Classic
    [Documentation]    ## Intro
    ...    intro text
    ...    ### Deep
    ...    deep text
    ...    ## Next
    ...    next text
    Log    classic action
Case MixedContiguous
    [Documentation]    ## Parent
    ...    parent text
    #> ### Child
    #> child text
    Log    child action
Case HeadingThenPlainMarker
    #> ### Testdaten anlegen
    Log    prep one
    #> 1. Antragsdaten in MockDatenbank schreiben
    Log    prep two
    #> ### Leistung Einweisen und Nachtverarbeitung starten
    Log    step two
Case PlainClassic
    [Documentation]    line one
    ...    line two
    Log    classic action
Case MarkerDepthHierarchy
    #> - first level
    #>> - child level
    Log    nested body
    
    #> - next first level
    Log    sibling body
Case MarkerDepthHierarchyNoGap
    #> - first level
    \${LeistungsfallId}=    BAVL LeistungsfallId zur Vertragsnummer Ermitteln
    ...    vertragsnummer=\${AD.VertragNr}
    #>> - child level
    BAVL KVDR_MELDUNG_ZS Eintrag Prüfen - DatenbankAufruf
    ...    leistungsfallId=\${LeistungsfallId}
    #> - next first level
    BAVL ZMV_CONNECT_VERSORGUNGSBEZUG Prüfen - DatenbankAufruf
    ...    kvdrMeldungZahlstelleId=\${None}
Case LastHeadingWithNestedChild
    #> ### Testablauf
    Log    one
    #> ### Letzte Section
    #>> - child
    Log    two
    Log    three
Case HeadingWithPlainPeersAndNestedChild
    #> ## Testablauf
    Log    heading intro
    #> ### tetes
    Log    heading detail
    #> - first level
    Log    first body
    #>> - child level
    Log    child body
    #> - next first level
    Log    next body
    #> - Prüfen der DPRS-Auftragsdatei
    Log    last body
Case NoFold
    # comment only
    Log    noop
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  const classicEntries = parsed.blocks.find((block) => block.ownerName === "Case Classic").fragments[0].lineEntries;
  assert.deepStrictEqual(
    classicEntries.map((entry) => ({
      sourceLine: entry.sourceLine,
      headingLevel: entry.headingLevel
    })),
    [
      { sourceLine: 15, headingLevel: 2 },
      { sourceLine: 16, headingLevel: 0 },
      { sourceLine: 17, headingLevel: 3 },
      { sourceLine: 18, headingLevel: 0 },
      { sourceLine: 19, headingLevel: 2 },
      { sourceLine: 20, headingLevel: 0 }
    ]
  );

  const markerDepthEntries = parsed.blocks.find((block) => block.ownerName === "Case MarkerDepthHierarchy").fragments[0]
    .lineEntries;
  assert.deepStrictEqual(
    markerDepthEntries.map((entry) => ({
      sourceLine: entry.sourceLine,
      nestingLevel: entry.nestingLevel
    })),
    [
      { sourceLine: 40, nestingLevel: 0 },
      { sourceLine: 41, nestingLevel: 1 }
    ]
  );

  const foldingRanges = extensionTestApi.buildDocumentationFoldingRanges(parsed.blocks);
  assert.deepStrictEqual(foldingRanges, [
    { startLine: 2, endLine: 4 },
    { startLine: 5, endLine: 7 },
    { startLine: 8, endLine: 9 },
    { startLine: 11, endLine: 13 },
    { startLine: 15, endLine: 16 },
    { startLine: 17, endLine: 18 },
    { startLine: 19, endLine: 21 },
    { startLine: 23, endLine: 24 },
    { startLine: 25, endLine: 27 },
    { startLine: 29, endLine: 32 },
    { startLine: 31, endLine: 32 },
    { startLine: 33, endLine: 34 },
    { startLine: 36, endLine: 38 },
    { startLine: 40, endLine: 43 },
    { startLine: 41, endLine: 42 },
    { startLine: 44, endLine: 45 },
    { startLine: 47, endLine: 52 },
    { startLine: 50, endLine: 51 },
    { startLine: 53, endLine: 55 },
    { startLine: 57, endLine: 58 },
    { startLine: 59, endLine: 62 },
    { startLine: 60, endLine: 62 },
    { startLine: 64, endLine: 65 },
    { startLine: 66, endLine: 75 },
    { startLine: 68, endLine: 71 },
    { startLine: 70, endLine: 71 },
    { startLine: 72, endLine: 73 },
    { startLine: 74, endLine: 75 }
  ]);
  assert.ok(
    foldingRanges.some((range) => range.startLine === 47 && range.endLine === 52),
    "top-level inline fold should remain available even when a nested child shares the section"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 50 && range.endLine === 51),
    "nested #>> child should fold independently before the next top-level peer"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 59 && range.endLine === 62),
    "last heading should fold to the end of the owner"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 64 && range.endLine === 65),
    "top headings should flatten into a single heading tier and close at the next heading"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 60 && range.endLine === 62),
    "nested child under the last heading should still get its own fold"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 68 && range.endLine === 71),
    "first-level plain peers under a heading should still get their own fold markers"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 70 && range.endLine === 71),
    "nested children should survive normalization even when they close on the same line as their parent"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 31 && range.endLine === 32),
    "single-body first-level markers under a heading should still keep a fold marker"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 74 && range.endLine === 75),
    "the final first-level peer in a heading-owned section should still fold to the owner end"
  );
  assert.ok(
    foldingRanges.some((range) => range.startLine === 66 && range.endLine === 75),
    "the last nested heading should still keep a visible fold marker even when it ends near the owner boundary"
  );
}

function runDocumentationBodyFoldingTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case TieredInlineDocs
    #> ### Headline
    Log    heading intro
    # comment hidden under headline
    #> - first level
    Log    first body one
    Log    first body two
    #>> - second level
    Log    second body one
    Log    second body two
    #> plain overview note
    Log    top body one
    # regular hidden line
Case TieredClassicDoc
    [Documentation]    Classic summary
    ...    Classic details
    Log    classic body one
    Log    classic body two
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  const headlineRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 1);
  assert.deepStrictEqual(headlineRanges, [
    { startLine: 2, endLine: 13 },
    { startLine: 15, endLine: 19 }
  ]);

  const firstLevelRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 2);
  assert.deepStrictEqual(firstLevelRanges, [
    { startLine: 5, endLine: 10 },
    { startLine: 11, endLine: 13 }
  ]);

  const secondLevelRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 3);
  assert.deepStrictEqual(secondLevelRanges, [{ startLine: 8, endLine: 9 }]);

  const stepRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 4);
  assert.deepStrictEqual(stepRanges, [
    { startLine: 5, endLine: 10 },
    { startLine: 8, endLine: 9 },
    { startLine: 11, endLine: 13 }
  ]);

  assert.deepStrictEqual(
    extensionTestApi.buildDocumentationOverviewRanges(parsed.blocks),
    [
      { startLine: 2, endLine: 13 },
      { startLine: 5, endLine: 10 },
      { startLine: 8, endLine: 9 },
      { startLine: 11, endLine: 13 },
      { startLine: 15, endLine: 19 }
    ],
    "overview compatibility should still expose every body fold marker"
  );
}

function runKeywordDocumentationBodyFoldingTests() {
  const document = createMockRobotDocument(`
*** Keywords ***
Keyword TieredInlineDocs
    #> ### Headline
    Log    heading intro
    # comment hidden under headline
    #> - first level
    Log    first body one
    Log    first body two
    #>> - second level
    Log    second body one
    Log    second body two
    #> plain overview note
    Log    top body one
    # regular hidden line
Keyword TieredClassicDoc
    [Documentation]    Classic summary
    ...    Classic details
    Log    classic body one
    Log    classic body two
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  const headlineRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 1);
  assert.deepStrictEqual(headlineRanges, [
    { startLine: 2, endLine: 13 },
    { startLine: 15, endLine: 19 }
  ]);

  const firstLevelRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 2);
  assert.deepStrictEqual(firstLevelRanges, [
    { startLine: 5, endLine: 10 },
    { startLine: 11, endLine: 13 }
  ]);

  const secondLevelRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 3);
  assert.deepStrictEqual(secondLevelRanges, [{ startLine: 8, endLine: 9 }]);

  const stepRanges = extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 4);
  assert.deepStrictEqual(stepRanges, [
    { startLine: 5, endLine: 10 },
    { startLine: 8, endLine: 9 },
    { startLine: 11, endLine: 13 }
  ]);
}

function runDocumentationPreviewActionLinkTests() {
  const documentUri = "file:///tmp/folding.robot";
  const encodedArgs = encodeURIComponent(JSON.stringify([documentUri]));
  const blockId = "10:Case Export";
  const encodedBlockArgs = encodeURIComponent(JSON.stringify([documentUri, blockId]));
  const previewActions = extensionTestApi.buildDocumentationPreviewActionsHtml(documentUri, blockId);
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.foldDocumentationToHeadlines\\?${encodedArgs}`));
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.foldDocumentationToSteps\\?${encodedArgs}`));
  assert.match(
    previewActions,
    new RegExp(`command:robotCompanion\\.exportDocumentationMarkdown\\?${escapeRegExp(encodedBlockArgs)}`)
  );
  assert.match(
    previewActions,
    new RegExp(`command:robotCompanion\\.exportDocumentationPdf\\?${escapeRegExp(encodedBlockArgs)}`)
  );
  assert.match(
    previewActions,
    new RegExp(`command:robotCompanion\\.exportDocumentationSelectedMarkdown\\?${encodedArgs}`)
  );
  assert.match(
    previewActions,
    new RegExp(`command:robotCompanion\\.exportDocumentationSelectedPdf\\?${encodedArgs}`)
  );
  assert.match(previewActions, />Headlines</);
  assert.match(previewActions, />Steps</);
  assert.match(previewActions, /Export:/);
  assert.match(previewActions, />Current MD</);
  assert.match(previewActions, />Current PDF</);
  assert.match(previewActions, />Selected MD</);
  assert.match(previewActions, />Selected PDF</);
  assert.doesNotMatch(previewActions, /Show Returned Variables/);
  assert.doesNotMatch(previewActions, /data-preview-toggle-target=\"returned-variables\"/);
  assert.doesNotMatch(previewActions, /foldDocumentationToFirstLevel/);
  assert.doesNotMatch(previewActions, /foldDocumentationToSecondLevel/);
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.unfoldDocumentation\\?${encodedArgs}`));
  assert.strictEqual(extensionTestApi.buildDocumentationPreviewActionsHtml(""), "");
}

async function runDocumentationExportTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Export
    [Documentation]    Intro uses \${localValue}
    \${localValue}=    Set Variable    42
    \${returnedValue}=    Keyword Alpha
    #> ## Flow
    #> - Uses \${localValue}
    #>> -> Expected return \${returnedValue}
Case Second Export
    [Documentation]    Second body
    \${secondLocal}=    Set Variable    two
    \${secondReturned}=    Keyword Beta
*** Keywords ***
Helper Keyword
    [Documentation]    Keyword body
    No Operation
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);
  const block = parsed.blocks[0];
  const secondBlock = parsed.blocks.find((candidate) => candidate.ownerName === "Case Second Export");
  const keywordBlock = parsed.blocks.find((candidate) => candidate.ownerName === "Helper Keyword");

  const quickPickItems = extensionTestApi.buildDocumentationExportQuickPickItems(parsed.blocks);
  assert.deepStrictEqual(
    quickPickItems.map((item) => item.label),
    ["Case Export", "Case Second Export"]
  );
  assert(quickPickItems.every((item) => item.picked === true));
  assert(!quickPickItems.some((item) => item.blockId === keywordBlock.id));

  const markdown = extensionTestApi.buildDocumentationExportMarkdown(document.uri.toString(), block);
  assert(markdown.startsWith("# Case Export\n\n"));
  assert(markdown.includes("Intro uses 42"));
  assert(markdown.includes("## Flow"));
  assert(markdown.includes("- Uses 42"));
  assert(markdown.includes("## Variables"));
  assert(markdown.includes("- `${localValue}`: 42"));
  assert(!markdown.includes("## Returned Variables"));
  assert(!markdown.includes("- `${returnedValue}`: Return from Keyword Alpha"));
  assert(!markdown.includes("doc-target-marker"));
  assert(!markdown.includes("data-doc-render-targets"));

  const markdownWithReturned = extensionTestApi.buildDocumentationExportMarkdown(document.uri.toString(), block, {
    includeReturnedVariables: true
  });
  assert(markdownWithReturned.includes("## Returned Variables"));
  assert(markdownWithReturned.includes("- `${returnedValue}`: Return from Keyword Alpha"));

  const combinedMarkdown = extensionTestApi.buildDocumentationExportMarkdownForBlocks(
    document.uri.toString(),
    [secondBlock, block],
    {
      includeReturnedVariablesByBlockId: {
        [block.id]: true
      }
    }
  );
  assert(
    combinedMarkdown.indexOf("# Case Second Export") < combinedMarkdown.indexOf("# Case Export"),
    "expected combined Markdown helper to preserve caller-provided block order"
  );
  assert(combinedMarkdown.includes('<div style="page-break-after: always;"></div>'));
  assert(combinedMarkdown.includes("- `${returnedValue}`: Return from Keyword Alpha"));
  assert(!combinedMarkdown.includes("- `${secondReturned}`: Return from Keyword Beta"));

  const renderedHtml = await extensionTestApi.renderDocumentationBlockHtml(document.uri.toString(), block, {
    includeReturnedVariables: true,
    returnedVariablesVisible: true,
    returnedVariablesToggleEnabled: false
  });
  const pageHtml = extensionTestApi.buildDocumentationPdfExportPageHtml("Case Export", renderedHtml, 0);
  const pdfHtml = extensionTestApi.buildDocumentationPdfExportHtml(document, {
    title: "Case Export",
    bodyHtml: pageHtml
  });
  assert(pdfHtml.includes("<title>Case Export</title>"));
  assert(pdfHtml.includes("Open in Browser / Save as PDF"));
  assert(pdfHtml.includes("openDocumentationPdfInBrowser"));
  assert(pdfHtml.includes("Try VS Code Print"));
  assert(pdfHtml.includes("Intro uses 42"));
  assert(pdfHtml.includes("Returned Variables"));
  assert(pdfHtml.includes(".preview [hidden]"));
  assert(pdfHtml.includes("display: block !important"));
  assert(!pdfHtml.includes("[[RDP_INDENT_"));

  const selectedPagesHtml = await extensionTestApi.buildDocumentationPdfExportPagesHtml(
    document.uri.toString(),
    [block, secondBlock],
    {
      includeReturnedVariablesByBlockId: {
        [secondBlock.id]: true
      }
    }
  );
  assert.strictEqual((selectedPagesHtml.match(/class="documentation-export-page/g) || []).length, 2);
  assert(selectedPagesHtml.includes('class="documentation-export-page documentation-export-page-break"'));
  assert(selectedPagesHtml.includes("Case Export"));
  assert(selectedPagesHtml.includes("Case Second Export"));
  assert(!selectedPagesHtml.includes("Return from Keyword Alpha"));
  assert(selectedPagesHtml.includes("Return from Keyword Beta"));

  const selectedPdfHtml = extensionTestApi.buildDocumentationPdfExportHtml(document, {
    title: "Selected Export",
    bodyHtml: selectedPagesHtml
  });
  assert(selectedPdfHtml.includes("page-break-before: always"));
  assert(selectedPdfHtml.includes("break-before: page"));
  assert(selectedPdfHtml.includes("Open in Browser / Save as PDF"));
  assert(selectedPdfHtml.includes("openDocumentationPdfInBrowser"));

  const browserPdfHtml = extensionTestApi.buildDocumentationPdfExportHtml(document, {
    title: "Selected Export",
    bodyHtml: selectedPagesHtml,
    browserMode: true,
    autoPrint: true
  });
  assert(browserPdfHtml.includes("Print / Save as PDF"));
  assert(browserPdfHtml.includes("window.print()"));
  assert(!browserPdfHtml.includes("Try VS Code Print"));
}

function runKeywordDocArgumentInsertLinkTests() {
  const markdown = extensionTestApi.buildKeywordDocPreviewMarkdown({
    documentUri: "file:///tmp/keyword_insert.robot",
    keywordToken: {
      line: 12,
      start: 4,
      keywordName: "Demo Keyword"
    },
    callHeaderIndent: "    ",
    callArgumentNavigationMap: new Map([
      [
        "first",
        {
          argumentName: "first",
          line: 12,
          character: 17,
          argumentValue: "1"
        }
      ],
      [
        "third",
        {
          argumentName: "third",
          line: 13,
          character: 7,
          argumentValue: "3"
        }
      ]
    ]),
    primaryCandidate: {
      normalizedDocstring: `
### Args

- \`first\`: First value
- \`second\`: Second value
- \`third\`: Third value
`.trim(),
      rawDocstring: "",
      docWarnings: []
    },
    candidates: [],
    additionalWarnings: []
  });

  assert.match(markdown, /Use \*\*Insert\*\* for missing named arguments/);
  assert.match(markdown, /data-source-command="command:robotCompanion\.openLocation\?/);
  assert.match(markdown, /data-source-command="command:robotCompanion\.insertKeywordArgument\?/);
  assert.match(markdown, /data-managed-keyword-doc-command="true"/);
  assert.match(markdown, /href="#"/);
  const markdownLines = markdown.split(/\r?\n/);
  const firstLine = markdownLines.find((line) => /^\s*-\s+<a\b/.test(line) && line.includes("<code>first</code>"));
  const secondLine = markdownLines.find((line) => /^\s*-\s+<a\b/.test(line) && line.includes("<code>second</code>"));
  const thirdLine = markdownLines.find((line) => /^\s*-\s+<a\b/.test(line) && line.includes("<code>third</code>"));
  assert(firstLine, "Expected rendered markdown to include the first argument line.");
  assert(secondLine, "Expected rendered markdown to include the second argument line.");
  assert(thirdLine, "Expected rendered markdown to include the third argument line.");
  assert(firstLine.includes('class="doc-keyword-argument-link"'));
  assert(!firstLine.includes('doc-keyword-argument-insert-link'));
  assert(secondLine.includes('class="doc-keyword-argument-link"'));
  assert(secondLine.includes('class="doc-keyword-argument-insert-link"'));
  assert(thirdLine.includes('class="doc-keyword-argument-link"'));
  assert(!thirdLine.includes('doc-keyword-argument-insert-link'));

  const [insertPayload] = parseCommandUriFromMarkdown(markdown, "robotCompanion.insertKeywordArgument");
  assert.strictEqual(insertPayload.documentUri, "file:///tmp/keyword_insert.robot");
  assert.strictEqual(insertPayload.keywordLine, 12);
  assert.strictEqual(insertPayload.keywordCharacter, 4);
  assert.strictEqual(insertPayload.keywordName, "Demo Keyword");
  assert.strictEqual(insertPayload.argumentName, "second");
  assert.deepStrictEqual(insertPayload.documentedArgumentNames, ["first", "second", "third"]);
  assert.strictEqual(insertPayload.headerIndent, "    ");

  const extractManagedInvocations = (line) =>
    Array.from(String(line || "").matchAll(/data-source-command="([^"]+)"/g))
      .map((match) => extensionTestApi.parseManagedCommandUriInvocation(String(match[1] || "")))
      .filter(Boolean);

  const parsedInsertInvocation = extractManagedInvocations(secondLine).find(
    (invocation) => invocation.commandId === "robotCompanion.insertKeywordArgument"
  );
  assert(parsedInsertInvocation, "Expected managed command parser to understand Insert links.");
  assert.strictEqual(parsedInsertInvocation.commandId, "robotCompanion.insertKeywordArgument");
  assert.strictEqual(parsedInsertInvocation.args[0].argumentName, "second");

  const parsedPreviewInvocation = extractManagedInvocations(firstLine).find(
    (invocation) => invocation.commandId === "robotCompanion.openLocation"
  );
  assert(parsedPreviewInvocation, "Expected managed command parser to understand preview links.");
  assert.strictEqual(parsedPreviewInvocation.commandId, "robotCompanion.openLocation");
  assert.strictEqual(parsedPreviewInvocation.args[0], "file:///tmp/keyword_insert.robot");
}

function runKeywordArgumentInsertPlanTests() {
  const multilineDocument = createMockRobotDocument(`
*** Test Cases ***
Case Insert Before Later Continuation Arg
    Demo Keyword    first=1
    ...    third=3
    ...    fourth=4
`);
  const multilinePlan = extensionTestApi.buildKeywordArgumentInsertPlan(multilineDocument, {
    keywordLine: 2,
    argumentName: "second",
    documentedArgumentNames: ["first", "second", "third", "fourth"]
  });
  assert(multilinePlan);
  assert.strictEqual(multilinePlan.kind, "insertBeforeLine");
  assert.strictEqual(multilinePlan.beforeLine, 3);
  assert.strictEqual(multilinePlan.insertLine, 3);
  assert.strictEqual(multilinePlan.insertLineText, "    ...    second=");

  const mixedDocument = createMockRobotDocument(`
*** Test Cases ***
Case Insert After Header
    Demo Keyword    first=1    third=3
    ...    fourth=4
`);
  const mixedPlan = extensionTestApi.buildKeywordArgumentInsertPlan(mixedDocument, {
    keywordLine: 2,
    argumentName: "second",
    documentedArgumentNames: ["first", "second", "third", "fourth"]
  });
  assert(mixedPlan);
  assert.strictEqual(mixedPlan.kind, "insertBeforeLine");
  assert.strictEqual(mixedPlan.beforeLine, 3);
  assert.strictEqual(mixedPlan.insertLineText, "    ...    second=");

  const existingDocument = createMockRobotDocument(`
*** Test Cases ***
Case Existing Named Arg
    Demo Keyword    first=1
    ...    second=2
`);
  const existingPlan = extensionTestApi.buildKeywordArgumentInsertPlan(existingDocument, {
    keywordLine: 2,
    argumentName: "second",
    documentedArgumentNames: ["first", "second", "third"]
  });
  assert(existingPlan);
  assert.strictEqual(existingPlan.kind, "existing");
  assert.strictEqual(existingPlan.existingTarget.line, 3);

  const appendDocument = createMockRobotDocument(`
*** Test Cases ***
Case Append At End
    Demo Keyword    first=1
    ...    second=2
`);
  const appendPlan = extensionTestApi.buildKeywordArgumentInsertPlan(appendDocument, {
    keywordLine: 2,
    argumentName: "third",
    documentedArgumentNames: []
  });
  assert(appendPlan);
  assert.strictEqual(appendPlan.kind, "appendAfterCallEnd");
  assert.strictEqual(appendPlan.insertAfterLine, 3);
  assert.strictEqual(appendPlan.insertLine, 4);
  assert.strictEqual(appendPlan.insertLineText, "    ...    third=");
}

function runHeadlineTailRangeTests() {
  const document = createMockRobotDocument(`
*** Test Cases ***
Case Tail Before Next Owner
    #> ### First visible heading
    Log    alpha one
    #> ### Final heading before next testcase
    Log    omega one
    Log    omega two
Case Following Owner
    Log    following body
`);
  const parser = new extensionTestApi.RobotDocumentationService();
  const parsed = parser.parse(document);

  assert.deepStrictEqual(extensionTestApi.buildDocumentationBodyFoldingRanges(parsed.blocks, 1), [
    { startLine: 2, endLine: 3 },
    { startLine: 4, endLine: 6 }
  ]);
}

function runDebugPausePolicyTests() {
  extensionTestApi.setRobotDebugPausedForTest(true);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionInteractiveUiForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionEditorManipulationForDebug(), true);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionKeywordArgumentInsertForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionPassiveEditorFeaturesForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionPrewarmForDebug(), true);

  extensionTestApi.setRobotDebugPausedForTest(false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionInteractiveUiForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionEditorManipulationForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionKeywordArgumentInsertForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionPassiveEditorFeaturesForDebug(), false);
  assert.strictEqual(extensionTestApi.shouldPauseRobotCompanionPrewarmForDebug(), false);
}

function runConvertUmlautKeywordArgumentIndexingTests() {
  const decorationSource = `
_exclude_umlaut_kwargs = [
    "steuer",
    "manuell",
    "value",
    "request",
]

def convert_umlaut_kwargs(exclude=None):
    pass
`;
  const parsedConfig = extensionTestApi.parseConvertUmlautDecoratorConfigFromPythonSource(
    decorationSource,
    "/workspace/Common/Libs/common/decoration.py"
  );
  assert(parsedConfig, "Expected convert_umlaut decorator config to be parsed from source.");
  assert.deepStrictEqual(parsedConfig.defaultExcludeKeys, ["steuer", "manuell", "value", "request"]);

  const keywordSource = `
from Common.Libs.common.decoration import convert_umlaut_kwargs, keyword

@keyword("Demo Keyword")
@convert_umlaut_kwargs()
def demo_keyword(
    kennzeichenBeitragsabfuehrungspflicht: str,
    steuer: str,
    UebergabeInfo: str,
    value: str,
):
    """
    Args:
        kennzeichenBeitragsabfuehrungspflicht (str): Beschreibt die Beitragspflicht.
        steuer (str): Sollte wegen der Exclusion ascii bleiben.
        UebergabeInfo (str): Uppercase Umlaut replacement.
        value (str): Sollte ascii bleiben.
    """
    return None
`;
  const parsedDefinitions = extensionTestApi.parseKeywordEnumHintsFromPythonSource(
    keywordSource,
    "/workspace/BAVL/Keywords/demo_keyword.py"
  );
  assert.strictEqual(parsedDefinitions.length, 1);

  const finalized = extensionTestApi.finalizePythonKeywordDefinitionForIndex(parsedDefinitions[0], {
    defaultExcludeKeys: parsedConfig.defaultExcludeKeys
  });
  assert.deepStrictEqual(
    [...finalized.parameters.entries()],
    [
      ["kennzeichenBeitragsabführungspflicht", "str"],
      ["steuer", "str"],
      ["ÜbergabeInfo", "str"],
      ["value", "str"]
    ]
  );
  assert.match(finalized.normalizedDocstring, /`kennzeichenBeitragsabführungspflicht`/);
  assert.match(finalized.normalizedDocstring, /`steuer`/);
  assert.match(finalized.normalizedDocstring, /`ÜbergabeInfo`/);
  assert.match(finalized.normalizedDocstring, /`value`/);

  const previewMarkdown = extensionTestApi.buildKeywordDocPreviewMarkdown({
    documentUri: "file:///tmp/umlaut.robot",
    keywordToken: {
      line: 8,
      start: 4,
      keywordName: "Demo Keyword"
    },
    callHeaderIndent: "    ",
    callArgumentNavigationMap: new Map(),
    primaryCandidate: {
      normalizedDocstring: finalized.normalizedDocstring,
      rawDocstring: finalized.rawDocstring,
      docWarnings: []
    },
    candidates: [],
    additionalWarnings: []
  });
  assert.match(previewMarkdown, /kennzeichenBeitragsabführungspflicht/);
  assert.match(previewMarkdown, /ÜbergabeInfo/);
  assert.match(previewMarkdown, /data-source-command="command:robotCompanion\.insertKeywordArgument\?/);
  assert.match(previewMarkdown, /data-managed-keyword-doc-command="true"/);
  const insertPayloads = parseCommandUriFromMarkdown(previewMarkdown, "robotCompanion.insertKeywordArgument");
  const umlautInsertPayload = insertPayloads.find(
    (payload) => payload.argumentName === "kennzeichenBeitragsabführungspflicht"
  );
  assert(umlautInsertPayload, "Expected insert payload to use the exposed umlaut argument name.");
  assert.deepStrictEqual(umlautInsertPayload.documentedArgumentNames, [
    "kennzeichenBeitragsabführungspflicht",
    "steuer",
    "ÜbergabeInfo",
    "value"
  ]);

  const customExcludeSource = `
from Common.Libs.common.decoration import convert_umlaut_kwargs, keyword

@keyword("Custom Exclude")
@convert_umlaut_kwargs(exclude=("kennzeichenBeitragsabfuehrungspflicht",))
def custom_keyword(kennzeichenBeitragsabfuehrungspflicht: str):
    """
    Args:
        kennzeichenBeitragsabfuehrungspflicht (str): Bleibt ascii.
    """
    return None
`;
  const customDefinition = extensionTestApi.parseKeywordEnumHintsFromPythonSource(
    customExcludeSource,
    "/workspace/BAVL/Keywords/custom_keyword.py"
  )[0];
  const finalizedCustom = extensionTestApi.finalizePythonKeywordDefinitionForIndex(customDefinition, {
    defaultExcludeKeys: parsedConfig.defaultExcludeKeys
  });
  assert.deepStrictEqual([...finalizedCustom.parameters.keys()], ["kennzeichenBeitragsabfuehrungspflicht"]);
  assert.match(finalizedCustom.normalizedDocstring, /`kennzeichenBeitragsabfuehrungspflicht`/);

  const fallbackExcludeSource = `
from Common.Libs.common.decoration import convert_umlaut_kwargs, keyword

@keyword("Dynamic Exclude")
@convert_umlaut_kwargs(exclude=build_excludes())
def dynamic_keyword(steuer: str, kennzeichenBeitragsabfuehrungspflicht: str):
    """
    Args:
        steuer (str): Default exclusion still applies.
        kennzeichenBeitragsabfuehrungspflicht (str): Regular conversion should still happen.
    """
    return None
`;
  const fallbackDefinition = extensionTestApi.parseKeywordEnumHintsFromPythonSource(
    fallbackExcludeSource,
    "/workspace/BAVL/Keywords/dynamic_keyword.py"
  )[0];
  const finalizedFallback = extensionTestApi.finalizePythonKeywordDefinitionForIndex(fallbackDefinition, {
    defaultExcludeKeys: parsedConfig.defaultExcludeKeys
  });
  assert.deepStrictEqual([...finalizedFallback.parameters.keys()], [
    "steuer",
    "kennzeichenBeitragsabführungspflicht"
  ]);
}

function runConvertUmlautNamedArgumentLookupTests() {
  const asciiDocument = createMockRobotDocument(`
*** Test Cases ***
Case Umlauts Still Match
    Demo Keyword    kennzeichenBeitragsabfuehrungspflicht=ja
`);
  const existingPlan = extensionTestApi.buildKeywordArgumentInsertPlan(asciiDocument, {
    keywordLine: 2,
    argumentName: "kennzeichenBeitragsabführungspflicht",
    documentedArgumentNames: ["kennzeichenBeitragsabführungspflicht"]
  });
  assert(existingPlan);
  assert.strictEqual(existingPlan.kind, "existing");
  assert.strictEqual(existingPlan.existingTarget.argumentName, "kennzeichenBeitragsabfuehrungspflicht");

  const umlautDocument = createMockRobotDocument(`
*** Test Cases ***
Case Umlaute Can Insert
    Demo Keyword
`);
  const insertPlan = extensionTestApi.buildKeywordArgumentInsertPlan(umlautDocument, {
    keywordLine: 2,
    argumentName: "kennzeichenBeitragsabführungspflicht",
    documentedArgumentNames: ["kennzeichenBeitragsabführungspflicht"]
  });
  assert(insertPlan);
  assert.strictEqual(insertPlan.kind, "appendAfterCallEnd");
  assert.strictEqual(insertPlan.insertLineText, "    ...    kennzeichenBeitragsabführungspflicht=");
}

async function main() {
  runPythonCamelCaseDetectionTests();
  runPythonPropertyParsingTests();
  runPythonPropertyAliasParsingTests();
  runReturnFieldNameStyleTests();
  runPropertyInclusionTests();
  runCompletionMatchingTests();
  runSecondLevelPreviewRenderingTests();
  await runInlineDocumentationTests();
  await runIndentedInlineDocumentationTests();
  runRenderedArrowIndentHtmlTransformTests();
  await runInlineArrowContinuationRenderingTests();
  runDocumentationPreviewManagedClickBridgeTests();
  await runLargeFixtureRenderTargetTests();
  await runDocumentationVariableSectionRenderTests();
  await runDocumentationLocalVariableSubstitutionTests();
  await runDocumentationColorMarkupTests();
  runConditionalVariableResolutionTests();
  runRobot7VarAssignmentHoverTests();
  await runEmbeddedVariableArgumentPreviewTests();
  runDocumentationFoldingTests();
  runDocumentationBodyFoldingTests();
  runKeywordDocumentationBodyFoldingTests();
  runDocumentationPreviewActionLinkTests();
  await runDocumentationExportTests();
  runKeywordDocArgumentInsertLinkTests();
  runKeywordArgumentInsertPlanTests();
  runHeadlineTailRangeTests();
  runDebugPausePolicyTests();
  runConvertUmlautKeywordArgumentIndexingTests();
  runConvertUmlautNamedArgumentLookupTests();
  console.log("return-field-name-style tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

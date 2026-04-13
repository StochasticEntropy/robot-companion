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
          appendMarkdown() {}
          appendText() {}
        },
        Range: class {},
        Hover: class {},
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
  return {
    uri: {
      toString: () => `file://${filePath}`,
      fsPath: filePath,
      path: filePath
    },
    version: 1,
    getText: () => text
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
  assert(renderedHtml.includes("- first item"));
  assert(renderedHtml.includes("  - second item"));
  assert(renderedHtml.includes("    - third item"));
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

function decodeDocumentationRenderTargets(renderedHtml) {
  const targetMatch = String(renderedHtml || "").match(/data-doc-render-targets="([^"]+)"/);
  assert(targetMatch, "expected rendered documentation HTML to include encoded source targets");
  return JSON.parse(decodeURIComponent(targetMatch[1]));
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
        { line: 311, kind: "heading", labelFragment: "line 312" },
        { line: 333, kind: "arrow-line", labelFragment: "line 334" }
      ]
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
    assert.strictEqual((renderedHtml.match(/class="doc-render-flow"/g) || []).length, 1);
    assert(!renderedHtml.includes("doc-fragment"));
    const decodedTargets = decodeDocumentationRenderTargets(renderedHtml);

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
  }
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
}

function runDocumentationPreviewActionLinkTests() {
  const documentUri = "file:///tmp/folding.robot";
  const encodedArgs = encodeURIComponent(JSON.stringify([documentUri]));
  const previewActions = extensionTestApi.buildDocumentationPreviewActionsHtml(documentUri);
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.foldDocumentationToHeadlines\\?${encodedArgs}`));
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.foldDocumentationToFirstLevel\\?${encodedArgs}`));
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.foldDocumentationToSecondLevel\\?${encodedArgs}`));
  assert.match(previewActions, />Level 3</);
  assert.match(previewActions, />Level 4</);
  assert.match(previewActions, />Level 5</);
  assert.match(previewActions, new RegExp(`command:robotCompanion\\.unfoldDocumentation\\?${encodedArgs}`));
  assert.strictEqual(extensionTestApi.buildDocumentationPreviewActionsHtml(""), "");
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
  await runLargeFixtureRenderTargetTests();
  runDocumentationFoldingTests();
  runDocumentationBodyFoldingTests();
  runKeywordDocumentationBodyFoldingTests();
  runDocumentationPreviewActionLinkTests();
  runHeadlineTailRangeTests();
  console.log("return-field-name-style tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

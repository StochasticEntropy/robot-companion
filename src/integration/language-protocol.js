"use strict";

// LSP 3.17 results to VS Code objects. Backend data is untrusted input: ranges
// are checked, targets must be files on the workspace host, markdown is never
// trusted and only editor commands that reopen suggestions or hints run.
const vscode = require("vscode");

const ALLOWED_ITEM_COMMANDS = new Set(["editor.action.triggerSuggest", "editor.action.triggerParameterHints"]);

function toProtocolRange(range) {
  return { start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character } };
}

function fromProtocolRange(range) {
  const valid = point => point && Number.isSafeInteger(point.line) && point.line >= 0 &&
    Number.isSafeInteger(point.character) && point.character >= 0;
  if (!valid(range?.start) || !valid(range?.end) || range.end.line < range.start.line ||
      (range.end.line === range.start.line && range.end.character < range.start.character)) {
    throw new Error("Backend returned an invalid source range.");
  }
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function fileUri(value, label = "Backend location") {
  const uri = vscode.Uri.parse(String(value ?? ""), true);
  if (uri.scheme !== "file") throw new Error(`${label} must target a file on the workspace host.`);
  return uri;
}

function definitionSourceKind(value) {
  if (value !== undefined && value !== "declaration") {
    throw new Error("Backend definition returned an unsupported source kind.");
  }
  return value;
}

function normalizeDefinitions(result) {
  if (result === null || result === undefined) return [];
  return (Array.isArray(result) ? result : [result]).map(item => {
    const uri = fileUri(item.targetUri || item.uri, "Backend definition");
    const kind = definitionSourceKind(item.sourceKind);
    const source = kind ? { sourceKind: kind } : {};
    if (item.targetUri) return {
      targetUri: uri, targetRange: fromProtocolRange(item.targetRange),
      targetSelectionRange: fromProtocolRange(item.targetSelectionRange),
      originSelectionRange: item.originSelectionRange && fromProtocolRange(item.originSelectionRange), ...source
    };
    return Object.assign(new vscode.Location(uri, fromProtocolRange(item.range)), source);
  });
}

function markdown(value) {
  if (value === null || value === undefined) return undefined;
  const result = new vscode.MarkdownString();
  result.isTrusted = false;
  result.supportHtml = false;
  if (typeof value === "string") result.appendText(value);
  else if (value.kind === "markdown") result.appendMarkdown(String(value.value ?? ""));
  else if (value.kind === "plaintext") result.appendText(String(value.value ?? ""));
  else if (typeof value.language === "string") result.appendCodeblock(String(value.value ?? ""), value.language);
  else return undefined;
  return result.value.trim() ? result : undefined;
}

// Hover contents as plain markdown strings (MarkedString[] and MarkupContent).
function hoverMarkdown(result) {
  if (!result || result.contents === undefined || result.contents === null) return [];
  return (Array.isArray(result.contents) ? result.contents : [result.contents])
    .map(markdown).filter(Boolean).map(item => item.value);
}

function itemCommand(command) {
  return command && ALLOWED_ITEM_COMMANDS.has(command.command)
    ? { title: String(command.title ?? ""), command: command.command } : undefined;
}

function textEdit(edit) {
  return vscode.TextEdit.replace(fromProtocolRange(edit.range), String(edit.newText ?? ""));
}

const COMPLETION_KINDS = Object.freeze(Object.fromEntries(Object.entries(vscode.CompletionItemKind || {})
  .filter(([, value]) => typeof value === "number").map(([, value]) => [value + 1, value])));

function completionItem(item) {
  const label = item.labelDetails ? { label: String(item.label), detail: item.labelDetails.detail,
    description: item.labelDetails.description } : String(item.label);
  const result = new vscode.CompletionItem(label, COMPLETION_KINDS[item.kind]);
  const snippet = item.insertTextFormat === 2;
  const text = item.textEdit ? item.textEdit.newText : item.insertText;
  if (typeof text === "string") result.insertText = snippet ? new vscode.SnippetString(text) : text;
  if (item.textEdit?.range) result.range = fromProtocolRange(item.textEdit.range);
  else if (item.textEdit?.insert && item.textEdit?.replace) {
    result.range = { inserting: fromProtocolRange(item.textEdit.insert), replacing: fromProtocolRange(item.textEdit.replace) };
  }
  if (typeof item.detail === "string") result.detail = item.detail;
  result.documentation = markdown(item.documentation);
  if (typeof item.sortText === "string") result.sortText = item.sortText;
  if (typeof item.filterText === "string") result.filterText = item.filterText;
  if (item.preselect === true) result.preselect = true;
  if (item.deprecated === true || item.tags?.includes(1)) result.tags = [vscode.CompletionItemTag.Deprecated];
  if (Array.isArray(item.additionalTextEdits)) result.additionalTextEdits = item.additionalTextEdits.map(textEdit);
  if (Array.isArray(item.commitCharacters)) result.commitCharacters = item.commitCharacters.map(String);
  result.command = itemCommand(item.command);
  return result;
}

function completionList(result) {
  if (!result) return { items: [], isIncomplete: false };
  const items = Array.isArray(result) ? result : result.items;
  return { items: Array.isArray(items) ? items : [], isIncomplete: result.isIncomplete === true };
}

function signatureHelp(result) {
  if (!result || !Array.isArray(result.signatures) || !result.signatures.length) return undefined;
  const help = new vscode.SignatureHelp();
  help.signatures = result.signatures.map(signature => {
    const information = new vscode.SignatureInformation(String(signature.label ?? ""), markdown(signature.documentation));
    information.parameters = (signature.parameters || []).map(parameter => new vscode.ParameterInformation(
      Array.isArray(parameter.label) ? [Number(parameter.label[0]), Number(parameter.label[1])] : String(parameter.label ?? ""),
      markdown(parameter.documentation)));
    if (Number.isInteger(signature.activeParameter)) information.activeParameter = signature.activeParameter;
    return information;
  });
  help.activeSignature = Number.isInteger(result.activeSignature) ? result.activeSignature : 0;
  help.activeParameter = Number.isInteger(result.activeParameter) ? result.activeParameter : 0;
  return help;
}

function locations(result) {
  if (!Array.isArray(result)) return [];
  return result.map(item => new vscode.Location(fileUri(item.uri), fromProtocolRange(item.range)));
}

const SYMBOL_KINDS = Object.freeze(Object.fromEntries(Object.entries(vscode.SymbolKind || {})
  .filter(([, value]) => typeof value === "number").map(([, value]) => [value + 1, value])));

function documentSymbol(item) {
  const range = fromProtocolRange(item.range);
  let selection = item.selectionRange ? fromProtocolRange(item.selectionRange) : range;
  if (!range.contains(selection)) selection = range; // VS Code rejects the whole outline otherwise.
  const symbol = new vscode.DocumentSymbol(String(item.name ?? ""), String(item.detail ?? ""),
    SYMBOL_KINDS[item.kind] ?? vscode.SymbolKind.Null, range, selection);
  symbol.children = Array.isArray(item.children) ? item.children.map(documentSymbol) : [];
  return symbol;
}

function symbolInformation(item) {
  const location = item.location?.range
    ? new vscode.Location(fileUri(item.location.uri), fromProtocolRange(item.location.range))
    : new vscode.Location(fileUri(item.location?.uri), new vscode.Range(0, 0, 0, 0));
  return new vscode.SymbolInformation(String(item.name ?? ""), SYMBOL_KINDS[item.kind] ?? vscode.SymbolKind.Null,
    String(item.containerName ?? ""), location);
}

function documentSymbols(result) {
  if (!Array.isArray(result)) return [];
  return result.map(item => item.location ? symbolInformation(item) : documentSymbol(item));
}

function workspaceSymbols(result) {
  return Array.isArray(result) ? result.map(symbolInformation) : [];
}

// Text edits only, each inside the owning workspace folder. File create,
// rename and delete operations are refused rather than partly applied.
// Used for rename and code action edits.
function workspaceEdit(result, folder) {
  const edit = new vscode.WorkspaceEdit();
  if (!result) return edit;
  const target = value => {
    const uri = fileUri(value, "Backend edit");
    if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
      throw new Error(`The backend edit for ${uri.fsPath} is outside the workspace folder ${folder.name}.`);
    }
    return uri;
  };
  const add = (uri, edits) => { for (const item of edits || []) edit.replace(uri, fromProtocolRange(item.range), String(item.newText ?? "")); };
  if (Array.isArray(result.documentChanges)) {
    for (const change of result.documentChanges) {
      if (change.kind) throw new Error(`Backend edits that ${change.kind} files are not supported.`);
      const uri = target(change.textDocument?.uri), version = change.textDocument?.version;
      const open = Number.isInteger(version) && vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      if (open && open.version !== version) throw new Error(`The backend edit for ${uri.fsPath} was computed for an older version of the file.`);
      add(uri, change.edits);
    }
  } else if (result.changes && typeof result.changes === "object") {
    for (const [uri, edits] of Object.entries(result.changes)) add(target(uri), edits);
  }
  return edit;
}

// Formatting results: TextEdit[] or null (nothing to change).
function textEdits(result) {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) throw new Error("Backend returned invalid text edits.");
  return result.map(textEdit);
}

const SEVERITIES = Object.freeze({ 1: vscode.DiagnosticSeverity?.Error, 2: vscode.DiagnosticSeverity?.Warning,
  3: vscode.DiagnosticSeverity?.Information, 4: vscode.DiagnosticSeverity?.Hint });

// A published diagnostic. Its code is shown in the Problems view; the backend's
// own object is kept by the caller for code action requests.
function diagnostic(item) {
  const result = new vscode.Diagnostic(fromProtocolRange(item.range), String(item.message ?? ""),
    SEVERITIES[item.severity] ?? vscode.DiagnosticSeverity.Error);
  result.source = "Robot Companion";
  if (typeof item.code === "string" || Number.isSafeInteger(item.code)) result.code = item.code;
  return result;
}

function codeActionKind(value) {
  if (typeof value !== "string") throw new Error("Backend returned an invalid code action kind.");
  return value ? vscode.CodeActionKind.Empty.append(value) : vscode.CodeActionKind.Empty;
}

// An LSP CodeAction or Command. `command` translates a backend command into an
// editor command, or undefined when Companion cannot run it; `diagnostic` maps
// the backend's diagnostics to the shown ones. An action left with no edit, no
// edit to resolve and no command does nothing and is omitted.
function codeAction(item, { folder, command, diagnostic: shown, resolvable }) {
  if (!item || typeof item.title !== "string" || !item.title) throw new Error("Backend returned a code action without a title.");
  if (typeof item.command === "string") {
    const translated = command(item);
    if (!translated) return undefined;
    const action = new vscode.CodeAction(item.title);
    action.command = translated;
    return action;
  }
  const action = new vscode.CodeAction(item.title, item.kind === undefined ? undefined : codeActionKind(item.kind));
  if (Array.isArray(item.diagnostics)) action.diagnostics = item.diagnostics.map(shown);
  if (item.isPreferred === true) action.isPreferred = true;
  if (item.disabled) action.disabled = { reason: String(item.disabled.reason ?? "") };
  if (item.edit) action.edit = workspaceEdit(item.edit, folder);
  if (item.command) action.command = command(item.command);
  if (!action.edit && !action.command && !action.disabled && !(resolvable && item.data !== undefined)) return undefined;
  return action;
}

// The backend's semantic tokens legend, in its order: token data indexes into it.
function semanticTokensLegend(options) {
  const names = value => Array.isArray(value) && value.every(item => typeof item === "string" && item) ? value : undefined;
  const types = names(options?.legend?.tokenTypes), modifiers = names(options?.legend?.tokenModifiers);
  if (!types || !types.length || !modifiers || modifiers.length > 32) {
    throw new Error("Backend advertised an invalid semantic tokens legend.");
  }
  return new vscode.SemanticTokensLegend(types, modifiers);
}

// LSP relative token data: five unsigned integers per token (line delta, start
// delta in UTF-16 units, length, type index, modifier bits), the same encoding
// VS Code uses. A type or modifier outside the legend refuses the whole result.
function semanticTokenData(data, legend) {
  if (!(Array.isArray(data) || data instanceof Uint32Array) || data.length % 5 !== 0) {
    throw new Error("Backend returned invalid semantic tokens.");
  }
  const modifierBits = 2 ** legend.tokenModifiers.length;
  for (let index = 0; index < data.length; index += 5) {
    for (let part = index; part < index + 5; part++) {
      if (!Number.isSafeInteger(data[part]) || data[part] < 0 || data[part] > 0xffffffff) {
        throw new Error("Backend returned invalid semantic tokens.");
      }
    }
    if (data[index + 3] >= legend.tokenTypes.length || data[index + 4] >= modifierBits) {
      throw new Error("Backend semantic tokens use a type or modifier outside its legend.");
    }
  }
  return Uint32Array.from(data);
}

const resultId = result => typeof result.resultId === "string" ? result.resultId : undefined;

function semanticTokens(result, legend) {
  if (result === null || result === undefined) return undefined;
  return new vscode.SemanticTokens(semanticTokenData(result.data, legend), resultId(result));
}

// An LSP SemanticTokensDelta applied to `previous`, the data of the result it was
// requested against: edits in ascending order, each relative to `previous`, none
// overlapping another or reaching past its end. The edited data is checked as a
// whole, like a whole-document result, and returned as one.
function editedSemanticTokens(result, previous, legend) {
  if (!result || !Array.isArray(result.edits)) throw new Error("Backend returned invalid semantic token edits.");
  const parts = [];
  let position = 0;
  for (const edit of result.edits) {
    const { start, deleteCount } = edit || {};
    const data = edit?.data ?? [];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deleteCount) || start < position || deleteCount < 0 ||
        start + deleteCount > previous.length || !Array.isArray(data)) {
      throw new Error("Backend returned invalid semantic token edits.");
    }
    parts.push(previous.subarray(position, start), data);
    position = start + deleteCount;
  }
  parts.push(previous.subarray(position));
  return new vscode.SemanticTokens(semanticTokenData(parts.flatMap(part => Array.from(part)), legend), resultId(result));
}

const KEYWORD_GROUPS = new Set(["local", "resource", "library", "standard"]);

// Robot Companion's `robotCompanion/documentKeywords` result: the keywords one Robot file can
// call, by import. Locations must be files; documentation stays untrusted markdown.
function documentKeywords(result) {
  const text = (value, label) => {
    if (typeof value !== "string") throw new Error(`Backend keyword list has an invalid ${label}.`);
    return value;
  };
  const optional = (value, label) => value === null || value === undefined ? undefined : text(value, label);
  const place = value => value ? Object.assign(new vscode.Location(fileUri(value.uri, "Backend keyword location"),
    fromProtocolRange(value.range)), value.sourceKind === undefined ? {} : {
      sourceKind: definitionSourceKind(value.sourceKind)
    }) : undefined;
  const declaration = item => {
    const sourceKind = definitionSourceKind(item.sourceKind);
    if (sourceKind === "declaration" ? item.runtimeSignatureKnown !== false : item.runtimeSignatureKnown !== undefined) {
      throw new Error("Backend keyword declaration has an invalid runtime signature marker.");
    }
    if (item.location && item.location.sourceKind !== sourceKind) {
      throw new Error("Backend keyword declaration and location have different source kinds.");
    }
    return sourceKind ? { sourceKind, runtimeSignatureKnown: false } : {};
  };
  if (!result || !Array.isArray(result.imports)) throw new Error("Backend returned an invalid keyword list.");
  return {
    version: Number.isSafeInteger(result.version) ? result.version : undefined,
    imports: result.imports.map(group => {
      if (!KEYWORD_GROUPS.has(group?.kind) || !Array.isArray(group.keywords)) {
        throw new Error("Backend keyword list has an invalid import.");
      }
      return {
        kind: group.kind, name: text(group.name, "import name"), alias: optional(group.alias, "alias"),
        namespace: text(group.namespace, "namespace"),
        uri: group.uri ? fileUri(group.uri, "Backend import") : undefined,
        importedBy: place(group.importedBy),
        importSites: (Array.isArray(group.importSites) ? group.importSites : []).map(place).filter(Boolean),
        documentation: markdown({ kind: "markdown", value: optional(group.documentation, "documentation") ?? "" }),
        keywords: group.keywords.map(item => ({
          name: text(item?.name, "keyword name"), namespace: text(item.namespace, "namespace"),
          kind: text(item.kind, "keyword kind"), ...declaration(item),
          signature: Array.isArray(item.signature) ? item.signature.map(cell => text(cell, "argument")) : undefined,
          required: Array.isArray(item.required)
            ? item.required.map(argument => ({ name: text(argument?.name, "argument"), named: argument.named === true }))
            : undefined,
          returnType: optional(item.returnType, "return type"),
          documentation: markdown({ kind: "markdown", value: optional(item.documentation, "documentation") ?? "" }),
          location: place(item.location),
          call: optional(item.call, "call")
        }))
      };
    }),
    unresolved: (Array.isArray(result.unresolved) ? result.unresolved : []).map(item => ({
      location: place(item), message: text(item?.message, "message")
    }))
  };
}

// One LSP inlay hint as text: a label part's location and command, and a hint's
// text edits, are not used, so a hint never edits the document or runs a command.
// Hints without a known kind stay without one.
const INLAY_HINT_KINDS = Object.freeze({ 1: vscode.InlayHintKind?.Type, 2: vscode.InlayHintKind?.Parameter });
function inlayHint(item) {
  const position = fromProtocolRange({ start: item?.position, end: item?.position }).start;
  const label = typeof item.label === "string" ? item.label : Array.isArray(item.label) ? item.label.map(part => {
    const result = new vscode.InlayHintLabelPart(String(part?.value ?? ""));
    const tooltip = markdown(part?.tooltip);
    if (tooltip) result.tooltip = tooltip;
    return result;
  }) : "";
  if (!label.length || (Array.isArray(label) && !label.some(part => part.value))) throw new Error("Backend returned an inlay hint without a label.");
  const hint = new vscode.InlayHint(position, label, INLAY_HINT_KINDS[item.kind]);
  const tooltip = markdown(item.tooltip);
  if (tooltip) hint.tooltip = tooltip;
  if (item.paddingLeft === true) hint.paddingLeft = true;
  if (item.paddingRight === true) hint.paddingRight = true;
  return hint;
}

module.exports = {
  toProtocolRange, fromProtocolRange, fileUri, normalizeDefinitions, markdown, hoverMarkdown, completionItem, completionList,
  signatureHelp, locations, documentSymbols, workspaceSymbols, workspaceEdit, textEdits, diagnostic, codeActionKind, codeAction,
  semanticTokensLegend, semanticTokens, documentKeywords, inlayHint, editedSemanticTokens
};

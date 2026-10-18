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

function normalizeDefinitions(result) {
  if (result === null || result === undefined) return [];
  return (Array.isArray(result) ? result : [result]).map(item => {
    const uri = fileUri(item.targetUri || item.uri, "Backend definition");
    if (item.targetUri) return {
      targetUri: uri, targetRange: fromProtocolRange(item.targetRange),
      targetSelectionRange: fromProtocolRange(item.targetSelectionRange),
      originSelectionRange: item.originSelectionRange && fromProtocolRange(item.originSelectionRange)
    };
    return new vscode.Location(uri, fromProtocolRange(item.range));
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
      if (change.kind) throw new Error(`Rename edits that ${change.kind} files are not supported.`);
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

module.exports = {
  toProtocolRange, fromProtocolRange, normalizeDefinitions, markdown, hoverMarkdown, completionItem, completionList,
  signatureHelp, locations, documentSymbols, workspaceSymbols, workspaceEdit
};

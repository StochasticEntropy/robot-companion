"use strict";

// The Robot Keywords view and Search Keywords in Scope: the keywords the last active Robot file
// can call, grouped by the import they come from, as its language backend resolves them
// (`robotCompanion/documentKeywords`). Nothing is listed from a guess or from an unimported
// library. A keyword opens its definition; Insert Keyword Call writes the call text the
// backend checked to resolve to that keyword, with its required arguments as placeholders.
const path = require("path");
const vscode = require("vscode");

const VIEW_ID = "robotCompanion.keywordView";
const COMMANDS = Object.freeze({
  search: "robotCompanion.searchKeywords",
  refresh: "robotCompanion.keywordView.refresh",
  open: "robotCompanion.keywordView.openDefinition",
  insert: "robotCompanion.keywordView.insert"
});
const REFRESH_DELAY_MS = 300;
const isRobot = document => document?.uri.scheme === "file" && /\.(robot|resource)$/i.test(document.uri.path);
const fileName = uri => path.basename(uri.fsPath);
const KIND_LABELS = Object.freeze({ local: "This file", resource: "Resource", library: "Library", standard: "Standard library" });
const KIND_ICONS = Object.freeze({ local: "file", resource: "file-code", library: "library", standard: "symbol-namespace" });

function groupLabel(group) {
  return group.alias ? `${group.alias}` : group.kind === "local" ? group.name : group.namespace;
}

// "Library · AuditLibrary.py · via shared.resource"
function groupDescription(group, document) {
  const parts = [KIND_LABELS[group.kind]];
  if (group.alias || group.kind === "resource" || group.kind === "library") parts.push(group.name);
  const importer = group.importedBy?.uri;
  if (importer && document && importer.toString() !== document.uri.toString()) parts.push(`via ${fileName(importer)}`);
  return parts.join(" · ");
}

const sameSite = (a, b) => Boolean(a && b) && a.uri.toString() === b.uri.toString() && a.range.start.line === b.range.start.line;

function signatureText(keyword) {
  if (!keyword.signature) return "arguments unknown";
  return keyword.signature.join(", ");
}

class KeywordExplorer {
  constructor(languageWorkspace) {
    this.languageWorkspace = languageWorkspace;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.document = undefined;  // the Robot document listed
    this.listing = undefined;   // { document, version, data, groups }
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{robot,resource,py}");
    this.subscriptions = [
      this.view, this.changed, watcher,
      watcher.onDidCreate(() => this.schedule()), watcher.onDidChange(() => this.schedule()),
      watcher.onDidDelete(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.track(editor?.document)),
      vscode.workspace.onDidChangeTextDocument(event => {
        // The listed file's imports, and the resources and libraries they read, change its list.
        if (event.contentChanges.length && (event.document === this.document ||
            /\.(robot|resource|py)$/i.test(event.document.uri.path))) this.schedule();
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document === this.document) this.track(undefined, true);
      }),
      this.languageWorkspace.onDidChange(() => this.schedule()),
      this.view.onDidChangeVisibility(() => { if (this.view.visible && this.stale) this.refresh(); }),
      vscode.commands.registerCommand(COMMANDS.refresh, () => this.refresh()),
      vscode.commands.registerCommand(COMMANDS.open, item => this.openDefinition(item ?? this.view.selection[0])),
      vscode.commands.registerCommand(COMMANDS.insert, item => this.insert(item ?? this.view.selection[0])),
      vscode.commands.registerCommand(COMMANDS.search, () => this.search())
    ];
    this.track(vscode.window.activeTextEditor?.document);
  }

  // A newly active Robot editor is listed; another editor (a library opened from the list,
  // the output) keeps the last Robot file, which the view's description names.
  track(document, closed = false) {
    if (closed) {
      this.document = undefined;
    } else if (!isRobot(document) || document === this.document) {
      return;
    } else {
      this.document = document;
    }
    this.listing = undefined;
    this.view.description = this.document ? fileName(this.document.uri) : undefined;
    this.refresh();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
  }

  refresh() {
    clearTimeout(this.timer);
    this.stale = true;
    // A hidden view asks again when it is shown.
    if (this.view.visible) this.changed.fire();
  }

  // The current list of the tracked document, asked again when it changed. Errors and
  // unavailability become the view's message, never a partial list.
  async load() {
    const document = this.document;
    if (!document || document.isClosed) {
      this.view.message = "Open a .robot or .resource file to list the keywords it can call.";
      return undefined;
    }
    if (this.listing?.document === document && this.listing.version === document.version && !this.stale) {
      return this.listing;
    }
    this.stale = false;
    const reason = this.languageWorkspace.keywordListUnavailable(document);
    if (reason) {
      this.listing = undefined;
      this.view.message = reason;
      return undefined;
    }
    const version = document.version;
    let data;
    try {
      data = await this.languageWorkspace.documentKeywords(document);
    } catch (error) {
      this.listing = undefined;
      this.view.message = `Keywords of ${fileName(document.uri)} are not available: ${error.message}`;
      return undefined;
    }
    if (document !== this.document) return this.load();
    if (!data || document.version !== version) {
      // Edited, closed or restarted meanwhile: the next change event asks again.
      this.stale = true;
      return this.listing?.document === document ? this.listing : undefined;
    }
    // Element ids are unique within the tree: VS Code keeps expansion and focus by id, so a
    // repeated id would make a click or ArrowRight act on another row.
    const used = new Set();
    const unique = id => {
      let candidate = id;
      for (let index = 2; used.has(candidate); index++) candidate = `${id}#${index}`;
      used.add(candidate);
      return candidate;
    };
    const groups = data.imports.map(group => ({ type: "group", id: unique(`${group.kind}|${group.namespace}|${group.uri ?? ""}`), group }));
    for (const item of groups) {
      item.children = item.group.keywords.map((keyword, index) => ({ type: "keyword",
        id: unique(`${item.id}/${keyword.name}@${keyword.location?.range.start.line ?? index}`),
        keyword, group: item.group, parent: item }));
    }
    const unresolved = data.unresolved.map((entry, index) => ({ type: "unresolved", id: unique(`unresolved/${index}`), entry }));
    this.listing = { document, version, data, groups, unresolved };
    this.view.message = undefined;
    return this.listing;
  }

  async getChildren(element) {
    if (element) return element.children || [];
    const listing = await this.load();
    return listing ? [...listing.unresolved, ...listing.groups] : [];
  }

  getParent(element) {
    return element.parent;
  }

  getTreeItem(element) {
    if (element.type === "unresolved") {
      const item = new vscode.TreeItem(element.entry.message, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.iconPath = new vscode.ThemeIcon("warning");
      item.description = element.entry.location ? `${fileName(element.entry.location.uri)}:${element.entry.location.range.start.line + 1}` : undefined;
      item.tooltip = `Unresolved import: ${element.entry.message}`;
      if (element.entry.location) item.command = { title: "Open import", command: "vscode.open",
        arguments: [element.entry.location.uri, { selection: element.entry.location.range }] };
      return item;
    }
    if (element.type === "group") {
      const { group } = element;
      const item = new vscode.TreeItem(groupLabel(group), group.kind === "local"
        ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = element.id;
      item.description = groupDescription(group, this.document);
      item.iconPath = new vscode.ThemeIcon(KIND_ICONS[group.kind]);
      item.contextValue = "robotKeywordGroup";
      const tooltip = new vscode.MarkdownString();
      tooltip.isTrusted = false;
      tooltip.supportHtml = false;
      tooltip.appendText(`${groupLabel(group)} · ${item.description} · ${group.keywords.length} keyword(s)`);
      const sites = group.importSites.length ? group.importSites : group.importedBy ? [group.importedBy] : [];
      if (sites.length) {
        // This file's own import first, then the imports in resources sharing the same library instance.
        const ordered = [group.importedBy, ...sites.filter(site => !sameSite(site, group.importedBy))].filter(Boolean);
        tooltip.appendText(`\n\nImported in ${ordered.map(site => `${fileName(site.uri)}, line ${site.range.start.line + 1}`).join("; also in ")}`);
      }
      if (group.uri) tooltip.appendText(`\n\nSource: ${group.uri.fsPath}`);
      if (group.documentation) tooltip.appendMarkdown("\n\n---\n\n").appendMarkdown(group.documentation.value);
      item.tooltip = tooltip;
      item.accessibilityInformation = { label: `${groupLabel(group)}, ${item.description}, ${group.keywords.length} keywords` };
      return item;
    }
    const { keyword, group } = element;
    const item = new vscode.TreeItem(keyword.name, vscode.TreeItemCollapsibleState.None);
    item.id = element.id;
    item.description = signatureText(keyword);
    item.iconPath = new vscode.ThemeIcon("symbol-function");
    item.contextValue = keyword.call ? "robotKeyword.insertable" : "robotKeyword";
    item.tooltip = keyword.documentation;
    if (keyword.location) item.command = { title: "Go to Keyword Definition", command: COMMANDS.open, arguments: [element] };
    item.accessibilityInformation = { label: `${keyword.name}, keyword of ${KIND_LABELS[group.kind].toLowerCase()} ` +
      `${groupLabel(group)}, arguments ${item.description}` };
    return item;
  }

  async openDefinition(element) {
    const location = element?.keyword?.location;
    if (!location) return;
    // The cursor at the start of the name, as Go to Definition (F12) places it.
    const start = new vscode.Range(location.range.start, location.range.start);
    await vscode.window.showTextDocument(location.uri, { selection: start, preview: false });
  }

  // Insert a call of the keyword at the cursor of the listed file, checked against its current list.
  async insert(element) {
    if (element?.type !== "keyword") return;
    const document = this.document;
    if (!document || document.isClosed) return;
    this.stale = true;
    const listing = await this.load();
    const same = keyword => keyword.name === element.keyword.name && keyword.namespace === element.keyword.namespace &&
      String(keyword.location?.uri) === String(element.keyword.location?.uri) &&
      keyword.location?.range.start.line === element.keyword.location?.range.start.line;
    const keyword = listing?.document === document && listing.groups.flatMap(group => group.group.keywords).find(same);
    this.changed.fire();
    if (!keyword) {
      void vscode.window.showWarningMessage(`${element.keyword.name} is no longer a keyword ${fileName(document.uri)} can call.`);
      return;
    }
    if (!keyword.call) {
      void vscode.window.showWarningMessage(`${keyword.name} cannot be called unambiguously from ${fileName(document.uri)}: ` +
        "several imports give it the same name. Give one import its own AS alias.");
      return;
    }
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document === document);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn, preview: false });
    if (editor.document.version !== listing.version) return;
    const { range, snippet, newLine } = callSnippet(editor, keyword);
    if (newLine) {
      // The new line is plain text: a snippet's line break would get the editor's auto-indentation too.
      if (!await editor.edit(builder => builder.insert(range.start, newLine), { undoStopBefore: true, undoStopAfter: false })) return;
      const end = editor.document.lineAt(range.start.line + 1).range.end;
      await editor.insertSnippet(snippet, end, { undoStopBefore: false, undoStopAfter: true });
      return;
    }
    await editor.insertSnippet(snippet, range);
  }

  async search() {
    const document = this.document;
    if (!document) {
      void vscode.window.showInformationMessage("Open a .robot or .resource file to search the keywords it can call.");
      return;
    }
    this.stale = true;
    const listing = await this.load();
    this.changed.fire();
    if (!listing) {
      void vscode.window.showWarningMessage(this.view.message || "No keyword list is available.");
      return;
    }
    const insertButton = { iconPath: new vscode.ThemeIcon("insert"), tooltip: "Insert Keyword Call" };
    const picker = vscode.window.createQuickPick();
    picker.title = `Keywords ${fileName(document.uri)} can call`;
    picker.placeholder = "Type to filter by keyword, library, alias or resource. Enter opens the definition.";
    picker.matchOnDescription = true;
    picker.items = listing.groups.flatMap(item => item.children.map(element => ({
      label: element.keyword.name,
      description: `${groupLabel(item.group)} · ${groupDescription(item.group, document)}`,
      detail: `${signatureText(element.keyword)}${element.keyword.returnType ? ` → ${element.keyword.returnType}` : ""}`,
      buttons: element.keyword.call ? [insertButton] : [],
      element
    })));
    await new Promise(resolve => {
      picker.onDidTriggerItemButton(event => { picker.hide(); void this.insert(event.item.element); });
      picker.onDidAccept(() => {
        const chosen = picker.selectedItems[0];
        picker.hide();
        if (chosen) void this.openDefinition(chosen.element);
      });
      picker.onDidHide(() => { picker.dispose(); resolve(); });
      picker.show();
    });
  }

  dispose() {
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

// Where and what to insert: on an empty line the call with the body's indentation; at the end of
// a line a new line below it (`newLine`, inserted first); inside a line the call at the cursor
// (after `${x}=    `, say).
// Required arguments become placeholders, named-only ones as `name=`.
function callSnippet(editor, keyword) {
  const document = editor.document;
  const position = editor.selection.active;
  const line = document.lineAt(position.line);
  const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const indentation = text => /^[ \t]*/.exec(text)[0];
  const snippet = new vscode.SnippetString();
  let range, newLine;
  if (line.isEmptyOrWhitespace) {
    let indent = line.text.length >= 2 ? line.text : "";
    for (let index = position.line - 1; !indent && index >= 0; index--) {
      const previous = document.lineAt(index).text;
      if (previous.trim()) indent = indentation(previous).length >= 2 ? indentation(previous) : "    ";
    }
    snippet.appendText(indent || "    ");
    range = line.range;
  } else if (position.character >= line.text.trimEnd().length) {
    const indent = indentation(line.text);
    newLine = `${eol}${indent.length >= 2 ? indent : "    "}`;
    range = new vscode.Range(line.range.end, line.range.end);
  } else {
    range = new vscode.Range(position, position);
  }
  snippet.appendText(keyword.call);
  for (const argument of keyword.required || []) {
    snippet.appendText(argument.named ? `    ${argument.name}=` : "    ");
    snippet.appendPlaceholder(argument.name);
  }
  return { range, snippet, newLine };
}

module.exports = { KeywordExplorer, callSnippet, VIEW_ID, COMMANDS };

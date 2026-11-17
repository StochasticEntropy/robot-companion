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
    this.revision = 0;
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

  invalidate() {
    this.revision++;
    this.stale = true;
    this.pending?.cancellation.cancel();
    this.pending = undefined;
  }

  schedule() {
    this.invalidate();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.view.visible) this.changed.fire(); }, REFRESH_DELAY_MS);
  }

  refresh() {
    clearTimeout(this.timer);
    this.invalidate();
    if (this.view.visible) this.changed.fire();
  }

  // Tree and Quick Pick share a listing and one in-flight request per revision.
  load() {
    const document = this.document;
    if (!document || document.isClosed) {
      this.view.message = "Open a .robot or .resource file to list the keywords it can call.";
      return;
    }
    const version = document.version;
    const revision = this.revision;
    if (this.isCurrent(this.listing)) return this.listing;
    if (this.isCurrent(this.pending)) return this.pending.result;

    const reason = this.languageWorkspace.keywordListUnavailable(document);
    if (reason) {
      this.view.message = reason;
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    const pending = { document, version, revision, cancellation };
    this.pending = pending;
    pending.result = this.loadListing(pending).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      cancellation.dispose();
    });
    return pending.result;
  }

  isCurrent(snapshot) {
    return Boolean(snapshot && snapshot.document === this.document && !snapshot.document.isClosed &&
      snapshot.version === snapshot.document.version && snapshot.revision === this.revision);
  }

  async loadListing(pending) {
    const { document, version, revision, cancellation } = pending;
    let data;
    try {
      data = await this.languageWorkspace.documentKeywords(document, cancellation.token);
    } catch (error) {
      if (this.isCurrent(pending)) {
        this.view.message = `Keywords of ${fileName(document.uri)} are not available: ${error.message}`;
      }
      return;
    }
    if (!this.isCurrent(pending)) return;
    if (!data) {
      this.view.message = "The keyword list is unavailable. Use Refresh Keywords to try again.";
      return;
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
    this.listing = { document, version, revision, data, groups, unresolved };
    this.stale = false;
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
    if (!location) {
      void vscode.window.showInformationMessage("No source location is available for this keyword.");
      return;
    }
    // The cursor at the start of the name, as Go to Definition (F12) places it.
    const start = new vscode.Range(location.range.start, location.range.start);
    try {
      await vscode.window.showTextDocument(location.uri, { selection: start, preview: false });
    } catch {
      void vscode.window.showWarningMessage(`The source for "${element.keyword.name}" could not be opened. Refresh Keywords and try again.`);
    }
  }

  // Insert a call of the keyword at the cursor of the listed file, checked against its current list.
  async insert(element) {
    if (element?.type !== "keyword") return;
    const document = this.document;
    if (!document || document.isClosed) return;
    this.invalidate();
    const listing = await this.load();
    const same = keyword => keyword.name === element.keyword.name && keyword.namespace === element.keyword.namespace &&
      String(keyword.location?.uri) === String(element.keyword.location?.uri) &&
      keyword.location?.range.start.line === element.keyword.location?.range.start.line;
    const keyword = this.isCurrent(listing) && listing.document === document && listing.groups.flatMap(group => group.group.keywords).find(same);
    this.changed.fire();
    if (!keyword) {
      void vscode.window.showWarningMessage(`${element.keyword.name} is no longer a keyword ${fileName(document.uri)} can call.`);
      return;
    }
    if (!keyword.call) {
      void vscode.window.showWarningMessage(`${keyword.name} cannot be called unambiguously from ${fileName(document.uri)}: ` +
        "several imports give it the same name (Robot Framework ignores case and spaces in it). " +
        "Give one import an AS alias of its own.");
      return;
    }
    const visible = vscode.window.visibleTextEditors.find(editor => editor.document === document);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: visible?.viewColumn, preview: false });
    if (!this.isCurrent(listing) || editor.document !== document) return;
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

  search() {
    const document = this.document;
    if (!document) {
      void vscode.window.showInformationMessage("Open a .robot or .resource file to search the keywords it can call.");
      return;
    }
    this.picker?.hide();
    const origin = { document, version: document.version, revision: this.revision };
    const insertButton = { iconPath: new vscode.ThemeIcon("insert"), tooltip: "Insert Keyword Call" };
    const picker = this.picker = vscode.window.createQuickPick();
    picker.title = `Keywords in ${fileName(document.uri)}`;
    picker.placeholder = "Type a keyword, library, alias or resource";
    picker.matchOnDescription = true;
    picker.busy = true;
    const moved = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document !== document) picker.hide();
    });
    const valid = () => {
      if (this.isCurrent(origin)) return true;
      picker.items = [];
      picker.placeholder = "The source changed. Reopen Search Keywords in Scope to refresh.";
      return false;
    };
    return new Promise(resolve => {
      picker.onDidTriggerItemButton(event => {
        if (!valid() || !event.item.element) return;
        picker.hide();
        void this.insert(event.item.element);
      });
      picker.onDidAccept(() => {
        const chosen = picker.selectedItems[0];
        if (!chosen?.element || !valid()) return;
        if (!chosen.element.keyword.location) {
          picker.placeholder = "Source location unavailable for this keyword.";
          return;
        }
        picker.hide();
        void this.openDefinition(chosen.element);
      });
      picker.onDidHide(() => {
        if (this.picker === picker) this.picker = undefined;
        moved.dispose();
        picker.dispose();
        resolve();
      });
      picker.show();
      void Promise.resolve(this.load()).then(listing => {
        if (this.picker !== picker) return;
        picker.busy = false;
        if (!valid()) return;
        const items = listing?.groups.flatMap(item => item.children.map(element => ({
          label: element.keyword.name,
          description: `${groupLabel(item.group)} · ${groupDescription(item.group, document)}`,
          detail: `${signatureText(element.keyword)}${element.keyword.returnType ? ` → ${element.keyword.returnType}` : ""}` +
            (element.keyword.location ? "" : " · Source location unavailable"),
          buttons: element.keyword.call ? [insertButton] : [],
          element
        }))) || [];
        picker.items = items.length ? items : [{ label: this.view.message || "No callable keywords in this file." }];
        if (items.length) picker.placeholder = "Filter by keyword, library, alias or resource. Enter opens its definition.";
      });
    });
  }

  dispose() {
    this.picker?.hide();
    this.invalidate();
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

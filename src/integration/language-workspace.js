"use strict";

const vscode = require("vscode");
const { validateDescriptor } = require("./backend-contract");
const { LspSession } = require("./lsp-session");
const { definitionIdentity } = require("./definition-identity");
const { backendHoverRemainder, uniqueBackendCompletions } = require("./language-merge");
const protocol = require("./language-protocol");
const bridge = require("./robotcode-bridge");
const { toProtocolRange, fromProtocolRange, normalizeDefinitions } = protocol;

const SELECTOR = [{ scheme: "file", language: "robotframework" }];
const isRobot = document => document.uri.scheme === "file" && /\.(robot|resource)$/i.test(document.uri.path);

// One process per workspace root. This module owns VS Code/LSP plumbing only;
// backend-specific protocols and environment selection do not belong here.
class LanguageWorkspace {
  constructor() {
    this.roots = new Map();
    this.disposed = false;
    this.generation = 0;
    this.queue = Promise.resolve();
    // Companion's own hover/completion providers, composed with the backend's
    // in owned roots (see language-merge.js for the precedence rule).
    this.companion = {};
    this.channel = vscode.window.createOutputChannel("Robot Companion Language");
    this.diagnostics = vscode.languages.createDiagnosticCollection("robotCompanion");
    this.subscriptions = [
      vscode.commands.registerCommand("robotCompanion.restartLanguageService", () => this.refresh()),
      vscode.commands.registerCommand("robotCompanion.showLanguageServiceStatus", () => this.showStatus()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("robotCompanion.integrationMode") ||
            event.affectsConfiguration("robotCompanion.languageBackend")) void this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
      // Revoking trust reloads the extension host; deactivate also awaits stop.
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }),
      vscode.workspace.onDidOpenTextDocument(document => this.open(document)),
      vscode.workspace.onDidChangeTextDocument(event => this.change(event)),
      vscode.workspace.onDidSaveTextDocument(document => this.save(document)),
      vscode.workspace.onDidCloseTextDocument(document => this.close(document))
    ];
    void this.refresh();
  }

  mode(uri) {
    return vscode.workspace.getConfiguration("robotCompanion", uri).get("integrationMode", "coexistence");
  }

  refresh() {
    // Invalidate synchronously: in-flight definitions cannot escape while a
    // configuration/root transition waits for an old process to close.
    const generation = ++this.generation;
    for (const root of this.roots.values()) {
      root.current = false;
      // An initializing process must not hold the lifecycle queue until its
      // request timeout before a mode/root transition can stop it.
      void root.session?.stop();
    }
    this.queue = this.queue.then(async () => {
      await this.stopRoots();
      if (this.disposed || !vscode.workspace.isTrusted || generation !== this.generation) return;
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (this.disposed || generation !== this.generation) break;
        if (folder.uri.scheme !== "file" || this.mode(folder.uri) !== "owned") continue;
        const root = { folder, generation, current: true, documents: new Map(), registrations: [], features: new Set() };
        this.roots.set(folder.uri.toString(), root);
        try {
          // Read executable configuration only after checking workspace trust.
          const input = vscode.workspace.getConfiguration("robotCompanion", folder.uri).get("languageBackend");
          const descriptor = validateDescriptor(input);
          if (descriptor.workspaceUri !== folder.uri.toString()) {
            throw new Error("languageBackend.workspaceUri must match this workspace folder URI.");
          }
          root.descriptor = descriptor;
          root.session = new LspSession({ onServerRequest: (method, params) => this.serverRequest(root, method, params) });
          root.session.on("log", message => this.channel.append(`[${folder.name}] ${message}`));
          root.session.on("failure", error => this.failed(root, error));
          root.session.on("notification", (method, params) => this.notification(root, method, params));
          await root.session.start(descriptor, vscode.workspace.isTrusted && !this.disposed && root.current);
          if (!this.usable(root)) { await root.session.stop(); continue; }
          bridge.verifyLanguageServer(descriptor, root.session.serverInfo);
          this.register(root);
          for (const document of vscode.workspace.textDocuments) this.open(document);
          const server = root.session.serverInfo?.name ? ` (${root.session.serverInfo.name} ${root.session.serverInfo.version})` : "";
          this.channel.appendLine(`[${folder.name}] Running ${descriptor.id} ${descriptor.version}${server}. ` +
            `Server capabilities: ${JSON.stringify(root.session.capabilities)}. ` +
            `Companion client: text sync, diagnostics${[...root.features].map(name => `, ${name}`).join("")}; ` +
            "other server capabilities are not exposed.");
        } catch (error) {
          this.failed(root, error);
          await root.session?.stop();
        }
      }
    }).catch(error => this.channel.appendLine(`Language lifecycle failed: ${error.message}`));
    return this.queue;
  }

  usable(root) {
    return root?.current && root.generation === this.generation && !this.disposed && vscode.workspace.isTrusted &&
      this.mode(root.folder.uri) === "owned" && root.session?.state === "running";
  }

  rootFor(document) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = folder && this.roots.get(folder.uri.toString());
    return isRobot(document) && this.usable(root) ? root : undefined;
  }

  failed(root, error) {
    root.current = false;
    root.error = error.message;
    this.unregister(root);
    this.clearDiagnostics(root);
    this.channel.appendLine(`[${root.folder.name}] Unavailable: ${error.message} ` +
      "Check robotCompanion.languageBackend, then run Robot Companion: Restart Language Service.");
  }

  setCompanionProviders({ hover, completion }) {
    this.companion = { hover, completion };
  }

  // True when this document's owned backend provides the feature, so that
  // Companion's own provider for it stands back for the composed one.
  backendProvides(document, feature) {
    return document.languageId === "robotframework" && Boolean(this.rootFor(document)?.features.has(feature));
  }

  // One VS Code provider per capability the backend advertises; none for the rest.
  register(root) {
    const capabilities = root.session.capabilities;
    // Relative patterns overlap for nested folders. Resolve the owning folder
    // before dispatch so each request reaches its backend exactly once.
    const selector = SELECTOR.map(filter => ({ ...filter, pattern: new vscode.RelativePattern(root.folder, "**/*") }));
    const mine = document => this.rootFor(document) === root;
    const add = (feature, registration) => { root.features.add(feature); root.registrations.push(registration); return registration; };
    if (capabilities.definitionProvider) {
      root.definitionRegistration = add("definitions", vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (document, position, token) => mine(document) ? this.definition(document, position, token) : undefined
      }));
    }
    if (capabilities.hoverProvider) {
      add("hover", vscode.languages.registerHoverProvider(selector, {
        provideHover: (document, position, token) => mine(document) ? this.hover(document, position, token) : undefined
      }));
    }
    if (capabilities.completionProvider) {
      const options = capabilities.completionProvider;
      const triggers = new Set([...(options.triggerCharacters || []), ...(this.companion.completion?.triggerCharacters || [])]
        .filter(value => typeof value === "string" && value.length === 1));
      add("completion", vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems: (document, position, token, context) =>
          mine(document) ? this.completion(document, position, token, context) : undefined,
        ...(options.resolveProvider ? { resolveCompletionItem: (item, token) => this.resolveCompletion(item, token) } : {})
      }, ...triggers));
    }
    if (capabilities.signatureHelpProvider) {
      const options = capabilities.signatureHelpProvider;
      const characters = value => (value || []).filter(item => typeof item === "string" && item.length === 1);
      add("signature help", vscode.languages.registerSignatureHelpProvider(selector, {
        provideSignatureHelp: (document, position, token, context) =>
          mine(document) ? this.signatureHelp(document, position, token, context) : undefined
      }, { triggerCharacters: characters(options.triggerCharacters), retriggerCharacters: characters(options.retriggerCharacters) }));
    }
    if (capabilities.referencesProvider) {
      add("references", vscode.languages.registerReferenceProvider(selector, {
        provideReferences: (document, position, context, token) =>
          mine(document) ? this.references(document, position, context, token) : undefined
      }));
    }
    if (capabilities.renameProvider) {
      const prepare = typeof capabilities.renameProvider === "object" && capabilities.renameProvider.prepareProvider === true;
      add("rename", vscode.languages.registerRenameProvider(selector, {
        provideRenameEdits: (document, position, newName, token) =>
          mine(document) ? this.rename(document, position, newName, token) : undefined,
        ...(prepare ? { prepareRename: (document, position, token) =>
          mine(document) ? this.prepareRename(document, position, token) : undefined } : {})
      }));
    }
    if (capabilities.documentSymbolProvider) {
      add("document symbols", vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols: (document, token) => mine(document) ? this.documentSymbols(document, token) : undefined
      }, { label: root.folder.name }));
    }
    if (capabilities.workspaceSymbolProvider) {
      add("workspace symbols", vscode.languages.registerWorkspaceSymbolProvider({
        provideWorkspaceSymbols: (query, token) => this.workspaceSymbols(root, query, token)
      }));
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.folder, "**/*.{robot,resource,py}"));
    root.registrations.push(watcher,
      watcher.onDidCreate(uri => this.watched(root, uri, 1)),
      watcher.onDidChange(uri => this.watched(root, uri, 2)),
      watcher.onDidDelete(uri => this.watched(root, uri, 3)));
  }

  unregister(root) {
    for (const registration of root.registrations.splice(0)) registration.dispose();
    root.definitionRegistration = undefined;
    root.features.clear();
  }

  syncOptions(root) {
    const sync = root.session.capabilities.textDocumentSync;
    return typeof sync === "number" ? { openClose: sync !== 0, change: sync } : sync || {};
  }

  send(root, method, params) {
    try { root.session.notify(method, params); return true; }
    catch (error) { this.failed(root, error); return false; }
  }

  open(document) {
    const root = this.rootFor(document);
    if (!root || root.documents.has(document.uri.toString())) return;
    const uri = document.uri.toString();
    root.documents.set(uri, document.version);
    if (this.syncOptions(root).openClose) this.send(root, "textDocument/didOpen", {
      textDocument: { uri, languageId: "robotframework", version: document.version, text: document.getText() }
    });
  }

  change(event) {
    const root = this.rootFor(event.document);
    if (!root || !event.contentChanges.length) return;
    const uri = event.document.uri.toString();
    if (!root.documents.has(uri)) { this.open(event.document); return; }
    root.documents.set(uri, event.document.version);
    const kind = this.syncOptions(root).change;
    if (kind === 1 || kind === 2) this.send(root, "textDocument/didChange", {
      textDocument: { uri, version: event.document.version },
      contentChanges: kind === 1 ? [{ text: event.document.getText() }] :
        event.contentChanges.map(change => ({ range: toProtocolRange(change.range), text: change.text }))
    });
    // No stale diagnostics survive edits while waiting for a newer publication.
    this.diagnostics.delete(event.document.uri);
  }

  close(document) {
    const root = this.rootFor(document);
    if (!root || !root.documents.delete(document.uri.toString())) return;
    this.diagnostics.delete(document.uri);
    if (this.syncOptions(root).openClose) this.send(root, "textDocument/didClose", {
      textDocument: { uri: document.uri.toString() }
    });
  }

  save(document) {
    const root = this.rootFor(document);
    if (!root) return;
    const save = this.syncOptions(root).save;
    if (save) this.send(root, "textDocument/didSave", {
      textDocument: { uri: document.uri.toString() },
      ...(save.includeText ? { text: document.getText() } : {})
    });
  }

  watched(root, uri, type) {
    if (this.usable(root) &&
        vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === root.folder.uri.toString()) {
      this.send(root, "workspace/didChangeWatchedFiles", {
        changes: [{ uri: uri.toString(), type }]
      });
    }
  }

  async definitionIdentity(document, position, token) {
    if (this.mode(document.uri) !== "owned") return { status: "coexistence" };
    const root = this.rootFor(document), version = document.version, generation = this.generation;
    const current = () => this.usable(root) && generation === this.generation &&
      !document.isClosed && document.version === version && !token?.isCancellationRequested;
    const definitions = await this.definition(document, position, token);
    if (!current()) return { status: "unresolved", current };
    return { ...definitionIdentity(definitions), current };
  }

  // A request about one document. Stale answers (edit, close, mode or root
  // change, cancellation) resolve to undefined; failures are logged, not thrown,
  // unless `raise` asks for the backend's message (rename shows it to the user).
  async documentRequest(document, method, params, token, { capability, raise = false } = {}) {
    const root = this.rootFor(document);
    if (!root || !root.session.capabilities[capability] || token?.isCancellationRequested) return;
    this.open(document);
    // With no change synchronization the backend only knows disk content.
    if (document.isDirty && ![1, 2].includes(this.syncOptions(root).change)) return;
    const version = document.version;
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    try {
      const result = await root.session.request(method, { textDocument: { uri: document.uri.toString() }, ...params },
        { signal: controller.signal });
      if (!this.usable(root) || document.isClosed || document.version !== version || token?.isCancellationRequested) return;
      return { root, result };
    } catch (error) {
      if (controller.signal.aborted) return;
      if (raise) throw new Error(error.message);
      this.channel.appendLine(`${method} unavailable: ${error.message}`);
    } finally { cancellation?.dispose(); }
  }

  async definition(document, position, token) {
    const answer = await this.documentRequest(document, "textDocument/definition", { position: point(position) }, token,
      { capability: "definitionProvider" });
    if (!answer) return;
    try { return normalizeDefinitions(answer.result); }
    catch (error) { this.channel.appendLine(`Definition unavailable: ${error.message}`); }
  }

  // One hover: Companion's sections first, then what the backend adds.
  async hover(document, position, token) {
    const [companion, answer] = await Promise.all([
      Promise.resolve(this.companion.hover?.provideHover(document, position, token)).catch(error => {
        this.channel.appendLine(`Companion hover failed: ${error.message}`);
      }),
      this.documentRequest(document, "textDocument/hover", { position: point(position) }, token, { capability: "hoverProvider" })
    ]);
    if (token?.isCancellationRequested) return;
    const contents = companion ? [...companion.contents] : [];
    let range = companion?.range;
    try {
      const shown = contents.map(item => typeof item === "string" ? item : item.value ?? "");
      const remainder = backendHoverRemainder(shown, protocol.hoverMarkdown(answer?.result).join("\n\n"));
      if (remainder) {
        contents.push(protocol.markdown({ kind: "markdown", value: remainder }));
        if (answer.result.range) range = fromProtocolRange(answer.result.range);
      }
    } catch (error) { this.channel.appendLine(`Hover unavailable: ${error.message}`); }
    return contents.length ? new vscode.Hover(contents, range) : undefined;
  }

  // Companion's completions first; backend items that repeat one are left out.
  // A trigger character reaches only the side that registered it.
  async completion(document, position, token, context) {
    const root = this.rootFor(document);
    const character = context?.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
    const asks = triggers => character === undefined || (triggers || []).includes(character);
    const [companion, answer] = await Promise.all([
      asks(this.companion.completion?.triggerCharacters)
        ? Promise.resolve(this.companion.completion?.provider.provideCompletionItems(document, position, token, context))
          .catch(error => { this.channel.appendLine(`Companion completion failed: ${error.message}`); })
        : undefined,
      asks(root?.session.capabilities.completionProvider?.triggerCharacters) &&
      this.documentRequest(document, "textDocument/completion", { position: point(position), context: {
        triggerKind: context?.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter ? 2
          : context?.triggerKind === vscode.CompletionTriggerKind.TriggerForIncompleteCompletions ? 3 : 1,
        ...(context?.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {})
      } }, token, { capability: "completionProvider" })
    ]);
    if (token?.isCancellationRequested) return;
    const own = Array.isArray(companion) ? companion : companion?.items || [];
    let backend = [], incomplete = companion?.isIncomplete === true;
    try {
      const list = protocol.completionList(answer?.result);
      backend = list.items.flatMap(item => {
        try {
          // completionItem/resolve goes to the same backend with its original item.
          return [Object.assign(protocol.completionItem(item), { backendItem: item, backendRoot: answer.root })];
        } catch (error) {
          this.channel.appendLine(`Completion item skipped: ${error.message}`);
          return [];
        }
      });
      incomplete ||= list.isIncomplete;
    } catch (error) { this.channel.appendLine(`Completion unavailable: ${error.message}`); }
    const items = own.concat(uniqueBackendCompletions(own, backend));
    return items.length || incomplete ? new vscode.CompletionList(items, incomplete) : undefined;
  }

  async resolveCompletion(item, token) {
    const owner = item.backendRoot;
    if (!item.backendItem || !this.usable(owner) || token?.isCancellationRequested) return item;
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    try {
      const resolved = await owner.session.request("completionItem/resolve", item.backendItem, { signal: controller.signal });
      if (!resolved || token?.isCancellationRequested) return item;
      const documentation = protocol.markdown(resolved.documentation);
      if (documentation) item.documentation = documentation;
      if (typeof resolved.detail === "string") item.detail = resolved.detail;
    } catch (error) {
      if (!controller.signal.aborted) this.channel.appendLine(`Completion details unavailable: ${error.message}`);
    } finally { cancellation?.dispose(); }
    return item;
  }

  async signatureHelp(document, position, token, context) {
    const answer = await this.documentRequest(document, "textDocument/signatureHelp", { position: point(position), context: {
      triggerKind: context?.triggerKind === vscode.SignatureHelpTriggerKind.TriggerCharacter ? 2
        : context?.triggerKind === vscode.SignatureHelpTriggerKind.ContentChange ? 3 : 1,
      ...(context?.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
      isRetrigger: context?.isRetrigger === true
    } }, token, { capability: "signatureHelpProvider" });
    if (!answer) return;
    try { return protocol.signatureHelp(answer.result); }
    catch (error) { this.channel.appendLine(`Signature help unavailable: ${error.message}`); }
  }

  async references(document, position, context, token) {
    const answer = await this.documentRequest(document, "textDocument/references", { position: point(position),
      context: { includeDeclaration: context?.includeDeclaration !== false } }, token, { capability: "referencesProvider" });
    if (!answer) return;
    try { return protocol.locations(answer.result); }
    catch (error) { this.channel.appendLine(`References unavailable: ${error.message}`); }
  }

  // The backend's refusal message reaches the rename box unchanged.
  async prepareRename(document, position, token) {
    const answer = await this.documentRequest(document, "textDocument/prepareRename", { position: point(position) }, token,
      { capability: "renameProvider", raise: true });
    if (!answer) return;
    const result = answer.result;
    // LSP null: no rename is possible here. VS Code would otherwise rename the word.
    if (result === null || result === undefined) throw new Error("The element can't be renamed.");
    if (result.defaultBehavior) return;
    return result.range ? { range: fromProtocolRange(result.range), placeholder: String(result.placeholder ?? "") }
      : fromProtocolRange(result);
  }

  async rename(document, position, newName, token) {
    const answer = await this.documentRequest(document, "textDocument/rename", { position: point(position), newName }, token,
      { capability: "renameProvider", raise: true });
    if (!answer) return;
    return protocol.workspaceEdit(answer.result, answer.root.folder);
  }

  async documentSymbols(document, token) {
    const answer = await this.documentRequest(document, "textDocument/documentSymbol", {}, token,
      { capability: "documentSymbolProvider" });
    if (!answer) return;
    try { return protocol.documentSymbols(answer.result); }
    catch (error) { this.channel.appendLine(`Document symbols unavailable: ${error.message}`); }
  }

  async workspaceSymbols(root, query, token) {
    if (!this.usable(root) || token?.isCancellationRequested) return;
    const generation = this.generation;
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    try {
      const result = await root.session.request("workspace/symbol", { query: String(query ?? "") }, { signal: controller.signal });
      if (!this.usable(root) || generation !== this.generation || token?.isCancellationRequested) return;
      return protocol.workspaceSymbols(result);
    } catch (error) {
      if (!controller.signal.aborted) this.channel.appendLine(`Workspace symbols unavailable: ${error.message}`);
    } finally { cancellation?.dispose(); }
  }

  serverRequest(root, method, params) {
    if (method === "workspace/workspaceFolders") {
      return [{ uri: root.folder.uri.toString(), name: root.folder.name }];
    }
    if (method === "workspace/configuration") {
      return (params?.items || []).map(item => {
        const config = vscode.workspace.getConfiguration(undefined, root.folder.uri);
        return item.section ? bridge.configuration(root.descriptor, item.section, config.get(item.section, null)) ?? null : null;
      });
    }
    throw Object.assign(new Error(`Unsupported language client request: ${method}`), { code: -32601 });
  }

  notification(root, method, params) {
    if (!this.usable(root)) return;
    if (method === "window/logMessage" || method === "window/showMessage") {
      this.channel.appendLine(`[${root.folder.name}] ${String(params?.message || "")}`);
      return;
    }
    if (method !== "textDocument/publishDiagnostics") return;
    try {
      const uri = vscode.Uri.parse(params.uri, true);
      if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== root.folder.uri.toString()) return;
      const version = root.documents.get(uri.toString());
      if (params.version !== undefined && params.version !== version) return;
      const diagnostics = params.diagnostics.map(item => {
        const diagnostic = new vscode.Diagnostic(fromProtocolRange(item.range), item.message,
          ({ 1: vscode.DiagnosticSeverity.Error, 2: vscode.DiagnosticSeverity.Warning,
            3: vscode.DiagnosticSeverity.Information, 4: vscode.DiagnosticSeverity.Hint })[item.severity] ?? vscode.DiagnosticSeverity.Error);
        diagnostic.source = "Robot Companion";
        return diagnostic;
      });
      this.diagnostics.set(uri, diagnostics);
    } catch (error) { this.channel.appendLine(`Invalid backend diagnostics: ${error.message}`); }
  }

  clearDiagnostics(root) {
    this.diagnostics.forEach(uri => {
      if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === root.folder.uri.toString()) this.diagnostics.delete(uri);
    });
  }

  async stopRoots() {
    const roots = [...this.roots.values()];
    this.roots.clear();
    for (const root of roots) {
      root.current = false;
      this.unregister(root);
      await root.session?.stop();
    }
    this.diagnostics.clear();
  }

  showStatus() {
    if (!vscode.workspace.isTrusted) this.channel.appendLine("Restricted Mode: no language backend processes are started.");
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const root = this.roots.get(folder.uri.toString());
      this.channel.appendLine(`[${folder.name}] ${this.mode(folder.uri)}: ` +
        (root?.error || root?.session?.state || "no owned language service"));
    }
    this.channel.show(true);
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const root of this.roots.values()) {
      root.current = false;
      void root.session?.stop();
    }
    for (const disposable of this.subscriptions) disposable.dispose();
    this.disposePromise = this.queue.then(() => this.stopRoots()).finally(() => {
      this.diagnostics.dispose();
      this.channel.dispose();
    });
    return this.disposePromise;
  }
}

function point(position) {
  return { line: position.line, character: position.character };
}

module.exports = { LanguageWorkspace, normalizeDefinitions, fromProtocolRange };

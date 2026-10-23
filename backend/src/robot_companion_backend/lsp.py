"""LSP requests use the current snapshot; owned push diagnostics run independently."""

from pathlib import Path
import sys

from . import __version__
from . import diagnostics
from . import explorer
from . import features
from . import formatting
from . import inlay_hints
from . import markdown
from . import navigation
from . import project
from . import robot_toml
from . import runtime
from . import semantic_tokens
from .protocol import FramedStream, ProtocolError
from .workspace import Workspace, uri_path
from .diagnostic_worker import DiagnosticsWorker
from .lsp_messages import Messages
from . import cancellation

# Requests about a position or a whole document, and their empty result: the answer for a
# Markdown file that is no Robot data here, and for a position outside its Robot blocks.
DOCUMENT_REQUESTS = {"textDocument/definition": [], "textDocument/hover": None, "textDocument/completion": [],
                     "textDocument/signatureHelp": None, "textDocument/references": [],
                     "textDocument/prepareRename": None, "textDocument/rename": None,
                     "textDocument/documentSymbol": [], "textDocument/codeAction": [],
                     "textDocument/formatting": None}
# Results whose positions are translated to a Markdown file's columns (semantic tokens do it
# themselves).
TRANSLATED_RESULTS = frozenset((*DOCUMENT_REQUESTS, "workspace/symbol"))


class RequestError(Exception):
    def __init__(self, code, message):
        super().__init__(message)  # str(exc) is the plain message, not the argument tuple
        self.code, self.message = code, message


class LanguageServer:
    def __init__(self, stream):
        self.stream = stream
        self.workspace = Workspace()
        self.initialized = False
        self.shutdown = False
        self.hover_markup = self.signature_markup = features.Markup(())
        self.hierarchical = False
        self.code_actions = False
        self.source_actions = False
        self.versioned_edits = False
        self.document_changes = False
        self.formatter = None
        self.semantic_results = semantic_tokens.Results()
        self.diagnostic_worker = DiagnosticsWorker(self.notify)
        self.robot_configuration = None

    def notify(self, method, params):
        self.stream.write({"jsonrpc": "2.0", "method": method, "params": params})

    def publish(self):
        self.diagnostic_worker.submit(self.workspace, self.robot_configuration)

    @staticmethod
    def roots(params):
        """Workspace folders (else rootUri, else rootPath); fixed for the session."""
        folders = [f.get("uri") for f in params.get("workspaceFolders") or () if isinstance(f, dict)]
        uris = [u for u in folders if isinstance(u, str)] or \
            ([params["rootUri"]] if isinstance(params.get("rootUri"), str) else [])
        roots = []
        for uri in uris:
            try:
                roots.append(uri_path(uri))
            except ValueError as exc:
                print(f"Workspace folder not indexed: {uri}: {exc}", file=sys.stderr)
        if not uris and isinstance(params.get("rootPath"), str):
            roots.append(Path(params["rootPath"]).resolve())
        return [root for root in roots if root.is_dir()]

    def dispatch(self, method, params):
        with self.workspace.source_snapshot():
            return self.dispatch_snapshot(method, params)

    def dispatch_snapshot(self, method, params):
        """`handle`, with positions in a Markdown file's Robot blocks translated both ways."""
        document = params.get("textDocument")
        uri = document.get("uri") if isinstance(document, dict) else None
        if self.initialized and not self.shutdown and method in DOCUMENT_REQUESTS and isinstance(uri, str):
            path = uri_path(uri)
            if robot_toml.is_configuration_file(path):  # robot.toml settings: help on hover only
                return self.configuration_hover(path, params) if method == "textDocument/hover" else \
                    DOCUMENT_REQUESTS[method]
            if markdown.is_markdown(path):
                if not self.workspace.is_robot_source(path):
                    return DOCUMENT_REQUESTS[method]
                if "position" in params:
                    position = params["position"]
                    offset = self.workspace.markdown_view(path).offset(position.get("line"))
                    if offset is None or not isinstance(position.get("character"), int):
                        return DOCUMENT_REQUESTS[method]  # prose, a fence line, or past the end
                    params = {**params, "position": {**position, "character": max(0, position["character"] - offset)}}
        result = self.handle(method, params)
        return self.workspace.to_editor(result, uri) if method in TRANSLATED_RESULTS else result

    def configuration_hover(self, path, params):
        _, text, line, column = self.workspace.locate(path.as_uri(), params["position"])
        help_text = robot_toml.hover(path, self.workspace.text(path), line, column)
        if help_text is None:
            return None
        return {"contents": {"kind": "markdown" if self.hover_markup.markdown else "plaintext", "value": help_text}}

    def handle(self, method, params):
        if method == "initialize":
            if self.initialized:
                raise RequestError(-32600, "Already initialized")
            if reason := runtime.unsupported_reason():
                raise RequestError(-32002, reason)
            capabilities = params.get("capabilities") or {}
            encodings = (capabilities.get("general") or {}).get("positionEncodings") or ["utf-16"]
            if "utf-16" not in encodings:
                raise RequestError(-32602, "Only UTF-16 positions are supported")
            text_document = capabilities.get("textDocument") or {}
            self.workspace.roots = self.roots(params)
            # The folder's Robot configuration (robotCompanion.robotArguments), fixed for the session.
            options = params.get("initializationOptions") or {}
            configured = isinstance(options, dict) and "robotConfiguration" in options
            self.robot_configuration = options.get("robotConfiguration") if configured else None
            self.workspace.config = project.parse(self.robot_configuration) if configured else project.EMPTY
            # RenameOptions and nested DocumentSymbols only for clients that declare support.
            prepare = bool((text_document.get("rename") or {}).get("prepareSupport"))
            self.hierarchical = bool((text_document.get("documentSymbol") or {}).get(
                "hierarchicalDocumentSymbolSupport"))
            self.hover_markup = features.Markup((text_document.get("hover") or {}).get("contentFormat"))
            self.signature_markup = features.Markup(((text_document.get("signatureHelp") or {}).get(
                "signatureInformation") or {}).get("documentationFormat"))
            # Quick fixes are CodeAction literals, which a client must declare it supports.
            literals = (text_document.get("codeAction") or {}).get("codeActionLiteralSupport") or {}
            self.code_actions = bool(literals)
            # The source action only for a client that lists `source` (or its own kind).
            self.source_actions = any(kind in ("source", diagnostics.ADD_MISSING_IMPORTS) for kind in
                                      (literals.get("codeActionKind") or {}).get("valueSet") or ())
            # Edits name the document version they were computed for when the client accepts it.
            self.versioned_edits = bool(((capabilities.get("workspace") or {}).get("workspaceEdit") or {}).get(
                "documentChanges"))
            self.document_changes = self.versioned_edits
            self.formatter = formatting.available()  # Robocop 9.1.0, an optional dependency
            self.initialized = True
            # Only implemented features: no completion resolve, snippets or commit characters.
            capabilities = {
                "positionEncoding": "utf-16", "textDocumentSync": {"openClose": True, "change": 1},
                "definitionProvider": True, "hoverProvider": True,
                "completionProvider": {"triggerCharacters": ["{", "."], "resolveProvider": False},
                "signatureHelpProvider": {"triggerCharacters": [" ", "\t"], "retriggerCharacters": ["="]},
                "referencesProvider": True, "renameProvider": {"prepareProvider": True} if prepare else True,
                "documentSymbolProvider": True, "workspaceSymbolProvider": True,
                # Deltas are computed from the complete current token set.
                "semanticTokensProvider": {"legend": semantic_tokens.LEGEND, "full": {"delta": True}, "range": True},
                "inlayHintProvider": {"resolveProvider": False},
                # Robot Companion's own request: the keywords a Robot file can call (explorer.py).
                "experimental": {"robotCompanion": {"documentKeywords": 1}}}
            if self.code_actions:
                capabilities["codeActionProvider"] = {"codeActionKinds": [diagnostics.QUICKFIX] + (
                    [diagnostics.ADD_MISSING_IMPORTS] if self.source_actions else [])}
            if self.formatter:
                capabilities["documentFormattingProvider"] = True
                capabilities["documentRangeFormattingProvider"] = True
                capabilities["documentOnTypeFormattingProvider"] = {
                    "firstTriggerCharacter": formatting.ON_TYPE_TRIGGER}
            result = {"capabilities": capabilities,
                      "serverInfo": {"name": "robot-companion-backend", "version": __version__}}
            if configured:
                # What the services apply, so the client can show it; problems never stop the server.
                summary = self.workspace.config.summary()
                summary["errors"] = self.workspace.configured_variables()[2]
                for error in summary["errors"]:
                    print(f"Robot configuration: {error}", file=sys.stderr)
                result["robotConfiguration"] = summary
            return result
        if not self.initialized:
            raise RequestError(-32002, "Server not initialized")
        if self.shutdown:
            raise RequestError(-32600, "Server shut down")
        if method == "shutdown":
            self.shutdown = True
            self.diagnostic_worker.close()
            return None
        if method in ("initialized", "$/cancelRequest", "$/setTrace"):
            return None
        if method == "textDocument/didOpen":
            self.diagnostic_worker.invalidate()
            doc = params["textDocument"]
            self.workspace.open(doc["uri"], doc["text"], doc["version"])
            self.publish()
            return None
        if method == "textDocument/didChange":
            self.diagnostic_worker.invalidate()
            doc = params["textDocument"]
            changes = params["contentChanges"]
            if not changes or any("range" in change for change in changes):
                raise ValueError("Full document changes are required")
            self.workspace.open(doc["uri"], changes[-1]["text"], doc["version"])
            self.publish()
            return None
        if method == "textDocument/didClose":
            self.diagnostic_worker.invalidate()
            uri = params["textDocument"]["uri"]
            self.workspace.close(uri)
            self.semantic_results.forget(uri_path(uri))
            self.notify("textDocument/publishDiagnostics", {"uri": uri, "diagnostics": []})
            self.publish()
            return None
        if method == "workspace/didChangeWatchedFiles":
            self.diagnostic_worker.invalidate()
            self.publish()
            return None
        if method == "textDocument/definition":
            return self.workspace.definition(params["textDocument"]["uri"], params["position"])
        if method == "textDocument/hover":
            return features.hover(self.workspace, params["textDocument"]["uri"], params["position"],
                                  self.hover_markup)
        if method == "textDocument/completion":
            return features.completion(self.workspace, params["textDocument"]["uri"], params["position"])
        if method == "textDocument/signatureHelp":
            return features.signature_help(self.workspace, params["textDocument"]["uri"], params["position"],
                                           self.signature_markup)
        if method == "textDocument/references":
            return navigation.references(self.workspace, params["textDocument"]["uri"], params["position"],
                                         bool((params.get("context") or {}).get("includeDeclaration")))
        if method == "textDocument/prepareRename":
            return navigation.prepare_rename(self.workspace, params["textDocument"]["uri"], params["position"])
        if method == "textDocument/rename":
            edit = navigation.rename(self.workspace, params["textDocument"]["uri"], params["position"],
                                     params["newName"])
            if not self.document_changes:
                return edit
            return {"documentChanges": [
                {"textDocument": {"uri": uri, "version": self.workspace.version(uri)}, "edits": edits}
                for uri, edits in edit["changes"].items()]}
        if method == "robotCompanion/documentKeywords":
            return explorer.document_keywords(self.workspace, params["textDocument"]["uri"])
        if method == "textDocument/documentSymbol":
            return navigation.document_symbols(self.workspace, params["textDocument"]["uri"], self.hierarchical)
        if method == "workspace/symbol":
            return navigation.workspace_symbols(self.workspace, params.get("query", ""))
        if method == "textDocument/semanticTokens/full":
            return semantic_tokens.full(self.workspace, params["textDocument"]["uri"], self.semantic_results)
        if method == "textDocument/semanticTokens/full/delta":
            return semantic_tokens.delta(self.workspace, params["textDocument"]["uri"], params.get("previousResultId"),
                                         self.semantic_results)
        if method == "textDocument/semanticTokens/range":
            return semantic_tokens.in_range(self.workspace, params["textDocument"]["uri"], params["range"])
        if method == "textDocument/inlayHint":
            return inlay_hints.hints(self.workspace, params["textDocument"]["uri"], params["range"])
        if method == "textDocument/codeAction" and self.code_actions:
            context = params.get("context") or {}
            # An automatic lightbulb with no diagnostics has no quick fix to offer.
            # Explicit source actions (including on save) still inspect the source.
            if context.get("triggerKind") == 2 and not context.get("diagnostics") and \
                    not any(kind != "quickfix" for kind in context.get("only") or ()):
                return []
            return diagnostics.code_actions(self.workspace, params["textDocument"]["uri"], params["range"],
                                            (params.get("context") or {}).get("only"), self.source_actions,
                                            self.versioned_edits)
        if method == "textDocument/formatting" and self.formatter:
            return formatting.format_document(self.workspace, params["textDocument"]["uri"])
        if method == "textDocument/rangeFormatting" and self.formatter:
            return formatting.format_range(self.workspace, params["textDocument"]["uri"], params["range"])
        if method == "textDocument/onTypeFormatting" and self.formatter:
            return formatting.format_on_type(self.workspace, params["textDocument"]["uri"], params["position"],
                                             params["ch"])
        raise RequestError(-32601, f"Method not implemented: {method}")

    def run(self):
        messages = Messages(self.stream).start()
        try:
            return self.run_messages(messages)
        finally:
            messages.close()

    def run_messages(self, messages):
        while True:
            try:
                incoming = messages.take()
            except ProtocolError as exc:
                self.stream.write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
                return 1
            if incoming is None:
                return 0 if self.shutdown else 1
            message = incoming.value
            if incoming.error is not None:
                code, text = incoming.error
                self.stream.write({"jsonrpc": "2.0", "id": message.get("id"),
                                   "error": {"code": code, "message": text}})
                continue
            request = "id" in message
            request_id = message.get("id")
            reply = None
            cancellable = request and message.get("method") not in ("initialize", "shutdown")
            try:
                if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                    raise RequestError(-32600, "Invalid JSON-RPC request")
                if message["method"] == "exit":
                    return 0 if self.shutdown else 1
                params = message.get("params", {})
                if not isinstance(params, dict):
                    raise RequestError(-32602, "Object parameters required")
                if request and message["method"].startswith("$/"):
                    raise RequestError(-32601, "Implementation-specific notifications cannot be requests")
                if cancellable:
                    with cancellation.request(incoming.cancellation):
                        result = self.dispatch(message["method"], params)
                else:
                    result = self.dispatch(message["method"], params)
                if request:
                    reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
            except (RequestError, navigation.RequestFailed, cancellation.RequestCancelled, ValueError,
                    KeyError, TypeError, OSError, SyntaxError) as exc:
                code = exc.code if isinstance(exc, (RequestError, navigation.RequestFailed,
                                                    cancellation.RequestCancelled)) else -32602
                if request:
                    reply = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": str(exc)}}
                else:
                    self.notify("window/logMessage", {"type": 1, "message": str(exc)})
            except Exception as exc:
                print(f"Language request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                if request:
                    reply = {"jsonrpc": "2.0", "id": request_id,
                             "error": {"code": -32603, "message": "Internal backend error; see stderr"}}
            finally:
                cancelled = messages.finish(incoming)
            if reply is not None:
                if cancellable and cancelled:
                    reply = {"jsonrpc": "2.0", "id": request_id,
                             "error": {"code": -32800, "message": "Request cancelled"}}
                # Complete admission before writing: a client can reuse an id as
                # soon as it receives this response. Only this thread writes replies.
                self.stream.write(reply)


def serve(reader, writer):
    server = LanguageServer(FramedStream(reader, writer))
    try:
        return server.run()
    finally:
        server.diagnostic_worker.close()

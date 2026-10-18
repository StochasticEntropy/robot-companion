"""Synchronous LSP 3.17 subset; all replies use the current document and disk snapshot."""

import importlib.util
from pathlib import Path
import sys

from . import __version__
from . import features
from . import navigation
from .protocol import FramedStream, ProtocolError
from .workspace import Workspace, uri_path


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

    def notify(self, method, params):
        self.stream.write({"jsonrpc": "2.0", "method": method, "params": params})

    def publish(self):
        for path, (version, _) in self.workspace.documents.items():
            self.notify("textDocument/publishDiagnostics", {
                "uri": path.as_uri(), "version": version,
                "diagnostics": self.workspace.diagnostics(path.as_uri()),
            })

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
        if method == "initialize":
            if self.initialized:
                raise RequestError(-32600, "Already initialized")
            if importlib.util.find_spec("robot") is None:
                raise RequestError(-32002, "Robot Framework 7.5 is required; use the approved backend runtime")
            capabilities = params.get("capabilities") or {}
            encodings = (capabilities.get("general") or {}).get("positionEncodings") or ["utf-16"]
            if "utf-16" not in encodings:
                raise RequestError(-32602, "Only UTF-16 positions are supported")
            text_document = capabilities.get("textDocument") or {}
            self.workspace.roots = self.roots(params)
            # RenameOptions and nested DocumentSymbols only for clients that declare support.
            prepare = bool((text_document.get("rename") or {}).get("prepareSupport"))
            self.hierarchical = bool((text_document.get("documentSymbol") or {}).get(
                "hierarchicalDocumentSymbolSupport"))
            self.hover_markup = features.Markup((text_document.get("hover") or {}).get("contentFormat"))
            self.signature_markup = features.Markup(((text_document.get("signatureHelp") or {}).get(
                "signatureInformation") or {}).get("documentationFormat"))
            self.initialized = True
            # Only implemented features: no completion resolve, snippets or commit characters.
            return {"capabilities": {
                "positionEncoding": "utf-16", "textDocumentSync": {"openClose": True, "change": 1},
                "definitionProvider": True, "hoverProvider": True,
                "completionProvider": {"triggerCharacters": ["{", "."], "resolveProvider": False},
                "signatureHelpProvider": {"triggerCharacters": [" ", "\t"], "retriggerCharacters": ["="]},
                "referencesProvider": True, "renameProvider": {"prepareProvider": True} if prepare else True,
                "documentSymbolProvider": True, "workspaceSymbolProvider": True},
                    "serverInfo": {"name": "robot-companion-backend", "version": __version__}}
        if not self.initialized:
            raise RequestError(-32002, "Server not initialized")
        if self.shutdown:
            raise RequestError(-32600, "Server shut down")
        if method == "shutdown":
            self.shutdown = True
            return None
        if method in ("initialized", "$/cancelRequest", "$/setTrace"):
            return None
        if method == "textDocument/didOpen":
            doc = params["textDocument"]
            self.workspace.open(doc["uri"], doc["text"], doc["version"])
            self.publish()
            return None
        if method == "textDocument/didChange":
            doc = params["textDocument"]
            changes = params["contentChanges"]
            if not changes or any("range" in change for change in changes):
                raise ValueError("Full document changes are required")
            self.workspace.open(doc["uri"], changes[-1]["text"], doc["version"])
            self.publish()
            return None
        if method == "textDocument/didClose":
            uri = params["textDocument"]["uri"]
            self.workspace.close(uri)
            self.notify("textDocument/publishDiagnostics", {"uri": uri, "diagnostics": []})
            self.publish()
            return None
        if method == "workspace/didChangeWatchedFiles":
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
            return navigation.rename(self.workspace, params["textDocument"]["uri"], params["position"],
                                     params["newName"])
        if method == "textDocument/documentSymbol":
            return navigation.document_symbols(self.workspace, params["textDocument"]["uri"], self.hierarchical)
        if method == "workspace/symbol":
            return navigation.workspace_symbols(self.workspace, params.get("query", ""))
        raise RequestError(-32601, f"Method not implemented: {method}")

    def run(self):
        while True:
            try:
                message = self.stream.read()
            except ProtocolError as exc:
                self.stream.write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
                return 1
            if message is None:
                return 0 if self.shutdown else 1
            request = "id" in message
            request_id = message.get("id")
            try:
                if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                    raise RequestError(-32600, "Invalid JSON-RPC request")
                if message["method"] == "exit":
                    return 0 if self.shutdown else 1
                params = message.get("params", {})
                if not isinstance(params, dict):
                    raise RequestError(-32602, "Object parameters required")
                result = self.dispatch(message["method"], params)
                if request:
                    self.stream.write({"jsonrpc": "2.0", "id": request_id, "result": result})
            except (RequestError, navigation.RequestFailed, ValueError, KeyError, TypeError, OSError,
                    SyntaxError) as exc:
                code = exc.code if isinstance(exc, (RequestError, navigation.RequestFailed)) else -32602
                if request:
                    self.stream.write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": str(exc)}})
                else:
                    self.notify("window/logMessage", {"type": 1, "message": str(exc)})
            except Exception as exc:
                print(f"Language request failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                if request:
                    self.stream.write({"jsonrpc": "2.0", "id": request_id,
                                       "error": {"code": -32603, "message": "Internal backend error; see stderr"}})


def serve(reader, writer):
    return LanguageServer(FramedStream(reader, writer)).run()

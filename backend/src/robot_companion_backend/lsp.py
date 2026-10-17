"""Synchronous LSP 3.17 subset; all replies use the current document snapshot."""

import importlib.util
import sys

from . import __version__
from .protocol import FramedStream, ProtocolError
from .workspace import Workspace


class RequestError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class LanguageServer:
    def __init__(self, stream):
        self.stream = stream
        self.workspace = Workspace()
        self.initialized = False
        self.shutdown = False

    def notify(self, method, params):
        self.stream.write({"jsonrpc": "2.0", "method": method, "params": params})

    def publish(self):
        for path, (version, _) in self.workspace.documents.items():
            self.notify("textDocument/publishDiagnostics", {
                "uri": path.as_uri(), "version": version,
                "diagnostics": self.workspace.diagnostics(path.as_uri()),
            })

    def dispatch(self, method, params):
        if method == "initialize":
            if self.initialized:
                raise RequestError(-32600, "Already initialized")
            if importlib.util.find_spec("robot") is None:
                raise RequestError(-32002, "Robot Framework 7.5 is required; use the approved backend runtime")
            encodings = params.get("capabilities", {}).get("general", {}).get("positionEncodings", ["utf-16"])
            if "utf-16" not in encodings:
                raise RequestError(-32602, "Only UTF-16 positions are supported")
            self.initialized = True
            return {"capabilities": {"positionEncoding": "utf-16", "textDocumentSync": {
                "openClose": True, "change": 1}, "definitionProvider": True},
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
            except (RequestError, ValueError, KeyError, TypeError, OSError, SyntaxError) as exc:
                code = exc.code if isinstance(exc, RequestError) else -32602
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

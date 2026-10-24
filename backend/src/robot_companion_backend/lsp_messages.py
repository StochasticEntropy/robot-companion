"""Bounded intake keeps cancellation readable and navigation ahead of queued passive queries."""

from collections import deque
from dataclasses import dataclass, field
import json
import os
import select
import threading

from .protocol import ProtocolError


PASSIVE_DOCUMENT_REQUESTS = frozenset((
    "textDocument/hover", "textDocument/inlayHint", "textDocument/documentSymbol",
    "textDocument/semanticTokens/full", "textDocument/semanticTokens/full/delta",
    "textDocument/semanticTokens/range",
))
MAX_NAVIGATION_BURST = 4


class PipeReader:
    """Interruptible stdio reads; never hold Python's buffered-stdin lock at exit."""

    def __init__(self, reader):
        self.fd = reader.fileno()
        self.stopped = threading.Event()
        self.buffer = bytearray()
        self.peek = None
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            import msvcrt

            self.handle = msvcrt.get_osfhandle(self.fd)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.peek = kernel.PeekNamedPipe
            self.peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                  wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD]
            self.peek.restype = wintypes.BOOL
            kernel.GetFileType.argtypes = [wintypes.HANDLE]
            kernel.GetFileType.restype = wintypes.DWORD
            self.disk = kernel.GetFileType(self.handle) == 1

    def chunk(self):
        while not self.stopped.is_set():
            count = 65536
            if self.peek is not None:
                if not self.disk:
                    import ctypes
                    from ctypes import wintypes

                    available = wintypes.DWORD()
                    if not self.peek(self.handle, None, 0, None, ctypes.byref(available), None):
                        error = ctypes.get_last_error()
                        if error in (109, 232):  # writer closed its pipe
                            return b""
                        raise OSError(error, "Cannot read LSP input pipe")
                    count = min(count, available.value)
                    if not count:
                        self.stopped.wait(.05)
                        continue
            elif not select.select([self.fd], [], [], .05)[0]:
                continue
            return os.read(self.fd, count)
        return b""

    def readline(self, limit):
        while True:
            newline = self.buffer.find(b"\n", 0, limit)
            count = newline + 1 if newline >= 0 else min(len(self.buffer), limit)
            if newline >= 0 or len(self.buffer) >= limit:
                break
            chunk = self.chunk()
            if not chunk:
                break
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def read(self, size):
        if not self.buffer:
            self.buffer.extend(self.chunk())
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result


@dataclass
class Message:
    value: dict
    size: int
    cancellation: threading.Event = field(default_factory=threading.Event)
    queued: bool = True
    error: tuple | None = None

    @property
    def cancelled(self):
        return self.cancellation.is_set()


class Messages:
    """Only intake/cancellation run on the reader; workspace mutations remain FIFO.

    Requests exceeding admission receive a busy error without executing. Waiting for a
    queue slot here would hide cancellation frames behind the very work they stop.
    Notifications cannot be discarded: exceeding their bounded storage fails the
    session explicitly rather than silently losing document changes.
    """

    def __init__(self, stream, max_requests=64, max_messages=256, max_bytes=16 * 1024 * 1024):
        self.stream = stream
        self.max_requests, self.max_messages, self.max_bytes = max_requests, max_messages, max_bytes
        self.condition = threading.Condition()
        self.queue, self.pending = deque(), {}
        self.size = 0
        self.navigation_burst = 0
        self.done = self.closed = False
        self.error = None
        self.input = None
        try:
            self.input = PipeReader(stream.reader)
        except (AttributeError, OSError, ValueError):
            pass  # In-memory framed protocol tests do not own an OS pipe.
        if self.input is not None:
            stream.reader = self.input
        self.reader = threading.Thread(target=self.read, name="lsp-input", daemon=True)

    @staticmethod
    def request_id(value):
        key = value.get("id")
        return (type(key), key) if "id" in value and type(key) in (str, int, type(None)) else None

    def start(self):
        self.reader.start()
        return self

    @staticmethod
    def rejection(value, code, text):
        # Do not retain an obsolete request's large document/parameter payload.
        value = {"jsonrpc": "2.0", "id": value.get("id")}
        return Message(value, len(json.dumps(value).encode("utf-8")), error=(code, text))

    def cancel(self, value):
        params = value.get("params")
        key = self.request_id(params) if isinstance(params, dict) else None
        with self.condition:
            message = self.pending.get(key) if key is not None else None
            if message is not None:
                message.cancellation.set()
                if message.queued:
                    rejected = self.rejection(message.value, -32800, "Request cancelled")
                    self.size += rejected.size - message.size
                    message.value, message.size, message.error = rejected.value, rejected.size, rejected.error
                    del self.pending[key]

    def read(self):
        try:
            while (value := self.stream.read()) is not None:
                if value.get("jsonrpc") == "2.0" and value.get("method") == "$/cancelRequest" and "id" not in value:
                    self.cancel(value)
                    continue
                size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
                key = self.request_id(value)
                with self.condition:
                    if self.closed:
                        return
                    if key is not None and key in self.pending:
                        raise ProtocolError("Duplicate outstanding request id")
                    if "id" in value and len(self.pending) >= self.max_requests:
                        message = self.rejection(value, -32001, "Language server busy; request was not executed")
                    else:
                        message = Message(value, size)
                    if len(self.queue) >= self.max_messages or self.size + message.size > self.max_bytes:
                        raise ProtocolError("Language input queue limit exceeded")
                    if key is not None and message.error is None:
                        self.pending[key] = message
                    self.queue.append(message)
                    self.size += message.size
                    self.condition.notify_all()
                if value.get("method") == "exit":
                    return
        except Exception as exc:
            with self.condition:
                self.error = ProtocolError(f"Language input failed: {type(exc).__name__}: {exc}")
                for message in self.pending.values():
                    message.cancellation.set()
        finally:
            with self.condition:
                self.done = True
                self.condition.notify_all()

    @classmethod
    def document_query(cls, message):
        """Recognized query envelopes; the dispatcher still validates method parameters."""
        value = message.value
        method = value.get("method")
        params = value.get("params")
        document = params.get("textDocument") if isinstance(params, dict) else None
        uri = document.get("uri") if isinstance(document, dict) else None
        if message.error is None and value.get("jsonrpc") == "2.0" and cls.request_id(value) is not None \
                and isinstance(method, str) and isinstance(uri, str) and uri.startswith("file:") and "\x00" not in uri:
            return method, uri
        return None, None

    def navigation_index(self):
        """One same-document definition may pass only an uninterrupted passive prefix.

        Definitions also serve background source lookups; this is query priority,
        not an assertion of user intent. No frame crosses a notification, mutation,
        unknown request, invalid query envelope or different document. The remaining
        requests retain their order, including semantic full/delta cache operations.
        """
        if self.navigation_burst >= MAX_NAVIGATION_BURST:
            return 0
        prefix_uri = None
        for index, message in enumerate(self.queue):
            method, uri = self.document_query(message)
            if prefix_uri is not None and uri != prefix_uri:
                break
            if method == "textDocument/definition":
                return index
            if method not in PASSIVE_DOCUMENT_REQUESTS:
                break
            prefix_uri = uri
        return 0

    def take(self):
        with self.condition:
            while not self.queue and not self.done and not self.closed:
                self.condition.wait()
            if self.error:
                raise self.error
            if self.queue:
                index = self.navigation_index()
                if index:
                    message = self.queue[index]
                    del self.queue[index]
                    self.navigation_burst += 1
                else:
                    message = self.queue.popleft()
                    self.navigation_burst = 0
                message.queued = False
                self.size -= message.size
                return message
            return None

    def finish(self, message):
        with self.condition:
            key = self.request_id(message.value)
            if key is not None and self.pending.get(key) is message:
                del self.pending[key]
            return message.cancelled

    def close(self):
        if self.input is not None:
            self.input.stopped.set()
        with self.condition:
            self.closed = True
            for message in self.pending.values():
                message.cancellation.set()
            self.queue.clear()
            self.pending.clear()
            self.size = 0
            self.condition.notify_all()
        self.reader.join(timeout=1)
        if self.reader.is_alive():
            raise RuntimeError("Language input reader did not stop")

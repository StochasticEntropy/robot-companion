"""Bounded byte framing shared by stdio LSP and DAP (no logs on stdout)."""

import json
import threading

MAX_CONTENT_BYTES = 8 * 1024 * 1024
MAX_HEADER_BYTES = 8192


class ProtocolError(ValueError):
    pass


class FramedStream:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.lock = threading.Lock()

    def read(self):
        headers = {}
        size = 0
        while True:
            line = self.reader.readline(MAX_HEADER_BYTES + 1)
            if not line and not size:
                return None
            size += len(line)
            if not line or size > MAX_HEADER_BYTES or not line.endswith(b"\r\n"):
                raise ProtocolError("Incomplete or oversized CRLF header")
            if line == b"\r\n":
                break
            try:
                key, value = line[:-2].decode("ascii").split(":", 1)
            except (UnicodeDecodeError, ValueError) as exc:
                raise ProtocolError("Malformed header") from exc
            key = key.lower().strip()
            if key in headers:
                raise ProtocolError("Duplicate header")
            headers[key] = value.strip()
        length = headers.get("content-length", "")
        if not length.isascii() or not length.isdecimal():
            raise ProtocolError("Content-Length must be an unsigned decimal")
        length = int(length)
        if not 0 < length <= MAX_CONTENT_BYTES:
            raise ProtocolError("Content-Length outside permitted range")
        chunks = []
        remaining = length
        while remaining:
            part = self.reader.read(remaining)
            if not part:
                raise ProtocolError("Incomplete message body")
            chunks.append(part)
            remaining -= len(part)
        try:
            result = json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProtocolError("Invalid UTF-8 JSON body") from exc
        if not isinstance(result, dict):
            raise ProtocolError("Message must be an object")
        return result

    def write(self, message):
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(payload) > MAX_CONTENT_BYTES:
            raise ProtocolError("Outgoing message exceeds permitted size")
        with self.lock:
            self.writer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii"))
            self.writer.write(payload)
            self.writer.flush()

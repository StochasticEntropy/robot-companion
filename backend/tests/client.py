"""Headless real-process protocol driver with bounded waits and owned cleanup."""

import os
import queue
import subprocess
import sys
import threading
import time

from robot_companion_backend.protocol import FramedStream


class Client:
    def __init__(self, service="lsp"):
        self.process = subprocess.Popen([sys.executable, "-m", "robot_companion_backend", service],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=os.environ.copy())
        self.stream = FramedStream(self.process.stdout, self.process.stdin)
        self.messages = queue.Queue()
        self.transcript = []
        self.stderr = bytearray()
        self.counter = 0
        self.notifications = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._errors, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def _read(self):
        try:
            while (message := self.stream.read()) is not None:
                self.messages.put(message)
        except Exception as exc:
            self.messages.put(exc)
        finally:
            self.messages.put(EOFError("Backend stdout closed"))

    def _errors(self):
        while data := self.process.stderr.read(4096):
            self.stderr.extend(data)

    def send(self, method, params=None, request_id=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if request_id is not None:
            message["id"] = request_id
        self.transcript.append({"sent": message})
        self.stream.write(message)

    def request(self, method, params=None):
        self.counter += 1
        self.send(method, params, self.counter)
        deadline = time.monotonic() + 10
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Backend request timed out: {method}")
            message = self.messages.get(timeout=remaining)
            if isinstance(message, Exception):
                raise message
            self.transcript.append({"received": message})
            if message.get("id") == self.counter:
                if "error" in message:
                    raise AssertionError(message)
                return message["result"]
            self.notifications.append(message)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()

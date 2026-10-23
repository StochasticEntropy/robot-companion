"""Real framed intake saturation, cooperative graph cancellation and owned shutdown."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from client import Client, client_uri, uri_file
from robot_companion_backend.lsp import LanguageServer
from robot_companion_backend.protocol import FramedStream, ProtocolError
from robot_companion_backend.workspace import Workspace


def controlled_server(directory):
    root = Path(directory)

    class ObservedStream(FramedStream):
        def read(self):
            value = super().read()
            if value and value.get("id") == 103:
                (root / "received").touch()
            if value and value.get("method") == "fixture/intakeBarrier":
                (root / "intake").touch()
            return value

    class HeldWorkspace(Workspace):
        held = False

        def graph(self, path):
            if not self.held:
                self.held = True
                (root / "active").touch()
                deadline = time.monotonic() + 8
                while not (root / "release").exists():
                    # Exercise the real source-cache hit path inside request dispatch.
                    # Only cooperative source cancellation may end this loop normally.
                    self.source(path)
                    if time.monotonic() > deadline:
                        raise RuntimeError("Active graph did not observe cancellation")
                    time.sleep(.002)
            return super().graph(path)

    class ControlledServer(LanguageServer):
        calls = 0

        def handle(self, method, params):
            if method == "shutdown" and (root / "hold-shutdown").exists():
                (root / "shutdown-active").touch()
                deadline = time.monotonic() + 8
                while not (root / "release").exists():
                    self.workspace.source(root / "safe.robot")
                    if time.monotonic() > deadline:
                        raise RuntimeError("Test did not release active shutdown")
                    time.sleep(.002)
            if method == "textDocument/codeAction":
                self.calls += 1
                return []
            result = super().handle(method, params)
            if method == "textDocument/definition":
                (root / "observed.json").write_text(json.dumps({
                    "passiveCalls": self.calls,
                    "version": self.workspace.version(params["textDocument"]["uri"]),
                }), encoding="utf-8")
            return result

    server_type = ControlledServer
    if (root / "discovery-service").exists():
        from robot_companion_backend.discovery import DiscoveryServer, METHOD

        class ControlledDiscovery(DiscoveryServer):
            held = False

            def dispatch(self, method, params):
                if method == METHOD and not self.held:
                    self.held = True
                    (root / "active").touch()
                    deadline = time.monotonic() + 8
                    while not (root / "release").exists():
                        self.workspace.source(root / "safe.robot")
                        if time.monotonic() > deadline:
                            raise RuntimeError("Discovery did not observe cancellation")
                        time.sleep(.002)
                return super().dispatch(method, params)

        server_type = ControlledDiscovery
    server = server_type(ObservedStream(sys.stdin.buffer, sys.stdout.buffer))
    server.workspace = HeldWorkspace()
    try:
        return server.run()
    finally:
        server.diagnostic_worker.close()


class CancellationTests(unittest.TestCase):
    def wait_until(self, predicate, message, timeout=3):
        deadline = time.monotonic() + timeout
        while not predicate():
            self.assertLess(time.monotonic(), deadline, message)
            time.sleep(.005)

    def pipe_messages(self, **limits):
        from robot_companion_backend.lsp_messages import Messages

        reader_fd, writer_fd = os.pipe()
        reader = os.fdopen(reader_fd, "rb", buffering=0)
        writer = os.fdopen(writer_fd, "wb", buffering=0)
        output = io.BytesIO()
        messages = Messages(FramedStream(reader, output), **limits).start()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        self.addCleanup(messages.close)
        return messages, FramedStream(None, writer), output

    def test_saturated_intake_reads_cancels_and_preserves_change_before_fresh_request(self):
        messages, sender, output = self.pipe_messages(max_requests=2, max_messages=8, max_bytes=4096)
        sender.write({"jsonrpc": "2.0", "method": "fixture/active", "id": 1})
        active = messages.take()
        sender.write({"jsonrpc": "2.0", "method": "fixture/queued", "id": 2,
                      "params": {"obsolete": "x" * 1000}})
        sender.write({"jsonrpc": "2.0", "method": "fixture/excess", "id": 3})
        for request_id in (2, 1, "unknown", ["invalid"], True):
            sender.write({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": request_id}})
        sender.write({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": []})
        sender.write({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {"version": 7}})
        sender.write({"jsonrpc": "2.0", "method": "textDocument/definition", "id": 4})
        self.wait_until(lambda: active.cancelled and any(item.value.get("id") == 4 for item in messages.queue),
                        "Saturation hid the cancellation or fresh request from intake")
        self.assertEqual(output.getvalue(), b"", "Only the dispatcher may write responses")
        with messages.condition:
            self.assertEqual(set(messages.pending), {(int, 1), (int, 4)})
            self.assertLess(messages.size, 1000, "Cancelled payload must be released")
        queued, excess, change, fresh = [messages.take() for _ in range(4)]
        self.assertEqual((queued.value["id"], queued.error[0]), (2, -32800))
        self.assertEqual((excess.value["id"], excess.error[0]), (3, -32001))
        self.assertEqual(change.value["method"], "textDocument/didChange")
        self.assertEqual(change.value["params"]["version"], 7)
        self.assertEqual(fresh.value["id"], 4)
        self.assertTrue(messages.finish(active))
        for item in (queued, excess, change, fresh):
            messages.finish(item)
        messages.close()  # The pipe writer intentionally remains open.
        self.assertFalse(messages.reader.is_alive())
        self.assertEqual((len(messages.pending), len(messages.queue), messages.size), (0, 0, 0))

    def test_notification_exhaustion_is_fatal_and_cancels_active_without_dropping_changes(self):
        for limits, payload in (({"max_messages": 2}, {}), ({"max_bytes": 180}, {"text": "x" * 200})):
            with self.subTest(limits=limits):
                messages, sender, output = self.pipe_messages(**limits)
                sender.write({"jsonrpc": "2.0", "id": 1, "method": "fixture/active"})
                active = messages.take()
                for version in range(3):
                    sender.write({"jsonrpc": "2.0", "method": "textDocument/didChange",
                                  "params": {"version": version, **payload}})
                self.wait_until(lambda: messages.done, "Notification exhaustion must end intake")
                self.assertTrue(active.cancelled)
                with self.assertRaisesRegex(ProtocolError, "queue limit"):
                    messages.take()
                self.assertLessEqual(len(messages.queue), messages.max_messages)
                self.assertLessEqual(messages.size, messages.max_bytes)
                self.assertEqual(output.getvalue(), b"")
                messages.close()
                self.assertFalse(messages.reader.is_alive())

    def test_request_form_cancel_is_queued_without_cancelling_its_target(self):
        messages, sender, output = self.pipe_messages()
        sender.write({"jsonrpc": "2.0", "method": "fixture/active", "id": 1})
        active = messages.take()
        sender.write({"jsonrpc": "2.0", "method": "$/cancelRequest", "id": 2, "params": {"id": 1}})
        sender.write({"jsonrpc": "2.0", "method": "fixture/intakeBarrier"})
        self.wait_until(lambda: len(messages.queue) == 2, "Request-form cancellation disappeared in intake")
        self.assertFalse(active.cancelled, "Only notification-form cancellation may cancel another request")
        request, barrier = messages.take(), messages.take()
        self.assertEqual(request.value, {"jsonrpc": "2.0", "method": "$/cancelRequest", "id": 2,
                                         "params": {"id": 1}})
        self.assertIsNone(request.error)
        self.assertEqual(barrier.value["method"], "fixture/intakeBarrier")
        self.assertEqual(output.getvalue(), b"")
        for item in (active, request, barrier):
            messages.finish(item)

    def test_real_request_form_cancel_returns_method_error_and_keeps_session_usable(self):
        client = Client()
        try:
            client.request("initialize", {"capabilities": {}})
            with self.assertRaises(AssertionError) as rejected:
                client.request("$/cancelRequest", {"id": "unknown"})
            self.assertEqual(rejected.exception.args[0]["error"]["code"], -32601)
            self.assertIsNone(client.request("shutdown"))
            client.send("exit")
            self.assertEqual(client.process.wait(timeout=3), 0)
        finally:
            client.close()
        self.assertFalse(client.forced_cleanup)

    def test_active_shutdown_completes_despite_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "hold-shutdown").touch()
            (root / "safe.robot").write_text("*** Test Cases ***\nExample\n    No Operation\n", encoding="utf-8")
            client = Client(argv=[sys.executable, __file__, "serve", directory])
            try:
                client.request("initialize", {"capabilities": {}})
                client.send("shutdown", {}, 2)
                self.wait_until(lambda: (root / "shutdown-active").exists(), "Shutdown never became active")
                client.send("$/cancelRequest", {"id": 2})
                client.send("fixture/intakeBarrier")
                self.wait_until(lambda: (root / "intake").exists(), "Intake did not process active shutdown cancellation")
                (root / "release").touch()
                reply = client.messages.get(timeout=3)
                self.assertEqual(reply, {"jsonrpc": "2.0", "id": 2, "result": None})
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=3), 0)
            finally:
                (root / "release").touch()
                client.close()
            self.assertFalse(client.forced_cleanup)

    def test_discovery_inherited_run_cancels_active_source_work_then_discovers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "discovery-service").touch()
            path = root / "safe.robot"
            path.write_text("*** Test Cases ***\nExample\n    No Operation\n", encoding="utf-8")
            method = "robotCompanion/discoverTests"
            params = {"workspaceUri": client_uri(root)}
            client = Client(argv=[sys.executable, __file__, "serve", directory])
            try:
                initialized = client.request("initialize", {"capabilities": {}})
                self.assertEqual(initialized["capabilities"]["robotCompanionDiscovery"]["version"], 1)
                client.send(method, params, 2)
                self.wait_until(lambda: (root / "active").exists(), "Discovery never entered source work")
                client.send("$/cancelRequest", {"id": 2})
                reply = client.messages.get(timeout=3)
                self.assertEqual(reply["id"], 2)
                self.assertEqual(reply["error"]["code"], -32800)
                self.assertFalse((root / "release").exists(), "Discovery cancellation required manual release")
                client.counter = 2
                result = client.request(method, params)
                self.assertEqual(result["version"], 1)
                self.assertFalse(result.get("errors"))
                suite, = result["items"]
                test, = suite["children"]
                self.assertEqual(uri_file(suite["uri"]), path)
                self.assertEqual((test["label"], test["kind"]), ("Example", "test"))
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=3), 0)
            finally:
                (root / "release").touch()
                client.close()
            self.assertFalse(client.forced_cleanup)

    def test_real_saturated_server_cancels_active_graph_and_uses_latest_overlay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            resource = root / "steps.resource"
            resource.write_text("*** Keywords ***\nOriginal Step\n    No Operation\nFresh Step\n    No Operation\n",
                                encoding="utf-8")
            path = root / "safe.robot"
            text = "*** Settings ***\nResource    steps.resource\n*** Test Cases ***\nExample\n    Original Step\n"
            path.write_text(text, encoding="utf-8")
            uri = client_uri(path)
            params = {"textDocument": {"uri": uri}, "position": {"line": 4, "character": 7}}
            client = Client(argv=[sys.executable, __file__, "serve", directory])
            try:
                client.request("initialize", {"rootUri": client_uri(root), "capabilities": {}})
                client.send("textDocument/didOpen", {"textDocument": {
                    "uri": uri, "version": 1, "languageId": "robotframework", "text": text}})
                client.send("textDocument/definition", params, 2)
                self.wait_until(lambda: (root / "active").exists(), "Definition never entered the real graph")
                for request_id in range(3, 103):
                    client.send("textDocument/codeAction", {}, request_id)
                # Cancel queued work first, so dispatch cannot race the cancellation batch.
                for request_id in range(3, 103):
                    client.send("$/cancelRequest", {"id": request_id})
                started = time.monotonic()
                client.send("$/cancelRequest", {"id": 2})
                client.send("$/cancelRequest", {"id": ["invalid"]})
                client.send("$/cancelRequest", {"id": "unknown"})
                client.send("textDocument/didChange", {"textDocument": {"uri": uri, "version": 7},
                            "contentChanges": [{"text": text.replace("Original Step", "Fresh Step")}]})
                client.send("textDocument/definition", params, 103)
                self.wait_until(lambda: (root / "received").exists(), "Fresh F12 was hidden behind saturation")
                replies = {}
                deadline = started + 3
                while len(replies) < 102:
                    message = client.messages.get(timeout=max(.001, deadline - time.monotonic()))
                    self.assertIsInstance(message, dict)
                    if "id" not in message:
                        continue
                    self.assertNotIn(message["id"], replies, "Exactly one response per request")
                    replies[message["id"]] = message
                    self.assertLess(time.monotonic(), deadline, "Cancelled work delayed fresh F12")
                self.assertEqual(set(replies), set(range(2, 104)))
                self.assertEqual(replies[2]["error"]["code"], -32800)
                codes = [replies[index]["error"]["code"] for index in range(3, 103)]
                self.assertEqual(codes.count(-32001), 37, "64 admitted requests include the active graph")
                self.assertEqual(codes.count(-32800), 63)
                location, = replies[103]["result"]
                self.assertEqual(uri_file(location["uri"]), resource)
                self.assertEqual(location["range"]["start"]["line"], 3)
                self.assertEqual(json.loads((root / "observed.json").read_text(encoding="utf-8")),
                                 {"passiveCalls": 0, "version": 7})
                self.assertFalse((root / "release").exists(), "Success may not rely on manual graph release")
                client.counter = 103
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=3), 0)
            finally:
                (root / "release").touch()  # Failure-only cleanup of our own synthetic server.
                client.close()
            self.assertFalse(client.forced_cleanup)

    def test_unexpected_json_conversion_error_after_shutdown_is_not_healthy_eof(self):
        client = Client()
        try:
            client.request("initialize", {"capabilities": {}})
            client.request("shutdown")
            body = b'{"jsonrpc":"2.0","id":' + b"9" * 5000 + b',"method":"fixture/noop"}'
            client.process.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
            client.process.stdin.flush()
            # stdin stays open: a failed intake must wake dispatch and stop its reader.
            code = client.process.wait(timeout=4)
            client.error_reader.join(timeout=1)
            self.assertGreater(code, 0, client.stderr.decode(errors="replace"))
            self.assertNotIn(b"Exception in thread", client.stderr)
            self.assertNotIn(b"Fatal Python error", client.stderr)
            self.assertNotIn(b"_enter_buffered_busy", client.stderr)
        finally:
            client.close()
        self.assertFalse(client.forced_cleanup)

    def test_closed_output_with_input_open_stops_reader_without_fatal_shutdown(self):
        process = subprocess.Popen([sys.executable, "-m", "robot_companion_backend", "lsp"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdout.close()
            FramedStream(None, process.stdin).write({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                                    "params": {"capabilities": {}}})
            code = process.wait(timeout=4)
            stderr = process.stderr.read()
            self.assertGreater(code, 0, stderr.decode(errors="replace"))
            self.assertNotIn(b"Fatal Python error", stderr)
            self.assertNotIn(b"_enter_buffered_busy", stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)
            process.stdin.close()
            process.stderr.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "serve":
        raise SystemExit(controlled_server(sys.argv[2]))
    unittest.main()

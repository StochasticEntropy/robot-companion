"""Bounded full-workspace discovery pages over real framed backend processes."""

from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from client import Client, client_uri
from robot_companion_backend import discovery
from robot_companion_backend.lsp import RequestError
from robot_companion_backend.protocol import FramedStream


class DiscoveryBatchTests(unittest.TestCase):
    def setUp(self):
        from robot.conf.languages import Languages
        self.addCleanup(setattr, Languages, "_import_language_module", Languages.__dict__["_import_language_module"])
        self.temp = tempfile.TemporaryDirectory(prefix="rcb-discovery-batches-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "Generated Workspace"
        self.root.mkdir()
        self.write("__init__.robot", "*** Settings ***\nTest Tags    root-tag\n")
        self.write("robot.toml", '[variables]\nENV = "toml"\n\n[tool.robotcode-analyze]\nignored = 1\n')
        self.write("a/__init__.robot", "*** Settings ***\nName    Team A\nTest Tags    child-tag\n")
        self.write("a/duplicates.robot", "*** Test Cases ***\nSame ${ENV}\n    No Operation\n"
                   "Same ${ENV}\n    Log    ${CURDIR}\nGrüße 🎉\n    No Operation\n")
        self.write("a/broken.robot", "*** Unknown ***\ninvalid\n*** Test Cases ***\nKept\n    No Operation\n")
        self.write("b/__init__.robot", "*** Unknown ***\ninvalid\n")
        for number in range(25):
            self.write(f"b/suite_{number:03d}.robot", "*** Test Cases ***\nGenerated\n    No Operation\n")
        self.write("b/no_tests.robot", "*** Keywords ***\nOnly Keyword\n    No Operation\n")
        self.write("b/markdown.robot.md", "# Generated\n\n```robotframework\n*** Test Cases ***\nMarkdown\n    No Operation\n```\n")
        self.write("b/ignored.resource", "*** Keywords ***\nOnly Resource\n    No Operation\n")
        self.configuration = {"version": 1, "cwd": str(self.root), "robotArguments": ["--variable", "ENV:configured"]}
        self.params = {"workspaceUri": client_uri(self.root), "robotConfiguration": self.configuration}

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def start(self):
        client = Client("discovery")
        self.addCleanup(self.finish, client)
        capabilities = client.request("initialize", {"rootUri": client_uri(self.root), "capabilities": {}})
        self.assertEqual(capabilities["capabilities"]["robotCompanionDiscovery"],
                         {"version": 1, "document": True, "batch": 1})
        client.send("initialized", {})
        return client

    def finish(self, client):
        try:
            if not client.closed and client.process.poll() is None:
                client.request("shutdown")
                client.send("exit")
                self.assertEqual(client.process.wait(timeout=5), 0)
        finally:
            client.close()
        self.assertFalse(client.forced_cleanup)

    def page(self, client, scan="scan", token=None, **changes):
        params = {**self.params, "batch": 1, "scanId": scan, **changes}
        if token is not None:
            params["continuation"] = token
        return client.request(discovery.METHOD, params)

    def error(self, client, params):
        with self.assertRaises(AssertionError) as caught:
            client.request(discovery.METHOD, params)
        self.assertEqual(caught.exception.args[0]["error"]["code"], -32602)
        return caught.exception.args[0]["error"]["message"]

    def collect(self, client, scan="scan"):
        result, pages, token = {"version": 1, "items": []}, [], None
        while True:
            page = self.page(client, scan, token)
            pages.append(page)
            result["items"] += page["items"]
            if page.get("errors"):
                result.setdefault("errors", []).extend(page["errors"])
            token = page["batch"]["continuation"]
            if token is None:
                return result, pages
            self.assertLess(len(pages), 1000)

    def test_real_framed_pages_equal_the_complete_legacy_tree_and_error_order(self):
        client = self.start()
        expected = client.request(discovery.METHOD, self.params)
        actual, pages = self.collect(client)
        self.assertEqual(actual, expected)
        self.assertGreater(len(pages), 1)
        previous = {name: 0 for name in ("scanned", "files", "suites", "tests")}
        tokens = set()
        for page in pages:
            counts = page["batch"]
            self.assertLessEqual(counts["files"] - previous["files"], discovery.BATCH_FILES)
            for name in previous:
                self.assertGreaterEqual(counts[name], previous[name])
            if counts["continuation"] is not None:
                self.assertNotIn(counts["continuation"], tokens)
                tokens.add(counts["continuation"])
            previous = {name: counts[name] for name in previous}
        self.assertEqual(previous["suites"], len(actual["items"]))
        self.assertEqual(previous["tests"], sum(len(s["children"]) for s in actual["items"]))
        duplicates = next(suite for suite in actual["items"] if suite["uri"].endswith("/a/duplicates.robot"))
        self.assertEqual([test["label"] for test in duplicates["children"]], ["Same configured", "Same configured", "Grüße 🎉"])
        self.assertIn("child-tag", duplicates["children"][0]["tags"])

    def test_invalid_test_names_report_source_errors_without_losing_valid_tests_or_later_pages(self):
        invalid = {
            "pipe": "*** Test Cases ***\n| | No Operation |\n| Kept |\n| | No Operation |\n",
            "escaped": "*** Test Cases ***\n\\\n    No Operation\nKept\n    No Operation\n",
            "empty": "*** Variables ***\n${NAME}    ${EMPTY}\n*** Test Cases ***\n${NAME}\n    No Operation\nKept\n    No Operation\n",
            "space": "*** Variables ***\n${NAME}    ${SPACE}\n*** Test Cases ***\n${NAME}\n    No Operation\nKept\n    No Operation\n",
            "nul": "*** Test Cases ***\nNull\0Name\n    No Operation\nKept\n    No Operation\n",
        }
        paths = [self.write(f"z_invalid/{name}.robot", text) for name, text in invalid.items()]
        only_invalid = self.write("z_invalid/only_empty.robot", "*** Test Cases ***\n\\\n    No Operation\n")
        self.write("zz_later.robot", "*** Test Cases ***\nLater\n    No Operation\n")
        client = self.start()
        actual, pages = self.collect(client)
        self.assertEqual(actual, client.request(discovery.METHOD, self.params))
        self.assertGreater(len(pages), 1)
        self.assertNotIn(client_uri(only_invalid), [suite["uri"] for suite in actual["items"]])
        self.assertTrue(any(error["uri"] == client_uri(only_invalid) for error in actual["errors"]))
        for path in paths:
            uri = client_uri(path)
            suite = next(item for item in actual["items"] if item["uri"] == uri)
            self.assertEqual([test["label"] for test in suite["children"]], ["Kept"])
            findings = [error for error in actual.get("errors", []) if error["uri"] == uri
                        and error["message"].startswith("Not discovered: test name")]
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0]["range"]["start"]["line"], 3 if path.stem in ("empty", "space") else 1)
            focused = client.request(discovery.METHOD, {**self.params, "documentUri": uri})
            self.assertEqual(focused["items"], [suite])
            self.assertIn(findings[0], focused["errors"])
        self.assertIn("Later", [test["label"] for suite in actual["items"] for test in suite["children"]])
        for page in pages:
            self.assertTrue(all(test["label"].strip() and "\0" not in test["label"]
                                for suite in page["items"] for test in suite["children"]))
        final = pages[-1]["batch"]
        self.assertEqual(final["tests"], sum(len(suite["children"]) for suite in actual["items"]))

    def test_label_whitespace_matches_editor_validation_after_configured_substitution(self):
        path = self.write("configured.robot", "*** Test Cases ***\n${LABEL}\n    No Operation\nKept\n    No Operation\n")
        client = self.start()
        for value, accepted in (("\ufeff", False), (" \ufeff\t", False), ("\u0085", True), ("\u001c", True),
                                (" \ufeffName\ufeff ", True)):
            with self.subTest(value=repr(value)):
                configuration = {"version": 1, "cwd": str(self.root), "robotArguments": ["--variable", f"LABEL:{value}"]}
                actual = client.request(discovery.METHOD, {**self.params, "documentUri": client_uri(path),
                                                          "robotConfiguration": configuration})
                self.assertEqual([test["label"] for test in actual["items"][0]["children"]],
                                 [value, "Kept"] if accepted else ["Kept"])
                findings = [error for error in actual.get("errors", []) if error["uri"] == client_uri(path)
                            and error["message"].startswith("Not discovered: test name")]
                self.assertEqual(len(findings), 0 if accepted else 1)

    def test_new_edits_and_deletions_are_seen_by_a_new_scan(self):
        client = self.start()
        self.collect(client)
        self.write("new.robot", "*** Test Cases ***\nNew\n    No Operation\n")
        (self.root / "b/suite_000.robot").unlink()
        self.write("b/suite_001.robot", "*** Test Cases ***\nChanged\n    No Operation\n")
        actual, _ = self.collect(client, "fresh")
        self.assertEqual(actual, client.request(discovery.METHOD, self.params))
        names = [test["label"] for suite in actual["items"] for test in suite["children"]]
        self.assertIn("New", names)
        self.assertIn("Changed", names)

    def test_tokens_are_single_use_and_bound_to_workspace_configuration_and_scan(self):
        client = self.start()
        first = self.page(client)
        old = first["batch"]["continuation"]
        second = self.page(client, token=old)
        current = second["batch"]["continuation"]
        self.assertIsNotNone(current)
        self.error(client, {**self.params, "batch": 1, "scanId": "scan", "continuation": old})
        self.error(client, {**self.params, "batch": 1, "scanId": "scan", "continuation": current})
        other = Path(self.temp.name) / "Other"
        other.mkdir()
        for changed in ({"workspaceUri": client_uri(other)}, {"robotConfiguration": None}, {"scanId": "different"}):
            token = self.page(client)["batch"]["continuation"]
            self.error(client, {**self.params, "batch": 1, "scanId": "scan", "continuation": token, **changed})

    def test_new_full_focused_and_batch_requests_invalidate_older_tokens(self):
        client = self.start()
        for replace in (self.params, {**self.params, "documentUri": client_uri(self.root / "a/duplicates.robot")},
                        {**self.params, "batch": 1, "scanId": "replacement"}):
            token = self.page(client)["batch"]["continuation"]
            client.request(discovery.METHOD, replace)
            self.error(client, {**self.params, "batch": 1, "scanId": "scan", "continuation": token})

    def test_cancel_is_scoped_to_workspace_and_scan_and_lost_tokens_are_rejected(self):
        client = self.start()
        token = self.page(client)["batch"]["continuation"]
        client.send(discovery.METHOD_CANCEL, {"workspaceUri": self.params["workspaceUri"], "scanId": "older"})
        token = self.page(client, token=token)["batch"]["continuation"]
        client.send(discovery.METHOD_CANCEL, {"workspaceUri": "file:///different", "scanId": "scan"})
        token = self.page(client, token=token)["batch"]["continuation"]
        client.send(discovery.METHOD_CANCEL, {"workspaceUri": self.params["workspaceUri"], "scanId": "scan"})
        self.error(client, {**self.params, "batch": 1, "scanId": "scan", "continuation": token})
        self.collect(client, "after-cancel")

    def test_invalid_batch_inputs_refuse_instead_of_returning_a_partial_legacy_tree(self):
        client = self.start()
        for changed in ({"batch": True}, {"batch": 2}, {"scanId": ""}, {"scanId": "x" * 129},
                        {"scanId": None}, {"scanId": "bad" + chr(0)}, {"documentUri": client_uri(self.root / "a/duplicates.robot")}):
            self.error(client, {**self.params, "batch": 1, "scanId": "scan", **changed})

    def local_server(self):
        server = discovery.DiscoveryServer(FramedStream(BytesIO(), BytesIO()))
        server.dispatch("initialize", {})
        self.addCleanup(server.diagnostic_worker.close)
        self.addCleanup(server.close_batch)
        return server

    def test_expired_oversized_and_interrupted_jobs_are_closed_without_reusable_tokens(self):
        for mode in ("expired", "oversized", "oversized-page", "interrupted"):
            with self.subTest(mode=mode):
                server = self.local_server()
                params = {**self.params, "batch": 1, "scanId": "local"}
                with patch.object(discovery, "BATCH_SECONDS", 0):
                    token = server.dispatch(discovery.METHOD, params)["batch"]["continuation"]
                job = server.discovery_batch
                if mode == "expired":
                    job.expires = 0
                    context, error = patch.object(discovery, "BATCH_SECONDS", 10), RequestError
                elif mode == "oversized-page":
                    context, error = patch.multiple(discovery, MAX_RESULT_BYTES=job.bytes + 1, BATCH_SECONDS=0), RequestError
                elif mode == "oversized":
                    context, error = patch.object(discovery, "MAX_RESULT_BYTES", job.bytes), RequestError
                else:
                    context, error = patch.object(discovery, "read_suite", side_effect=KeyboardInterrupt), KeyboardInterrupt
                with context, self.assertRaises(error):
                    server.dispatch(discovery.METHOD, params if mode == "oversized-page" else {**params, "continuation": token})
                self.assertIsNone(server.discovery_batch)
                self.assertIsNone(job.walk.gi_frame)
                with self.assertRaises(RequestError):
                    server.dispatch(discovery.METHOD, {**params, "continuation": token})

    def test_walk_steps_page_even_when_no_suite_file_has_been_found(self):
        for number in range(100):
            self.write(f"empty_{number:03d}/not-a-suite.txt", "generated\n")
        server = self.local_server()
        with patch.object(discovery, "BATCH_SECONDS", 0):
            first = server.dispatch(discovery.METHOD, {**self.params, "batch": 1, "scanId": "steps"})
            token = first["batch"]["continuation"]
            second = server.dispatch(discovery.METHOD, {**self.params, "batch": 1, "scanId": "steps", "continuation": token})
        self.assertEqual(first["batch"]["files"], 0)
        self.assertGreater(second["batch"]["scanned"], first["batch"]["scanned"])
        self.assertIsNotNone(second["batch"]["continuation"])

    def test_shutdown_and_serve_exit_close_an_unfinished_job(self):
        server = self.local_server()
        params = {**self.params, "batch": 1, "scanId": "shutdown"}
        with patch.object(discovery, "BATCH_SECONDS", 0):
            token = server.dispatch(discovery.METHOD, params)["batch"]["continuation"]
        job = server.discovery_batch
        server.dispatch("shutdown", {})
        self.assertIsNone(server.discovery_batch)
        self.assertIsNone(job.walk.gi_frame)
        with self.assertRaises(RequestError):
            server.dispatch(discovery.METHOD, {**params, "continuation": token})
        leaving = []

        def return_without_shutdown(instance):
            instance.dispatch("initialize", {})
            with patch.object(discovery, "BATCH_SECONDS", 0):
                instance.dispatch(discovery.METHOD, params)
            leaving.append(instance.discovery_batch)
            self.addCleanup(instance.diagnostic_worker.close)
            return 1

        with patch.object(discovery.DiscoveryServer, "run", return_without_shutdown):
            self.assertEqual(discovery.serve(BytesIO(), BytesIO()), 1)
        self.assertIsNone(leaving[0].walk.gi_frame, "EOF/exit cleanup does not depend on shutdown dispatch")


if __name__ == "__main__":
    unittest.main()

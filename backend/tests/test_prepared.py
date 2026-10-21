"""Prepared-session descriptor, file protection and authentication rules (fixture-only).

Pure validation and real loopback sockets; real `dap-prepare`/`dap-connect` processes and
Robot runs are covered by test_dap_prepared_live.py."""

import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest

from robot_companion_backend import __version__, prepared
from robot_companion_backend.prepared import DescriptorError

WINDOWS = sys.platform == "win32"
NOW = datetime.datetime(2026, 10, 21, 12, 0, tzinfo=datetime.timezone.utc)


def valid(workspace="/ws", port=40123):
    workspace = str(Path(workspace))
    return {"version": 1, "kind": prepared.KIND, "backend": {"id": prepared.BACKEND_ID, "version": __version__},
            "sessionId": "0123456789abcdef0123456789abcdef", "generation": 1, "workspace": workspace,
            "workspaceUri": Path(workspace).absolute().as_uri(), "cwd": workspace, "targets": ["audit.robot"],
            "args": [], "attachPython": False, "owner": {"processId": 4242, "created": None},
            "connect": {"host": "127.0.0.1", "port": port}, "created": prepared.utc(NOW),
            "expires": prepared.utc(NOW + datetime.timedelta(seconds=30)), "secret": "ab" * 32}


def encoded(descriptor):
    return json.dumps(descriptor).encode("utf-8")


class DescriptorValidationTests(unittest.TestCase):
    def refused(self, data, fragment):
        with self.assertRaises(DescriptorError) as caught:
            prepared.parse_descriptor(data, now=NOW)
        self.assertIn(fragment, str(caught.exception))
        self.assertNotIn("ab" * 32, str(caught.exception))  # never echo the secret

    def test_minimal_valid_descriptor(self):
        descriptor = valid()
        self.assertEqual(prepared.parse_descriptor(encoded(descriptor), now=NOW), descriptor)
        unicode = valid(workspace="/tmp/My Tests Ä 😀")
        self.assertEqual(prepared.parse_descriptor(encoded(unicode), now=NOW)["workspace"], unicode["workspace"])

    def test_invalid_and_boundary_descriptors(self):
        def changed(**fields):
            descriptor = valid()
            for key, value in fields.items():
                path = key.split("__")
                target = descriptor
                for part in path[:-1]:
                    target = target[part]
                if value is KeyError:
                    del target[path[-1]]
                else:
                    target[path[-1]] = value
            return encoded(descriptor)
        cases = [
            (b"", "empty file"), (b"{", "not JSON"), (b"\xff\xfe", "not UTF-8"), (b"[]", "not a JSON object"),
            (encoded(valid())[:-1] + b' "' + b"x" * 17000 + b'"}', "larger than 16384 bytes"),
            (encoded(valid()).replace(b'"audit.robot"', b'"a\\u0000"'), "contains NUL"),
            (changed(version=2), "unsupported version 2"), (changed(version=True), "unsupported version True"),
            (changed(version="1"), "unsupported version"), (changed(kind="other"), "kind must be"),
            (changed(extra=1), "unknown fields ['extra']"), (changed(secret=KeyError), "missing fields ['secret']"),
            (changed(backend__version="9.9"), "prepared by another backend"),
            (changed(backend__id="robotcode"), "prepared by another backend"),
            (changed(sessionId="ABC"), "sessionId"), (changed(generation=2), "generation must be 1"),
            (changed(generation=True), "generation must be 1"),
            (changed(workspace="relative"), "workspace must be an absolute path"),
            (changed(cwd=None), "cwd must be an absolute path"),
            (changed(workspaceUri="http://x"), "workspaceUri"),
            (changed(targets=[]), "targets"), (changed(targets=[""]), "targets"), (changed(args=[1]), "args"),
            (changed(attachPython=1), "attachPython"), (changed(owner__processId=True), "owner"),
            (changed(owner__extra=1), "owner"),
            (changed(connect__port=True), "connect.port"), (changed(connect__port=0), "connect.port"),
            (changed(connect__port=65536), "connect.port"), (changed(connect__port=1.5), "connect.port"),
            (changed(connect__host="localhost"), "connect.host"), (changed(connect__host="10.0.0.1"), "connect.host"),
            (changed(connect__host="::1"), "connect.host"), (changed(connect__secret="ab"), "connect must be exactly"),
            (changed(secret="ab"), "secret must be 64"), (changed(secret="zz" * 32), "secret must be 64"),
            (changed(secret="AB" * 32), "secret must be 64"), (changed(created="yesterday"), "timestamps"),
            (changed(expires=prepared.utc(NOW - datetime.timedelta(seconds=1))), "expires must follow created"),
        ]
        for data, fragment in cases:
            with self.subTest(fragment=fragment):
                self.refused(data, fragment)
        with self.assertRaises(DescriptorError) as caught:
            prepared.parse_descriptor(encoded(valid()), now=NOW + datetime.timedelta(seconds=30))
        self.assertIn("expired", str(caught.exception))

    def test_digest_binds_public_fields_but_not_the_secret(self):
        first, second = valid(), valid()
        second["secret"] = "cd" * 32
        self.assertEqual(prepared.public_digest(first), prepared.public_digest(second))
        second["workspace"] = "/other"
        self.assertNotEqual(prepared.public_digest(first), prepared.public_digest(second))

    def test_startup_data(self):
        good = {"version": 1, "preparedSession": str(Path("/tmp/s.json").absolute()),
                "workspace": str(Path("/ws").absolute()), "backend": {"id": prepared.BACKEND_ID, "version": __version__}}
        self.assertEqual(prepared.parse_startup(json.dumps(good).encode() + b"\n"), good)
        for line in (b"{}\n", b"x\n", json.dumps(good).encode(), json.dumps({**good, "version": True}).encode() + b"\n",
                     json.dumps({**good, "preparedSession": "rel.json"}).encode() + b"\n",
                     json.dumps({**good, "extra": 1}).encode() + b"\n", b"\xff\n", b"x" * 20000 + b"\n"):
            with self.subTest(line=line[:40]):
                with self.assertRaises(DescriptorError):
                    prepared.parse_startup(line)


class PrivateFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="rcb-prepared-test-")).resolve()
        if not WINDOWS:
            os.chmod(self.directory, 0o700)

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_write_is_private_new_and_readable_once_checked(self):
        path = self.directory / "session.json"
        prepared.write_private(path, b"payload")
        self.assertEqual(prepared.read_private(path), b"payload")
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ["session.json"])  # no temporary left
        if not WINDOWS:
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with self.assertRaises(OSError):
            prepared.write_private(path, b"replacement")  # never overwritten
        self.assertEqual(prepared.read_private(path), b"payload")

    def test_unsafe_files_and_directories_are_refused(self):
        path = self.directory / "session.json"
        prepared.write_private(path, b"payload")
        with self.assertRaises(DescriptorError) as caught:
            prepared.read_private(self.directory / "missing.json")
        self.assertIn("No prepared session descriptor", str(caught.exception))
        with self.assertRaises(DescriptorError):
            prepared.read_private(Path("relative.json"))
        link = self.directory / "link.json"
        try:
            os.symlink(path, link)
        except OSError as exc:  # Windows without symlink privilege
            if not WINDOWS:
                raise
            print("symlink-case-unavailable", exc, flush=True)
        else:
            with self.assertRaises(DescriptorError):
                prepared.read_private(link)
        if WINDOWS:
            self.make_broad_on_windows(path)
        else:
            os.chmod(path, 0o644)
        with self.assertRaises(DescriptorError) as caught:
            prepared.read_private(path)
        self.assertIn("grants access to another account" if WINDOWS else "private (0600)", str(caught.exception))
        if not WINDOWS:
            os.chmod(self.directory, 0o755)
            with self.assertRaises(DescriptorError):
                prepared.write_private(self.directory / "other.json", b"x")
            os.chmod(self.directory, 0o700)
        big = self.directory / "big.json"
        prepared.write_private(big, b"x" * (prepared.DESCRIPTOR_LIMIT + 1))
        with self.assertRaises(DescriptorError):
            prepared.read_private(big)

    def make_broad_on_windows(self, path):
        """Grant Everyone read through a new unprotected DACL, as a broadly readable file would."""
        import ctypes
        from ctypes import wintypes
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        descriptor = ctypes.c_void_p()
        advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        security = prepared._windows()
        self.assertTrue(advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            f"D:P(A;;FA;;;{security.user_text})(A;;FR;;;WD)", 1, ctypes.byref(descriptor), None))
        dacl, present, defaulted = ctypes.c_void_p(), wintypes.BOOL(), wintypes.BOOL()
        advapi32.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                                                       ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
        self.assertTrue(advapi32.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl),
                                                           ctypes.byref(defaulted)))
        advapi32.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p,
                                                   ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        self.assertEqual(advapi32.SetNamedSecurityInfoW(str(path), 1, 0x4 | 0x80000000, None, None, dacl, None), 0)


class AuthenticationTests(unittest.TestCase):
    def claim_in_thread(self, descriptor, timeout=3):
        listener = prepared.PreparedListener()
        descriptor["connect"]["port"] = listener.port
        result, refusals = {}, []
        thread = threading.Thread(target=lambda: result.update(connection=listener.claim(
            descriptor, time.monotonic() + timeout, lambda: True, refusals.append)), daemon=True)
        thread.start()
        return listener, thread, result, refusals

    def test_secret_session_and_digest_must_match_and_the_claim_is_single_use(self):
        descriptor = valid()
        listener, thread, result, refusals = self.claim_in_thread(descriptor)
        for wrong in ({"secret": "cd" * 32}, {"sessionId": "f" * 32}, {"workspace": "/elsewhere"}):
            forged = {**copy.deepcopy(descriptor), **wrong}
            with self.assertRaises(OSError):
                prepared.authenticate(forged)
        raw = socket.create_connection(("127.0.0.1", listener.port))
        raw.sendall(b"GET / HTTP/1.1\r\n\r\n" + b"x" * 64)
        raw.close()
        connection = prepared.authenticate(descriptor)
        thread.join(timeout=5)
        self.assertIsNotNone(result["connection"])
        self.assertEqual(len(refusals), 4, refusals)
        # The listener closed at the claim: a replay cannot reach the owner.
        with self.assertRaises(OSError):
            prepared.authenticate(descriptor)
        connection.close()
        result["connection"].close()

    def test_silent_client_cannot_extend_the_lease(self):
        descriptor = valid()
        listener, thread, result, refusals = self.claim_in_thread(descriptor, timeout=1)
        silent = socket.create_connection(("127.0.0.1", listener.port))
        started = time.monotonic()
        thread.join(timeout=5)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIsNone(result["connection"])
        silent.close()


if __name__ == "__main__":
    unittest.main()

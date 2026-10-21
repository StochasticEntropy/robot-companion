"""Prepared Robot sessions: the supported way to attach to a native Robot run.

`dap-prepare` is a foreground owner. It checks the runtime and run inputs, starts its own
Robot worker (and, with --attach-python, its own debugpy adapter) waiting before Robot
executes anything, then publishes a private one-use descriptor and waits up to the attach
lease for one authenticated client. It owns every process of the run until it exits:
disconnect, a failed attach, expiry or Ctrl+C stop them all and remove the descriptor.

`dap-connect` is that client. An editor starts it as an ordinary stdio debug adapter and
writes one line of startup data (descriptor path, expected workspace and backend) on its
stdin before DAP framing. It opens the descriptor exactly once, checks that it is a private
regular file of this account, validates it, authenticates to the owner on 127.0.0.1 and
then relays DAP bytes unchanged. The secret never leaves the descriptor and the two
processes; it is not in argv, the environment, the socket or any output.

Authentication reuses control.py's pattern with its own prefix and labels. Both peers prove
the descriptor secret with HMAC-SHA256 over fresh nonces, bound to the session ID,
generation and the digest of the descriptor's public fields:

    client -> owner  HELLO + session ID + client nonce
    owner  -> client owner nonce + HMAC(secret, "owner" | context | client nonce | owner nonce)
    client -> owner  HMAC(secret, "client" | context | owner nonce | client nonce)

The first authenticated client claims the session: the listener closes and the descriptor
is removed, so a descriptor can never be replayed. A failed handshake closes only that
connection. This protects against other accounts and accidental cross-session use, not
against a hostile process already running as the same account.

Attaching to an arbitrary process ID or network endpoint is not supported.
"""

import argparse
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import sys
import tempfile
import threading
import time
import uuid

from . import __version__
from .control import HANDSHAKE_TIMEOUT, receive_exactly
from .protocol import FramedStream, ProtocolError

DESCRIPTOR_VERSION = 1
KIND = "robot-companion-prepared"
BACKEND_ID = "robot-companion-native"
DESCRIPTOR_LIMIT = 16 * 1024
STARTUP_LIMIT = 16 * 1024
LEASE = 30  # seconds for one client to attach, and then for it to configure the run
HOST = "127.0.0.1"
HELLO = b"RCB-PREPARED-1\n"
NONCE_BYTES = 32
MAC_BYTES = hashlib.sha256().digest_size
SESSION = re.compile(r"[0-9a-f]{32}")
SECRET = re.compile(r"[0-9a-f]{64}")
REPORTED_REFUSALS = 10
WINDOWS = sys.platform == "win32"
FIELDS = {"version", "kind", "backend", "sessionId", "generation", "workspace", "workspaceUri", "cwd", "targets",
          "args", "attachPython", "owner", "connect", "created", "expires", "secret"}


class DescriptorError(ValueError):
    pass


def utc(moment):
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def public_digest(descriptor):
    """SHA-256 of every descriptor field except the secret; logs name a session by it."""
    public = {key: value for key, value in descriptor.items() if key != "secret"}
    return hashlib.sha256(json.dumps(public, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def context(descriptor):
    return (descriptor["sessionId"].encode("ascii") + b"\0" + str(descriptor["generation"]).encode("ascii")
            + b"\0" + public_digest(descriptor).encode("ascii"))


def mac(secret, role, bound, first, second):
    return hmac.new(secret, b"robot-companion-prepared/" + role + b"\0" + bound + first + second,
                    hashlib.sha256).digest()


def _integer(value):
    return type(value) is int


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def parse_descriptor(data, now=None):
    """The validated descriptor object of `data` (bytes); DescriptorError names the problem."""
    def refuse(detail):
        raise DescriptorError(f"Invalid prepared session descriptor: {detail}")
    if len(data) > DESCRIPTOR_LIMIT:
        refuse(f"larger than {DESCRIPTOR_LIMIT} bytes")
    if not data:
        refuse("empty file")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        refuse("not UTF-8")
    if "\0" in text:
        refuse("contains NUL")
    try:
        descriptor = json.loads(text)
    except json.JSONDecodeError as exc:
        refuse(f"not JSON ({exc.msg})")
    if not isinstance(descriptor, dict):
        refuse("not a JSON object")
    if any("\0" in text for text in _strings(descriptor)):
        refuse("contains NUL")
    if not _integer(descriptor.get("version")) or descriptor["version"] != DESCRIPTOR_VERSION:
        refuse(f"unsupported version {descriptor.get('version')!r}; this backend reads version {DESCRIPTOR_VERSION}")
    if descriptor.get("kind") != KIND:
        refuse(f"kind must be {KIND!r}")
    if unknown := sorted(set(descriptor) - FIELDS):
        refuse(f"unknown fields {unknown}")
    if missing := sorted(FIELDS - set(descriptor)):
        refuse(f"missing fields {missing}")
    backend = descriptor["backend"]
    if not isinstance(backend, dict) or set(backend) != {"id", "version"} or backend["id"] != BACKEND_ID \
            or backend["version"] != __version__:
        refuse(f"prepared by another backend; this is {BACKEND_ID} {__version__}")
    if not isinstance(descriptor["sessionId"], str) or not SESSION.fullmatch(descriptor["sessionId"]):
        refuse("sessionId must be 32 lowercase hex digits")
    if not _integer(descriptor["generation"]) or descriptor["generation"] != 1:
        refuse("generation must be 1")
    for key in ("workspace", "cwd"):
        if not isinstance(descriptor[key], str) or not os.path.isabs(descriptor[key]):
            refuse(f"{key} must be an absolute path")
    if not isinstance(descriptor["workspaceUri"], str) or not descriptor["workspaceUri"].startswith("file:"):
        refuse("workspaceUri must be a file URI")
    targets, args = descriptor["targets"], descriptor["args"]
    if not isinstance(targets, list) or not targets or not all(isinstance(t, str) and t for t in targets):
        refuse("targets must be a non-empty list of paths")
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        refuse("args must be a list of strings")
    if not isinstance(descriptor["attachPython"], bool):
        refuse("attachPython must be true or false")
    owner = descriptor["owner"]
    if not isinstance(owner, dict) or set(owner) != {"processId", "created"} or not _integer(owner["processId"]) \
            or owner["processId"] <= 1 or not (owner["created"] is None or _integer(owner["created"])):
        refuse("owner must be {processId, created}")
    connect = descriptor["connect"]
    if not isinstance(connect, dict) or set(connect) != {"host", "port"}:
        refuse("connect must be exactly {host, port}")
    if connect["host"] != HOST:
        refuse(f"connect.host must be {HOST}")
    if not _integer(connect["port"]) or not 0 < connect["port"] <= 65535:
        refuse("connect.port must be an integer from 1 to 65535")
    try:
        created, expires = (datetime.datetime.strptime(descriptor[key], "%Y-%m-%dT%H:%M:%S.%fZ")
                            .replace(tzinfo=datetime.timezone.utc) for key in ("created", "expires"))
    except (TypeError, ValueError):
        refuse("created/expires must be UTC timestamps")
    if not created < expires:
        refuse("expires must follow created")
    if not isinstance(descriptor["secret"], str) or not SECRET.fullmatch(descriptor["secret"]):
        refuse("secret must be 64 lowercase hex digits")
    if (now or datetime.datetime.now(datetime.timezone.utc)) >= expires:
        raise DescriptorError("The prepared session expired; prepare a new one")
    return descriptor


def process_created():
    """Creation identity of this process (Linux start ticks, Windows FILETIME), else None."""
    try:
        if WINDOWS:
            return _windows().created()
        text = Path("/proc/self/stat").read_text(encoding="ascii")
        return int(text[text.rindex(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def same_path(first, second):
    return os.path.normcase(os.path.realpath(first)) == os.path.normcase(os.path.realpath(second))


# --- private descriptor file -------------------------------------------------------------

def _private_directory(directory):
    info = os.lstat(directory)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise DescriptorError(f"Descriptor directory {directory} must be a real directory, not a link")
    if WINDOWS:
        if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise DescriptorError(f"Descriptor directory {directory} must not be a junction or reparse point")
    elif info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise DescriptorError(f"Descriptor directory {directory} must belong to this user and be private (0700)")


def write_private(path, data):
    """Publish `data` at `path` atomically: a new file only this account can read; never replaced."""
    path = Path(path)
    _private_directory(path.parent)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        if WINDOWS:
            _windows().create_private(str(temporary), data)
        else:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.fchmod(descriptor, 0o600)  # independent of the umask
                os.write(descriptor, data)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        if WINDOWS:
            _windows().move_new(str(temporary), str(path))
        else:
            os.link(temporary, path, follow_symlinks=False)  # fails if path exists
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_private(path):
    """Open `path` once and return its bytes after checking the opened object itself."""
    path = Path(path)
    if not path.is_absolute():
        raise DescriptorError("The prepared session descriptor path must be absolute")
    try:
        _private_directory(path.parent)
        if WINDOWS:
            return _windows().read_private(str(path), DESCRIPTOR_LIMIT + 1)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise DescriptorError(f"No prepared session descriptor at {path}; it was consumed, expired "
                              "or never published") from None
    except OSError as exc:
        raise DescriptorError(f"Cannot open the prepared session descriptor safely: {exc.strerror or exc}") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise DescriptorError("The prepared session descriptor is not a regular file")
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise DescriptorError("The prepared session descriptor must belong to this user and be private (0600)")
        if info.st_size > DESCRIPTOR_LIMIT:
            raise DescriptorError(f"Invalid prepared session descriptor: larger than {DESCRIPTOR_LIMIT} bytes")
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise DescriptorError("The prepared session descriptor was replaced while it was opened")
        chunks, size = [], 0
        while size <= DESCRIPTOR_LIMIT and (chunk := os.read(descriptor, DESCRIPTOR_LIMIT + 1 - size)):
            chunks.append(chunk)
            size += len(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def read_descriptor(path):
    return parse_descriptor(read_private(path))


# --- owner side ---------------------------------------------------------------------------

class PreparedListener:
    """One-use 127.0.0.1 listener that accepts only a client proving the descriptor secret."""

    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: no other socket may bind this port.
                self.server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            self.server.bind((HOST, 0))
            self.server.listen(8)
        except OSError:
            self.server.close()
            raise
        self.port = self.server.getsockname()[1]

    def claim(self, descriptor, deadline, alive, refused):
        """The authenticated connection, or None once `deadline` (monotonic) passes or `alive()` fails."""
        secret = bytes.fromhex(descriptor["secret"])
        try:
            while (remaining := deadline - time.monotonic()) > 0 and alive():
                self.server.settimeout(min(0.2, remaining))
                try:
                    connection, address = self.server.accept()
                except socket.timeout:
                    continue
                try:
                    # Failed handshakes cannot extend the lease.
                    self._authenticate(connection, descriptor, secret,
                                       time.monotonic() + min(HANDSHAKE_TIMEOUT, remaining))
                except OSError as exc:
                    connection.close()
                    refused(f"{address[0]}:{address[1]} ({exc})")
                    continue
                connection.settimeout(None)
                return connection
            return None
        finally:
            self.close()

    def _authenticate(self, connection, descriptor, secret, deadline):
        hello = receive_exactly(connection, len(HELLO) + 32 + NONCE_BYTES, deadline)
        if not hmac.compare_digest(hello[:len(HELLO)], HELLO):
            raise OSError("not a prepared-session handshake")
        if not hmac.compare_digest(hello[len(HELLO):len(HELLO) + 32], descriptor["sessionId"].encode("ascii")):
            raise OSError("another prepared session's ID")
        bound, client_nonce, owner_nonce = context(descriptor), hello[len(HELLO) + 32:], secrets.token_bytes(NONCE_BYTES)
        connection.sendall(owner_nonce + mac(secret, b"owner", bound, client_nonce, owner_nonce))
        proof = receive_exactly(connection, MAC_BYTES, deadline)
        if not hmac.compare_digest(proof, mac(secret, b"client", bound, owner_nonce, client_nonce)):
            raise OSError("client failed prepared-session authentication")

    def close(self):
        self.server.close()


def authenticate(descriptor, timeout=HANDSHAKE_TIMEOUT):
    """Client side: connect to the descriptor's owner and authenticate both ends."""
    secret = bytes.fromhex(descriptor["secret"])
    connection = socket.create_connection((HOST, descriptor["connect"]["port"]), timeout=timeout)
    try:
        deadline = time.monotonic() + timeout
        bound, client_nonce = context(descriptor), secrets.token_bytes(NONCE_BYTES)
        connection.sendall(HELLO + descriptor["sessionId"].encode("ascii") + client_nonce)
        reply = receive_exactly(connection, NONCE_BYTES + MAC_BYTES, deadline)
        owner_nonce, proof = reply[:NONCE_BYTES], reply[NONCE_BYTES:]
        if not hmac.compare_digest(proof, mac(secret, b"owner", bound, client_nonce, owner_nonce)):
            raise OSError("the prepared session owner failed authentication")
        connection.sendall(mac(secret, b"client", bound, owner_nonce, client_nonce))
        connection.settimeout(None)
        return connection
    except BaseException:
        connection.close()
        raise


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def prepare_main(argv):
    from .dap import DebugAdapter, RequestError, STOP_TIMEOUT, launch_inputs
    from .python_debug import HANDOFF_VERSION, SessionReader
    from .runtime import unsupported_reason
    parser = argparse.ArgumentParser(
        prog="robot-companion-backend dap-prepare",
        description="Start an owned Robot run that waits for one debugger to attach (prepared session).")
    parser.add_argument("--workspace", required=True, help="absolute workspace folder the editor has open")
    parser.add_argument("--target", action="append", required=True, help="Robot suite path (repeatable)")
    parser.add_argument("--cwd", help="run directory (default: the workspace folder)")
    parser.add_argument("--descriptor", help="descriptor path in a private directory (default: a new private "
                                             "temporary directory)")
    parser.add_argument("--attach-python", action="store_true", help="also debug Python keywords (debugpy 1.8.22)")
    parser.add_argument("--attach-timeout", type=float, default=LEASE,
                        help=f"seconds to wait for the attach, at most {LEASE} (default {LEASE})")
    parser.add_argument("robot_args", nargs=argparse.REMAINDER, help="-- then Robot Framework options")
    args = parser.parse_args(argv)
    robot_args = args.robot_args[1:] if args.robot_args[:1] == ["--"] else args.robot_args
    fail = lambda message: (print(f"dap-prepare: {message}", file=sys.stderr, flush=True), 2)[1]  # noqa: E731
    if not 0 < args.attach_timeout <= LEASE:
        return fail(f"--attach-timeout must be more than 0 and at most {LEASE} seconds")
    workspace = Path(args.workspace)
    if not workspace.is_absolute() or not workspace.is_dir():
        return fail("--workspace must be an absolute path of an existing folder")
    workspace = workspace.resolve()
    if reason := unsupported_reason():
        return fail(reason)
    try:
        inputs = launch_inputs({"cwd": str(Path(args.cwd).resolve() if args.cwd else workspace),
                                "target": args.target, "args": robot_args,
                                **({"pythonDebug": {"handoffVersion": HANDOFF_VERSION}} if args.attach_python else {})})
    except RequestError as exc:
        return fail(str(exc))
    created_directory = None
    if args.descriptor:
        path = Path(args.descriptor)
        if not path.is_absolute():
            return fail("--descriptor must be an absolute path")
        if os.path.lexists(path):
            return fail(f"{path} already exists; descriptors are never overwritten")
    else:
        created_directory = Path(tempfile.mkdtemp(prefix="rcb-prepared-"))
        path = created_directory / "session.json"
    # SIGINT too: a parent that ignores it (nohup, some runners) would otherwise leave Ctrl+C ignored.
    for name in ("SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), _interrupt)
    adapter = DebugAdapter(None, prepared=True)
    listener = connection = timer = None
    published = False
    refusals = []

    def remove_descriptor():
        nonlocal published
        if published:
            published = False
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        if created_directory is not None:
            shutil.rmtree(created_directory, ignore_errors=True)

    def refused(detail):
        refusals.append(detail)
        if len(refusals) <= REPORTED_REFUSALS:
            print(f"dap-prepare: refused a prepared-session connection: {detail}", file=sys.stderr, flush=True)
        elif len(refusals) == REPORTED_REFUSALS + 1:
            print("dap-prepare: refused more connections; no longer reporting each", file=sys.stderr, flush=True)

    try:
        try:
            listener = PreparedListener()
            adapter.prepare(inputs)
        except (RequestError, OSError) as exc:
            return fail(f"preparation failed: {exc}")
        now = datetime.datetime.now(datetime.timezone.utc)
        descriptor = {
            "version": DESCRIPTOR_VERSION, "kind": KIND, "backend": {"id": BACKEND_ID, "version": __version__},
            "sessionId": uuid.uuid4().hex, "generation": 1, "workspace": str(workspace),
            "workspaceUri": workspace.as_uri(), "cwd": str(inputs["cwd"]), "targets": inputs["targets"],
            "args": inputs["args"], "attachPython": inputs["python"],
            "owner": {"processId": os.getpid(), "created": process_created()},
            "connect": {"host": HOST, "port": listener.port},
            "created": utc(now), "expires": utc(now + datetime.timedelta(seconds=args.attach_timeout)),
            "secret": secrets.token_hex(32)}
        deadline = time.monotonic() + args.attach_timeout
        try:
            write_private(path, json.dumps(descriptor, indent=2).encode("utf-8"))
        except (DescriptorError, OSError) as exc:
            return fail(f"cannot publish the descriptor: {exc}")
        published = True
        print(f"Robot Companion prepared session {descriptor['sessionId']} (digest {public_digest(descriptor)[:16]}) "
              f"waits {args.attach_timeout:g} s for one attach.", flush=True)
        print(f"preparedSession: {path}", flush=True)
        worker = adapter.worker

        def alive():
            python = adapter.python
            return worker.tree.poll() is None and (python is None or not python.lost.is_set())
        connection = listener.claim(descriptor, deadline, alive, refused)
        remove_descriptor()  # Claimed or not, it can never be used again.
        if connection is None:
            if not alive():
                return fail(f"the prepared Robot worker ended before a client attached "
                            f"(exit code {worker.process.returncode})")
            return fail("the prepared session expired before a client attached")
        print(f"dap-prepare: session {descriptor['sessionId']} attached", file=sys.stderr, flush=True)
        stopping = threading.Event()
        reader, writer = SessionReader(connection, stopping), connection.makefile("wb")
        adapter.stream = FramedStream(reader, writer)

        def configuration_expired():
            if not adapter.configured and not adapter.terminated:
                adapter.event("output", {"category": "important", "output":
                                         f"Prepared session was not configured within {LEASE} s of attaching; "
                                         "ending the owned run\n"})
                adapter.end_session()
                stopping.set()
        timer = threading.Timer(LEASE, configuration_expired)
        timer.daemon = True
        timer.start()
        return adapter.run()
    except KeyboardInterrupt:
        print("dap-prepare: interrupted; stopping the owned run", file=sys.stderr, flush=True)
        adapter.cancel_operation()
        adapter.stop_worker()
        return 130
    finally:
        if timer is not None:
            timer.cancel()
        remove_descriptor()
        if listener is not None:
            listener.close()
        adapter.cancel_operation()
        adapter.stop_worker()
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
            if adapter.stream is not None:
                try:
                    adapter.stream.writer.close()
                except OSError:
                    pass
        if adapter.cleanup_thread is not None:
            adapter.cleanup_thread.join(timeout=STOP_TIMEOUT * 3)


# --- client side --------------------------------------------------------------------------

def parse_startup(line):
    if len(line) > STARTUP_LIMIT or not line.endswith(b"\n"):
        raise DescriptorError("dap-connect needs one line of startup data before DAP framing")
    try:
        startup = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DescriptorError("dap-connect startup data must be one UTF-8 JSON line") from None
    if not isinstance(startup, dict) or set(startup) != {"version", "preparedSession", "workspace", "backend"} \
            or not _integer(startup["version"]) or startup["version"] != 1:
        raise DescriptorError("dap-connect startup data must be {version: 1, preparedSession, workspace, backend}")
    for key in ("preparedSession", "workspace"):
        if not isinstance(startup[key], str) or "\0" in startup[key] or not os.path.isabs(startup[key]):
            raise DescriptorError(f"dap-connect startup {key} must be an absolute path")
    backend = startup["backend"]
    if not isinstance(backend, dict) or set(backend) != {"id", "version"}:
        raise DescriptorError("dap-connect startup backend must be {id, version}")
    return startup


def refuse_dap(reader, writer, message):
    """Answer every DAP request with the refusal so the editor shows it; end on EOF/disconnect."""
    stream = FramedStream(reader, writer)
    try:
        while (request := stream.read()) is not None:
            if request.get("type") != "request":
                continue
            stream.write({"seq": 0, "type": "response", "request_seq": request.get("seq", 0),
                          "command": request.get("command", "unknown"), "success": False, "message": message,
                          "body": {"error": {"id": 1, "format": message, "showUser": True}}})
            if request.get("command") == "disconnect":
                break
    except (ProtocolError, OSError):
        pass
    return 2


def connect_main():
    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    try:
        startup = parse_startup(reader.readline(STARTUP_LIMIT + 1))
        expected = startup["backend"]
        if (expected["id"], expected["version"]) != (BACKEND_ID, __version__):
            raise DescriptorError(f"the editor expects backend {expected['id']} {expected['version']}; "
                                  f"this is {BACKEND_ID} {__version__}")
        descriptor = read_descriptor(startup["preparedSession"])
        if not same_path(descriptor["workspace"], startup["workspace"]):
            raise DescriptorError("the prepared session belongs to another workspace folder "
                                  f"({descriptor['workspace']})")
        connection = authenticate(descriptor)
    except (DescriptorError, OSError) as exc:
        message = f"Cannot attach to the prepared Robot session: {exc}"
        print(message, file=sys.stderr, flush=True)
        return refuse_dap(reader, writer, message)
    print(f"dap-connect: attached to prepared session {descriptor['sessionId']} "
          f"(digest {public_digest(descriptor)[:16]})", file=sys.stderr, flush=True)
    del descriptor  # The secret is no longer needed.

    def upstream():
        try:
            while data := reader.read1(65536):
                connection.sendall(data)
        except OSError:
            pass
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass
    threading.Thread(target=upstream, daemon=True).start()
    try:
        while data := connection.recv(65536):
            writer.write(data)
            writer.flush()
    except OSError:
        pass
    finally:
        connection.close()
    return 0


# --- Windows: protected descriptor DACL ----------------------------------------------------

_WIN = None


def _windows():
    global _WIN
    if _WIN is None:
        _WIN = _WindowsSecurity()
    return _WIN


class _WindowsSecurity:
    """ctypes access to the few Win32 calls a private descriptor needs."""

    GENERIC_READ, GENERIC_WRITE, READ_CONTROL = 0x80000000, 0x40000000, 0x00020000
    CREATE_NEW, OPEN_EXISTING = 1, 3
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_SHARE_READ = 1
    SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION = 1, 1, 4
    SE_DACL_PROTECTED = 0x1000
    ACCESS_ALLOWED_ACE_TYPE = 0
    WIN_LOCAL_SYSTEM_SID = 22

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes, self.wintypes = ctypes, wintypes
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        k, a = self.kernel32, self.advapi32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.CreateFileW.restype = wintypes.HANDLE
        k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.LocalFree.argtypes = [ctypes.c_void_p]
        k.LocalFree.restype = ctypes.c_void_p
        k.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        a.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        a.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]
        a.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
        a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        a.GetSecurityInfo.restype = wintypes.DWORD
        a.GetSecurityInfo.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
                                      ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p)]
        a.GetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.WORD),
                                                   ctypes.POINTER(wintypes.DWORD)]
        a.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
        a.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        a.IsWellKnownSid.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.user = self._user_sid()

    def _error(self, action):
        error = self.ctypes.get_last_error()
        return OSError(f"{action} failed: {self.ctypes.FormatError(error).strip()} (Windows error {error})")

    def _user_sid(self):
        ctypes, wintypes = self.ctypes, self.wintypes
        token = wintypes.HANDLE()
        if not self.advapi32.OpenProcessToken(self.kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise self._error("OpenProcessToken")
        try:
            needed = wintypes.DWORD()
            self.advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
            buffer = ctypes.create_string_buffer(needed.value)
            if not self.advapi32.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
                raise self._error("GetTokenInformation")
            sid = ctypes.c_void_p.from_buffer(buffer).value  # TOKEN_USER.User.Sid
            text = wintypes.LPWSTR()
            if not self.advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
                raise self._error("ConvertSidToStringSidW")
            try:
                self.user_text = text.value
            finally:
                self.kernel32.LocalFree(text)
            self.user_buffer = buffer  # keeps `sid` valid
            return sid
        finally:
            self.kernel32.CloseHandle(token)

    def created(self):
        times = [self.wintypes.FILETIME() for _ in range(4)]
        if not self.kernel32.GetProcessTimes(self.kernel32.GetCurrentProcess(), *map(self.ctypes.byref, times)):
            raise self._error("GetProcessTimes")
        return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime

    def _open(self, path, access, share, disposition, attributes=None, flags=0):
        handle = self.kernel32.CreateFileW(path, access, share, attributes, disposition, flags, None)
        if handle in (None, self.wintypes.HANDLE(-1).value):
            raise self._error(f"CreateFileW {path}")
        return handle

    def _fd(self, handle, mode):
        import msvcrt
        try:
            return msvcrt.open_osfhandle(handle, mode)
        except OSError:
            self.kernel32.CloseHandle(handle)
            raise

    def create_private(self, path, data):
        ctypes, wintypes = self.ctypes, self.wintypes

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                        ("bInheritHandle", wintypes.BOOL)]
        # Protected DACL (no inherited entries): full access for this account and the OS only.
        sddl = f"O:{self.user_text}D:P(A;;FA;;;{self.user_text})(A;;FA;;;SY)"
        descriptor = ctypes.c_void_p()
        if not self.advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor),
                                                                                  None):
            raise self._error("ConvertStringSecurityDescriptorToSecurityDescriptorW")
        try:
            attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
            handle = self._open(path, self.GENERIC_WRITE, 0, self.CREATE_NEW, ctypes.byref(attributes))
        finally:
            self.kernel32.LocalFree(descriptor)
        fd = self._fd(handle, os.O_WRONLY | os.O_BINARY)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        self.read_private(path, len(data) + 1)  # The new file must pass the reader's own checks.

    def move_new(self, source, target):
        if not self.kernel32.MoveFileExW(source, target, 0):  # no MOVEFILE_REPLACE_EXISTING
            raise self._error("MoveFileExW")

    def _check_private(self, handle):
        ctypes, wintypes = self.ctypes, self.wintypes
        owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
        error = self.advapi32.GetSecurityInfo(handle, self.SE_FILE_OBJECT,
                                              self.OWNER_SECURITY_INFORMATION | self.DACL_SECURITY_INFORMATION,
                                              ctypes.byref(owner), None, ctypes.byref(dacl), None,
                                              ctypes.byref(descriptor))
        if error:
            raise OSError(f"GetSecurityInfo failed (Windows error {error})")
        try:
            if not self.advapi32.EqualSid(owner, self.user):
                raise DescriptorError("The prepared session descriptor must be owned by this user")
            control, revision = wintypes.WORD(), wintypes.DWORD()
            if not self.advapi32.GetSecurityDescriptorControl(descriptor, ctypes.byref(control),
                                                              ctypes.byref(revision)):
                raise self._error("GetSecurityDescriptorControl")
            if not dacl.value or not control.value & self.SE_DACL_PROTECTED:
                raise DescriptorError("The prepared session descriptor must have a protected private DACL")
            count = ctypes.c_ushort.from_address(dacl.value + 4).value  # ACL.AceCount
            for index in range(count):
                ace = ctypes.c_void_p()
                if not self.advapi32.GetAce(dacl, index, ctypes.byref(ace)):
                    raise self._error("GetAce")
                if ctypes.c_ubyte.from_address(ace.value).value != self.ACCESS_ALLOWED_ACE_TYPE:
                    continue  # Deny entries only narrow access.
                sid = ace.value + 8  # ACCESS_ALLOWED_ACE: header (4), mask (4), SID
                if not (self.advapi32.EqualSid(sid, self.user)
                        or self.advapi32.IsWellKnownSid(sid, self.WIN_LOCAL_SYSTEM_SID)):
                    raise DescriptorError("The prepared session descriptor grants access to another account")
        finally:
            self.kernel32.LocalFree(descriptor)

    def read_private(self, path, limit):
        handle = self._open(path, self.GENERIC_READ | self.READ_CONTROL, self.FILE_SHARE_READ, self.OPEN_EXISTING,
                            flags=self.FILE_FLAG_OPEN_REPARSE_POINT)
        try:
            self._check_private(handle)
        except BaseException:
            self.kernel32.CloseHandle(handle)
            raise
        fd = self._fd(handle, os.O_RDONLY | os.O_BINARY)
        try:
            info = os.fstat(fd)
            if info.st_file_attributes & (stat.FILE_ATTRIBUTE_REPARSE_POINT | stat.FILE_ATTRIBUTE_DIRECTORY):
                raise DescriptorError("The prepared session descriptor is not a regular file")
            if info.st_size >= limit:
                raise DescriptorError(f"Invalid prepared session descriptor: larger than {DESCRIPTOR_LIMIT} bytes")
            chunks, size = [], 0
            while size < limit and (chunk := os.read(fd, limit - size)):
                chunks.append(chunk)
                size += len(chunk)
            return b"".join(chunks)
        finally:
            os.close(fd)

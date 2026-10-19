"""Private authenticated loopback channel between the DAP adapter and its Robot worker.

The adapter listens on 127.0.0.1 with an OS-allocated port and generates a random
32-byte session secret. The worker receives the port in its argv and the secret as
one hex line on its stdin pipe, which the adapter closes after writing; the secret
is never in argv or the environment and never crosses the socket. Both sides
prove knowledge of the secret with HMAC-SHA256 over fresh nonces from both ends:

    worker  -> adapter  HELLO + worker nonce
    adapter -> worker   adapter nonce + HMAC(secret, "adapter" + worker nonce + adapter nonce)
    worker  -> adapter  HMAC(secret, "worker" + adapter nonce + worker nonce)

The adapter closes any connection that fails this exchange and keeps waiting for
its worker; once the worker is authenticated the listener is closed, so the
session has exactly one control connection. Framed control and event messages
then share that full-duplex socket unchanged. Standard library only, so it works
on POSIX and Windows (where the listener also sets SO_EXCLUSIVEADDRUSE).
"""

import hashlib
import hmac
import secrets
import socket
import time

HOST = "127.0.0.1"
HELLO = b"RCB-CONTROL-1\n"
SECRET_BYTES = 32
NONCE_BYTES = 32
MAC_BYTES = hashlib.sha256().digest_size
HANDSHAKE_TIMEOUT = 2  # whole adapter-side handshake of one connection
CONNECT_TIMEOUT = 30  # worker side; the adapter may first refuse foreign connections


class ControlError(OSError):
    pass


def mac(secret, role, first, second):
    return hmac.new(secret, role + first + second, hashlib.sha256).digest()


def receive_exactly(connection, size, deadline=None):
    """Read `size` bytes; with `deadline` (time.monotonic) the whole read is bounded."""
    data = bytearray()
    while len(data) < size:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("control authentication timed out")
            connection.settimeout(remaining)
        part = connection.recv(size - len(data))
        if not part:
            raise ControlError("control peer closed the connection during authentication")
        data.extend(part)
    return bytes(data)


def parse_secret(line):
    """The secret from the worker's stdin line; ControlError if malformed."""
    text = line.strip()
    try:
        secret = bytes.fromhex(text.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        secret = b""
    if len(secret) != SECRET_BYTES:
        raise ControlError("worker stdin did not supply a control secret")
    return secret


class ControlListener:
    """Adapter side: a one-use listener that accepts only the peer holding its secret."""

    def __init__(self):
        self.secret = secrets.token_bytes(SECRET_BYTES)
        self.refused = []
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

    def secret_line(self):
        return self.secret.hex().encode("ascii") + b"\n"

    def accept(self, timeout, alive, refused=None):
        """Return the authenticated connection, or None when `alive()` turns false or time runs out.

        Connections are authenticated one at a time, each within HANDSHAKE_TIMEOUT.
        `refused(detail)` is called for each closed unauthenticated connection.
        """
        deadline = time.monotonic() + timeout
        try:
            while (remaining := deadline - time.monotonic()) > 0 and alive():
                self.server.settimeout(min(0.2, remaining))
                try:
                    connection, address = self.server.accept()
                except socket.timeout:
                    continue
                try:
                    self._authenticate(connection, time.monotonic() + min(HANDSHAKE_TIMEOUT, remaining))
                except OSError as exc:
                    connection.close()
                    detail = f"{address[0]}:{address[1]} ({exc})"
                    self.refused.append(detail)
                    if refused is not None:
                        refused(detail)
                    continue
                connection.settimeout(None)
                return connection
            return None
        finally:
            self.close()

    def _authenticate(self, connection, deadline):
        hello = receive_exactly(connection, len(HELLO) + NONCE_BYTES, deadline)
        if not hmac.compare_digest(hello[:len(HELLO)], HELLO):
            raise ControlError("not a Robot worker control handshake")
        worker_nonce, adapter_nonce = hello[len(HELLO):], secrets.token_bytes(NONCE_BYTES)
        connection.sendall(adapter_nonce + mac(self.secret, b"adapter", worker_nonce, adapter_nonce))
        proof = receive_exactly(connection, MAC_BYTES, deadline)
        if not hmac.compare_digest(proof, mac(self.secret, b"worker", adapter_nonce, worker_nonce)):
            raise ControlError("worker failed control authentication")

    def close(self):
        self.server.close()


def connect(port, secret, timeout=CONNECT_TIMEOUT):
    """Worker side: connect to the adapter and authenticate both ends."""
    connection = socket.create_connection((HOST, port), timeout=timeout)
    try:
        worker_nonce = secrets.token_bytes(NONCE_BYTES)
        connection.sendall(HELLO + worker_nonce)
        reply = receive_exactly(connection, NONCE_BYTES + MAC_BYTES)
        adapter_nonce, proof = reply[:NONCE_BYTES], reply[NONCE_BYTES:]
        if not hmac.compare_digest(proof, mac(secret, b"adapter", worker_nonce, adapter_nonce)):
            raise ControlError("control listener failed authentication")
        connection.sendall(mac(secret, b"worker", adapter_nonce, worker_nonce))
        connection.settimeout(None)
        return connection
    except BaseException:
        connection.close()
        raise

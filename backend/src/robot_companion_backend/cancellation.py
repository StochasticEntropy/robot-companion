"""Cooperative foreground cancellation; no concurrent workspace mutation."""

from contextlib import contextmanager
from contextvars import ContextVar


class RequestCancelled(Exception):
    code = -32800


current = ContextVar("language_request_cancellation", default=None)


def checkpoint():
    event = current.get()
    if event is not None and event.is_set():
        raise RequestCancelled("Request cancelled")


@contextmanager
def request(event):
    token = current.set(event)
    try:
        checkpoint()
        yield
        checkpoint()
    finally:
        current.reset(token)

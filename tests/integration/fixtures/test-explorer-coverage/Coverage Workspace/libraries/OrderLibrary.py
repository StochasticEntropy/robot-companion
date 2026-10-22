"""Order keywords of the synthetic coverage workspace."""
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor", "site-packages"))
import vendored  # noqa: E402  A third-party folder: never measured.
from pricing import discount  # noqa: E402

STORE = {}


def open_store():
    STORE["open"] = True


def order_total(quantity):
    quantity = int(quantity)
    price = quantity * 10
    if quantity >= 100:
        price -= discount(price)
    return vendored.identity(price)


def run_in_background():
    found = []
    worker = threading.Thread(target=lambda: found.append(_answer()))
    worker.start()
    worker.join()
    return found[0]


def _answer():
    return 42


def never_called():
    return "not run"

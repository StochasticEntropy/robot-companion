"""Synthetic library keyword that blocks in Python until the test releases it."""

import sys
import time
from pathlib import Path


def wait_for_release(name):
    # Bypass RF's captured stdout so the test sees the marker as a DAP output event.
    sys.__stdout__.write("controls-blocking-started\n")
    sys.__stdout__.flush()
    deadline = time.monotonic() + 60
    while not Path(name).exists():
        if time.monotonic() > deadline:
            raise AssertionError(f"{name} was not created within 60 seconds")
        time.sleep(0.05)

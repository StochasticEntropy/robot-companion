"""Robot worker child owned by the DAP adapter; experimental paused-thread listener."""

import argparse
import os
import select
import socket
import queue
import sys
import threading

from . import control as control_channel
from .protocol import FramedStream, ProtocolError
from .python_debug import SessionReader

FAILURE_FILTERS = ("robot-failed-keyword", "robot-failed-test")
# Set once debugpy is attached: see the end of this module.
debugpy_attached = False


STOP_TIMEOUT = 5


class ControlPump:
    """The only reader of the adapter's control stream once the Robot run starts.

    Messages are queued in arrival order and consumed only by the Robot execution
    thread (the listener), which alone changes debugger state and calls RF. The pump
    evaluates nothing. EOF or a framing error ends the queue with a `None` sentinel.
    """

    def __init__(self, stream, stopping, events):
        self.stream = stream
        self.events = events
        self.stopping = stopping
        self.messages = queue.Queue()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def _run(self):
        try:
            while (message := self.stream.read()) is not None:
                if message.get("command") == "failureFilters":
                    filters, revision = message.get("filters"), message.get("revision")
                    if not isinstance(filters, list) or not set(filters) <= set(FAILURE_FILTERS) or type(revision) is not int:
                        self.events.write({"requestId": message.get("requestId"), "error": "Invalid failure filters"})
                        continue
                    self.messages.put(message)
                    self.events.write({"requestId": message.get("requestId"), "body": {"queued": revision}})
                else:
                    self.messages.put(message)
        except (ProtocolError, OSError):
            pass
        self.messages.put(None)

    def get(self):
        """Block until the next message (the paused loop)."""
        return self.messages.get()

    def pending(self):
        """Messages that arrived before this safe point; later ones wait for the next."""
        snapshot = []
        for _ in range(self.messages.qsize()):
            try:
                snapshot.append(self.messages.get_nowait())
            except queue.Empty:
                break
        return snapshot

    def stop(self):
        self.stopping.set()
        self.thread.join(timeout=STOP_TIMEOUT)

def closed_by_adapter(connection):
    """True once the adapter closed the control channel, which asks this run to stop. While Robot
    runs, the adapter sends nothing, so readable without data means EOF; nothing is consumed."""
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def main(argv=None):
    global debugpy_attached
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--python-debug", action="store_true")
    parser.add_argument("robot_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    # The adapter decodes this process's stdout/stderr as UTF-8; a Windows pipe would otherwise
    # get the ANSI code page. Only this interpreter changes, not the environment of its children.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    # The adapter writes the session secret to stdin and closes it (see control.py).
    try:
        secret = control_channel.parse_secret(sys.stdin.buffer.readline(control_channel.SECRET_BYTES * 2 + 2))
        connection = control_channel.connect(args.control_port, secret)
    except OSError as exc:
        print(f"Robot worker control channel failed: {exc}", file=sys.stderr)
        return 4
    events = FramedStream(None, connection.makefile("wb"))
    # A select-based reader: the pump can be stopped while the adapter keeps the socket open.
    stopping = threading.Event()
    control = FramedStream(SessionReader(connection, stopping), None)
    from .runtime import robot_version, unsupported_reason
    if reason := unsupported_reason():
        events.write({"event": "prerequisite", "message": reason})
        return 3
    if args.python_debug:
        from .python_debug import require_debugpy
        try:
            require_debugpy()
            import debugpy
            debugpy.configure(subProcess=False)
        except (ImportError, ValueError) as exc:
            events.write({"event": "prerequisite", "message": str(exc)})
            return 3
    events.write({"event": "ready", "robot": robot_version(), "python": sys.version.split()[0],
                  "processId": os.getpid()})
    python_connected = False
    while True:
        try:
            message = control.read()
        except ProtocolError:
            return 4
        if not message:
            return 4
        if message.get("command") == "connectPython" and args.python_debug and not python_connected:
            if message.get("version") != 1 or message.get("host") != "127.0.0.1" \
                    or type(message.get("port")) is not int or not 0 < message["port"] <= 65535:
                return 4
            try:
                debugpy.connect((message["host"], message["port"]))
            except Exception as exc:
                events.write({"event": "output", "body": {"category": "important", "output": str(exc)}})
                return 4
            python_connected = True
            debugpy_attached = True
            events.write({"event": "robotCompanion/pythonConnected", "body": {
                "version": 1, "sessionId": message["sessionId"], "debuggeeProcessId": os.getpid()}})
        elif message.get("command") == "configurationDone":
            if args.python_debug and not python_connected:
                return 4
            break
        else:
            return 4
    robot_args = args.robot_args[1:] if args.robot_args[:1] == ["--"] else args.robot_args
    from .listener import RobotListener
    filters = message.get("failureFilters", [])
    if not isinstance(filters, list) or not set(filters) <= set(FAILURE_FILTERS):
        return 4
    handle_base = message.get("handleBase", 1)
    if type(handle_base) is not int or handle_base < 1:
        return 4
    commands = ControlPump(control, stopping, events).start()
    try:
        listener = RobotListener(commands, events, message.get("breakpoints", {}),
                                 filters, message.get("filterRevision", 0), handle_base,
                                 stop_requested=lambda: closed_by_adapter(connection))
        return run_robot(robot_args, listener, events)
    finally:
        # Half-close on every exit once the control reader runs: the adapter then reads a clean
        # end of stream. On Windows, exiting while that reader still waits in recv would
        # otherwise reset the connection.
        commands.stop()
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def run_robot(robot_args, listener, events):
    """Run Robot with the in-process listener and return its exit status."""
    # run_cli accepts no listener instance: parse the CLI with RF's public parser,
    # then execute with the in-process listener added to any user listeners.
    from robot.errors import DataError, Information, INFO_PRINTED
    from robot.run import RobotFramework
    application = RobotFramework()
    try:
        options, sources = application.parse_arguments(robot_args)
    except Information as info:  # --help/--version: RF's own exit status (no `rc` before RF 7.5)
        events.write({"event": "output", "body": {"category": "stdout", "output": f"{info.message}\n"}})
        return getattr(info, "rc", INFO_PRINTED)
    except DataError as exc:
        events.write({"event": "output", "body": {"category": "important",
                                                  "output": f"{exc.message}\n\nTry --help for usage information.\n"}})
        return 252
    options["listener"] = [*(options.get("listener") or []), listener]
    return application.execute(*sources, **options)


def finish(code):
    """End the worker with Robot's exit status.

    With debugpy attached, a SystemExit carrying a non-zero status (a failed test) would
    be an uncaught Python exception to the Python child session, which then stops on it
    and the debug session cannot end. The worker then flushes its output and ends
    directly. Status 0 is no exception to debugpy and ends normally.
    """
    if not debugpy_attached or code == 0:
        sys.exit(code)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError):
            pass
    os._exit(code if isinstance(code, int) and 0 <= code <= 255 else 255)


if __name__ == "__main__":
    finish(main())

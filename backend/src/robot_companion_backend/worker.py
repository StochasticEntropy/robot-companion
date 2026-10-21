"""Robot worker child owned by the DAP adapter; experimental paused-thread listener."""

import argparse
import os
import queue
import sys
import threading

from . import control as control_channel
from .protocol import FramedStream, ProtocolError

FAILURE_FILTERS = ("robot-failed-keyword", "robot-failed-test")


class Commands:
    """The worker's only control reader once the run is configured.

    Commands are queued in arrival order for the Robot execution thread, which runs
    every Robot operation. A failure filter change is acknowledged here as soon as it
    is queued, so the adapter never waits for Robot execution; the Robot thread
    applies it at its next listener callback, or at once while paused. EOF or a
    protocol error queues None.
    """

    def __init__(self, control, events):
        self.control = control
        self.events = events
        self.queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                message = self.control.read()
            except (ProtocolError, OSError):
                message = None
            if message is None:
                self.queue.put(None)
                return
            if message.get("command") == "failureFilters":
                filters, revision = message.get("filters"), message.get("revision")
                if not isinstance(filters, list) or not set(filters) <= set(FAILURE_FILTERS) \
                        or type(revision) is not int:
                    self.events.write({"requestId": message.get("requestId"), "error": "Invalid failure filters"})
                    continue
                self.queue.put(message)
                self.events.write({"requestId": message.get("requestId"), "body": {"queued": revision}})
            else:
                self.queue.put(message)

    def get(self):
        return self.queue.get()

    def pending(self):
        """A bounded snapshot of queued commands, so a stream of changes cannot starve the run."""
        snapshot = []
        for _ in range(self.queue.qsize()):
            try:
                snapshot.append(self.queue.get_nowait())
            except queue.Empty:
                break
        return snapshot


def main(argv=None):
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
    control = FramedStream(connection.makefile("rb"), None)
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
    listener = RobotListener(Commands(control, events), events, message.get("breakpoints", {}),
                             filters, message.get("filterRevision", 0))
    # run_cli accepts no listener instance: parse the CLI with RF's public parser,
    # then execute with the in-process listener added to any user listeners.
    from robot.errors import DataError, Information
    from robot.run import RobotFramework
    application = RobotFramework()
    try:
        options, sources = application.parse_arguments(robot_args)
    except Information as info:  # --help/--version: RF's own exit status
        events.write({"event": "output", "body": {"category": "stdout", "output": f"{info.message}\n"}})
        return info.rc
    except DataError as exc:
        events.write({"event": "output", "body": {"category": "important",
                                                  "output": f"{exc.message}\n\nTry --help for usage information.\n"}})
        return 252
    options["listener"] = [*(options.get("listener") or []), listener]
    return application.execute(*sources, **options)


if __name__ == "__main__":
    sys.exit(main())

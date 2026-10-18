"""Robot worker child owned by the DAP adapter; experimental paused-thread listener."""

import argparse
import os
import sys

from .protocol import FramedStream, ProtocolError

REQUIRED_ROBOT = ("7", "5")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-fd", type=int, required=True)
    parser.add_argument("--event-fd", type=int, required=True)
    parser.add_argument("--python-debug", action="store_true")
    parser.add_argument("robot_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    events = FramedStream(None, os.fdopen(args.event_fd, "wb"))
    control = FramedStream(os.fdopen(args.control_fd, "rb"), None)
    try:
        import robot
        from robot.version import VERSION
    except ImportError as exc:
        events.write({"event": "prerequisite", "message": f"Robot Framework 7.5 is required in {sys.executable}: {exc}"})
        return 3
    if tuple(VERSION.split(".")[:2]) != REQUIRED_ROBOT:
        events.write({"event": "prerequisite", "message": f"Robot Framework 7.5 is required; found {VERSION}"})
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
    events.write({"event": "ready", "robot": VERSION, "python": sys.version.split()[0]})
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
    listener = RobotListener(control, events, message.get("breakpoints", {}))
    return robot.run_cli(robot_args, exit=False, listener=listener)


if __name__ == "__main__":
    sys.exit(main())

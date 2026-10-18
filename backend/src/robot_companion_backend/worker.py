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
    events.write({"event": "ready", "robot": VERSION, "python": sys.version.split()[0]})
    try:
        message = control.read()
    except ProtocolError:
        return 4
    if not message or message.get("command") != "configurationDone":
        return 4
    robot_args = args.robot_args[1:] if args.robot_args[:1] == ["--"] else args.robot_args
    from .listener import RobotListener
    listener = RobotListener(control, events, message.get("breakpoints", {}))
    return robot.run_cli(robot_args, exit=False, listener=listener)


if __name__ == "__main__":
    sys.exit(main())

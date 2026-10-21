"""Robot worker of one interactive session, owned by the `interactive` service.

It connects to the service over the authenticated private channel of control.py, then runs
one generated Robot test in-process whose only step serves the session's cells (see
interactive_session.py). The worker's working directory is the session's: the workspace
folder. Of the Robot arguments, the options that shape a keyword's context apply (APPLIED);
the others select or report tests and are listed as ignored. No output, log or report file
is written; definition cells are kept in the service-owned session directory.
"""

import argparse
import os
import sys

from . import control as control_channel
from .protocol import FramedStream, ProtocolError

# robot options that apply to a session: variables, variable files, the Python path for
# libraries, the log level of forwarded messages and the data languages of cells.
APPLIED = ("variable", "variablefile", "pythonpath", "loglevel", "language")
SUITE_NAME = "Robot Companion Session"


class LogForwarder:
    """Forwards the messages keywords log (at the session's log level) to the running cell."""

    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self, session):
        self.session = session

    def log_message(self, message):
        self.session.output("log", message.message, level=message.level, html=bool(message.html))

    def message(self, message):
        # RF's own errors and warnings, such as a variable file that could not be imported.
        if message.level in ("ERROR", "WARN"):
            self.session.notice(message.level, message.message)


def session_options(robot_args):
    """(options for TestSuite.run, applied options, ignored option names)."""
    from robot.run import RobotFramework
    # The parser requires a data source; the generated session suite is not a file.
    options, _ = RobotFramework().parse_arguments([*robot_args, SUITE_NAME])
    applied = {name: options[name] for name in APPLIED if options.get(name) not in (None, [], ())}
    ignored = sorted(name for name, value in options.items()
                     if name not in APPLIED and value not in (None, [], (), False))
    return applied, ignored


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--session-dir", required=True)
    parser.add_argument("robot_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        secret = control_channel.parse_secret(sys.stdin.buffer.readline(control_channel.SECRET_BYTES * 2 + 2))
        connection = control_channel.connect(args.control_port, secret)
    except OSError as exc:
        print(f"Robot session control channel failed: {exc}", file=sys.stderr)
        return 4
    events = FramedStream(None, connection.makefile("wb"))
    control = FramedStream(connection.makefile("rb"), None)
    from .runtime import robot_version, unsupported_reason
    if reason := unsupported_reason():
        events.write({"event": "prerequisite", "message": reason})
        return 3
    robot_args = args.robot_args[1:] if args.robot_args[:1] == ["--"] else args.robot_args
    from robot.conf import RobotSettings
    from robot.errors import DataError, Information
    try:
        applied, ignored = session_options(robot_args)
        # As `robot --pythonpath` does; TestSuite.run itself leaves sys.path alone.
        sys.path[:0] = RobotSettings(applied).pythonpath
    except (DataError, Information) as exc:
        events.write({"event": "prerequisite", "message": f"Invalid Robot arguments: {exc.message}"})
        return 3
    from . import interactive_session
    from robot.running import TestSuite
    session = interactive_session.Session(control, events, args.session_dir)
    session.applied, session.ignored = applied, ignored
    session.languages = applied.get("language")
    session.ready = {"robot": robot_version(), "python": sys.version.split()[0], "executable": sys.executable,
                     "applied": applied, "ignored": ignored}
    interactive_session.ACTIVE = session
    suite = TestSuite(name=SUITE_NAME)
    suite.resource.imports.library("robot_companion_backend.interactive_session.SessionLibrary")
    suite.tests.create(name="Robot Companion Session").body.create_keyword(interactive_session.SESSION_KEYWORD)
    session.start_reader()
    session.redirect_output()
    try:
        result = suite.run(**applied, output=None, log=None, report=None, console="none",
                           listener=[LogForwarder(session)])
    except DataError as exc:
        events.write({"event": "prerequisite", "message": f"Invalid Robot arguments: {exc.message}"})
        return 3
    except ProtocolError:
        return 4
    if session.ready is not None and not session.serving:
        # RF ended the session test before it served (for example, an invalid variable file).
        test = result.suite.tests[0] if result.suite.tests else None
        events.write({"event": "prerequisite", "message": (test.message if test else "") or
                      "Robot Framework did not start the session"})
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""The supported runtime matrix: each row is one Python minor version with one exact Robot
Framework release. pyproject.toml declares the same rows (requires-python and environment
markers on robotframework); every service refuses any other combination before using RF."""

import sys

# (Python major.minor, exact Robot Framework version), verified on Linux aarch64 only.
SUPPORTED = (((3, 11), "7.3.2"), ((3, 13), "7.5"))


def describe_supported():
    return ", ".join(f"Python {major}.{minor} + Robot Framework {robot}" for (major, minor), robot in SUPPORTED)


def _robot():
    """(version, import error) of the `robot` package this interpreter executes: the same
    import the services use, not distribution metadata."""
    try:
        from robot.version import VERSION
    except ImportError as exc:
        return None, exc
    return VERSION, None


def robot_version():
    return _robot()[0]


def unsupported_reason():
    """None for a supported row, else the prerequisite message naming the supported set."""
    robot, error = _robot()
    python = tuple(sys.version_info[:2])
    if robot and (python, robot) in SUPPORTED:
        return None
    found = f"Robot Framework {robot}" if robot else f"no importable Robot Framework ({error})"
    return (f"Unsupported runtime in {sys.executable}: Python {python[0]}.{python[1]} with {found}. "
            f"Supported: {describe_supported()}.")


def row():
    """This interpreter's Python/RF combination and the supported matrix, for doctor/evidence."""
    return {"python": "%d.%d" % sys.version_info[:2], "robotframework": robot_version(),
            "supported": unsupported_reason() is None,
            "supportedRows": [{"python": f"{major}.{minor}", "robotframework": version}
                              for (major, minor), version in SUPPORTED]}

import subprocess

from robot.api.deco import keyword


@keyword("Wait In Child Process")
def wait_in_child_process(seconds: str = "300"):
    """Start a child process in this run's process group and wait for it."""
    subprocess.run(["sleep", str(seconds)], check=True)

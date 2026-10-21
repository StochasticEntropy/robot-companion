from robot.api.deco import keyword


@keyword("Twin Step")
def twin_step(left):
    return left


@keyword("Shadowed Step")
def shadowed_step(library_argument):
    """The local keyword of hints.robot takes precedence over this one."""
    return library_argument

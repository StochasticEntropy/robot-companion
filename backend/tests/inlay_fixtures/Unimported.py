from robot.api.deco import keyword


@keyword("Build Record")
def unrelated_build_record(label: str = "unused") -> int:
    """Not imported by hints.robot: its argument name and return type never appear."""
    return 0

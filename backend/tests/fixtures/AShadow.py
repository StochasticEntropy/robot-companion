from robot.api.deco import keyword


@keyword("Build Record")
def unrelated_build_record(name: str = "unused"):
    """Unrelated shadow implementation: this library is not imported by audit.robot.

    Args:
        name: A value that should not be selected for this test's keyword.
    """
    return "wrong-library"

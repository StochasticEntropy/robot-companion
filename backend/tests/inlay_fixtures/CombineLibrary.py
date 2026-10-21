from robot.api.deco import keyword


@keyword("Combine")
def combine(first: str = "", /, second: str = "", *rest: str) -> str:
    """Join the values: `first` is positional-only, `rest` collects the others."""
    return " ".join((first, second, *rest))

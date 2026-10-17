from dataclasses import dataclass
from robot.api.deco import keyword


@dataclass
class Record:
    name: str
    count: int


@keyword("Build Record")
def build_record(name: str = "Ada") -> Record:
    """Build a record for the isolated editor audit.

    Args:
        name: The name to store in the returned record.
    """
    count = len(name)
    return Record(name=name, count=count)

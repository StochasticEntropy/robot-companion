from dataclasses import dataclass
from robot.api.deco import keyword


@dataclass
class Record:
    name: str
    count: int


@keyword("Build Record")
def build_record(name: str = "Ada") -> Record:
    """Build a record."""
    return Record(name=name, count=len(name))

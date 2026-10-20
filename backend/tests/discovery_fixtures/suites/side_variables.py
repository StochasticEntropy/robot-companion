from pathlib import Path

# Importing this variable file is the observable side effect: discovery must never do it.
Path(__file__).with_name("variables-imported.marker").write_text("imported", encoding="utf-8")
SIDE_VALUE = "side"

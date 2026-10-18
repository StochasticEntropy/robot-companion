from pathlib import Path

# Importing this library is the observable side effect: discovery must never do it.
Path(__file__).with_name("library-imported.marker").write_text("imported", encoding="utf-8")


def side_effect_keyword():
    Path(__file__).with_name("keyword-ran.marker").write_text("ran", encoding="utf-8")

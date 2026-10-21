Synthetic project for the robot.toml and Markdown UI case. The case copies this folder into
the UI workspace as `integration-project-files/` and writes `robot.toml.txt` as the workspace
folder's `robot.toml` only while it runs, so other UI cases never see either.
`markdown_login.robot.md` is a Robot Framework 7.5 Markdown suite, `markdown_keywords.md`
a Markdown resource, `lib/tomlkw.py` a library found only through robot.toml's `python-path`.

Synthetic project for the project Robot configuration UI case: `lib/` is on the module
search path only through `--pythonpath`, `vars/env.py` is a `--variablefile`, and
`--variable ENV:prod` overrides the suite's own `${ENV}`. Without those
`robotCompanion.robotArguments`, Robot Framework cannot import `projectlib`.

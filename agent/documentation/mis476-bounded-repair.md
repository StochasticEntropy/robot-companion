# Selected-environment bounded repair

This continues the original outcome; it is a checkpoint, not acceptance. The copied
CTO technical plan is revision `5ae62567-bf4d-488f-acff-7aeaf5ff2ce4`, SHA-256
`51477b7096a8b738b4955c2282e4ce3bf32017787c2ddbc8a95a7ddcabc2c64f`.

The interaction baseline was audited before these edits at source
`ed3ceba855ebf4ee8c8388668d6e2b26b2617e54` with empty full Git porcelain.
Command (exit 1, 0 passing / 4 failing, no pending cases):

```bash
ROBOT_COMPANION_UI_GREP='Owned debugging with the pinned RobotCode 2.7.0 bridge|Test Explorer shows exactly|switching back to RobotCode|Test Explorer discovery per combination' xvfb-run -a npm run test:ui
```

The owned VS Code 1.141.0 profile exercised copied synthetic fixtures with real CDP
pointer/keyboard input, the installed RobotCode 2.7.0 bridge and an offline backend
built from this checkout. Retained baseline: `/evidence/mis476-bounded-20261020/red.log`,
`red.exit`, `source-before.json` and `red/` (actions, protocol and screenshots).
The screenshots and action transcripts establish the interaction audit; this was
agent-driven verification, not a human usability session.

The mixed debug journey completed with Robot/Python stops and 1 PASS but classified
an unprefixed environment line as program output. Native discovery matched the
backend tree, then failed on the old Run-command wording. Both provider journeys
lost the language-status entry at 1280×900: the long Robot unavailable warning
consumed its status-bar space. The retained screenshot shows the missing entry.

The repair prefixes Companion's own debug environment line consistently, shortens
status warnings while preserving their full accessible tooltip, and aligns the
native-discovery assertion with the selected-environment/explicit-command rule.
Tree equality, mixed output, debugger/process cleanup and real input checks remain.
The existing environment UI case now also checks the unavailable tooltip and
language-status visibility at 1024 and 1280 pixels. README and CHANGELOG document
the visible changes in their existing homes.

Run the plan's affected deterministic checks, the same focused UI profile and the
environment UI suite at the committed candidate. Record exact SHA, commands, exits
and counts in the issue's checkpoint document and `/evidence`. Remaining normal
hosts and full release checks belong to the subsequent handoff boundary. Existing
baseline failures and the live Windows qualification gap are not waived.

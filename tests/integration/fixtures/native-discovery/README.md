# Native discovery fixture (synthetic)

Owned by the integration track for Test Explorer over the native backend's
discovery service (normalized discovery API v1). Copied into the UI workspace as
`integration-native-discovery/`. Synthetic data only.

- `native_tasks.robot`: a `*** Tasks ***` section with a task template; RF names
  the suite `Native Tasks`.
- `nested/native_names.robot` (suite `Native Names`): a test whose name has
  umlauts and non-BMP characters (`Grüße aus Köln 🎉 und 𝄞`); two tests named
  `Duplicate Name`, the first passes and the second fails, so each occurrence must
  report its own result; `Needs Ready Flag` fails until `native.ready` exists next
  to the file (Rerun Failed); `Login On ${ENVIRONMENT}`, which RF runs (and the
  backend lists) as `Login On staging`.
- `native_waits.robot` (suite `Native Waits`): `Waits For Stop` waits in a
  `sleep 300` child of the Robot process group, so Stop must end that whole group.

# Test Explorer run fixture (synthetic)

Owned by the integration track for Test Explorer run selection, failure
reporting, rerun failed, cancellation and debug checks.

- `checkout.robot`: `Checkout Passes` passes; `Checkout Needs Ready Flag` fails
  with Robot's `File ... does not exist.` message until a `checkout.ready` file
  exists next to the suite, so a rerun can change its state; `Checkout Not
  Selected` must never run in a selection that excludes it.
- `billing.robot`: `Billing Passes` passes; `Billing Waits For Stop` runs
  `sleep 300` as a child process in the Robot process group, so a Stop must
  end that whole group.

# Controller

## Scope

This specification defines the controller behavior for detecting approved ref changes and deploying the secret runtime.

The controller is trusted because it can deploy secret-bearing containers.

## State

Controller state path:

```text
<stateRoot>/controller/secret-runtime.json
```

State shape:

```json
{
  "lastDeployedSha": "<sha>",
  "updatedAt": "<iso timestamp>"
}
```

Controller lock path:

```text
<stateRoot>/controller/secret-runtime.lock
```

The lock is an atomic directory.

## Tick Operation

`controllerTick` must:

1. Resolve the configured approved ref SHA.
2. Read the last deployed SHA.
3. Return unchanged if the previous SHA equals the current SHA.
4. Acquire the controller lock.
5. Re-read last deployed SHA under the lock.
6. Return unchanged if another controller already deployed the current SHA.
7. Deploy the secret runtime.
8. If not dry-run, write the current SHA as last deployed.
9. Release the lock in `finally`.
10. Return whether deployment occurred.

## Run Operation

`controller run` must:

- Validate that interval seconds is a positive safe integer.
- Run ticks until stopped.
- Stop after one tick when `--once` is true.
- Log one line per tick:

```text
<iso timestamp> <deployed|unchanged> <repo>:<approvedRef> <currentSha>
```

## Lock Behavior

If the lock directory already exists:

- The tick must fail with a user-facing error.
- The controller must not deploy.

If deployment throws:

- The lock directory must still be removed.
- The last deployed SHA must not be updated.

## Dry-Run Behavior

Dry-run mode passes dry-run to the deployment function.
Dry-run must not write `lastDeployedSha`.

## Invariants

- Controller deploys only from the approved ref.
- Concurrent controllers must not deploy over each other.
- Deployment state must update only after successful non-dry-run deployment.
- Controller lock is always released after callback completion or failure.

## Verification

Required verification:

- Unit test that first tick deploys and records state.
- Unit test that second tick is unchanged.
- Unit test that an existing lock refuses deployment.
- Unit test that lock is released after deploy failure.

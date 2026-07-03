# Job Lifecycle

## Scope

This specification defines job path calculation, preparation, cleanup, one-shot execution, metadata, and failure behavior.

## Job IDs

Job IDs must:

- Match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`.
- Not contain `..`.

Invalid job IDs must fail before host filesystem mutation.

## Paths

For a normalized config and job ID:

- `jobRoot`: `<stateRoot>/jobs/<jobId>`
- `diskImage`: `<jobRoot>/disk.img`
- `mountPoint`: `<jobMountRoot>/<jobId>`
- `workspace`: `<mountPoint>/workspace`
- `runtimeData`: `<mountPoint>/runtime-data`
- `metadata`: `<jobRoot>/metadata.json`

See [Filesystem Layout](local-details/filesystem-layout.md).

## State Claiming

Non-dry-run prepare must atomically claim both:

- `jobRoot`
- `mountPoint`

If `jobRoot` already exists, prepare must fail with a user-facing cleanup instruction.
If `mountPoint` already exists after `jobRoot` was created, prepare must remove the newly created `jobRoot` before failing.

This prevents accidental overwrite of existing job state.

## Prepare Operation

Input:

- Config.
- Job ID.
- Resource profile name.
- Dry-run flag.

Steps:

1. Validate job ID.
2. Resolve resource profile.
3. Resolve storage backend.
4. In non-dry-run mode, claim paths.
5. Execute or print the storage backend prepare plan.
6. Write metadata in non-dry-run mode.
7. Return metadata.

Metadata fields:

- `jobId`
- `profileName`
- `resourceProfile`
- `storageBackend`
- `paths`
- `createdAt`
- `mounted`

`mounted` is true only when the selected storage backend uses a mount and the command is not dry-run.

## Cleanup Operation

Input:

- Config.
- Job ID.
- Dry-run flag.
- Remove-disk flag.

Non-dry-run cleanup:

1. Resolve paths and storage backend.
2. If the backend uses a mount, run `mountpoint -q <mountPoint>`.
3. If mounted, unmount the mount point.
4. If remove-disk is true, remove `jobRoot` and `mountPoint`.
5. Also remove those paths through Node filesystem calls with `force: true`.

Dry-run cleanup prints the storage backend cleanup plan instead of executing it.

## One-Shot Job Run

`job run` must:

1. Prepare the job.
2. Build the agent backend Docker command.
3. Execute the command through host `timeout`.
4. Always call cleanup in a `finally` block.
5. Preserve job data only when `--keep-disk` is true.
6. Exit with the agent command exit code when prepare succeeds.

## Invariants

- Prepare must not reuse a live job ID.
- Dry-run prepare must not write metadata or create job files.
- Cleanup must be idempotent enough to remove partially prepared jobs.
- Job runtime timeout is enforced outside the agent container.
- Resource limits apply to the outer agent container.

## Failure Behavior

- Unknown resource profile fails before host mutation.
- Any failed planned command fails the operation unless that command is marked `allowFailure`.
- Cleanup is attempted after one-shot execution even when agent execution fails.

## Verification

Required verification:

- Unit tests for job ID validation.
- Unit tests for loopback prepare command planning.
- Unit tests for directory backend prepare command planning.
- Unit tests for duplicate job refusal.
- Unit tests for reuse after cleanup.
- Unit tests that dry-run prepare does not write metadata.
- Integration job run checks for at least one backend available on the host.

# Storage Backends

## Scope

Storage backends define how job workspace and nested runtime data directories are prepared and cleaned up.

Storage backends must not change runtime backend command generation or managed Git behavior.

## Common Contract

Every storage backend provides:

- `kind`
- Whether it produces a mounted filesystem.
- Prepare command plan.
- Cleanup command plan.

The job lifecycle executes these plans or prints them in dry-run mode.

## `loopback`

Purpose:

- Production default for aggregate disk quota enforcement.

Prepare plan:

1. `truncate -s <diskBytes> <diskImage>`
2. `mkfs.ext4 -F -q <diskImage>`
3. `sudo mount -o loop <diskImage> <mountPoint>`
4. `sudo install -d -m 0755 <workspace> <runtimeData>`
5. `sudo chown -R <currentUid>:<currentGid> <mountPoint>`

Cleanup plan:

1. `sudo umount <mountPoint>`
2. If remove-disk is true, `sudo rm -rf <jobRoot> <mountPoint>`.

Runtime behavior:

- `mounted` metadata is true after non-dry-run prepare.
- `diskBytes` is enforced by the disk image size.
- Workspace and nested runtime data share the same quota boundary.

Requirements:

- Loop device setup must be allowed.
- `mkfs.ext4`, `mount`, `umount`, `truncate`, `install`, and `chown` must be available.
- Sudo must be available for mount and ownership operations.

## `directory`

Purpose:

- Compatibility fallback for nested environments that cannot create loop devices.

Prepare plan:

1. `sudo install -d -m 0755 <workspace> <runtimeData>`
2. `sudo chown -R <currentUid>:<currentGid> <mountPoint>`

Cleanup plan:

1. If remove-disk is true, `sudo rm -rf <jobRoot> <mountPoint>`.

Runtime behavior:

- `mounted` metadata is false.
- `diskBytes` is not enforced.
- Any disk enforcement must come from an external layer.

## Invariants

- Both backends must use the same job path contract.
- Both backends must create workspace and runtime data directories.
- `directory` must be documented as not enforcing disk quota.
- `loopback` must keep workspace and nested runtime data inside the same filesystem.

## Verification

Required verification:

- Unit tests for loopback command planning.
- Unit tests for directory command planning.
- Doctor loop setup check for `loopback`.
- Doctor informational success for `directory`.

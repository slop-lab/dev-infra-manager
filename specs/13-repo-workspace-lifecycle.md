# Repository and Workspace Lifecycle

## Scope

This specification defines the local Gitea service, role-neutral repository
registration, persistent workspace containers, Git environment injection,
journaling, reconciliation, and cleanup.

## State and Docker resources

Metadata must be stored below `DIM_STATE_ROOT`, defaulting to
`~/.local/state/dim`.

Repository records:

```text
<stateRoot>/repos/<name>.json
```

Service, workspace records, and locks:

```text
<stateRoot>/services/gitea.json
<stateRoot>/workspaces/<name>.json
<stateRoot>/locks/workspace-<name>.lock
```

Host metadata must not contain Gitea passwords or workspace writer
credentials.

Managed Docker resources must:

- Use a `dim-` name prefix.
- Carry `dim.managed=true`.
- Carry a `dim.resource` label.
- Carry workspace and repository labels when scoped to a workspace.

## Gitea service

The initial provider is a shared local Gitea service with:

- Container `dim-gitea`.
- Network `dim-control`.
- Docker-managed volume `dim-gitea-data`.
- Loopback-only HTTP publication.
- No host Git repository bind mount.

The service must create separate admin and shared workspace-writer users.
Credentials must be generated or accepted from process environment and stored
only inside the Gitea data volume. Workspace code must not receive admin
credentials.

All registered repositories may be publicly readable. The shared writer may
push unprotected branches. Protected branch patterns must reject direct
workspace pushes, and merge authority must remain with the human/admin path.

## Repository registration

Usage:

```bash
dim repo register --name NAME [--protect PATTERN,...] /path/to/bare.git
```

Registration must:

1. Validate the logical name.
2. Resolve the source to a canonical path.
3. Verify it is a bare Git repository.
4. Atomically claim an `importing` repository journal record.
5. Reconcile the Gitea service.
6. Create an empty Gitea repository.
7. Import branches and tags without retaining the source path as a runtime
   dependency.
8. Grant the shared writer write access.
9. Install protected branch patterns.
10. Mark the record `ready`.

Failed imports must record `error`. Repeating registration with the same name
and canonical source may resume the import. A ready registration or a
different source must be rejected.

Repository metadata must not assign product, control, or secret-handling
roles.

## Project workspace creation

Usage:

```bash
dim workspace create PROJECT WORKSPACE [--profile PROFILE ...]
```

A workspace consists of:

- One top-level persistent workspace container.
- One named Docker volume for its inner Docker store.
- Membership in the shared Gitea network.
- Optional routes, initially an empty list.
- One host metadata record containing the project, selected Compose profiles,
  Compose project name, and last setup result.

The top-level container must not mount a host checkout, host worktree, host
Git directory, host Docker socket, or host workspace data directory.

The project repository must be cloned inside the container at:

```text
/workspace/project
```

Creation must claim metadata before Docker mutations, reconcile named and
labeled resources, wait for inner Docker readiness, clone the project, and
invoke the `.dim` setup contract.

The project contract consists only of optional `.dim/setup.sh`,
`.dim/entrypoint.sh`, `.dim/teardown.sh`, and `.dim/docker-compose.yml`.
`dim` must not discover a root Compose file. A setup hook overrides the
default Compose setup. With no setup hook or DIM Compose file, setup is a
successful no-op.

`workspace run WORKSPACE TASK` must not run setup. It dispatches the task
through `.dim/entrypoint.sh` when present. `workspace exec WORKSPACE --
COMMAND` always executes the raw command from the project root.

`workspace update` must require a clean checkout and use fast-forward-only Git
update before setup. `workspace start` must reconcile and run setup without
updating Git.

## Git environment

The workspace container must receive:

- `DIM_GIT_USERNAME`
- `DIM_GIT_TOKEN`
- `DIM_GIT_USER_NAME`
- `DIM_GIT_USER_EMAIL`
- `DIM_GIT_BASE_URL`
- `GIT_ASKPASS`
- Non-interactive Git configuration for `user.name` and `user.email`

Credentials must not be embedded in the remote URL or host metadata. Nested
containers receive Git values only through explicit environment forwarding.

## Stop and discard

`workspace stop` must preserve the project checkout and named inner-Docker
volume.

`workspace discard --yes` must attempt `.dim/teardown.sh` or default Compose
down, then remove:

- The top-level container.
- Its named inner-Docker volume.
- Its workspace metadata.

It must not delete the registered Gitea repository. The command must require
explicit acknowledgement because unpushed changes are lost.

Entrypoints must remove stale inner-dockerd pid and socket files before
restart.

## Reconciliation

Reconciliation must be serialized per workspace. Lock files must be created
atomically, released after reconciliation rather than after the user command,
and recoverable after process failure.

The lifecycle must:

- Adopt matching labeled resources.
- Recreate missing recorded resources.
- Reject unmanaged or mismatched name collisions.
- Record errors for retry on the next invocation.
- Avoid anonymous Docker volumes.

## Verification

Required verification:

- Unit tests for name validation, atomic claims, locks, role-neutral records,
  and Docker command boundaries.
- An runc development smoke test for Gitea import, internal clone, Git
  identity, writer push, protected branch rejection, nested Docker,
  stop/start persistence, and discard cleanup.
- A four-repository project smoke test for `.dim` setup and entrypoint,
  capability profiles, nested service-owned Git clones, nested writer push,
  profile replacement, setup retry, and cleanup.
- A production smoke test on a host with `sysbox-runc`.

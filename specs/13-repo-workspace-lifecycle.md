# Project, Repository, and Workspace Lifecycle

## State and identities

DIM stores schema-versioned Project and workspace records below
`DIM_STATE_ROOT`, defaulting to `~/.local/state/dim`.

```text
<stateRoot>/projects/<project>.json
<stateRoot>/workspaces/<workspace>.json
<stateRoot>/services/gitea.json
<stateRoot>/locks/project-<project>.lock
<stateRoot>/locks/workspace-<workspace>.lock
```

Project and workspace records use stable IDs distinct from display names.
Schema 2 is the first Project-aware schema. Schema 1/0.1 state is rejected
without mutation.

## Project namespace

The built-in managed Git service is one DIM-owned Gitea instance. Each Project
owns the reserved organization `dim-<project>` and repository aliases are
scoped below it:

```text
dim-acme/root
dim-acme/product
dim-acme/environment
```

Project metadata contains its name/ID, namespace, repository catalog, and
exactly one root repository/ref when runnable. Infrastructure implementation
belongs to the root repository, not the Project state.

Claims precede Gitea mutations. Project and repository reconciliation is
serialized, records errors for diagnosis, and rejects unmanaged identity
collisions.

## Repository creation and import

Empty repository creation is the primary operation. It returns separate host
and workspace endpoints without credentials. Users may populate it with any
standard Git commands.

Protection is pending until the initial push, then applied explicitly or when
the root is first used to create a workspace. Import performs the initial
mirror push before applying protection.

External sources are accessed only through the local Git CLI and its existing
credential configuration. DIM 0.2 does not provision external Git providers or
proxy Git traffic.

## Root workspace contract

A workspace binds permanently to a Project ID and directly clones only the
configured root repository/ref at:

```text
/workspace/project
```

The root repository owns the optional:

```text
.dim/setup.sh
.dim/entrypoint.sh
.dim/teardown.sh
.dim/docker-compose.yml
```

It also owns checkout and reconciliation of any additional Project
repositories. DIM supplies a read-only runtime manifest and environment to
`.dim/setup.sh`, `.dim/entrypoint.sh`, `.dim/teardown.sh`, and `exec`:

```text
DIM_PROJECT_ID
DIM_PROJECT_NAME
DIM_PROJECT_ROOT
DIM_PROJECT_MANIFEST
DIM_WORKSPACE_NAME
DIM_WORKSPACE_BACKEND
DIM_NESTED_ENGINE
COMPOSE_PROJECT_NAME
COMPOSE_PROFILES
DIM_GIT_BASE_URL
```

The workspace container additionally carries Git integration variables for
its whole lifetime (not only during setup/entrypoint/exec dispatch):

```text
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_GIT_USER_NAME
DIM_GIT_USER_EMAIL
GIT_ASKPASS
GIT_TERMINAL_PROMPT
```

`DIM_GIT_BASE_URL` is Project-specific. Project lifecycle code appends its
own stable managed repository names and owns all checkout paths and
repository-to-service mappings. DIM does not export per-repository
variables. `COMPOSE_PROJECT_NAME`, `containerName`, and `dockerVolumeName`
are the only stable identifiers for Docker resources DIM creates for a
workspace; callers must read them from `dim show WORKSPACE --json` rather
than reconstructing a naming scheme, which is not part of this contract and
may change.

## Applying changes

DIM never applies Project or root remote changes to a running workspace
automatically.

- `start` starts a stopped runtime, fetches the configured root ref,
  fast-forward merges it, and runs setup.
- `restart` stops a running runtime and performs the same start/apply/setup
  sequence.
- `update` performs the fast-forward and setup without a stop and may also
  replace Compose profiles.
- `setup` retries setup without fetching.

Dirty roots and non-fast-forward updates fail without modifying user work.
Stop/start and restart preserve the checkout and named inner-engine volume.

## Cleanup

`discard --yes` attempts root teardown and removes only the workspace
container, named inner-engine volume, and workspace record. It does not delete
Project metadata or managed Git repositories.

`project remove` refuses while referenced and otherwise removes metadata only;
the reserved Gitea organization remains. `project purge --yes` refuses while
referenced and otherwise deletes the DIM-managed organization and Project
metadata.

## Verification

Required tests cover:

- atomic Project/repository/workspace claims and schema rejection;
- two Projects using the same repository alias without collision;
- empty creation, standard initial push, delayed protection, and import;
- host/workspace URL separation and credential-free output;
- root clone/ref validation and runtime manifest injection;
- no live update of a running workspace;
- start/restart fast-forward and dirty-root rejection;
- task/raw command dispatch, stop persistence, and discard cleanup;
- packed CLI help, JSON output, URL stdout, and Git credential wrapper.

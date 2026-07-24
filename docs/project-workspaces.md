# Project Workspaces

Before adopting this workflow, follow the mandatory [DIM adoption and trust
requirements](adoption.md). In particular, a human must review the complete DIM
and project repositories and all secret-bearing environment code at the pinned
revisions.

This document defines the project-facing workspace workflow. Repository
registration and managed Gitea details are documented in
[Repository-backed Workspaces](repo-workspaces.md).

## Concepts

A **repository** is a Git repository registered with the managed Git service.
Repository registration is role-neutral.

A **project** is a repository used as the root of a workspace. Its optional
`.dim` directory defines how that project prepares its environment and
dispatches project tasks.

A **workspace** is a named, persistent, isolated environment bound to one
project. It owns its top-level runtime, inner-Docker state, selected profiles,
and lifecycle journal.

A workspace **profile** is a Docker Compose capability profile: for example
`development`, `secrets`, `browser`, or `gpu-tools`. It selects optional
project services and is unrelated to the CPU/memory/disk resource profiles
used for CPU, memory, and PID limits on the top-level workspace.

A **service** is a container managed by the project, normally through
`.dim/docker-compose.yml`. Services may clone additional registered
repositories directly from the managed Git service into their own named
volumes. `dim` does not require every repository to be cloned into the
top-level workspace.

## Project contract

Only files below `.dim` have special meaning:

```text
project/
├── .dim/
│   ├── setup.sh             optional
│   ├── entrypoint.sh        optional
│   ├── teardown.sh          optional
│   └── docker-compose.yml   optional
└── ...                      all other layout is project-defined
```

`dim` does not discover or run a `compose.yaml` from the repository root.
Projects remain free to use a root Compose file for their own non-`dim`
workflow.

### `.dim/setup.sh`

When present, this script completely owns environment reconciliation. It may
clone or update additional repositories, build images, and start project
services. It runs from the project root with:

```text
DIM_PROJECT_ROOT
DIM_WORKSPACE_NAME
COMPOSE_PROJECT_NAME
COMPOSE_PROFILES
DIM_GIT_BASE_URL
DIM_GIT_USERNAME
DIM_GIT_TOKEN
```

Selected profiles are passed as repeated arguments:

```bash
.dim/setup.sh --profile development --profile secrets
```

The script must be safe to retry after partial failure. It is invoked by
`workspace create`, `workspace start`, `workspace setup`, and after a
successful `workspace update`. It is not invoked by `workspace run` or
`workspace exec`.

### `.dim/docker-compose.yml`

When `.dim/setup.sh` is absent and this file exists, `dim` performs the default
setup:

```bash
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --file .dim/docker-compose.yml \
  [--profile PROFILE ...] \
  up --detach --build
```

Compose runs against the workspace's inner Docker daemon. Relative build
contexts and bind sources are resolved inside the workspace, never against a
host checkout. The fixed Compose project name lets reconciliation and cleanup
distinguish resources belonging to different workspaces.

When neither setup mechanism exists, setup is a successful no-op. The
workspace remains useful for direct commands and projects that manage their
environment through another tool.

### `.dim/entrypoint.sh`

When present, `workspace run` passes the task name and arguments to this
script:

```bash
exec sh .dim/entrypoint.sh TASK [ARGS...]
```

For example:

```sh
#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  codex)
    exec codex "$@"
    ;;
  test)
    exec docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --file .dim/docker-compose.yml \
      --profile development \
      run --rm test "$@"
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
```

When the entrypoint is absent, `workspace run` executes the supplied task and
arguments directly from the project root. `workspace exec` always bypasses
the entrypoint.

### `.dim/teardown.sh`

When present, this script receives the same environment and repeated profile
arguments as setup and runs before workspace discard. When it is absent and
`.dim/docker-compose.yml` exists, `dim` performs:

```bash
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --file .dim/docker-compose.yml \
  down --remove-orphans
```

Teardown does not include `--volumes` by default. The final removal of the
workspace's inner-Docker store still guarantees cleanup of non-external
Compose resources. An external volume remains outside this ownership boundary
and is the project's responsibility.

## End-to-end workflow

Register a bare project repository:

```bash
dim repo register --name example /path/to/example.git
```

Create a workspace and persist its desired Compose profiles:

```bash
dim workspace create example example-dev \
  --backend sysbox \
  --profile development \
  --profile secrets
```

Creation:

1. Claims the workspace journal before creating non-trivial resources.
2. Reconciles the managed Git service and workspace runtime.
3. Clones the project repository inside the workspace.
4. Stores the selected runtime backend and profiles in workspace metadata.
5. Runs `.dim/setup.sh`, or the default `.dim/docker-compose.yml` setup.
6. Leaves failed setup resources and diagnostics available for retry.

Run project-defined tasks without repeating setup:

```bash
dim workspace run example-dev codex
dim workspace run example-dev test -- --filter unit
```

Run a raw command in the top-level workspace:

```bash
dim workspace exec example-dev -- bash
dim workspace exec example-dev -- docker compose \
  --file .dim/docker-compose.yml ps
```

There is no separate `workspace shell` command; `workspace exec NAME -- bash`
is the explicit equivalent.

Update the project and reconcile its environment:

```bash
dim workspace update example-dev
dim workspace update example-dev \
  --profile development \
  --profile production
```

`update` performs a fast-forward-only update of the project repository before
selecting the new setup script. An update that would overwrite local work or
requires a merge stops with an error. If one or more `--profile` flags are
provided, they replace the stored profile set; otherwise the existing set is
retained. Additional repository update policy belongs to `.dim/setup.sh` or
the services that own those repositories.

Stop and resume the environment:

```bash
dim workspace stop example-dev
dim workspace start example-dev
```

`stop` preserves the project checkout and inner-Docker state. `start`
reconciles the runtime and invokes setup so detached project services return
to their desired state. It does not pull the project repository; use
`workspace update` when new Git content should be incorporated.

Retry setup explicitly:

```bash
dim workspace setup example-dev
```

Inspect or discard:

```bash
dim workspace show example-dev
dim workspace discard example-dev --yes
```

Discard stops project services when possible, then removes the top-level
runtime, inner-Docker store, project checkout, and workspace journal. It does
not remove repositories from the managed Git service.

## Lifecycle behavior

| Command | Project Git update | Setup | Project entrypoint |
|---|---:|---:|---:|
| `workspace create` | initial clone | yes | no |
| `workspace start` | no | yes | no |
| `workspace setup` | no | yes | no |
| `workspace update` | fast-forward only | yes | no |
| `workspace run` | no | no | when present |
| `workspace exec` | no | no | never |
| `workspace stop` | no | no | no |
| `workspace discard` | no | teardown only | no |

Setup is serialized per workspace. Ordinary tasks may run concurrently.
Setup failure is recorded separately from runtime reconciliation failure and
does not destroy the checkout or inner-Docker cache. Task failure is returned
to the caller but does not mark the workspace itself unhealthy.

## Project scaffold

The scaffold command is:

```bash
dim project init
```

By default it creates only `.dim/docker-compose.yml`, leaving the optional
hooks absent. The initial Compose file assumes a root `Dockerfile` and
provides one long-running development service:

```yaml
services:
  dev:
    build:
      context: ..
    command: sleep infinity
    working_dir: /workspace
    volumes:
      - ..:/workspace
```

The command must refuse to overwrite existing files unless `--force` is
explicitly supplied. A project that needs custom repository checkout,
non-Compose orchestration, or task aliases can add `.dim/setup.sh` and
`.dim/entrypoint.sh` manually.

The generated files are ordinary project files. Developers may run the
Compose definition directly without `dim`:

```bash
docker compose --file .dim/docker-compose.yml up --detach --build
```

When invoking hooks directly, callers can supply the same standard Compose
environment used by `dim`:

```bash
COMPOSE_PROJECT_NAME=example-dev \
COMPOSE_PROFILES=development,secrets \
sh .dim/setup.sh --profile development --profile secrets
```

## Multiple repositories

The project repository is the only checkout required in the top-level
workspace. Other repositories need not be bind-mounted from it.

Services can reach the managed Git service and may clone into service-specific
named volumes. `DIM_GIT_BASE_URL` is a routable HTTP endpoint for nested
services; projects explicitly pass `DIM_GIT_USERNAME`, `DIM_GIT_TOKEN`, and an
askpass helper when a service also needs to push. Repositories used only as
image build inputs may use a Git build context. Projects that require
centralized checkout behavior can implement it in `.dim/setup.sh`; this is a
project choice rather than a `dim` requirement.

The multi-repository container smoke covers:

- A project repository containing `.dim/docker-compose.yml`.
- Separate secret-handling and multiple product repositories.
- Direct managed-Git access from nested services.
- Service-owned persistent checkout volumes.
- Compose profile selection stored by `workspace create`.
- Project task dispatch through `.dim/entrypoint.sh`.
- Stop/start persistence, update/setup retry, and complete discard cleanup.

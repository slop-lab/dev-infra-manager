# Repository-backed Workspaces

The repository and workspace lifecycle keeps host checkouts out of the runtime
boundary. Gitea owns Git data in a Docker-managed volume, while each workspace
keeps its checkout inside its top-level container.

## Local installation

Build and link `dim` for use from other local projects:

```bash
just build-codex-workspace
just install-dim-local
```

The link is installed under `~/.local/bin`. Add that directory to `PATH` when
the host shell does not already include it.

The default production runtime is `sysbox-runc`. A nested development
container without Sysbox can explicitly opt into the privileged runc smoke
path:

```bash
export DIM_WORKSPACE_RUNTIME=runc
export DIM_WORKSPACE_PRIVILEGED=yes
```

This opt-in is for compatibility testing and is not the production isolation
boundary.

## Register a repository

Register an existing bare repository:

```bash
dim repo register --name project /path/to/project.git
```

The source path is canonicalized and verified as a bare repository. `dim`
starts the managed local Gitea service, creates an empty public repository,
imports branches and tags, grants the shared workspace writer account write
access, and protects `main`.

More than one protected branch pattern may be supplied as a comma-separated
list:

```bash
dim repo register \
  --name project \
  --protect 'main,release/*' \
  /path/to/project.git
```

The source path is used only during import. It is not mounted into Gitea or a
workspace and is not a runtime dependency after registration.

Inspect the role-neutral registry:

```bash
dim repo list
dim repo show project
```

Repository records do not classify repositories as product, control, or
secret-handling repositories. Those are contextual roles for a future
container-group definition.

## Run a workspace

Run a command in a named persistent workspace:

```bash
dim workspace run project work-1 bash
dim workspace run project work-1 -- git status --short
```

Use `--` before commands that have their own flags.

The first invocation:

1. Writes a `creating` journal record before Docker mutations.
2. Reconciles the shared Gitea network and service.
3. Creates a labeled workspace inner-Docker volume.
4. Creates the labeled top-level workspace container.
5. Waits for its inner Docker daemon.
6. Clones the registered repository into
   `/workspace/repos/<repo>` inside the container.
7. Marks the journal record `ready`.

Later invocations reuse the same container, clone, and inner-Docker store.
The workspace container has no host checkout bind mount and no host Docker
socket mount.

Git identity can be supplied through flags or environment variables:

```bash
export DIM_GIT_USER_NAME='Agent Name'
export DIM_GIT_USER_EMAIL='agent@example.invalid'
dim workspace run project work-1 bash
```

The shared Gitea writer username and password are injected as
`DIM_GIT_USERNAME` and `DIM_GIT_TOKEN`. `GIT_ASKPASS` reads them without
embedding credentials in the remote URL. Nested containers receive these
values only when their creator explicitly forwards the environment.

Protected branch patterns reject direct workspace pushes. Unprotected
branches are freely writable. Review and merge use a human Gitea login.

## Lifecycle and recovery

Inspect, stop, restart, or discard a workspace:

```bash
dim workspace show work-1
dim workspace stop work-1
dim workspace run project work-1 bash
dim workspace discard work-1 --yes
```

`stop` preserves the container writable layer and the named inner-Docker
volume. `discard` deletes both, so unpushed changes are lost. Registered Gitea
repositories are not deleted.

Workspace reconciliation is serialized by a crash-recoverable lock. Resource
names use the `dim-` prefix and resources carry `dim.managed`,
`dim.workspace`, `dim.repo`, and `dim.resource` labels. A later invocation
adopts matching partial resources, recreates missing resources, and rejects
unmanaged name collisions. Journal errors remain visible and are retried by
the next `workspace run`.

Routes are optional. The initial lifecycle records an empty route list and
does not create externally reachable routes.

## Gitea operation

The default service uses:

```text
container: dim-gitea
network:   dim-control
volume:    dim-gitea-data
HTTP:      127.0.0.1:3300
image:     gitea/gitea:1.27.0
```

Its desired state is journaled at
`~/.local/state/dim/services/gitea.json` before Docker resources are created.

Ensure it is running:

```bash
dim gitea ensure
```

Initial admin and shared-writer passwords are generated and stored with mode
`0600` inside the Gitea data volume. Operators can explicitly retrieve them:

```bash
dim gitea credentials --show-secrets
```

The following environment variables override defaults:

```text
DIM_STATE_ROOT
DIM_GITEA_IMAGE
DIM_GITEA_PORT
DIM_GITEA_ADMIN_USERNAME
DIM_GITEA_ADMIN_PASSWORD
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_GIT_USER_NAME
DIM_GIT_USER_EMAIL
DIM_WORKSPACE_IMAGE
DIM_WORKSPACE_RUNTIME
DIM_WORKSPACE_PRIVILEGED
DIM_WORKSPACE_CPUS
DIM_WORKSPACE_MEMORY
DIM_WORKSPACE_PIDS
```

## Container verification

The full nested-container verification available in a development container
is:

```bash
just container-runtime-verify
```

It includes a disposable Gitea repository and workspace lifecycle test:
import, clone, Git identity, free branch push, protected branch rejection,
nested container networking, stop/start persistence, and cleanup.

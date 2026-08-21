# Configuration

DIM stores installation-wide user settings in
`~/.config/dim/config.json` (or `DIM_CONFIG_PATH`) and schema-versioned
runtime state under `DIM_STATE_ROOT`. The host backend installer writes the
required `workspaceBackend` setting. If the CLI was installed separately, run
`dim doctor configure-backend`. It verifies locally usable backends before
recording one; when several are available, an interactive terminal prompts for
the choice.

The default paths use DIM's own namespace: configuration is under
`~/.config/dim`, persistent application state under `~/.local/state/dim`,
and installed data under `~/.local/share/dim`. DIM does not create files in
the organization-wide `slop-lab` directory.

The default managed-controller sockets are
`${XDG_RUNTIME_DIR:-/tmp/dim-UID}/dim/controller.sock` and `admin.sock`.
Only a non-default `DIM_STATE_ROOT` adds a stable state-root hash directory so
multiple controller instances cannot collide.

Common settings:

```text
DIM_STATE_ROOT
DIM_GITEA_IMAGE
DIM_GITEA_HOST
DIM_GITEA_PORT
DIM_GITEA_ADMIN_USERNAME
DIM_GITEA_ADMIN_PASSWORD
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_WORKSPACE_IMAGE
DIM_WORKSPACE_RUNTIME
DIM_WORKSPACE_PRIVILEGED
DIM_WORKSPACE_CPUS
DIM_WORKSPACE_MEMORY
DIM_WORKSPACE_PIDS
DIM_CI_RUNNER_IMAGE
DIM_CI_RUNNER_RUNTIME
DIM_CI_RUNNER_CPUS
DIM_CI_RUNNER_MEMORY
DIM_CI_RUNNER_PIDS
```

`DIM_GITEA_HOST` defaults to the hostname in a TCP `DOCKER_HOST`, or to
`127.0.0.1` for a local Docker daemon. Override it when the Docker daemon's
published ports are reachable through a different hostname or address.

Runtime backend selection is documented in
[Runtime Backends](runtime-backends.md). Project and workspace settings are
persisted by their lifecycle commands rather than copied into user config.
The CPU, memory, and PID settings are defaults for new workspace records.
`dim workspace create --cpus`, `--memory`, and `--pids-limit` persist per-workspace
overrides. Change one or more limits on an existing workspace without
recreating it:

```bash
dim workspace resources WORKSPACE --cpus 4 --memory 8g --pids-limit 2048
```

Omitted flags keep their recorded values. DIM updates the live or stopped
container first and persists the new effective limits only after Docker
accepts them.

CI runner resource defaults use the built-in `4 CPU`, `8g` memory, and `2048`
PID fallback unless changed in user configuration:

```bash
dim ci runner defaults set --cpus 6 --memory 12GiB --pids-limit 4096
dim ci runner defaults show
dim ci runner defaults reset
```

Runner-specific flags on `dim ci runner enable PROJECT RUNNER sysbox` override these defaults.

DIM is pre-stable. Incompatible configuration and state are rejected rather
than migrated implicitly; compatibility behavior is added only when a release
explicitly defines it.

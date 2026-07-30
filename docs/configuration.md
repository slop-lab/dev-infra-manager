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
```

Runtime backend selection is documented in
[Runtime Backends](runtime-backends.md). Project and workspace settings are
persisted by their lifecycle commands rather than copied into user config.
The CPU, memory, and PID settings are defaults for new workspace records.
`dim create --cpus`, `--memory`, and `--pids-limit` persist per-workspace
overrides.

DIM 0.2 rejects 0.1 state and does not perform an automatic migration.

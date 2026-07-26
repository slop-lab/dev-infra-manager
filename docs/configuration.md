# Configuration

DIM stores installation-wide user settings in
`~/.config/slop-lab/dim.json` (or `DIM_CONFIG_PATH`) and schema-versioned
runtime state under `DIM_STATE_ROOT`. The host backend installer writes the
required `workspaceBackend` setting.

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

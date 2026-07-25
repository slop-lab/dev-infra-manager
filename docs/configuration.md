# Configuration

DIM 0.2 uses `DIM_*` environment variables and schema-versioned state under
`DIM_STATE_ROOT`. There is no generated JSON configuration file.

Common settings:

```text
DIM_STATE_ROOT
DIM_GITEA_IMAGE
DIM_GITEA_PORT
DIM_GITEA_ADMIN_USERNAME
DIM_GITEA_ADMIN_PASSWORD
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_WORKSPACE_BACKEND
DIM_WORKSPACE_IMAGE
DIM_WORKSPACE_RUNTIME
DIM_WORKSPACE_PRIVILEGED
DIM_WORKSPACE_CPUS
DIM_WORKSPACE_MEMORY
DIM_WORKSPACE_PIDS
```

Runtime backend selection is documented in
[Runtime Backends](runtime-backends.md). Project and workspace settings are
persisted by their lifecycle commands rather than copied into a global config.

DIM 0.2 rejects 0.1 state and does not perform an automatic migration.

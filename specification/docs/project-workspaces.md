> Scope: optional managed Git integration. Ordinary development uses the
> [base workspace flow](usage.md) and requires no Project registration.

# Native Projects and workspaces

```bash
dim project bootstrap-native-root PROJECT \
  --project-id PROJECT_ID \
  --source-repository /absolute/reviewed/root \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/registrar.json \
  --importer-connection /absolute/operator/importer.json --json

export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/importer.json
dim project create PROJECT --json
dim project list --json
dim project show PROJECT --json
dim managed create PROJECT WORKSPACE
dim managed show WORKSPACE --json
```

Bootstrap stages immutable reviewed root bytes and creates no runnable state.
Create performs fresh native proof and atomically publishes ready state.
Workspace creation uses that snapshot and proposal-only Git authority. It does
not wait for ordinary or QEMU CI.

Workspace run, exec, setup, start, stop, restart, update, and discard operate on
that native record. DIM has no public repository CRUD or Project removal/purge
surface. Export predecessor data with the pinned prior release; do not edit or
adopt old records.

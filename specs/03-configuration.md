# Configuration

DIM configuration is environment-based. `DIM_STATE_ROOT` selects the
schema-versioned state root; managed Gitea, workspace backend, image and
resource options use the `DIM_GITEA_*`, `DIM_GIT_*`, and `DIM_WORKSPACE_*`
variables documented in `docs/configuration.md`.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles and backend choices belong to Project/workspace records. Raw
credentials must not be written to those records.

There is no legacy JSON config, bare-Git PR store, controller config, job
storage, or automatic 0.1 state migration.

# Configuration

DIM configuration is environment-based. `DIM_STATE_ROOT` selects the
schema-versioned state root; managed Gitea, workspace backend, image and
resource options use the `DIM_GITEA_*`, `DIM_GIT_*`, and `DIM_WORKSPACE_*`
variables documented in `docs/configuration.md`.

The configured Gitea host and port form the host-facing repository and
management endpoint. `DIM_GITEA_HOST` overrides the host. Otherwise DIM uses
the host from a TCP `DOCKER_HOST`, or `127.0.0.1` for a local Docker daemon.
The Gitea port binding, readiness checks, management API requests, and host
clone URLs must all use that endpoint; Docker-network clone URLs remain on
the isolated `dim-control` network.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles and backend choices belong to Project/workspace records. Raw
credentials must not be written to those records.

There is no legacy bare-Git PR store, separate controller config, or job
storage. DIM is pre-stable and rejects incompatible configuration or state
unless an explicit migration is part of the current contract.

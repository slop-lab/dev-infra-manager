# Configuration

DIM configuration is environment-based. `DIM_STATE_ROOT` selects the
schema-versioned state root; Gitea, workspace backend, image and resource
options use the `DIM_GITEA_*`, `DIM_GIT_*`, and `DIM_WORKSPACE_*` variables
documented in `docs/configuration.md`.

The configured Gitea host and port form the host-facing repository and
management endpoint. `DIM_GITEA_HOST` overrides the host. Otherwise DIM uses
the host from a TCP `DOCKER_HOST`, or `127.0.0.1` for a local Docker daemon.
The Gitea port binding, readiness checks, management API requests, and host
clone URLs must all use that endpoint; Docker-network clone URLs remain on
the isolated `dim-control` network.

**CONFIG-GIT-001:** With no external connection configured, DIM MUST retain
the host-local managed Gitea lifecycle above. `DIM_GITEA_CONNECTION_FILE`
instead selects one operator-managed external Gitea service. The file MUST be
a regular, DIM-user-owned mode-`0600` JSON file with an exact supported schema.
It MUST provide distinct management API, host clone, workspace clone, and CI
runner base URLs; administrator, constrained workspace-writer, and host
maintainer credentials; a stable host ID; an explicit transport policy; and
explicit Project identity bindings. HTTPS is the normal transport. Plain HTTP
MUST be limited to loopback or an explicitly isolated network.

**CONFIG-GIT-002:** DIM MUST validate every external URL and perform bounded
health and authenticated-identity checks before lifecycle mutation. It MUST
NOT create, start, stop, or configure the external service; create or persist
its credentials; acquire the managed-service lock; enforce the local
organization-creation policy; inject the local `dim-gitea` alias; or rewrite
the external webhook allowlist. Errors and logs MUST NOT disclose credentials.

**CONFIG-GIT-003:** Each Project used with external Gitea MUST bind its DIM
Project ID, `dim-<project>` namespace, and positive Gitea organization ID
explicitly. Every host sharing that Project MUST use the same binding. DIM
MUST verify the existing organization by both ID and namespace and MUST reject
an absent, changed, or unrelated binding rather than adopting by name.

The administrator identity MUST report administrator status. Writer and
maintainer identities MUST be distinct from each other and the administrator,
authenticate as their configured login, and report non-administrator status.
Project names, IDs, namespaces, organization IDs, and host IDs MUST be safe and
unique within the connection file before they can select local state.

**CONFIG-QEMU-SCHEDULER-001:** `DIM_QEMU_SCHEDULER_CONNECTION_FILE` MAY select
an operator-managed shared QEMU demand scheduler. The file MUST be a regular,
DIM-user-owned mode-`0600` JSON file with exact schema version `1`, a stable
host ID, one explicit transport policy, and per-Project bindings. Each binding
MUST match the local immutable Project ID and provide distinct controller,
supervisor, and central webhook URLs plus host and webhook bearer tokens. URLs
MUST contain no credentials, query, or fragment. Plain HTTP is valid only for
loopback or an explicitly isolated transport. Shared scheduling MUST require
external Gitea and MUST reject mixed shared/local topology or changed
persisted identity. When the variable is absent, existing host-local
scheduling MUST remain unchanged.

The service-side Project binding MUST separately identify its webhook token,
per-host tokens, and non-empty allowed-label set. Its configured lease MUST be
at least 60 seconds. Host-authenticated requests MUST NOT introduce labels
outside that reviewed set.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles and backend choices belong to Project/workspace records. Raw
credentials must not be written to those records.

There is no legacy bare-Git PR store, separate controller config, or job
storage. DIM is pre-stable and rejects incompatible configuration or state
unless an explicit migration is part of the current contract.

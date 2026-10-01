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

The administrator identity MUST report administrator status. The writer MUST
use an identity distinct from both privileged host identities, authenticate as
its configured login, and report non-administrator status. The maintainer MAY
reuse the administrator credentials; when configured as a distinct identity,
it MUST authenticate as its configured login and report non-administrator
status. Project names, IDs, namespaces, organization IDs, and host IDs MUST be
safe and unique within the connection file before they can select local state.

**CONFIG-GIT-SYNC-001:** `DIM_GIT_SYNC_CONNECTION_FILE` MUST explicitly select
an operator-deployed repository synchronization service on the physical Git
host. The regular, DIM-user-owned, mode-`0600` exact-schema file MUST contain a
credential-free endpoint, bearer token, stable Git host ID, bounded timeout,
and HTTPS, loopback-HTTP, or isolated-HTTP transport policy. Its host ID MUST
equal the external Gitea host ID when external Gitea is configured. Without
this file, `repo fetch` and `repo publish` MUST fail closed and MUST NOT fall
back to temporary bare repositories or generic remote execution.

The service's separate private configuration MUST map every accepted Project
ID and repository alias to one relative bare-repository path below a fixed root
and one credential-free managed receive URL. It MUST explicitly allow upstream
HTTPS, HTTP, SSH, or local-path locations. Requests MUST NOT select managed
repository paths, managed URLs, Git options, commands, or arbitrary
environment. Local upstream paths are paths on the Git host and MUST remain
below configured roots. SSH authentication and host verification belong to the
service account. HTTP credentials MAY cross the authenticated request only for
that operation and MUST NOT enter URLs, logs, service configuration, or
persistent Git configuration.

**CONFIG-QEMU-SCHEDULER-001:** `DIM_QEMU_SCHEDULER_CONNECTION_FILE` MAY select
an operator-managed shared QEMU demand scheduler. The file MUST be a regular,
DIM-user-owned mode-`0600` JSON file with exact schema version `1`, a stable
host ID, one explicit transport policy, and per-Project bindings. Each binding
MUST match the local immutable Project ID and provide distinct controller,
supervisor, and central webhook URLs plus Project API and webhook bearer tokens. URLs
MUST contain no credentials, query, or fragment. Plain HTTP is valid only for
loopback or an explicitly isolated transport. Shared scheduling MUST require
external Gitea and MUST reject mixed shared/local topology or changed
persisted identity before runtime mutation. The scheduler host ID MUST equal
the external Gitea connection host ID. Every host attached to one Project MUST
use the same Project API token and a distinct stable host ID. When the variable
is absent, existing host-local scheduling MUST remain unchanged.

The service-side Project binding MUST separately identify its webhook token,
Project API token, and non-empty label set. The stable host ID is a
concurrency identity, not an authorization principal. Its configured lease MUST be
at least 60 seconds. API-authenticated queued events outside that Project label
set MUST be acknowledged without creating demand.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles and backend choices belong to Project/workspace records. Raw
credentials must not be written to those records.

There is no legacy bare-Git PR store, separate controller config, or job
storage. DIM is pre-stable and rejects incompatible configuration or state
unless an explicit migration is part of the current contract.

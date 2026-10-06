# Configuration

**Kind: Contract**

DIM configuration is environment-based. `DIM_STATE_ROOT` selects the
schema-versioned state root; Gitea, workspace backend, image and resource
options use the `DIM_GITEA_*`, `DIM_GIT_*`, and `DIM_WORKSPACE_*` variables
documented in `docs/configuration.md`.

## Workspace backend admission

**CONFIG-BACKEND-001:** Backend configuration is trusted host input, not a
Project extension point. The current release accepts exactly the scalar user
configuration `workspaceBackend: "sysbox"`, creates only workspace schema `8`
records whose `runtimeBackend` is `sysbox`, and MUST reject `container`, `vm`,
and every other value before plugin, hook, grant, state, or runtime mutation.
`DIM_WORKSPACE_RUNTIME`, `DIM_WORKSPACE_PRIVILEGED`, image overrides, Compose
configuration, and capability-provider output MUST NOT change that backend
identity or select a VM manager.

The target multi-backend contract reserves the scalar values `container` and
`vm`. They remain invalid in this release. A future release MAY accept one only
when its immutable release capability manifest names an implemented backend
profile and version, the profile's required live development gate has passed,
and local host preflight succeeds. An operator setting, environment variable,
Project file, plugin, guest response, or retained resource MUST NOT declare a
candidate profile supported or override the release-selected profile.

The initial target mappings are exact:

| Configured backend | Release-selected profile | Status in this release |
| --- | --- | --- |
| `sysbox` | historical schema-`8` profile | Supported and the only accepted value |
| `container` | `sysbox-container` version `1` | Reserved; rejected until implemented by a target release |
| `vm` | `incus-vm` version `1` | Evaluation candidate; rejected until the live KVM gate passes and a later release enables it |

The alternate `libvirt-vm` version `1` profile is not a configuration fallback.
It MAY replace the `vm` mapping only in an explicit later release after a
reproducible `incus-vm` gate failure and after passing the unchanged VM gate
itself. A runtime error MUST NOT switch an existing or newly requested
workspace between Incus and libvirt.

**CONFIG-BACKEND-002:** The release-selected profile is persisted in target
schema `9` workspace state as `runtimeBackendProfile`; it is not copied from
untrusted input. A new-workspace request MAY choose only a backend identity
enabled by the installed release and local host. Omission MAY use the trusted
host default. The selected backend, profile, and profile version become
immutable when the workspace record is created. Project configuration MAY
request backend-neutral capabilities, but MUST NOT provide provider sockets,
driver names, Incus projects or profiles, libvirt URIs or XML, QEMU arguments,
host paths, networks, storage pools, devices, cloud-init, or provider resource
names.

For `vm`, local preflight MUST verify KVM availability to the trusted host
service, the exact supported Incus/client compatibility, pinned guest image,
restricted Project policy including `restricted=true` and
`restricted.backups=allow`, allowed storage driver and pool, managed network
policy, deterministic provider-name cloud-init metadata with legacy `user.*`
cloud-init inputs absent and the controlled-first-boot validation barrier
available, resource support backed by a live-gate successful bounded memory
decrease, and the absence of conflicting owned or foreign resources. Missing
or indeterminate prerequisites are an admission failure. Preflight MUST NOT
install packages, change host policy, create Incus resources, or expose
`/dev/kvm`, backup authority, or a provider API to the guest. The complete
candidate profile and live gate are in
[Workspace Runtime Backend](05-runtime-backends.md#incus-vm-candidate-version-1).

Configuration and state admission MUST produce these results:

| Input | Result |
| --- | --- |
| Current release with `workspaceBackend: "sysbox"` and exact current state | Accept under the current Sysbox profile |
| Current release with `workspaceBackend: "container"` or `"vm"` | Reject as unsupported before mutation; do not claim a candidate gate passed |
| Target release with a newly selected enabled backend and exact release profile, plus successful local preflight | Permit creation of a fresh schema-`9` workspace record |
| Target release with `vm` while KVM, Incus, image, storage, network, successful memory decrease, provider-name cloud-init metadata, controlled-first-boot validation, host-only backup permission, restriction, or release-gate support is absent or indeterminate | Reject before provider or state mutation and report the failed prerequisite |
| Target release with `workspaceBackend: "sysbox"` or schema-`8` `runtimeBackend: "sysbox"` | Reject unchanged with prior-release export/discard/create/restore guidance; never alias to `container` |
| Existing `container` workspace requested as `vm`, or existing `vm` requested as `container` | Reject unchanged before contacting either provider |
| Unknown backend, profile, profile version, state schema, provider field, device, label, or mixed provider identity | Reject unchanged before plugin, hook, grant, network, storage, or runtime mutation |
| Guest, Project, plugin, or environment supplies low-level Incus/libvirt/QEMU/device/network/storage settings | Reject the settings; do not widen the release profile |
| Incus operation fails after admission | Preserve the `incus-vm` identity and follow its failure policy; never retry through libvirt or another profile |

**CONFIG-BACKEND-003:** Backend state transitions follow
`STATE-BACKEND-001`. No workspace config or state migration exists from
historical `sysbox` to `container` or `vm`, between `container` and `vm`, or
between VM profiles. A target release MUST leave the old configuration file,
workspace record, labels, and provider resources byte-for-byte unchanged when
rejecting them. It MUST direct the operator to keep the old exact release,
export declared Project/user data through a reviewed Project-owned task,
validate that backend-neutral archive outside DIM state, discard with the old
release, create a fresh workspace instance on the selected supported backend,
and explicitly restore the archive.

`discard --keep-volume`, raw provider volume transfer, engine-store copying,
record editing, relabeling, and same-name resource adoption are not transition
mechanisms. Exports MUST exclude DIM state, grants, sockets, credentials,
routes, approvals, device decisions, provider metadata, and runtime-manager
state. If the old pinned release cannot validate the old state or the export
fails, the transition stops without changing that state. The exact target
schema and rejection matrix are in
[Workspace Runtime Backend](05-runtime-backends.md#versioned-target-state-and-transition).

The configured Gitea host and port form the host-facing repository and
management endpoint. `DIM_GITEA_HOST` overrides the host. Otherwise DIM uses
the host from a TCP `DOCKER_HOST`, or `127.0.0.1` for a local Docker daemon.
The Gitea port binding, readiness checks, management API requests, and host
clone URLs must all use that endpoint; Docker-network clone URLs remain on
the isolated `dim-control` network.

**CONFIG-GIT-001:** This predecessor profile applies only when
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` is absent. With no predecessor
external connection configured, DIM MUST retain the host-local managed Gitea
lifecycle above. `DIM_GITEA_CONNECTION_FILE` instead selects one
operator-managed external Gitea service. The file MUST be
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

## Native control-plane host connection

**CONFIG-NATIVE-CONTROL-PLANE-001:** This is the unimplemented target host
connection shape for a future native Project/repository adapter. After that
adapter is separately specified, a participating host MUST set
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` to a regular,
non-symbolic-link, DIM-user-owned mode-`0600` JSON file with this exact schema:

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "nativeGit": {
    "transport": "https",
    "endpoint": "https://git-control.example",
    "serviceId": "native-main",
    "username": "host-a",
    "password": "replace-with-native-host-credential"
  },
  "ordinaryCi": {
    "transport": "https",
    "endpoint": "https://ci-control.example",
    "serviceId": "ordinary-main",
    "hostToken": "replace-with-host-token"
  },
  "capacities": {
    "primary": {
      "runnerBaseImage": "registry.example/dim/ordinary-runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "cpus": 4,
      "memoryBytes": 8589934592,
      "pids": 2048,
      "timeoutSeconds": 3600,
      "outputBytes": 16777216
    }
  }
}
```

The schema has no Project list or candidate job image. `hostId`, service
identities, and capacity names are safe non-empty identifiers. Each capacity's
runner base is an operator-selected registry reference pinned by one complete
lowercase `sha256` digest with no tag. Each resource, timeout, and output bound
is a positive integer. Candidate config and claims cannot widen them. URLs are
credential-free origins without path, query, or fragment. Each transport is exactly `https` or, only for a loopback HTTP
origin, `loopback-http`. Unknown keys, duplicate
capacity names after normalization, shared tokens, redirects, service-identity
mismatch, and mutable or unassigned endpoints fail before controller capacity
registration or runtime mutation.

The native Git credential is host-scoped read/attestation authority, not a
reviewer, promoter, or storage-administrator identity. Ordinary admission and
host authorities are distinct. `hostToken` may claim, renew, recover, and
submit a result only for this host's named capacities. The separate global
operator registrar credential may attest approved Project membership and
protected required-job policy, not review of candidate-selected job bytes, but
cannot claim or report. The
central service's separate native reporter credential, not a host credential,
submits accepted durable evidence to native Git. None may enter a workspace,
job, image, Compose bundle, log, or Project state. Controller startup validates both authenticated service
identities before advertising capacity. Failure closes ordinary admission and
claiming but does not fall back to a local or Project-scoped runner.

No current controller reads or consumes this target variable. Setting
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` in the shipped release is ignored:
it neither selects native lifecycle nor rejects otherwise valid predecessor
Gitea operations. That is an implementation absence, not target behavior. Once
target parsing exists, and until the adapter contract is also approved and
implemented, a requested native Project, repository, admission, or capacity
operation MUST reject before service-state or runtime mutation. The future
native connection and `DIM_GITEA_CONNECTION_FILE` are mutually exclusive for
one host. `DIM_ORDINARY_CI_POOL_CONNECTION_FILE` is obsolete in the target and
MUST be rejected, not ignored, when that target is implemented.

**CONFIG-QEMU-SCHEDULER-001:** This is a predecessor Gitea-only contract.
`DIM_QEMU_SCHEDULER_CONNECTION_FILE` MAY select
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

It MUST be rejected when native control-plane selection is requested. QEMU is
not part of the native installer bundle, has no native Project-state adapter,
and cannot satisfy native ordinary CI evidence.

The service-side Project binding MUST separately identify its webhook token,
Project API token, and non-empty label set. The stable host ID is a
concurrency identity, not an authorization principal. Its configured lease MUST be
at least 60 seconds. API-authenticated queued events outside that Project label
set MUST be acknowledged without creating demand.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles, and the trusted host's effective backend choice belong to
Project/workspace records. Raw credentials and provider-selection input must
not be written to those records.

The implemented Gitea Project profile has no legacy bare-Git PR store, separate
controller config, or separate job storage. The unimplemented ordinary service
would own its explicitly versioned private database without changing Project
state. DIM is pre-stable and rejects incompatible configuration or state unless
an explicit migration is part of the current contract.

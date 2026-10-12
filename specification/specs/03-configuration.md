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
schema `10` workspace state as `runtimeBackendProfile`; it is not copied from
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
| First release implementing the native adapter, with `workspaceBackend: "sysbox"` and a strict native source | Permit creation of a fresh source-aware schema-`9` workspace record under the unchanged Sysbox profile |
| Target release with a newly selected enabled backend and exact release profile, plus successful local preflight | Permit creation of a fresh schema-`10` workspace record |
| Target release with `vm` while KVM, Incus, image, storage, network, successful memory decrease, provider-name cloud-init metadata, controlled-first-boot validation, host-only backup permission, restriction, or release-gate support is absent or indeterminate | Reject before provider or state mutation and report the failed prerequisite |
| Later multi-backend target release with `workspaceBackend: "sysbox"`, schema-`8` `runtimeBackend: "sysbox"`, or schema-`9` `runtimeBackend: "sysbox"` | Reject unchanged with prior-release export/discard/create/restore guidance; never alias to `container` |
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

**CONFIG-NATIVE-CONTROL-PLANE-001:**
This is the explicit opt-in connection for the native Project adapter. A
participating host MUST set
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` to a regular,
non-symbolic-link, single-link, DIM-user-owned mode-`0600` JSON file of at most
64 KiB with this exact schema:

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "nativeGit": {
    "transport": "https",
    "endpoint": "https://git-control.example",
    "serviceId": "native-main",
    "generationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "workspaceWriteIssuer": {
      "username": "host-a",
      "password": "replace-with-canonical-32-byte-base64url-secret"
    },
    "rootReadIssuer": {
      "username": "root-reader-host-a",
      "password": "replace-with-another-canonical-32-byte-base64url-secret"
    }
  }
}
```

This readiness-only form contains exactly `schemaVersion`, `hostId`, and
`nativeGit`. It has no Project list, ordinary-CI endpoint, capacity,
candidate-selected image, reviewer, promoter, or storage-administrator
identity. `hostId`, `serviceId`, and both usernames are safe non-empty identifiers.
URLs are
credential-free origins without path, query, or fragment. Each transport is exactly `https` or, only for a loopback HTTP
origin, `loopback-http`. Unknown keys, duplicate
credentials, redirects, service-identity or host-identity mismatch, and mutable
or unassigned endpoints fail before Project, workspace, grant, or runtime
mutation. HTTPS requests use the system certificate store and hostname
verification, with no insecure verification bypass or automatic redirect.
Ordinary-CI service and host-capacity configuration belong to their
separate operator-owned connection and are not accepted in this file.

The generation is exactly 64 lowercase hexadecimal characters and identifies
the current serving generation, not the immutable generation in an original
Project import receipt. Both passwords are distinct canonical base64url
encodings of exactly 32 bytes. The workspace-write issuer username equals the
host ID. Parsing this host file does not attest the service or make a native
Project runnable.

The workspace-write issuer is host-scoped readiness-attestation and
proposal-write lease authority. The separate root-read issuer can mint only a
short-lived read lease used to materialize the protected root snapshot. Neither
is a reviewer, promoter, storage-administrator, or CI identity. The central
services automatically derive CI eligibility for every Project created through
the trusted native lifecycle. No per-Project registrar, admission file,
approval, or refresh is part of host configuration. This eligibility is
independent of the protected required-job policy and does not review
candidate-selected job bytes. The
central service's separate native reporter credential, not a host credential,
submits accepted durable evidence to native Git. None may enter a workspace,
job, image, Compose bundle, log, or Project state. Failure of an independently
configured ordinary-CI service pauses claiming while durable candidate work
queues for automatic retry. It does not change native Project readiness or
cause a local or Project-scoped fallback.

**CONFIG-NATIVE-READINESS-001:** The selected host proves readiness through
exact `POST /v1/projects/{projectId}/workspace-readiness` with no query string.
The request body contains exactly `schemaVersion: 1`, the current connection's
`generationId`, `repositoryId: "root"`, the full `protectedRef`, and the
schema-5 record's exact `rootCommit`, `rootTree`, and three review-policy
revisions. The authenticated credential supplies the owner host and cannot
select another host in the body.

A successful non-cacheable `200` response contains exactly schema version,
service ID, owner host ID, Project ID, root repository ID, generation ID,
protected ref, commit, tree, policy revision, required-review revision, and
required-job-set revision. The service returns it only after a fresh read-only
proof of the registered owner, imported root and protected ref, complete object
graph, authoritative policy, and installed proposal-only workspace transport.
The host requires exact identity and revision equality with the connection and
Project record. The selected commit and tree must also match unless a workspace
lifecycle operation explicitly requests a fast-forward selection, in which case
the service proves that its returned current head descends from the stored root.
It
reloads the owner-only connection while holding the Project lock before each
ready transition or workspace lifecycle selection. Snapshot materialization
uses the distinct root-read issuer; readiness and proposal transport use the
workspace-write issuer. A later serving generation does not rewrite the
original import receipt.
Missing, additional, malformed, oversized, stale, foreign, redirected, or
cacheable responses fail closed.

This operation creates no lease, credential, ref, review, approval, promotion,
CI admission, attempt, result, Project state, or workspace state. It is the only
service request allowed to authorize the schema-5 to schema-6 ready transition;
a root-import proof, snapshot, CI result, or successful Git request alone is not
readiness evidence.

**CONFIG-NATIVE-SELECTION-001:** Presence of
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` selects only the native adapter.
An empty value, unreadable or invalid file, or
unsupported native state MUST reject before selecting an adapter or mutating
Project, service, Git, CI, workspace, or runtime state. Native selection MUST
NOT start, inspect, reconcile, or fall back to managed Gitea.

Native selection is mutually exclusive with
`DIM_GITEA_CONNECTION_FILE`, `DIM_GIT_SYNC_CONNECTION_FILE`,
`DIM_QEMU_SCHEDULER_CONNECTION_FILE`, and
`DIM_ORDINARY_CI_POOL_CONNECTION_FILE`, including empty values. It MUST also
reject a same-name schema-`4` Gitea Project rather than parse, migrate, delete,
or adopt it. Absence of `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` preserves
the complete existing managed or external Gitea selection and behavior;
native state supplies no fallback or authority to that predecessor adapter.

The first native adapter step may derive only the strict canonical
`admission-pending` record in `PROJECT-NATIVE-PENDING-001`. It MUST use an exact
imported schema-`2` draft and a fresh authenticated imported-root proof under
the Project lock. `dim project create PROJECT` under native selection MUST
also require `DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE` to name the separate
owner-only mode-`0600` schema-`1` root-importer connection. That connection's
service, endpoint, and host MUST equal the selected control-plane native Git
binding; its credential and serving generation remain distinct fields and
MUST NOT be inferred from the host connection. An absent, empty, invalid,
foreign, stale, or unauthenticated importer connection rejects before Project
state mutation. Native `project list` and `project show` do not require or
load that importer credential.

The installed pending-create step currently requires the native Git endpoint
to use `loopback-http`. The owner-host importer client supports only loopback
HTTP, so an otherwise valid HTTPS control-plane connection MUST refuse
pending creation before reading an importer file or changing Project state;
HTTPS support requires a separately reviewed importer TLS trust model. This
limit does not make HTTPS a Gitea fallback.

Pending admission grants no repository transport, workspace, ordinary or
QEMU admission, review, promotion, removal, purge, or ready authority. Every
other native mutation MUST fail closed until its own contract is implemented.
The later ready transition depends on registered owned repository state,
protected-root snapshot and proposal-only transport, plus workspace runtime
prerequisites under `TRUST-NATIVE-READINESS-001`. It MUST NOT wait for ordinary
or QEMU CI deployment, a CI result, or a completed promotion. The direct host
CLI implements
only this pending step and local pending-state queries; the controller remains
outside the native path. This contract does not claim that the clean-host gate
passes.

**CONFIG-NATIVE-PROJECT-DRAFT-001:** The separate trusted-host bootstrap draft
is not selected by this environment variable or a Gitea connection. Its strict
schema-`2` record and private artifact bind the host, active native generation,
exact root commit/tree and policy, and bundle digest as
`PROJECT-NATIVE-DRAFT-001` requires. Registrar and importer credentials remain
in their distinct owner-only connection files, never in Project state.
Creating a draft does not load this target connection, advertise capacity,
grant Git transport, or let a native lifecycle request fall back to Gitea.

The installed bootstrap command names those files independently with
`--registrar-connection` and `--importer-connection`; neither is inferred from
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` or
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`. It also requires
`--project-id`, `--source-repository`, and the canonical full branch
`--source-ref`; accepts only the reviewed manifest at the pinned source commit;
and optionally accepts an absolute `--git-executable` (default `/usr/bin/git`).
The command creates its disposable scratch below the selected private DIM state
root and does not accept an alternate scratch, remote URL, branch shorthand,
tag, raw policy JSON, or credential value on the command line. Registrar and
importer files retain their existing exact schema-1 formats and loopback-HTTP
limit. This bootstrap-host limit is independent of HTTPS ordinary/QEMU worker
connections and does not claim built-in TLS termination for any service.

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

The predecessor service-side Project binding uses separate webhook and API
tokens, an explicit label set, and a lease of at least 60 seconds. Those
Project-scoped credentials and `workflow-job` events belong **only** to
`CONFIG-QEMU-SCHEDULER-001`; they MUST NOT authorize native QEMU admission.

**CONFIG-NATIVE-QEMU-001:** Native Project QEMU
capacity MUST use a separate operator-owned connection from the predecessor
`DIM_QEMU_SCHEDULER_CONNECTION_FILE`. A participating host supplies
`DIM_NATIVE_QEMU_CONNECTION_FILE` as a regular, non-symlink, DIM-user-owned
mode-`0600`, single-link JSON file of at most 64 KiB. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "generationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gitExecutable": "/usr/bin/git",
  "scheduler": {
    "transport": "https",
    "endpoint": "https://qemu-ci.example",
    "serviceId": "qemu-main",
    "hostToken": "replace-with-canonical-32-byte-base64url-secret"
  },
  "nativeGit": {
    "transport": "loopback-http",
    "endpoint": "http://127.0.0.1:9080",
    "serviceId": "native-main"
  },
  "capacities": [{
    "capacity": "primary",
    "runnerBaseImage": "registry.example/dim/qemu-runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "jobBaseImage": "registry.example/dim/qemu-job@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "cpus": 4,
    "memoryBytes": 8589934592,
    "supervisorMemoryBytes": 9663676416,
    "pids": 2048,
    "timeoutSeconds": 3600,
    "outputBytes": 16777216
  }]
}
```

The credential examples are placeholders, not valid tokens. The generation is
exactly 64 lowercase hexadecimal characters and `gitExecutable` is an absolute
non-root path. The host token MUST be canonical base64url decoding to exactly
32 bytes and MUST be distinct from ordinary CI, registrar, reporter, and
predecessor QEMU secrets. `nativeGit` is exactly the loopback HTTP origin for
`native-main`. The scheduler brokers one short-lived, Project/root-scoped
candidate lease for an active exact assignment; no reusable native-Git
credential is persisted or passed into the supervisor container or guest.
The scheduler endpoint is an exact credential-free HTTP origin with no path,
query, or fragment. `transport` is exactly `https` for an HTTPS origin or
`loopback-http` for an HTTP origin on `127.0.0.1` or `[::1]` only. The stable
safe `hostId` MUST match the eventual native control-plane host ID. Capacities
are nonempty with unique safe names, immutable operator-selected registry
references pinned by complete lowercase SHA-256 digests, and positive safe
integer bounds. Extra, missing, duplicate, credential-bearing, or mutable
fields fail before registration or runtime mutation; the file is opened with
no-follow semantics and its owner, mode, link count, size, and stable metadata
are checked around parsing. There is no Project list, label, webhook URL,
per-Project token, Gitea URL, runner registration, or candidate-selected image.
All registered native Projects use the operator-owned capacities without a
Project-specific CI registration, approval, admission, or refresh. QEMU remains a separate scheduler and
executor from ordinary Sysbox capacity, outside the installed two-service
Compose bundle. Native selection rejects the predecessor QEMU variable even
when this file is absent.

`memoryBytes` is the guest RAM bound copied into the authoritative descriptor
and passed to QEMU. `supervisorMemoryBytes` is the outer trusted Docker
supervisor limit and MUST be strictly greater than `memoryBytes`; operators
must size the difference for QEMU, the kernel and initramfs, and supervisor
process overhead. Equal or smaller limits fail while parsing this private file,
before scheduler contact.

The host token may claim, renew, recover, and report only its own QEMU
capacity. Scheduler intake accepts authenticated events bound to the current
registered native Project, workspace proposal, exact candidate commit/tree,
and candidate-declared job. The protected required-job policy is recorded for
later promotion evaluation but does not create eligibility or filter intake.
Neither candidate content nor a webhook may choose the base image, resource
ceilings, host command, mount, network or reusable credential. The candidate
may supply only a strict job definition and script executed with fixed argv
inside the VM. All such results are `candidate-controlled`, including on
KVM-capable hosts. Missing KVM reports unavailable; it never changes a
required QEMU job into an ordinary job or a success. No controller lifecycle
reads this target native QEMU connection as authority; the separately invoked
native QEMU host worker does. Its presence, including an empty value, still
rejects lifecycle option construction before any Gitea fallback, without
runtime mutation.

The scheduler owns a distinct private configuration and database with
host-scoped tokens and global capacities, not Project-bound credentials or
ordinary-CI state; see [Native QEMU Scheduler and Evidence](local-details/native-qemu.md).

## Native ordinary-CI host connection

**CONFIG-NATIVE-ROOT-CI-HOST-001:** An installed ordinary Sysbox execution
node uses one operator-owned, absolute, mode-`0600`, single-link regular JSON
file. The file is host state and MUST NOT be mounted into a workspace or job.
Its exact schema is:

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "generationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "stateDirectory": "/var/lib/dim/native-root-ci-host",
  "gitExecutable": "/usr/bin/git",
  "ordinaryCi": {
    "transport": "https",
    "endpoint": "https://ordinary-ci.example",
    "serviceId": "ordinary-main",
    "credential": {
      "username": "host-a",
      "password": "replace-with-canonical-32-byte-base64url-secret"
    }
  },
  "nativeGit": {
    "transport": "https",
    "endpoint": "https://native-git.example",
    "serviceId": "native-main"
  },
  "capacities": ["primary", "secondary"]
}
```

`hostId` and every capacity are safe identifiers, and capacities are nonempty
and unique. The ordinary credential username equals `hostId`. Its password is
a canonical base64url encoding of exactly 32 bytes and is the node's only
reusable service credential.
Endpoints are credential-free origins. `transport` is `https`, or
`loopback-http` only for `127.0.0.1` or `[::1]`. The generation is exactly 64
lowercase hexadecimal characters. State and executable paths are absolute.
The state directory and every capacity journal are owner-only; a node MUST
refuse a symlink, foreign owner, permissive mode, malformed journal, duplicate
capacity, or changed replay identity before claiming.

Each configured capacity runs one exclusive loop. The ordinary scheduler,
never the node, derives the exact descriptor and issues or revokes the attempt
after durably reserving the node and capacity. Exact reservation replay returns
the same server-selected assignment. For an active claim the node may request
one ephemeral candidate-read lease from the ordinary service using only its
host credential and claim identity. The service derives the authenticated host,
configured capacity, active claim, attempt, descriptor, and job kind from its
own state and asks native Git with its distinct `candidateReader` credential.
Native Git issues an in-memory lease only after proving the current unrevoked
exact attempt, descriptor digest and contents, `ordinary-sysbox` kind, host,
capacity, Project, repository, protected head, candidate commit, and candidate
tree. It repeats that currentness proof before each upload-pack invocation.
Malformed requests return `400`, unknown credentials return `401`, and a
configured candidate reader used for the wrong execution kind returns `403`.
Missing, unregistered, or non-current tuples return `404`; a known current tuple
that conflicts with live authority, including inactive authority, returns
`409`. Unexpected storage and I/O failures remain internal errors.

The node persists exact claim, renewal, recovery, and result request bytes
before each uncertain network boundary. Restart replays those bytes and
ownership-inspects cleanup; it never regenerates an identity, adopts an unknown
resource, silently uses `runc`, or claims another job on a fenced capacity. The
candidate lease is not persisted by either service or the node and only it
reaches the private Git subprocess. No scheduler `candidateReader`, attempt
issuer, host credential, ordinary-CI credential, or native-Git secret enters
the candidate tree, container, arguments, logs, or terminal evidence. Host
config and journal schemas reject `attemptIssuer`, `rootReadIssuer`, candidate
lease credentials, and arbitrary reader mappings.

**CONFIG-NATIVE-ROOT-CI-ELIGIBILITY-001:** The ordinary and QEMU services use
their operator-owned global service and host configuration to reconcile all
registered native Projects. There is no per-Project CI connection file,
registrar credential, admission lease, or operator refresh command. A service
restart, generation rollover, or temporary native-Git outage triggers internal
reconciliation and retry. Host credentials remain scoped to one registered
node and its named capacities. Candidate events remain scoped to one Project,
root repository, workspace proposal, commit, tree, execution kind, and job.
Neither source may supply the other source's authority.

Project-specific Git namespaces, repository aliases, root repository/ref,
profiles, and the trusted host's effective backend choice belong to
Project/workspace records. Raw credentials and provider-selection input must
not be written to those records.

The implemented Gitea Project profile has no legacy bare-Git PR store, separate
controller config, or separate job storage. The unimplemented ordinary service
would own its explicitly versioned private database without changing Project
state. DIM is pre-stable and rejects incompatible configuration or state unless
an explicit migration is part of the current contract.

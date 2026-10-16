# Configuration

**Kind: Contract**

## Native selection

**CONFIG-NATIVE-ONLY-001:** Every Project lifecycle operation requires
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE`. The value names one absolute,
caller-owned, single-link, non-symlink, mode-`0600` schema-1 file. It binds the
host ID, native Git service and generation, credential-free endpoint, and
distinct root-read and workspace-write issuer roles.

An absent, empty, unsafe, malformed, stale, or unauthenticated file fails
before Project, Git, workspace, runtime, or service mutation. There is no
managed-provider default and no provider fallback. Predecessor selectors,
including `DIM_GITEA_CONNECTION_FILE`, `DIM_GIT_SYNC_CONNECTION_FILE`,
`DIM_QEMU_SCHEDULER_CONNECTION_FILE`, and
`DIM_ORDINARY_CI_POOL_CONNECTION_FILE`, are rejected even when empty.

`dim project create` additionally requires
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`. It names a distinct private
root-importer role bound to the same service, endpoint, owner host, and serving
generation. List and show are local bounded queries and do not load importer
credentials.

## Native Git storage

**CONFIG-NATIVE-GIT-PERMISSIONS-001:** Service-owned bare repositories MUST be
created with numeric Git sharing mode `0600`, independent of the caller's
umask. Future Git object and ref creation MUST preserve owner-only permissions.
Registered-repository startup validation MUST require the exact creation
setting and reject missing or changed values. It MUST NOT weaken durable-file
checks or repair unsafe object/ref metadata to accept existing state.

## Workspace runtime

**CONFIG-WORKSPACE-001:** The current release accepts only
`workspaceBackend: "sysbox"`. Backend, image, and resource configuration is
trusted host input. Project content cannot select a runtime driver, host path,
socket, device, network, storage provider, image, or low-level QEMU argument.

Native workspaces use strict schema 9 with `source.kind: "native"`. Historical
provider-backed or minimal records are rejected unchanged. They are never
aliased, migrated, or adopted.

## Global CI

**CONFIG-NATIVE-CI-001:** Ordinary and QEMU capacity is global operator state,
not Project state. Private exact-schema files bind one service generation,
host identity, named capacities, immutable digest-pinned runner/job images,
and fixed resource limits. Candidate content may select only a reviewed job
name, script blob, and runtime-fixed argv.

The ordinary host requires registered `sysbox-runc` and the enabled exact-
version host mirror provider; startup reconciles the DIM-owned pull-through
cache and control network before advertising capacity. The QEMU host requires a
functional character `/dev/kvm`; missing KVM is unavailable and cannot select
TCG or ordinary execution. No CI config contains a Project registrar,
reviewer, promoter, Actions token, provider webhook, or reusable guest
credential.

## State contraction

**CONFIG-NATIVE-CUTOVER-001:** There is no in-place migration or adoption from
predecessor Project, repository, runner, or provider state. Operators use the
pinned prior release to stop services and export declared user data, validate
it outside DIM state, then create fresh native state and restore only that
data. Native installation does not delete old containers, volumes, remotes,
credentials, or repositories.

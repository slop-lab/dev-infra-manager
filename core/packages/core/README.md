# @slop-lab/dim-core

Core TypeScript APIs behind the `dim` command-line interface. This package
implements:

- Project and project-scoped repository state;
- managed Gitea reconciliation and clone URLs;
- provider-neutral Project CI runner lifecycle with an initial managed-Gitea
  coordinator adapter and isolated container executor;
- persistent workspace create/start/restart/update/discard lifecycle;
- a Sysbox workspace runtime plan with runc reserved for trusted infrastructure;
- host-readiness checks;
- plugin manifest loading and version validation.

Most users should install
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli)
instead. The core package is for embedding DIM lifecycle operations in
TypeScript tools or contributing to DIM itself.

## Installation

Pin the same reviewed release used by the CLI:

```bash
npm install --save-exact "@slop-lab/dim-core@0.9.0"
```

The package is ESM-only, supports Node.js 24 and 26, and includes TypeScript
declarations. It supports Linux hosts only.

Lifecycle operations require a mounted Linux procfs and the util-linux
`flock` executable. DIM combines the kernel guard with a versioned owner
record so process death releases exclusion while PID reuse remains detectable.

## Basic use

```ts
import {
  ProcessRunner,
  createProject,
  importProjectRepository,
  createWorkspace,
  lifecycleOptions
} from "@slop-lab/dim-core";

const runner = new ProcessRunner();
const options = lifecycleOptions(process.env);

await createProject(runner, options, "acme");
await importProjectRepository(runner, options, {
  project: "acme",
  alias: "root",
  source: "/path/to/acme",
  root: true,
  ref: "main",
  protectedPatterns: ["main", "development"]
});
await createWorkspace(runner, options, {
  project: "acme",
  name: "feature-123",
  runtimeBackend: "sysbox",
  profiles: [],
  cpuCount: "4",
  memory: "8g",
  pidsLimit: "4096"
});
```

Lifecycle methods reconcile Docker containers, volumes, networks, and a local
managed Gitea service. They are not pure data helpers. Callers must provide a
usable host environment and surface `UserError` messages to users without
discarding the underlying operation result.

`importProjectRepository` is a low-level mirror import and copies every source
ref. Applications that want the CLI's branches-and-tags-only default should
use the prepare/transfer/complete API and perform that explicit Git transfer
with host credentials.

## Configuration

`lifecycleOptions()` reads the same environment used by the CLI:

Native Git root import is an additive host-only API, not a selectable Project
lifecycle backend. After a separate registrar prepares the empty root, trusted
host code may call `createNodeNativeGitRootImporterClient(connectionFile)` from
this package with a different, owner-only mode-`0600` JSON file:

```json
{
  "schemaVersion": 1,
  "endpoint": "http://127.0.0.1:9080",
  "serviceId": "native-main",
  "role": "operator-root-importer",
  "hostId": "builder-a",
  "generationId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "credential": {
    "username": "root-importer-a",
    "password": "replace-with-canonical-base64url-32-byte-secret"
  }
}
```

The file must be a single-link, non-symlink regular file owned by the DIM
host user. The endpoint is an exact loopback HTTP origin; the importer
credential must be distinct from the registrar and ordinary-CI credentials.
`importRoot` takes a trusted policy, expected commit, protected ref, local
Git bundle path, and `AbortSignal`. It attests the exact importer role, host,
service, and generation immediately before uploading the bounded bundle and
again before requesting finalization. It checks the durable and final receipt
against the request and transferred bundle. No reader or writer is issued and
existing Gitea lifecycle selection remains unchanged.

After root import, trusted host code may separately call
`createNodeNativeGitRootReadIssuerClient(connectionFile)` with an owner-only
mode-`0600` connection whose role is `operator-root-read-issuer`. The client
requests only a 30-second credential for one named Project's fixed `root`
repository and accepts only an exact non-cacheable `201` response bound to the
configured service and generation. The returned username and password are for
upload-pack only; the issuer credential itself cannot use Git, and neither
credential creates Project ready state. Callers must pass Git credentials
through a private prompt or environment boundary, never command arguments,
logs, Git configuration, errors, or persisted state.

For a retained native bootstrap draft, trusted host code should instead call
`issueNativeProjectDraftRootReadLease({ stateRoot, name,
importerConnectionFile, issuerConnectionFile, signal })`. This operation loads
both owner-only role files, requires one endpoint, owner host, and generation
with distinct credentials, and accepts only an exact `root-imported` draft
whose immutable receipt matches a fresh importer-authenticated live proof. It
makes the current importer/issuer generation authenticate that proof and lease,
while the unchanged draft and nested import receipt retain the generation that
performed the original import. Pending drafts cannot roll to another generation.
It mints the Project/root-scoped lease only after that proof and rereads the full
draft before returning, so changed host state withholds the result. It returns
only the ephemeral upload-pack lease: neither role credential nor the lease is
persisted, placed in arguments, or made available to a workspace. The draft
remains non-runnable and no Gitea or native Project-ready state is created.

Trusted host code may call
`materializeNativeProjectDraftRootSnapshot({ stateRoot, name,
importerConnectionFile, issuerConnectionFile, gitExecutable, temporaryRoot,
signal })` to turn that imported draft into a private, commit-addressed host
snapshot under `assets/native-project-roots/<projectId>/<rootCommit>`. The
operation holds the Project lifecycle lock, repeats the live imported-root
proof, and reuses a recursively validated read-only snapshot without minting a
lease. Otherwise it uses the short-lived lease only through environment-backed
Git askpass, fetches and hash-checks the exact commit, tree, and blobs in
disposable private Git storage, and publishes a fully read-only staged tree.
Regular and executable files retain their Git modes. Relative symbolic links
are accepted only after their target blobs are hash-checked and only when they
resolve inside the complete snapshot; absolute, dangling, escaping, and
reserved lifecycle-path links, gitlinks, unsafe cache nodes, and oversized
objects fail without adopting or replacing a target. The return value contains
only Project/root identity, the protected ref, commit/tree IDs, and the host
snapshot path. It contains no credential and is not a runtime-ready Project
descriptor. Native Project selection remains unavailable and Gitea remains the
only runnable profile.

`parseNativeRootBootstrapManifestYaml(yaml, selectedRef)` is a separate,
mutation-free reader for the native-only `nativeReview` extension of a reviewed
`.dim/repos.yml`. `compileNativeRootBootstrapPolicy({rootAlias, protectedRef,
review})` accepts the same review fields for explicit manifest-free bootstrap.
Both derive sorted reviewer and required-job lists, bind `ordinary-sysbox` or
`qemu` job kinds plus the `candidate-controlled` evidence class into the
versioned imported-root policy, use v2 policy/job revision domains while
retaining the v1 reviewer domain, and produce the exact native Git import
policy. The existing Gitea repository-set parser
rejects this extension. Neither policy function reads Git or creates a Project.
`prepareNativeRootBootstrapGit` accepts an already-local, trusted host Git
repository and an owner-only mode-`0700` scratch directory. It resolves one
concrete branch to an exact commit, reads the native manifest from that same
commit (or accepts explicit manifest-free policy), and stages a mode-`0600`,
self-contained, one-ref bundle in private storage. The caller must invoke the
returned `cleanup()` in a `finally` block after importing. The planner does not
fetch an origin, attest the selected source URL, call a DIM service, create
Project state, or grant CI/transport authority. The host-only
`bootstrapNativeProjectRoot` API loads separate mode-`0600` registrar and
importer files, checks the same endpoint, host, and generation, then attests
both roles. It pins the local source, retains the exact bundle and immutable
policy in a private, non-runnable schema-`2` draft **before** service mutation,
prepares the root, imports it, and durably binds the final receipt. An exact
retry after uncertain finalization converges without another protected-ref
write. Before storing a final receipt or returning an imported draft, the host
requires a no-store, importer-authenticated read-only proof of the current
activation, owner, bundle, sole protected ref, commit, tree, and object graph.
The strict schema-`3` proof binds its outer serving generation to the current
connection, compares its nested schema-`1` import receipt byte-for-byte with
the original draft receipt, and parses a separate sequence, ref, commit, tree,
and policy-bound current head. Sequence zero must equal the original import;
the service refuses later heads until immutable review, approval, and both CI
evidence classes can be independently verified. The host draft and
nested receipt are never rewritten. An imported draft may replay through a newer serving
generation only when every other claimed intent field is unchanged; the draft
is never rewritten. A moved ref, missing owner
marker, or replaced repository path leaves the draft unchanged and non-runnable.
A completed schema-1 draft from the earlier import implementation remains
byte-preserved proof/read data only; pending schema-1 drafts cannot resume or
roll generations, and neither form supplies authoritative kind-labelled jobs.
This does not attest the external source origin, select native Git for
`lifecycleOptions()`, issue a Git reader/writer, admit ordinary or QEMU CI, or
publish a runnable Project. Gitea must remain installed until the distinct
native adapter and real Sysbox/KVM acceptance gate pass.

`loadNativeQemuConnection(file, expectedHostId)` is a separate host-only
preflight API for the proposed QEMU scheduler. It checks a single-link,
owner-only mode-`0600` file, exact service/host/endpoint identity, a canonical
host token, and globally pinned runner/job images and resource bounds. Parsing
does not connect to a scheduler, advertise capacity, boot a VM, or provide
KVM acceptance. Setting `DIM_NATIVE_QEMU_CONNECTION_FILE` still makes
`lifecycleOptions()` refuse native selection before any Gitea fallback.

The exported `createNativeRootCiProofClient` is a separate strict consumer for
the installed schema-7 native Git bundle's read-only proof namespace. Its
configuration pins one endpoint, `native-main` service identity, serving
generation, and `ordinaryCi.identity` credential. Before reading proof it
attests the exact `native-root-ci-proof-reader` role and ordered policy/event
scope. It accepts only bounded non-cacheable exact JSON, verifies every policy
field, sorted unique jobs/reviewers/rules, v2 policy and job revisions, the v1
reviewer revision, SHA-256 policy bytes, current-root object format and import
nonce, and the deterministic schema-2 event digest and selector bindings.
There are no redirects or retries. `404` and `409` are rejected/stale tuples;
authentication, protocol, malformed proof, timeout, cancellation, and transport
failures are unavailable without exposing credentials. This client is not the
standalone `nativeGitAdmissionSource` and creates no Project, admission,
attempt, result, scheduler, runtime, promotion, or ready state.

The installed ordinary service consumes that client for native-root policy
eligibility and inert review-event receipts. Its strict format-5 database adds
`native_root_ci_event_receipts` to bundle activation, admissions, and the
100,000-entry request replay ledger; format 4 is rejected unchanged. After exact local activation, the registrar credential
can register or revoke one imported `root`, while the reader credential can
query only a named current admission generation. A registration binds the
complete kind-labelled canonical policy, import nonce and protected ref to the
installer generation and global `nativeCapacityConfigDigest`; current head
sequence/commit/tree advance monotonically without changing the admission
generation. Policy, import, installer-generation, capacity, expiry, or
revocation changes create a new UUID generation and cannot revive an older
row. Restart preserves rows but requires activation again. Every freshness
check must use a new UUIDv4 `requestId`: exact replays of any operation,
including `current`, return historical receipts, even after revocation or
expiry, and are not assertions of present eligibility. This surface grants
no claim, attempt, execution, readiness, promotion, or Project lifecycle
authority, and the legacy flat ordinary authority is not exported or selected
by the installed CLI.

The webhook credential's installed endpoint is exact
`POST /v1/native-root-ci-events`. A strict schema-1 wrapper binds the startup
generation and active admission generation to one canonical schema-2
ordinary-Sysbox event. A new receipt requires a fresh native proof of the exact
event, complete policy/import identity, services, generation, current root, and
capacity digest. The service repeats those checks in the insertion transaction.
An exact replay may skip proof only while that admission remains active and
unexpired. Receipts are permanent, capped globally at 100,000, and mean only
that delivery was historically recorded; they create no demand, claim,
attempt, result, dispatch, approval, execution, or current-liveness authority.

- `DIM_STATE_ROOT`
- `DIM_GITEA_IMAGE`, `DIM_GITEA_PORT`, and `DIM_GITEA_ADMIN_USERNAME` for the
  default host-local managed service
- `DIM_GITEA_CONNECTION_FILE` for an operator-managed external Gitea service
- `DIM_ORDINARY_CI_POOL_CONNECTION_FILE` for a private, host-bound connection
  to the optional ordinary Sysbox CI pool
- `DIM_GIT_SYNC_CONNECTION_FILE` for the separately deployed Git-host sync service
- `DIM_GIT_USERNAME`
- the installed `workspaceBackend`, `DIM_WORKSPACE_IMAGE`, and
  `DIM_WORKSPACE_RUNTIME`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`
- `DIM_CI_RUNNER_IMAGE`, `DIM_CI_RUNNER_RUNTIME`, `DIM_CI_RUNNER_CPUS`,
  `DIM_CI_RUNNER_MEMORY`, and `DIM_CI_RUNNER_PIDS`

`DIM_CI_RUNNER_IMAGE` accepts exactly one of these forms:

- the built-in cache-tag sentinel `dev-infra-manager-ci-runner:act-runner-minimal-v2`,
  which DIM builds locally;
- a complete local Docker image ID such as `sha256:<64 lowercase hexadecimal characters>`;
- a tagless registry reference pinned as `name@sha256:<64 lowercase hexadecimal characters>`.

DIM pulls a configured registry reference and resolves it through Docker to the
actual local image ID. Runner probes, state, and launches use only that resolved
ID. Other tags and mutable image references are rejected before trusted image
execution.

Without `DIM_WORKSPACE_IMAGE`, the workspace image is
`dev-infra-project-workspace:<installed DIM package version>`. Release installs
therefore select the release tag, while aggregate-identity local packages
select their full local version tag. `DIM_WORKSPACE_IMAGE` remains an explicit
override.

`buildWorkspaceImage` stages the image Dockerfile, entrypoint, relay, and
cgroup helpers shipped in this package together with the exact-version
`@slop-lab/dim-controller-proxy` dependency, then runs Docker Buildx with the
current user's UID and GID. It accepts only an explicit mutable tag as a build
destination: image IDs, digest references, untagged references, and `latest`
are rejected. The operation is local to Docker and does not require or start a
DIM controller.

The resource environment variables provide defaults. `createWorkspace`
accepts persistent per-workspace overrides. A Project root ref may be omitted;
workspace creation then resolves the root repository's symbolic `HEAD` and
fails if no `HEAD` exists.

The default state root is `~/.local/state/dim`; the default managed Gitea port
is `3300`. Managed Gitea state uses strict schema `2` to record service and
resource ownership identities, immutable image and network IDs,
resource-establishment state, and the leased endpoint address. Schema-less and
schema-1 service state is rejected unchanged because it lacks that evidence.
Stop DIM and use the prior pinned release to export or otherwise preserve
needed repository data. Remove only independently verified resources; retain
any unverifiable data volume or other resource, and don't recreate the service
under a conflicting name. DIM rejects other incompatible pre-stable state
except for the single
lossless host lifecycle transition from schema 1 to schema 2. At controller
startup, DIM resolves the required host-mirror provider before
`migrateHostLifecycleState` runs under the host lifecycle lock and before any
managed service reconciliation or listeners. Migration renames only `resumeCiRunners` to `restartCiRunners`, and
retains the original bytes permanently in mode-`0600`
`host.json.schema-1.bak`. Normal lifecycle reads remain schema-2-only. A
malformed record, extra field, conflicting backup, symlink, or non-regular
canonical, backup, or recognized temporary artifact fails closed without
changing canonical state. No Project, workspace, runner, plugin, installer, or
other state is migrated. Workspace schema 8 adds a fresh 256-bit instance ID
that binds grants and plugin authority independently of the display name.
Schema-7 workspace records are rejected unchanged; use the prior pinned DIM
version to export needed Project/user data, then discard and recreate the
workspace. Retained data does not retain grants, routes, or approvals.

When `DIM_GITEA_CONNECTION_FILE` is set, the mode-`0600`, DIM-user-owned JSON
file is the complete external connection boundary:

```json
{
  "schemaVersion": 1,
  "transport": "https",
  "hostId": "builder-a",
  "apiBaseUrl": "https://gitea-control.example/api/v1",
  "hostBaseUrl": "https://git.example",
  "workspaceBaseUrl": "https://git.workspace.example",
  "runnerBaseUrl": "https://git.runner.example",
  "credentials": {
    "adminUsername": "dim-operator",
    "adminPassword": "replace-with-secret",
    "writerUsername": "dim-workspace",
    "writerPassword": "replace-with-secret",
    "maintainerUsername": "dim-host",
    "maintainerPassword": "replace-with-secret"
  },
  "projects": {
    "acme": {
      "id": "shared-project-id",
      "gitNamespace": "dim-acme",
      "giteaOrganizationId": 42
    }
  }
}
```

The API, host-clone, workspace-clone, and runner endpoints are independent
because those clients may use different routes to the same service. DIM
requires HTTPS unless every endpoint is loopback HTTP or the operator selects
`isolated-http` for an isolated network. It rejects redirects and bounds API
requests to the configured API base. The administrator must report admin
status; the writer must be a distinct non-admin identity. The maintainer may
reuse the administrator credentials, while a distinct maintainer must report
non-admin status. DIM does not create or stop the external service, create
credentials, change its organization-creation policy, or rewrite its webhook
allowlist. Host-admin repository deletion and Project purge do delete external
resources after the ordinary checks, affecting every host attached to the
shared Project even though their local records remain. Use `project remove` to
detach only local state. The operator must provision the users, organization,
permissions, and branch policy first. Each external Project requires a unique
explicit shared ID, namespace, and Gitea organization ID; this lets multiple
hosts attach to the same Project without adopting an unrelated same-name
organization. The stable host ID scopes and persists Sysbox provider
registrations across hosts.

Repository fetch and publish do not run in the DIM controller or a temporary
clone. Build the version-pinned service image with
`dim repo sync-service image build IMAGE`, deploy it beside Gitea repository
storage, and point `DIM_GIT_SYNC_CONNECTION_FILE` at a private connection file.
The service has a separate private alias registry and transport allowlist; it
receives no arbitrary command or caller-selected filesystem path. Absence of
the connection file makes synchronization fail closed. Initial `repo add`
imports remain local host Git operations.

Every Project-scoped managed CI runner requires `.dim/ci/runner.yml` in the protected Project
root. Its strict schema declares ordinary and integration labels,
digest-pinned disposable job images, required executables, and the integration
workload's `nested-docker` capability. DIM records the exact source ref, commit,
and configuration digest, probes both workloads before registration, and never
runs Project workflow commands in the runner host container.

The optional ordinary pool is a separate, operator-managed service for
reviewed DIM Projects using external Gitea. A trusted host reconciler derives
leased admissions from each Project's exact protected root snapshot, validates
the live external Gitea organization binding, and configures the organization
webhook. The service uses one common digest-pinned disposable job image,
stores admissions, demand, and renewable claims in SQLite, and owns stable
per-Project webhook secrets without receiving Gitea credentials. Worker and
registrar connections are separate mode-`0600` files. Remote hosts may claim a
Project without a local Project record only when their external Gitea binding,
expected service identity, and expected common image match the claim. The pool
retains a random admission generation only for an active identical-policy
refresh; revocation, expiry, or policy rotation creates a fresh generation so
preserved old demand cannot reactivate. It does not register an instance-wide
runner or replace the Project-scoped QEMU path.

For QEMU CI capacity, a Project may provide `.dim/ci/qemu-cache.bash`. DIM
requires applied root protection, resolves the configured root or symbolic
`HEAD` once to a concrete protected branch and commit, and stages the exact
hook blob from that immutable commit. An absent hook stages a deterministic
no-op executable instead of an empty sentinel. The resolved source ref,
commit, kind, and executable digest define the Project image identity and are
stored in runner state. DIM executes the staged bytes as root inside the Packer
guest, passing `/var/lib/dim-kvm-cache` as the only argument. The hook does not
run on the host and receives no host runtime socket or coordinator credential.
Reconcile the QEMU capacity after changing it.

The shared QEMU common base pins one dated, signed Ubuntu 24.04 cloud image and
one timestamped Ubuntu snapshot. Its identity includes exact artifact URLs and
digests, signer-keyring provenance, APT source and requested package/version
specifications, downloaded executable inputs, generated scripts, and Packer
templates. Ubuntu guarantees snapshot history for at least two years rather
than forever; preserve those source artifacts in a reviewed internal immutable
cache when rebuilds must remain possible beyond that period.

## API scope

The package exports its core modules from the root entry point, including
lifecycle records and low-level managed-Gitea helpers. APIs are versioned with
DIM but are not promised to remain source-compatible across minor `0.x`
releases. Prefer high-level functions from `projectRegistry`,
`workspaceLifecycle`, and `ciRunner` over direct state or Gitea mutation.

The plugin loader validates explicitly installed plugins and gives each
controller an instance-scoped plugin route registry. `GET /api` discovers
those authenticated routes. Core does not define product-specific external
URL routes or a generic repository-provider extension point.

DIM executes Project-controlled lifecycle scripts and manages container
runtimes. Consumers must follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md),
including full human review and exact version pinning.

See the
[architecture](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/architecture.md),
[lifecycle documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/repo-workspaces.md),
and [source repository](https://github.com/slop-lab/dev-infra-manager).

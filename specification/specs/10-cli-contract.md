# CLI Contract

## Common behavior

- The package exposes `dim`.
- `--help` is hierarchical; `dim help --all` also shows administrative commands.
- User errors and invalid CLI input exit with code `2`; unexpected errors exit
  with code `1`.
- Record commands print a human-readable summary by default. Record-producing
  subcommands expose their own `--json`; non-record commands do not.
- URL commands print exactly one URL on stdout.
- DIM rejects incompatible pre-stable project/workspace state and does not
  migrate it implicitly.
- Commands that inspect or mutate DIM state are clients of the managed
  host-admin controller API. Long-running calls and `exec`/`run` use controller
  command sessions rather than starting host runtime commands in the CLI.
  Local process adapters are limited to external Git import and credential
  discovery for repository synchronization, `x git`, the Git credential helper, controller bootstrap,
  and pre-controller backend diagnosis. They obtain DIM-owned state and
  credentials through the admin API.
- Every ordinary built-in other than the runtime-session exceptions below, and
  every plugin host-admin operation, MUST acquire host lifecycle admission
  before dispatch and MUST retain that admission through completion. This
  includes every lifecycle mutation. Host maintenance waits for those admitted
  operations before it captures recovery targets or drains services. An
  operation queued behind maintenance MUST reread host lifecycle state after
  admission and reject without dispatch unless the host is `ready`.
- `workspace.run`, `workspace.exec`, and `ci.runner.logs` are runtime-session
  exceptions. Each MUST acquire host lifecycle admission, confirm the host is
  `ready`, and release admission before dispatching its potentially long-lived
  stream. Independent runtime sessions may therefore progress concurrently and
  do not authorize concurrent lifecycle mutations. Existing operation-specific
  checks still apply; in particular, workspace run/exec retain their workspace
  readiness, ownership, and per-workspace locking checks. Host shutdown,
  workspace stop/discard, or another admitted lifecycle mutation that begins
  after this short readiness check MAY interrupt an existing stream; runtime
  admission does not promise that the host remains `ready` for the session
  lifetime.
- The managed controller uses separate Unix sockets in separate host runtime
  directories. The host-admin socket is mode `0600` and is never mounted into
  a workspace. The workspace socket accepts workspace-scoped grants and is
  mounted only into the trusted workspace root. The agent socket accepts a
  distinct agent grant and dispatches only routes explicitly registered for
  the `agent` audience. A grant from one socket cannot authenticate to another.

## Streaming command sessions

The host-admin API exposes an asynchronous command-session contract:

- `POST /v1/sessions` starts an allowlisted operation and returns an opaque ID.
- `GET /v1/sessions/ID/events` streams ordered SSE events for command stages,
  stdout, stderr, exit status, final result, and sanitized errors.
- `POST /v1/sessions/ID/input` forwards base64-encoded input bytes and may close
  stdin, or updates the active terminal's validated columns and rows.
- `DELETE /v1/sessions/ID` cancels the active process.

Sessions retain a bounded post-completion lifetime so a reconnecting client can
replay events by sequence. Command events never contain argv because arguments
may contain runtime secrets. The CLI is one client of this contract; a future
web UI can use the same lifecycle after an authenticated transport proxy is
defined. The session API remains host-admin-only and is not exposed through a
workspace grant.

Stdout and stderr event payloads are base64-encoded byte chunks with an
explicit encoding field. Clients MUST decode them before writing to their
respective streams and MUST reject unknown encodings. The transport must not
interpret arbitrary command output as UTF-8; redirected archive and other
binary task streams must remain byte-exact.

Input requests MUST form one FIFO. The CLI MUST preserve byte and EOF order
for terminal input, pipes, redirected files, and named FIFOs. A failed input
response or transport, event-stream response or transport, or cancellation
request MUST fail the command rather than being dropped or reported as a
successful session.

An interactive `exec` or `run` session MUST allocate a real pseudoterminal at
the controller-side process boundary. The CLI sends its initial terminal size,
forwards raw input bytes, and sends size changes after `SIGWINCH`; the
controller applies them to the same PTY before invoking the runtime CLI with
TTY allocation. Non-interactive sessions remain ordinary stdin/stdout/stderr
pipes. Output from internal non-streaming probes MUST NOT appear in session
stdout or stderr.

**CLI-STREAM-PROGRESS-001:** Lifecycle and CI operations that stream through a
command session MAY render an idle spinner only when stderr is a TTY. They MUST
NOT emit spinner frames or terminal-control bytes to non-TTY output, JSON
stdout, or the byte streams of interactive `exec` and `run` sessions.
For workspace `create`, `setup`, `update`, `start`, and `restart`, a visible
spinner MUST identify the current fixed lifecycle stage and the guaranteed
major work that remains. The controller MUST report a stage only when it enters
that stage. The client MUST render only recognized fixed labels, MUST NOT
interpolate arbitrary controller or command data, and MUST omit conditional
stages until the controller reports that they apply. Other eligible command
sessions MUST continue to identify the current operation while idle.
Non-TTY lifecycle and CI output MUST retain deterministic Project stage lines.
The client MUST clear the complete progress block before streamed stdout or
stderr and on final result, error, disconnect, cancellation, or local
interruption. Each progress row MUST fit the active terminal width.

## Projects

The Gitea organization, transfer, and provider details in Projects and
Repositories below are the only implemented Project-state adapter. Installing
the future native control-plane bundle does not select it for Project lifecycle.
Until a separate native Project/repository adapter is specified and
implemented, requesting native selection MUST reject every Project,
repository, workspace, ordinary-admission, and CI-runner operation before
state or runtime mutation.

```bash
dim project create PROJECT [--repos FILE] [--yes]
dim project create PROJECT --bootstrap-git-url URL [--bootstrap-git-ref REF]
  [--apply-repos | --no-apply-repos]
dim project create PROJECT --root ALIAS [--bootstrap-git-url URL] [--bootstrap-git-ref REF]
  [--protect PATTERNS] [--mirror]
  [--apply-repos | --no-apply-repos]
dim project list
dim project show PROJECT
dim project remove PROJECT
dim project purge PROJECT --yes
```

`create` atomically claims Project metadata and reconciles the reserved
`dim-PROJECT` organization in the managed Gitea service. A Project may be
assembled without a root, but it is not runnable until it has exactly one root
repository. Its ref is optional and falls back to the repository's symbolic
`HEAD`; a missing configured ref and missing `HEAD` is an error.

Project state uses schema version `4`. Its required `giteaOrganizationId` is
nullable only while creation has not established a trusted organization
identity; every `ready` Project MUST contain a positive Gitea organization ID.
After creating an organization, DIM MUST persist the returned ID while the
Project is still non-ready, then publish `ready` in a separate state write.
Creation retries with a stored ID MUST verify both that exact ID and the exact
reserved organization username. A retry with a null ID MUST attempt creation
rather than adopt an organization by name. If Gitea returns HTTP `422`, DIM
MUST fail closed and require administrator reconciliation.

`project create --bootstrap-git-url` fetches the selected external Git ref
before creating Project state and requires `.dim/repos.yml` there. Its single
`root: true`
mapping key supplies the stable root alias and its URL must match the bootstrap
URL. The CLI imports that root through the invoking host Git CLI using the
manifest's protection policy. `--bootstrap-git-ref` selects the manifest
revision and sets the root ref when the manifest omits one; a differing
manifest root ref is an error. A same-origin set applies automatically;
`--apply-repos` approves a set adding origins and `--no-apply-repos` skips it.
A declined or non-interactive multi-origin default must print
`dim repo apply PROJECT --yes` as the clone-free later path.

`project create --root` is the explicit manifest-free form. It creates the
Project and registers an empty or imported root under the supplied alias.
`--protect` and `--mirror` require this form because manifest bootstrap reads
those policies from `.dim/repos.yml`. Apply flags are mutually exclusive and
root/bootstrap options cannot be combined with `--repos FILE`.

`remove` removes only DIM Project metadata. It preserves the managed Git
organization and repositories and refuses while a workspace references the
Project. `purge` has the same reference check and permanently deletes the
DIM-managed Git organization and repositories after explicit confirmation.

## Repositories

```bash
dim repo add PROJECT ALIAS [URL] [--root] [--ref BRANCH] [--protect PATTERNS] [--mirror]
dim repo fetch PROJECT ALIAS [--prune]
dim repo publish PROJECT [ALIAS]
dim repo plan PROJECT [--file FILE]
dim repo apply PROJECT [--file FILE] [--yes]
dim repo apply PROJECT --file FILE --rebind-origin ROOT_ALIAS --expect-origin-tip FULL_COMMIT --yes
dim repo protect PROJECT ALIAS
dim repo list PROJECT
dim repo show PROJECT ALIAS
dim repo delete PROJECT ALIAS --yes
dim repo url PROJECT ALIAS
dim repo url --workspace PROJECT ALIAS
```

Every repository alias belongs to one Project namespace and is always
supplied explicitly; DIM never derives it from a URL. `add` without a URL
creates an empty repository and leaves protection pending. `add` with a URL
uses the invoking CLI's host `git` process to transfer the source into managed
Gitea, then applies protection. The default import copies branches and tags;
`--mirror` explicitly copies every source ref, including server-private refs.
Workspace creation also applies pending
protection to the root repository.
No protection pattern is implied. Projects pass their actual policy through
`--protect`; an omitted option records no patterns.
For a root with no configured ref, `protect` sets Gitea `HEAD` when exactly one
branch exists and does not guess when multiple branches exist.

`repos.yml` contains `schemaVersion: 1` and a `repositories` object whose
property names are Project-scoped aliases. Each value may contain `url`,
`root`, `ref`, `protect`, `blockForcePush`, `import`, and `publish`. `protect`
selects refs requiring reviewed changes and explicit host/owner push and merge
allowlists. `blockForcePush` selects refs that retain ordinary writer push and
merge permissions while rejecting force pushes; a ref named in both receives
the stronger `protect` policy. `import` maps managed branch
names to external branch names. `publish` independently authorizes managed
source branches and connection-relative destinations, which the import
namespace projects back to external names. An explicit import mapping copies
only its named external branches and does not import tags.
`project create --repos` requires exactly one
`root: true`. `repo apply` updates an existing Project without deleting
repositories omitted from the file. Reapplying an identical entry is a no-op;
an existing alias with a different URL, root role/ref, or protection policy is
a conflict rather than an implicit mutation. The explicit rebind form is the
only exception for a ready, protected Project root: it MUST require an
unchanged alias, concrete branch ref, ref mapping, publish mapping, and
protection policy, a credential-free HTTPS destination, and an exact complete
lowercase expected origin commit. Under the Project lock it MUST prove that
the current managed root tip is an ancestor of that advertised commit and
recheck both tips and the old origin before atomically changing only the
recorded origin URL. It MUST NOT move a managed ref, import objects into the
managed repository, change protection, delete omitted aliases, or rewrite
workspace state. Incompatible state fails without mutation. With no `--file`, it reads the
managed root's optional `.dim/repos.yml`. Because that file is read without a
local checkout, its Git URLs must be network/scp-style URLs or absolute
filesystem paths; relative filesystem paths are rejected as ambiguous. An
explicit local `--repos`/`--file` manifest is only an input to reconciliation
and is never written over the root repository's tracked `.dim/repos.yml`.

`repo delete --yes` deletes an unused non-root repository from managed Gitea
and Project metadata. It rejects the Project root, the selected target while
that target is importing, and any Project referenced by a workspace. An
importing sibling does not prevent deletion of a ready target.

When every discovered repository resolves to the bootstrap root's external
origin (or is empty), `project create --bootstrap-git-url` applies the complete set without
another prompt because it introduces no additional host Git origin. Otherwise
the CLI asks in a TTY and non-interactive use requires `--apply-repos`.
`repo apply` requires `--yes` in non-interactive use. `--no-apply-repos`
always skips discovery without disabling later clone-free `repo apply`.
Repository-set planning and all state transitions use the admin API. Initial
import remains a local CLI adapter, so current host credential helpers, SSH
configuration, and SSH agent apply to `repo add`. Fetch and publish use the
explicitly configured service on the physical Git host. For HTTP upstreams,
the CLI MAY resolve its existing credential helper and forward the result only
in that authenticated request. SSH synchronization uses the service account's
key and host verification; local paths are interpreted on the Git host and
must satisfy its configured root allowlist.
If root transfer fails after Project creation, repeating `project create` with
the same URL re-reads the manifest and derives the same root alias before
retrying that failed transfer. The explicit `--root` form likewise retries
with the same alias and origin. Neither form adopts
an unrelated existing Project, a ready root, or a different origin.

The built-in admin operations are:

```text
repo.plan       validate and compare a canonical RepositorySet
repo.prepare    claim an alias, create its Gitea target, and begin a transfer
repo.complete   finish or fail the identified transfer and update state
repo.root-set   read and parse .dim/repos.yml from the managed root ref
```

`repo.prepare` returns an opaque transfer ID and destination-only Gitea
credential to the host CLI. `repo.complete` accepts only the active transfer
ID for that Project/alias. During transfer, the repository remains non-ready
and only the trusted transfer identity has write authority. `repo.complete`
revokes that authority before applying protection. It publishes `ready` and
grants ordinary repository users only after protection succeeds. A transfer or
protection failure leaves the repository non-ready with protection pending and
no ordinary writer access. API inputs use normalized JSON field names
`rootRef`, `protectedPatterns`, and `forcePushBlockedPatterns`; YAML `ref`,
`protect`, and `blockForcePush` are file-format adapters, not API fields.

Host and workspace URLs never contain credentials.

`repo fetch` reuses the external `origin` URL recorded by `repo add`. External
branches selected by an explicit `import` mapping retain their mapped managed
names beneath `upstream/`; otherwise external branches retain their names
(for example, external `refs/heads/main` becomes managed
`refs/heads/upstream/main`).
Updates to those tracking branches are forced so an external force-push can be
represented without changing DIM-owned branches. Tags retain their names and
an existing tag that points to a different object rejects the fetch.
`--prune` deletes only managed `upstream/*` branches that disappeared
externally. It never deletes other managed branches or tags.

`repo publish PROJECT [ALIAS]` pushes only the non-forced branch mappings in
the reviewed repository-set `publish` policy. With no alias it publishes every
repository that has a non-empty policy, in alias order. A repository without a
policy cannot be published explicitly. Namespace prefixes are applied only at
the external boundary.

**CLI-REPO-SYNC-001:** Both operations MUST address one trusted Project ID and
repository alias through the configured Git-host service. The service MUST
resolve that identity through its private registry, serialize operations per
bare repository, and retain one deterministic `dim-upstream` remote in the
actual managed bare repository. Its URL and fetch refspecs MUST contain no
credential. Fetch MUST write external objects only to a hidden service-owned
namespace, then update visible `upstream/*` branches and allowed tags through
Gitea's receive path so hooks, protected-ref policy, and provider-visible state
remain authoritative. The hidden namespace MUST be removed after every
completed or failed request. Publish MUST read that same bare repository and
push only explicit reviewed branch mappings, without force, deletion, tags, or
arbitrary refspecs.

The service MUST reject unknown aliases and disallowed transports before Git
execution, use a scrubbed subprocess environment, and bound request bodies,
handlers, lock acquisition, and Git process groups. Error responses MUST NOT
include Git output. Credentials are request-scoped and memory-only. Concurrent
operations for one repository MUST NOT overlap ref mutation. Timeout MUST
terminate and reap the complete Git process group before releasing that
repository's lock.

## CI runners

The command tree below is the unimplemented target after retirement of
Project-scoped ordinary Sysbox runners. The current release still implements
the predecessor Gitea `sysbox` and `qemu` runner commands; target rejection of
`sysbox` input is not shipped behavior.

```bash
dim ci runner create PROJECT RUNNER qemu [--cpus COUNT] [--memory SIZE]
dim ci runner list
dim ci runner status PROJECT RUNNER
dim ci runner logs PROJECT RUNNER
dim ci runner start PROJECT RUNNER
dim ci runner restart PROJECT RUNNER
dim ci runner stop PROJECT RUNNER
dim ci runner delete PROJECT RUNNER --yes
dim ci runner defaults show
dim ci runner defaults set --cpus COUNT --memory SIZE --pids COUNT
dim ci runner defaults reset
```

`create` rejects an existing Project/runner identity. `start`, `restart`, and
`stop` require an existing runner; `start` additionally requires its phase to
be `stopped`. `delete` is the only command that removes provider registration,
local data, and lifecycle state.

**CI-ORDINARY-POOL-001:** Ordinary CI is supplied by the native control-plane
bundle in [Installer Facade](14-installer-facade.md#control-plane-bundle). The
contract below is a target and is not implemented. Without the separate native
Project/repository adapter, the installed bundle admits no Project and every
capacity advertisement or claim fails before mutation. Once that adapter is
approved, the
ordinary scheduler/webhook service owns admission, demand, queueing, and fenced
leases. Each participating DIM host controller owns named shared capacities
and executes claims through its local Sysbox runtime. The service receives no
host runtime socket or generic controller capability and cannot execute a job.

One ordinary admission is derived only from the exact protected native Git
snapshot and strict `.dim/ci/runner.yml`. It binds the native Project and
repository IDs, protected ref, commit and tree, policy and required-job-set
revisions, exact config digest, required job names, ordinary labels, one
complete digest-pinned disposable job image, and a fresh random public
generation. A Project-selected image is admission input for disposable jobs;
it is not installed or persisted as a Project runner image. An active
byte-identical policy refresh retains its generation. Expiry, revocation, or
any changed binding creates a new generation, even if a later policy is
byte-identical. Old demand and claims remain durable but inactive and MUST NOT
be rebound, renewed, or requeued under the replacement generation.

Authenticated native Git webhook events are demand input, never admission
authority. The event's Project, repository, protected tuple, job name, and
candidate commit/tree MUST match a live admission before demand is queued.
Missing, foreign, expired, revoked, stale, or tuple-mismatched events are
rejected without queue or attempt mutation. Before dispatch, the scheduler
durably issues the current unguessable attempt identity required by
`TRUST-PROMOTION-001`. A claim contains only the admitted execution tuple,
attempt identity, image digest, labels, resource bounds, generation, and lease
identity. It contains no Git, reviewer, registrar, webhook, scheduler, host,
or CI-result credential.

Each host controller authenticates with one host-scoped credential and
advertises operator-configured capacity names and bounds. Capacity is
installation state, not Project state: a host may execute an admitted Project
without a local Project record, but it MUST verify the signed admission tuple
and exact native service identity before launch. Claims are exclusive per host
and capacity and use renewable leases. An expired claim fences that capacity
until the same host controller has ownership-inspected and reaped its exact
DIM-owned container and acknowledged recovery. Foreign or ambiguous resources
remain untouched. Uncertain renewal stops and reaps the job before release.
Host maintenance holds lifecycle admission across execution and cleanup and
does not add disposable jobs to restart state.

Every claim launches one ephemeral Sysbox runner and one disposable job image
with bounded CPU, memory, and process limits, no host Docker socket, no
`/dev/kvm`, no workspace/controller credential, and no runner host mode. Its
nested daemon uses the host registry cache and fails without direct Docker Hub
bypass. Completion records exact terminal evidence against the issued attempt,
then removes the runner container and temporary credential material. No
persistent Project-scoped ordinary runner, runner registration, worker
container, image copy, or ordinary runner lifecycle record exists.

Every ordinary runner, probe container, and temporary socket volume carries
the exact `dim.managed=true`, `dim.owner=dim`, `dim.host`, `dim.capacity`,
`dim.admission-generation`, `dim.attempt`, `dim.resource`, `dim.kind`, and
`dim.digest` labels. The digest covers all length-framed label identities. The
controller inspects all nine labels and acts only on the immutable container ID
returned by that inspection; volume removal is name-based only after immediate
complete reinspection. Missing, partial, malformed, foreign, or mismatched
labels fence the capacity and leave the resource untouched.

The service SQLite schema is strict version `3`. Schema-less, schema-`1`, and
legacy Gitea ordinary-pool schema-`2` databases are rejected byte-for-byte
unchanged before WAL or schema mutation. The removed `dim ci ordinary-pool
service run`, `project reconcile`, `worker serve`, and `worker run-once`
surfaces and `DIM_ORDINARY_CI_POOL_CONNECTION_FILE` are obsolete input and MUST
be rejected rather than aliased. `dim ci runner create ... sysbox` and any
persisted Project-scoped Sysbox runner state are likewise unsupported. Existing
operators must use the old pinned release to stop and remove that capacity
before adopting host-controller shared capacity.

QEMU integration remains a predecessor Gitea-only path. QEMU runner identities,
scheduler connection, hooks, cache layers, and `/dev/kvm` boundary do not join
the ordinary service, cannot coexist with native selection, satisfy native
ordinary required jobs, or provide an ordinary fallback.

For a stopped QEMU runner, `start` MUST preserve its schema-`8` runner config
and hook artifact and provenance, supervisor image, job image, labels, effective
resources, and inheritance choice. It restores only runtime resources and
replaces the provider registration, webhook authorization, webhook, and
supervisor container. `restart` instead performs current protected-root
admission again and refreshes all derived config, hook, image, label, and
inherited-resource state.

`RUNNER` is a Project-scoped stable identity only for the `qemu` executor. A
Project may enable independently managed QEMU integration capacities. The QEMU
executor advertises the Project's integration labels plus the
DIM-owned `dim-qemu` label and boots a fresh one-job VM after a queued job
selects any of those labels. The managed organization contains all
repositories registered to that Project, so root and non-root repositories can
use the same QEMU capacity. Its supervisor, nested container
daemon, job containers, data volume, and resource limits are independent from
every workspace. The QEMU capacity receives neither workspace credentials nor
a host container-engine socket. Every integration label maps to a digest-pinned
disposable job image; no Project workload uses runner host mode.

Managed CI runner and DIM-owned workspace container engines MUST use a
host-scoped, managed Docker Hub pull-through cache. The cache MUST have
persistent filesystem storage, MUST NOT publish a host port or contain
upstream credentials, and MUST remain outside Project-defined networks.
DIM-owned workspace daemons and Sysbox runner daemons MUST discover it directly
as `dim-registry-cache:5000` on the control network. Nested agent DinD uses a
workspace-local relay, while QEMU guests use a launcher-local relay owned by
the persistent supervisor. Both relays target the cache's stable alias rather
than its replaceable address. Ordinary Project and example definitions MUST
NOT depend on the managed cache. Cache use MUST
NOT expose a host container-engine socket or make disposable runner state
persistent. Cache misses remain ordinary anonymous upstream pulls.

**HOST-MIRROR-PROVIDER-001:** Docker and APT cache implementation selection
MUST come from exactly one explicitly enabled, host-installed DIM plugin. The
plugin package MUST be installed at an exact version and MUST register one
complete Docker cache image and one complete APT cache image, each pinned by a
`sha256` digest. A missing provider, a second provider, or a mutable image
reference MUST fail before workspace or managed CI reconciliation. Project
configuration, workspace creation input, lifecycle hooks, and workspace
capability providers MUST NOT select, replace, disable, or override either
image or the fixed mirror endpoints.

Core MUST reconcile both plugin-selected images as DIM-owned containers on the
host control network, with persistent cache volumes, stable internal aliases,
no published host ports, and no upstream credential. It MUST NOT install the
cache packages into the host operating system. Before creating, setting up,
updating, starting, or restarting a workspace, core MUST reconcile both caches.
Every newly created or replaced workspace container MUST configure its Docker
daemon through `dim-registry-cache:5000` and APT HTTP and HTTPS acquisition
through `dim-apt-cache:3142`. Cache outage MUST fail package retrieval without
direct upstream fallback. Changing the workspace runtime configuration MUST
replace an older workspace container so the host-owned routing is applied.

**CI-CACHE-ROUTING-001:** A DIM-owned workspace engine, Sysbox runner engine,
QEMU guest engine, or nested verification engine configured for this cache
MUST fail its managed operation when the required cache or relay route is
unavailable. Verification MUST separately prove cold cache ingress with
upstream artifact requests, warm cache ingress without another upstream
artifact request, routing through the stable alias after cache replacement,
and failure without upstream bypass during a cache or relay outage.
Configuration inspection alone is insufficient. This requirement does not
mandate packet capture or general network monitoring.

**CI-QEMU-SCHEDULER-001:** Without a shared scheduler connection, the QEMU
supervisors form the existing host-local Project-scoped scheduler
with one capacity per named runner. They MUST coordinate through a shared
managed dispatch volume and atomically claim demand so duplicate provider
deliveries cannot produce concurrent claims for one trigger. The scheduler
MUST persist selected `queued`, `in_progress`, and `completed` workflow-job
state before acknowledging each webhook. The
scheduler MUST fsync the temporary state file, atomically replace the durable
state file, and fsync its containing directory before returning HTTP `202`.
State load, validation, replacement, or durability errors MUST fail the
acknowledgement. Event transitions MUST be monotonic per job ID, with
`completed` taking precedence
over `in_progress`, which takes precedence over `queued`, regardless of delivery
order. A completed job ID MUST remain terminal for seven days from its first
completed delivery; duplicate completed deliveries MUST NOT extend that window.
After that retention window the scheduler MUST prune the terminal marker so
state growth remains bounded. Terminal-marker pruning is independent of queued
claim lease expiry and recovery. Queued demand
MUST remain pending until the coordinator reports that the job entered
progress or completed; a disposable VM exiting, including after consuming a
different stale coordinator task, MUST NOT silently discard that demand.
Supervisor failures use bounded retry delay and MUST NOT terminate the webhook
server. After a supervisor or container restart, persisted queued demand MUST
resume without another webhook delivery. Claims MUST use renewable leases so a
removed or failed capacity cannot strand demand. Completed demand MUST NOT
start a VM. Workflows select either a Project integration label or the
forge-neutral `dim-qemu` capability and MUST NOT name a managed capacity.
The claimed webhook job ID is a durable demand trigger, not the identity of the
coordinator job consumed by the generic ephemeral runner. Each capacity MUST
run at most one VM at a time. Once that VM starts, completion, loss, or
replacement of its trigger claim MUST stop claim renewal but MUST NOT terminate
the running VM. Scheduler shutdown, scheduler state-I/O failure, supervisor
exit, and bounded process termination and cleanup retain their existing
behavior.

When `CONFIG-QEMU-SCHEDULER-001` selects a shared service, that service MUST
instead own Project demand and lease state in a transactionally durable SQLite
database. Its authenticated HTTP surface MUST be limited to normalized events
and capacity claim, renewal, and release; it MUST expose no generic state
mutation or executable payload. Claims MUST use unguessable IDs, finite
leases of at least 60 seconds, idempotent request IDs, and fencing. Clients
MUST use bounded two-second HTTP operations, renew at most every five seconds,
and derive a local monotonic deadline from the request start and negotiated
lease duration. The service MUST retain an expired claim for at least 20
seconds before takeover and MUST apply a one-time recovery hold to outstanding
queued claims on restart without reviving terminal demand. The Project API
credential MAY seed only queued backlog events matching the service's Project
labels; only the webhook credential may report running or completed
transitions. Each host remains authoritative
for its local supervisor and VM. Loss or uncertainty of renewal MUST stop and
reap that process group before the capacity claims again. Scheduler credentials
MUST never enter a guest or job environment. The service MUST hold no Gitea
administrator credential. Persistent state MUST cap each Project at 10,000
combined queued and running jobs, 10,000 completed tombstones, and 100,000
claim request receipts. Saturation MUST reject new entries without evicting
existing nonterminal demand, claims, or live request fences. Completed events
MUST free nonterminal capacity. Completed tombstones and receipts without a
live claim MUST be pruned after seven days. An unsuccessful supervisor MUST be
terminated and reaped before release, then fresh claims MUST use
shutdown-interruptible exponential backoff capped at 30 seconds.

**CI-QEMU-BACKLOG-001:** QEMU runner create, start, and restart MUST make the
supervisor healthy, install its authenticated workflow-job webhook, and perform
one queued-job reconciliation before publishing the runner `ready`. The
coordinator adapter MUST retain the first ascending-ID page, derive a fixed
last page and effective page size from validated same-Gitea `Link` metadata or
coherent first-page count metadata, then enumerate those pages from last to
first. It MUST collect and deduplicate all jobs before replaying any job through
the supervisor's existing authenticated workflow-job handler. It MUST NOT
request a URL supplied by `Link`, expose the Gitea credential to the supervisor,
or exceed 100 pages. Malformed, inconsistent, unbounded, or incomplete
pagination and any replay failure MUST fail reconciliation and retain the
runner in `error`; only complete reconciliation may publish `ready`.

**CI-QEMU-IMAGE-LAYERS-001:** QEMU runner reconciliation MUST use a host-scoped,
immutable common base keyed by the pinned cloud image, DIM provisioning,
required toolchain, and runner inputs. DIM MAY reuse that common base across
Projects. It MUST contain no Project hook output, token, runner identity, or
job data. QEMU admission MUST require the root repository's provider
protection to be applied, resolve the configured root or symbolic `HEAD` once
to one concrete branch covered by that protection, and pin its exact commit.
A Project-specific cache layer MUST be isolated per Project and keyed by the
resolved `{sourceRef, sourceCommit, kind, digest}` provenance. A present hook's
digest covers the exact `.dim/ci/qemu-cache.bash` blob bytes from that commit.
An absent hook MUST publish and hash the exact deterministic no-op executable
that Packer consumes; an empty-byte sentinel is not its identity. DIM executes a present hook as
root inside the Packer guest, never on the DIM host, with a fixed cache
directory as its first argument and no host runtime socket or coordinator
credential. Both layers require locked, atomic publication. Removing the final
QEMU capacity for a Project MUST remove that Project-specific cache layer, but
MUST NOT remove a reusable common base. Every job MUST use a fresh disposable
overlay above the Project-specific cache layer.

The common-base key MUST cover the guest and QEMU architecture, the exact
dated Ubuntu cloud-image URL and digest, the signed checksum and detached
signature URLs and exact digests, the exact trusted cloud-image keyring digest
and accepted signing fingerprints, and the supervisor builder image digest.
It MUST cover the one timestamped official Ubuntu snapshot URI, complete
Deb822 source bytes, suites, components, signature-key path, and every exact
top-level `package=version` specification requested for both supervisor and
guest provisioning. It MUST also cover every downloaded executable's exact URL
and digest, including Packer, its QEMU plugin, and the coordinator runner, plus
the exact generated image-preparation, artifact-verification, provisioning,
and Packer-template bytes. A version label or package name without the
corresponding immutable repository or artifact input is not sufficient
identity. The common build MUST retain APT signature verification and MUST
reject mutable cloud-image release aliases or floating Ubuntu archives.

Ubuntu documents snapshot availability for dates at least two years in the
past, not permanent retention. Deployments that require rebuilds beyond that
window MUST preserve the dated cloud image, signed checksum metadata, trusted
keyring, snapshot repository metadata, and referenced package artifacts in a
reviewed local or internal immutable cache before depending on long-term
reconstruction. DIM's retained common qcow2 cache is useful build output but
does not replace preservation of those source inputs.

**CI-QEMU-RESOURCE-OWNERSHIP-001:** Every DIM-managed QEMU data, dispatch,
Project-cache, and common-cache volume MUST carry and match its complete DIM
owner, scope, resource-kind, and deterministic identity-digest label set before
DIM reuses or deletes it. Each QEMU supervisor container MUST carry and match
the complete `dim.managed=true`,
`dim.owner=dim`, `dim.project`, `dim.project-id`, `dim.capacity`,
`dim.executor`, `dim.resource`, `dim.kind`, and `dim.digest` label set. Those
values identify the DIM owner, Project name and ID, capacity, executor,
resource kind, Docker kind, and deterministic identity digest. Any same-name
resource with absent, partial, malformed, foreign, or mismatched
labels MUST be treated as a conflict and MUST NOT be adopted, relabeled, or
modified. Container start, stop, removal, QEMU reconstruction, and host resume
MUST inspect all nine labels and act only on the exact container ID returned by
that successful inspection. They MUST NOT fall back to acting on a container
name. An absent container is a successful no-op for stop. QEMU reconstruction
MUST complete ownership inspection before any coordinator registration,
authorization, or webhook mutation. Runner stop MUST acquire the Project lock
and then the Project-scoped CI-runner lock before inspection or mutation. Every
generated CI resource name MUST be at most 63 characters and
MUST carry a collision-resistant digest of all length-framed identity inputs,
whether or not the readable portion requires shortening. Container deletion
MUST remove the exact container ID returned by the successful ownership
inspection, never the unchecked deterministic name. Capacity deletion MUST
complete all provider, container, volume, and Project-image-state cleanup
before removing runner state. Already-absent resources are retryable success,
while any other cleanup failure MUST retain
runner state. Removing a non-final capacity MUST retain Project dispatch and
cache resources; removing the final capacity MUST remove them while preserving
the host-common cache.

QEMU reconciliation that takes multiple lifecycle locks MUST acquire the
Project lock, then the Project-scoped CI-runner lock, then the Project-hook
publication lock. It MUST publish the exact executable and provenance before
releasing the Project lock. Supervisor-image construction and every Packer or
QEMU image operation MUST occur after the Project lock is released. Branch
movement after admission MUST NOT change or mix the selected commit's hook or
runner configuration, provenance, image identity, or persisted runner state.
CI runner state schema `8` records QEMU runner-configuration and hook
provenance. Persisted Sysbox runner state is unsupported.

The host plugin-selected APT cache is required for workspace package reuse.
It is distinct from the Docker registry pull-through cache and neither cache
replaces the immutable QEMU common or Project image layers. QEMU common-image
identity continues to cover the immutable upstream snapshot and exact package
versions; cache storage is transport reuse, not source identity.

**CI-JOB-IMAGE-001:** Runner admission MUST require the protected Project root
to provide `.dim/ci/runner.yml`. Schema version `1` has exactly `ordinary` and
`integration` workloads. Each workload has required `labels`, `image`, `tools`,
and `capabilities`; unknown keys, duplicate labels or tools, unsafe names, and
mutable image tags MUST be rejected. Images MUST be pinned by a complete
`sha256` digest. The finite capability vocabulary currently contains only
`nested-docker`, and the integration workload MUST request it.

DIM MUST resolve one protected branch and exact commit and read the runner
config and optional QEMU cache hook from that one immutable snapshot. Ordinary
CI binds `{sourceRef, sourceCommit, configDigest}` to its admission without a
Project runner record; QEMU persists that provenance in its runner state. The
ordinary scheduler maps ordinary labels to the admitted disposable image. A
QEMU executor MUST advertise integration labels plus `dim-qemu`; each maps to
the integration image and receives only the guest-private Docker socket. No Project workload
may use runner host mode.

Before ordinary execution or QEMU provider registration, the responsible host
controller MUST force-pull and probe the selected workload image in a separate
throwaway Sysbox daemon, verify every declared executable, and prove each
requested capability. The ephemeral Sysbox runner host image MUST contain
only act_runner, Bash, the Docker CLI required by the upstream image's daemon
readiness gate, and the nested daemon needed to launch jobs. It MUST NOT contain
Node.js, Git, `just`, `jq`, `socat`, or the `script` PTY helper. Its act_runner
config MUST remain non-privileged, reject arbitrary volume mounts, bind only the
job workspace, and force-pull job images. Project workflows MUST remain confined
to disposable job containers without the host Docker socket or runner host mode.
Each temporary deterministic probe container and socket volume MUST carry the
exact `dim.managed=true`, `dim.owner=dim`, `dim.project`, `dim.project-id`,
`dim.capacity`, `dim.executor`, `dim.resource`, `dim.kind`, and `dim.digest`
label set. Those values MUST identify DIM, the Project name and ID, capacity,
executor, probe resource kind, Docker resource kind, and complete deterministic
identity digest. DIM MUST inspect that exact ownership before reuse or deletion
and after creation. Absence is safe; a partial, malformed, mismatched, or
foreign identity MUST fail admission without modifying the resource. Final
cleanup MUST await removal of every owned probe container before removing its
socket volume. It MUST still attempt ownership-safe cleanup of later resources
after an earlier inspection or removal fails, then report the first failure in
resource-plan order. Container cleanup MUST remove only the immutable ID
returned by successful ownership inspection. Docker exposes no equivalent
immutable volume ID, so volume cleanup necessarily remains name-based and MUST
reinspect complete ownership immediately before removal. Each deterministic
name MUST be re-inspected so cleanup removes only exact owned probe residue.
Refreshing ordinary admission changes no provider registration. Restarting a
QEMU runner replaces its provider registration so that label contract is
reconciled.

When `/dev/kvm` is available to the DIM host, DIM MUST NOT pass it into an
ordinary Sysbox job. A trusted QEMU runc supervisor receives only that device
and boots an isolated QEMU VM, which registers one ephemeral runner after the
guest reports readiness. It copies only the validated `.runner` credential into the guest.
Untrusted workflow code receives nested KVM inside the VM, not the host device
or container engine. The supervisor deletes the per-job run state after the
job and has no waiting VM while idle. Creating this runner fails when host KVM
is unavailable.

The managed Gitea adapter MUST allow webhook delivery only to exact enabled
QEMU supervisor hostnames. It MUST NOT broaden Gitea's webhook allowlist to
arbitrary private-network targets.

Ordinary resources are capped by the explicit CPU, memory-byte, and PID bounds
of the claiming host capacity; there is no Project override or fallback. QEMU
resources resolve from runner overrides, configured user defaults, then the
built-in fallback. `create` with resource flags records a QEMU override and
`restart` preserves it. QEMU requires an integer CPU count and maps CPU
and memory to guest vCPUs and RAM; its supervisor receives the same CPU limit
and guest RAM plus 2 GiB. A process override is rejected for QEMU because the
supervisor's process cgroup is not a guest process limit.

The CI coordinator and execution backend are separate contracts. The initial
coordinator adapter registers against managed Gitea Actions, while lifecycle
state, CLI, cgroup resources, and the container executor use provider-neutral
CI terms. Registration credentials are not persisted in DIM state.

The ordinary executor is an ephemeral Sysbox system container created by the
claiming host controller and removed after one claim. The QEMU executor uses a
pinned persistent supervisor image, a
checksum-verified Ubuntu cloud image, and a pinned Gitea runner binary. After
each fresh guest publishes readiness, the trusted supervisor runs `register
--ephemeral`, validates the resulting temporary `.runner` file, and copies only
that file into the guest. The reusable registration token is unset for guest
transports and QEMU. The guest runs `daemon --once` under a bounded timeout,
then the supervisor tears down the job's overlay, SSH keys, registration file,
and run directory. The supervisor, cache layers, and registry cache are not
per-job state.

## Workspaces

```bash
dim workspace create PROJECT WORKSPACE \
  [--profile PROFILE ...] \
  [--require-capability NAME ...] [--recommend-capability NAME ...] \
  [--kvm | --no-kvm] \
  [--cpus COUNT] [--memory SIZE] [--pids COUNT]

dim workspace list
dim workspace show WORKSPACE
dim workspace image build
dim workspace image status [--json]
dim workspace resources WORKSPACE [--cpus COUNT] [--memory SIZE] [--pids COUNT]
dim workspace exec WORKSPACE -- COMMAND [ARGS...]
dim workspace run WORKSPACE TASK [ARGS...]
dim workspace setup WORKSPACE
dim workspace update WORKSPACE [--profile PROFILE ... | --clear-profiles]
dim workspace start WORKSPACE
dim workspace restart WORKSPACE...
dim workspace stop WORKSPACE
dim workspace discard WORKSPACE --yes [--keep-volume]
```

`create` resolves one concrete branch covered by applied root protection,
publishes its exact commit as a controller-owned immutable full-tree snapshot,
mounts it read-only at `/run/dim/project-root`, mounts persistent Project-owned
data at `/var/lib/dim/workspace-data`, and runs the snapshot's `.dim` setup
contract. DIM does not materialize mutable repository checkouts. Project code
owns repository aliases, refs, checkout paths, and reconciliation policy.
Resource flags are stored in the workspace record. Environment configuration
provides their defaults but does not force one limit set on every workspace.
`resources` requires at least one flag, applies the complete effective limit
set to the existing top-level container with `docker update`, and persists
state only after the runtime accepts the update. Omitted flags retain their
current per-workspace values. Running and stopped containers are supported.

**CLI-WORKSPACE-RESOURCES-READ-001:** The workspace image MUST provide
`dim-workspace-resources show` and `dim-nproc`. Both commands MUST use only
`DIM_AGENT_CONTROLLER_SOCKET` and the bodyless
`GET /api/workspace/resources` route exposed by reviewed proxy policy. The
resource command MUST print one JSON object containing exactly `cpuCount`,
`memory`, and `pidsLimit`; it MUST NOT accept a workspace name or other target
selector. `dim-nproc` MUST print one positive integer equal to
`max(1, floor(cpuCount))`, capped by the caller's visible CPU count. Missing,
invalid, non-finite, or unlimited (`max`) CPU assignments MUST fail explicitly;
the command MUST NOT report visible host CPUs as a workspace assignment when
the assigned quota is unavailable. Neither command may read Docker, cgroup,
workspace state, or a host-admin socket directly.
The resource socket MUST be a reviewed, exact-route proxy backed by the
agent-audience controller grant. It MUST remain separate from any restart proxy
backed by `DIM_CONTROLLER_SOCKET` and the workspace-audience grant.
At creation, DIM records the immutable effective KVM policy. When KVM is
available for the selected backend and neither policy flag is supplied, an
interactive terminal asks whether to grant it and recommends acceptance.
Non-interactive creation retains automatic enablement unless `--no-kvm` is
supplied. `--kvm` requires the device to be available rather than silently
downgrading. The runtime backend is always the Sysbox backend recorded during
installation.
Omitting `--profile` stores an empty profile list and starts ordinary
non-profiled Compose services.

**CLI-WORKSPACE-IMAGE-STATUS-001:** `workspace image status` MUST inspect the
currently configured workspace image and report `ready` or `missing`. A ready
result MUST include the inspected image ID in complete
`sha256:<64 lowercase hexadecimal digits>` form; a missing result has no image
ID. Human output MUST be `Workspace image is ready: ID` when ready and
`Workspace image is missing` when missing. JSON output MUST be
`{"status":"ready","imageId":"ID"}` when ready and `{"status":"missing"}`
when missing.
An inspection failure other than image absence MUST be returned as an error.
This status is derived at request time and MUST remain independent of host or
controller readiness and every workspace lifecycle phase. DIM MUST NOT persist
image readiness. Starting or restarting the controller neither builds the
image nor marks it ready; Project and development scripts retain build
authority.

**CLI-WORKSPACE-IMAGE-IDENTITY-001:** When `DIM_WORKSPACE_IMAGE` is absent, DIM
MUST select `dev-infra-project-workspace:<installed DIM package version>`.
Release packages and their release image MUST use the exact release version.
A local package bundle and its local workspace image MUST use exactly one shared
aggregate local version. That version MUST include the identity of the exact
production source commits and the SHA-256 digest of the reviewed aggregate
dependency lock owned by the root repository. DIM MUST NOT fall back to
`latest`. An explicit `DIM_WORKSPACE_IMAGE` remains authoritative.

**CLI-WORKSPACE-IMAGE-BUILD-001:** `workspace image build` MUST explicitly
build the configured workspace image from trusted assets shipped with the
installed DIM packages. The build context MUST contain the Dockerfile,
entrypoint, Git askpass helper, route relay, cgroup helper, and the complete
exact-version published `@slop-lab/dim-controller-proxy` package. It MUST NOT
depend on a source checkout, `just`, pnpm, a sibling source path, or source
package build order at runtime. The default destination MUST be
`dev-infra-project-workspace:<installed DIM package version>`, including the
complete aggregate identity for local packages. `DIM_WORKSPACE_IMAGE` MAY
override it only with an explicitly tagged destination. An image ID, digest
reference, untagged destination, or `latest` MUST be rejected before Docker is
invoked. The build MUST pass the invoking user's UID and GID, use Buildx with
`--load`, and remain independent of host, controller, and workspace lifecycle
readiness. No lifecycle operation builds the image implicitly, restarts a host
service, or selects a fallback tag.

Running workspaces do not change when Project metadata or the root remote
changes. `start`, `restart`, and `update` each select and stage one approved
root commit before applying that exact commit and its lifecycle snapshot.
`setup` and `discard` reuse the commit already recorded by the workspace.
For a workspace in `setting-up` or `setup-error`, direct `setup` MUST acquire
the Project lock and then the workspace setup lock, revalidate the Project and
workspace identity while both locks are held, and replay Project runtime
manifest publication from the recorded immutable root before Project
setup. It MUST keep the workspace non-ready through setup and MUST NOT fetch or
resolve a mutable lifecycle ref. Only successful setup may publish `ready`.
`restart` selects immutable reviewed root bytes before stopping a running
workspace. Project setup owns any mutable-checkout reconciliation.
When multiple workspaces are supplied, `restart` MUST process them sequentially
in command-line order. It MUST report each completed workspace before starting
the next one and MUST stop at the first failure with that workspace identified;
earlier completed restarts remain complete and later workspaces are not called.
With `--json`, a fully successful invocation MUST emit one array containing the
ordered per-workspace results.

**CLI-WORKSPACE-LIFECYCLE-DOCTOR-001:** When a controller command session for
`workspace create`, `setup`, `update`, `start`, or `restart` fails with a user
error, the CLI MUST preserve the original error and operation context and MUST
append exactly one `Run 'dim doctor' to check host readiness.` recommendation.
The recommendation MUST NOT be added to local option validation or to `run`,
`exec`, `stop`, `discard`, `align`, or `resources` failures. `dim doctor` is a
diagnostic command and MUST NOT be represented as repairing DIM records,
workspace lifecycle state, containers, or Project services.

Top-level `dim run` and
`dim exec` are convenience aliases for `dim workspace run` and `dim workspace
exec`. Other workspace lifecycle commands exist only below `dim workspace`.

`run` dispatches through immutable `.dim/entrypoint.sh` snapshot bytes when
present. `exec` always
bypasses it. `discard` follows `WORKSPACE-DISCARD-VOLUMES-001` for Project
teardown and removal of the top-level container, inner-engine volume, and
workspace state. `--keep-volume` retains the labeled DIM-managed volume;
recreating the same workspace name validates and reuses it.
For probes of `.dim/setup.sh`, `.dim/entrypoint.sh`, `.dim/teardown.sh`, and
`.dim/docker-compose.yml`, only exit code `1` means the file is absent. Any
other probe failure MUST abort the lifecycle or task operation before DIM
dispatches a hook, Compose command, or direct-command fallback.

Commands that permanently delete Projects, repositories, CI runners, or
workspaces accept confirmation from an interactive terminal. In a
non-interactive shell they require the explicit `--yes` option.

`doctor` can diagnose the host without a configured workspace backend.
`doctor configure-backend [BACKEND]` verifies and records a backend without
requiring the controller to be running.

## External URL commands

Host configuration is managed through:

```text
dim external-url dns-provider add DRIVER --name NAME [DRIVER_ARGUMENT...]
dim external-url dns-provider list [--json]
dim external-url dns-provider remove NAME
dim external-url ingress add DRIVER --name NAME --description TEXT
  --scheme SCHEME [DRIVER_ARGUMENT...]
dim external-url ingress list [--json]
dim external-url ingress verify NAME
dim external-url ingress remove NAME [--cleanup-dns]
```

Invalid ingress driver arguments are client errors. The admin API returns HTTP
400, and its message links to the ingress configuration documentation when a
driver-specific JSON object is missing or malformed. An ingress that references
a named infrastructure provider must be rejected unless that provider is
already configured.

Drivers may own host services required by an ingress. Those services are
reconciled by the managed controller after configuration changes and must not
require a separate setup command. Driver-private runtime values must be kept
under DIM state rather than added to the opaque user-supplied argument.
Managed Caddy may additionally reserve explicitly configured exact hostnames
beneath its wildcard domain for static HTTP(S) upstreams. Such routes must be
validated as credential-free origins and take precedence over workspace
routes without granting workspaces authority to create or change them.

Workspace-scoped URL operations are:

```text
dim external-url discover [--workspace WORKSPACE] [--json]
dim external-url request [--workspace WORKSPACE] --ingress NAME
  [--subdomain NAME] [--container NAME ...] --port PORT [--protocol http|https|tcp]
dim external-url list [--workspace WORKSPACE] [--json]
dim external-url revoke URL_ID [--workspace WORKSPACE]
dim external-url approve URL_ID
dim host-input get PROVIDER KEY [--parameters STRING]
```

**CLI-DEVELOPMENT-URL-REQUEST-001:** The workspace image MUST provide
`dim-development-service request-url --ingress NAME --container NAME
[--container NAME] --port PORT` for nested HTTP development services. The
command MUST derive one complete `DIM_CONTROLLER_SOCKET`/`DIM_CONTROLLER_TOKEN`
pair, or one complete agent pair when the workspace pair is absent, and MUST
NOT accept a workspace, socket, API, token, host, domain, subdomain, path,
protocol, approval, or host-administration selector. It MUST send only the
selected ingress and an HTTP target containing one or two non-empty nested
container names plus a valid port. It MUST print the controller's JSON response
so a caller can observe `pending`, `approved`, or `not-required` state. It MUST
NOT print the controller grant. The authenticated controller remains
authoritative for workspace identity, ingress policy, target resolution, and
approval; the helper MUST expose no approval operation.

**CLI-EXTERNAL-URL-APPROVAL-001:** `dim external-url ingress add
--require-approval` MUST configure per-route host approval independently of
driver-private arguments. A valid request on that ingress MUST succeed with a
redacted `pending` route while every HTTP, WebSocket, and TCP data-plane path
denies traffic. `dim external-url approve URL_ID` MUST use only the host-admin
socket. Host invocation of `dim external-url revoke URL_ID` with no workspace
credential MUST also use that socket; workspace, agent, and `--workspace`
invocations remain limited to revoking their own route. Approval MUST enable
only the exact tuple required by `URL-APPROVAL-001`. Revocation MUST be
terminal for that ID, and the observable route state MUST distinguish
`not-required`, `pending`, `approved`, and `revoked`.

**CLI-EXTERNAL-URL-HOST-LIST-001:** On a host with no workspace or agent
controller credential in the environment, `dim external-url list` MUST use the
host-admin socket and return routes for every current workspace. Each route MUST
identify its Project and workspace by name. The complete response MUST be
bounded to 1,000 routes and fail rather than truncate when that bound would be
exceeded. It MUST NOT return controller grants, provider arguments, internal
route claims, or workspace IDs. `--workspace WORKSPACE` MUST retain the
single-workspace controller-grant path. Inside a workspace or agent environment,
omitting `--workspace` MUST retain the authenticated caller's workspace scope.
Workspace and agent grants MUST NOT authorize the host-wide admin action.

Provider and ingress arguments are forwarded as an ordered string array and
interpreted only by the selected plugin driver. The CLI does not encode a
driver-specific JSON schema.
DNS provider plugins register named drivers through the instance-scoped DIM
plugin extension registry. Provider configuration and Caddy's per-record
`dnsArgument` remain opaque strings interpreted only by that driver; the
External URLs plugin must not depend on a provider implementation package.
Drivers return public URLs rather than asking the common controller to derive
domains. The request contains a complete relative subdomain. By default it
must begin `WORKSPACE--`; an omitted value receives the first unused
`WORKSPACE--INDEX` name. An ingress may replace this default with a fail-closed
HTTP(S) or Unix-socket policy webhook. DIM revalidates any webhook replacement
and prevents hostname conflicts. The authoritative workspace-discard operation
MUST invoke registered plugin cleanup before removing workspace runtime and
state, and MUST NOT depend on the workspace controller grant still existing.
Library-level discard callers that omit plugin hooks do not receive this
plugin-cleanup guarantee.

**CLI-EXTERNAL-URL-TCP-001:** A raw TCP ingress MUST accept only a target with
protocol `tcp`, MUST reject a URL path or subdomain, and MUST resolve its
upstream through the authenticated workspace target resolver rather than a
caller-supplied host. One listener MUST have at most one workspace and exact
target claim; an identical claim is idempotent, while a different claim is
rejected until revocation. An identical replay MUST return the existing route
identity without acquiring, persisting, or revoking another claim. Claims MUST
persist and reconcile after controller restart and MUST be revoked on
authoritative workspace discard. Reconciliation MAY replace a resolved
upstream only for the same workspace and exact logical target when its runtime
generation changes, including a replaced nested leaf behind an unchanged relay;
it MUST destroy every active old flow before the replacement becomes current.
A different claim MUST remain rejected. Revocation, listener shutdown, client
end, upstream end, and either-side failure MUST release both socket directions.
Each listener MUST allow at most 256 concurrent flows, bound upstream connect
waits to 10 seconds, and terminate flows after five idle minutes. Returned
endpoints use `tcp://HOST:PORT`.

Removing any ingress MUST close its live listener, terminate active flows, and
remove every persisted route and claim for that ingress before deleting its
configuration. Re-adding the same ingress name MUST NOT restore those removed
routes or claims.

**CLI-EXTERNAL-URL-TAILSCALE-001:** The optional `tailscale` ingress driver MUST
require scheme `tcp` and exactly one configured listener port in
`49152..65535`. It MUST derive both advertised and listen hosts from a running
host Tailscale self IPv4 address in `100.64.0.0/10`, using only `tailscale
status --json`, and MUST bind that exact address. It MUST NOT authenticate or
mutate Tailscale, bind a wildcard or arbitrary host address, depend on Serve or
Funnel, make Tailscale a core dependency, or expose the host LocalAPI socket,
state, binary, or credentials to a workspace or target container.

Inside a workspace the controller endpoint and grant come from
`DIM_CONTROLLER_SOCKET` and `DIM_CONTROLLER_TOKEN`. On the host, `--workspace`
loads that workspace's stored grant and uses DIM's managed controller socket;
without `--workspace`, `list` uses the host-admin inventory described above.

## Git integration

```bash
dim x git ARGS...
dim git setup
```

Runs the local Git CLI with a host-only managed maintainer credential supplied
through environment and a one-command credential helper. The admin API returns
the provider-neutral `username` and `password` credential shape; it does not
expose the workspace writer or provider-administrator credential. The command
does not put credentials in argv or repository URLs. Existing Git credential
helpers and SSH agents remain valid alternatives. The maintainer may submit the
checked protected-ref compare-and-swap operation through the provider's
explicit push allowlist. It MUST NOT expose a direct review-bypass push path;
`TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001` remain mandatory.
Force-push policy is unchanged.

`git setup` installs a URL-scoped, path-aware global Git credential helper for
ordinary host-side Git commands. The requested URL path remains available for
future Project-aware gateway routing. Credential retrieval also reconciles
the host maintainer's repository access and existing protected-ref allowlists.

## Diagnostics and administration

```bash
dim doctor
dim host status [--json]
dim host shutdown
dim host start
dim plugin list
dim admin service ensure
dim admin service credentials --show-secrets
```

Administrative commands are omitted from the default root help.

`dim host shutdown` MUST atomically record the workspaces and CI runners that
were ready and every other running `dim.managed=true` host container. It then
stops execution runtimes, other managed services, the registry cache, and
managed Gitea. It MUST NOT remove containers, volumes, repositories, or state.
The controller remains live but reports the host as not ready. Shutdown MUST
acquire host lifecycle admission before capturing those targets, so its
snapshot and drain begin only after every previously admitted ordinary
host-admin operation completes.

`dim host start` MUST restore Gitea and the registry cache first, then process
the recorded recovery targets in order. A partial failure MUST retain all
still-pending restart intent so another
`host start` invocation can repeat recovery. Host lifecycle state uses only
schema version `2`; `restartCiRunners` is the durable authority to recover CI
runners. Managed-controller startup MUST migrate only an exact schema-`1` host
record by changing `schemaVersion` to `2` and renaming `resumeCiRunners` to
`restartCiRunners`; every other field and value is preserved. A runner
that is ready but absent from `restartCiRunners` MUST remain untouched. A
workspace already in `ready` MUST not be cycled on retry. A `stopped` workspace
MUST use ordinary start, while
`setting-up`, `setup-error`, and `error` MUST replay setup from its recorded
immutable repository selection. A workspace still in `creating` MUST fail
closed without start or setup dispatch.

A schema-`2` host record MUST have exactly `schemaVersion`, `phase`,
`resumeWorkspaces`, `restartCiRunners`, `resumeManagedContainers`, and
`updatedAt`, plus optional `error`. Its phase MUST be `ready`, `stopping`,
`stopped`, `starting`, or `error`; both resume lists contain only valid names,
and each runner target contains exactly valid `project` and `name` strings.
Malformed, missing, mistyped, or unknown structure MUST be rejected without
mutating the record or dispatching recovery.

The startup-only migration MUST run immediately after controller PID ownership
is claimed and before plugin loading, route initialization, or listener setup.
It owns one host lifecycle lock acquisition and rereads under that lock. It
keeps byte-exact schema-`1` bytes permanently in mode-`0600`
`host.json.schema-1.bak`, publishes that backup without replacement, and uses
synced exclusive same-directory temporaries plus atomic canonical rename and
directory sync. It deterministically completes or recovers the valid
schema-1/no-backup, schema-1/matching-backup, schema-2/no-backup,
schema-2/valid-historical-backup, and missing-canonical/valid-backup states. A
valid schema-`2` canonical record is authoritative and is not compared with the
historical backup after normal lifecycle changes. Symlinks, non-regular
artifacts, malformed or extra-key state, an existing backup that differs from a
canonical schema-`1` record, and all other schemas fail closed without canonical
mutation. Operator output is emitted only for completed migration or recovery;
failure names the migration startup stage. Normal reads accept only schema `2`,
and no other state family is migrated.

CI recovery behavior is fixed by the host phase at invocation entry. For an
entry phase of `ready`, host start MUST return without recovery dispatch. For
an entry phase of `stopped`, `starting`, or `error`, a target already in
`ready` MUST remain untouched, a `stopped` target MUST use ordinary start, and
a `creating` or `error` target MUST first normalize through ownership-safe
stop and then start. For an entry phase of `stopping`, DIM MUST also apply that
stop/start normalization to a nominally `ready` target because shutdown may
have been interrupted; the other runner phases keep the same behavior. All
runner inspection and mutation MUST follow
`CI-QEMU-RESOURCE-OWNERSHIP-001`, including acting only on the inspected
container ID. The host returns to `ready`, and clears every recovery list, only
after every target succeeds. Until then it remains retryable and blocks other
ordinary administration. Recovery work performed by `host start`, including
workspace start and immutable setup replay, runs inside that maintenance
operation rather than attempting a second ordinary host admission.

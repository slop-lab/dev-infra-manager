# Managed CI runners

The current release uses the Gitea Project-scoped runner profile documented
below. Both ordinary Sysbox and QEMU integration runners are persistent
Project-scoped lifecycle records, while each job runs in a disposable job
container or VM. The specified native ordinary-CI replacement is a separate,
unimplemented target later in this page.

Current commands include both executors:

```bash
dim ci runner create example primary sysbox
dim ci runner create example release qemu
dim ci runner status example primary
dim ci runner status example release
```

The target will reject `dim ci runner create ... sysbox` after its native
Project adapter and host-controller capacity path are implemented. That
rejection is not current behavior.

## Predecessor Gitea runner profile

The following Gitea runner details describe the currently implemented
predecessor release and its migration evidence. They are not the target native
control-plane contract, do not become a fallback after future native selection, and
must not be used to infer persistent ordinary runner support in the target.

The initial Gitea coordinator registers it at the Project's managed
organization. Every root or non-root repository registered to that Project can
therefore select the same runner. Runner admission requires the protected root
repository to provide `.dim/ci/runner.yml`:

```yaml
schemaVersion: 1
workloads:
  ordinary:
    labels: [dim]
    image: registry.example/ci@sha256:<64 lowercase hexadecimal digits>
    tools: [bash, git, node]
    capabilities: []
  integration:
    labels: [dim-container-integration]
    image: registry.example/ci-integration@sha256:<64 lowercase hexadecimal digits>
    tools: [bash, docker, git, node]
    capabilities: [nested-docker]
```

The schema is strict: both workload classes and every field are required,
unknown keys and duplicate labels or tools are rejected, images must use an
immutable `sha256` digest without a tag, and the only current capability is
`nested-docker`. Integration must request that capability. DIM resolves the
configured root or symbolic `HEAD` once to one protected branch and exact
commit, reads both this file and the optional QEMU cache hook from that one
immutable snapshot, and persists `{sourceRef, sourceCommit, configDigest}` in
runner state. A branch moving after admission cannot mix either input with a
different commit.

Workflows select it with the stable DIM label:

```yaml
jobs:
  verify:
    runs-on: dim
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm workspace:check
      - run: pnpm workspace:test
```

Every Project label maps to its workload's configured digest-pinned disposable
job image. Persistent Sysbox runners advertise only ordinary labels, configure
`docker_host: '-'`, and expose no job Docker host. QEMU runners advertise the
integration labels plus DIM's `dim-qemu` label. Those labels map to the
integration image, whose job receives only the private Docker socket inside
its fresh guest. No Project workload uses Gitea runner host mode. DIM first
force-pulls and probes both images in a separate throwaway Sysbox daemon,
checks every declared executable, and proves the integration image can use
nested Docker. Registration happens only after those probes succeed.
The daemon's temporary deterministic container and socket volume carry the
exact `dim.managed=true`, `dim.owner=dim`, `dim.project`, `dim.project-id`,
`dim.capacity`, `dim.executor`, `dim.resource`, `dim.kind`, and `dim.digest`
labels. Together they identify DIM, the Project name and ID, capacity,
executor, probe resource kind, Docker resource kind, and full deterministic
digest. DIM inspects the complete identity before reuse or deletion and after
creation. An absent name is safe. A partial, malformed, mismatched, or foreign
identity stops admission without touching that resource. Final cleanup
re-inspects both names and removes only exact owned probe residue. Container
cleanup uses the immutable ID returned by inspection. Docker volumes have no
equivalent immutable ID, so socket-volume deletion remains name-based and is
preceded by an immediate ownership reinspection. Container removal finishes
before socket-volume removal so Docker has detached the volume. A partial
cleanup failure does not skip ownership-safe attempts for the remaining
resources.

The managed Sysbox runner host image includes only act-runner, Bash, the Docker
CLI required by the upstream image's daemon readiness gate, and the nested
Docker daemon needed to launch disposable jobs. It contains no Node.js, Git,
`just`, `jq`, `socat`, or PTY helper for Project workflows. Project workflows
still run only in disposable job containers and receive neither the host Docker
socket nor runner host mode. Its act_runner configuration remains
non-privileged, rejects arbitrary volume mounts, binds only the job workspace,
and force-pulls job images. `just verify sysbox-ci-runner-image` builds and
probes the same generated image without installing DIM on the host. After
changing `.dim/ci/runner.yml`, run `dim ci runner restart PROJECT RUNNER` to
admit the new protected snapshot and replace the provider registration.

DIM starts one host-scoped CNCF Distribution registry as an anonymous Docker
Hub pull-through cache when the first managed CI runner is reconciled. Managed
workspace and Sysbox runner daemons discover it directly as
`dim-registry-cache:5000` on the private `dim-control` network. A
workspace-local relay carries nested agent DinD traffic. Each persistent QEMU
supervisor owns a launcher-local TCP relay to its disposable guest, whose
Docker daemon uses the relay at `10.0.2.2` on a worker-specific port. Both
relays target the stable cache alias so cache-container address replacement
does not stale their route.
The supervisor verifies its relay before booting a guest; an
unavailable cache is reported as a runner error instead of silently sending
the guest directly to Docker Hub. The registry has no published host
port, accepts no pushes in proxy mode, stores no Docker Hub credentials, and
is not attached to Project workspace networks. Its managed filesystem volume
is shared across Projects and runner executors, so common public layers survive
runner and VM disposal. A cache miss still reaches Docker Hub and remains
subject to its upstream policy. Project workflow images must be digest-pinned.

Verification records separate evidence for each route. A cold pull must reach
the cache and request its upstream artifacts. A warm pull must reach the cache
without another upstream artifact request. A replacement pull must follow the
stable alias after the cache address changes, and an outage pull must fail
without direct upstream bypass. A configured endpoint is not enough evidence.
Packet capture and general network monitoring are not required.

Run `just verify cache-routing-sysbox` directly on a real Sysbox-capable Docker
host. Its preflight treats a missing Sysbox or Docker capability as an unmet
prerequisite, not a pass. This recipe is not scheduled on the QEMU-backed
`dim-container-integration` hosted lane. The hosted integration lane exercises
its QEMU guest routes separately.

After upgrading an existing installation to a DIM version that introduces or
changes this cache configuration, run `dim ci runner restart PROJECT RUNNER`
once for each existing Sysbox runner. QEMU supervisor image-version changes are
reconciled automatically, but an explicit restart is also safe when immediate
replacement is preferred.

## Native ordinary CI target

This target is specified but not implemented. The installer bundle alone has
no native Project/repository state adapter, so it starts empty and denies
Project admission, capacity advertisement, webhook demand, claims, attempts,
and results before mutation.

After that separate adapter is approved, the installer-owned ordinary service
has one stable service identity but no Project list, common image, Gitea
credential, runner-registration authority, or runtime socket in its private
deployment config. A trusted host controller derives admission from one exact
protected native Git snapshot. Admission binds the Project/repository,
protected ref, commit/tree, policy and job-set revisions, required jobs, config
digest, ordinary labels, and complete image digest. The admitted image is
pulled for a claim and discarded with job state; it is not a persistent Project
image.

Admissions are renewable leases with fresh public generations. An active
identical-policy refresh retains its generation. Expiry, revocation, or changed
policy creates a new generation, even if a later policy has identical bytes.
Old queued jobs and claims remain durable but cannot dispatch, renew, or requeue
under the replacement. Authenticated native Git webhooks create demand only
when their complete candidate/job tuple matches a live admission. Before
dispatch the scheduler durably issues the exact current attempt identity used
as native promotion evidence.

Each host controller authenticates separately, advertises only operator-owned
capacity names and bounds, and may execute a claim without a local Project
record. The claim has no reusable Git, webhook, admission, host, scheduler, or
result credential. The host uses Sysbox and its managed cache, applies CPU,
memory, and PID limits, mounts no host Docker socket or `/dev/kvm`, and removes
the ephemeral runner and credential material after exact terminal evidence is
recorded. Lease uncertainty stops and reaps the job before release; expired
claims fence only that host capacity until ownership-safe cleanup.

The target facade will deploy this service beside native Git through `dim
installer install control-plane --config FILE`. In that target, old `dim ci
ordinary-pool ...` commands, `DIM_ORDINARY_CI_POOL_CONNECTION_FILE`, schema-2
databases, and persistent Project Sysbox runner records are rejected, not
migrated. See the exact
[installer contract](../specs/14-installer-facade.md#control-plane-bundle) and
[paired operations design](../../core-development/ordinary-ci-pool.md).

As described in the
[development repository model](development-repositories.md), DIM develops
itself through 11 GitLab development upstreams and its DIM-managed internal
review host, while GitHub remains the integrated canonical public source. The
current automatic workflows are provider-specific:
`.gitea/workflows/ci.yml` uses the Project-owned integration label for the
container gate in a fresh QEMU guest. Persistent Sysbox runners serve only
ordinary labels. The QEMU gate covers the canonical self-Project's private
nested runtime on a compatible clean host. `.github/workflows/ci.yml`
intentionally runs only lightweight Node.js type checks and tests without APT
or Docker setup. GitHub-only manual Sysbox and KVM release workflows remain
under `.github/workflows` and are not copied into the managed development Gitea
instance.

In the current Gitea-only profile, when explicitly created on a host with KVM, DIM starts a small persistent,
trusted runc supervisor with `/dev/kvm`. A Gitea `workflow_job` webhook asks it
to boot a QEMU VM only after a queued job selects an integration label or
`dim-qemu`. Workflow code
runs inside that VM and sees its nested
KVM device; it never runs in the supervisor or receives the DIM host's device
directly. Each registration accepts one job. While idle, no guest exists; only
the persistent supervisor remains.
The container limit still leaves room for its QEMU child while a job runs.
Gitea registration is
only the current coordinator adapter, so replacing the built-in coordinator
does not change this executor boundary.

By default, QEMU supervisors on one host form a Project scheduler, with one
concurrent capacity per named runner. They persist demand and renewable claims
in a host-local dispatch volume before acknowledging webhooks. Each update
fsyncs its temporary state file, atomically replaces the durable file, and
fsyncs the containing directory before HTTP `202`; a load, validation, or
write error fails the acknowledgement. Duplicate deliveries remain idempotent,
and each trigger has at most one active capacity claim.

For capacity spanning hosts, an operator may deploy the packaged standalone
scheduler and configure each host with
`DIM_QEMU_SCHEDULER_CONNECTION_FILE`. The service stores Project demand,
completed tombstones, idempotency records, and fenced renewable leases in
SQLite with WAL and full synchronization. Its API accepts only workflow-job
events and claim, renewal, and release operations. Separate Project API and
webhook bearer tokens separate host operations from event integrity; stable
host IDs provide concurrency identity rather than authorization. The service
receives no Gitea administrator credential. Each host still owns execution:
after uncertain renewal it terminates and reaps its local process group before
claiming again. Scheduler tokens are removed from the child environment and
never reach a guest.

Production leases are at least 60 seconds. Workers use two-second requests,
five-second heartbeats, and a local monotonic deadline. The service delays
takeover for at least 20 seconds after expiry and places outstanding queued
claims on a recovery hold after restart, allowing a paused host time to stop
its process group. This is bounded cooperative fencing, not an external kill
switch: a host paused beyond both lease and grace, partitioned from the
scheduler, or compromised outside DIM can continue executing until its local
supervisor runs cleanup. Use infrastructure-level fencing when that stronger
guarantee is required.

Every host for one Project presents the same Project API credential and its
own stable host ID; that ID must also be the host ID in the external Gitea
connection. Creating, starting, or restarting a capacity fails before runtime
mutation when persisted local/shared mode, Project ID, or host ID differs from
the current connection.

Build the pinned service image from installed assets with `dim ci scheduler
image build IMAGE`. Mount a service-user-owned mode-`0600` config and a durable
database directory. The operator owns TLS or isolated-network transport and
service lifecycle. Stopping or deleting one host's capacity does not remove the
central webhook while another host may serve it. Shared mode requires external
Gitea and rejects a Project that mixes host-local and shared scheduler state.
The service config names the Project integration labels used to select demand.
The shared Project API credential can seed only queued matching demand; running
and completed transitions require the webhook credential.
Creating, starting, or restarting capacity does not rely on future webhook
redelivery to discover existing demand. After launching the supervisor, DIM
inspects its complete ownership identity, addresses the resulting immutable
container ID, and waits for its authorization-protected loopback health
endpoint, which becomes ready only after the worker completes an authenticated
claim exchange with the shared service. DIM installs the `workflow_job` hook before listing queued
organization jobs, traverses that API with bounded pagination, strictly parses
positive job IDs, string labels, and queued status, deduplicates IDs, and
replays normalized queued events through the same authenticated webhook
handler. Only then may the capacity become `ready`. Hook installation, listing,
or replay failure leaves admission failed rather than publishing partial
capacity. This is one host-driven reconciliation pass, not a polling scheduler;
the existing shared claims, label matching, event precedence, and completed
tombstones govern replay exactly as they govern live delivery.

Persistent admission is capped per Project at 10,000 combined queued and
running jobs, 10,000 completed tombstones, and 100,000 claim request receipts.
The service returns HTTP `503` rather than evicting nonterminal demand, claims,
or live request fences. Completed events free nonterminal slots; completed
tombstones and released receipts are retained for up to seven days, after which
normal traffic prunes them. Operators recover nonterminal saturation by
restoring terminal webhook delivery, and receipt saturation by allowing the
retention window to expire. A receipt remains while its claim is live even
after the ordinary retention deadline.

Coordinator credentials remain in the DIM host process that installs the hook
and lists jobs. Neither the supervisor nor its guest receives them. Supervisor
health and replay use only the per-launch webhook authorization, passed to
`curl` as direct Docker-exec arguments without a shell.

For each job ID, scheduler state only advances from `queued` to `in_progress`
to `completed`, even when Gitea deliveries are duplicated or reordered. The
scheduler retains the first completed timestamp for seven days, rejects stale
queued or in-progress deliveries during that window, then prunes the terminal
marker to bound persistent state. This retention cleanup is separate from the
renewable lease expiry that lets another capacity recover an abandoned queued
claim. The claimed job ID is only a durable demand trigger. It does not identify
the job that Gitea assigns to the generic ephemeral runner, so two capacities
may receive assignments in an order different from their triggers. A VM exit
does not itself consume queued demand:
the scheduler waits for Gitea to report that a job started or completed, and
starts another disposable VM with bounded retry delay while demand remains.
Each capacity runs at most one VM. Once started, that VM keeps running if its
trigger completes or its claim disappears or moves to another capacity;
renewal of that trigger claim stops. Shutdown and scheduler state-I/O failures
still terminate and reap the supervisor process group, and normal supervisor
cleanup still removes per-run process state. Persisted queued demand resumes
after a supervisor restart, so webhook redelivery is not required. An
unsuccessful supervisor is terminated and reaped, its claim is released, and
the worker waits with shutdown-interruptible exponential backoff capped at 30
seconds before requesting fresh work.

The first matching QEMU job builds or reuses two immutable Packer layers. A
host-scoped common base is keyed by the pinned Ubuntu cloud image, DIM
provisioning, required tools, and coordinator runner inputs, so Projects may
share it safely. It contains no Project hook output, token, runner identity, or
job data. Above it, DIM builds a Project-specific cache layer, isolated per
Project and keyed by hook provenance. DIM first requires applied provider
protection, resolves the configured root or symbolic `HEAD` once to a concrete
covered branch and commit, and reads `.dim/ci/qemu-cache.bash` only from that
commit's immutable snapshot. The provenance records the resolved source ref,
source commit, presence kind, and exact executable digest. If the hook is
absent, DIM stages a deterministic non-empty no-op executable and hashes the
same bytes that Packer consumes. Trusted Packer provisioning runs the staged executable inside the
guest with the cache directory as its only argument. Locks serialize each
build, and publication is atomic. Workflow changes can modify only a fresh
disposable qcow2 overlay above the Project-specific cache layer. After the
guest reports readiness, the trusted supervisor runs `register --ephemeral`,
validates the temporary mode-`0600` `.runner`, and copies only that file into
the guest. The reusable registration token is unset for guest transports and
QEMU. The guest runs `daemon --once` under a bounded timeout. Teardown removes
the job's overlay, SSH keys, `.runner`, and run directory, while the supervisor
and cache layers persist. Deleting the final QEMU capacity
removes shared dispatch state and that Project-specific cache layer, while reusable
common bases remain host-scoped. Changed pinned inputs select new keys instead
of mutating layers in use.

The common base uses one dated Ubuntu 24.04 cloud-image release. Before Packer
uses the checksum-pinned image, DIM verifies the exact `SHA256SUMS` and
`SHA256SUMS.gpg` bytes with the digest-pinned Ubuntu cloud-image keyring and an
accepted official signing fingerprint. Supervisor and guest APT use one
timestamped `snapshot.ubuntu.com` Deb822 source for `noble`, `noble-updates`,
and `noble-security`, with `main` and `universe` and normal Ubuntu signature
verification. Every directly requested package is pinned as
`package=version`; the initial digest-pinned supervisor image plus immutable
snapshot also fixes dependency resolution. Packer, its QEMU plugin, the Gitea
runner, generated scripts, and both Packer templates are exact identity inputs,
so changing executable build input selects a new common key.

Ubuntu states that archive snapshots are intended to remain available for at
least two years, not forever. Operators needing later reconstruction must copy
the dated cloud image, signed checksum files, trusted keyring, snapshot
metadata, and package artifacts into a reviewed local or internal immutable
cache while they remain available. Retaining DIM's common qcow2 alone preserves
the built output, not all source provenance needed to rebuild it.

DIM inspects the complete owner, scope, resource kind, and identity digest
labels before reusing or deleting any QEMU CI volume. Each QEMU supervisor
container also carries the complete DIM owner, Project name and ID,
capacity, executor, resource kind, Docker kind, and identity digest labels. A
same-name foreign, malformed, or partially labeled resource is a conflict,
never an adoption target. Every generated CI resource name includes a digest
of all length-framed identity inputs, even when the readable name is already
short, and remains within the 63-character bound. Start, stop, removal, QEMU
reconstruction, and host resume inspect all nine container labels and act only
on the inspected container ID, never the name. Foreign, malformed, and
partially labeled resources remain untouched. Stopping an already absent
container succeeds. QEMU reconstruction checks ownership before
changing coordinator registration, authorization, or webhook state. Container
cleanup removes the inspected container ID rather than trusting the name after
inspection.
Deletion removes provider and Docker resources before lifecycle state, so a
failed or partially completed cleanup remains safe to retry. Only the final
capacity removes its Project dispatch, cache volume, and local image state;
the host-common cache remains intentional shared state.

Admission acquires lifecycle locks in Project, CI-runner, then hook-publication
order and stages the immutable executable and provenance before releasing the
Project lock. Supervisor-image construction and Packer/QEMU image work happen
after that release. A protected branch moving later therefore cannot mix a new
hook or runner configuration with the admitted commit. Runner state schema 8
retains config provenance for both executors and exact hook provenance for QEMU.

The cache hook is optional and belongs in the protected root because it is the
only Project code allowed to populate persistent runner state. Test orchestration
and artifact-specific verification should remain in ordinary development
repositories. The hook runs inside the disposable Packer guest, receives no
host socket or coordinator credential, and cannot access another Project's
cache volume.

The enabled host mirror plugin owns the exact digest-pinned APT cache image used
for workspace package reuse. This cache does not change QEMU source identity:
QEMU cache reuse continues to come from the common base and Project-specific
image layers, whose keys cover the immutable Ubuntu snapshot and exact package
versions. Project runner configuration cannot select host mirror packages or
versions.

Creating a QEMU runner adds only its managed supervisor hostname to Gitea's
webhook allowlist and restarts the managed Gitea service to apply that setting.
DIM does not enable unrestricted private-network webhook delivery.

The DIM repository selects integration labels or `dim-qemu` for automatic
host-backend verification on non-draft pull requests in its managed
development host. Draft pull requests and branch pushes skip the expensive
gate. One job installs and verifies Sysbox in a clean QEMU guest. Named host
capacities claim these common jobs without appearing in the workflow. After
installing a DIM
version that adds or changes runner labels, restart the runner once:

```bash
dim ci runner restart dim release
dim ci runner create dim release-1 qemu
dim ci runner create dim release-2 qemu
dim ci runner status dim release-1
```

Restart every existing QEMU runner after this scheduler upgrade before adding
another capacity. DIM rejects a mixed old/private and new/shared scheduler
topology because both could otherwise react to the same capability event.

Each status must include a ready QEMU `executor` record with the Project's
integration labels, `dim-qemu`, and a distinct supervisor name. Workflows may
select an integration label or `runs-on: dim-qemu`; capacity names are host
lifecycle configuration and do not belong in tracked Project code. Creation
detects host KVM, while successful VM readiness also
requires nested virtualization from the host KVM module. Use `dim ci runner
logs dim release` when diagnosing VM boot,
registration, or replacement.

An individual VM boot, provisioning, registration, or job failure is scoped
to one capacity attempt. The webhook service logs the trigger job ID and
supervisor exit status, releases or retains demand according to coordinator
state, and continues processing later queued triggers. The logged trigger ID
must not be read as the actual consumed job ID. Repeated webhook responses
without a corresponding
`qemu-ci: start disposable runner VM` line indicate that the event did not
select `dim-qemu`; a previous supervisor failure must not disable demand
processing.

Each ordinary claim has concurrency one. Its ephemeral Sysbox runner, nested
daemon, disposable job container, temporary registration data, and resource
limits live outside workspace and Project runner state. It does not mount the
host Docker socket or receive DIM workspace credentials. The host controller
uses its reviewed Sysbox runtime; there is no Project runtime override.

## Resources

Future native ordinary capacity bounds are explicit positive CPU, memory-byte,
and PID values in each host's target connection file. Projects and claims
cannot widen them after the adapter exists. Current named Gitea runners retain
their documented resource defaults and overrides; a named QEMU capacity may
set its own CPU and memory:

```bash
dim ci runner create example release qemu --cpus 6 --memory 12GiB
```

`restart` preserves an existing QEMU runner override. Delete and create the
QEMU runner again without flags to return to inherited defaults.

For QEMU, `--cpus` must be an integer and maps to guest vCPUs; `--memory` maps
to guest memory. The supervisor container receives the same CPU limit, the
guest memory plus 2 GiB of overhead, and a fixed 1024-process boundary. A
QEMU does not accept a process override because the supervisor's host cgroup
does not define the guest's process policy. These are limits, not
reservations; while idle there is no VM or guest memory. Each job uses a
disposable 64 GiB overlay.

The QEMU host-install smoke verifies the Sysbox limits in a clean
Ubuntu guest rather than relying on a development workspace's delegated
cgroup hierarchy.

## Lifecycle

```bash
dim ci runner list
dim ci runner logs example release
dim ci runner start example release
dim ci runner stop example release
dim ci runner restart example release
dim ci runner delete example release --yes
```

In the target native topology these commands address Gitea-only QEMU integration
runners and cannot be used while native selection is requested. In the current
release the same lifecycle also addresses Project-scoped Sysbox runners.
`create` requires a new
Project/runner identity. `start` requires a stopped runner and preserves its
schema-8 config and hook
artifact and provenance, supervisor image, job image, labels, effective
resources, and inheritance choice. It restores runtime volumes and cache, then
replaces only the provider registration, webhook authorization, webhook, and
supervisor container because `stop` removed the live credential and webhook.
`restart` instead re-admits the current protected root and refreshes derived
config, hook, images, labels, and inherited resources while preserving the
executor kind and explicit resource override. `delete` permanently removes its
provider registration, container, volume, and state.

`stop` holds the Project lock and then the Project-scoped runner lock while it
inspects and changes the runner lifecycle.

Host resume applies the same ownership inspection before it restarts a runner
that was ready at shutdown. A same-name container with incomplete, malformed,
or foreign labels blocks that runner's recovery and is left untouched.

The coordinator integration is provider-specific, but runner state, lifecycle,
and executor capabilities are provider-neutral. Managed Gitea Actions is the
initial adapter. `dim-qemu` is an executor capability that any Project workflow
may select; the disposable VM boundary and label do not encode DIM's particular
release policy or depend on Gitea-specific execution behavior.

Later lifecycle operations address the stable Project/QEMU-runner identity, so
managing one runner never starts, replaces, or deletes another. Multiple QEMU
runners provide parallel integration capacity while retaining concurrency one.
QEMU
supervisors share provider-neutral demand and claim state; the Gitea webhook is
only the current adapter that translates coordinator events into that demand.
The current QEMU coordinator remains Gitea-only. A future native adapter cannot
reuse this scheduler implicitly; its own reviewed transition contract must
decide any label or capacity behavior.

As a pre-stable state contract, earlier CI runner state is not migrated
automatically. Schema 8 records effective resources, protected-root runner
configuration provenance, and QEMU hook provenance so image admission survives
restart. Before upgrading from schema 7, use the installed older CLI to delete
each runner, then recreate it with the new CLI; alternatively clean up its
managed containers, volumes, provider registrations, and state manually.

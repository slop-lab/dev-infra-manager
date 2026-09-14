# Verification

## Scope

This specification defines the minimum verification gates for development.

## Example runner

`verification/scripts/verify-example.bash` is the common entrypoint for runnable examples.
It accepts `current-installed` and `sysbox`. The named backend provisions an independent disposable QEMU guest for
each selected example, while an optional example selector narrows the
otherwise compatible suite. Its dirty-repository policy is `auto`, `use`, or
`discard`: `auto`
rejects dirty input, `use` snapshots tracked and non-ignored untracked files,
and `discard` verifies committed `HEAD` without changing the checkout.

Repository-backed examples use `repos/<alias>`. The common fixture code must
initialize every alias as an independent Git repository, update matching
entries in the root `repos.yml`, and register that reviewed set in the
verification run's disposable managed Gitea.

The QEMU wrapper owns only guest and toolchain provisioning. After installing
Sysbox, Node.js, pnpm, and `just`, it must invoke repository
verification through `just install` and `just verify example`.

`project-runtime-cgroups` is one leaf feature example. Its systemd, cgroupfs,
and unsupported variants are files within that leaf and the common example
runner must dispatch its contract smoke for both direct selection and the
compatible `all` suite. Because the contract smoke is backend-independent, a
named backend may run it without provisioning a dedicated QEMU guest.

## Source Check Gate

`just check-source` must run:

1. TypeScript check.
2. Unit tests.
3. Production build.

Current commands:

```bash
just typecheck
just test
just build-packages
```

This gate must require only Node.js and pnpm, not Docker, a runtime backend,
QEMU, KVM, or an installed DIM CLI.

The source gate MUST require zero multi-module runtime strongly connected
components in the core and CLI source graphs. Its graph check MUST follow
relative runtime imports and re-exports recursively while excluding type-only
edges, and its own fixtures MUST prove that a nested cycle is detected.

Local source-preparation tests MUST require the three named inputs
`DIM_SOURCE_CORE_COMMIT`, `DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT`, and
`DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT` as exact 40-character commits. They
MUST prove detached checkout of each full commit and derive the shared local
package version from the SHA-256 digest of the ordered repository-name and
full-commit records.

CI runner unit coverage must verify resource-default precedence, stable managed
names, and that default container arguments use the configured isolation
runtime without mounting the host Docker socket. It must also verify that the
host-scoped pull-through cache has no published port and that Sysbox and QEMU
runner daemon configuration selects only the internal cache endpoints. For
`CI-CACHE-ROUTING-001`, verification must prove that managed workspace and
Sysbox daemons discover `dim-registry-cache:5000` directly, nested agent DinD
uses a workspace-local relay, and QEMU uses its launcher-local relay. Each route
must provide separate cold, warm, stable-alias replacement, and outage
evidence: the cold pull reaches the cache and requests its upstream artifacts,
the warm pull reaches the cache without another upstream artifact request, a
cache address change retains routing through the alias, and an unavailable
cache or relay fails without direct upstream bypass. Project examples must not
embed cache configuration. Packet capture and general network monitoring are
not required.
`cache-routing-sysbox` remains a direct, capability-gated local recipe. It MUST
require a real Sysbox-capable Docker host and MUST NOT be scheduled on the
QEMU-backed `dim-container-integration` hosted lane. A missing local capability
is a failed prerequisite, not passing evidence for `CI-CACHE-ROUTING-001`.

Managed Git verification must distinguish the host maintainer from the
workspace writer and verify that reviewed-ref push options allowlist the host
maintainer and organization Owners while force pushes remain disabled. It must
also verify that baseline-protected refs allow ordinary writer pushes but
reject force pushes.
Project identity tests MUST prove that schema `4` requires nullable
`giteaOrganizationId`, rejects null for `ready`, and rejects older schemas.
Creation tests MUST prove that the exact positive organization ID returned by
Gitea is persisted in a non-ready record before `ready` publication. A retry
with that ID MUST issue no creation request and MUST accept only a response
with the exact stored ID and reserved username. A null-ID creation receiving
HTTP `422` MUST require administrator reconciliation without a lookup or name
adoption. Managed Gitea verification MUST also prove that regular users cannot
create organizations through Gitea's
`[admin] DISABLE_REGULAR_ORG_CREATION` setting, mapped exactly as
`GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true`.
Managed Gitea concurrency tests MUST prove that one service-scoped lock spans
service-state claim and error/ready publication, network and volume
reconciliation, container inspection and creation, organization-policy
inspection and repair, restart, readiness, credential read or publication,
and webhook configuration. Waiting reconciliation MUST issue no interleaved
inspection or mutation. Container start, policy inspection and editing,
restart, and credential access MUST use the immutable ID returned by the
owned-container inspection. Credential tests MUST create credentials only
after the reserved genuine missing-path result and MUST propagate every other
read failure without user or credential mutation. Policy tests MUST accept
exactly one `[admin]` `DISABLE_REGULAR_ORG_CREATION=true` entry, reject missing,
false, or duplicate entries, and reinspect that same policy after restart
before readiness, credentials, or ready-state publication.
Managed Gitea resource tests MUST prove that network or volume creation occurs
only for the trimmed, case-insensitive exact Docker absence diagnostic for that
resource's expected type and name. They MUST reject daemon connection and
permission failures, wrong names, wrong resource types, and prefixed or
suffixed absence text without mutation or later reconciliation.

The Sysbox lane of `verification/scripts/kvm-host-install-smoke.bash` must enable a real
Project CI runner inside its disposable QEMU guest and inspect the effective
Docker runtime, CPU quota, memory limit, PID limit, non-privileged flag, and
absence of a host Docker-socket mount. It must then run the CI runner feature
smoke against a non-root repository.

`just verify example sysbox DIRTY ci-runner` must register one
organization-scoped runner
for a multi-repository Project, open a pull request in a non-root repository,
and wait for that repository's real workflow to succeed.

`just verify plugin-install` builds the publishable packages and verifies
plugin installation through their packaged shape. It is separate because it
tests an installation workflow rather than source correctness.

The external URL plugin unit suite must exercise real HTTP forwarding through
configured listeners sharing the hostname registry, generated URL shape,
concurrent automatic-name allocation, default workspace-prefix rejection,
webhook approval and response bounds, forwarded-header normalization, and
independent route claim revocation. The Cloudflare plugin suite must verify named driver
registration, provider/record argument normalization, and DNS reconciliation.
The generated QEMU webhook asset suite MUST execute the emitted Python program
and verify monotonic workflow-job transitions across duplicate, reordered,
concurrent, and post-restart deliveries, including bounded terminal retention,
without replacing its file lock or atomic state-write path with a test double.
It MUST prove that the scheduler fsyncs its temporary state file, atomically
replaces the durable file, and fsyncs the containing directory before HTTP
`202`, and that state load or write failures reject acknowledgement. Scheduler
tests MUST also prove that a claimed job ID is only a demand trigger: swapped
coordinator assignments, trigger completion, and missing or replaced trigger
claims MUST leave every already-running generic capacity alive, while one-VM
per-capacity, shutdown, state-I/O failure, and process cleanup remain enforced.
The route-policy test launches the checked-in advanced example server rather
than maintaining a test-only webhook implementation.
A configured Tailnet
ingress can additionally run:

```bash
verification/scripts/tailscale-external-url-smoke.sh
```

That smoke starts a workspace service, provisions a Tailscale URL through the
controller API, fetches a unique sentinel through the external URL, and revokes
the route. It is required verification code but is not part of the static gate
because it depends on operator-owned Tailnet DNS and TLS.

## Managed Workspace Integration Gate

The container CI lane requires Docker with Compose v2 and support for privileged
nested containers. It runs source checks plus workspace image, nested Docker,
lifecycle, packed-project, shared-upstream, and cgroup verification. The
broader `just verify container` additionally covers the canonical self Project.
These recipes may run against the nested Docker daemon in a development
container and must not claim to verify a host runtime backend boundary.

Gitea runs this gate automatically via the Project-owned
`dim-container-integration` label from `.gitea/workflows`. That integration
label selects a fresh one-job QEMU guest, whose job container receives only the
guest-private Docker socket. Persistent Sysbox runners advertise ordinary
labels only and expose no job Docker host. The QEMU boundary runs the complete
stateful development flow and canonical self-Project contract with the runc
Project backend. GitHub automatic CI is
intentionally limited to Node.js type checks and tests that need no APT packages
or container runtime. Sysbox and KVM host-backend gates also remain available
through the manually dispatched GitHub workflows.

For `CI-JOB-IMAGE-001`, verification MUST reject absent, malformed, non-exact,
duplicate, mutable-image, and unknown-capability Project runner configuration.
It MUST prove exact-byte digest and protected-ref/commit provenance, one-snapshot
use for runner configuration and QEMU hook admission, and state schema `8`
round-tripping. It MUST prove that every Project label selects a digest-pinned
disposable job image and that no `:host` label is advertised.

Verification MUST build the generated runner host image, execute act_runner,
and prove that Node.js, Git, Docker CLI, `just`, `jq`, `socat`, and `script` are
absent. It MUST inspect the effective act_runner policy for non-privileged jobs,
no arbitrary valid volumes, bound job workspaces, and forced pulls. Admission
tests MUST run every configured tool and capability probe through a separate
nested daemon and MUST prove that probe failure prevents registration.
Probe ownership tests MUST verify the complete DIM, Project name and ID,
capacity, executor, probe resource kind, Docker resource kind, and identity
digest label set. They MUST cover foreign same-name container and socket-volume
collisions, replacement of exact owned residue, a foreign resource winning a
same-name creation race, and a foreign replacement appearing before final
cleanup. They MUST prove that container removal settles before attached socket
volume removal, that container mutation uses the inspected immutable ID, and
that ownership-safe cleanup still attempts later resources after a partial
failure. Because Docker volumes have no immutable ID, tests MUST also prove
name-based volume removal is preceded by immediate ownership reinspection.
Every foreign resource MUST remain untouched, while cleanup removes only exact
owned residue.
QEMU tests MUST prove selection by either an integration label or `dim-qemu`,
supervisor-side `register --ephemeral` after guest readiness, strict validation
of the temporary `.runner`, and transfer of only that file into the guest.
They MUST also prove that guest transports and QEMU lack the reusable token,
the guest runs `daemon --once` under a timeout, and each job receives fresh
overlay, SSH, registration, and run state with bounded teardown.

The automatic managed-workspace gate must also run the shared-upstream example smoke.
That smoke proves that two logical DIM repositories can share one external Git
upstream while fetch and push map only the branches and tags owned by each
repository namespace.

The multi-repository container smoke MUST dirty both a tracked file and a
non-ignored untracked file before requesting a workspace restart. It MUST
verify rejection without a container stop, Project-service replacement, Git
state change, workspace-record change, or setup invocation, then clean the
checkout and exercise the successful fast-forward restart path.

The stateful development-flow smoke MUST materialize
`examples/projects/full-development-flow` and exercise one continuous journey:
profiled resource-bounded creation, private nested Docker, dirty restart
rejection, a reviewed root update, stop/start persistence, controller socket
replacement, setup-error recovery, agent-home backup, discard, recreation,
restore, and final managed-state/resource cleanup. Failure hooks and managed CI
cache configuration MUST be injected only into its temporary repositories;
the checked-in example remains a normal user-facing Project. The Sysbox
installer lane in the release gate MUST execute this same journey after
installation and workload probes.

That live journey MUST also force the first `host start` to fail during one
workspace setup, invoke `host start` exactly once more, and prove that one retry
completes recovery. After the failed first call it MUST observe
`resumeWorkspaces` retaining exactly the selected workspace and both
`restartCiRunners` and `resumeManagedContainers` retaining their captured
values, which are empty in this journey. It MUST inspect failed-state evidence
without issuing an ordinary workspace admin operation while host admission is
closed. Only after the successful retry may it require all three arrays to be
empty and ordinary workspace operations to succeed.

Deterministic workspace recovery tests MUST prove that direct `setup` from both
`setting-up` and `setup-error` acquires the Project lock before the workspace
setup lock, revalidates Project and workspace identity while both are held,
and replays the recorded immutable-root checkout and complete alias-keyed
repository snapshot before Project setup and final `ready` publication. They
MUST prove schema `5` requires each alias, including the root, to retain its
requested ref, resolved ref, and exact commit. The workspace must remain
non-ready throughout setup, moved refs cannot change any recorded selection,
and recovery MUST neither fetch nor resolve a repository ref.

Lifecycle-file probe tests MUST cover `.dim/setup.sh`, `.dim/entrypoint.sh`,
`.dim/teardown.sh`, and `.dim/docker-compose.yml`. They MUST prove that exit
code `0` means present, only exit code `1` means absent, and every other exit
code aborts before hook, Compose, or direct-command fallback dispatch.

Workspace selection tests MUST prove that schema `5` rejects an empty snapshot,
an omitted Project alias, any entry whose phase is not `ready`, and any entry
missing `requestedRef`, resolved `ref`, or exact `commit`. They MUST prove that
an omitted root ref records requested `HEAD` separately from the concrete
protected branch in `ref`. Published-CLI transport and an end-to-end workspace
journey MUST pass repeated `--repo-ref ALIAS=REF` values through the controller,
resolve each selected non-root ref to its exact commit, and observe the same
requested ref, resolved ref, and commit in workspace state and the Project
runtime manifest. The journey MUST also reject malformed, root-alias, unknown,
duplicate, unavailable-ref, and existing-workspace mismatch overrides without
mutating Project, workspace, repository, or ref state.

Workspace resource ownership tests MUST verify the complete container and
inner-engine volume label sets from `WORKSPACE-RESOURCE-OWNERSHIP-001`,
including their deterministic identity digests. They MUST reject absent,
partial, malformed, foreign, or mismatched labels. Every container mutation
MUST be tested against an inspected ID while a foreign same-name replacement
remains untouched. Volume creation races MUST be followed by ownership
reinspection, and discard MUST reinspect the volume immediately before removal
so a foreign replacement remains untouched.

Repository deletion tests MUST prove that deleting the selected importing
target fails before Gitea or Project state mutation, while an importing sibling
does not block deletion of a ready target.

Deterministic host recovery tests MUST invoke `host start` twice after a
fault-injected first attempt. They MUST prove that a partial failure retains
all still-pending workspace, CI-runner, and managed-container recovery intent,
and full success alone clears all lists. Host lifecycle validation MUST accept
only schema `2`; require exactly its phase, workspace, CI-runner,
managed-container, and timestamp structure with optional string error; require
exact `{project, name}` runner targets; and reject missing, mistyped, unknown,
or invalid fields without mutation or dispatch. It MUST prove that a ready
runner absent from `restartCiRunners` is not restarted. Workspace
phase coverage MUST map `ready` to no action, `stopped` to start,
`setting-up`/`setup-error`/`error` to immutable setup replay, and `creating` to
fail-closed rejection. CI phase coverage MUST map `stopped` to start and
`creating`/`error` to ownership-safe stop then start for every recoverable host
entry phase. It MUST prove that a `ready` target is untouched when invocation
enters from `stopped`, `starting`, or `error`, but is normalized through stop
then start when invocation enters from `stopping`. An invocation entering from
host phase `ready` MUST dispatch no recovery. Ready targets MUST not be
disrupted on an ordinary retry. Runner normalization and QEMU reconstruction MUST inspect
complete ownership and act only on the inspected container ID before any
coordinator registration, authorization, or webhook mutation.
Host administration tests MUST prove that ordinary built-in and plugin
operations acquire lifecycle admission before dispatch and retain it until
completion. Shutdown MUST wait before target capture while an admitted
operation remains active. A later operation queued behind shutdown MUST reread
the resulting host state and reject without dispatch. Streamed ordinary
operations MUST follow the same admission rule, while health, readiness, route
discovery, host status, and command-session transport remain available during
maintenance. Recovery tests MUST also prove that `host start` can perform its
internal workspace recovery while ordinary workspace administration remains
blocked by the non-ready host phase.

Repository transfer tests MUST prove that an imported repository remains
non-ready while protection is pending, only the trusted transfer identity can
write before protection, and transfer authority is revoked before protection
is applied. Protection failure MUST leave the repository non-ready and deny
ordinary writer and maintainer access. Only successful protection may publish
`ready` and grant ordinary repository users.

The integrated development repository MUST expose a manually dispatched QEMU
release gate. The dispatch MUST pin the exact development commit and accept an
explicit root ref, while the reusable verification workflow resolves and
records the exact commit for every repository in the assembled set. It MUST run
one full integration lane selected by `dim-container-integration` and one host
installer lane selected by `dim-qemu` before that repository set is installed
on a host or applied by workspace restart. Both labels MUST start fresh one-job
QEMU guests and use the protected Project contract's integration image and
declared toolchain.

## Container Backend Gates

`verification/scripts/container-cgroup-smoke.bash` requires direct access to the target Docker
host and must cover exact runc cgroup v2 CPU, memory, swap, and PID limits,
including live resource updates.

`verification/scripts/container-sysbox-isolation-smoke.bash` requires a prebuilt workspace
image and direct access to a Docker host with `sysbox-runc`. It must cover:

- Sysbox system-container execution with explicit CPU, memory, and PID limits.
- Exact cgroup v2 limit visibility inside the container.
- Nested Docker `hello-world` execution.
- Bidirectional image-store isolation using unique host-only and inner-only
  probe tags, independent of pre-existing image caches.

The multi-repository Project example gate verifies managed Git, protected refs, and
trusted deployment of a reviewed secret-bearing child beside a Project-owned
agent. It must use the example's generated `repos.yml`, prove the agent uses a
distinct Docker daemon, cannot list the trusted workspace's secret-bearing
child, does not mount either Docker socket, and does not receive the child's
raw secret environment. Its shared bind-mount probe must work when the agent
UID differs from the rootless-DinD UID.
The single- and multi-repository example gates must also verify that their
fresh rootless-DinD images retain executable UID/GID mapping helpers with a
setuid fallback before exercising the private daemon.

For `LIFECYCLE-LOCK-001`, deterministic tests MUST prove that elapsed time
cannot reclaim a matching live process instance, a dead child and an injected
reused-PID identity are reclaimable, and simultaneous reclaimers remain
serialized. Tests MUST also cover malformed owner records, crash leftovers
during atomic publication, a malformed 36-character boot ID whose hyphens are
not in canonical UUID positions, same-process independent acquisitions,
bounded timeout, and a stale release nonce that cannot remove a successor. The
Project-to-CI-runner-to-hook-publication order, Project-lock release boundary,
and independent workspace setup/reconciliation identities MUST remain under
regression coverage.

The canonical self-Project gate must verify its healthy private rootless daemon
and inner UID-0 agent both after workspace creation and after the first
workspace restart, proving the persistent nested image store and
workspace-container lifecycle. The daemon UID and GID MUST match the reviewed
workspace checkout owner while the inner agent sees that checkout as UID 0,
and the disposable-QEMU lane MUST use UID 1001 so a default UID 1000 assumption
cannot pass unnoticed. It MUST also inspect the DIM-owned
workspace engine and verify that it selects the managed pull-through cache
without adding cache configuration to the Project definition. Canonical setup must explicitly
rebuild the outer private-runtime image and reconcile the inner agent image so
an updated entrypoint cannot leave stale inner workloads running. The agent
home volume MUST be writable by inner UID 0 through the daemon's mapped
workspace-owner UID/GID. The daemon's rootless socket and data directory remain
inside `agent-dind` and MUST NOT be replaced
with a host or trusted-workspace runtime socket.

Project-runtime cgroup verification MUST cover both supported delegation
shapes (`systemd` and `cgroupfs`) and the unsupported `none` driver. The
checked-in feature examples MUST consume the same versioned Project manifest
contract and helper used by Project setup, and the negative example MUST fail
closed rather than silently running without resource enforcement.

## Fast Isolation Gate

`just verify isolation` must run without contacting Docker or creating a
container. It verifies generated runtime arguments, including:

- Outer CPU, memory, and PID limits.
- Job-specific workspace and nested runtime data mounts.
- Absence of the host `/var/lib/docker` as a mount source.
- Absence of the host `/var/run/docker.sock`.

`just verify isolation-json` runs the same tests with Vitest's JSON reporter so
CI can consume a single JSON document from stdout. These static checks do not
replace `verification/scripts/container-sysbox-isolation-smoke.bash`, which verifies actual
Sysbox and cgroup behavior.

## Backend Verification

Runtime backend verification should include:

- `doctor` for the installed backend.
- Workspace create, task execution, stop/start persistence, and discard.
- Nested rootless Docker smoke inside the Sysbox agent boundary.

Current verified host evidence:

- Sysbox inner Docker can run nested `hello-world` without access to the host
  Docker image store.
- Sysbox exposes the outer agent CPU, memory, and PID cgroup limits to the
  nested workload as aggregate upper bounds.

## Install Verification

Host installation scripts must be verified by:

- Checksum verification for downloaded runtime artifacts.
- Runtime version command after installation.
- Docker runtime registration check when the script registers a runtime.

`verification/scripts/kvm-host-install-smoke.bash BACKEND` and
`just verify environments-kvm BACKEND` verify one backend installer in a
disposable VM. Omitting `BACKEND` runs every backend in a separate VM. Managed
development CI MUST schedule each backend as an independent `dim-qemu` job so
available host capacities can run them concurrently without exposing capacity
names in tracked workflow code. These expensive jobs MUST run automatically
only for non-draft pull requests whose base is the managed development
repository's `main` promotion branch. Routine pull requests into `development`
retain source and managed-workspace verification without reserving
disposable-QEMU release capacity.
For `CI-QEMU-IMAGE-LAYERS-001`, verification MUST prove that the common-base
key changes with each pinned cloud image, provisioning, required toolchain, or
runner input and that the same key is reusable across Projects. It MUST inspect
the common base for absence of Project hook output, tokens, runner identities,
and job data. QEMU hook tests MUST reject unapplied protection and resolved
branches outside its patterns, prove one symbolic-`HEAD` resolution to a
concrete ref and commit, and prove that branch movement cannot substitute blob
bytes after admission. The Project-layer key MUST change with source ref,
source commit, hook kind, or exact executable digest and remain isolated per
Project. The absent case MUST stage, execute, and hash the same deterministic
non-empty no-op bytes. Tests MUST verify Project-to-CI-runner-to-hook-publication
lock order, Project-lock release before expensive image work, and complete
provenance in image manifests and runner state. Concurrent construction MUST prove locked, atomic publication. Deleting the
last Project QEMU capacity MUST remove only its Project-specific cache layer
and dispatch state. Every job MUST write only to a fresh disposable overlay.
Lifecycle tests MUST prove that QEMU `start` restores its persisted schema-`8`
config and hook artifact and provenance, supervisor image, job image, labels,
resources, and inheritance choice while replacing only runtime registration,
authorization, webhook, container, and resources. They MUST prove that
`restart` resolves the current protected state and refreshes every derived
admission input.
Common-base identity tests MUST independently vary both architecture names,
each cloud-image/checksum/signature/keyring input, the APT snapshot and exact
Deb822 source bytes, every requested package/version specification, every
downloaded executable URL and digest, each generated script, and the common
Packer template. Tests MUST reject `release/current` and other mutable image
aliases. Verification MUST check the official signed checksum metadata against
the selected artifact digest and trusted signing fingerprint, prove all APT
sources use one timestamped `snapshot.ubuntu.com` repository without disabling
signature verification, and prove every explicitly requested package is
version-pinned and available in that snapshot.
For `CI-QEMU-RESOURCE-OWNERSHIP-001`, tests MUST reject existing unlabeled,
partially labeled, malformed, wrong-owner, wrong-Project, wrong-capacity,
wrong-executor, wrong-resource-kind, wrong-Docker-kind, and wrong-digest
volumes and runner or supervisor containers for reuse and deletion. Every
generated short or long name MUST include a digest of all length-framed
identity inputs. Name tests MUST independently vary every input and include
distinct tuples whose naive delimiter-joined forms are identical. Container
tests MUST prove that start, stop, removal, QEMU reconstruction, and host resume
validate all nine ownership labels and use only the inspected container ID,
without a name fallback. Deterministic start and stop tests MUST cover foreign,
incomplete, and malformed same-name containers, plus a foreign same-name
replacement winning the race after inspection, and MUST prove each remains
untouched. Tests MUST prove absent stop is idempotent and absent Sysbox start
fails. QEMU reconstruction tests MUST prove complete ownership inspection and
selection of the inspected container ID precede coordinator registration,
authorization, and webhook mutation. Stop tests MUST prove
Project-to-CI-runner lock order. Tests MUST also prove that distinct valid long
names remain bounded and distinct, that failed and partially completed deletion
retains retryable runner state, that multiple capacities retain shared Project
resources, and that final-capacity deletion removes Project resources and local
Project image state without removing the host-common cache.
Every backend guest must run the same stateful development-flow and
`just verify self-development` recipe after the host installer completes. This
verifies the canonical DIM Project and its agent inside a private DinD on a
clean Ubuntu host. The guest verification user must use UID 1001. The gate
must prove that the canonical agent is UID 0 only inside its rootless
daemon, that the daemon's outer UID equals the non-root UID owning the checkout
(including verification UID 1001), and that Docker reports rootless security.
It must not treat inner UID 0 as host or trusted-workspace root authority.
The Sysbox guest must additionally verify a privileged trusted workspace using
its directly passed `/dev/kvm` with QEMU, absence of Sysbox registration in
the workspace's Project daemon, and a separate unprivileged Sysbox isolation
probe running a private DinD workload.
The self-Project integration gate MUST verify, after Project setup completes,
that the untrusted agent container has neither a `/dev/kvm` device nor readable
or writable access to that path. This is an agent-boundary regression test run
through a Project task; it MUST NOT run from Project setup or any workspace
lifecycle, readiness, start, or restart operation. KVM-disabled lifecycle
coverage instead asserts that DIM omits the explicit device and supplemental
group from the workspace creation arguments.

For `WORKSPACE-QEMU-INPUT-001`, the canonical Project MUST expose the protected
QEMU launcher through a workspace-local, single-run service. Admission tests
MUST prove that the first request claims the run synchronously before body or
filesystem work, a concurrent request is rejected, duplicate input names are
rejected before path resolution, and a rejected admission releases its claim.
Snapshot tests MUST prove that directory entries are streamed from open
directory handles rather than loaded as a complete listing, permission bits
are preserved, and symlinks are copied without dereferencing. They MUST cover
nested trees, immutable service-owned results after source replacement, a
socket, and a FIFO. A rejected unsupported entry and an interrupted snapshot
MUST start no subprocess or launcher and leave no reusable partial run tree.

Ownership tests MUST require a mode-`0600`, exact schema-1
`service-owner.json`. They MUST prove publication records schema 1 and the
launched PID as a decimal string, and MUST reject a missing required field, an
extra field, a numeric PID, a noncanonical executable path, and PIDs above
either kernel `pid_max` or the maximum safe integer. Tests MUST prove that an
argument-vector mismatch, owner-only state, malformed or foreign PID-only
state, and replaced owner or socket inodes remain untouched and cause no
signal. They MUST also prove that structurally valid dead residue is removed
only through captured inode identities. Obsolete `service.pid` state MUST be
rejected without migration for both live and dead recorded processes.

Publication tests MUST prove that the published owner has mode `0600`, schema
1, and the launched PID, and that no `service.pid` is created. Startup rollback
MUST cover owner-publication failure after socket bind while a foreign socket
replaces the bound pathname. Startup rollback and ordinary shutdown tests MUST
prove that captured device and inode identities prevent removal of a successor.
Restoration tests MUST prove that a later socket at the destination is not
overwritten and that both foreign socket inodes remain preserved. A direct
second service MUST fail without replacing the active socket, owner, or run
tree.

Setup tests MUST prove exact live-owner retirement occurs before replacement,
exact dead residue can be removed, and the malformed, foreign, ambiguous,
PID-only, and argument-mismatched cases above fail closed. Readiness tests MUST
require the launched PID in the structured owner, socket mode `0666`, and a
successful bounded status request. They MUST cover readiness failure after
publication, owner and socket replacement during readiness, and a started
process that never publishes an owner. The no-owner case MUST reach a bounded
failure without signalling the process.

Shutdown tests MUST cover an incomplete request body, an observed partial
snapshot, and a running detached launcher group. They MUST prove that shutdown
first closes admission, prevents later launch, drains run cleanup, and removes
only the service's own owner, socket, and run tree. Cancellation and shutdown
tests MUST also use a TERM-ignoring launcher group and prove bounded escalation
from TERM to KILL, child closure, and group termination before cleanup.

Event tests MUST prove that no more than 16 followers are admitted for an
active run, follower 17 is rejected before successful stream headers, and a
closed follower releases capacity. A replay write that reports false MUST
immediately disconnect that follower instead of allowing unbounded
backpressure.

The agent may start, follow, inspect, or cancel the fixed launcher, but cannot
supply a command, launcher path, QEMU argument, or path outside the assembled
`/workspace`. Accepted `NAME=/workspace/PATH` inputs appear only as guest
snapshots under `/mnt/dim-inputs/NAME`. The service and QEMU process run in the
trusted workspace; `/dev/kvm`, QEMU binaries, the launcher copy, and its
base-image cache MUST NOT be mounted writable into the agent. Candidate
verification code executes only in the VM.

## Installer Facade Verification

`just verify mise-install-smoke` requires Docker and network access. It
verifies `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end in a
disposable container against a local npm registry seeded from freshly built
tarballs, covering facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override. See [Installer Facade](14-installer-facade.md).
The local registry helper MUST execute the exact Verdaccio binary owned by the
frozen lockfile, bind a randomly selected IPv4 loopback port, close signup
after creating one random publisher, and require authentication for package
mutation.
Package tests must additionally cover the published launcher's direct use of
Node.js 24 or 26, its `mise exec node@24` fallback when the available Node.js
is absent or unsupported, npm `.bin` symlink resolution, argv preservation,
and its actionable failure when neither runtime path is available.

`just verify example BACKEND DIRTY external-urls` requires Docker. It proves
`examples/features/external-urls/README.md` end to end: a host DIM controller,
plugin loading before any external URL config exists, the example's checked-in
ingress and URL scripts, dnsmasq wildcard DNS, a project-root workspace,
the nested `dev` Compose service, a further `deep` container, root relay,
reverse proxy, ingress discovery, URL creation, HTTP access, and revocation.
The HTTP client runs on a separate Docker network, a loopback-only listener
must be unreachable from it, unknown and revoked routes must return 404, and
the controller-managed Caddy deployment must be generated and running without
an explicit setup command. Its private router port must not appear in the user
configuration.
It also reconciles an ingress through a local Cloudflare-compatible API,
resolves the resulting wildcard through authoritative CoreDNS, and verifies
provider cleanup without external credentials.
Ingress discovery, creation, and revocation must run through the public
`dim external-url` CLI rather than project-specific curl wrappers.

`just verify example BACKEND DIRTY multi-repository` requires Docker and managed Gitea. It
materializes the repositories under `examples/projects/multi-repository/repos/` in a temporary
directory and verifies the manifest-aware
`project create --bootstrap-git-url ... --apply-repos` flow,
protected refs, workspace, Project-owned agent, host Git identity, managed
repository access, nested Docker, and secret-bearing service boundary.

`just verify example BACKEND DIRTY single-repository` verifies the default
one-repository shape under `examples/projects/single-repository/`: no
`.dim/repos.yml`, no protected ref or secret service, a direct agent-style
push to `main`, explicit workspace resource limits, and an unprivileged
Project-owned agent serving the application through its private rootless DinD
sidecar boundary. It must also prove that the agent receives a filtered
controller proxy with only bodyless self-restart permission, cannot reach host
inputs, and can request an asynchronous restart of its own workspace. The
workspace/agent controller boundary must additionally prove that the agent
grant cannot authenticate to the workspace socket, the workspace grant cannot
authenticate to the agent socket, agent discovery omits restart and host
inputs, and an explicitly agent-audience External URL route remains usable.
The smoke accepts `DIM_EXAMPLE_WORK_ROOT` so a remote or sibling DinD daemon can
resolve controller-socket bind sources through a shared absolute path.

`just verify example BACKEND DIRTY full-development-flow` verifies the
multi-repository reference Project and the complete stateful journey described
above. CI runner lifecycle remains separate because it is a Project-external
host capability rather than Project-owned development configuration.

## Documentation Verification

Controller API tests must cover command-session creation, ordered SSE replay,
stdout/stderr separation, input forwarding, completion, sanitized failures,
and cancellation. Linux process tests must exercise a real PTY, initial
terminal dimensions, live resize, input, output, and exit propagation; session
tests must prove that internal probe output is not emitted. CLI contract tests
must ensure `exec`, `run`, workspace
lifecycle, and CI runner log commands use the streaming controller client and
forward `SIGWINCH`, and that the obsolete `--processes` spelling is rejected in
favor of `--pids`.
Streaming tests MUST also send redirected and named-FIFO input through one
ordered input queue, including EOF, and prove that input responses, input and
event transports, event responses, cancellation requests, and local
interruption failures all surface to the caller.

The managed container-integration and full-development integration steps in
QEMU-backed lanes MUST exercise live PTY resize without an unsupported
override. Only the workflow step named `Verify source repository set` may
record `DIM_TEST_PTY_RESIZE=unsupported` as an observation of that source
lane's current environment. The observation is not evidence of a Sysbox
product limitation and MUST NOT weaken container or disposable-QEMU resize
verification.

For `CLI-WORKSPACE-IMAGE-STATUS-001`, CLI tests MUST verify the exact human and
JSON ready and missing output, including a
`sha256:<64 lowercase hexadecimal digits>` image ID in ready output and no
image ID in missing output. They MUST prove that non-absence inspection
failures remain errors and that status is independent of host readiness,
controller readiness, and workspace lifecycle state.

For `CLI-STREAM-PROGRESS-001`, CLI tests must prove that lifecycle and CI
streams show an idle spinner only on TTY stderr, retain deterministic Project
stage lines in non-TTY output, and emit no spinner or terminal-control bytes to
non-TTY output, JSON stdout, or interactive `exec` and `run` byte streams.
Result, error, disconnect, cancellation, and local interruption must each clear
the spinner.

For `WORKSPACE-SSH-PROXY-001`, Project verification must connect through raw
stdio with no TTY, accept only key authentication after checking the generated
host-key fingerprint, and reconnect after agent recreation with persisted
authorized keys. It must prove that the target is fixed, no port is published,
and no host, trusted-workspace, or Project-runtime control socket is exposed.
Static checks MUST also prove that Project setup uses a bounded Compose wait
and that agent health requires the SSH server to accept a connection, so setup
cannot report completion before the proxy target is usable.
Static checks MUST require a standalone key-only server configuration with no
root login, password path, client environment import, or image-baked key. They
MUST require runtime host-key generation, persistent authorized keys, the fixed
`dim-agent` UID 1000, a fixed shell bridge, and a root-owned allowlisted
ephemeral environment outside the persistent home.

Live SSH checks MUST prove reads, writes, creation, and removal in both existing
and newly created workspace directories, equivalent operations in the agent
home, private rootless Docker use, and bounded Git credentials, identity,
no-prompt behavior, and safe directories limited to `/workspace` and
`/workspace/*`. They MUST exercise only the constrained External URL and QEMU
sockets, prove client `SetEnv` and `SendEnv` cannot override server values, and
prove that neither a host socket nor a Project-runtime socket is present.
Unprovisioned keys and password authentication MUST fail. The client MUST
attempt root authentication with the same known-valid key accepted for
`dim-agent`; root login MUST be rejected as account policy. A capable-host
journey missing `ssh` or `ssh-keygen` MUST report unavailable and exit `2`
before allocating state, not record passing evidence. QEMU service readiness
MUST be published only after its private socket has mode `0666` and the agent
receives that private namespace through a read-only mount.

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.

# Core development changelog

## Unreleased

- Replace DIM-owned mutable repository reconciliation with a schema-6
  workspace contract that mounts reviewed root bytes read-only and gives
  reviewed Project code a persistent data root. The schema-3 runtime manifest
  no longer publishes a repository catalog or accepts per-workspace ref
  overrides; incompatible old workspace state is rejected before mutation.

- Select the default trusted workspace image by the exact installed DIM package
  version instead of the mutable `latest` tag, while retaining
  `DIM_WORKSPACE_IMAGE` as an explicit override. Package builds now generate the
  runtime version used by both release and aggregate-identity local installs.
  The installed CLI now builds that image explicitly from shipped trusted
  assets and its exact-version controller-proxy dependency, with no source
  checkout or running controller required. Builds use the current user's UID
  and GID and reject IDs, digests, untagged destinations, and `latest`.

- Migrate the sole supported historical host state schema 1 record to schema 2
  during controller startup, with a durable permanent backup, deterministic
  interruption recovery, authoritative schema 2 lifecycle evolution without
  rewriting the historical backup, and fail-closed handling of conflicting or
  unsafe artifacts.

- Discover matching Gitea Actions jobs that were already queued when QEMU CI
  capacity is created, started, or restarted. DIM installs the webhook first,
  performs one bounded host-side backlog reconciliation through the existing
  authenticated shared scheduler, and publishes capacity ready only after the
  replay succeeds, without exposing coordinator credentials to the supervisor
  or guest.

- Keep the Docker CLI required by the pinned upstream Sysbox runner image's
  daemon readiness gate so persistent runners start instead of waiting
  indefinitely, while Project jobs remain disposable containers without the
  host Docker socket or runner host mode.

- Diagnose whether the current user's systemd manager persists after logout
  and whether AppArmor's unprivileged-user-namespace restriction has the
  required loaded rootlesskit profile. These doctor checks are read-only and
  report the explicit host commands needed for remediation. Workspace create,
  setup, update, start, and restart controller-session failures now preserve
  their original context while recommending `dim doctor` once; unrelated and
  locally rejected commands remain unchanged.

- Allow `dim workspace restart` to accept multiple workspace names, process
  them sequentially with per-workspace progress, stop at the first contextual
  failure without hiding earlier success, and return ordered results as one
  JSON array. Preserve the installer's existing multi-package
  `enable-plugin` behavior with executable regression coverage.

- Show the canonical public DIM source repository in both direct CLI and
  installer-only root help, while preserving full source-specific local build
  versions and installed-facade dispatch behavior.

- Allow independent workspace run/exec and CI-log streams to progress
  concurrently by releasing their host-readiness admission before runtime
  dispatch, while lifecycle mutations and plugin operations remain exclusively
  admitted. Workspace readiness, ownership, and per-workspace locking checks
  still apply, and a later stop, discard, or host-maintenance operation may
  interrupt an existing stream.

- Publish protected-root snapshots successfully when DIM runs as a normal
  non-root host user, while retaining read-only published trees and cleaning
  unpublished staging trees without replacing the original publication error.

- Add a generic `dim-development-service` helper backed by a shared
  HTTP/WebSocket gateway reachable on the agent-container gateway port and
  forwarding only to loopback applications. A trusted bound External URL proxy
  fixes the gateway target while callers submit only an ingress; stable service
  names retain their URL and URL ID when the local application port changes or
  the workspace is recreated, with persisted URLs reconciled to the current
  resolved upstream before reuse.

- Allow workspace discard to continue when its optional External URL cleanup
  cannot authenticate because the workspace controller grant is already gone,
  while preserving failures for denied or unreachable controllers.

## 0.9.0 - 2026-09-13

- Give locally built installation packages a validated version containing the
  aggregate SHA-256 of the three exact production commits named by
  `DIM_SOURCE_CORE_COMMIT`, `DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT`, and
  `DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT`, plus dirty-worktree state, so
  package managers do not reuse different local contents under the release
  version. Local builds link the exact core and contracts sources before
  compiling plugins. Existing facades pass these local tarballs through without
  revalidating the aggregate identity; an obsolete `<git-sha>` rejection during
  preparation means the selected production sources must be updated together,
  not that the 64-character identity should be weakened. Tracked manifests
  remain private and release builds retain the exact release version.

- Keep routine workspace lifecycle output concise by default instead of
  printing complete internal records, while preserving the full documented
  machine-readable result behind `--json`.

- Show a TTY-only idle spinner after five quiet seconds during long-running
  workspace, CI runner, and host lifecycle commands, reset the delay whenever
  command output arrives, and cleanly remove the indicator on every exit path
  without changing redirected, interactive, or machine-readable output.

- Add a volume-preserving host shutdown/start lifecycle that leaves the
  controller available, records previously ready workspaces, CI runners, and
  plugin-managed host containers, restores infrastructure before execution
  runtimes, and reports maintenance readiness until every target recovers.
  Ordinary admitted admin operations hold lifecycle admission through
  completion, so maintenance waits for them before target capture and drain;
  later queued operations reread host state and reject while it is non-ready.
  Internal workspace recovery remains available to the admitted host-start
  operation without reopening ordinary workspace administration.
  Repeated start attempts retain pending recovery intent after partial failure,
  skip targets already ready, replay
  interrupted workspace setup from immutable state, and normalize interrupted
  CI runners with ownership-safe stop/start. Lists clear only after full
  recovery. Host state schema 2 records runner restart authority in the durable
  `restartCiRunners` list and does not infer it from current runner state.
  Schema 2 is structurally validated without mutating malformed records, and
  the invocation's entry phase fixes runner recovery: ordinary retries leave
  ready runners untouched, while an interrupted `stopping` transition
  ownership-safely cycles a listed ready runner. Schema 1 is rejected without
  migration. Host-global registry-cache reconciliation is serialized across
  callers.

- Give reviewed Project Compose runtimes a stable workspace-local identity
  independent of the outer DIM workspace name, and reconcile a stale `ready`
  phase to `stopped` when the managed outer container is no longer running.
  Workspace state schema 5 records a complete alias-keyed repository snapshot
  with each requested ref, resolved ref, and exact commit, including the root.
  A symbolic root `HEAD` request remains distinct from its resolved protected
  branch, so setup retries rebuild the runtime manifest without resolving moved
  refs. Workspace containers and inner-engine volumes now require complete
  identity-digest ownership labels. Lifecycle mutations use only inspected
  container IDs. Docker volumes have no immutable ID, so deletion remains
  name-based and discard reinspects ownership immediately before removal.
  Workspace creation rejects malformed, root, unknown, duplicate, unavailable,
  and existing-workspace-mismatch ref overrides without mutating state.
  Optional lifecycle-file probes treat only exit 1 as absence; other probe
  failures abort before hook, Compose, or fallback dispatch. Live agent SSH
  rejects root login even when the client uses the same valid key accepted for
  the non-root `dim-agent` account.

- Remove the pre-stable gVisor, rootless-Podman, and privileged-runc workspace
  backends. Sysbox is now the sole workspace backend; ordinary runc remains an
  internal runtime for trusted infrastructure, obsolete configuration and
  state are rejected, and KVM is no longer a Sysbox doctor prerequisite.

- Resolve util-linux `script`'s own descriptor to a validated `/dev/pts/N`
  device and resize that device directly, avoiding Sysbox's non-effective
  ioctl forwarding through `/proc/<pid>/fd/*` while preserving ordered delivery.

- Materialize reviewed workspace host aliases such as the resolved DIM Gitea
  control-network address in `/etc/hosts`, avoiding runtime-specific embedded
  DNS behavior while retaining the recorded endpoint boundary.

- Move every managed CI workload into a disposable, digest-pinned job image
  selected by a strict protected-root `.dim/ci/runner.yml`. Runner admission
  now records exact config provenance, probes declared tools and nested-Docker
  capability before registration, shares one protected snapshot with QEMU
  cache-hook admission, and removes Project tools and host-mode labels from the
  runner host. State schema 8 records the final split: persistent Sysbox
  advertises ordinary labels only with no job Docker host, while QEMU
  advertises integration labels plus `dim-qemu` for fresh one-job guests. Probe
  cleanup waits for container removal before its attached socket volume and
  keeps attempting ownership-safe cleanup after partial failures. Probe
  containers are mutated only through inspected immutable IDs; socket-volume
  removal remains name-based and requires immediate ownership reinspection.

- Added protected-root-owned QEMU cache hooks, digest-keyed shared runner
  bases, collision-safe managed resource identities, fail-closed volume
  ownership checks, retry-safe final-capacity cleanup, and a monotonic shared
  webhook scheduler that prevents duplicate or reordered Gitea events from
  resurrecting completed jobs while retaining the intentional host-common
  cache. Common bases now use a dated, signed Ubuntu cloud-image release and a
  timestamped Ubuntu package snapshot, pin requested package versions, verify
  executable downloads, and key the cache from every repository, artifact,
  package, architecture, generated script, and Packer-template input. The
  scheduler fsyncs its durable file and containing directory before HTTP `202`
  and rejects acknowledgement on load or write failure. After guest readiness,
  the supervisor registers ephemerally, validates and transfers only `.runner`,
  unsets the reusable token for guest transports and QEMU, runs `daemon --once`
  under a timeout, and treats the claimed webhook job as a durable demand
  trigger rather than the consumed job identity. Trigger completion, loss, or
  replacement stops renewal without terminating running generic capacity,
  while shutdown and state-I/O failures retain bounded process cleanup. QEMU
  `start` preserves schema-8 admission state and refreshes only runtime state;
  `restart` re-admits the current protected state. TERM and INT remain graceful,
  startup residue is swept, and fresh per-job overlay, SSH, registration, and
  run state are removed.

- Command-session tests now cover base64-framed stdout/stderr, including bytes
  that are invalid UTF-8, plus FIFO input from files, pipes, and named FIFOs.
  Streaming `run`/`exec` remains safe for binary backup and restore tasks, and
  Unix responses settle on abort and error, while input responses, event
  responses, transport errors, cancellation failures, and local interruption
  failures all surface to the caller.

- Added coverage for exact-name workspace capability providers, required
  fail-closed behavior, recommended availability reporting, and validated
  provider additions to workspace container arguments.

- Interactive controller command sessions now use a real Linux PTY and track
  terminal resize events, while internal lifecycle probe output stays out of
  the user-visible task stream.

- New managed Gitea repositories enable the built-in issue tracker only for
  the Project root, keeping Project work tracking in one repository without
  changing repositories that already exist. Managed Gitea now disables
  regular-user organization creation through exactly one true admin policy
  key, reinspected after restart. Service state, resources, policy, readiness,
  credential publication, and webhook configuration are serialized in one
  reconciliation. Network and volume creation proceeds only when Docker's
  trimmed, case-insensitive inspect diagnostic exactly identifies the expected
  resource type and name as absent; every other inspect failure propagates
  before any mutation. Container work uses the inspected immutable ID, and
  only the reserved genuine missing-path result permits credential creation.
  Project schema 4 records the required
  nullable trusted organization ID before ready publication, verifies exact ID
  and username on retry, and fails closed on a null-ID name collision pending
  administrator reconciliation. Repository deletion also refuses
  to remove its selected target while that repository is importing, without
  blocking a ready target because a sibling import is active. Imports retain
  only trusted transfer authority and remain non-ready until protection
  succeeds; protection failure leaves ordinary repository users without write
  access.

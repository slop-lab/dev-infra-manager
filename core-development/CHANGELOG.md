# Core development changelog

## Unreleased

- Add the native ordinary authority library as the first bounded slice of the
  native ordinary-CI target. Its separate schema-3 SQLite state admits exact
  canonical operator Project/repository policy returned by an authenticated
  `NativeAdmissionSource`, rotates and revokes admission generations, and
  records only exact native-issued attempt tuples returned by that source.
  Its production source lazily authenticates the fixed private-Compose native
  Git peer on first mutation, attests the exact service role and ordered scope,
  and accepts only strict nonce-bound canonical policy, stored review-event, and
  current-attempt proofs. Rejected source tuples are concealed and unavailable or malformed
  peers return service unavailable, always before changing SQLite. Native Git's strict
  schema-2 config pins the proof service identity to `native-main` and provides
  a dedicated read-only proof identity plus exact canonical protected-policy
  and current unrevoked schema-2 attempt endpoints. Policy proof returns sorted
  required jobs but no per-Project capacity mapping; the central adapter derives
  and sorts every eligible assignment from its global operator-owned host
  capacities and requires exact equality with registrar and scheduler
  assertions. Once source-gated state exists, the library answers the Native Git query client
  only for exact live admission and current-attempt tuples. Registrar,
  scheduler, and query credentials are disjoint; stale generations, expired or
  revoked policy, foreign tuples, credential crossover, and predecessor
  schema-2 databases fail closed across restart without exposing secrets. The
  service has no Docker or host-administration socket, and a query never creates
  admission or attempt state. The query nonce is correlation and offline-replay
  protection rather than server authentication; the target currently assumes
  authenticated peers on its fixed private Compose network. Continue defining
  the complete native target as candidate-controlled self-test execution:
  strict schema-2 `.dim/ci/runner.yml`, its Bash script,
  and the digest-pinned job image come from the exact candidate tree, while the
  operator retains Project admission, required-job policy, a digest-pinned
  runner base, host capacity, and resource/time/output ceilings. Webhooks carry
  no executable fields; attempts and results bind complete config, script,
  argv, image, base, bounds, host, and candidate provenance, and stale replay
  cannot satisfy promotion. A zero exit may satisfy an explicitly classified
  required condition and records bounded execution of the selected tests, but
  is not independent verification or blanket correctness proof. Product
  maintainers still review changed requirements, implementation, tests, and
  relevant results; only infrastructure security review is narrowed around
  secrets and trusted capabilities. Human exact-tree approval and CAS promotion
  remain mandatory. Specify the remaining target as native review-event
  delivery, host-capacity claim, descriptor derivation, receipt-bound native
  issuance, transactional assignment, cleaned host result,
  durable native report retry, and fenced release. Webhooks cannot select
  executable input. One claim UUID is reused as the native issuance request so
  crash recovery converges on one attempt, while generation rotation, lease
  uncertainty, and scheduler restart fence only the affected capacity until the
  same host proves ownership-safe cleanup. Webhook, query, native identity,
  issuer, reporter, admission, and host roles remain separate. The final target
  keeps capacities global and operator-owned, stores no per-Project assignment
  list, and requires complete SQLite table-shape validation before accepting an
  unreleased schema-3 database. The standalone webhook intake now accepts only
  the exact non-executable review/job event after exact stored-event proof
  and a live admission, atomically records its inbox row, queued demand, and two
  permanent compact replay fences, and acknowledges exact or equivalent-ID
  replay without reopening work across restart or retention time. Changed reuse
  conflicts, each fence table is capped at 100,000 without evicting known
  replay, and G1 rotation supersedes queued old-generation demand. The former
  authority-only two-table and unreleased six-table schema-3 shapes are rejected
  rather than migrated. The final dormant claim, result, report, fence, terminal-detail,
  and service-epoch tables are present in the compiled manifest. The
  native Git event emitter now uses a fifth outbound-only webhook credential to
  retry the exact immutable event bytes without blocking review creation, accepts
  only the exact non-cacheable `202` acknowledgement, and stores permanent
  digest-bound mode-`0600` delivery markers under the registered repository.
  Startup replays only undelivered events, validates every marker, reserves the
  100,000-marker and 10,000-pending caps before review publication, and aborts
  requests and backoff timers on shutdown. Receipt-bound host claims now renew
  only their exact live host/capacity, attempt, descriptor, generation, and
  service epoch. Expiry, generation rotation, and restart durably withdraw
  verifier visibility and fence only that capacity. The same host can record
  exact cleanup and drive idempotent native revocation; a failed or lost revoke
  response retains the fence until retry proves the bound revocation. Cleaned
  host results now strictly mirror the native schema-2 terminal envelope and
  atomically commit immutable result and outbox rows before `202`. The central
  reporter uses its distinct fixed-peer credential for one bounded send at a
  time, retries the same stored bytes with capped backoff across response loss
  and restart, and releases the claim only after exact native acknowledgement
  or cleanup-gated terminal denial. Durable cleaned results remain valid current-
  attempt proof only for the current active admission and a non-denied outbox.
  Rotation, expiry, and revocation terminally deny and release pending old-
  generation delivery without another native request; a denial after native
  committed a status also prevents that stored status from satisfying
  promotion. Claims expose no reporter credential. A callable, independently
  authenticated host capacity worker now journals exact claim, result, and
  recovery requests across response loss and restart. It reads the exact
  candidate tree through Project-scoped native Git reader transport, verifies
  SHA-1 or SHA-256 objects and bounded inputs, runs one digest-pinned nested
  Sysbox job with no host authority in the candidate, renews against a
  request-start monotonic deadline, and submits terminal evidence only after
  ownership-checked cleanup. The worker is not connected to controller startup:
  the native Project adapter and installer wiring remain unimplemented, and
  actual Sysbox execution still requires the unavailable runtime gate.
  Native Git now
   authenticates the configured attempt issuer and result reporter as distinct
   service principals: only the issuer may derive descriptors or issue and
   revoke current attempts, and only the reporter may submit the exact current
   schema-2 terminal tuple. The service rejects obsolete generic scheduler and
   CI identity configuration rather than letting either satisfy protected
   promotion evidence.

- Let one explicitly configured reviewer-web account approve the exact immutable
  review and revoke only its own active approval through fixed, Origin- and CSRF-guarded
  routes backed by the existing native Git reviewer authority. The responsive
  evidence view keeps other authenticated accounts read-only and shows the
  freshly reread review status before mutation-time navigation resumes;
  stale approval remains denied, while rejection, administrator revocation,
  promotion, CI reporting, host administration, and generic proxying remain
  absent.

- Replace top-level installer verbs with the `dim installer install
  core|plugin` namespace, require exact registry plugin versions, stage plugin
  graph replacement transactionally, and include one controller
  restart/readiness gate in core installation with restoration of the prior
  runtime and controller after injected failure. The current CLI-owned
  `dim install-cp` placeholder remains an explicit fail-closed gate because the
  specified native Git/ordinary-CI bundle, service integration, and native
  Project adapter are not implemented; it changes no host state and installs no
  separate web UI.

- Add a standalone DIM-owned Git smart-HTTP host with exact
  Project/repository registration, identity-scoped reads, and workspace-bound
  proposal pushes. Its server-side receive policy denies protected refs, tags,
  deletion, force updates, foreign namespaces, unsafe paths, and invalid
  credentials. Host-scoped reviewer API and CLI operations now persist
  immutable complete-tree proposal evidence, including deletion, rename, mode,
  and symbolic-link changes; apply path-owner rules only to add whole-tree
  human reviewers; and record or revoke approval bound to exact refs, heads,
  commits, trees, policies, and identities. Ref, tree, policy, or identity drift
  makes approval stale across restart. It is not yet selected by Project
  lifecycle code and exposes no issue tracker, CI status, merge, or
  protected-promotion authority; existing managed and external Gitea behavior
  remains unchanged while exact-evidence CI and compare-and-swap promotion
  remain future gates. Storage ownership now uses a validated file-backed
  SQLite exclusive transaction on the shared repository volume, preventing
  duplicate owners across container network namespaces while allowing a clean
  replacement after process death.

- Let an agent with an explicitly filtered resource-read proxy query only its
  own accepted workspace CPU, memory, and PID assignments. The packaged
  `dim-nproc` helper floors fractional CPU quotas, caps output by visible CPUs,
  and fails on unavailable or unlimited assignments instead of reporting host
  capacity. Resource reads use a dedicated agent-audience proxy and derived
  socket while self-restart remains on its separate workspace-audience proxy;
  configured Project agents and SSH sessions receive neither raw grant. No
  host-admin socket, runtime socket, or workspace selector is exposed.

- Let `dim external-url list` use the host-admin controller to show a bounded
  all-workspace route inventory with Project and workspace names when invoked
  on the host. `--workspace` and workspace/agent environments remain scoped to
  one workspace, and the host inventory omits internal route identity and
  credential-bearing configuration. Ingresses may now require per-route host
  approval: requests reserve a pending URL while HTTP, WebSocket, and TCP
  traffic remains denied; host-only approval enables the exact persisted route,
  and terminal host revocation or deletion removes reachability and active flows
  without allowing an agent, foreign workspace, changed external listener
   policy, or recreated workspace to reuse the ID.
  Hostname-routed HTTP and HTTPS requests now also return a stable per-route
  permalink alongside the policy-selected slug. Both authorities are claimed
  atomically and exclusively by one route and share approval, target rebinding,
  revocation, and deletion;
  policy slug changes retain the permalink while requiring fresh approval, and
  workspace recreation receives a new one. Development-service gateways adopt
  a changed slug for their existing listed route ID instead of registering a
  duplicate. The workspace-image development-service helper can also request
  one- or two-level nested HTTP targets without accepting a workspace, public
  authority, controller endpoint, protocol, or approval selector. Raw TCP
  routes remain address-and-port URLs without DNS permalinks.

- Let trusted hosts share ordinary Sysbox CI capacity across explicitly
  enrolled DIM Projects on one external Gitea control plane. Each host
  verifies the Project and organization identity before one-job registration,
  fences a named capacity with a renewable claim, safely reaps an expired
  worker, and uses one digest-pinned job image and the managed registry cache.
  Pool configuration and organization webhooks remain operator-owned; QEMU
  integration capacity and Project-specific hooks remain separate.

- Allow a reviewed maintenance-window repository apply to rebind only an
  existing ready Project root's external origin with an explicit root alias,
  exact full lowercase expected tip, and non-interactive approval. The locked
  transition requires unchanged root and protection policy, verifies the new
  HTTPS origin twice, requires the old managed protected-root tip to be an
  ancestor, and changes no managed ref, omitted alias, or workspace state;
  ordinary origin mismatches remain conflicts.

- Require an Owner-approved pull request for every ordinary update to a
  reviewed Project root branch. Only the host-side maintainer retains direct
  publication authority; repository Owners and administrators cannot use the
  routine direct-push or merge-override paths. CODEOWNERS routes additional
  review for lifecycle and policy files without treating filenames alone as
  proof of the trusted execution inputs.

- Run repository fetch and selective non-force publication through an
  explicitly configured narrow service on the physical Git host. The service
  resolves Project and repository aliases from a private registry, reuses the
  actual Gitea bare repository and a credential-free persistent upstream
  remote, stages fetched objects only in a hidden namespace, and sends visible
  updates through Gitea's receive path. It rejects unregistered repositories
  and disallowed transports, keeps credentials request-scoped, serializes each
  repository, and fails closed instead of restoring temporary clones when the
  capability is absent.

- Build the QEMU CI supervisor image successfully under restrictive caller
  umasks by applying each generated build asset's intended mode explicitly.
  The snapshot TLS CA remains readable by APT's sandboxed user while the build
  context and private assets retain their restricted modes; TLS, signature,
  artifact, and package pins remain unchanged.

- Allow hosts to use one explicitly configured external Gitea service while
  retaining the existing local managed-Gitea default and one DIM controller on
  every host. A private connection file separates API, host, workspace, and
  runner endpoints, supplies existing scoped credentials, and binds shared
  Project and organization identities. The connection declares a stable host
  identity and HTTPS, loopback-HTTP, or isolated-HTTP transport policy; DIM
  validates a distinct non-admin workspace writer, permits the host maintainer
  to reuse the administrator credentials, and validates unique Project
  bindings. It rejects API redirects, scopes host credentials to the configured
  URL, and host-scopes shared Sysbox runner registrations. DIM validates health
  and authentication before mutation but does not provision, stop, reconfigure,
  or inject aliases for the operator-owned service. Explicit host-admin
  repository deletion and Project purge remain available and affect every host
  attached to those shared remote resources; repository permissions and branch
  protection remain enforced through the existing APIs.

- Replace DIM-owned mutable repository reconciliation with a schema-8
  workspace contract that mounts reviewed root bytes read-only and gives
  reviewed Project code a persistent data root. The schema-3 runtime manifest
  no longer publishes a repository catalog or accepts per-workspace ref
  overrides. Protected-root paths are derived from the state root, Project ID,
  and exact commit instead of being persisted. Each workspace instance now has
  a fresh 256-bit ID that binds controller and agent grants, plugin routes, and
  runtime ownership across stop/start while preventing same-name recreation
  from inheriting authority. Discard now publishes its non-ready phase and
  revokes grants before cleanup, while controller/plugin dispatch, host
  shutdown, and host CLI grant lookup revalidate the current instance. A
  distinct per-workspace authority lock preserves that revalidation without
  deadlocking setup-time host inputs, and controllers buffer bounded request
  bodies before acquiring authority so partial agent requests cannot delay
  discard denial. Schema-7 and other incompatible workspace state is rejected
  unchanged with pinned-version export and recreate guidance.

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
  unsafe artifacts. CLI installation now runs the staged target core package's
  read-only compatibility preflight before runtime, config, symlink, or plugin
  promotion: missing and current state proceed, this exact host migration warns
  without changing bytes, and malformed or unsupported Project, workspace,
  runner, or host state refuses with export-and-recreate guidance. Local source
  entrypoints stage and execute this exact target facade rather than relying on
  an older standalone or mise-managed facade to enforce a newer contract.

- Discover matching Gitea Actions jobs that were already queued when QEMU CI
  capacity is created, started, or restarted. DIM installs the webhook first,
  performs one bounded host-side backlog reconciliation through the existing
  authenticated shared scheduler, and publishes capacity ready only after the
  replay succeeds, without exposing coordinator credentials to the supervisor
  or guest.

- Bound the shared QEMU scheduler to 32 concurrent request handlers and a
  ten-second total request lifetime, including slowly delivered headers and
  bodies. Saturated requests receive a bounded service-unavailable response,
  failed handler-thread startup releases its capacity, and the packaged image
  now includes every scheduler storage module required at startup. Per-Project
  persistent state now rejects new entries after 10,000 nonterminal jobs or
  100,000 claim receipts without evicting live fences, and unsuccessful shared
  supervisors use bounded shutdown-interruptible backoff after release. Runner
  admission also rejects scheduler mode, Project, or host identity changes
  before mutation and requires the scheduler host ID to match external Gitea.

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
  operation through an authenticated controller grant only for a listed
  workspace while its setup is replaying, without reopening ordinary workspace
  administration.
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

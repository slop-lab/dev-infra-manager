# Status

The development branch targets DIM 0.9.0. DIM has no stable release yet;
pre-stable state, configuration, CLI, and extension contracts may change
without backward-compatibility shims or implicit migration.

The supported host platform is Linux with a systemd user manager. macOS,
Windows, and Docker Desktop are outside the supported runtime model.

Specified but not implemented:

- Native ordinary CI admission and host-controller-owned shared Sysbox
  capacity. The target has no persistent Project-scoped ordinary runner or
  image. Its accepted design reads strict schema-3 job config and script from
  the exact candidate tree, uses an operator-owned digest-pinned common job
  base image, and labels a zero exit as
  candidate-controlled self-test evidence, not independent verification.
  Green records bounded execution of the selected tests, not correctness or
  completeness of those tests and not blanket product correctness. Product
  maintainers still review changed requirements, implementation, tests, and
  results; the sandbox narrows infrastructure security review only.
  Trusted native Project registration will establish CI eligibility without a
  separate per-Project approval; operator policy controls required jobs and
  global capacity, pinned images, and bounds. Existing Gitea ordinary-pool commands, schema-2 state, and persistent
  Sysbox runners are predecessor behavior and are rejected by the target rather
  than migrated.
- A runnable native Project/repository state adapter. Host-only drafts and
  exact root import exist, but bundle installation does not select native Git
  for Projects; until a separate adapter is reviewed and implemented,
  native Project admission, capacity advertisement, claims, attempts, and
  results remain denied. A separate native QEMU host-file parser provides
  preflight only: there is no native QEMU scheduler, executor, or VM result,
  and existing QEMU scheduling remains Gitea-only.

The installed bundle and passing predecessor Gitea/QEMU gates are not
evidence that native Project integration is available. Bundle support remains
gated on the control-plane acceptance run on a clean host. The reviewer browser
UI and transition away from protected-root schema 1 remain unimplemented.
This pre-stable target defines no compatibility parser or source/state migration.

Implemented:

- The installer-facade-owned `dim installer install control-plane --config
  FILE` transaction for the two-service native Git and ordinary CI Compose
  bundle, including distinct nonroot identities and private volumes,
  authenticated readiness, bounded predecessor-state refusal, pre-activation
  rollback, and explicit `dim installer recover control-plane --roll-forward
  --generation GENERATION` after uncertain candidate activation. Recovery
  checks the retained journal, snapshots, runtime topology, and readiness,
  replays only the exact candidate activation, and preserves volumes and
  imported roots. A wrong or incomplete candidate remains refused.
  It neither selects native Git for Projects nor admits jobs for execution.
  The ordinary service now durably records imported-root policy eligibility and
  inert proof-bound ordinary review-event receipts in strict format 5 after
  exact activation and fresh native proof. Its
  registrar can register/revoke, its reader can query current eligibility, and
  native Git readiness attests that reader identity. Admissions bind the full
  kind-labelled policy to installer generation and global capacity digest, but
  grant no claim, attempt, execution, result, promotion, or runnable-Project
  authority. Event receipts likewise create no demand, claim, attempt, result,
  dispatch, or execution authority. Exact replays are historical receipts, so current-validity checks
  require fresh UUIDv4 request IDs. Native Git's strict format-8 volume can record multiple exact
  Project/root identities and one immutable import intent per prepared root.
  A strict schema-7 native config with empty registrar, importer, root
  read-issuer, workspace-write-issuer, and human-reviewer lists retains the idle
  HTTP service on empty state. A host-bound registrar can
  prepare an inaccessible root; a distinct importer can upload one bounded,
  self-contained Git bundle, bind the exact policy and commit, and finalize
  the initially unborn protected ref through the service's checked CAS.
  Separate host-only clients load owner-only mode-`0600` registrar/importer
  connections, attest the exact service/role/host/generation, and match durable
  and final receipts.
  A separate host-bound root read issuer is isolated from every other role.
  After live imported-root proof it can request a 30-second, Project/root-scoped
  upload-pack lease; the issuer credential itself has no Git authority, and
  receive-pack remains denied. Host-only clients load separate owner-only
  importer and issuer connections, check the exact non-runnable draft against
  a fresh proof, and withhold the lease when the bound receipt or owner drifts.
  A native bootstrap planner pins one commit in an already-local repository,
  reads its exact reviewed manifest or explicit manifest-free policy, and
  creates a private self-contained one-ref bundle. A host-only bootstrap
  durably claims a separate credential-free native draft, imports that same
  commit and policy, and binds the final receipt; a lost host receipt can be
  recovered by exact replay. A read-only importer-scoped schema-2 proof checks
  the current serving activation and the original import receipt against the
  owner marker, private repository, bundle, protected ref, tree, and host draft.
  A fully imported root survives a later service generation after read-only
  verification without changing its receipt or draft; incomplete earlier-
  generation imports reject startup before mutating recovery. Stale proof leaves
  the draft non-ready and unchanged. A host-only snapshot operation uses the
  same proof and read lease to hash-check and publish the exact imported commit
  and tree under a separate private native asset namespace. It preserves safe
  contained relative symlinks, rejects unsafe lifecycle links and gitlinks,
  and publishes no lease or workspace authority. This does not attest an
  external origin or publish a runnable Project. A separate owner-host issuer
  can mint a 30-second memory-only workspace lease after live authoritative
  imported-policy proof; its checked Git backend permits only that workspace's
  proposal namespace. Configured policy-required human reviewers may inspect
  and durably approve only one exact immutable Project/root/review ID after a
  fresh live proof. Approval is request-idempotent immutable evidence; all
  path-added required reviewers must approve before current status is approved,
  while moved proposal, protected head, or policy evidence is returned as
  stale. Reviewers can also durably revoke their own exact historical approvals;
  this surface has no list, CI, promotion, or protected-ref
  mutation. The installed bundle still issues no durable workspace or promoter
  identity, executes no native CI job, and exposes no protected writes or
  runnable Project. Trusted in-process read-only methods can derive separate ordinary and QEMU descriptors
  from an exact current immutable review plus operator-labelled images, bounds,
  and admission generation. Each requires matching policy/review and schema-4
  candidate job kinds, and QEMU uses its own schema and digest domain. They
  create no admission, attempt, execution, result, or VM and are only future
  adapter prerequisites. The host-only root fetch is not
  workspace admission. Gitea-free adoption
  remains gated on the clean-host Sysbox and KVM journey above.
- Service-level candidate job parsing and descriptor binding, central ordinary
  claim/lease/result state, and a callable host executor. The host worker is
  not connected to controller startup and no native Project adapter is active.
- Project metadata with exactly one root repository per runnable Project.
- Schema 4 Project state with a trusted Gitea organization ID persisted before
  ready publication, and Project creation serialized through identity
  selection and reconciliation.
- Mandatory managed-Gitea organization policy for existing and newly created
  service containers, disabling regular-user organization creation with one
  canonical true admin key and post-restart reinspection. Service state,
  resources, policy, readiness, and credential publication are serialized;
  container operations use the inspected immutable ID, and only explicit
  credential-path absence permits credential creation.
- Managed local Gitea repositories, imports through the host `git` CLI, and
  protected branches.
- Project-scoped repository sets loaded from `repos.yml`, including reviewed
  bulk planning and application.
- Explicit external repository synchronization through `repo fetch` and
  reviewed `repo publish` branch mappings, without coupling the core Git
  transport to one provider.
- Persistent create, run, exec, setup, update, start, stop, show,
  and discard lifecycle.
- Strict schema 2 host recovery that rejects invalid state before dispatch,
  retains pending recovery intent after partial failure, and clears it only
  after complete recovery. Ordinary built-ins other than runtime sessions, and
  all plugin administration, hold host lifecycle admission through completion;
  maintenance waits before target capture, and queued later operations reread
  and reject while the host is not ready. Workspace run/exec and CI-log runtime
  sessions release their short readiness admission before streaming, so
  independent sessions can overlap while later stop, discard, or maintenance
  may interrupt them.
- Sysbox backend identity persisted per workspace, with obsolete backend state
  rejected.
- CPU, memory, and PID limits at the top-level workspace boundary.
- Nested Docker storage isolated in a labeled volume.
- Optional `.dim` setup, task entrypoint, teardown, and Compose contract.
- Project-owned development-agent containers and task dispatch, without a
  core-managed agent resource.
- A unified managed runtime for the CLI, core, and plugins, with exact peer
  dependency validation and persisted plugin activation.
- Host-shared external URL ingresses with workspace-scoped route requests on a
  dedicated agent controller socket and optional Project narrowing proxy.
- Automatic host KVM forwarding for supported trusted workspace backends.
- A thin installer facade (`@slop-lab/dim-installer`, also exposing `dim`) that
installs the unified runtime via `installer install core|plugin` and
  proxies operational commands to its managed `@slop-lab/dim-cli`,
  verified through `mise use --raw --global` in a disposable container and against the
  canonical Project example.
- Root-ref refresh on workspace start/restart without live mutation of running
  workspaces.
- Atomic running-workspace restart preflight: dirty and divergent roots are
  rejected before the workspace or its Project services are stopped.
- TypeScript unit tests and nested-container lifecycle smoke tests.
- Reproducible local Node.js 24/26, container, Sysbox, and KVM CI entrypoints.
- Source CLI execution through `just run-cli`, which builds core and runs the
  CLI directly through `tsx` without requiring an installed DIM CLI.
- A common example verifier that creates a separate disposable QEMU guest for
  each selected example and runtime backend.
- A full-development-flow Project example and continuous stateful journey from
  creation through reviewed updates, safe restart rejection, controller
  replacement, setup recovery, and backup/discard/restore. Test-only registry
  and failure hooks are injected into its disposable materialization rather
  than embedded in the copyable example.
- Project-scoped managed CI runners shared by all repositories in the Project,
  with schema 8 state, independent resource limits, and a provider-neutral
  coordinator boundary. Persistent Sysbox runners advertise ordinary labels
  only and expose no job Docker host. Integration labels and `dim-qemu` select
  fresh one-job QEMU guests through a persistent trusted supervisor that keeps
  reusable registration tokens outside the guest.
- Durable QEMU demand scheduling that fsyncs state and its containing directory
  before HTTP `202`, rejects acknowledgement on state errors, and cleans fresh
  per-job overlay, SSH, registration, and run state after bounded execution.
- A host-scoped Docker Hub cache reached directly as
  `dim-registry-cache:5000` by managed workspace and Sysbox daemons, through a
  workspace-local relay by nested agent DinD, and through a launcher-local relay
  by QEMU. Verification records separate cold, warm, replacement, and outage
  evidence.
- FIFO command-session input for terminals, redirected files, pipes, and named
  FIFOs, with response, transport, and cancellation failures surfaced to the
  CLI caller.
- Local source preparation from three named exact production commits, with one
  aggregate SHA-256 package identity and frozen-lockfile installs. Its local
  test registry uses the exact lockfile-owned Verdaccio binary on randomized
  loopback, closes signup, and requires login for package mutation.

Acceptance verification on 2026-09-14: `just verify agent` exited 0.
Core-development Vitest reported 784 passed and 40 intentionally skipped; the
CLI reported 63 passed; verification reported 138 passed across 29 files; and
the plugin development suites reported 6 and 14 passed. Repository materialization,
TypeScript checks, builds, seven package dry-runs, plugin installation,
`project-runtime-cgroups`, `pull-request-skill`, and the `agent-docker` smoke
passed. `just check-run-cli`, the SSH policy check, and shell syntax checks
passed. Independently observed third-wave QEMU verification passed all 10 files
and 38 tests. Before the final race fix, the focused owner, record, setup, and
startup group passed three consecutive runs of 13 tests. After the fix, the
expanded owner, startup, shutdown, and setup group passed all 17 tests, and the
full verification test run passed all 29 files and 138 tests. The new
regressions cover structured ownership and bounded resource behaviors,
alongside QEMU admission, immutable snapshots, shutdown, service replacement,
socket readiness, nested executable files, unsupported FIFOs,
full-development fixed-shell authority, and bounded SSH-readiness policy.
Direct Unix-socket QEMU service tests, static full-development Compose
validation, Node and shell syntax checks, and changed-file diff checks passed.
The broader `just` gates were not rerun for this third wave.

A follow-up QEMU ownership hardening pass on 2026-09-14 added an adjacent
hard-link lease for the bound socket inode, descriptor-bound owner inspection
and publication identity, a root-owned service-directory boundary, staged run
directory activation, and launcher-first shutdown ordering. The final
verification run passed all 32 files and 162 tests. Focused publication
verification also passed after exact `0600` and `0666` mode assertions were
tightened. Workspace TypeScript checks, changed QEMU module syntax checks,
changed-file diff checks, pure-source line limits, fixture cleanup, and a
direct rejection probe for a sticky-bit service directory passed. The added
regressions cover lease collisions and mismatches, partial ownership triads,
open-listener inode pinning, deterministic owner-path replacement, all four
service namespace preflight paths, staged-run rollback, and active-launcher
termination before a lease-failure exit. TypeScript LSP diagnostics were
unavailable because no server is installed; the executable typecheck was used
instead. The broader `just verify agent`, live Sysbox, KVM, and
full-development gates were not rerun for this follow-up.

A lifecycle correction was independently verified on 2026-09-15. Evidence
included verification across 40 files and 206 tests, passing cross-workspace
gates, 786 passed core-development tests with 40 environment skips, and 63
passed CLI tests. All 11 typechecks, package builds, Node and Bash syntax, LOC,
hygiene, and changed-file diff checks passed. Manual Unix-socket checks observed
status, HTTP `400` handling, and graceful cleanup. Oracle reported a PASS for
the implementation blockers as a point-in-time review observation, not final
approval. That observation was not a five-way sealed review and is superseded
as approval evidence by the current pending status below. TypeScript LSP
remained unavailable because its earlier installation was declined. Live KVM,
live Sysbox, and the full-development journey were not rerun.

OpenSSH 9.6 and Docker buildx 0.30.1 were installed in the development agent to
exercise the capable-host entrypoint. The full-development journey built all
packages and the canonical workspace image, then stopped at managed Gitea
readiness because this agent controls a sibling rootless Docker daemon through
a mounted Unix socket: Gitea returned HTTP 200 inside its container, while the
daemon-local `127.0.0.1:3300` publication was not reachable from the agent's
loopback namespace. This daemon also exposes no `sysbox-runc` runtime, and the
agent has no accessible `/dev/kvm`. Therefore
`JUST_UNSTABLE=1 JUST_ACK_UNSTABLE=1 just verify full-development` was executed
but did not pass in this environment. Its live SSH and ordinary-writer denial
assertions remain pending execution on a Sysbox-capable host whose Docker
loopback namespace is local to the verifier.

Current review status on 2026-09-17: **PENDING**. Seal
`6279a7a8f70dd1e5761e5788dea5b596901f0df2e28d6c25dfa026cb0d4be103`
failed and carries no approval. The parent review observed 221 verification
tests passing across 43 files; `workspace:check` passing all 11 projects;
core-development reporting 786 passed and 40 skipped; the CLI reporting 63
passed; and the workspace build passing. A manual real-Node Unix-socket check
observed status HTTP `200`, malformed JSON HTTP `400`, run HTTP `202`, and
SIGTERM exit `0`, after which the owner, socket, lease, and runs artifacts were
all absent. TypeScript LSP diagnostics remained unavailable because
installation had previously been declined. Live KVM, live Sysbox, and the
full-development journey were not run. No final five-lane approval has been
issued.

The lifecycle-finalization follow-up on 2026-09-17 retains **PENDING** status
and does not supersede that failed seal. Regression-first verification observed
40 focused QEMU lifecycle tests pass, followed by the first full verification
run passing 237 tests across 44 files. `workspace:check` passed all 11 checked
projects and the workspace package build passed. Changed Node modules passed
syntax checks. A manual real-Node Unix-socket run observed status HTTP `200`,
malformed JSON HTTP `400`, run HTTP `202`, and SIGTERM exit `0`; owner, public
socket, lease, and run-root artifacts were all absent afterward. Deterministic
tests separately exercised both blocked snapshot-removal orderings, cancel-only
finalization failures, a foreign public socket with a valid owned lease, the
12-case obsolete-PID lifecycle matrix, and activation readiness after owner
publication. TypeScript LSP diagnostics remain unavailable because installation
was previously declined. No fresh sealed review or final approval has been
issued.

DIM does not currently provide automatic workspace cleanup after PR merge,
one-shot workspace wrappers, or disk quota. Those orchestration policies can
be added on top of the workspace lifecycle without introducing a second
execution model.

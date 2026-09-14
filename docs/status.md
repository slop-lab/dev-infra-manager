# Status

The development branch targets DIM 0.8.0. DIM has no stable release yet;
pre-stable state, configuration, CLI, and extension contracts may change
without backward-compatibility shims or implicit migration.

The supported host platform is Linux with a systemd user manager. macOS,
Windows, and Docker Desktop are outside the supported runtime model.

Implemented:

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
  after complete recovery. Ordinary admitted administration holds host
  lifecycle admission through completion; maintenance waits before target
  capture, and queued later operations reread and reject while the host is not
  ready.
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
  installs the unified runtime via `install-cli`/`install-plugin` and
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

DIM does not currently provide automatic workspace cleanup after PR merge,
one-shot workspace wrappers, or disk quota. Those orchestration policies can
be added on top of the workspace lifecycle without introducing a second
execution model.

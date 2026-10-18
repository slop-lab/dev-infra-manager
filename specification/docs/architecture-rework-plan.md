# Architecture rework plan

Status: working design and implementation sequence, not a stable API contract.
Source baseline: `development` at `14d3564794846848b2af37f3429b28ef2028f08e`.

## Product direction

DIM should make persistent remote development convenient, with practical
isolation between development workloads and the host. Only the published
`@slop-lab/dim-installer` facade is a compatibility boundary for this work.
Existing internal APIs, storage schemas, command names, service layouts and
specifications may change together. Specifications describe the resulting
product; historical specifications are not reasons to retain unused machinery.

The control plane is optional. An ordinary Git repository must be enough to
start development without deploying native Git, a reviewer service, a scheduler,
CI images, role credentials or Project import proofs. Managed Git, review and
shared CI remain useful optional features and must have a natural installation
and connection flow. Optional means absent from the base dependency and startup
path, not merely disabled after loading.

This is a source rework. Do not upgrade the running host or discard its data as
part of a source refactor. Preserve the exported issue backup independently.

## Findings

The initial audit covered production packages, centralized tests, deployment
scripts, specifications and the exported open issues, including comments.

- `dim-core` combines workspace lifecycle, host administration, native Git
  clients and admission, ordinary execution, a second root-CI claim protocol,
  QEMU scheduling and their stores. Its public barrel loads optional services.
- `nativeRootCiHostExecutor` translates root-CI claims into ordinary claims,
  then translates renewal, reporting and recovery back. These are competing
  internal execution models, not useful user features.
- `controller.ts` mixes HTTP transport, authentication, runtime composition,
  Docker target resolution, Git brokering and workspace restart. `LifecycleState`
  mixes Project/workspace storage, grants, host state, mirrors and lock policy.
- Workspace commands use controller RPC while Project commands own stores and
  native clients directly in the CLI. There is no explicit remote host context.
- The current runtime distinguishes a trusted outer container and host-side
  untrusted Sysbox agent, but exposes a generic backend API supporting one
  backend. Custom lifecycle hooks can replace much of the default environment.
- CI YAML interpretation is repeated across host verification and native Git.
  Extension registration also knows concrete host-mirror policy, while plugin
  commands are hardcoded in the base CLI.
- Tests and verification mix useful real Git/process/HTTP behavior with source
  text assertions, historical schema contracts, pinned host-tool assumptions
  and expensive environment provisioning. A fixture Git version mismatch can
  obscure the behavior under test before it is exercised.

Moving files or adding subpath exports is insufficient. The important changes
are one owner per state transition, optional feature composition and fewer
internal protocols.

## Responsibility map

Physical packages follow these boundaries when they need independent deployment,
dependencies or optional loading. Do not create packages for every interface.

| Owner | Owns | Does not own |
| --- | --- | --- |
| Installer facade | Exact-version acquisition, component profiles, transactional install/update, service activation and recovery | Workspace operations, workflow syntax, project policy |
| CLI client | Commands, output, terminal streams, host contexts and SSH transport | Persistent domain state, Docker orchestration, service business rules |
| Workspace kernel (`dim-core`) | Project/workspace identities, lifecycle operations, resource intent, persistence semantics, narrowly scoped extension ports | Native Git admission, CI scheduling, YAML dialects, web sessions |
| Host application/composition | Local daemon, stores, grants, runtime/source providers, operation coordination and capability discovery | Independent copies of Project logic in each transport |
| Repository source | Local/remote ordinary Git, source snapshots and workspace checkout; optional managed-Git adapter | Mandatory native import/review policy for ordinary development |
| Runtime provider | Container/VM creation, exec, resources, volumes, stop/recreate/discard and recovery | Project tools, workflow syntax, Git approval policy |
| Optional Git authority | Managed repository identity, refs, proposals, review decisions and atomic promotion | Worker scheduling, workflow language, remote workspace orchestration |
| Optional execution | One job/attempt/lease/result lifecycle, shared capacities, execution recovery | Review approval, repository ownership, workflow parsing |
| Workflow plugin | Candidate configuration to normalized job plans and diagnostics | Host credentials, mounts, image acquisition authority, promotion |
| Service/integration plugins | Mirrors, published URLs, tool setup, LLM access, persistent VMs/tunnels | Access to unrestricted host control through agent-facing helpers |
| Web client/service | Authenticated presentation of the same application operations | A separate lifecycle implementation or browser-held host credentials |

Domain operations have one application entry point. CLI, HTTP and future web
interfaces call that entry point. Transport code validates envelopes and scope;
application code owns state transitions; adapters own Docker/Git/filesystem calls.
A small implementation may use in-process calls. HTTP is required at actual
process or host boundaries, not between every internal step.

## Base development path

1. Install the CLI/host profile through the existing facade.
2. Select a local or SSH host context. Paths and connection settings are stored
   once; users do not assemble several environment variables per command.
3. Create a workspace from an ordinary local path or Git URL. No `.dim` files or
   native control plane are required. Interactive input may fill missing values;
   unattended commands accept the same configuration explicitly.
4. List, connect, run tasks and publish a development URL using ordinary daily
   commands. Read-only inspection must not provision caches or services.
5. Restart/recreate while preserving checkout and home. Discard semantics name
   exactly which data is retained or deleted; they are not inferred from an old
   environment schema.

Source acquisition and access are separate from workload execution. A normal
repository does not acquire host secrets by being registered. Project-specific
trusted services/hooks require explicit operator configuration. Managed Git can
supply stronger proposal/review boundaries without becoming a prerequisite for
all development.

SSH is the first remote transport: use an existing authenticated host connection
and stream the same host operations through it. Do not expose an unauthenticated
HTTP admin endpoint. SSH/ProxyCommand access into the agent is tool-neutral;
Codex and other clients are examples rather than core responsibilities.

## Workspace and extension model

A workspace has identity, source, runtime selection, desired resources and named
persistent storage. Track observed runtime state separately from user intent.
Checkout, home, nested-engine storage and scratch have explicit lifecycle rules.
Recreation creates a new runtime/grant identity while retaining selected data.
Session continuation is an explicit process/service restart facility, not an
OpenCode-specific hook hidden in Project setup.

Separate runtime resources from agent-facing services. A backend-neutral helper
provides shell/exec, resource discovery, scoped service access and restart/session
requests. It must not depend on nested container names, an outer Docker daemon,
a specific tool or VM implementation.

Default lifecycle and declarative services should cover current examples and
self-development. Inventory actual advanced-hook uses before replacing them.
Keep a deliberate custom command escape hatch, not arbitrary hooks that silently
change the ownership and secret boundary of every lifecycle stage.

For ordinary development, target one unprivileged Sysbox workspace container.
The existing agent runtime already owns home, checkout and nested-engine volumes.
The trusted outer container currently exists for native Git relay, immutable root
and trusted Project lifecycle; it is not an inherent prerequisite for an ordinary
Git checkout. Moving those optional responsibilities out also removes the outer/
agent resource split and relay/phase coupling from the default path. Run normal
Project setup and Compose inside the isolated workspace. An optional trusted
service environment may still exist when the operator deliberately enables it.
Validate this change against the existing working agent implementation before
replacing runtime code.

The initial supported runtime remains the existing container mechanism. Implement
one honest adapter before adding a registry of imaginary backends. The VM issue
requires an actual KVM experiment with persistent disks, guest Docker, restart,
resource limits and memory return. Incus is a candidate, not an accepted dependency
or a security claim. VM management and QEMU CI execution are different features.

Plugin ports should be small and typed: repository source, runtime, service,
workflow compiler and commands where needed. Validate the extension at its
consumer; a generic registry must not contain host-mirror-specific rules.
Discover optional commands/capabilities without importing all optional runtimes.
Core must not depend on a concrete workflow or external-URL plugin.

## Optional control plane and execution

The facade keeps `installer install control-plane`. A managed local profile
should generate private role configuration, choose/probe ports, install services,
register the resulting context and report readiness. Advanced configuration
files remain available, but are not the only installation experience. Remote
attachment validates the selected service and stores a reusable connection.
Installation failure reports the failed stage and a concrete recovery action.

Managed Git can retain immutable review tuples and checked protected-ref updates.
Keep real controls: scoped credentials, explicit approval where selected, and
compare-and-swap protection against a changed head. Do not retain old schema tags,
multiple proof HTTPs or service generations merely because tests mention them.
Installer generation/rollback machinery is evaluated separately because it
protects actual installation state and is within the retained facade boundary.

Execution uses one normalized job plan and one attempt lifecycle. A lease binds
an attempt to a worker and deadline. Capacity stays fenced after lease expiry
until cleanup is known, and replay uses an explicit command/attempt identity.
Keep backend process/VM cleanup journals as operational state rather than new
business claim protocols. Results bind the attempt to exact candidate
bytes. Ordinary containers and QEMU guests are execution backends; they do not
need unrelated result/proof models. Workflow syntax belongs to a selected compiler
plugin, while trusted execution policy controls resources, images and privileged
inputs. Candidate-controlled CI results never imply human approval.

Share capacity across Projects. DIM base images contain execution plumbing and
cache integration; project build tools belong to job configuration. Cached base
images and persistent VM images have explicit ownership and update rules.

## Backlog integration

Issue numbers refer to the exported `dim-dim/root` issue set. Read historical
comments as evidence of requirements and prior progress, not current acceptance.
New product decisions above supersede mandatory-control-plane assumptions.

| Workstream | Exported issues | Treatment |
| --- | --- | --- |
| Daily remote development | #4, #6, #29, #31, #38, #44, #48 | Design the no-configuration workspace, tool-neutral SSH/session/service APIs and generic tool setup together. Keep stable service labels separate from runtime identity. |
| Workspace lifecycle and diagnostics | #8, #11, #15, #22, #49, #55, #56 | Verify existing progress first; own restart/recreate/storage/process cleanup in runtime/application layers. Reassess obsolete Gitea symptoms as generic endpoint/recovery checks. |
| Runtime and resource model | #24, #34, #37 | Model resources and agent operations independently of container/VM. Preserve working resource discovery, add unlimited semantics intentionally, validate VM behavior empirically. |
| Mirrors, execution capacity and images | #1, #3, #27, #35 | One execution model, shared base images, plugin-owned mirrors and ordinary-user cache routing. Do not turn bypass resistance into a new strong egress-security requirement. |
| Optional managed Git, UI and install | #40, #41, #45 | Reuse working Git/review behavior behind optional composition, keep facade behavior, make install/connect usable, build UI on application services. |
| Development URLs and tools | #32, #39, #50, #52 | Scoped service publication, explicit scratch storage and generic tool bootstrap; OpenCode configuration lives outside core. Recheck implemented pieces before adding replacements. |
| Reusable environment verification | #47 | A plugin can exercise Project lifecycle through the same public operations. Avoid building another scheduler or requiring DIM-specific repositories. |
| Future services | #51, #53, #54 | Support scoped service/secret adapters in the design. LLM router attachment is design input, not an obligation to implement a new router during cleanup. Persistent VM service is distinct from VM workspace; tunnels remain deferred unless needed. |

All 32 open issues are represented. Keep original JSON, comments and attachments
unchanged. Track adopted work and acceptance evidence separately; do not declare
an issue complete merely because its implementation appeared in an old branch.

## Implementation sequence

1. **Establish the architecture and baseline.** Record this responsibility map,
   backlog classification and real test/capability matrix. Treat early edits as
   candidates, not an architecture already adopted. Keep changes reviewable.
2. **Deliver the base vertical slice.** Workspace from ordinary Git, explicit host
   context, default lifecycle and shell/exec/list/stop/recreate without native
   services. This validates the kernel/source/runtime split before package moves.
3. **Consolidate host ownership.** Move Project operations behind the same host
   application service as workspace operations. Split stores and grant ownership,
   parse state completely at storage boundaries, separate HTTP routing and host
   composition. Add SSH transport and the scoped agent interface to those ports.
4. **Extract optional features.** Move Git authority and execution out of base
   imports/dependencies; consolidate competing execution state machines before
   relocating their files. Wire workflow, mirror and URL providers at composition.
5. **Make setup and everyday operations natural.** Facade profiles, context
   discovery/attachment, plugin commands, declarative environment/services,
   recreation/session resume, generic tool examples. Fold matching backlog work
   into these changes instead of opening parallel implementations.
6. **Validate runtime extensions and broader UI.** Container lifecycle first;
   disposable KVM VM experiments and shared-worker tests where appropriate.
   Optional UI calls the same services. Large new services remain explicit work,
   rather than expanding a refactor into an unrelated product implementation.
7. **Remove superseded code and contracts.** Delete old active protocols,
   compatibility branches, misleading backend abstractions, unused public exports,
   obsolete docs and tests. Re-audit dependencies and the user journeys after
   every substantial slice; repeat where a concrete ownership problem remains.

Each slice includes implementation, affected packaging, focused behavior tests,
examples and documentation, then an intermediate commit. A new package is useful
only if it creates a real deployment, optional-dependency or ownership boundary.

## Validation and stopping criteria

Test behavior at the owner of the behavior: state transitions and persistence,
transport/terminal cancellation, resource and ownership rules, real Git/ref races,
install/update failure recovery, and scoped agent access. Keep a small number of
end-to-end journeys that cross the actual components. Remove source-string and
function-count assertions. Runtime-specific deployment pins must not turn an
otherwise generic Git integration fixture into a test of the host's exact Git
version.

Use disposable names, directories and environments for live tests. Report
container, KVM and remote-host coverage separately. A mocked process test does
not establish real container isolation or VM memory behavior. Do not provision
whole VMs for tests that require only a real Git repository or local HTTP server.

An implementation pass is ready when the base path runs without optional
services, enabled features install/connect naturally, domain state has one
owner, the dependency graph reflects optional features, and relevant behavioral
and capable-host checks pass. Record remaining concrete issues. Do not claim
that an arbitrary large codebase has no possible further improvements.

## Implementation checkpoints

- Responsibility/backlog plan recorded in `6b4d81f2`.
- Host contexts and stdio transport: `16bef988`.
- Ordinary Git, one-container workspace lifecycle and CLI vertical slice:
  `0fde8eb3`. Real Sysbox and CLI data-preservation/cleanup checks passed.
- Optional installation and active-controller recovery: `004e724d`.
- Real SSH-host lifecycle evidence: `50844092`; source existed only on the
  selected remote host, with stdin/status and persistent data verified.
- Physical optional-package extraction and independent state/image namespaces:
  `7c6ccdd2`. The base package has no production dependencies or service binary.
  This extraction checkpoint made the base deployable before the deeper managed
  model consolidation; relocation alone is not considered that consolidation.
- Local installation selects an exact transitive dependency closure, preserving
  explicit integrations without installing every bundled artifact: `067d6d9b`.
  Actual tarball installs verified base-only and optional managed graphs.
- Removed the unused standalone CI authority/worker branch and its tests:
  `909aa8fd`. The current root execution path retains meaningful cleanup, lease,
  replay, cancellation and fencing verification.
- Generic workspace TCP connect/forward: `65ed4dd7`; actual SSH/Sysbox binary,
  concurrent connection, half-close and in-container cancellation cleanup:
  `c49107e0`. Listener binds client loopback and pins the workspace UUID.
- Workflow language extraction and neutral plan injection: `98dc66f4` and
  `647040d2`. The selected plugin, Git object authority and runtime verifier
  have separate responsibilities.
- Optional control-plane preparation, live generation checks and scoped role
  connections: `9fa0943f`, `0519fb08`. Reviewer web uses the installed human
  review API (`2d9055f3`); private initialization and actual Chromium proposal,
  diff, approve/revoke, expiry and stale-generation checks passed (`adaab5dd`).
- Managed source uses the core's single Sysbox workspace and scoped host broker:
  `8892c26a`. Real proposal/lifecycle/data checks and post-promotion fetch plus
  another proposal in the same workspace passed (`b51a3fe7`).
- Optional controller and URL targets use the core UUID/state and revalidate
  new connections: `ce66fb85`. Actual Sysbox byte relay, concurrent binary data,
  half-close, name reuse denial and cleanup passed.
- Removed the parallel workspace/host lifecycle, outer image, controller RPC
  sessions and obsolete state contracts: `aec19847`; 85 CLI tests passed. Shared
  runtime documentation and obsolete acceptance retirement: `eb5da2f1`.
- Source `--with-managed` installs the library without implicitly selecting
  plugins or starting a controller: `bd10c47c`. Base and managed sources use
  the same workspace image and runtime.
- Fresh host provisioning no longer writes unused backend selection state;
  login/resume and foreign-state protections pass 24 tests: `a11dabb9`.

- Host-local saved control-plane selection: `08aa7855`; existing managed
  workspaces reconnect only after same-authority/Project/ref/policy proof:
  `05f98e35`. The real service generation-rotation test passed.
- Optional administration follows local/SSH host selection, including clients
  with only the base package: `299c36a2`. Real SSH preparation created private
  control-plane files only on the selected host; runtime/forwarding checks passed.
- Explicit self-development tasks replace the privileged nested self-Project
  framework and obsolete templates: `e3f625e8`. Standalone KVM service mechanics
  remain separate from a workspace adapter.
- First execution consolidation: `2ebc6f1a`. Ordinary execution uses one durable
  aggregate, cleans before capacity reuse and publishes results independently.
  Actual HTTP/Git latest-result and checked-promotion integration passed.
- Installer private service credential pairing uses the unified CI roles while
  retaining facade deployment syntax and transaction behavior: `b6fc02d6`.
  Installer behavior suites passed 302 tests, with one existing skipped case.

- One durable execution aggregate, indexed queue, backend interface and worker
  now serve Sysbox and QEMU: `52b969d3`. Generation-bound intake, current lease
  fencing, result recovery and bounded diagnostics replace parallel authorities.
- Remove unused controller proxy and close source artifact dependency graphs:
  `41e476e5`. Workflow compilation is included in actual source archives.
- Revalidate published targets per connection and restore stored routes lazily
  across stopped/recreated workspaces: `5cadde78`, `6cdf5b8a`, `10f56545`.
  Real Sysbox HTTP/TCP, ownership and bidirectional half-close checks passed.
- Remove standalone legacy Git registries and policy fallback: `1aecbb66`.
  Current imported policy and Git object/ref checks retain explicit authority.
- Add operator job summaries and bounded binary logs with a dedicated query role:
  `6534d25d`. Saved connection setup remains usable while CI is offline.

Persistent VM workspaces and the larger LLM/router service remain separate
product work; their requirements are represented in the issue map without
claiming implementation. No KVM device is available on this host, so actual
QEMU guest execution requires the separate disposable KVM verification host.

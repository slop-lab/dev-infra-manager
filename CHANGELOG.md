# Changelog

All notable changes to this project are documented here.

## [Unreleased]

Target: `0.10.0` internal development candidate. No publication or deployment
is implied by these source changes.

- Split managed Git into independent repository, code-review, merge-policy,
  Git CI and webhook control-plane plugins. Repository hosting no longer
  requires review, CI or a workflow compiler. The managed deployment preset
  composes the full workflow, while repository policies explicitly select
  their features. Host policy transport and control-plane lifecycle remain
  independent of feature implementations. Approvals bind the complete policy;
  changing it requires renewed approval. Add mandatory reviews for paths or
  specific JSON fields and extend matching through named providers. Project-owned
  matchers can change, but an independent rule requires review of their own code
  and settings; their output cannot waive that review. Optional brokered review
  tracing protects observed imports and configuration reads automatically, while
  explicit target reads support field-level decisions. A shared tracing library
  and separate control-plane/runtime plugins keep language execution outside
  the review service; the Node adapter runs without a repository mount or
  credentials in disposable Docker containers. Read evidence participates in
  review identity and is rechecked before promotion. Support TypeScript detectors
  with original-source dependency hashes and optional dispatch through the existing
  scheduler to a host task handler. CI and detector tasks share durable scheduling,
  lease fencing and worker recovery. General execution uses the named scheduler
  and worker plugins and `dim execution worker`; CI contracts retain CI-specific
  messages, while execution contracts own shared scheduling data. Plugin author
  APIs use explicit `/plugin-api` entrypoints. Execution hosts receive bounded file reads
  instead of repository or approval credentials. Compose named protected-ref
  update constraints at the repository boundary,
  alongside non-rewritable history, current approvals and quality evidence.
  Restart recovery never replays an unapplied authorization. Use `--policy` with
  the namespaced
  repository policy file and the separate `dim-code-review` and
  `dim-merge-policy` operator clients.

- Manage independent Git repositories in one Project with separate imports,
  proposal credentials, reviews and protected-ref promotion. Select workspace
  checkouts and their default directory; CI binds allowed repository inputs to
  exact commit/tree snapshots without granting unselected repository access.
  A runnable public/private example links its reviewed files to Git/CI and
  workspace runtime verification; example recipes identify required optional
  plugins and services.
  Scoped Git credentials account for request latency without requiring exactly
  synchronized clocks between the control plane and workspace host.
  Examples own executable recipes, repository templates and development/check
  scripts. Both lightweight integration and fresh-VM workspace acceptance use
  those declarations. Run heavy VM acceptance before merging to main or
  releasing, independently of development push checks. The acceptance gate runs
  the control plane and host in separate simultaneous VMs and can launch from
  a DIM workspace with the optional KVM runtime; its preflight reports actual
  KVM VM creation, tooling and resource requirements.
  Fresh VM installation inherits selected workspace package mirrors and reuses
  pinned bootstrap binaries from a shared SHA256 cache, with explicit direct
  routing when no cache was selected. Retry stalled or temporarily unavailable
  artifact downloads while retaining digest verification.

- Develop ordinary Git repositories on local or SSH hosts without installing a
  control plane. Use `dim ls`, `create`, `exec`, `connect` and `forward` directly.
  Persistent Sysbox workspaces preserve checkout, home, private Docker data
  and a private temporary volume across recreation, with explicit resource
  limits, tool-neutral SSH and scoped in-guest lifecycle/session helpers.
  Select the optional `container-kvm` host runtime to run QEMU inside a
  workspace through an explicit operator-owned device grant.
  Concurrent service resume keeps one supervisor and workload across atomic
  owner-record replacement.
  Installed host plugins prepare their guest clients without repository
  configuration; agents discover commands and readiness inside the workspace.
  Share bounded, identity-checked file delivery across integrations, including
  explicitly selected containers in the workspace's private Docker engine.
  Enabled host plugins own custom source acquisition and Project metadata;
  long-lived hosts follow promoted plugin releases without borrowing ambient
  packages from an ancestor installation.
- Install managed Git, human review, shared CI and service plugins only when
  selected. Keep the `@slop-lab/dim-installer` facade, exact component graphs
  and transactional install/activation recovery. Prepare initial CI capacity
  and connect generation-bound worker configuration without hand-writing
  credentials. Source installs retain the
  matching installer and select it through mise for subsequent operations.
  Local source installation also configures the authenticated Web UI in a
  separate runtime, starts a loopback user service when available, and retains
  its browser account across repeat installs. Local removal stops and removes
  the owned Web UI service.
  Install `dim-host-plugin-*` capabilities on workspace/CI hosts and
  `dim-control-plane-plugin-*` services in an independent runtime without
  host core through `installer install control-plane plugin`. Native Project
  commands use `dim project`, CI workers use `dim execution worker`, and operator
  deployment/query commands use `dim control-plane`. The base host core owns
  the generic controller; neutral CI contracts keep workers independent of
  Git server implementation packages.
  Validate deployment installation against its selected configuration and
  current owned resources.
  Install selected host plugins from a matching local package bundle with
  their complete dependency closure. Build service images from temporary
  contexts containing only selected compiled packages and image inputs.
- Use the same workspace lifecycle for ordinary and managed Git sources.
  Remove the separate trusted outer container, duplicate host/workspace state,
  unused controller RPC/session paths and predecessor compatibility machinery.
- Separate workflow compilation, Git authority and execution responsibilities.
  Candidate scripts never gain host, review or protected-ref authority. Inspect
  CI jobs and bounded diagnostics through a separate read-only query role.
- Provide the separate `dim-web` console for workspace creation,
  lifecycle and resources, with explicit Web plugins for LLM router governance,
  execution diagnostics and authoritative Git review. Shared validated operation
  clients connect CLI and Web to the same service authority without requiring
  host or control-plane implementations in the console. Discover installed CLI
  plugin commands through root help. Separate
  read, operator and reviewer roles. Organize workspaces by host, disclose
  creation and advanced settings on demand, preserve drafts across refresh and
  failed operations, and provide scoped recovery and explicit discard cancellation.
  Login origin failures identify the configured console URL.
  Keep unrelated features usable when a service is unavailable; reconnect a
  configured feature without losing drafts. Distinguish accepted changes from
  failed follow-up reads. Local source installation includes the feature panels
  while preserving accounts and explicit connection choices.
  Deliver external Git events through signed,
  durable webhook subscriptions with bounded retry and restart recovery.
- Keep LLM routing/account governance, Incus VM workspaces and SPICE consoles,
  durable TCP/UDP tunnels, mirrors, agent tools and disposable workspace checks
  in optional plugins. Fence guest capabilities by current workspace UUID;
  control-plane router plugins own backend keys and usage, while the separate
  host router adapter owns workspace fencing and guest gateway tokens.
  Configured workspace OpenCode/OMO
  helpers use that router by default. Separate Docker/npm/PyPI/APT cache clients
  from optional host cache servers; external cache URLs use the same client path.
  Select cache protocols independently and install additional protocol adapters.
  Refresh or retire cache defaults in running workspace and nested-container
  configuration without replacing their bound files. Registered ingress drivers
  retain their own configuration and lifecycle through controller restart.
  Reviewed VM image downloads share a resumable checksum-verified host cache.
  Publish the versioned OpenCode static UI
  automatically from `main` and `development` through GitHub Pages.
- Add a separate Tailscale host plugin with a host-owned authenticated gateway
  for workspace and nested-agent IPv4 tailnet routing and DNS. Keep VPN state,
  credentials and control sockets outside guests; preserve private workspace
  bridges and reconcile networking through shared host lifecycle hooks. The
  optional External URLs ingress driver uses the host's existing Tailscale node
  independently. Local uninstall/reinstall retains LLM router accounts,
  authentication, history and captures, plus Tailscale gateway identity and
  state, regardless of package cache retention; owned runtime processes and
  gateway containers/networks are replaced.
- Document `.dim` file ownership and activation explicitly. Native Git's
  reviewed manifest contains branch policy, namespaced feature declarations and
  explicit upstream/publication mappings. A separate control-plane Git-sync
  plugin fetches read-only upstream tracking refs, creates merge proposals and
  publishes authoritative protected commits without force. DIM maps managed
  `main` to GitHub `development`; `.dim/` changes require `owner` approval while
  ordinary changes need no human approval. Import selects repository policy
  explicitly; ordinary workspace creation does not apply it. Remove retired
  repository-set connection and bulk-creation helpers.
- Extend the security-review example with separate agent-dind and secure-dind
  daemons. A reviewed `.dim` boundary selects secret access; only secure-dind
  receives the read-only operator secret. Real container and Git/HTTP checks
  cover secret isolation, review-required boundary changes and ordinary changes
  promoted without human approval.
- Align documentation and disposable verification with the current architecture;
  remove tests and gates that enforce retired internal contracts. Preserve the
  exported issue backup and map its 32 open issues into the architecture plan.
  Local and CI source checks show concise failure reports and retain private
  per-stage logs for diagnosis.

## [0.8.0] - 2026-08-19

### Changed

- Added installer-owned plugin enable, disable, and removal commands, and made
  local plugin tarballs durable under the managed runtime so CLI replacement
  never depends on a caller's temporary build path.
- Grouped verification, CI, and ephemeral GitHub runner recipes into `just`
  modules. Commands now use the namespaced `just verify ...`, `just ci ...`,
  and `just runner ...` forms. Automated Ubuntu paths enable module support for
  the distribution's older `just` package.
- Added local package bundle installation through the DIM installer facade.
  `just install-dim-local` now preserves a mise-managed
  facade automatically and retains its direct-PATH fallback when mise is not
  available.
- Added a dedicated host-mode label for the container-integration workflow
  job and made `ci runner enable` replace its stored provider registration so
  runner label changes take effect. The host mode is scoped to the isolated
  runner container; ordinary checks remain in disposable job containers.
- Rephrased the interactive installer's local symlink question so `Y` and
  Enter both select the recommended mode, including mise's facade-managed
  default.

### Fixed

- Unified the CLI, core, and plugins in one stable `runtime/current` npm
  project. Replacements are installed and verified in staging, failed switches
  restore the previous runtime, and exact core peer dependencies let npm reject
  incompatible plugin combinations before activation.
- Split automatic GitHub and Gitea CI definitions. GitHub now runs only
  lightweight Node.js type checks and tests without APT or Docker setup;
  Gitea remains the complete automatic CI authority, and GitHub's manual
  Sysbox and KVM release workflows retain the heavier release gates.
- Disabled Docker 29's containerd snapshotter in every Docker-backed workspace
  so fresh workspace engines keep image data in DIM's managed volume and
  preserve rootless-DinD UID/GID helper privileges. Official examples now also
  install and verify the helpers' setuid fallback.
- Made CI runner state reads and listings validate their schema 1 contract
  instead of incorrectly requiring the project/workspace schema version 3.

## [0.7.0] - 2026-08-16

### Added

- Added managed Caddy static upstream routes for exact hostnames beneath an
  ingress wildcard domain, with origin-only URL validation and precedence over
  dynamic workspace routes.

### Changed

- Grouped workspace lifecycle commands under `dim workspace`; only the
  frequently used `dim run` and `dim exec` forms remain as top-level aliases.
  Added `workspace align` to switch a clean root checkout back to its
  configured ref without running Project setup or recreating containers, with
  an explicit `--reset --yes` mode for discarding local commits on that branch.
- Made `project create --bootstrap-git-url` read the selected external ref's
  `.dim/repos.yml` before creating Project state, so repository code fixes the
  root alias and policy instead of duplicating them on the command line.
- Delegated Project-owned threaded CPU/PID cgroups inside the canonical
  self-development agent. Ordinary `bash` tasks retain a responsive default
  execution path while Codex and its descendants run in a separately tunable
  child, still bounded by the workspace-wide CPU, memory, and PID limits.
- Added a workspace `hostAliases` registry to the read-only Project manifest
  and applied it to the canonical agent through a generated Compose override,
  so nested services can resolve approved DIM-managed endpoints such as
  `dim-gitea` without hard-coded addresses or copying the workspace hosts file.
- Persisted the canonical development agent's home in a Project-owned named
  volume so Codex configuration and other home state survive separate task
  invocations and agent service recreation until workspace discard.
- Reduced the canonical self-Project task surface to `codex` and an explicit
  agent-container `bash`; repository just recipes now run through the bash
  task instead of duplicating recipe-specific entrypoint aliases.

### Fixed

- Derived the host-facing Gitea endpoint from a remote TCP `DOCKER_HOST` so
  containerized CI jobs reach the Docker daemon host instead of mistaking
  their own loopback for it.
- Skipped RootlessKit AppArmor profile loading in containerized CI jobs that
  can see the host restriction sysctl but cannot access its securityfs policy
  interface.
- Treated short root branch names such as `main` as equivalent to their full
  `refs/heads/main` form when checking `project create --bootstrap-git-url
  --bootstrap-git-ref` against the
  root repository manifest.
- Ran the complete agent-container gate inside the disposable runc KVM
  self-Project verification, including its private rootless-DinD behavior.

## [0.6.0] - 2026-08-12

### Changed

- Split complete examples into single- and multi-repository Project shapes.
  The new default example intentionally uses no `.dim/repos.yml`, protected
  ref, or secret service while demonstrating a resource-bounded workspace,
  unprivileged agent, private rootless DinD, and an optional external URL.
- Added a root-aware `project create` workflow that imports the root, offers
  its managed `.dim/repos.yml`, supports explicit apply/skip choices, and
  points skipped applications at the clone-free `repo apply` path. Matching
  failed root imports can be retried with the same root alias and origin;
  managed-root manifests reject ambiguous relative filesystem URLs and local
  manifest inputs never replace the tracked root file.
- Made the npm installer facade bootstrap itself through `mise exec node@24`
  when Node.js 24 or 26 is not already on `PATH`, so a mise installation no
  longer requires Node.js in the global mise configuration. The documented
  mise install uses `--raw --global` so the low-download review prompt and its
  `Y` response remain visible.

## [0.5.0] - 2026-08-06

### Changed

- Extended disposable runc QEMU verification to exercise the canonical DIM
  self-Project, its private rootless-DinD sidecar, and the installed
  RootlessKit AppArmor profile together.
- Made the private agent/DinD shared bind area work when the unprivileged agent
  and rootless-DinD sidecar use different host UIDs.
- Simplified Cloudflare DNS record arguments to `zone`, `value`, and
  `proxied`; record type is inferred as A, AAAA, or CNAME from the value.
- Made Linux the explicit host platform and moved the default managed
  controller to a systemd user service with journald logging and rotation.
- Made Caddy ingresses controller-managed: DNS and the Caddy container are
  reconciled automatically, while the internal router port remains runtime
  state instead of being stored in the ingress argument.
- Added `repo delete --yes` for deleting an unused non-root repository from
  Project metadata and managed Gitea.
- Made `repo add --root` promote an already imported matching repository when
  the Project does not yet have a root.
- Added reusable external repository synchronization: `repo fetch` projects
  external branches under managed `upstream/*`, and `repo push` publishes only
  explicit non-forced branch or tag refspecs.
- Limited the default `repo add URL` import to branches and tags; copying every
  source ref now requires `--mirror`.
- Added `dim ci runner` lifecycle commands for a Project-scoped isolated
  container runner, with configurable inherited resource defaults and a
  provider-neutral coordinator boundary. The managed Gitea adapter registers
  one organization-scoped runner so every Project repository can use it.
- Returned development-agent ownership to Projects: `.dim/setup.sh`, Compose,
  and `.dim/entrypoint.sh` now define and dispatch agent services without a
  core-managed `.dim/agent.json` resource.
- Moved the canonical Project agent onto an unprivileged container backed by
  a private rootless-DinD sidecar instead of running the agent itself as a
  privileged nested-Docker container.
- Organized examples around a canonical multi-repository `examples/project`
  and capability-focused `examples/features/*` examples.
- Added a common example verifier with current-host and disposable QEMU
  backends, explicit dirty-checkout policies, and automatic `repos/<alias>`
  Git fixture materialization and registration.
- Added `dim workspace resources` to change CPU, memory, and PID limits on an existing
  running or stopped workspace without recreating it.

### Fixed

- Prevented concurrent managed controllers from overwriting an active
  controller's PID and Unix sockets, cleaned up controller runtime files after
  startup failures, and treated a missing process during restart as already
  stopped.

## [0.4.0] - 2026-07-30

### Changed

- Added `dim doctor configure-backend [BACKEND]` to verify and record an
  installed workspace backend, with interactive selection when needed.
- Made external URL ingress driver arguments optional at the CLI boundary.
- Made Cloudflare an independently installed
  `@slop-lab/dim-plugin-dns-cloudflare` extension and clarified the Caddy
  ingress provider reference as `dnsProvider`.
- Rejected Caddy ingress registration when its named DNS provider is not
  configured.
- Replaced the flat External URL provider commands with
  `external-url dns-provider add|list|remove`.
- Made DNS provider configuration a driver-owned opaque argument. Cloudflare
  provider instances now contain only credential connection settings, while
  Caddy ingress arguments own domain-specific DNS record policy.
- Store the Cloudflare provider's actual `credential` in the mode-`0600`
  External URL config, omit provider arguments from list responses, and render
  the generated Caddy `.env` directly.
- Made Caddy `listenHost` and `listenPort` describe the external HTTPS
  listener. The driver now allocates its loopback HTTP router internally and
  no longer opens an HTTP redirect port.
- Consolidated direct HTTP and Caddy HTTPS ingress handling in the External
  URLs plugin around one hostname route registry; the separate
  `@slop-lab/dim-ingress-caddy` package is no longer needed.
- Replaced generated service names in URL requests with explicit relative
  `subdomain` requests. The default policy requires the authenticated
  workspace prefix, while an ingress can opt into a fail-closed HTTP(S) or
  Unix-socket policy webhook.
- Added a general named plugin-extension registry. External URL DNS providers
  now register a driver contract instead of becoming dependencies of the
  External URLs plugin.
- Serialized External URL route mutations so concurrent automatic subdomain
  requests receive distinct names.

### Fixed

- Made `dim doctor` report missing backend configuration instead of exiting
  before diagnostics run.
- Treated an External URLs plugin with no configured ingress as a normal empty
  state instead of warning during controller startup.
- Returned plugin-originated user input failures as HTTP 400 responses even
  when plugins load a separate copy of DIM core, and linked ingress validation
  errors to the relevant configuration documentation.
- Removed the state-root hash from default managed-controller socket paths;
  custom state roots remain hash-namespaced to prevent collisions.
- Prevented clients from spoofing forwarded proxy metadata, removed
  hop-by-hop upstream headers, and bounded route-policy webhook responses.

## [0.3.0] - 2026-07-30

### Added

- Added Project-scoped repository sets. `repos.yml` maps stable aliases to
  arbitrary host-Git URLs, and `project create --repos`, `repo plan`, and
  `repo apply` provide reviewed bulk registration without treating the file as
  a Project manifest.
- Added the `@slop-lab/dim-controller-proxy` package and a workspace-side
  controller proxy helper. Root repositories can expose only selected
  controller capabilities to development containers through a private Unix
  socket.
- Added controller HTTP APIs for DIM management commands other than
  interactive `run` and `exec`, plus controller restart support.
- Added local package tarball generation for examples and self-development,
  and a `just ci-matrix --manual` entrypoint that reproduces automatic and
  manually dispatched GitHub Actions workflows.

### Changed

- Replaced separate repository create/import flows with Project-scoped
  `repo add`, `repo plan`, and `repo apply`. Repository aliases come from
  `repos.yml` mapping keys, while external Git transport runs through the
  invoking host Git CLI and its existing authentication.
- Added standalone `project create --repos` registration and optional
  discovery of a managed root's `.dim/repos.yml`.
- Redesigned external URLs around host-shared named ingresses. Drivers own
  their opaque string arguments, automatically allocate listener ports when
  requested, generate workspace-qualified public names, and remove routes
  with their workspace.
- Moved DIM configuration and state under DIM-specific roots rather than the
  organization-wide `slop-lab` directory.
- Changed workspace KVM handling to automatically pass a host `/dev/kvm`
  character device and its numeric group to supported trusted backends.
  gVisor remains KVM-free.
- Changed package dry-run and local tarball creation to use pnpm consistently.

### Fixed

- Made an absent external URL configuration resolve to an empty configuration
  instead of crashing plugin discovery.
- Fixed workspace controller startup so users do not need to launch it
  explicitly and avoided controller TCP port conflicts by using Unix sockets.
- Fixed self-development KVM detection on GitHub runners where `/dev/kvm`
  exists but the runner process itself cannot open it.
- Normalized installer test paths on macOS where temporary directories acquire
  a `/private` prefix.

## [0.2.0] - 2026-07-29

### Changed

- Standardized package names under `@slop-lab/dim-*` and organized source by
  role under `packages/{core,cli,installer,contracts,plugin,ingress,provider}`.
  Only plugin API implementations use `dim-plugin`; package name prefixes are
  organizational and never enable implicit discovery.
- Node.js support now follows declared LTS release lines. DIM 0.2 supports
  Node.js 24 and validates Node.js 26 ahead of its scheduled LTS transition;
  package engines and CI cover both release lines.
- The default Sysbox layout now keeps the trusted privileged workspace and
  untrusted agent as host-side sibling containers. Reviewed
  `.dim/agent.json` files define the agent build context and fixed task
  commands; agents receive separate checkout and private-Docker volumes, no
  Docker control socket, and run without `--privileged`.
- Extended the Sysbox KVM installer smoke to run QEMU through a directly
  passed workspace `/dev/kvm`, prove the Project daemon has no Sysbox runtime,
  and run nested Docker in an unprivileged host-side Sysbox agent.
- Simplified repository URLs to `dim repo url [--workspace] PROJECT ALIAS`.
  The multi-repository example now uses short helper scripts, default
  workspace backend/profile behavior, interactive `bash`/Codex/Claude tasks,
  and a root-Compose secret service that dev can reach only through its HTTP
  interface while retaining a separate DinD daemon.
- Replaced external URL profiles, provider bindings, and provider-specific
  environment variables with provider-agnostic named ingresses. Each ingress
  now owns its public scheme/domain and internal reverse-proxy listener, and
  workspace requests select it with `ingress`.
- Added persistent `dim external-url` provider/ingress and workspace URL
  commands, a Cloudflare wildcard DNS adapter, a pinned Caddy HTTPS deployment
  generator, and automatic migration of stored profile/provider URL entries.
- Replaced the pre-stable `@slop-lab/install-dim` package with
  `@slop-lab/dim-installer`, renamed its executable from `install-dim` to
  `dim`, and renamed its `cli`/`plugin` subcommands to `install-cli`/
  `install-plugin`, so the installer and CLI resolve to the same command name.
- Made the installer a strict facade: it owns only `installer`,
  `install-cli`, and `install-plugin`, and proxies every other command
  (including `dim plugin`, a `dim-cli` command) unchanged to a separately
  installed `@slop-lab/dim-cli`, adding `DIM_INVOKED_VIA_INSTALLER`/
  `DIM_INSTALLER_VERSION` for display purposes only. See
  [Installer Facade](docs/specs/14-installer-facade.md).
- Added `--no-local-bin`/`--local-bin` install modes with a mise-aware
  default, a managed `~/.local/bin/dim` symlink that refuses to touch an
  unmanaged or pre-0.2 `dim`, and a combined `dim --version` line once a
  CLI is configured.
- Renamed the unprivileged account used by workspace-root images from `agent`
  to `dim` (`/home/agent` → `/home/dim`, `AGENT_UID`/`AGENT_GID` build args
  → `DIM_UID`/`DIM_GID`). The account belongs to DIM's controller/root
  environment; an actual coding agent runs in a separate child container.
  See [Trust Boundaries](docs/specs/02-boundaries-and-trust.md#host-and-workspace).
- `rootless-podman` no longer defaults its outer container to
  `--privileged`; it now receives the specific capabilities nested
  unprivileged user namespaces need instead (the same set already used for
  `gvisor`). Set `DIM_WORKSPACE_PRIVILEGED=true` to restore the old
  behavior if a host needs it. **This has not been verified against a real
  rootless-podman host** — it could not be exercised in this change's own
  development environment, whose own nested sandboxing already rejects
  nested user-namespace creation even under full `--privileged`, for
  reasons unrelated to this change. Validate with `just
  verify-host-backend-kvm rootless-podman` (now exercises the same
  capability set) and `DIM_WORKSPACE_BACKEND=rootless-podman bash
  verification/scripts/container-lifecycle-smoke.bash` before relying on it.

- Split the root `README.md` into user-facing content (installing and using
  `dim`) and [CONTRIBUTING.md](CONTRIBUTING.md) (building/verifying DIM
  itself), added a project glossary
  ([documentation index](docs/guides/README.md)) covering Project/Workspace
  scope and what "controller" actually refers to, and added `just cli` to
  build core and run `dim` from source without the
  `ERR_MODULE_NOT_FOUND`-if-core-isn't-built footgun of invoking `tsx`
  directly.

### Added

- Multi-repository project
  example, with independent
  real-container verification of its materialized repository skeletons.
- [External URL example](examples/features/external-urls/README.md), a copyable,
  dnsmasq-verified walkthrough covering a nested development container and a
  container inside it.
- Added plugin API v2 with an instance-scoped DIM controller route registry
  and ordered disposal.
- Added authenticated external URL routes on the general DIM controller and a
  local-build plugin with named reverse-proxy ingresses. Discovery exposes
  only ingress name, description, and external URL scheme.

### Fixed

- Every documented walkthrough (root README, `specification/docs/repo-workspaces.md`,
  `specification/docs/project-workspaces.md`, `specification/docs/usage.md`, `core/packages/cli/core/README.md`,
  the multi-repository example) showed `dim repo create ... --root` without
  `--protect`, then a bare `dim repo protect`. `--protect` only exists on
  `repo create`/`repo import`; omitting it there left `repo protect` with
  nothing to apply, and it reported success anyway — every literal reading
  of the docs left the root branch completely unprotected. All of them now
  show `--protect` at `create` time; the container workspace smoke test verifies
  a protected root actually rejects a direct push.

### Changed: Project workspaces

- Added first-class projects with project-scoped managed Gitea organizations
  and repository aliases.
- Replaced bare-repository registration with empty repository creation,
  optional import, host/workspace URL lookup, and optional Git credential
  wrapping.
- Made workspaces reference a project root repository and ref, with project
  changes applied on explicit update, start, or restart rather than while a
  workspace is running.
- Replaced the namespaced workspace CLI with concise top-level lifecycle
  commands and hierarchical Commander help.
- Made the Project root ref optional with repository `HEAD` fallback, added
  per-workspace CPU/memory/PID limits, and scoped JSON output to
  record-producing subcommands.
- Added `dim git setup`, Project-specific Git base URLs, and a smaller runtime
  manifest that leaves repository layout and nested containers to `.dim`.
- Removed automatic migration of 0.1 workspace state.

## [0.1.0] - 2026-07-24

### Added

- Provider-neutral DIM core APIs and a thin `dim` command-line package.
- Persistent Gitea-backed project workspaces with nested container support.
- Per-workspace Sysbox, gVisor, rootless Podman, and privileged-runc backend selection.
- Review-gated Git and secret-runtime deployment workflows.
- Versioned plugin API and standalone plugin installer.
- Container, lifecycle, multi-repository, packaging, and self-project smoke tests.

[Unreleased]: https://github.com/slop-lab/dev-infra-manager/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/slop-lab/dev-infra-manager/releases/tag/v0.1.0

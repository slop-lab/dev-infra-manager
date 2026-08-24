# Integrated Development Tree

## Integrated Layout

The archival checkout physically stages the repository boundaries while
retaining one Git history. The self-development `root` catalog publishes each
staged subtree independently and its reviewed lifecycle recreates the same
integrated pnpm tree from the Project runtime repository catalog. See
[DIM Self-development Boundaries](self-development-boundaries.md) for the
review model.

```text
.
├── .dim/                       extracted `root` bootstrap
├── repository-boundaries.json repository ownership contract
└── workbench/                  extracted `development` repository root
    ├── agent/                  agent development image
    ├── core/                   independently cloned `core` repository
    ├── core-development/       core unit and integration tests
    ├── plugin-*/               minimal buildable plugin source repository
    ├── plugin-*-development/   matching plugin tests and test tooling
    ├── specification/          documentation/specification repository
    ├── examples/               reviewed Project examples repository
    └── verification/           cross-repository and host verification
```

The `development` repository is the remaining `workbench` orchestration
and development-environment code. It contains no application source or tests.
`core/packages/cli` imports only the public
`@slop-lab/dim-core` entrypoint; core never imports the CLI.
Workbench-level `just` and pnpm commands forward to workspace packages for
operator convenience. Every tracked path is assigned by
`repository-boundaries.json`; longest-prefix ownership lets explicit child
repositories override the development owner of the surrounding workbench.
The contract records the target repository and stripped source prefix rather
than leaving migration layout to an ad-hoc history-filter command.

`core` owns only the files needed to install, check, build, and package its
production artifacts. Each plugin source repository follows the same rule.
Tests, fixtures, and test-only dependencies live in the corresponding
`*-development` repository and consume the source as a sibling checkout.
Cross-component, container, host, KVM, and example-flow checks live in
`verification`; runnable examples live in `examples`. The source gate
materializes every repository into siblings, verifies production repositories
without the development repositories, and then runs each paired development
suite. Consequently a reviewer can audit the exact production build inputs
without first trusting test or development-environment code.
Archive-only forge workflows remain outside the extracted source repositories.
Every managed repository uses `main`, mapped to its archive `dev/<alias>`;
only the self Project's `root/main` and `development/main` require protected-ref
review. Repository-specific CI policy can move with each destination when the
temporary branches become separate canonical repositories.

## Dependency Direction

```text
core/packages/cli ──> core/packages/core
core/packages/controller-proxy (Node built-ins only)
plugin-external-urls
  ──> core/packages/{core,contracts/external-url}
plugin-dns-cloudflare
  ──> core/packages/{core,contracts/external-url}
```

`dim-plugin-*` identifies a package that implements DIM's plugin API; DIM does
not scan npm names or filesystem prefixes to discover it. A project must
explicitly install and list every plugin. Reusable implementations stay in
`dim-*` packages so a plugin can compose them without making the
implementation itself a plugin. Plugins may register named extension
implementations, such as External URL DNS provider drivers, through the common
plugin host without adding dependencies to their consumers.

Disallowed dependencies:

- A shared contract importing a provider adapter.
- One package importing another package's private source.
- Provider-neutral code importing Gitea, Caddy, Cloudflare, or Tailscale
  implementation details.

## Optional Hosting Components

Git hosting and externally reachable entries are optional capabilities.
Configuration must select providers explicitly and disabling a capability must
not require its binaries, containers, credentials, or network access.

The current core contains one built-in managed Gitea service boundary.
External source and destination transport still runs through the host Git CLI
and is provider-neutral. A future replacement for managed Gitea must preserve
the Project/repository records, protected-ref boundary, and separate
host/workspace endpoint contract without leaking provider details into
Project-owned repository configuration. See
[DIM Development Repositories](development-repositories.md) for how that
replaceable managed host relates to the canonical public source repository.

The DIM controller API authenticates an agent workspace and lets installed
plugins register routes. External URL ingresses accept only a constrained
workspace target and derive the upstream from the workspace grant rather than
accepting an arbitrary host. Discovery exposes ingress name, description, and
URL scheme without leaking proxy or TLS implementation details.

The standard workspace image includes `dim-controller-proxy`. Reviewed root
lifecycle code can use its verified feature presets or Node.js API to expose a
new, policy-constrained Unix socket to a development container without
sharing the original controller socket or workspace grant.

## DIM self-development workspace

This repository uses the same project-facing contract as an external project:

```text
.dim/
├── dind/
│   ├── Dockerfile
│   ├── agent.sh
│   └── entrypoint.sh
├── docker-compose.yml
├── kvm.sh
├── setup.sh
├── entrypoint.sh
└── teardown.sh
```

The role-neutral `core/images/project-workspace` image is the trusted lifecycle
container. The reviewed `.dim/setup.sh` obtains the host Git author through
the narrow host-input API and starts only the repository-owned Compose
`private-docker` service. That rootless daemon creates the development agent
inside its own runtime. Its pinned `workbench/agent` image supplies Codex,
Node.js 24, pnpm, just, Git, and a Docker client connected only to the private
daemon; it receives neither the host Docker socket nor the trusted workspace's
Docker socket.

The outer lifecycle mounts a Project-owned named volume into the private
runtime, which bind-mounts it as the agent's `/home/dim-agent`. Separate
`dim workspace run` invocations therefore share Codex configuration and other user-home
state until the workspace is discarded; source remains in `/workspace`.

Create the split Project and a persistent workspace:

```bash
dim project create dim-self \
  --url https://github.com/slop-lab/dev-infra-manager.git \
  --ref dev/root
dim workspace create dim-self dim-self-dev
dim workspace run dim-self-dev codex
```

`run` dispatches the repository's checked-in `.dim/entrypoint.sh` task
contract into the Project-owned agent. The canonical contract deliberately
exposes only these tasks:

- `codex` starts Codex inside the unprivileged Project-owned agent container.
- `bash` starts Bash inside the unprivileged Project-owned agent container,
  not in the trusted workspace container.
- `backup` writes a gzip tar stream of the agent home to stdout, and `restore`
  reads that stream from stdin. Both stop the agent for consistency and use a
  networkless temporary container that receives only the named home volume;
  backup mounts it read-only and restore mounts it read-write. The Project owns
  the archive contract.

Use `bash -- -lc 'just RECIPE'` for repository recipes instead of adding a
task alias for each recipe.
`exec dim-self-dev -- bash` remains the raw trusted-workspace recovery or
interactive shell path. The agent bind-mounts the workspace checkout and its
private-Docker state uses a separate Project volume; no host checkout or
Docker socket is mounted.

On a host with accessible KVM, interactive creation recommends and confirms
exposing `/dev/kvm`; automation can use `--kvm` or `--no-kvm`. Run
`dim workspace exec dim-self-dev -- sh .dim/kvm.sh` to verify the
trusted workspace's effective KVM capability; `/dev/kvm` is intentionally not
passed to the ordinary agent. The `verify` agent task remains portable to
hosts without KVM.

## State And Credentials

- Application state is separate per service under the configured state root.
- Provider credentials are host-side secrets and are never placed in agent
  configuration, shared package source, or Git-managed route records.
- Git hosting, edge routing, tunnel credentials, and the root Docker
  controller use separate processes and least-privilege service identities.
- Machine-scope route reconciliation is trusted infrastructure behavior.

## Workspace Commands

Run the current manager verification:

```bash
just check-source
```

This verifies ownership and extraction, proves the extracted core repository
is self-contained, then runs the matching check, test, and build scripts in
the integrated development tree.

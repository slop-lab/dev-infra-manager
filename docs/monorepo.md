# Monorepo Structure

## Current Layout

This repository is a pnpm workspace.

```text
.
├── .dim/                this repository's DIM project contract
├── packages/
│   ├── core/            lifecycle, runtime, state, and plugin APIs
│   ├── cli/             executable command and output adapter
│   ├── installer/       installer facade
│   ├── controller-proxy/ restricted workspace-to-controller proxy
│   ├── contracts/
│   │   └── external-url/
│   ├── plugin/
│   │   ├── external-urls/
│   │   └── dns-cloudflare/
├── images/              runtime image definitions
├── examples/            copyable Project and feature examples
├── scripts/             verification and host-install helpers
└── specs/               normative behavior and local implementation details
```

The root package is workspace orchestration only. It contains no application
source or tests. `packages/cli` imports only the public
`@slop-lab/dim-core` entrypoint; core never imports the CLI.
Root-level `just` and pnpm commands forward to workspace packages for operator
convenience.

## Dependency Direction

```text
packages/cli ──> packages/core
packages/controller-proxy (Node built-ins only)
packages/plugin/external-urls
  ──> packages/{core,contracts/external-url}
packages/plugin/dns-cloudflare
  ──> packages/{core,contracts/external-url}
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
├── dev/
│   ├── Dockerfile
│   └── start.sh
├── docker-compose.yml
├── kvm.sh
├── setup.sh
├── entrypoint.sh
└── teardown.sh
```

The role-neutral `images/project-workspace` image is the trusted lifecycle
container. The reviewed `.dim/setup.sh` obtains the host Git author through
the narrow host-input API and starts the repository-owned Compose `agent`
service. The agent image supplies Codex, Node.js, pnpm, just, Git, and a
private Docker daemon without receiving either host Docker socket or the
trusted workspace's Docker socket.

The agent's `/home/dim-agent` is a Project-owned named volume. Separate
`dim workspace run` invocations therefore share Codex configuration and other user-home
state until the workspace is discarded; source remains in `/workspace`.

Build the image once, create a Project root, push this repository, and create
a persistent workspace:

```bash
just build-workspace-image
dim project create dim-self \
  --url /path/to/dev-infra-manager --ref development --apply-repos
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

On a host with accessible KVM, creation records and exposes `/dev/kvm`
automatically. Run `dim workspace exec dim-self-dev -- sh .dim/kvm.sh` to verify the
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

This runs the matching check, test, and build scripts in every workspace
package, including packages added later.

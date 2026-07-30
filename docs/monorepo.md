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
│   │   └── external-urls/
│   ├── ingress/
│   │   └── caddy/
│   └── provider/
│       └── dns-cloudflare/
├── deploy/              deployment manifests and service templates
├── images/              runtime image definitions
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
packages/{ingress/caddy,provider/dns-cloudflare}
  ──> packages/contracts/external-url
packages/plugin/external-urls
  ──> packages/{core,contracts/external-url}
```

`dim-plugin-*` identifies a package that implements DIM's plugin API; DIM does
not scan npm names or filesystem prefixes to discover it. A project must
explicitly install and list every plugin. Reusable implementations stay in
`dim-*` packages so a plugin can compose them without making the
implementation itself a plugin.

Disallowed dependencies:

- A shared contract importing a provider adapter.
- One package importing another package's private source.
- Provider-neutral code importing Gitea, Caddy, Cloudflare, or Tailscale
  implementation details.

## Optional Hosting Components

Git hosting and externally reachable entries are optional capabilities.
Configuration must select providers explicitly and disabling a capability must
not require its binaries, containers, credentials, or network access.

The 0.2 core contains one built-in managed Gitea service boundary. A future
gateway or external managed backend must preserve the Project/repository
records and host/workspace endpoint contract.

Gitea will be the recommended full Git-host provider, not a mandatory runtime
dependency. The built-in managed Gitea implementation remains a lightweight
provider, and other implementations such as Forgejo can implement the same
contract.

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
├── setup.sh
└── entrypoint.sh
```

The role-neutral `images/project-workspace` image supplies Codex, Node.js,
pnpm, just, Git, and an inner Docker daemon. It is the default outer image for
all DIM project workspaces, not an application-specific launcher.

Build the image once, create a Project root, push this repository, and create
a persistent workspace:

```bash
just build-project-workspace
dim project create dim-self
dim repo add dim-self root /path/to/dev-infra-manager \
  --root --ref development
dim create dim-self dim-self-dev
dim run dim-self-dev codex
```

`run` dispatches the repository's checked-in task contract.
`exec dim-self-dev -- bash` remains the raw recovery or interactive
shell path. The project checkout and inner-Docker state exist only in the
workspace; no host checkout or Docker socket is mounted.

On a host with accessible KVM, creation records and exposes `/dev/kvm`
automatically. `dim run dim-self-dev kvm` verifies the self-development
workspace's effective KVM capability. The ordinary `verify` task remains
portable to hosts without KVM.

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
just check
```

This runs the matching check, test, and build scripts in every workspace
package, including packages added later.

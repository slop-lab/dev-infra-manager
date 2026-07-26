# Monorepo Structure

## Current Layout

This repository is a pnpm workspace.

```text
.
├── .dim/                this repository's DIM project contract
├── packages/
│   ├── core/            lifecycle, runtime, Git, state, and plugin contracts
│   ├── dim-cli/         thin executable command and output adapter
│   └── install/         npx plugin installer
├── deploy/              deployment manifests and service templates
├── images/              runtime image definitions
└── specs/               normative behavior and local implementation details
```

The root package is workspace orchestration only. It contains no application
source or tests. `packages/dim-cli` imports only the public
`@slop-lab/dev-infra-manager-core` entrypoint; core never imports the CLI.
Root-level `just` and pnpm commands forward to workspace packages for operator
convenience.

## Dependency Direction

```text
packages/dim-cli ──> packages/core
packages/provider-* ──> packages/*-contracts
```

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
dim repo create dim-self root --root
git -C /path/to/dev-infra-manager push \
  "$(dim repo url-for-host dim-self root)" main
dim repo protect dim-self root
dim create dim-self dim-self-dev
dim run dim-self-dev codex
```

`run` dispatches the repository's checked-in task contract.
`exec dim-self-dev -- bash` remains the raw recovery or interactive
shell path. The project checkout and inner-Docker state exist only in the
workspace; no host checkout or Docker socket is mounted.

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

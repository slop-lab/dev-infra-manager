# Monorepo Structure

## Current Layout

This repository is a pnpm workspace.

```text
.
├── apps/                future deployable services
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
apps/*  ──> packages/*
packages/provider-* ──> packages/*-contracts
```

Disallowed dependencies:

- A shared contract importing a provider adapter.
- One application importing another application's private source.
- Provider-neutral code importing Gitea, Caddy, Cloudflare, or Tailscale
  implementation details.

## Optional Hosting Components

Git hosting and externally reachable entries are optional capabilities.
Configuration must select providers explicitly and disabling a capability must
not require its binaries, containers, credentials, or network access.

The intended future split is:

```text
packages/git-host-contracts
packages/git-host-bare
packages/git-host-gitea
packages/entry-contracts
packages/edge-caddy
packages/tunnel-cloudflare
apps/entry-api
apps/edge-controller
```

Gitea will be the recommended full Git-host provider, not a mandatory runtime
dependency. The existing bare Git implementation remains a lightweight
provider, and other implementations such as Forgejo can implement the same
contract.

The optional entry API will authenticate an agent job and accept only a
constrained service request. It must derive or validate the upstream from the
job grant rather than accept an arbitrary host from an untrusted agent. Route
providers and URL providers remain separate so one entry may expose local,
tailnet, and public URLs without coupling the API contract to one proxy or
tunnel product.

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

Build the image once, register a bare clone of this repository, and create a
persistent workspace:

```bash
just build-project-workspace
dim repo register --name dim-self /path/to/dev-infra-manager.git
dim workspace create dim-self dim-self-dev
dim workspace run dim-self-dev codex
```

`workspace run` dispatches the repository's checked-in task contract.
`workspace exec dim-self-dev -- bash` remains the raw recovery or interactive
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
just verify
```

Run matching scripts in every workspace package as packages are added:

```bash
just workspace-verify
```

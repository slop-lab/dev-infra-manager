# Monorepo Structure

## Current Layout

This repository is a pnpm workspace.

```text
.
├── apps/
│   ├── manager/         current host-side CLI and controller
│   └── codex-workspace/ host-side isolated Codex launcher
├── packages/            provider-neutral contracts and adapters
├── deploy/              deployment manifests and service templates
├── images/              runtime image definitions
└── specs/               normative behavior and local implementation details
```

The root package is workspace orchestration only. It contains no application
source or tests. Root-level `just` and pnpm commands forward to workspace
packages for operator convenience.

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

## Next Priority: Containerized Codex Workspace

Before adding Gitea or the entry API, the next implementation target is a
Sysbox workspace in which the Codex CLI itself runs. It should include:

- Codex CLI, Node.js, pnpm, and just. Host-side convenience commands may use
  mise, but the container image deliberately does not depend on mise or shims.
- The repository mounted at `/workspace` without the host Docker socket.
- A separate inner Docker daemon and image store.
- Outer CPU, memory, PID, disk, and timeout enforcement.
- Explicit, minimal handling for Codex authentication and Git credentials.
- A launcher that can start, inspect, and clean up the workspace without
  granting Codex direct control of the host Docker daemon.

This environment is the preferred place to implement the later Gitea and
optional entry-service work.

The initial launcher is available as `just codex-workspace`. Build and inspect
it with:

```bash
just codex-workspace build
just codex-workspace doctor
```

Authenticate into its dedicated home, then start Codex with full access inside
the outer Sysbox boundary:

```bash
just codex-workspace login
just codex-workspace run --yes
```

The launcher bind-mounts only the selected worktree, a dedicated Codex home,
and a dedicated inner-Docker store. It never mounts the host Docker socket.
CPU, memory, PID, and wall-clock limits are applied to the outer container.
Directory-backed state does not provide a hard disk quota; use the manager's
loopback storage backend when a hard aggregate disk limit is required.

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

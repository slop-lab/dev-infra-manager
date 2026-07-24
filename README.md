# dev-infra-manager

`dev-infra-manager` provides infrastructure for running AI-assisted development jobs in isolated, review-gated environments.

The project focuses on the container and infrastructure boundary around agent jobs:

- Ephemeral agent workspaces.
- Backend-selectable nested container isolation.
- Secret-bearing runtime separation.
- Review-gated deployment of secret-bearing environments.
- Managed Git hosting primitives for proposed changes.
- Job-level resource limits, including aggregate disk quota.

## Quick Start

Install dependencies and verify the TypeScript project:

```bash
pnpm install
just verify
```

Install host runtime dependencies on Ubuntu:

```bash
just install-host-ubuntu
```

Run `just` as your normal user, including when it is managed by mise. The
installer invokes `sudo` only for host changes. It also adds the invoking user
to the `docker` group; log out and back in or run `newgrp docker` once after
the first installation. If the entire recipe must run through `sudo`, a
mise-managed executable is also supported via
`sudo "$(command -v just)" install-host-ubuntu`.

The installer shows every package and host-level change before doing anything
and proceeds only after you enter `yes`. It is a development convenience, not
production hardening guidance. In particular, review its path-scoped AppArmor
exception for Sysbox FUSE mounts before using it outside a development host.

Install gVisor `runsc` for the no-KVM backend:

```bash
just install-runsc-linux
```

Or run the full Ubuntu bootstrap:

```bash
just bootstrap-ubuntu
```

Bootstrap prefers mise when available: it runs `mise install` and uses the
repository-managed Node.js, pnpm, and `just`. Hosts without mise fall back to
APT and the pinned global pnpm version.

Create a local configuration:

```bash
just sample-config
```

Build the included runtime images:

```bash
just build-agent-image
just build-secret-example
```

Run the reproducible integration smoke test:

```bash
just smoke
```

Run the fast static isolation check without Docker or container creation:

```bash
just isolation-check
```

Use `just isolation-check-json` for machine-readable JSON output.

Inspect host readiness:

```bash
just doctor
```

Prepare an agent job filesystem without making host changes:

```bash
pnpm run cli -- job prepare --config config.example.json --job-id demo --dry-run
```

Run a full agent job lifecycle:

```bash
pnpm run cli -- job run --config config.example.json --job-id demo -- bash
```

Run the deploy controller once in dry-run mode:

```bash
pnpm run cli -- controller run --config config.example.json --once --dry-run
```

See [docs/README.md](docs/README.md) for the full documentation index.
See [specs/README.md](specs/README.md) for implementation-oriented specifications.
See [docs/monorepo.md](docs/monorepo.md) for workspace boundaries and the
planned optional Git-host and ingress provider layout.

Register an existing bare repository with the local Gitea service and run a
persistent workspace whose checkout exists only inside its container:

```bash
just build-project-workspace
just install-dim-local
dim repo register --name project /path/to/project.git
dim workspace create project work-1 --profile development
dim workspace run work-1 codex
dim workspace exec work-1 -- bash
```

This repository implements the same project contract itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`. After registering a bare clone of
this repository, `dim workspace run work-1 codex` launches Codex in the
persistent DIM workspace; no separate workspace launcher is required.

The publishable CLI package is `@slop-lab/dim-cli`. Its source manifest remains
private; the build generates a consumer-facing manifest under `dist`:

```bash
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/dim-cli run publish:package
mise use -g npm:@slop-lab/dim-cli
```

See [docs/repo-workspaces.md](docs/repo-workspaces.md) for lifecycle,
credential, reconciliation, and container-only verification details.
See [docs/project-workspaces.md](docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle.

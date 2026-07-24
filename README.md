# dev-infra-manager

`dev-infra-manager` provides persistent, isolated, review-gated workspaces for AI-assisted development.

Licensed under the [MIT License](LICENSE). Release history is recorded in the
[changelog](CHANGELOG.md).

Before using DIM in another project, read the mandatory [adoption and trust
requirements](docs/adoption.md). They require full human review of DIM, the
project repository, and every secret-bearing environment, plus immutable
version pinning.

The project focuses on the container and infrastructure boundary around agent workspaces:

- Persistent, explicitly discarded agent workspaces.
- Backend-selectable nested container isolation.
- Secret-bearing runtime separation.
- Review-gated deployment of secret-bearing environments.
- Managed Git hosting primitives for proposed changes.
- Workspace-level CPU, memory, and PID limits.

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

Use `just smoke -- --verbose` (or `just smoke -- -v`) to show detailed output for each stage.

Run the fast static isolation check without Docker or container creation:

```bash
just isolation-check
```

Use `just isolation-check-json` for machine-readable JSON output.

Inspect host readiness:

```bash
just doctor
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
dim workspace create project work-1 --backend sysbox --profile development
dim workspace run work-1 codex
dim workspace exec work-1 -- bash
```

This repository implements the same project contract itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`. After registering a bare clone of
this repository, `dim workspace run work-1 codex` launches Codex in the
persistent DIM workspace; no separate workspace launcher is required.

The publishable packages are `@slop-lab/dev-infra-manager-core`, the thin
`@slop-lab/dim-cli`, and the plugin installer
`@slop-lab/install-dim`. Their source manifests remain private; each build
generates a consumer-facing manifest under `dist`. Publish core before the CLI:

```bash
pnpm --filter @slop-lab/dev-infra-manager-core run pack:dry-run
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/install-dim run pack:dry-run
pnpm --filter @slop-lab/dev-infra-manager-core run publish:package
pnpm --filter @slop-lab/dim-cli run publish:package
pnpm --filter @slop-lab/install-dim run publish:package
mise use -g npm:@slop-lab/dim-cli@0.1.0
npx "@slop-lab/install-dim@0.1.0"
npx "@slop-lab/install-dim@0.1.0" cli
npx "@slop-lab/install-dim@0.1.0" plugin "@dev-infra-manager/plugin-github@1.2.3"
```

Running `install-dim` without arguments opens an interactive installer for the
DIM CLI, optional plugins, or both. Use the explicit `cli` or `plugin`
subcommand for non-interactive automation. Installation choices are persisted
under `${XDG_CONFIG_HOME:-~/.config}/slop-lab/dim.json`.

Optional Git hosting integrations are designed as separately installed,
explicitly enabled packages over the versioned core plugin API. See
[docs/plugins.md](docs/plugins.md).

See [docs/repo-workspaces.md](docs/repo-workspaces.md) for lifecycle,
credential, reconciliation, and container-only verification details.
See [docs/project-workspaces.md](docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle.

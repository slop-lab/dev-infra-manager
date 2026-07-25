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
- Project-scoped managed Git repositories and protected branches.
- Root-repository lifecycle hooks for multi-repository projects.
- Workspace-level CPU, memory, and PID limits.

## Quick Start

Install dependencies and verify the TypeScript project:

```bash
pnpm install
just verify
```

Install and verify one host runtime backend on Ubuntu:

```bash
just install-host-sysbox-ubuntu
```

Run `just` as your normal user, including when it is managed by mise. The
installer invokes `sudo` only for host changes. It also adds the invoking user
to the `docker` group; log out and back in or run `newgrp docker` once after
the first installation. Do not install Sysbox and gVisor together merely for
testing; verify their installers in separate KVM guests instead.

The installer shows every package and host-level change before doing anything
and proceeds only after you enter `yes`. It is a development convenience, not
production hardening guidance. In particular, review its path-scoped AppArmor
exception for Sysbox FUSE mounts before using it outside a development host.

Install the VM test tools with `just install-kvm-verify-deps-ubuntu`, then test one installer without changing the host with `just verify-host-backend-kvm BACKEND`, or test every backend in a separate disposable VM with `just verify-host-backends-kvm`. Output is concise by default; append `--verbose` to show full guest installation and workload logs.

Choose the backend the host needs:

```bash
just install-host-sysbox-ubuntu
just install-host-gvisor-ubuntu
just install-host-rootless-podman-ubuntu
just install-host-runc-ubuntu
```

Install gVisor `runsc` directly for the no-KVM backend:

```bash
just install-runsc-linux
```

Or bootstrap the project with one selected backend (Sysbox by default):

```bash
just bootstrap-ubuntu
just bootstrap-ubuntu gvisor
```

Bootstrap prefers mise when available: it runs `mise install` and uses the
repository-managed Node.js, pnpm, and `just`. Hosts without mise fall back to
APT and the pinned global pnpm version.

Build the included runtime images:

```bash
just build-project-workspace
just build-secret-example
```

Run the reproducible integration smoke test:

```bash
just verify-container-sysbox
```

Use `just verify-container-sysbox -- --verbose` (or `-- -v`) to show detailed output for each stage. This requires a Docker host with Sysbox; standard GitHub-hosted CI uses `just verify-container-runc` instead.

Run the fast static isolation check without Docker or container creation:

```bash
just isolation-check
```

Use `just isolation-check-json` for machine-readable JSON output.

Inspect host readiness:

```bash
just doctor
```

See [docs/README.md](docs/README.md) for the full documentation index.
See [specs/README.md](specs/README.md) for implementation-oriented specifications.
See [docs/monorepo.md](docs/monorepo.md) for workspace boundaries and the
planned optional Git-host and ingress provider layout.

Create a Project namespace and root repository, push with ordinary Git, then
run a persistent workspace whose checkout exists only inside its container:

```bash
just build-project-workspace
just install-dim-local
dim project create project
dim repo create project root --root
git -C /path/to/project push "$(dim repo url-for-host project root)" main
dim repo protect project root
dim create project work-1 --backend sysbox --profile development
dim run work-1 codex
dim exec work-1 -- bash
```

For a complete, tested walkthrough spanning a root repository plus product
and secret-bearing repositories, see [examples/multi-repo-project](examples/multi-repo-project/README.md).

This repository implements the same project contract itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`. After pushing this repository as the
Project root, `dim run work-1 codex` launches Codex in the
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
mise use -g 'npm:@slop-lab/install-dim@0.2.0'
dim install-cli
npx '@slop-lab/install-dim@0.2.0'
npx '@slop-lab/install-dim@0.2.0' install-cli
npx '@slop-lab/install-dim@0.2.0' install-plugin '@example/dim-plugin@1.2.3'
```

Running `dim` without arguments opens an interactive installer for the DIM
CLI, optional plugins, or both — but only until a CLI is configured; after
that, bare `dim` behaves like every other command and proxies through
instead (same as `dim --help`), and `dim installer` is what reopens the
prompt. Use the explicit `install-cli` or `install-plugin` subcommand for
non-interactive automation. Installation choices are persisted under
`${XDG_CONFIG_HOME:-~/.config}/slop-lab/dim.json`.

DIM retains an explicitly enabled, versioned plugin loader for future concrete
integrations. Version 0.2.0 does not expose a generic Git-provider extension
point. See [docs/plugins.md](docs/plugins.md).

See [docs/repo-workspaces.md](docs/repo-workspaces.md) for lifecycle,
credential, reconciliation, and container-only verification details.
See [docs/project-workspaces.md](docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle.

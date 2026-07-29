# Contributing to DIM

This covers building and verifying `dev-infra-manager` (DIM) itself from
source. For using DIM in another project, see [README.md](README.md).

## Quick reference

```bash
pnpm install
just typecheck       # TypeScript checks only
just test            # unit tests
just build           # publishable package builds
just check           # typecheck + test + build; only Node.js and pnpm required
just doctor          # host readiness: dev tools, Docker, selected backend, cgroup v2
just cli -- --help   # build core, then run dim from source without installing it
```

The full setup, verification-gate, and installer-testing walkthrough — host
backend installers, KVM-based installer/backend smoke tests, the
`verify-container` integration suite, the direct host-backend smoke scripts,
and the installer/example smoke tests — is [docs/usage.md](docs/usage.md).

## Repository layout

[docs/monorepo.md](docs/monorepo.md) covers workspace boundaries and
dependency direction. In short: `packages/core` has no CLI dependency,
`packages/cli` is a thin executable adapter over it, and
`packages/installer` is the separate installer facade — see
[docs/README.md](docs/README.md) for the full documentation index and
[specs/README.md](specs/README.md) for the normative, implementation-facing
specifications that changes should stay consistent with.

## Publishing packages

See [docs/releasing.md](docs/releasing.md) for prerequisites, the
verification gate, and the publish order (core and shared integration
libraries, then `dim-cli`, then `install-dim`).

## Bootstrapping a fresh dev host

```bash
just bootstrap-ubuntu
just bootstrap-ubuntu gvisor
```

Installs Node.js/pnpm/`just` (via mise when available), the selected host
backend, project dependencies, and runs `verify` plus `doctor`. See
[docs/usage.md](docs/usage.md#setup) for what each step does.

## Linking a locally built `dim` for testing against another project

```bash
just install-dim-local
```

Builds `core`/`dim-cli` from source and installs the result globally,
bypassing the installer facade — for iterating on DIM itself, not the normal
install path (see [README.md](README.md#install-the-dim-cli) for that).

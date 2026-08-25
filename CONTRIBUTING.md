# Contributing to DIM

This covers building and verifying `dev-infra-manager` (DIM) itself from
source. For using DIM in another project, see [README.md](README.md).
DIM normally develops itself through its managed Git host while GitHub remains
the canonical public source; see
[DIM Development Repositories](specification/docs/development-repositories.md).

## Quick reference

```bash
just install-dependencies # locked monorepo dependencies
just typecheck       # TypeScript checks only
just test            # unit tests
just build-packages  # publishable package builds
just check-source    # typecheck + test + package builds; only Node.js and pnpm required
just verify agent    # strongest gate supported inside this repository's DIM agent
bash verification/scripts/local-ci-matrix.bash # exact Node.js 24/26 CI matrix via mise
just doctor          # host readiness: dev tools, Docker, selected backend, cgroup v2
just run-cli -- --help # build core, then run dim from source without installing it
```

`just verify agent` checks the source and package shapes, then verifies image
builds, container lifecycle, volumes, DNS, outbound networking, and peer
networking through the development agent's private rootless Docker runtime. It
does not replace `just verify container`, which starts a DIM workspace and exercises
that workspace's own nested runtime.

The top-level justfile is an everyday contributor index, not a mirror of every
CI job. Reusable verification commands remain under `just verify`; hosted lane
composition lives in workflows and scripts.

`local-ci-matrix.bash` requires mise, Docker with Compose v2, and the same host
capabilities as the container integration tests. It installs the locked
dependencies under Node.js 24 and 26, then runs the same source and container
gates used by the hosted CI workflows. The `--manual` option also
runs the same Sysbox isolation and KVM backend-installer recipes as the
manually dispatched workflows; it requires a registered `sysbox-runc` runtime,
QEMU tooling, and readable/writable `/dev/kvm`.

On Ubuntu, install the QEMU tooling and grant the invoking user persistent KVM
access with:

```bash
bash verification/scripts/install-kvm-verify-deps-ubuntu.bash
```

The full setup, verification-gate, and installer-testing walkthrough — host
backend installers, KVM-based installer/backend smoke tests, the
`just verify container` integration suite, the direct host-backend smoke scripts,
and the installer/example smoke tests — is [docs/usage.md](specification/docs/usage.md).

## Repository layout

[docs/monorepo.md](specification/docs/monorepo.md) covers workspace boundaries and
dependency direction. In short: `core/packages/core` has no CLI dependency,
`core/packages/cli` is a thin executable adapter over it, and
`core/packages/installer` is the separate installer facade — see
[docs/README.md](specification/docs/README.md) for the full documentation index and
[specs/README.md](specification/specs/README.md) for the normative, implementation-facing
specifications that changes should stay consistent with.

## Publishing packages

See [docs/releasing.md](specification/docs/releasing.md) for prerequisites, the
verification gate, and the publish order (core and shared integration
libraries, then `dim-cli`, then `dim-installer`).

## Bootstrapping a fresh dev host

```bash
just bootstrap-ubuntu
just bootstrap-ubuntu gvisor
```

Installs Node.js/pnpm/`just` (via mise when available), the selected host
backend, project dependencies, and runs `verify` plus `doctor`. See
[docs/usage.md](specification/docs/usage.md#setup) for what each step does.

## Linking a locally built `dim` for testing against another project

```bash
just install-local
```

Builds local package tarballs and installs them through the mise-managed
installer facade when available, with a direct global npm-prefix fallback —
for iterating on DIM itself, not the normal release install path (see
[README.md](README.md#install-the-dim-cli) for that).

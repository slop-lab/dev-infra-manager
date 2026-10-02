# Contributing to DIM

This covers building and verifying `dev-infra-manager` (DIM) itself from
source. For using DIM in another project, see [README.md](README.md).
DIM is developed from this integrated root monorepo. GitHub remains the
canonical public source; managed Git hosting is an internal review and CI
implementation detail.

## Quick reference

```bash
just install-dependencies # locked monorepo dependencies
just typecheck       # TypeScript checks only
just test            # unit tests
just build-packages  # publishable package builds
just check-source    # typecheck + test + package builds; only Node.js and pnpm required
just verify agent    # strongest gate supported inside this repository's DIM agent
bash verification/scripts/local-ci-matrix.bash # exact Node.js 24/26 CI matrix via mise
just build-workspace-image # run the source CLI's shipped-asset release image build
just build-local-workspace-image # image-only build for the current worktree
just prepare-local   # matched package/image candidate from one reviewed root commit
just install-local   # install the prepared candidate without restarting the controller
just restart-controller # restart the controller with the installed packages
just install-local-control-plane # install packages with transactional controller readiness
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

The `Expensive integration` workflow has dedicated clean hosted
`cache-routing-kvm` and `qemu-ci-image-layers-kvm` lanes. The direct local
`cache-routing-sysbox` recipe is capability-gated and is not a hosted QEMU
lane. The hosted KVM lanes target QEMU through the integration label or
`dim-qemu`; the local Sysbox recipe verifies Sysbox directly. Their matching
local recipes are `just verify cache-routing-sysbox`, `just verify
cache-routing-kvm`, and `just verify qemu-ci-image-layers-kvm`. A missing
Sysbox or KVM host capability is not a pass: these recipes stop with exit
status 2 and identify a missing local Sysbox, Docker, or KVM prerequisite
before starting an expensive journey.

Before installing or restarting a host with a reviewed repository set,
dispatch `QEMU release gate` at the exact development ref. Its `root-ref` input
selects the root candidate to combine with it. The `dim-qemu` runner boots a
clean runc guest and exercises the stateful development flow plus the canonical
self-Project; a green source-only PR check is not a substitute for this gate.

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
bash verification/scripts/bootstrap-ubuntu.bash
```

Installs Node.js/pnpm/`just` (via mise when available), Sysbox, project
dependencies, then runs `just check-source`, `just verify plugin-install`,
`just build-workspace-image`, and `just run-cli doctor`. See
[docs/usage.md](specification/docs/usage.md#setup) for what each step does.

## Preparing local DIM changes

```bash
just prepare-local
just install-local
# just restart-controller # optional: start the installed package set
just doctor
```

These are distinct operations with separate readiness domains:

- `build-workspace-image` is the release recipe. It requires Docker Buildx,
  delegates to `dim workspace image build`, and uses `--load` to prepare
  `dev-infra-project-workspace:<release version>` in the local Docker image
  store, and does not install packages or restart the controller.
- `build-local-workspace-image` is an image-only convenience for the current
  worktree. It does not create prepared package readiness.
- `prepare-local` accepts one exact reviewed root commit, archives its
  production source and aggregate lock without replacement refs, installs the
  disposable workspace with the frozen lock, and builds all package tarballs
  and the trusted image under one local version. Complete packages and
  readiness are promoted only after image identity verification succeeds.
- `install-local` validates and consumes that prepared candidate before and
  after installation. Mise may provide Node.js and npm but never old installer
  logic. It does not rebuild the image; core installation owns controller
  restart/readiness.
- `restart-controller` replaces the managed controller process with the
  currently installed DIM package set. It does not rebuild either packages or
  images.
- `install-local-control-plane` aliases `install-local`; a failed target
  readiness check restores the prior runtime and controller.
- `doctor` reports host readiness for development tools, Docker, the selected
  backend, and cgroup v2. Run the stronger verification gates separately when
  their image, container, or host behavior is the readiness domain in question.

This path is for iterating on DIM itself, not the normal release install path;
see [README.md](README.md#install-the-dim-cli) for that.

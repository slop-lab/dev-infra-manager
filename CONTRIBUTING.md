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
just check-source    # isolated pinned source gate; Docker is the only toolchain prerequisite
just check-source-native # same gate in an already pinned native environment
just verify agent    # strongest gate supported inside this repository's DIM agent
bash verification/scripts/local-ci-matrix.bash # isolated Node.js 24/26 source matrix plus mise host integrations
just build-workspace-image # run the source CLI's shipped-asset release image build
just build-local-workspace-image # image-only build for the current worktree
just prepare-local   # matched package/image candidate from one reviewed root commit
just install-local   # install the prepared candidate, enable plugins, and restart the controller
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

The recommended complete source check requires only Bash and Docker on the
host:

```bash
bash verification/scripts/source-gate-container.bash
# Select the real Node.js 26 source lane explicitly:
DIM_SOURCE_NODE_MAJOR=26 bash verification/scripts/source-gate-container.bash
```

`just check-source` and `just check-source-container` are convenience aliases
for the default Node.js 24 command. `DIM_SOURCE_NODE_MAJOR` accepts only `24`
or `26` and selects an independently checked Node.js 24.19.0 or 26.5.0 runtime.
The wrapper builds an image from digest-pinned Node.js and
Python 3.13.7 bases with Git and checksum-pinned Just 1.43.1, plus
exact-version pnpm 10.13.1. It copies the current worktree, including tracked and untracked changes,
into a disposable container with a fixed two-CPU limit in both local and hosted
lanes, so a large development host does not mask shared-runner contention;
it excludes Git metadata, generated `node_modules` and `dist` trees, user state,
and conventional local credential files and directories. This is not a general
secret scanner: submit only a reviewed checkout without other secret-bearing
files. The source checkout is never mounted writable, the Docker socket and
host environment are not passed through, and build or test output stays inside
the container. Network access remains available because source installer tests
intentionally download packages. The gate runs the complete recursive source
unit, verification, and CLI suites; hardware and live-runtime verification
remain explicit separate gates.

The centralized package Vitest suite uses a 15-second default per-test harness
budget because its fixtures include real Git imports, HTTP services, fsync, and
service restart recovery on shared CI CPUs. Production deadlines, lease expiry,
and explicitly shorter test-operation limits are unchanged. Use explicit
barriers or controlled clocks for ordering/expiry assertions; this scheduling
budget is not a substitute for those checks. Installed-service and multi-repository integration scenarios run independently,
with fresh fixture setup and explicit 30-second setup and scenario budgets.

Run the real native ordinary executor Docker integration separately on a host
with a reachable Docker daemon, `sysbox-runc`, and both digest-pinned fixture
images already available through `DIM_TEST_NATIVE_RUNNER_IMAGE` and
`DIM_TEST_NATIVE_JOB_IMAGE`:

```bash
just verify native-ordinary-executor-live
```

`just check-source-native` runs the ordinary source checks with Git, Python 3,
Node.js 24 or 26, pnpm 10.13.1, and a writable temporary directory. It builds all
packages before checking cross-package behavior. Root-only QEMU process and
filesystem checks are a separate disposable-environment profile; see
[verification profiles](verification/README.md). The default isolated source gate
runs both profiles without giving the container a host Docker socket.

The `Native integration` workflow has dedicated native ordinary Sysbox and
native QEMU KVM mechanics lanes. Their matching local recipes are `just verify
native-ordinary-guest-mechanics` and `just verify
native-qemu-guest-mechanics-kvm`. Missing Sysbox or KVM host capability is not
a pass: these recipes stop with exit status 2 and identify the unavailable
prerequisite before starting an expensive journey. Same-host mechanics do not
replace clean independent-host release acceptance or human review.

For GitHub UI/CLI manual dispatch, default-branch and disposable-runner
prerequisites, exact-SHA result checks, and remaining release gates, follow
[the release verification runbook](specification/docs/releasing.md#github-manual-triggers).

`local-ci-matrix.bash` requires mise, Docker with Compose v2, and the same host
capabilities as the container integration tests. It first runs the complete
source suite, package dry-runs, and production audit in each pinned disposable
Node.js 24/26 lane, matching the `Verify native candidate` workflow. Host plugin
checks use mise-selected Node.js 24 and 26; the container checks use Node.js 26.
The `--manual` option also
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
and the installer/example smoke tests — is the
[verification contract](specification/specs/12-verification.md).

## Fresh internal-development VMs

For a new Ubuntu 24.04 amd64 VM, use
[the role bootstrap](verification/bootstrap-ubuntu-vm.md) instead of assembling
the host and build-tool installers manually:

```bash
bash scripts/bootstrap-ubuntu-vm.bash --role ordinary --print-plan
bash scripts/bootstrap-ubuntu-vm.bash --role control-qemu --print-plan
```

Execution requires the full reviewed commit SHA, a clean checkout, and explicit
fresh-VM acknowledgement. Exit `3` means log out, log back in, and rerun the
same command. It does not configure secrets, TLS, lingering, or native worker
services. The `0.10.0` target is internal and pre-stable, not a public release.

## Repository layout

[docs/architecture.md](specification/docs/architecture.md) covers workspace boundaries and
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
`just build-workspace-image`, and `just run-cli doctor`. See the
[configuration guide](specification/docs/configuration.md) for the current
native host boundary.

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

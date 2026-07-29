# Usage

## Requirements

The development toolchain uses:

- A supported Node.js LTS release line. DIM 0.2 supports Node.js 24. Releases
  scheduled to become LTS, currently Node.js 26, are also validated during
  development before they enter the supported set.
- pnpm 10 or newer.
- just.
- TypeScript.

Runtime hosts also need the tools used by DIM:

- Docker-compatible CLI.
- The selected agent runtime backend installed and registered. The default backend requires Sysbox as `sysbox-runc`; the gVisor backend requires `runsc`.
- KVM access for the default Sysbox production runtime.
- Linux cgroup v2.
- `sudo` access for mount, unmount, ownership, and filesystem setup operations.

## Setup

Install dependencies:

```bash
pnpm install
```

Install and verify one Ubuntu host runtime backend:

```bash
bash scripts/install-host-ubuntu.bash sysbox
just cli doctor
```

For a root repository with `.dim/agent.json`, DIM keeps the trusted workspace
and untrusted Sysbox agent as sibling containers. Users still need only
`dim create PROJECT WORKSPACE` and `dim run WORKSPACE TASK`; no separate
runtime command is required.

Run `just` as your normal user, including when it comes from mise. After the
first install, log out and back in or run `newgrp docker` once to refresh the
Docker group membership added by the installer.

Before making changes, the installer identifies its APT packages, Sysbox
download, service operations, Docker group update, and path-scoped AppArmor
exception. It requires the exact response `yes`. Treat the script as a
development convenience and independently review these changes for production.

Choose exactly one backend:

```bash
bash scripts/install-host-ubuntu.bash sysbox
bash scripts/install-host-ubuntu.bash gvisor
bash scripts/install-host-ubuntu.bash rootless-podman
bash scripts/install-host-ubuntu.bash runc
```

The script records its backend in DIM user configuration and builds the
rootless Podman workspace image when that backend is selected. From this
source checkout, run `just cli doctor` after installation. Sysbox and gVisor are intentionally not
installed together by the convenience script. Use the KVM gate below to test
every installer without requiring the runtimes to coexist on one host.

Test installation destructively inside a disposable KVM-backed Ubuntu VM, without installing a backend on the host:

```bash
just verify-environments-kvm       # all backends, one clean VM each
just verify-environments-kvm --verbose
bash scripts/kvm-host-install-smoke.bash gvisor --verbose # one backend, direct script
```

Prepare those dependencies with `just install-kvm-verify-deps-ubuntu`. This
requires writable `/dev/kvm`, `qemu-system-x86_64`, `qemu-img`, and
`cloud-localds`. The verified Ubuntu cloud image is cached under `.local/kvm`;
each test uses and deletes a temporary overlay disk. The default output
identifies each stage and prints only the last 30 lines on failure; append
`--verbose` to the recipe or direct script to stream complete logs.

Install gVisor `runsc` directly for the no-KVM Docker-compatible backend:

```bash
bash scripts/install-runsc-linux.bash
```

This downloads the latest official gVisor release binaries, verifies their SHA-512 checksums, installs them under `/usr/local/bin`, registers `runsc` with Docker, and restarts Docker.

Run the Ubuntu bootstrap with one selected backend (Sysbox by default):

```bash
just bootstrap-ubuntu
just bootstrap-ubuntu gvisor
```

When mise is available, bootstrap runs `mise install` and uses the Node.js,
pnpm, and `just` versions declared by this repository. Otherwise it installs
Node.js, npm, and `just` through APT and installs the pinned pnpm version. It
then installs the selected host runtime and project dependencies, runs
verification, builds the included runtime images, and runs `doctor` for that
backend. If `doctor` reports missing host capabilities, bootstrap exits
non-zero after printing the gaps.

Build the included runtime images:

```bash
just build-project-workspace
```

Run the integration smoke test:

```bash
just verify-container
bash scripts/container-sysbox-isolation-smoke.bash
```

Use `bash scripts/container-sysbox-isolation-smoke.bash --verbose` to show
detailed output for each labeled Sysbox stage.

The container integration gate builds the included image and exercises
Project-scoped managed Git and workspace lifecycle flows. The backend gate
then verifies Sysbox-specific cgroup propagation and Docker-store isolation
using that prebuilt image.

For a fast check that does not contact Docker or create containers, validate
the generated isolation arguments only:

```bash
just isolation-check
```

CI can request the same test result as JSON on stdout:

```bash
just isolation-check-json
```

This verifies resource flags and rejects host Docker storage or socket mounts;
it does not replace the Sysbox runtime behavior covered by
`scripts/container-sysbox-isolation-smoke.bash`.

Run the full local verification suite:

```bash
just check
```

`just check` runs `just typecheck`, `just test`, and `just build`. It requires
only Node.js and pnpm, not Docker, an installed DIM CLI, or a runtime backend.
Run the packaged plugin installation flow separately:

```bash
just verify-plugin-install
```

When Docker has Compose v2 and supports privileged runc containers, run:

```bash
just verify-container
bash scripts/container-cgroup-smoke.bash
```

The first command builds the role-neutral DIM project workspace image and uses
privileged nested containers for backend-independent integration coverage.
The second requires direct access to the target Docker host and validates the
runc cgroup v2 boundary, including live resource updates. Neither validates
the production Sysbox boundary.
It also installs the publishable `@slop-lab/dim-cli` tarball into a temporary
prefix and uses only that installed `dim` binary to exercise:

- Disposable managed-Git repositories and persistent workspace reconciliation.
- A project with custom setup and entrypoint hooks, including setup failure and
  retry.
- An external URL project whose root, nested dev, and further nested service
  are routed without publishing arbitrary host upstreams.
- This repository registered as a real project, including locked dependency
  setup and its checked-in `check`, `verify`, and `codex` tasks.
- Capability-profile replacement, project fast-forward update, stop/start
  persistence, and discard cleanup.

Three additional standalone checks cover installation and the copyable
examples against a real Docker daemon:

```bash
just verify-mise-install-smoke   # mise use -g npm:@slop-lab/dim-installer, in a disposable container
just verify-example-multi-repo-project # three materialized repositories and a real workspace
just verify-example-external-urls      # nested URLs proven with dnsmasq
```

All require Docker and network access; `verify-mise-install-smoke` also
needs to reach the real npm registry to install `mise` itself, and
`verify-example-external-urls` uses Docker and dnsmasq but does not require a
real Tailscale account. The multi-repository verification also requires the
managed Gitea service.

## Project Workspaces

For installing `dim` and the minimal single-repository "create a Project"
shape, see the root [README](../README.md#install-the-dim-cli). For a
complete, tested nested-container walkthrough with named external URL ingresses, see
[Example: External URLs](../examples/external-urls/README.md).

`run` does not repeat setup. Environment reconciliation happens on `create`,
`start`, `restart`, `setup`, and after a fast-forward-only `update`. Only the
optional files under `.dim` have special meaning; root Compose files are
never auto-discovered.

Copy the minimal `.dim` examples from
[Project Workspaces](project-workspaces.md) for the hook contract, lifecycle,
capability profiles, and multi-repository service pattern. See
[Repository-backed Workspaces](repo-workspaces.md) for registration, Gitea,
credentials, and reconciliation details.

See [Configuration](configuration.md) for the full field reference.

## Host Readiness

Run:

```bash
dim doctor
```

The installed command checks Docker daemon access, the selected workspace
runtime backend, and cgroup v2 support.

Run the same check from source against the installed backend configuration:

```bash
just cli doctor
```

`just cli` builds `@slop-lab/dim-core` first, then runs `dim`
directly from source via `tsx` — the reliable way to run the CLI without
installing it. Running `tsx src/cli.ts` directly from `packages/cli`
instead fails with `ERR_MODULE_NOT_FOUND` unless core has already been built.

The Sysbox registration check only proves that Docker knows about
`sysbox-runc`. The Sysbox container execution check runs `hello-world:latest`
with `--runtime=sysbox-runc`; this is the direct readiness signal for Sysbox
workspace-root containers.
For gVisor, `doctor` checks `runsc` and Docker runtime execution when gVisor
is the installed selection. For rootless Podman, `doctor` checks the workspace
image and verifies that `podman` is present in it. Podman runs rootless as
`dim` inside the workspace. The outer Docker workspace container is not
privileged; it instead receives the specific capabilities (`SYS_ADMIN`,
`SETUID`/`SETGID`, `SYS_CHROOT`, `SYS_PTRACE`, and the rest of the set shared
with `gvisor`) that nested unprivileged user namespaces and mounts need, since
Docker's default capability set and seccomp profile normally block them. Set
`DIM_WORKSPACE_PRIVILEGED=true` to fall back to a fully privileged outer
container if a host's kernel/seccomp configuration needs it.

# Usage

## Requirements

The development toolchain uses:

- Node.js 24 or 26.
- pnpm 10 or newer.
- just.
- TypeScript.

Runtime hosts also need the tools used by DIM:

- A Linux host running a systemd user manager. macOS, Windows, and Docker
  Desktop hosts are not supported.
- Docker-compatible CLI.
- Sysbox installed and registered as `sysbox-runc`.
- Optional KVM access for workspaces that request it.
- Linux cgroup v2.
- `sudo` access for mount, unmount, ownership, and filesystem setup operations.

The default managed controller is a `systemd --user` service. DIM installs and
starts the unit automatically when a command first needs the controller.
Inspect its timestamped, rotated journal with:

```bash
systemctl --user status dim-controller.service
journalctl --user --unit dim-controller.service --lines 100
```

`dim controller restart` rewrites the unit for the currently installed CLI,
reloads systemd, and restarts it. Custom state roots used by disposable tests
retain an isolated foreground-compatible controller instead of sharing this
host service. The managed unit preserves its runtime directory across that
restart because existing workspaces bind-mount the directory, not an
individual socket inode; the replacement controller socket therefore becomes
visible without recreating those workspaces.

## Setup

Install dependencies:

```bash
pnpm install
```

Install and verify one Ubuntu host runtime backend:

```bash
bash verification/scripts/install-host-ubuntu.bash sysbox
just run-cli doctor
```

Projects may start a development-agent service from `.dim/setup.sh` and route
fixed tasks into it from `.dim/entrypoint.sh`. The service is ordinary
Project-owned Compose configuration; DIM core does not define or manage an
agent resource.

Enter that Project-owned task boundary with `dim run WORKSPACE bash`. Use
`dim exec WORKSPACE -- bash` only when raw access to the trusted workspace is
needed for recovery or lifecycle administration. `run`, `exec`, and trusted
`.dim/setup.sh` do not install coding-agent tools automatically.

A Project may document an optional workspace-user bootstrap. Fetch its script
and `.sha256` file from the same full development commit, verify the checksum,
then explicitly stream the verified script through
`dim run WORKSPACE bash -- -s`. Never pipe a branch, tag, or `latest` URL
directly into a shell. The bootstrap may change only the persistent agent user
home and must exclude authentication, global Git configuration, web exposure,
and DIM controller or plugin access. The canonical self-development workspace
can run its reviewed local copy directly:

```bash
dim run dim-dev bash -- /workspace/scripts/workspace-user-setup.bash
```

That optional script installs pinned OpenCode tooling below the canonical
agent home. OpenCode configuration remains in the home-confined XDG directory;
OMO 4.19.4 configuration is `$HOME/.omo/omo.jsonc`, with
`["[opencode]"].team_mode` settings of `enabled=true`, `max_parallel_members=4`,
`max_members=8`,
and `tmux_visualization=false`. Targeted JSONC updates preserve comments and
unrelated settings, and concurrent setup is serialized. An interrupted
multi-file update converges when retried rather than promising transactional
atomicity across files. OpenCode remains a user-selected command, not a DIM
agent resource, plugin, API, or lifecycle step.

Projects may separately publish an opt-in OpenCode Web launcher. The canonical
launcher requires the pinned setup to have completed, sets a non-empty server
password before binding OpenCode to loopback, stores the generated credential and
process identity in mode-restricted state below the user home, reports the
credential-file path without printing the password, and polls the authenticated
health endpoint. It invokes `dim-development-service expose` with a stable name,
the selected local port, and an HTTPS requirement. Its only DIM capability is
`DIM_DEVELOPMENT_URL_SOCKET`; the trusted proxy injects the fixed gateway target,
so the launcher receives no target/container metadata. It proves that its exact
recorded process owns the listening socket and bounds lock, helper, readiness,
and cleanup waits. Another ingress must already be allowed by the reviewed
trusted proxy. Installation, configuration, and lifecycle setup do not invoke
the launcher, and launcher retries or failures do not stop the shared gateway
or another routed service. The gateway listens on its fixed agent-container
port for the trusted ingress and forwards each route to a loopback application.
The returned Web UI and API are same-origin, so this path does not require
CORS. Do not enable a wildcard origin; a separate browser client must use only
its exact reviewed origin.

Run `just` as your normal user, including when it comes from mise. After the
first install, log out and back in or run `newgrp docker` once to refresh the
Docker group membership added by the installer.

Before making changes, the installer identifies its APT packages, Sysbox
download, service operations, Docker group update, and path-scoped AppArmor
exception. It requires the exact response `yes`. Treat the script as a
development convenience and independently review these changes for production.
On Ubuntu 24.04 and later, the common install also loads the official-style
AppArmor exception that permits only `/usr/local/bin/rootlesskit` to create
the user namespace needed by Project-owned rootless-DinD sidecars.

Install the supported backend:

```bash
bash verification/scripts/install-host-ubuntu.bash sysbox
```

The script records `sysbox` in DIM user configuration. From this source
checkout, run `just run-cli doctor` after installation.

Test installation destructively inside a disposable KVM-backed Ubuntu VM, without installing a backend on the host:

```bash
just verify environments-kvm       # Sysbox in one clean VM
just verify environments-kvm --verbose
bash verification/scripts/kvm-host-install-smoke.bash --verbose
```

The canonical DIM Project additionally lets its agent request that gate through
the protected root launcher:

```bash
node project/.dim/qemu-client.mjs run
node project/.dim/qemu-client.mjs run --input fixtures=/workspace/local-fixtures
```

The client also provides `start`, `status`, `follow`, and `cancel`. QEMU and
`/dev/kvm` remain in the trusted workspace. The service synchronously claims
one run before awaiting request or filesystem input, and rejects duplicate
input names. While the claim remains exclusive, it copies inputs without
following symlinks into immutable snapshots owned by that run before launch;
any snapshot failure starts no child. Inputs must resolve beneath `/workspace`,
and the guest receives snapshots rather than live host bind mounts.

Prepare those dependencies with
`bash verification/scripts/install-kvm-verify-deps-ubuntu.bash`. This
requires writable `/dev/kvm`, `qemu-system-x86_64`, `qemu-img`, and
`cloud-localds`. The verified Ubuntu cloud image is cached under `.local/kvm`;
each test uses and deletes a temporary overlay disk. The default output
identifies each stage and prints only the last 30 lines on failure; append
`--verbose` to the recipe or direct script to stream complete logs. The guest
overlay defaults to 32 GiB and can be changed with `DIM_KVM_SMOKE_DISK_SIZE`.

Run the Ubuntu bootstrap for Sysbox:

```bash
bash verification/scripts/bootstrap-ubuntu.bash
```

When mise is available, bootstrap runs `mise install` and uses the Node.js,
pnpm, and `just` versions declared by this repository. Otherwise it installs
Node.js, npm, and `just` through APT and installs the pinned pnpm version. It
then installs Sysbox and project dependencies, runs `just check-source` and
`just verify plugin-install`, builds the included runtime image, and runs
`just run-cli doctor` for that backend. If `doctor` reports missing host
capabilities, bootstrap exits non-zero after printing the gaps.

Build the included runtime images:

```bash
just build-workspace-image
dim workspace image status
```

`dim workspace image status --json` reports the same inspection-derived image
result for automation. A missing image is distinct from a controller, host, or
workspace readiness problem. Controller restart does not build workspace
images; use the Project or development build script that owns the configured
image.

Run the integration smoke test:

```bash
just verify container
bash verification/scripts/container-sysbox-isolation-smoke.bash
```

Use `bash verification/scripts/container-sysbox-isolation-smoke.bash --verbose` to show
detailed output for each labeled Sysbox stage.

The container integration gate builds the included image and exercises
Project-scoped managed Git and workspace lifecycle flows. The backend gate
then verifies Sysbox-specific cgroup propagation and Docker-store isolation
using that prebuilt image.

For a fast check that does not contact Docker or create containers, validate
the generated isolation arguments only:

```bash
just verify isolation
```

CI can request the same test result as JSON on stdout:

```bash
just verify isolation-json
```

This verifies resource flags and rejects host Docker storage or socket mounts;
it does not replace the Sysbox runtime behavior covered by
`verification/scripts/container-sysbox-isolation-smoke.bash`.

Run the full local verification suite:

```bash
just check-source
```

`just check-source` runs `just typecheck`, `just test`, and
`just build-packages`. It requires only Node.js and pnpm, not Docker, an
installed DIM CLI, or a runtime backend.
Run the packaged plugin installation flow separately:

```bash
just verify plugin-install
```

When Docker has Compose v2 and supports privileged runc containers, run:

```bash
just verify container
bash verification/scripts/container-cgroup-smoke.bash
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
  setup and its checked-in `bash`, `backup`, and `restore` tasks.
- Capability-profile replacement, project fast-forward update, stop/start
  persistence, and discard cleanup.

Inside this repository's DIM development agent, use the private agent-runtime
gate instead:

```bash
just verify agent
```

This runs the source and publishable-package gates and verifies the private runtime's
image build, container lifecycle, volume, DNS, outbound-network, and peer-network
behavior. The private runtime deliberately does not expose the host Docker
socket. A rootless outer runtime without cgroup delegation cannot run `just verify container`: that
gate adds another nested Docker daemon and requires it to create cgroups. Run
the full container integration gate on a cgroup-capable Docker host or in its
CI lane; do not treat `just verify agent` as equivalent coverage.

The runc guest in `just verify environments-kvm` also creates the canonical
self-Project and runs `just verify agent` inside its agent container.
This verifies the same private rootless `agent-dind` from a clean Ubuntu install;
when the source checkout is dirty, the KVM verifier uses a temporary snapshot
that includes the current worktree changes. The guest runs as UID 1001 and
proves the rootless daemon adopts that UID while the agent sees UID 0 only
inside the daemon's subordinate-ID-mapped namespace.

Three additional standalone checks cover installation and the copyable
examples against a real Docker daemon:

```bash
just verify mise-install-smoke   # mise use --raw --global npm:@slop-lab/dim-installer, in a disposable container
just verify example current-installed auto single-repository
just verify example current-installed auto multi-repository
just verify example current-installed auto full-development-flow
just verify example sysbox use
just verify example sysbox use ci-runner
```

For local development, `just install-local` builds the publishable package
tarballs. When mise is available it automatically invokes the mise-selected
installer facade and keeps `dim` proxied through that facade; without mise it
retains the direct installation under `${DIM_INSTALL_PREFIX:-~/.local}`.

The example recipe accepts `current-installed` or `sysbox`. The named backend creates
one disposable QEMU guest per selected example and invokes
`just verify example current-installed` inside it.
The dirty-repository policy defaults to `auto` (reject), while `use` snapshots
the worktree and `discard` verifies committed `HEAD`. The optional final
argument selects one example instead of the compatible suite.

All require Docker and network access; `just verify mise-install-smoke` also
needs to reach the real npm registry to install `mise` itself. The
`external-urls` example uses Docker and dnsmasq but does not require a real
Tailscale account. The multi-repository and full-development-flow verification
also require the managed Gitea service. The full flow exercises state changes
from creation through reviewed updates, restart rejection and recovery,
controller replacement, setup-error recovery, and backup/discard/restore.

## Project Workspaces

For installing `dim` and the minimal single-repository "create a Project"
shape, see the root [README](../README.md#install-the-dim-cli). For a
complete, tested nested-container walkthrough with named external URL ingresses, see
[Example: External URLs](../../examples/features/external-urls/README.md).
For a combined, stateful adoption and recovery walkthrough, see
[Full development flow](../../examples/projects/full-development-flow/README.md).

`run` does not repeat setup. Environment reconciliation happens on `create`,
`start`, `restart`, `setup`, and after a fast-forward-only `update`. Only the
optional files under `.dim` have special meaning; root Compose files are
never auto-discovered.
Agent-tool installation, when a Project offers it, is a separate explicit
workspace-user action through the Project task boundary.

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
just run-cli doctor
```

`just run-cli` builds `@slop-lab/dim-core` first, then runs `dim`
directly from source via `tsx` — the reliable way to run the CLI without
installing it. Running `tsx src/cli.ts` directly from `core/packages/cli`
instead fails with `ERR_MODULE_NOT_FOUND` unless core has already been built.

The Sysbox registration check only proves that Docker knows about
`sysbox-runc`. The Sysbox container execution check runs `hello-world:latest`
with `--runtime=sysbox-runc`; this is the direct readiness signal for Sysbox
workspace-root containers.
KVM is checked separately when a workspace requests it; it is not a Sysbox
installation prerequisite.

# Installation Scripts

## Ubuntu Host Install

Script:

```text
scripts/checks/install-host-ubuntu.bash sysbox
```

Behavior:

1. Validate `sysbox` and print a development-only warning and a summary of packages, downloads,
   service changes, group changes, and the AppArmor exception.
2. Continue only when the user enters exactly `yes`.
3. Determine `SYSBOX_VERSION`, default `0.7.0`.
4. Determine `SYSBOX_ARCH`, default `dpkg --print-architecture`.
5. Select pinned SHA-256 for supported architectures:
   - `arm64`
   - `amd64`
6. Install `apparmor`, `curl`, `docker.io`, and `jq`.
   On Ubuntu hosts that restrict unprivileged user namespaces through
   AppArmor, install the path-scoped `/usr/local/bin/rootlesskit` profile via
   `scripts/checks/install-rootlesskit-apparmor-profile-ubuntu.bash`. The container
   CI lane invokes the same script before exercising rootless-DinD sidecars.
   When a container can observe the host restriction sysctl but has no
   writable AppArmor securityfs policy interface, the script leaves policy
   loading to the runner host instead of invoking a parser that cannot reach
   the kernel interface.
7. Create a uniquely named, invoking-user-owned temporary file, download the
   Sysbox CE deb into it, and remove it when the script exits.
8. Verify SHA-256.
9. Install the deb.
10. Add an idempotent local `fusermount3` AppArmor rule limited to FUSE
    mounts below `/var/lib/sysboxfs/`, then reload that profile.
11. Reload systemd.
12. Restart Docker.
13. Restart Sysbox so AppArmor changes take effect and stale in-memory
    container registrations are cleared.
14. Add the invoking non-root user to the `docker` group.
15. Explain that the user must log in again or run `newgrp docker` once
    before the current session can use Docker without `sudo`.
16. Do not enable systemd user linger. The operator explicitly runs
    `sudo loginctl enable-linger "$USER"`; `doctor` reports disabled linger
    without changing it.

Unsupported Sysbox architectures fail. The base runtime uses Sysbox directly;
host installation creates no unused backend-selection configuration. From a
source checkout, run `just run-cli doctor` afterward.

The optional second argument `docker-ce` selects the exact Docker CE package
tuple used by the fresh-VM bootstrap instead of the Ubuntu Docker packages.
It verifies the signed repository key, refuses conflicting distro packages,
requires the containerd image store, and never removes packages or Docker data
to make an existing host fit. The bootstrap's explicit acknowledgement supplies
the host install confirmation; standalone invocation still prompts by default.

## Fresh Ubuntu VM Bootstrap

`scripts/bootstrap-ubuntu-vm.bash` MUST support explicit `ordinary` and
`control-qemu` roles for Ubuntu 24.04 amd64 internal-development VMs. Its
`--help` and `--print-plan` surfaces MUST be non-mutating and MUST NOT claim
candidate validation. Execution MUST require a normal sudo-capable operator,
explicit fresh-VM acknowledgement, one full reviewed root commit matching a
clean checkout, and the expected pre-stable package version.

Before privileged or network operations it MUST verify that DIM state and
prepared artifacts are absent, Docker has no workloads or non-default resources,
and daemon overrides are absent. Existing resources remain untouched.
Executable tools MUST use reviewed exact versions and embedded checksums;
Docker packages MUST use an exact signed package tuple. The host image-store
requirement MUST NOT change the distinct trusted inner-daemon storage contract.

Both roles install Docker CE 29.1.4, Compose v2, Buildx, Sysbox 0.7.0, Node.js
24.19.0, pnpm 10.13.1, and Just 1.43.1. Only `control-qemu` installs QEMU tooling
and requires a real readable/writable KVM device, without TCG substitution.
Provisioning device access alone MUST NOT be reported as a functional KVM test.
Group changes MUST stop with exit `3` for an explicit new login and identical
rerun. An owner-only resume marker MUST bind the phase, role, source, version,
operator, and bootstrap-created Docker configuration; foreign or changed state MUST
fail closed.

After host prerequisites, the bootstrap MUST reuse reviewed `prepare-local`
and `install-local` transactions. Its durable installer facade MUST use the
exact prepared installer and pinned Node/tool paths, remain usable after a new
login, and preserve foreign targets. Package/image registry publication, tags,
TLS, secrets, native role JSON, lingering, and worker activation MUST remain
outside bootstrap authority. See the
[operator guide](../../development/bootstrap-ubuntu-vm.md) for commands,
artifact checksums, and separate live-VM verification requirements.

## KVM Host-install Smoke

`scripts/checks/install-kvm-verify-deps-ubuntu.bash` installs QEMU, qcow2,
cloud-image, SSH, curl, and xz tooling, provisions pinned Node.js `v24.19.0`,
and adds the invoking non-root user to the `kvm` group; it does not install a
runtime backend. Before mutation it reports the exact APT package set, selected
Node URL, fixed literal SHA-256, canonical destination, preservation policy,
and group change. It requires the exact confirmation `yes` and explains that
the login session must be refreshed before the new group membership is active.
The KVM host installer accepts only `amd64` because the verification gate boots
an x86-64 guest with KVM; it rejects all other host architectures before
confirmation or mutation. The selected official Linux `x64` archive has SHA-256
`14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647` and
the helper retains the independently vetted Linux `arm64` archive SHA-256
`01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc`.
The helper downloads directly into a private root-owned directory under
`/usr/local/lib`, verifies that staged immutable file without consulting a
remote manifest, and extracts only afterward. It installs the canonical
root-owned mode-`0755` executable at
`/usr/local/lib/dim-qemu-node-24.19.0/bin/node`, never publishes or replaces
`/usr/local/bin/node`, and refuses an unsafe, mismatched, or foreign existing
target without removing, overwriting, or changing ownership of it.
`scripts/checks/kvm-host-install-smoke.bash [--preflight-only] [--verbose]` and
`just verify environments-kvm [--verbose]` verify Sysbox in a clean VM. The check boots a checksum-verified Ubuntu cloud-image VM with
`/dev/kvm`, archives one resolved committed source tree into a single-commit
workbench snapshot, installs Sysbox, verifies its runtime, and deletes the VM
overlay and SSH key on exit. The snapshot records the original source commit
in its commit message and preserves tracked source even when ignore rules
match it. Uncommitted, ignored-untracked, and other untracked files are excluded.
New verification helpers must therefore be committed before a host run.
The invoking operator remains unprivileged for the gate and client, but must
have cached noninteractive `sudo -n` authority for the narrow root-owned QEMU service
directory, trusted service process, exact-PID retirement, and directory cleanup.
The operator may prime normal sudo authorization with `sudo -v`; no permanent
blanket `NOPASSWD` rule is required. Root service execution uses only the
absolute `DIM_QEMU_NODE_EXECUTABLE`, defaulting to `/usr/bin/node`, after
requiring a canonical non-symlink root-owned mode-`0755` Node.js 24 or 26 file
and a root-owned, non-group/world-writable ancestor chain. It never selects a
user-managed Node executable from `PATH`, and it checks that ancestor chain
before executing Node for version discovery. `--preflight-only` aggregates all
identity, trusted closure, Node, sudo, `setpriv`, readable/writable character
`/dev/kvm`, and launcher dependency failures without creating service state.
Dependency lookup uses the exact root service and gate `PATH=/usr/bin:/bin`,
not the invoking shell's path. A full run keeps the cached authorization valid
with bounded noninteractive `sudo -n -v` refreshes while the unprivileged
client runs. Refresh failure terminates that run and enters bounded cleanup.
Privileged retirement, exact-PID signaling, wrapper waits, and directory
cleanup are bounded; the service directory is removed only after exact service
shutdown is proved, and otherwise remains for operator recovery with a
non-zero result.
After installation, the normal operator logs in again or runs `newgrp kvm`,
sets
`DIM_QEMU_NODE_EXECUTABLE=/usr/local/lib/dim-qemu-node-24.19.0/bin/node`, runs
`sudo -v`, and then invokes
`bash scripts/checks/kvm-host-install-smoke.bash --preflight-only` before
`just verify environments-kvm`. No blanket `NOPASSWD` policy, `/dev/kvm` mode
change, or silent group re-exec is part of the installer.
The check installs the source verification toolchain after the host installer
and runs dependency-aware full-development and independent KVM/CI stages,
including `just verify self-development` for the canonical Project's agent
inside its private rootless DinD. Stages run serially: an ordinary failure
does not prevent independent later checks, but failed prerequisites produce
`BLOCKED` results. The final aggregate remains nonzero for any failure or
blocked stage. Cancellation stops the active process group and prevents later
stages; uncertain cleanup produces exit 125 and blocks every remaining stage.
Per-stage logs and `PASS`/`FAIL`/`BLOCKED` summaries identify each outcome. The QEMU
verification user has the explicit UID 1001; the gate proves that the daemon
adopts that non-default UID and maps its inner UID-0 agent onto it.
The base cloud image is cached under `.local/kvm`. Default output names each
stage and emits only the final 120 lines of a failing stage; `--verbose`
streams full guest, build, and workload logs.
Guest cloud-init supplies an empty `PS1` before noninteractive SSH shells read
Ubuntu's global bashrc; strict shell checks remain enabled. The event service
limits all open followers, including completed-run replay, to 16 and retains
a bounded retained-output ring with at most 8 MiB queued per backpressured follower.
Normal backpressure drains in order before stream completion; an overflowing
slow follower is disconnected without delaying run cleanup. The client reports
truncated responses as failures rather than leaving an unsettled await. A
completed guest failure produces client exit status 1 after its logs finish.

## Ubuntu Bootstrap

Script:

```text
scripts/checks/bootstrap-ubuntu.bash
```

Behavior:

1. If `mise` is available, run `mise install` at the repository root and
   re-enter the script through `mise exec` so its Node.js, pnpm, and `just`
   versions are used.
2. Otherwise install `git`, `nodejs`, and `npm` with APT.
3. Without mise, use an existing `just` from `PATH` or install the Ubuntu
   `just` package when the command is missing. The `justfile` also passes its
   resolved executable path into the script.
4. Without mise, install pinned pnpm if missing or wrong version.
5. Install the selected Ubuntu host backend (Sysbox by default).
6. Install project dependencies with frozen lockfile.
7. Run `just check-source`.
8. Run `just verify plugin-install`.
9. Build the Docker project workspace image.
10. Run `doctor` for the backend persisted by the installer.
11. Exit non-zero if that backend doctor reports host runtime gaps.

## Local Source Preparation

The reviewed root monorepo MUST own the aggregate dependency lock used for
local source preparation. Preparation accepts only one exact root commit and
MUST archive the production package trees and lock from that commit into an
isolated temporary production workspace. The aggregate local identity MUST be
the SHA-256 digest of the root commit record plus the SHA-256 digest of that
reviewed lock. Preparation MUST install the archived workspace dependencies
with the frozen lock. A missing lock or one that is stale for the archived
workspace MUST fail preparation before package build, package publication, or
image publication. Preparation MUST NOT clone historical split production
repositories or modify the reviewed checkout to reconcile a lock mismatch.
Commit validation and archive operations MUST ignore Git replacement refs and
MUST reject trees, blobs, and other non-commit objects. Source, package, and
readiness staging MUST use private nonce paths; persistent path symlinks MUST
be rejected. A failed stage or publication MUST restore the previously
published package bundle and readiness. Every rollback operation MUST be
checked. If restoration fails, preparation MUST report and retain the private
staging path containing recovery data instead of deleting it.

The reviewed root `prepare-local` path MUST build every production package
tarball and the trusted workspace image under exactly one aggregate local
version. It builds the image under a temporary tag, inspects its immutable
image ID, and only then promotes it to
`dev-infra-project-workspace:<shared aggregate local version>`. Its readiness
state binds that versioned tag to the image ID and package/source digests.
`install-local` recomputes the tag from the unchanged bundle and rejects stale
or mismatched preparation state before and after installation. Complete staged
packages and readiness are promoted under the shared preparation lock before
the final versioned image tag is created as the last fallible publication
operation. Any prior versioned image is first held under a private rollback
tag. Docker's tag API has no compare-and-swap rollback, so a final-tag command
that reports failure after a possible mutation MUST NOT trigger an automatic
restore or removal by shared tag name. Preparation instead fails closed,
retains the prepared and prior private image references plus staging recovery
data, and reports that explicit operator recovery is required. Both the
reviewed-root prepared path and the assembled-development path MUST stage the
installer tarball from the validated candidate bundle in a temporary directory
outside that bundle, then use that target facade for `installer install core` and its
target-package state compatibility preflight before runtime promotion. An
existing standalone or mise-managed facade cannot retroactively provide a
candidate check and MUST NOT perform this install operation. Mise may supply
Node.js and npm while executing the staged facade's absolute path. After successful
assembled-development installation, retain the matching facade under a digest-named
DIM data directory and select it through `mise link` and `mise use --raw --global`.
Without mise, report its persistent executable directory for PATH configuration. A compatibility refusal
must therefore precede facade, config, runtime, plugin, or image mutation and
must preserve prepared bundle bytes and readiness. The existing preparation-
image readiness checks and their ordering remain unchanged.

The assembled-development path installs the base graph by default. `--with-managed`
adds the optional managed library graph without activating plugins or a controller.
The reviewed-root preparation path separately defers controller restart until its
explicit plugin selection has been activated.

`build-local-workspace-image` remains an image-only convenience path for the
current working tree and does not create prepared package readiness.
`prepare-local` is the required path for a matched package/image candidate;
`install-local` consumes that prepared candidate and does not build an image.
The release `build-workspace-image` path MUST remain distinct and delegate to
the explicit CLI build with the exact release version. A published CLI MUST
perform that same build from its shipped package assets without
source-development tools. None of these paths uses `latest`.

## Smoke Script

Script:

```text
scripts/checks/container-sysbox-isolation-smoke.bash
```

Behavior:

1. Build workspace packages and the workspace-root image.
2. Run a workspace-root image command smoke.
3. Start the image with Sysbox and explicit resource limits.
4. Verify cgroup limits and nested Docker execution.
5. Verify host and nested Docker image stores remain isolated.
6. Print the success marker and clean up temporary probes.

## Local npm Registry Helper

Script:

```text
scripts/checks/lib/local-npm-registry.bash
```

Sourced, not run directly. Provides `dim_start_local_npm_registry WORK_DIR`,
`dim_publish_to_local_registry TARBALL...`, and
`dim_stop_local_npm_registry` so a script can install unreleased local
package builds through ordinary `npm install`/`mise use --raw --global npm:...` instead
of the real npm registry. It runs the exact Verdaccio binary owned by the
repository's frozen lockfile and binds it to a randomly selected IPv4 loopback
port. The helper creates one random throwaway publisher through Verdaccio's
user API, restarts with signup closed, and permits package mutation only for
the authenticated publisher. It points npm at both `npm_config_registry` and
an isolated `NPM_CONFIG_USERCONFIG` file rather than the caller's real npm
config.

## mise Install Smoke

Script:

```text
scripts/checks/mise-install-smoke.bash
```

`just verify mise-install-smoke`. Requires Docker and network access.
Builds and packs `core`, `dim-cli`, and `install`, publishes them to a
disposable local npm registry inside a throwaway container, installs a
pinned `mise` release predating its npm-backend download-popularity gate
(see [Installer Facade](../14-installer-facade.md)), and runs
`mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` followed by facade
dispatch checks: facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override.

## Plugin Install Smoke

Script:

```text
scripts/checks/plugin-install-smoke.bash
```

Packs a synthetic plugin package and the `install` package, installs the
installer into a temporary prefix, runs `dim installer install plugin` against the
packed plugin tarball, and confirms `dim plugins` (a `dim-cli` command,
run directly against the packed CLI) reports it enabled.

## Core workspace controller relay smoke

```sh
node scripts/checks/controller-workspace-relay-smoke.mjs WORKSPACE_IMAGE
```

Requires matched built packages, Docker and Sysbox. Creates a disposable core
workspace from the supplied image, resolves an owned in-agent loopback relay,
and verifies concurrent binary transfers with half-close responses, relay reuse,
UUID fencing and discard cleanup. Host sockets are not mounted into the agent.
The script cleans its owned workspace and state on success or failure.

Centralized External URLs tests separately verify live HTTP/TCP/WebSocket
routing, approval, ingress removal, route rebinding, and denial after workspace
name or cached IP reuse. The retired Project-root plus nested-agent example is
not a supported verification path.

## Native Project Workspace Verification

`scripts/checks/native-workspace-smoke.mts` verifies actual Native Git
bootstrap, scoped proposal transport and the common workspace runtime through
private disposable state and generated service credentials. Its runtime image
must be explicitly selected from reviewed local artifacts.

`tests/host/core/multiRepositoryWorkspaceRuntime.test.ts` exercises
multiple independently imported repositories in one actual Sysbox workspace
when `DIM_NATIVE_MULTI_REPOSITORY_IMAGE` selects a reviewed local image. It checks
independent origins and grants, configured working directory, Git identity,
proposal pushes, recreation with retained data, and exclusion of a private
configuration checkout when only the public repository is selected. It owns and
cleans its generated services, workspace resources and temporary state.

## Native CI Runtime Verification

`scripts/checks/native-ci-runtime-smoke.mts` exercises an actual isolated
container or VM runner with a disposable candidate script, checkout and
read-only host configuration. Invoke it with an explicit `container|vm` runtime,
supervisor image and digest-pinned Ubuntu job image. It checks the selected
runtime's filesystem, configuration and nested-container boundaries. The VM path
requires readable/writable KVM and the reviewed runner artifacts.

Centralized Native Git and CI integration tests separately exercise service
identity, exact repository-input acquisition, authenticated claims, result
publication, review and checked promotion. Packaged installation, service
protocols and physical runtime mechanics have separate verification owners.

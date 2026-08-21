# Installation Scripts

## Ubuntu Host Install

Script:

```text
scripts/install-host-ubuntu.bash <sysbox|gvisor|rootless-podman|runc>
```

Behavior:

1. Validate the selected backend and print a development-only warning and a summary of packages, downloads,
   service changes, group changes, and the AppArmor exception.
2. Continue only when the user enters exactly `yes`.
3. For `sysbox`, determine `SYSBOX_VERSION`, default `0.7.0`.
4. For `sysbox`, determine `SYSBOX_ARCH`, default `dpkg --print-architecture`.
5. For `sysbox`, select pinned SHA-256 for supported architectures:
   - `arm64`
   - `amd64`
6. Install `apparmor`, `curl`, `docker.io`, and `jq`; install `fuse3` and `uidmap` and
   build the rootless workspace image when rootless Podman is selected.
   On Ubuntu hosts that restrict unprivileged user namespaces through
   AppArmor, install the path-scoped `/usr/local/bin/rootlesskit` profile via
   `scripts/install-rootlesskit-apparmor-profile-ubuntu.bash`. The container
   CI lane invokes the same script before exercising rootless-DinD sidecars.
   When a container can observe the host restriction sysctl but has no
   writable AppArmor securityfs policy interface, the script leaves policy
   loading to the runner host instead of invoking a parser that cannot reach
   the kernel interface.
7. For `sysbox`, create a uniquely named, invoking-user-owned temporary file, download the
   Sysbox CE deb into it, and remove it when the script exits.
8. For `sysbox`, verify SHA-256.
9. For `sysbox`, install the deb.
10. For `sysbox`, add an idempotent local `fusermount3` AppArmor rule limited to FUSE
    mounts below `/var/lib/sysboxfs/`, then reload that profile.
11. For `sysbox`, reload systemd.
12. For `sysbox`, restart Docker.
13. For `sysbox`, restart Sysbox so AppArmor changes take effect and stale in-memory
    container registrations are cleared.
14. Record the selected backend as `workspaceBackend` in the invoking user's
    DIM configuration.
15. For every selection, add the invoking non-root user to the `docker` group.
16. For every selection, explain that the user must log in again or run `newgrp docker` once
    before the current session can use Docker without `sudo`.

Unsupported Sysbox architectures must fail. Each invocation installs exactly
one backend and records it in DIM user configuration. From a source checkout,
the operator runs `just run-cli doctor` afterward. Testing every installer uses a separate KVM guest per
backend rather than requiring Sysbox and gVisor to coexist on one host.

## gVisor runsc Install

Script:

```text
scripts/install-runsc-linux.bash
```

Behavior:

1. Determine `GVISOR_CHANNEL`, default `release/latest`.
2. Determine `GVISOR_ARCH`, default `uname -m`.
3. Download from `https://storage.googleapis.com/gvisor/releases/<channel>/<arch>`.
4. Download:
   - `runsc`
   - `runsc.sha512`
   - `containerd-shim-runsc-v1`
   - `containerd-shim-runsc-v1.sha512`
5. Verify SHA-512 sums.
6. Mark binaries executable.
7. Move binaries to `/usr/local/bin`.
8. Run `/usr/local/bin/runsc install`.
9. Restart Docker.
10. Print `runsc --version`.

## KVM Host-install Smoke

`scripts/install-kvm-verify-deps-ubuntu.bash` installs QEMU, qcow2,
cloud-image, and SSH tooling and adds the invoking non-root user to the `kvm`
group; it does not install a runtime backend. It requires the exact
confirmation `yes` and explains that the login session must be refreshed
before the new group membership is active.
`scripts/kvm-host-install-smoke.bash BACKEND [--verbose]` verifies one backend,
while `just verify environments-kvm [--verbose]` verifies every backend in a
separate VM. Each check boots a checksum-verified Ubuntu cloud-image VM with
`/dev/kvm`, clones the committed repository state from a Git bundle, installs
the selected backend in isolation, verifies its runtime, and deletes the VM
overlay and SSH key on exit. A full source checkout retains its history; a
shallow checkout is converted to a self-contained single-commit repository
before bundling. Uncommitted and untracked files are intentionally excluded.
The runc check installs the source verification toolchain after the host
installer and runs `just verify self-development`, covering the canonical
Project's unprivileged agent, private rootless-DinD sidecar, and installed
RootlessKit AppArmor profile end to end. The QEMU verification user has the
explicit UID 1001, keeping it distinct from the rootless-DinD image's UID 1000
and matching the UID relationship commonly exposed by GitHub-hosted runners.
The base cloud image is cached under `.local/kvm`. Default output names each
stage and emits only the final 30 lines of a failing stage; `--verbose`
streams full guest, build, and workload logs.

The `rootless-podman` workload runs the outer container with the exact
capability set `workspaceRuntimePlan()` grants
(`packages/core/src/runtimeBackends.ts`) instead of `--privileged`, so
it also disables Docker system-path confinement to let the nested rootless
runtime mount its own procfs, and
`scripts/kvm-host-install-smoke.bash rootless-podman` is the real verification that
those capabilities are sufficient for nested unprivileged user namespaces on
a genuinely fresh (singly-nested) host — something a doubly-nested dev
sandbox cannot exercise, since even `--privileged` nested user-namespace
creation fails there for unrelated reasons. Full DIM contract verification
must run in the same environment after rootless Podman is installed and
recorded as its backend.

## Ubuntu Bootstrap

Script:

```text
scripts/bootstrap-ubuntu.bash
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
7. Run `just check`.
8. Run `just verify plugin-install`.
9. Build the Docker and rootless Podman project workspace images.
10. Run `doctor` for the backend persisted by the installer.
11. Exit non-zero if that backend doctor reports host runtime gaps.

## Smoke Script

Script:

```text
scripts/container-sysbox-isolation-smoke.bash
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
scripts/lib/local-npm-registry.bash
```

Sourced, not run directly. Provides `dim_start_local_npm_registry WORK_DIR`,
`dim_publish_to_local_registry TARBALL...`, and
`dim_stop_local_npm_registry` so a script can install unreleased local
package builds through ordinary `npm install`/`mise use --raw --global npm:...` instead
of the real npm registry. Runs `verdaccio` via `npx` (no global install, so
no root/writable-prefix requirement), binds it to `0.0.0.0` explicitly
(verdaccio defaults to IPv6 loopback only), registers one throwaway user via
verdaccio's legacy user API, and points the registry at both
`npm_config_registry` and an isolated `NPM_CONFIG_USERCONFIG` file rather
than the caller's real npm config.

## mise Install Smoke

Script:

```text
scripts/mise-install-smoke.bash
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
scripts/plugin-install-smoke.bash
```

Packs a synthetic plugin package and the `install` package, installs the
installer into a temporary prefix, runs `dim install-plugin` against the
packed plugin tarball, and confirms `dim plugin list` (a `dim-cli` command,
run directly against the packed CLI) reports it enabled.

## Example External URL Smoke

Script:

```text
scripts/external-url-example-smoke.bash
```

`just verify example current-installed auto external-urls`. Requires Docker. Executes
[examples/features/external-urls/README.md](../../examples/features/external-urls/README.md)
against real containers: builds local packages and the workspace image,
starts a project-root container, starts the nested `dev` Compose service and
its own `deep` nested container, runs a host DIM controller and reverse proxy,
provides wildcard DNS with dnsmasq, uses `dim external-url` to discover the
plugin ingresses and create URLs for both nesting depths, fetches both
sentinels from a separate curl container, and revokes the routes. The doc and
script must change together.

## Multi-Repository Project Example Smoke

`scripts/multi-repository-example-smoke.bash`, invoked by
`just verify example current-installed auto multi-repository`, builds and installs local packages,
copies `examples/projects/multi-repository/repos/` to a temporary directory, initializes and
pushes real Git repositories, and
verifies the documented workspace and secret boundary against managed Gitea.
The trusted workspace deploys the reviewed secret service on its own nested
Docker daemon; the smoke verifies the agent service's independent daemon
cannot see that service and its environment does not contain the raw secret.

## Single-Repository Project Example Smoke

`scripts/single-repository-example-smoke.bash`, invoked by `just verify example
current-installed auto single-repository`, verifies the default
one-repository/no-secret shape, including an unprotected direct `main` push,
explicit workspace resource limits, an unprivileged Project-owned agent, its
private rootless DinD sidecar, nested container execution, and the agent HTTP
application.

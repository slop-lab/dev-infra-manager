# Installation Scripts

## Ubuntu Host Install

Script:

```text
scripts/install-host-ubuntu.sh <sysbox|gvisor|rootless-podman|runc>
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
6. Install `curl`, `docker.io`, and `jq`; install `fuse3` and `uidmap` when rootless Podman is selected.
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
14. For every selection, add the invoking non-root user to the `docker` group.
15. For every selection, explain that the user must log in again or run `newgrp docker` once
    before the current session can use Docker without `sudo`.

Unsupported Sysbox architectures must fail. Each invocation installs exactly
one backend, and its just recipe runs `doctor --backend` afterward. Testing
every installer uses a separate KVM guest per backend rather than requiring
Sysbox and gVisor to coexist on one host.

## gVisor runsc Install

Script:

```text
scripts/install-runsc-linux.sh
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

`just install-kvm-verify-deps-ubuntu` installs QEMU, qcow2, cloud-image, and SSH tooling only; it does not install a runtime backend. `just verify-host-backend-kvm BACKEND [--verbose]` verifies one backend, while `just verify-host-backends-kvm [--verbose]` verifies every backend in a separate VM. Each check boots a checksum-verified Ubuntu cloud-image VM with `/dev/kvm`, clones the committed repository state from a Git bundle, installs the selected backend in isolation, verifies its runtime, and deletes the VM overlay and SSH key on exit. A full source checkout retains its history; a shallow checkout is converted to a self-contained single-commit repository before bundling. Uncommitted and untracked files are intentionally excluded. The base cloud image is cached under `.local/kvm`. Default output names each stage and emits only the final 30 lines of a failing stage; `--verbose` streams full guest, build, and workload logs.

## Ubuntu Bootstrap

Script:

```text
scripts/bootstrap-ubuntu.sh
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
7. Run `just verify`.
8. Build the Docker and rootless Podman project workspace images.
9. Build the secret runtime example image.
10. Run `doctor --backend` for the selected backend.
11. Exit non-zero if that backend doctor reports host runtime gaps.

## Smoke Script

Script:

```text
scripts/smoke.sh
```

Behavior:

1. Build default agent image.
2. Build secret runtime example image.
3. Run default agent image command smoke with inner Docker disabled.
4. Create temporary config using directory storage.
5. Initialize managed Git host.
6. Create trusted runtime repo.
7. Seed initial protected ref through trusted `git update-ref`.
8. Push reviewed proposal branch.
9. Create, approve, and merge PR.
10. Deploy secret runtime.
11. Poll `/healthz`.
12. Print `smoke-ok` on success.
13. Clean up temp files, container, and smoke image on exit.

## Local npm Registry Helper

Script:

```text
scripts/lib/local-npm-registry.sh
```

Sourced, not run directly. Provides `dim_start_local_npm_registry WORK_DIR`,
`dim_publish_to_local_registry TARBALL...`, and
`dim_stop_local_npm_registry` so a script can install unreleased local
package builds through ordinary `npm install`/`mise use -g npm:...` instead
of the real npm registry. Runs `verdaccio` via `npx` (no global install, so
no root/writable-prefix requirement), binds it to `0.0.0.0` explicitly
(verdaccio defaults to IPv6 loopback only), registers one throwaway user via
verdaccio's legacy user API, and points the registry at both
`npm_config_registry` and an isolated `NPM_CONFIG_USERCONFIG` file rather
than the caller's real npm config.

## mise Install Smoke

Script:

```text
scripts/mise-install-smoke.sh
```

`just verify-mise-install-smoke`. Requires Docker and network access.
Builds and packs `core`, `dim-cli`, and `install`, publishes them to a
disposable local npm registry inside a throwaway container, installs a
pinned `mise` release predating its npm-backend download-popularity gate
(see [Installer Facade](../14-installer-facade.md)), and runs
`mise use -g 'npm:@slop-lab/install-dim@<version>'` followed by facade
dispatch checks: facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override.

## Plugin Install Smoke

Script:

```text
scripts/plugin-install-smoke.sh
```

Packs a synthetic plugin package and the `install` package, installs the
installer into a temporary prefix, runs `dim install-plugin` against the
packed plugin tarball, and confirms `dim plugin list` (a `dim-cli` command,
run directly against the packed CLI) reports it enabled.

## Example Project Smoke

Script:

```text
scripts/example-project-smoke.sh
```

`just verify-example-project`. Requires Docker and a reachable managed
Gitea. Executes
[examples/multi-repo-project/README.md](../../examples/multi-repo-project/README.md)
command for command: installs DIM through the installer facade against a
disposable local npm registry, copies the three repository skeletons under
`examples/multi-repo-project/repos/`, registers them as a Project, creates a
real workspace container, and verifies it (`dim show --json` phase,
`docker ps` against the resolved `containerName`, `dim exec`, `dim run`,
`codex`/`claude` reachable in the nested `dev` service once its own startup
command finishes installing them, a further nested container created from
inside `dev` through its mounted nested Docker socket, cross-repository
access through `$DIM_GIT_BASE_URL`, and the `secrets` repository's service
built and run directly (outside `.dim/docker-compose.yml` and the workspace
lifecycle entirely) with a confirmation that the workspace's own environment
never receives the raw secret) before discarding everything. The doc and
this script must change together.

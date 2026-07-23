# Installation Scripts

## Ubuntu Host Install

Script:

```text
scripts/install-host-ubuntu.sh
```

Behavior:

1. Print a development-only warning and a summary of packages, downloads,
   service changes, group changes, and the AppArmor exception.
2. Continue only when the user enters exactly `yes`.
3. Determine `SYSBOX_VERSION`, default `0.7.0`.
4. Determine `SYSBOX_ARCH`, default `dpkg --print-architecture`.
5. Select pinned SHA-256 for supported architectures:
   - `arm64`
   - `amd64`
6. Install `curl`, `docker.io`, and `jq`.
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

Unsupported architectures must fail.

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
5. Run Ubuntu host install.
6. Install project dependencies with frozen lockfile.
7. Run `just verify`.
8. Build default agent image.
9. Build secret runtime example image.
10. Run `doctor`.
11. Exit non-zero if doctor reports host runtime gaps.

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

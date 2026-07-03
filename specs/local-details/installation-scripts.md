# Installation Scripts

## Ubuntu Host Install

Script:

```text
scripts/install-host-ubuntu.sh
```

Behavior:

1. Determine `SYSBOX_VERSION`, default `0.7.0`.
2. Determine `SYSBOX_ARCH`, default `dpkg --print-architecture`.
3. Select pinned SHA-256 for supported architectures:
   - `arm64`
   - `amd64`
4. Install `curl`, `docker.io`, and `jq`.
5. Download the Sysbox CE deb from Nestybox release storage.
6. Verify SHA-256.
7. Install the deb.
8. Reload systemd.
9. Restart Docker.
10. Start Sysbox.

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

1. Install `git`, `nodejs`, `npm`, and `just`.
2. Install pinned pnpm if missing or wrong version.
3. Run Ubuntu host install.
4. Install project dependencies with frozen lockfile.
5. Run `just verify`.
6. Build default agent image.
7. Build secret runtime example image.
8. Run `doctor`.
9. Exit non-zero if doctor reports host runtime gaps.

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

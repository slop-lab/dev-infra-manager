# Doctor Checks

## Scope

This specification defines host readiness checks.

`doctor` checks must reflect the selected config.
They must not require Sysbox checks when the selected backend is gVisor or rootless Podman.

## Output

Each check prints:

```text
<ok|fail>\t<name>\t<detail>
```

If any check fails, CLI exit code is `1`.

## Common Checks

Always check:

- Node.js: `node --version`
- pnpm: `pnpm --version`
- just: `just --version`
- git: `git --version`
- timeout: `timeout --version`
- Docker CLI: `docker --version`
- Docker daemon: `docker info --format "{{.ServerVersion}}"`
- cgroup v2: `/proc/filesystems` contains `cgroup2`

Docker daemon checks should retry with sudo when the first failure contains `permission denied`.

## Runtime Checks

### Sysbox

Checks:

- `sysbox-runc --version`
- `systemctl is-active sysbox.service`
- Docker runtime registration for configured runtime.
- `docker run --rm --runtime=<runtime> --pull=missing hello-world:latest`
- `/dev/kvm` readable and writable.

### gVisor

Checks:

- `runsc --version`
- Docker runtime registration for configured runtime.
- `docker run --rm --runtime=<runtime> --pull=missing hello-world:latest`

### Rootless Podman

Checks:

- Configured agent image exists through `docker image inspect`.
- `podman --version` succeeds inside the configured agent image.
- `/dev/fuse` readable and writable.

## Storage Checks

### Loopback

Checks:

1. Create temp directory.
2. Create an 8 MiB disk image with `truncate`.
3. Run `sudo losetup -f --show <image>`.
4. Detach the loop device if created.
5. Remove temp directory.

### Directory

Reports success with detail:

```text
available; diskBytes is not enforced by this backend
```

## Error Detail

Command checks should report the first output line when possible.
Runtime execution checks should report the first Docker error line when execution fails.

## Verification

Required verification:

- Unit test for Sysbox runtime execution check.
- Unit test for sudo retry on permission errors.
- Unit test for first-line error detail.
- Unit test that gVisor config uses gVisor checks and omits Sysbox service checks.
- Manual or scripted `doctor --config` on installed backends.

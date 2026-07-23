# Runtime Backends

`dev-infra-manager` separates agent runtime selection from job storage selection.

Agent runtime backends decide how the outer agent workspace container runs and how nested container tooling is exposed inside it.
Storage backends decide how the host prepares the job workspace and nested runtime data directory.

## Agent Runtime Backends

### `sysbox`

`sysbox` is the default backend.

Properties:

- Uses Docker with the configured Sysbox runtime, normally `sysbox-runc`.
- Starts an inner Docker daemon inside the agent workspace image.
- Mounts the job workspace and nested Docker data root into the agent container.
- Does not mount the host Docker socket.
- Requires Sysbox services to run on the host.
- Requires host support for id-mapped mounts.
- The primary production target also expects KVM to be available.

This backend provides the strongest fit for Docker-compatible nested container workflows without giving the agent access to the host Docker daemon.

### `gvisor`

`gvisor` is the preferred no-KVM fallback for Docker-compatible nested container workflows.

Properties:

- Uses Docker with the configured gVisor runtime, normally `runsc`.
- Starts an inner Docker daemon inside the same agent workspace image used by Sysbox.
- Adds the capabilities required for Docker-in-gVisor operation.
- Disables the Docker 29 containerd snapshotter for nested daemon compatibility.
- Does not require KVM.
- Does not mount the host Docker socket.

This backend is useful when Sysbox cannot start because the host or nested environment blocks id-mapped mount setup.

The host must install and register `runsc` as a Docker runtime before this backend can pass `doctor`.

Install the latest gVisor release binaries and register the Docker runtime with:

```bash
just install-runsc-linux
```

This follows the official gVisor manual install flow: download `runsc` and `containerd-shim-runsc-v1`, verify their SHA-512 checksums, move them into `/usr/local/bin`, run `runsc install`, and restart Docker.

Example agent config:

```json
{
  "image": "dev-infra-agent-workspace:latest",
  "runtime": "runsc",
  "runtimeBackend": {
    "kind": "gvisor",
    "dockerRuntime": "runsc"
  },
  "workspacePath": "/workspace",
  "runtimeDataPath": "/var/lib/docker",
  "env": {},
  "gitEnv": {}
}
```

### `rootless-podman`

`rootless-podman` is a lower-privilege fallback for workloads that can use Podman instead of a nested Docker daemon.

Properties:

- Uses a Podman-based agent image.
- Runs nested container operations as the `agent` user.
- Does not start an inner Docker daemon.
- Does not require Sysbox or KVM.
- May require `/dev/fuse` on the host for rootless overlay storage.
- Workloads must use `podman` or a configured Docker-compatible Podman socket.

Build the included image with:

```bash
just build-agent-podman-image
```

Example agent config:

```json
{
  "image": "dev-infra-agent-workspace-podman:latest",
  "runtime": "runc",
  "runtimeBackend": {
    "kind": "rootless-podman",
    "dockerRuntime": "runc"
  },
  "workspacePath": "/workspace",
  "runtimeDataPath": "/var/lib/docker",
  "env": {},
  "gitEnv": {}
}
```

## Storage Backends

### `loopback`

`loopback` is the default storage backend.

Properties:

- Creates a per-job disk image.
- Formats it as ext4.
- Mounts it with a loop device.
- Places both workspace data and nested runtime data inside that mounted filesystem.
- Enforces aggregate job disk usage through the size of the disk image.

This backend is the production default when loop device setup is available.

### `directory`

`directory` is a compatibility fallback for environments where loop device setup is not available.

Properties:

- Creates normal host directories for the workspace and nested runtime data.
- Does not require loop devices.
- Does not enforce `diskBytes`.

Use this backend only when the surrounding environment already enforces disk usage or when running development checks in a constrained nested environment.

Example:

```json
{
  "storageBackend": {
    "kind": "directory"
  }
}
```

## Backend Selection

Recommended order:

1. `sysbox` runtime with `loopback` storage for production hosts that support Sysbox and loop devices.
2. `gvisor` runtime with `loopback` storage when KVM is unavailable but loop devices work.
3. `gvisor` runtime with `directory` storage for nested environments that block loop setup and have an external disk quota.
4. `rootless-podman` runtime with `directory` storage for workloads that do not require Docker-in-Docker compatibility.

Run `doctor --config <file>` after changing backend settings. `doctor` reports checks for the selected runtime and storage backend instead of always checking Sysbox.

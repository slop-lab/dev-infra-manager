# Runtime Backends

## Scope

Runtime backends define how an agent workspace container is launched and how nested container tooling is made available inside it.

Runtime backends must not change job path calculation, managed Git behavior, or secret runtime deployment.

## Common Contract

Every runtime backend produces:

- Optional outer Docker runtime name.
- Additional Linux capabilities for the outer container.
- Bind mounts.
- Environment variables.
- Agent image.

The common Docker runner adds:

- `docker run`
- `--cpus <resourceProfile.cpuCount>`
- `--memory <resourceProfile.memoryBytes>`
- `--pids-limit <resourceProfile.pidsLimit>`
- Backend runtime, capabilities, mounts, and env.
- Optional container name.
- Optional detach flag.
- `--rm` by default.
- Configured agent image.
- User command.

`timeout <timeoutSeconds>s docker ...` wraps execution.

## `sysbox`

Purpose:

- Default production backend for Docker-compatible nested container workflows.

Runtime plan:

- Docker runtime: configured `dockerRuntime`, normally `sysbox-runc`.
- Capabilities: none added by this project.
- Mounts:
  - Job workspace to `agent.workspacePath`.
  - Job runtime data to `agent.runtimeDataPath`.
- Env:
  - `DEV_INFRA_NESTED_ENGINE=docker`
  - `DEV_INFRA_START_DOCKERD=1`
- Image: `agent.image`.

Host requirements:

- `sysbox-runc` binary.
- Sysbox service active.
- Docker runtime registered.
- Sysbox container execution works.
- KVM is expected for the default production target.

## `gvisor`

Purpose:

- No-KVM Docker-compatible fallback using gVisor `runsc`.

Runtime plan:

- Docker runtime: configured `dockerRuntime`, normally `runsc`.
- Capabilities:
  - `AUDIT_WRITE`
  - `CHOWN`
  - `DAC_OVERRIDE`
  - `FOWNER`
  - `FSETID`
  - `KILL`
  - `MKNOD`
  - `NET_BIND_SERVICE`
  - `NET_ADMIN`
  - `NET_RAW`
  - `SETFCAP`
  - `SETGID`
  - `SETPCAP`
  - `SETUID`
  - `SYS_ADMIN`
  - `SYS_CHROOT`
  - `SYS_PTRACE`
- Mounts:
  - Job workspace to `agent.workspacePath`.
  - Job runtime data to `agent.runtimeDataPath`.
- Env:
  - `DEV_INFRA_NESTED_ENGINE=docker`
  - `DEV_INFRA_START_DOCKERD=1`
  - `DEV_INFRA_DOCKERD_FLAGS=--feature containerd-snapshotter=false`
- Image: `agent.image`.

Host requirements:

- `runsc` binary.
- Docker runtime registered as `runsc` unless configured otherwise.
- `docker run --runtime=runsc hello-world:latest` works.

Verified current behavior:

- `runsc` release `release-20260622.0` can run the outer agent container.
- The included Docker agent image starts inner Docker under gVisor.
- Inner Docker can run nested `hello-world`.

## `rootless-podman`

Purpose:

- Lower-privilege fallback for workloads that can use Podman instead of Docker-in-Docker.

Runtime plan:

- Docker runtime: configured `dockerRuntime`, normally `runc`.
- Capabilities: none added by this project.
- Mounts:
  - Job workspace to `agent.workspacePath`.
  - Job runtime data to `/home/agent/.local/share/containers`.
- Env:
  - `DEV_INFRA_NESTED_ENGINE=podman`
  - `DEV_INFRA_START_DOCKERD=0`
  - `XDG_RUNTIME_DIR=/tmp/agent-runtime`
- Image: `agent.image`, normally `dev-infra-agent-workspace-podman:latest`.

Host requirements:

- Configured agent image present.
- `podman --version` works inside the image.
- `/dev/fuse` is accessible for rootless storage behavior expected by Podman.

## Invariants

- No backend may mount the host Docker socket into the agent container.
- No backend may inject raw secrets.
- Backend env may be overridden by explicit `agent.env` and `agent.gitEnv`; configs must not use that to add secrets.
- Backend selection must be reflected in `doctor --config`.

## Verification

Required verification:

- Unit tests for generated Docker args for each backend.
- `doctor --config` tests that selected backend checks are used.
- Image build and command smoke for included images.
- Integration job run for available host backends.

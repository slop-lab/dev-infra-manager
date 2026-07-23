# Status

## Current Status

The project has an initial TypeScript implementation for configuration validation, job filesystem lifecycle planning, doctor checks, and agent container command generation.

Documented decisions:

- The repository name is `dev-infra-manager`.
- This infrastructure repository is organized as a monorepo.
- Agent workspace containers are untrusted.
- Secret-bearing containers are separate from agent workspace containers.
- Raw product/runtime secrets are never injected into agent workspace
  containers; the internal Git writer credential is an explicit constrained
  capability that cannot push protected branches.
- Agents can receive approved environment variables and Git configuration for job execution.
- Agents can create nested containers through selected runtime backends.
- Agent workspaces are ephemeral per job.
- Resource limits apply at the agent workspace boundary.
- Disk quota uses a per-job loopback filesystem by default.
- The managed Git host uses bare Git repositories with a custom pull request layer.
- Managed Git repositories block direct pushes to protected refs.
- The managed Git host may run on the same machine or a separate machine.
- Secret-bearing containers are deployed by a controller from approved refs.
- The controller is part of the trusted boundary.
- Sysbox remains the default production runtime; gVisor and rootless Podman are available for no-KVM or constrained environments.

Implemented:

- pnpm monorepo workspace with the manager under `apps/manager` and reserved
  `apps/` and `packages/` boundaries for optional hosting services.
- TypeScript project using pnpm.
- just recipes for install, host install, check, test, build, verify, doctor, sample config generation, and runtime image builds.
- CLI entrypoint with `init-config`, `doctor`, `config validate`, `job prepare`, `job cleanup`, `job run`, `agent run-command`, and `agent run`.
- Config validation and default config generation.
- Configuration reference documentation.
- Storage backend abstraction with loopback and directory implementations.
- Atomic job ID state claiming to prevent accidental job overwrite.
- Host command execution abstraction for testable privileged operations.
- Agent runtime backend abstraction with Sysbox, gVisor, and rootless Podman command generation.
- One-shot agent job orchestration with guaranteed cleanup.
- Managed Git host state initialization.
- Bare Git repository creation.
- Protected-ref `pre-receive` hook installation for managed bare repositories.
- Custom pull request metadata with create, list, show, approve, and fast-forward merge commands.
- Secret runtime deployment planning and execution from configured approved refs.
- Long-running controller mode that watches the approved ref and deploys when it changes.
- Atomic controller deploy lock to prevent concurrent secret runtime replacement.
- Agent workspace Docker image for Sysbox and gVisor Docker-in-Docker use.
- Agent workspace Podman image for rootless Podman use.
- Secret runtime example image with an HTTP health endpoint.
- systemd controller service template.
- Ubuntu host installation script for Docker and pinned Sysbox CE packages.
- Ubuntu bootstrap script for toolchain install, host install, dependency install, verification, image build, and doctor.
- Reproducible integration smoke script covering image-store isolation,
  aggregate cgroup limits, nested Docker execution, managed Git PR flow,
  approved-ref secret deployment, and health check.
- Unit tests for size parsing, config validation, job planning, storage backend planning, duplicate job protection, runtime backend command generation, doctor runtime execution checks, one-shot agent job orchestration, managed Git pull request flow, secret runtime deployment planning, controller state handling, and controller deploy locking.
- Docker-managed local Gitea service with generated admin and shared-writer
  credentials, loopback-only HTTP access, and persistent volume storage.
- Role-neutral `repo register`, `repo list`, and `repo show` commands that
  import an existing bare repository without retaining a host mount.
- Persistent `workspace run`, `show`, `stop`, and confirmed `discard`
  lifecycle with metadata-first journaling, labels, prefixes, reconciliation,
  and a named inner-Docker volume.
- Container-internal Git clone and identity/credential environment injection
  without credential-bearing remote URLs.
- Container lifecycle smoke coverage for free branch pushes, protected branch
  rejection, nested containers, stop/start persistence, and cleanup.

Current environment verification:

- Docker 29.1.3 is installed and can run `hello-world`.
- Included agent and secret runtime images build successfully.
- Included rootless Podman agent image builds successfully.
- Agent image command smoke test passes with inner Docker startup disabled.
- Rootless Podman with directory storage passes `doctor --config` in the current environment.
- Rootless Podman with directory storage can run a full `job run` lifecycle in the current environment.
- Secret runtime deployment from an approved bare Git ref was verified end-to-end with Docker and `/healthz`.
- `just smoke` verifies the Docker-backed integration path that is available in the current environment.
- gVisor `runsc` release `release-20260622.0` is installed and registered with Docker.
- gVisor with directory storage passes `doctor --config` in the current environment.
- gVisor with directory storage can run a full `job run` lifecycle in the current environment.
- gVisor with directory storage can run a nested Docker `hello-world` container from inside the agent workspace.
- Sysbox CE 0.7.0 amd64 is installed and registered with Docker.
- Sysbox can run the agent workspace with a separate inner Docker daemon.
- Sysbox inner Docker can run `hello-world` and does not see a uniquely tagged
  host-only image; an inner-only tag is likewise absent from the host daemon.
- An agent limited to 1 CPU, 256 MiB memory, and 128 PIDs observes those exact
  aggregate cgroup v2 limits while running the nested workload.
- Loop device setup is blocked in the current nested environment.
- `/dev/kvm` is not exposed in the current nested environment.
- Config-aware `doctor` can now check the selected runtime and storage backend instead of always checking Sysbox and loopback.

## Future Work

- Validate the repository-backed workspace lifecycle end-to-end on the outer
  Sysbox host; the current nested environment covers the explicit privileged
  runc compatibility path.
- Add loopback-storage integration tests on a host with loop device setup available.
- Add gVisor integration tests on a host with `runsc` registered as a Docker runtime.
- Add rootless Podman integration tests on a host with `/dev/fuse` exposed.

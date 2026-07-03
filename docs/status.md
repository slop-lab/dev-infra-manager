# Status

## Current Status

The project has an initial TypeScript implementation for configuration validation, job filesystem lifecycle planning, doctor checks, and agent container command generation.

Documented decisions:

- The repository name is `dev-infra-manager`.
- This infrastructure repository is organized as a monorepo.
- Agent workspace containers are untrusted.
- Secret-bearing containers are separate from agent workspace containers.
- Raw secrets are never injected into agent workspace containers.
- Agents can receive approved environment variables and Git configuration for job execution.
- Agents can create nested containers through Sysbox.
- Agent workspaces are ephemeral per job.
- Resource limits apply at the agent workspace boundary.
- Disk quota uses a per-job loopback filesystem by default.
- The managed Git host uses bare Git repositories with a custom pull request layer.
- The managed Git host may run on the same machine or a separate machine.
- Secret-bearing containers are deployed by a controller from approved refs.
- The controller is part of the trusted boundary.
- The primary supported runtime assumes KVM is available.

Implemented:

- TypeScript project using pnpm.
- just recipes for install, host install, check, test, build, verify, doctor, and sample config generation.
- CLI entrypoint with `init-config`, `doctor`, `config validate`, `job prepare`, `job cleanup`, `job run`, `agent run-command`, and `agent run`.
- Config validation and default config generation.
- Configuration reference documentation.
- Per-job loopback filesystem command planning.
- Atomic job ID state claiming to prevent accidental job overwrite.
- Host command execution abstraction for testable privileged operations.
- Docker/Sysbox agent command generation.
- One-shot agent job orchestration with guaranteed cleanup.
- Managed Git host state initialization.
- Bare Git repository creation.
- Custom pull request metadata with create, list, show, approve, and fast-forward merge commands.
- Secret runtime deployment planning and execution from configured approved refs.
- Long-running controller mode that watches the approved ref and deploys when it changes.
- Atomic controller deploy lock to prevent concurrent secret runtime replacement.
- Agent workspace Docker image for Sysbox-based nested container use.
- Secret runtime example image with an HTTP health endpoint.
- systemd controller service template.
- Ubuntu host installation script for Docker and pinned Sysbox CE packages.
- Ubuntu bootstrap script for toolchain install, host install, dependency install, verification, image build, and doctor.
- Reproducible integration smoke script covering images, managed Git PR flow, approved-ref secret deployment, and health check.
- Unit tests for size parsing, config validation, job planning, duplicate job protection, Docker command generation, doctor Sysbox execution checks, one-shot agent job orchestration, managed Git pull request flow, secret runtime deployment planning, controller state handling, and controller deploy locking.

Current environment verification:

- Docker 29.1.3 is installed and can run `hello-world`.
- Included agent and secret runtime images build successfully.
- Agent image command smoke test passes with inner Docker startup disabled.
- Secret runtime deployment from an approved bare Git ref was verified end-to-end with Docker and `/healthz`.
- `just smoke` verifies the Docker-backed integration path that is available in the current environment.
- Sysbox CE 0.7.0 arm64 is installed and registered with Docker.
- Sysbox service cannot start in the current nested environment because id-mapped mount setup returns `operation not permitted`.
- Running `hello-world:latest` with Docker `--runtime=sysbox-runc` fails in the current nested environment because Docker cannot connect to `sysbox-mgr`.
- Loop device setup is blocked in the current nested environment.
- `/dev/kvm` is not exposed in the current nested environment.

## Future Work

- Add integration tests on a fully privileged host with Sysbox service, KVM, and loop device setup available.
- Plan support for non-KVM and nested environments.
- Evaluate rootless operation after the primary runtime boundary is working.

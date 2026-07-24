# Trust Boundaries

## Boundary Summary

The system has three major execution boundaries:

- Agent workspace boundary.
- Secret-bearing runtime boundary.
- Host/controller boundary.

The agent workspace boundary is untrusted.
The secret-bearing runtime boundary is trusted only after human review of its effective source and runtime definition.
The host/controller boundary is privileged because it can create job filesystems, run containers, and deploy secret-bearing runtimes. A project must directly review the complete pinned DIM revision before trusting this boundary.

## Agent Workspace Boundary

Agent workspace containers:

- Must not receive raw product/runtime secrets. It may receive an explicit
  constrained infrastructure capability such as the internal Git writer
  credential.
- Must receive only approved non-secret environment variables.
- May receive Git-related environment variables needed to push proposals.
- Must not mount the host Docker socket.
- Must not mount secret-bearing runtime volumes.
- May run nested containers through the selected backend.
- Must use a per-job workspace.
- Must be resource-limited at the outer container boundary.

The final command inside the included agent images runs as the `agent` user.

## Secret-Bearing Runtime Boundary

Secret-bearing containers:

- May receive raw secrets through host-side configuration such as `secretRuntime.envFile`.
- Must be separate from agent workspace containers.
- Must not mount an agent workspace as a writable shared volume.
- Must be built and deployed from the configured approved ref.
- Must expose only the configured host-reachable interface needed by the agent runtime tooling layer.

Any source, Dockerfile, entrypoint, dependency lockfile, runtime config, or controller change that can affect secret access is secret-bearing for review purposes.

## Host And Controller Boundary

The host/controller boundary:

- Creates and tears down job filesystems.
- Runs Docker commands for agent and secret runtime containers.
- Manages local bare Git repositories and PR metadata.
- Installs and checks runtime support through scripts and doctor checks.
- Deploys secret-bearing containers.

Controller code is trusted infrastructure code only after direct human review of the complete pinned DIM revision. The complete project repository and all secret-bearing environment code also require human review before deployment.

## Git Boundary

Managed Git repositories are the transition point from untrusted agent output to reviewed source.

Agents may push proposal refs.
Agents must not directly update protected refs.
Protected refs must be updated through the managed PR merge path or trusted host-side administrative operations.

## Backend Boundary

Runtime backend choice changes the strength and shape of isolation.

- `sysbox` is the default production backend for Docker-compatible nested workloads.
- `gvisor` is the no-KVM Docker-compatible backend.
- `rootless-podman` is the lower-privilege backend for Podman-compatible workloads.

Storage backend choice changes disk enforcement.

- `loopback` enforces aggregate disk usage.
- `directory` does not enforce disk usage.

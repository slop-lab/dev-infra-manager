# Trust Boundaries

## Boundary Summary

The system has three major execution boundaries:

- Agent container boundary.
- Secret-bearing runtime boundary.
- Controller boundary.

The agent container boundary is untrusted.
The secret-bearing runtime boundary is trusted only after human review of its effective source and runtime definition.
The controller boundary is privileged. It runs in the workspace root outside
the agent container, owns the root nested-container runtime, and deploys
secret-bearing workloads. Host-side DIM additionally creates and reconciles
the outer workspace root. A project must directly review the complete pinned
DIM revision before trusting these layers.

## Agent Container Boundary

Agent containers:

- Must not receive raw product/runtime secrets. It may receive an explicit
  constrained infrastructure capability such as the internal Git writer
  credential.
- Must receive only approved non-secret environment variables.
- May receive Git-related environment variables needed to push proposals.
- Must not mount the host or workspace-root controller Docker socket.
- Must not mount secret-bearing runtime volumes.
- May run nested containers through an agent-specific inner runtime.
- Must run as an isolated child of a named workspace root.
- Must be resource-limited at the outer container boundary.

The agent's actual influence over anything outside its container and inner
runtime is limited to explicit controller interfaces and pushing proposals for
review (see Git Boundary).

## Secret-Bearing Runtime Boundary

Secret-bearing containers:

- May receive raw secrets through controller deployment configuration outside
  DIM Project state and agent-controlled files.
- Must run as a separate child of the workspace root, outside the agent
  container and the agent's nested runtime.
- Must not mount an agent-controlled checkout as a writable shared volume.
- Must be built and deployed from the configured approved ref.
- Must expose only the configured constrained interface needed by the agent
  tooling layer.

Any source, Dockerfile, entrypoint, dependency lockfile, runtime config, or controller change that can affect secret access is secret-bearing for review purposes.

## Controller Boundary

The controller boundary:

- Runs in the workspace root, outside the agent container.
- Owns the workspace-root nested-container runtime.
- Starts and reconciles agent and secret-bearing child containers.
- Keeps the agent's inner runtime separate from its own runtime.
- Deploys secret-bearing containers only from approved refs.

The host-side DIM boundary:

- Creates, reconciles, and discards outer workspace-root resources.
- Manages local bare Git repositories and PR metadata.
- Installs and checks runtime support through scripts and doctor checks.

Controller code is trusted infrastructure code only after direct human review of the complete pinned DIM revision. The complete project repository and all secret-bearing environment code also require human review before deployment.

## Git Boundary

Managed Git repositories are the transition point from untrusted agent output to reviewed source.

Agents may push proposal refs.
Agents must not directly update protected refs.
Protected refs must be updated through Git-host review/merge or trusted
host-side administrative operations.

## Backend Boundary

Runtime backend choice changes the strength and shape of isolation.

- `sysbox` is the default production backend for Docker-compatible nested workloads.
- `gvisor` is the no-KVM Docker-compatible backend.
- `rootless-podman` is the lower-privilege backend for Podman-compatible workloads.

Storage backend choice changes disk enforcement.

- `directory` does not enforce disk usage.

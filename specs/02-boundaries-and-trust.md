# Trust Boundaries

## Boundary Summary

The system has four major execution boundaries:

- Agent container boundary.
- Secret-bearing runtime boundary.
- Trusted Project lifecycle boundary.
- DIM host boundary.

The agent container boundary is untrusted.
The secret-bearing runtime boundary is trusted only after human review of its effective source and runtime definition.
The trusted Project lifecycle boundary is privileged. Its code runs in the
workspace container outside the agent container, owns the Project runtime, and
deploys secret-bearing workloads. It is an authority boundary and need not be
one long-running controller process. Host-side DIM creates and reconciles the
workspace container and runs the DIM host controller. A project must directly
review the complete pinned DIM revision before trusting these layers.

## Agent Container Boundary

Agent containers:

- Must not receive raw product/runtime secrets. It may receive an explicit
  constrained infrastructure capability such as the internal Git writer
  credential.
- Must receive only approved non-secret environment variables.
- May receive Git-related environment variables needed to push proposals.
- Must not mount the host runtime socket or Project runtime socket.
- Must not mount secret-bearing runtime volumes.
- May run nested containers through an agent-specific inner runtime.
- May receive a reviewed, deny-by-default controller proxy. A self-restart
  capability must derive its target from the trusted workspace grant and must
  not expose that grant, the original workspace socket, another workspace
  name, or any host-admin route to the agent.
- Must belong to a named workspace and be declared by reviewed Project code;
  DIM core does not define an agent resource.
- Must remain inside the resource-limited outer workspace boundary. A Project
  may add stricter per-service limits, but core does not currently impose
  separate agent-container limits.

The agent's actual influence over anything outside its container and inner
runtime is limited to explicit constrained interfaces and pushing proposals for
review (see Git Boundary).

## Secret-Bearing Runtime Boundary

Secret-bearing containers:

- May receive raw secrets through trusted deployment configuration outside
  DIM Project state and agent-controlled files.
- Must run as a separate child of the workspace root, outside the agent
  container and the agent's nested runtime.
- Must not mount an agent-controlled checkout as a writable shared volume.
- Must be built and deployed from the configured approved ref.
- Must expose only the configured constrained interface needed by the agent
  tooling layer.

Any source, Dockerfile, entrypoint, dependency lockfile, runtime config, or
lifecycle-code change that can affect secret access is secret-bearing for
review purposes.

## Trusted Project Lifecycle Boundary

Trusted Project lifecycle code:

- Runs in the workspace container, outside the agent container.
- Owns the Project runtime.
- Defines, starts, and reconciles agent and secret-bearing Project services.
- Explicitly decides whether an agent may trigger its reviewed setup again by
  exposing the workspace self-restart route through a constrained proxy.
- Keeps the agent's inner runtime separate from its own runtime.
- Deploys secret-bearing containers only from approved refs.
- Receives an available host `/dev/kvm` automatically when its backend
  supports KVM; host devices must not be passed into the untrusted agent
  container.

## DIM Host Boundary

Host-side DIM:

- Creates, reconciles, and discards workspace containers.
- Manages Project-scoped repositories and protection through managed Gitea.
- Installs and checks runtime support through scripts and doctor checks.
- Runs the DIM host controller and grants each workspace only its scoped,
  authenticated interfaces.

DIM host code is trusted infrastructure code only after direct human review of
the complete pinned DIM revision. The complete root repository and all
secret-bearing environment code also require human review before deployment.

## Git Boundary

Managed Git repositories are the transition point from untrusted agent output to reviewed source.

Agents may push proposal refs.
Agents must not directly update protected refs.
Protected refs must be updated through Git-host review/merge or trusted
host-side administrative operations.

## Backend Boundary

Runtime backend choice changes the strength and shape of isolation.

- `sysbox` is the default nested-container backend for Docker-compatible workloads.
- `gvisor` is the no-KVM Docker-compatible backend.
- `rootless-podman` is the lower-privilege backend for Podman-compatible workloads.

Storage backend choice changes disk enforcement.

- `directory` does not enforce disk usage.

# Trust Boundaries

## Boundary Summary

The system has five major execution boundaries:

- Agent container boundary.
- Secret-bearing runtime boundary.
- Trusted Project lifecycle boundary.
- DIM host boundary.
- Remote control-plane boundary.

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
- May request the protected Project root's fixed local-QEMU verification task.
  The agent receives neither `/dev/kvm` nor a QEMU binary. Candidate worktrees
  and explicitly named inputs are copied into the guest as untrusted data; no
  candidate-controlled program runs in the trusted workspace.
- Must not run as root in a container whose root identity carries host or
  trusted-workspace authority. UID 0 is permitted inside an explicitly
  rootless agent runtime when its user namespace maps that identity to the
  non-root workspace owner and the mapping is verified.
- May receive the agent controller socket and its distinct workspace-scoped
  agent grant. That endpoint exposes only plugin routes explicitly marked for
  the `agent` audience. Workspace lifecycle, command sessions, host inputs,
  and administration are absent. A self-restart capability still requires a
  reviewed, deny-by-default Project proxy which derives its target from the
  trusted workspace grant and does not expose that grant or socket.
- May receive a distinct development-service External URL socket whose reviewed
  proxy fixes the allowed ingress and exact container path, protocol, and
  shared gateway port. The caller supplies only an ingress; it cannot select or
  override that target. Existing generic External URL sockets must remain
  separate when other clients still require ingress-only target selection.
  The gateway may listen on the agent container's interfaces at that fixed
  port, but its application upstreams are restricted to loopback ports.
  This is not an intra-agent isolation boundary: a process with the socket can
  expose a loopback service available through the agent's existing network
  authority.
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
- May receive available host `/dev/kvm` under the immutable creation-time KVM
  policy when its backend supports KVM; interactive creation confirms this
  recommended grant. Host devices must not be passed into the untrusted agent
  container.

## DIM Host Boundary

Host-side DIM:

- Creates, reconciles, and discards workspace containers.
- Holds approval state and capability ceilings locally.
- Executes only operator-registered workload IDs after exact-tree admission.
- Installs and checks runtime support through scripts and doctor checks.
- Runs the DIM host controller and grants each workspace only its scoped,
  authenticated interfaces.

DIM host code is trusted infrastructure code only after direct human review of
the complete pinned DIM revision. The complete root repository and all
secret-bearing environment code also require human review before deployment.

The CLI is an unprivileged local policy and transport adapter. It never sends a
host-admin socket or local runtime credential to the remote control plane.

## Remote Control-Plane Boundary

The local host initiates one bounded SSH request/response using an operator
key and pinned host key. SSH agent use, forwarding, PTYs, local commands, and
interactive authentication are disabled. The remote side may propose only a
Project ID, request ID, local workload ID, complete reviewed tree, and named
capabilities. Local admission remains authoritative.

A compromised control plane can schedule only workloads whose exact tree and
capability ceiling the local operator already approved. It cannot administer
the host, widen capabilities, or select commands, mounts, devices, environment,
URLs, images, or sockets.

## Git Boundary

Managed Git repositories are the transition point from untrusted agent output to reviewed source.

Agents may push proposal refs.
Agents must not directly update protected refs.
Protected refs must be updated through Git-host review/merge or trusted
host-side administrative operations.

The host-side operation MUST use a distinct managed maintainer credential.
That credential MUST NOT be returned by the workspace controller or injected
into a workspace, agent, nested container, or CI runner. Protected-ref push
policy MAY allow the maintainer identity but MUST continue to reject the
workspace writer identity. The maintainer capability is provider-neutral even
when the current adapter realizes it as a managed Gitea user.

## Backend Boundary

Sysbox defines the untrusted agent boundary. The trusted workspace
infrastructure uses ordinary runc, while the agent and its private rootless
Docker run in an unprivileged `sysbox-runc` container. DIM MUST reject any
other configured or recorded workspace backend.

Storage backend choice changes disk enforcement.

- `directory` does not enforce disk usage.

# Trust Boundaries

## Boundary Summary

The system has four major execution boundaries:

- Agent container boundary.
- Secret-bearing runtime boundary.
- Trusted Project lifecycle boundary.
- DIM host boundary.

The agent container boundary is untrusted.
The secret-bearing runtime boundary is trusted only after human review of its effective source and runtime definition.
The trusted Project lifecycle boundary is privileged. Its code runs outside
the untrusted agent execution boundary, owns the Project runtime, and deploys
secret-bearing workloads. The current container profile places it in the
trusted workspace container; a VM workspace places it outside the guest. It is
an authority boundary and need not be one long-running controller process.
Host-side DIM creates and reconciles the selected workspace runtime and runs
the DIM host controller. A project must directly review the complete pinned
DIM revision before trusting these layers. The exact cross-backend authority
matrix is `TRUST-RUNTIME-001` in
[Trust and Lifecycle Capability Matrix](04-trust-lifecycle-capability-matrix.md).

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

Native ordinary CI is another untrusted execution boundary. Its schema-2 job
definition, script, and disposable image come from the exact unreviewed
candidate tree. Operator Project admission controls eligibility and bounded
capacity, not trust in those bytes. A successful job is candidate-controlled
self-test evidence and MUST NOT be represented as independent verification.
It receives no host runtime socket, DIM or Git credential, secret, `/dev/kvm`,
review authority, or promotion authority. The human complete-tree approval and
checked protected-ref compare-and-swap remain outside this boundary.

“Unreviewed” here describes infrastructure admission at execution time: DIM may
run those bytes safely before a human has approved them because the sandbox
withholds secrets and trusted capabilities. It does not exempt test definitions
or scripts from product review before promotion. Product maintainers must review
changed requirements, implementation, tests, and relevant results sufficiently
to judge regression risk. Separately, infrastructure security reviewers focus
on changes that can alter secret exposure, protected-ref authority, host
privilege, or another trusted capability. One human approval may record both
judgments, but the judgments and evidence are distinct.

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

- Runs outside the untrusted agent execution boundary. For a VM workspace it
  MUST remain outside the guest.
- Owns the Project runtime.
- Defines, starts, and reconciles agent and secret-bearing Project services.
- Explicitly decides whether an agent may trigger its reviewed setup again by
  exposing the workspace self-restart route through a constrained proxy.
- Keeps the agent's inner runtime separate from its own runtime.
- Deploys secret-bearing containers only from approved refs.
- May receive available host `/dev/kvm` under the immutable creation-time KVM
  policy only for a backend profile that defines that trusted capability;
  interactive creation confirms this recommended grant for the current
  container profile. Host devices must not be passed into an untrusted agent
  container or VM guest.

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

The CLI is an unprivileged presentation and transport adapter for DIM-owned
state. Runtime lifecycle, workspace command execution, CI runner logs, and
secret-sensitive decisions execute in the host controller. The CLI may execute
external Git transport and controller bootstrap locally because those depend
on the invoking user's terminal or credential helpers. Controller command
sessions expose output, input, and cancellation only on the host-admin socket;
making them reachable from a browser requires a separately reviewed
authentication and authorization boundary.

## Git Boundary

Managed Git repositories are the transition point from untrusted agent output to reviewed source.

Agents may push proposal refs.
Agents must not directly update protected refs.
Protected refs must be updated through the complete-tree review and atomic
promotion operation in `TRUST-PROMOTION-001` and
`TRUST-PROMOTION-CAS-001`. A host administrative credential does not create a
routine review-bypass path.

Complete-tree approval does not mean every path has the same security
sensitivity. Security review follows the authority and secret-bearing
dependency closure. Product/QA review follows changed requirements and behavior,
including implementation and tests. Neither dimension may be inferred solely
from a green CI status.

For a Project that combines trusted lifecycle and agent-changeable sources in
one repository, every ordinary update to its selected root ref MUST enter
through a reviewed pull request. The workspace writer and ordinary repository
owners MUST NOT directly push that ref, including changes outside `.dim`.
Project-defined code-owner rules MAY request additional review for sensitive
paths, but path matching alone does not prove the dependency closure of trusted
scripts, Docker build contexts, or lifecycle hooks. The Project owns that
verification and the human reviewer must inspect its result against the
complete selected commit tree before trusting the ref. DIM does not infer a
safe subtree from filenames.

The host-side operation MUST use a distinct managed maintainer credential.
That credential MUST NOT be returned by the workspace controller or injected
into a workspace, agent, nested container, or CI runner. Protected-ref push
policy MAY allow the maintainer identity but MUST continue to reject the
workspace writer identity. The maintainer capability is provider-neutral even
when the current adapter realizes it as a managed Gitea user.

## Backend Boundary

The current implementation profile uses Sysbox to define the untrusted agent
boundary. The trusted workspace infrastructure uses ordinary runc, while the
agent and its private rootless Docker run in an unprivileged `sysbox-runc`
container. A multi-backend implementation MUST preserve
`TRUST-RUNTIME-001`; adding a VM mechanism does not move trusted lifecycle or
secret-bearing execution into the guest and does not make the mechanism itself
a security guarantee. Backend identity and incompatible-state handling follow
`STATE-BACKEND-001`.

Storage backend choice changes disk enforcement.

- `directory` does not enforce disk usage.

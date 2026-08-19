# Architecture

## Repository Layout

This infrastructure repository is organized as a monorepo. Projects that use the infrastructure are not required to use a monorepo.

The system supports Project-scoped repository sets. This allows product code,
environment code, harness code, and permission-bearing code to be separated
by repository when a project needs stronger ownership or review boundaries.

## Runtime Boundaries

Each DIM workspace has a trusted workspace container. Reviewed Project
lifecycle code owns its private Project runtime and may create both an
untrusted agent service and secret-bearing services there. DIM core creates
the workspace boundary but does not define an agent resource.

### Workspace Root and Controller

The workspace root owns the reviewed checkout and Project runtime and deploys
reviewed secret-bearing workloads. It may be privileged because it is trusted
lifecycle infrastructure. Host-side DIM creates this boundary and does not
expose its runtime to the agent.

### Agent Container

The agent container is a Project-defined untrusted execution environment.
Its image, mounts, privileges, private runtime, and task dispatch are reviewed
Project policy rather than a core-managed resource.

Properties:

- Contains no raw API keys or secret credentials.
- May receive the persistent workspace checkout through an explicit
  Project-owned mount.
- Allows command execution inside the workspace.
- Allows nested container creation through an agent-specific inner runtime.
- May receive approved Git identity and constrained managed-Git credentials.
- Can access the managed Git host for pushing branches and opening pull requests through the configured workflow.
- Can include Git configuration environment variables required for Git operations.
- Must not receive the host Docker socket, Project runtime socket, or original
  DIM controller socket/grant.
- Cannot mount secret-bearing volumes.
- Cannot directly control secret-bearing containers.

### Secret-Bearing Container

The secret-bearing container is the execution environment that may hold API keys or other secrets.

Properties:

- Runs as a separate Project service outside the agent container and its
  private nested runtime.
- Contains or can access secrets required for trusted operations.
- Exposes only a constrained interface selected by the controller for use by
  agent tooling.
- Is deployed by a controller from reviewed sources.
- Does not mount an agent-controlled checkout as a writable shared volume.
- Is treated as trusted only after its source, image definition, and runtime configuration pass human review.

If an API shape is needed before the agent runtime integration exists, the default placeholder interface is HTTP. The exact tool-facing protocol is owned by the agent runtime layer.

## Secret-Bearing Code

Any code or configuration that runs in, builds, deploys, or indirectly controls a secret-bearing environment is considered secret-bearing for review purposes.

This includes:

- Application source code inside secret-bearing containers.
- Dockerfiles and equivalent image definitions.
- Entrypoints and startup scripts.
- Dependency manifests and lockfiles.
- Runtime configuration for secret-bearing containers.
- Deployment controller logic that controls secret-bearing containers.
- Infrastructure code that can indirectly alter secret access.

Secret-bearing code must be reviewed by a human before it is used to build or deploy a secret-bearing environment.

The complete infrastructure code from this repository must pass direct human review at the pinned revision before a project trusts or adopts it. The complete project repository and all secret-bearing environment code require the same review.

## Deployment Flow

Secret-bearing containers are deployed by reviewed trusted Project lifecycle
code or another trusted controller selected by the Project. That authority is
part of the trusted boundary because it controls environments that access
secrets.

The deployment flow is:

1. An agent creates or modifies code in an untrusted workspace.
2. The agent pushes proposed changes to the managed Git host.
3. The agent opens a pull request through the configured Git host.
4. A human reviews the proposed changes.
5. Reviewed changes are merged into the approved ref.
6. The controller builds and deploys secret-bearing containers only from approved refs.

Secret-bearing containers must not be built or restarted directly from unreviewed workspace files.

Secret-bearing deployment is owned by the controller rather than the
agent-facing `.dim/entrypoint.sh` task surface. Secret values enter only the
controller/secret-bearing boundary, not agent-controlled files, Project state,
or the agent container.

## Execution and Promotion Domains

DIM separates three roles with different lifecycle and trust properties:

| Domain | Lifecycle | Trust and credentials | Purpose |
| --- | --- | --- | --- |
| Agent workspace | Persistent until explicit discard | Untrusted agent execution; no raw project/runtime secrets | Implementation, builds, services, and nested containers |
| Verification runner | Project-scoped runner with separate checkouts and disposable job containers | Runs untrusted proposed input; no host Docker socket or DIM workspace credentials | Tests, lint, builds, and review evidence |
| Trusted Project runtime | Project-defined lifecycle; services may persist | Reviewed lifecycle code; scoped secrets may be supplied to separate services | Protected updates and other secret-bearing operations |

These are roles, not a claim that every current boundary is a VM-strength
security boundary. In particular, services sharing the current privileged
workspace are operationally separated but depend on reviewed Project policy.
The review gate applies when output is promoted into protected or
secret-bearing state; the mutable agent workspace itself is not review-gated.

## Managed Git Host

The built-in managed Git host is a DIM-owned Gitea service. Each Project owns
a reserved `dim-<project>` organization and repository aliases below it.
Gitea branch protection rejects direct workspace pushes to configured refs;
review and merge happen through the Git host.

## Workspace Lifecycle

Workspace roots are named, persistent, and scoped to a registered project.

The workspace lifecycle is:

1. Create a new read-write workspace for the project.
2. Inject approved Git configuration and environment variables.
3. Start the trusted workspace container and ensure the host-managed DIM
   controller is available.
4. Run reviewed `.dim/setup.sh`, which may start a Project-owned agent service
   through the workspace's private engine.
5. Dispatch reviewed `.dim/entrypoint.sh` tasks into that service without
   exposing a Docker control socket to it.
6. Preserve only explicitly exported artifacts or Git-pushed changes.
7. Explicitly discard the workspace and all nested workloads when they are no longer needed.

No raw secret material is persisted in or exported from the agent container.

## Network Boundary

Internet access policy is owned by the agent runtime layer and is not defined by this infrastructure document.

For secret-bearing operations, the controller may expose a constrained service
interface to agent tooling, such as through MCP or another tool interface. It
must not expose the root container runtime or raw secret material.

Agent containers must not require direct access to raw secret material. If
direct communication with a secret-bearing service is enabled for a project,
it must be limited to the explicitly exposed service interface.

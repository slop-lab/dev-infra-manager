# Architecture

## Repository Layout

This infrastructure repository is organized as a monorepo. Projects that use the infrastructure are not required to use a monorepo.

The system supports adding project Git repositories later. This allows product code, environment code, harness code, and permission-bearing code to be separated by repository when a project needs stronger ownership or review boundaries.

## Runtime Boundaries

The system uses separate runtime boundaries for agent workspaces and secret-bearing environments.

### Agent Workspace Container

The agent workspace container is the execution environment exposed to an agent job.

Properties:

- Contains no raw API keys or secret credentials.
- Provides a read-write workspace that is ephemeral per job.
- Allows command execution inside the workspace.
- Allows nested container creation through Sysbox.
- Receives approved environment variables and runtime configuration needed for the job.
- Can access the managed Git host for pushing branches and opening pull requests through the configured workflow.
- Can include Git configuration environment variables required for Git operations.
- Cannot access host container runtime sockets.
- Cannot mount secret-bearing volumes.
- Cannot directly control secret-bearing containers.

### Secret-Bearing Container

The secret-bearing container is the execution environment that may hold API keys or other secrets.

Properties:

- Runs separately from the agent workspace container.
- Contains or can access secrets required for trusted operations.
- Exposes only a constrained host-reachable interface for use by the agent runtime.
- Is deployed by a controller from reviewed sources.
- Does not mount the agent workspace as a writable shared volume.
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

Shared infrastructure code from this repository is trusted by default for projects that adopt it. Project-specific changes that alter secret-bearing behavior are still subject to review.

## Deployment Flow

Secret-bearing containers are deployed by a controller. The controller is part of the trusted boundary because it can control environments that access secrets.

The deployment flow is:

1. An agent creates or modifies code in an untrusted workspace.
2. The agent pushes proposed changes to the managed Git host.
3. The agent opens a pull request through the managed PR layer.
4. A human reviews the proposed changes.
5. Reviewed changes are merged into the approved ref.
6. The controller builds and deploys secret-bearing containers only from approved refs.

Secret-bearing containers must not be built or restarted directly from unreviewed workspace files.

The deploy controller checks out the configured approved ref into a temporary Git worktree, builds the configured image from that worktree, replaces the previous container, and removes the temporary worktree. Secret values are supplied through host-side runtime configuration, such as an env file outside the agent workspace, not through agent-controlled files.

## Managed Git Host

The managed Git host uses bare Git repositories with a custom pull request layer. It may run on the same machine as the container infrastructure or on a separate machine.

Agents can push proposed branches and create pull requests. Human review happens before changes are accepted into refs used by trusted deployment.

## Workspace Lifecycle

Agent workspaces are ephemeral and scoped to a job.

The workspace lifecycle is:

1. Create a new read-write workspace for the job.
2. Inject approved job configuration and environment variables.
3. Start the agent workspace container.
4. Allow the agent to execute commands and create nested containers within the boundary.
5. Preserve only explicitly exported artifacts or Git-pushed changes.
6. Tear down the workspace and nested workloads after the job.

No raw secret material is persisted in or exported from the agent workspace.

## Network Boundary

Internet access policy is owned by the agent runtime layer and is not defined by this infrastructure document.

For secret-bearing operations, the infrastructure requires only that the secret-bearing service be reachable from the host so the agent runtime can expose it as a tool, such as through MCP or another tool interface.

Agent workspace containers must not require direct access to raw secret material. If direct communication with a secret-bearing service is enabled for a project, it must be limited to the explicitly exposed service interface.

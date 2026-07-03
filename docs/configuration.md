# Configuration

`dev-infra-manager` uses a JSON configuration file. Generate a starter file with:

```bash
pnpm run cli -- init-config --output dev-infra.config.json
```

Validate a configuration file with:

```bash
pnpm run cli -- config validate --config dev-infra.config.json
```

## Top-Level Fields

### `stateRoot`

Host path for persistent infrastructure state.

This includes job metadata, managed Git host state, pull request metadata, and controller deployment state. Relative paths are resolved from the current working directory.

### `jobMountRoot`

Host path where per-job quota filesystems are mounted.

Each job receives a mount directory under this root. Agent workspaces and nested container runtime data are created inside that job mount.

### `managedGitHost`

Configuration for the managed Git host.

Fields:

- `kind`: must be `bare-git-pr`.
- `remote`: informational remote URL for the managed Git host.

The current implementation stores bare repositories and pull request metadata under `stateRoot`.

### `resourceProfiles`

Named resource profiles for agent jobs.

Each profile contains:

- `cpuCount`: CPU count passed to Docker for the outer agent workspace container.
- `memoryBytes`: memory limit as bytes or a size string such as `4GiB`.
- `pidsLimit`: process limit for the outer agent workspace container.
- `diskBytes`: per-job disk quota as bytes or a size string such as `20GiB`.
- `timeoutSeconds`: wall-clock timeout for agent container execution.

### `agent`

Agent workspace container configuration.

Fields:

- `image`: agent workspace image.
- `runtime`: Docker runtime, normally `sysbox-runc`.
- `workspacePath`: container path for the job workspace.
- `runtimeDataPath`: container path for nested container runtime data.
- `env`: approved environment variables injected into the agent container.
- `gitEnv`: approved Git-related environment variables injected into the agent container.

Do not place raw secrets in `env` or `gitEnv`.

### `secretRuntime`

Secret-bearing runtime deployment configuration.

Fields:

- `endpoint`: host-reachable endpoint exposed to the agent runtime tooling layer.
- `repo`: managed Git repository that contains the trusted runtime source.
- `approvedRef`: Git ref used for deployment.
- `image`: Docker image tag to build.
- `containerName`: Docker container name to replace.
- `contextPath`: build context path inside the approved ref checkout.
- `dockerfile`: Dockerfile path relative to `contextPath`.
- `envFile`: optional host path to a Docker env file.
- `publish`: Docker port publishing entries.

Secret values are not stored in this configuration. If the secret runtime needs environment variables, use `secretRuntime.envFile` with a host path outside agent-controlled workspaces.

# Configuration

## Scope

This specification defines the `DevInfraConfig` JSON contract, normalization behavior, defaults, and compatibility rules.

## Source

The CLI loads JSON config files from `--config`, defaulting to `dev-infra.config.json` for config-dependent commands.

`init-config` writes the default config shape.

## Top-Level Fields

### `stateRoot`

Required non-empty string.
Resolved to an absolute host path during normalization.

Stores persistent infrastructure state:

- Job metadata and disk images.
- Managed Git repositories.
- Pull request metadata.
- Controller deployment state.
- Controller lock directories.

### `jobMountRoot`

Required non-empty string.
Resolved to an absolute host path during normalization.

Stores per-job mount or workspace directories.

### `storageBackend`

Optional object.
Defaults to:

```json
{ "kind": "loopback" }
```

Allowed `kind` values:

- `loopback`
- `directory`

### `managedGitHost`

Required object.

Fields:

- `kind`: must be `bare-git-pr`.
- `remote`: required non-empty string, informational.
- `protectedRefs`: required non-empty array of full Git refs.

Every protected ref must:

- Start with `refs/`.
- Not contain `..`.
- Not contain whitespace or Git-ref-unsafe characters matched by `[\s~^:?*[\]\\]`.
- Not end with `/` or `.`.
- Not contain `//`.

### `resourceProfiles`

Required non-empty object keyed by profile name.

Each profile requires:

- `cpuCount`: positive safe integer.
- `memoryBytes`: positive byte count or size string.
- `pidsLimit`: positive safe integer.
- `diskBytes`: positive byte count or size string.
- `timeoutSeconds`: positive safe integer.

Size strings support the units implemented by `parseBytes`.
Normalized profiles store byte fields as numbers.

### `agent`

Required object.

Fields:

- `image`: required non-empty string.
- `runtime`: required non-empty string, retained as a legacy runtime name.
- `runtimeBackend`: optional object.
- `workspacePath`: required absolute container path.
- `runtimeDataPath`: required absolute container path.
- `env`: required string record.
- `gitEnv`: required string record.

If `runtimeBackend` is absent:

- `runtime === "runsc"` normalizes to `{ "kind": "gvisor", "dockerRuntime": "runsc" }`.
- Any other runtime normalizes to `{ "kind": "sysbox", "dockerRuntime": runtime }`.

Allowed `runtimeBackend.kind` values:

- `sysbox`
- `gvisor`
- `rootless-podman`

If `runtimeBackend.dockerRuntime` is absent:

- `sysbox` defaults to `sysbox-runc`.
- `gvisor` defaults to `runsc`.
- `rootless-podman` defaults to `runc`.

`env` and `gitEnv` must not contain raw secrets.

### `secretRuntime`

Required object.

Fields:

- `endpoint`: host-reachable endpoint string.
- `repo`: managed Git repository name.
- `approvedRef`: full Git ref used for deployment.
- `image`: Docker image tag to build.
- `containerName`: Docker container name to replace.
- `contextPath`: path inside the approved ref worktree used as Docker build context.
- `dockerfile`: Dockerfile path relative to `contextPath`.
- `envFile`: optional host path to a Docker env file.
- `publish`: array of Docker publish strings.

Raw secret values must not be stored directly in this config.

## Default Config

The default config uses:

- `stateRoot`: `.dev-infra/state`
- `jobMountRoot`: `.dev-infra/mounts`
- `storageBackend.kind`: `loopback`
- `managedGitHost.kind`: `bare-git-pr`
- `managedGitHost.protectedRefs`: `["refs/heads/main"]`
- Default resource profile: 2 CPUs, 4 GiB memory, 2048 pids, 20 GiB disk, 3600 seconds.
- Agent image: `dev-infra-agent-workspace:latest`
- Agent backend: `sysbox` with `sysbox-runc`.
- Secret runtime image: `dev-infra-secret-runtime:latest`
- Secret runtime approved ref: `refs/heads/main`

## Failure Behavior

Invalid config must fail before any command performs host mutations.
Validation errors are reported as `UserError` messages and CLI exit code `2`.

## Verification

Required verification:

- Unit tests for default normalization.
- Unit tests for required field rejection.
- Unit tests for legacy runtime fallback.
- CLI validation of `config.example.json`.

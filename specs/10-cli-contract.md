# CLI Contract

## Scope

This specification defines stable CLI commands, flags, outputs, and exit behavior.

The package exposes:

- `dev-infra-manager`
- `dim`

Both point to `dist/cli.js` after build.

## Common Behavior

- `--help` or `-h` prints help and exits successfully.
- Unknown commands fail with user-facing error and exit code `2`.
- `UserError` failures exit with code `2`.
- Unexpected errors exit with code `1`.
- Boolean flags accept bare flags as true.
- Boolean string values true are `true`, `1`, and `yes`; other strings are false.

## Commands

### `init-config`

Usage:

```bash
dim init-config [--output dev-infra.config.json]
```

Writes the default config JSON to the output path, creating parent directories.

### `doctor`

Usage:

```bash
dim doctor [--config dev-infra.config.json]
```

Prints tab-separated lines:

```text
<ok|fail>\t<check name>\t<detail>
```

Exits with code `1` if any check fails.
Without `--config`, uses the default config.

### `config validate`

Usage:

```bash
dim config validate [--config dev-infra.config.json]
```

Prints a JSON summary containing:

- `ok`
- `configPath`
- `stateRoot`
- `jobMountRoot`
- `storageBackend`
- `resourceProfiles`
- `managedGitHostKind`
- `managedGitHostProtectedRefs`
- `agentImage`
- `agentRuntimeBackend`
- `secretRuntimeRepo`
- `secretRuntimeApprovedRef`

### `job prepare`

Usage:

```bash
dim job prepare --job-id ID [--profile default] [--config dev-infra.config.json] [--dry-run]
```

Prepares job storage and prints job metadata JSON.
Dry-run prints planned commands and does not write metadata.

### `job cleanup`

Usage:

```bash
dim job cleanup --job-id ID [--config dev-infra.config.json] [--dry-run] [--keep-disk]
```

Cleans up job storage.
`--keep-disk` prevents removal of job paths.

### `job run`

Usage:

```bash
dim job run --job-id ID [--profile default] [--config dev-infra.config.json] [--sudo=false] [--keep-disk] [-- COMMAND...]
```

Runs prepare, agent execution, and cleanup.
Exits with the agent command exit code after prepare succeeds.

### `agent run-command`

Usage:

```bash
dim agent run-command --job-id ID [--config dev-infra.config.json] [COMMAND...]
```

Reads existing job metadata and prints the timeout-wrapped Docker command line.

### `agent run`

Usage:

```bash
dim agent run --job-id ID [--config dev-infra.config.json] [--sudo=false] [-- COMMAND...]
```

Reads existing job metadata and executes the timeout-wrapped Docker command.

### `git-host init`

Creates managed Git host state directories.

### `git-host create-repo`

Usage:

```bash
dim git-host create-repo --repo NAME [--config dev-infra.config.json]
```

Creates a bare repository, installs hooks, and prints the repository path.

### `git-host install-hooks`

Reinstalls managed hooks for an existing bare repository and prints the hook path.

### `pr create`

Creates a pull request record and prints JSON.
Required flags: `--repo`, `--source`, `--title`.
`--target` defaults to `refs/heads/main`.
`--body` defaults to empty string.

### `pr list`

Prints pull request records as JSON array.

### `pr show`

Prints one pull request record as JSON.

### `pr approve`

Adds an approval and prints the updated pull request record.

### `pr merge`

Fast-forward merges an approved pull request and prints the updated pull request record.

### `secret deploy`

Usage:

```bash
dim secret deploy [--config dev-infra.config.json] [--dry-run]
```

Deploys the secret runtime from the approved ref.

### `controller run`

Usage:

```bash
dim controller run [--config dev-infra.config.json] [--once] [--interval-seconds 30] [--dry-run]
```

Runs controller ticks once or continuously.

### `repo register`

Usage:

```bash
dim repo register --name NAME [--protect main,release/*] /path/to/bare.git
```

Registers and imports an existing bare repository into the managed local
Gitea service. The source path is not retained as a runtime mount.

### `repo list` and `repo show`

Usage:

```bash
dim repo list
dim repo show NAME
```

Print role-neutral repository registry records as JSON.

### `workspace run`

Usage:

```bash
dim workspace run REPO WORKSPACE \
  [--git-user-name NAME] [--git-user-email EMAIL] [-- COMMAND...]
```

Reconciles a persistent top-level workspace, clones the registered repository
inside it, and executes the command from the clone. Commands with flags must
follow `--`.

### `workspace show`, `stop`, and `discard`

Usage:

```bash
dim workspace show WORKSPACE
dim workspace stop WORKSPACE
dim workspace discard WORKSPACE --yes
```

`discard` requires confirmation and removes the workspace container, its
inner-Docker volume, and metadata without deleting the registered repository.

### `gitea ensure` and `gitea credentials`

Usage:

```bash
dim gitea ensure
dim gitea credentials --show-secrets
```

Credential output requires an explicit secret-disclosure flag.

## Verification

Required verification:

- Unit tests for command helpers where behavior is non-trivial.
- CLI smoke coverage through `scripts/smoke.sh`.
- Manual or scripted checks for `doctor --config` on available backends.

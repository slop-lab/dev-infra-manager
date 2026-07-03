# Usage

## Requirements

The development toolchain uses:

- Node.js 22 or newer.
- pnpm 10 or newer.
- just.
- TypeScript.

Runtime hosts also need the tools used by the controller:

- Docker-compatible CLI.
- Sysbox runtime registered as `sysbox-runc`.
- KVM access for the primary supported runtime.
- Linux cgroup v2.
- `sudo` access for mount, unmount, ownership, and filesystem setup operations.

## Setup

Install dependencies:

```bash
pnpm install
```

Install Ubuntu host runtime dependencies:

```bash
just install-host-ubuntu
```

This installs Docker, downloads the pinned Sysbox CE package for the host architecture, verifies the package checksum, installs Sysbox, restarts Docker, and starts Sysbox services.

Run the full Ubuntu bootstrap:

```bash
just bootstrap-ubuntu
```

The bootstrap script installs Node.js, npm, just, the pinned pnpm version, host runtime dependencies, project dependencies, runs verification, builds the included runtime images, and runs `doctor`. If `doctor` reports missing host capabilities, bootstrap exits non-zero after printing the gaps.

Build the included runtime images:

```bash
just build-agent-image
just build-secret-example
```

Run the integration smoke test:

```bash
just smoke
```

The smoke test builds the included images, verifies the agent image command environment, exercises the managed Git pull request flow, deploys the secret runtime from an approved ref, and checks the secret runtime health endpoint.

Run the full local verification suite:

```bash
just verify
```

Create a starter configuration:

```bash
just sample-config
```

The generated `dev-infra.config.json` follows the same shape as [config.example.json](../config.example.json).

Validate configuration:

```bash
pnpm run cli -- config validate --config dev-infra.config.json
```

See [Configuration](configuration.md) for the full field reference.

## Host Readiness

Run:

```bash
just doctor
```

The doctor command checks local development tools, Docker CLI availability, Docker daemon access, Sysbox runtime registration, actual Sysbox container execution, loop device setup, KVM access, and cgroup v2 support.

The Sysbox registration check only proves that Docker knows about `sysbox-runc`. The Sysbox container execution check runs `hello-world:latest` with `--runtime=sysbox-runc`; this is the direct readiness signal for agent workspace containers.

## Job Filesystem Lifecycle

Prepare a job in dry-run mode:

```bash
pnpm run cli -- job prepare --config dev-infra.config.json --job-id demo --dry-run
```

Prepare a job and execute host filesystem operations:

```bash
pnpm run cli -- job prepare --config dev-infra.config.json --job-id demo
```

This creates a per-job disk image, formats it, mounts it, creates workspace/runtime data directories, and records job metadata.

Clean up a job:

```bash
pnpm run cli -- job cleanup --config dev-infra.config.json --job-id demo
```

Use `--dry-run` to inspect cleanup commands without executing them. Use `--keep-disk` to leave the job disk image and mount directory in place.

Run the full lifecycle in one command:

```bash
pnpm run cli -- job run --config dev-infra.config.json --job-id demo -- bash
```

`job run` prepares the quota filesystem, runs the agent workspace container with the configured resource profile and timeout, and then cleans up the job even when prepare or execution fails. Use `--keep-disk` to keep the job filesystem after execution for debugging.

Job IDs claim state atomically. Reusing a job ID while state or mount directories still exist is refused to avoid overwriting workspace data. Run `job cleanup` before reusing a job ID.

## Agent Container Command

After preparing a job, inspect the Docker command that would run the agent workspace container:

```bash
pnpm run cli -- agent run-command --config dev-infra.config.json --job-id demo bash
```

The command uses the configured Sysbox runtime, resource profile, workspace bind mount, nested runtime data bind mount, and approved environment variables.
It is wrapped with the configured job timeout.

Run the agent workspace container:

```bash
pnpm run cli -- agent run --config dev-infra.config.json --job-id demo -- bash
```

`agent run` executes Docker with sudo by default. Use `--sudo=false` when the invoking user can access the Docker daemon directly.
The command exits with the `timeout` exit code if the job exceeds `resourceProfiles.<name>.timeoutSeconds`.

## Managed Git Host

Initialize managed Git host state:

```bash
pnpm run cli -- git-host init --config dev-infra.config.json
```

Create a bare repository:

```bash
pnpm run cli -- git-host create-repo --config dev-infra.config.json --repo app
```

Agents can push branches to the resulting bare repository path. Create a pull request from pushed refs:

```bash
pnpm run cli -- pr create \
  --config dev-infra.config.json \
  --repo app \
  --source refs/heads/agent/change \
  --target refs/heads/main \
  --title "Proposed change"
```

Review state is stored as JSON metadata next to the managed bare repositories. A pull request must have at least one approval before merge:

```bash
pnpm run cli -- pr approve --config dev-infra.config.json --repo app --id 1 --reviewer alice
pnpm run cli -- pr merge --config dev-infra.config.json --repo app --id 1
```

Merges are fast-forward only. The source and target refs must still point to the same commits recorded when the pull request was created.

## Secret Runtime Deployment

Secret-bearing containers are deployed only from the configured approved ref:

```bash
pnpm run cli -- secret deploy --config dev-infra.config.json --dry-run
```

Dry-run mode prints the exact Git and Docker commands without executing them.

Execute deployment:

```bash
pnpm run cli -- secret deploy --config dev-infra.config.json
```

The deploy command:

1. Checks out the configured approved ref into a temporary Git worktree.
2. Builds the configured Docker image from the checked-out source.
3. Removes the previous secret runtime container if it exists.
4. Starts the new secret runtime container.
5. Removes the temporary worktree.

Secret values are not stored in the repository configuration. If the secret runtime needs environment variables, configure `secretRuntime.envFile` with a host path outside the agent workspace.

## Deploy Controller

Run the controller once:

```bash
pnpm run cli -- controller run --config dev-infra.config.json --once
```

Run the controller continuously:

```bash
pnpm run cli -- controller run --config dev-infra.config.json --interval-seconds 30
```

The controller checks the configured approved ref. When the ref differs from the last deployed SHA recorded under the state root, it deploys the secret runtime and records the deployed SHA.

The controller uses an atomic lock directory under the state root to prevent concurrent secret runtime deployments. If the controller exits unexpectedly while holding the lock, inspect the host before removing the lock directory manually.

For systemd deployment, see [deploy/systemd](../deploy/systemd).

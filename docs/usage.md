# Usage

## Requirements

The development toolchain uses:

- Node.js 22 or newer.
- pnpm 10 or newer.
- just.
- TypeScript.

Runtime hosts also need the tools used by the controller:

- Docker-compatible CLI.
- The selected agent runtime backend installed and registered. The default backend requires Sysbox as `sysbox-runc`; the gVisor backend requires `runsc`.
- KVM access for the default Sysbox production runtime.
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

Run `just` as your normal user, including when it comes from mise. After the
first install, log out and back in or run `newgrp docker` once to refresh the
Docker group membership added by the installer. When invoking the whole recipe
with elevated privileges, use `sudo "$(command -v just)" install-host-ubuntu`;
the resolved mise executable is propagated to scripts that invoke `just` again.

Before making changes, the installer identifies its APT packages, Sysbox
download, service operations, Docker group update, and path-scoped AppArmor
exception. It requires the exact response `yes`. Treat the script as a
development convenience and independently review these changes for production.

This installs Docker, downloads the pinned Sysbox CE package for the host architecture, verifies the package checksum, installs Sysbox, restarts Docker, and starts Sysbox services.

Install gVisor `runsc` for the no-KVM Docker-compatible backend:

```bash
just install-runsc-linux
```

This downloads the latest official gVisor release binaries, verifies their SHA-512 checksums, installs them under `/usr/local/bin`, registers `runsc` with Docker, and restarts Docker.

Run the full Ubuntu bootstrap:

```bash
just bootstrap-ubuntu
```

When mise is available, bootstrap runs `mise install` and uses the Node.js,
pnpm, and `just` versions declared by this repository. Otherwise it installs
Node.js, npm, and `just` through APT and installs the pinned pnpm version. It
then installs host runtime and project dependencies, runs verification, builds
the included runtime images, and runs `doctor`. If `doctor` reports missing
host capabilities, bootstrap exits non-zero after printing the gaps.

Build the included runtime images:

```bash
just build-agent-image
just build-secret-example
```

Run the integration smoke test:

```bash
just smoke
```

Use `just smoke -- --verbose` (or `just smoke -- -v`) to show detailed output for each labeled stage.

The smoke test builds the included images, verifies the agent image command environment, exercises the managed Git pull request flow, deploys the secret runtime from an approved ref, and checks the secret runtime health endpoint.

For a fast check that does not contact Docker or create containers, validate
the generated isolation arguments only:

```bash
just isolation-check
```

CI can request the same test result as JSON on stdout:

```bash
just isolation-check-json
```

This verifies resource flags and rejects host Docker storage or socket mounts;
it does not replace the runtime behavior covered by `just smoke`.

Run the full local verification suite:

```bash
just verify
```

When developing from inside a nested container that can reach a Docker daemon
but does not provide Sysbox, KVM, loop devices, systemd, or sudo, run:

```bash
just container-verify
```

This runs monorepo type checks, unit tests, builds, configuration validation,
and an runc-based cgroup v2 smoke test. The smoke test verifies initial and
live-updated CPU, memory, swap, and PID values on the container's leaf cgroup
without depending on host-only runtime checks. These values are not resource
guarantees: an ancestor cgroup may impose a lower effective limit.

For the heavier image-build and nested-Docker check, run:

```bash
just container-runtime-verify
```

This additionally builds the role-neutral DIM project workspace image and the
agent job image, then runs them with privileged runc solely as a
nested-container compatibility smoke test. It checks the default containerd
snapshotter path, the gVisor-compatible legacy `overlay2` path, and outbound
networking from a container created by each inner daemon. It does not claim to
validate the production Sysbox boundary.
It also installs the publishable `@slop-lab/dim-cli` tarball into a temporary
prefix and uses only that installed `dim` binary to exercise:

- Disposable managed-Git repositories and persistent workspace reconciliation.
- A project with custom setup and entrypoint hooks, including setup failure and
  retry.
- A four-repository project whose nested Compose services clone, persist, and
  push through managed Gitea.
- This repository registered as a real project, including locked dependency
  setup and its checked-in `check`, `verify`, and `codex` tasks.
- Capability-profile replacement, project fast-forward update, stop/start
  persistence, and discard cleanup.

## Project Workspaces

Install `dim` from the registry with mise:

```bash
mise use -g npm:@slop-lab/dim-cli
```

Register a role-neutral bare repository, then create a workspace using the
project's selected capability profiles:

```bash
dim repo register --name example /path/to/example.git
dim workspace create example example-dev \
  --profile development \
  --profile secrets
```

Run a project task or bypass project hooks with a raw command:

```bash
dim workspace run example-dev codex
dim workspace exec example-dev -- bash
```

`workspace run` does not repeat setup. Environment reconciliation happens on
`workspace create`, `workspace start`, `workspace setup`, and after a
fast-forward-only `workspace update`. Only the optional files under `.dim`
have special meaning; root Compose files are never auto-discovered.

Use `dim project init` in a new project to create the minimal
`.dim/docker-compose.yml` scaffold. See
[Project Workspaces](project-workspaces.md) for the hook contract, lifecycle,
capability profiles, and multi-repository service pattern. See
[Repository-backed Workspaces](repo-workspaces.md) for registration, Gitea,
credentials, and reconciliation details.

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

The doctor command checks local development tools, Docker CLI availability, Docker daemon access, the selected runtime backend, the selected storage backend, and cgroup v2 support.

Run config-aware checks with:

```bash
pnpm run cli -- doctor --config dev-infra.config.json
```

The Sysbox registration check only proves that Docker knows about `sysbox-runc`. The Sysbox container execution check runs `hello-world:latest` with `--runtime=sysbox-runc`; this is the direct readiness signal for Sysbox agent workspace containers.
For gVisor, `doctor --config` checks `runsc` and Docker runtime execution.
For rootless Podman, `doctor --config` checks the configured agent image and verifies that `podman` is present in it.

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

The command uses the configured runtime backend, resource profile, workspace bind mount, nested runtime data bind mount, and approved environment variables.
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

Repositories created by this command include a `pre-receive` hook that blocks direct pushes to `managedGitHost.protectedRefs`, such as `refs/heads/main`.
If hooks must be reinstalled for an existing bare repository, run:

```bash
pnpm run cli -- git-host install-hooks --config dev-infra.config.json --repo app
```

Agents can push non-protected branches to the resulting bare repository path. Create a pull request from pushed refs:

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

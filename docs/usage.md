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

Install and verify one Ubuntu host runtime backend:

```bash
just install-host-sysbox-ubuntu
```

Run `just` as your normal user, including when it comes from mise. After the
first install, log out and back in or run `newgrp docker` once to refresh the
Docker group membership added by the installer.

Before making changes, the installer identifies its APT packages, Sysbox
download, service operations, Docker group update, and path-scoped AppArmor
exception. It requires the exact response `yes`. Treat the script as a
development convenience and independently review these changes for production.

Choose exactly one backend recipe:

```bash
just install-host-sysbox-ubuntu
just install-host-gvisor-ubuntu
just install-host-rootless-podman-ubuntu
just install-host-runc-ubuntu
```

Each recipe runs `doctor --backend` after installation; rootless Podman also builds its workspace image. Sysbox and gVisor are intentionally not installed together by a convenience recipe. Use the KVM recipes below to test every installer without requiring the runtimes to coexist on one host.

Test installation destructively inside a disposable KVM-backed Ubuntu VM, without installing a backend on the host:

```bash
just verify-host-backends-kvm             # all backends, one clean VM each
just verify-host-backend-kvm gvisor       # one backend
just verify-host-backend-kvm gvisor --verbose
```

Prepare those dependencies with `just install-kvm-verify-deps-ubuntu`. This requires writable `/dev/kvm`, `qemu-system-x86_64`, `qemu-img`, and `cloud-localds`. The verified Ubuntu cloud image is cached under `.local/kvm`; each test uses and deletes a temporary overlay disk. The default output identifies each stage and prints only the last 30 log lines on failure; append `--verbose` to either KVM recipe to stream the complete guest installation, image build, and workload output.

Install gVisor `runsc` directly for the no-KVM Docker-compatible backend:

```bash
just install-runsc-linux
```

This downloads the latest official gVisor release binaries, verifies their SHA-512 checksums, installs them under `/usr/local/bin`, registers `runsc` with Docker, and restarts Docker.

Run the Ubuntu bootstrap with one selected backend (Sysbox by default):

```bash
just bootstrap-ubuntu
just bootstrap-ubuntu gvisor
```

When mise is available, bootstrap runs `mise install` and uses the Node.js,
pnpm, and `just` versions declared by this repository. Otherwise it installs
Node.js, npm, and `just` through APT and installs the pinned pnpm version. It
then installs the selected host runtime and project dependencies, runs
verification, builds the included runtime images, and runs `doctor` for that
backend. If `doctor` reports missing host capabilities, bootstrap exits
non-zero after printing the gaps.

Build the included runtime images:

```bash
just build-project-workspace
just build-secret-example
```

Run the integration smoke test:

```bash
just verify-container-sysbox
```

Use `just verify-container-sysbox -- --verbose` (or `-- -v`) to show detailed output for each labeled stage.

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
it does not replace the Sysbox runtime behavior covered by `just verify-container-sysbox`.

Run the full local verification suite:

```bash
just verify
```

`just verify` runs only monorepo type checks, unit tests, and builds. It does
not require Docker or a particular runtime backend.

When Docker has Compose v2 and supports privileged runc containers, run:

```bash
just verify-container-runc
```

This additionally builds the role-neutral DIM project workspace image and runs
it with privileged runc solely as a nested-container compatibility smoke test.
It also validates configuration, plugin installation, cgroup v2 limits,
inner-Docker startup, and outbound networking from a nested container. It
does not require or validate the production Sysbox boundary.
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
mise use -g npm:@slop-lab/dim-cli@0.1.0
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

The doctor command checks local development tools, Docker daemon access, the selected workspace runtime backend, and cgroup v2 support.

Run config-aware checks with:

```bash
pnpm run cli -- doctor --backend gvisor
```

The Sysbox registration check only proves that Docker knows about `sysbox-runc`. The Sysbox container execution check runs `hello-world:latest` with `--runtime=sysbox-runc`; this is the direct readiness signal for Sysbox agent workspace containers.
For gVisor, `doctor --backend gvisor` checks `runsc` and Docker runtime execution.
For rootless Podman, `doctor --backend rootless-podman` checks the workspace image and verifies that `podman` is present in it. Podman runs rootless as `agent` inside the workspace, but the outer Docker workspace container is privileged: nested user namespaces and mounts do not work under Docker's normal container mount restrictions.

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

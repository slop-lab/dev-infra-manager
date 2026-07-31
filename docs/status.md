# Status

DIM 0.4.0 is a pre-stable Project-aware release centered on named, persistent
workspaces. Pre-stable state and configuration are not migrated between
incompatible releases.

The supported host platform is Linux with a systemd user manager. macOS,
Windows, and Docker Desktop are outside the supported runtime model.

Implemented:

- Project metadata with exactly one root repository per runnable Project.
- Managed local Gitea repositories, imports through the host `git` CLI, and
  protected branches.
- Project-scoped repository sets loaded from `repos.yml`, including reviewed
  bulk planning and application.
- Persistent create, run, exec, setup, update, start, stop, show,
  and discard lifecycle.
- Backend selection persisted per workspace: Sysbox, gVisor, rootless Podman,
  and privileged runc.
- CPU, memory, and PID limits at the top-level workspace boundary.
- Nested Docker or Podman storage isolated in a labeled volume.
- Optional `.dim` setup, task entrypoint, teardown, and Compose contract.
- Plugin installation and persisted plugin discovery configuration.
- Host-shared external URL ingresses with workspace-scoped route requests
  mediated through a private controller proxy socket.
- Automatic host KVM forwarding for supported trusted workspace backends.
- A thin installer facade (`@slop-lab/dim-installer`, also exposing `dim`) that
  installs the CLI and plugins via `install-cli`/`install-plugin` and
  proxies every other command to a separately installed `@slop-lab/dim-cli`,
  verified through `mise use -g` in a disposable container and against the
  canonical Project example.
- Root-ref refresh on workspace start/restart without live mutation of running
  workspaces.
- TypeScript unit tests and nested-container lifecycle smoke tests.
- Reproducible local Node.js 24/26, container, Sysbox, and KVM CI entrypoints.
- Project-scoped managed CI runners shared by all repositories in the Project,
  with Sysbox-isolated DinD, independent resource limits, and a
  provider-neutral coordinator boundary.

DIM does not currently provide an independent `job` lifecycle, automatic
workspace cleanup after PR merge, one-shot workspace wrappers, or disk quota.
Those orchestration policies can be added on top of the workspace lifecycle
without introducing a second execution model.

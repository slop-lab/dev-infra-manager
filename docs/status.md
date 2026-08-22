# Status

The development branch targets DIM 0.8.0. DIM has no stable release yet;
pre-stable state, configuration, CLI, and extension contracts may change
without backward-compatibility shims or implicit migration.

The supported host platform is Linux with a systemd user manager. macOS,
Windows, and Docker Desktop are outside the supported runtime model.

Implemented:

- Project metadata with exactly one root repository per runnable Project.
- Managed local Gitea repositories, imports through the host `git` CLI, and
  protected branches.
- Project-scoped repository sets loaded from `repos.yml`, including reviewed
  bulk planning and application.
- Explicit external repository synchronization through `repo fetch` and
  `repo push`, without coupling the core Git transport to one provider.
- Persistent create, run, exec, setup, update, start, stop, show,
  and discard lifecycle.
- Backend selection persisted per workspace: Sysbox, gVisor, rootless Podman,
  and privileged runc.
- CPU, memory, and PID limits at the top-level workspace boundary.
- Nested Docker or Podman storage isolated in a labeled volume.
- Optional `.dim` setup, task entrypoint, teardown, and Compose contract.
- Project-owned development-agent containers and task dispatch, without a
  core-managed agent resource.
- A unified managed runtime for the CLI, core, and plugins, with exact peer
  dependency validation and persisted plugin activation.
- Host-shared external URL ingresses with workspace-scoped route requests
  mediated through a private controller proxy socket.
- Automatic host KVM forwarding for supported trusted workspace backends.
- A thin installer facade (`@slop-lab/dim-installer`, also exposing `dim`) that
  installs the unified runtime via `install-cli`/`install-plugin` and
  proxies operational commands to its managed `@slop-lab/dim-cli`,
  verified through `mise use --raw --global` in a disposable container and against the
  canonical Project example.
- Root-ref refresh on workspace start/restart without live mutation of running
  workspaces.
- Atomic running-workspace restart preflight: dirty and divergent roots are
  rejected before the workspace or its Project services are stopped.
- TypeScript unit tests and nested-container lifecycle smoke tests.
- Reproducible local Node.js 24/26, container, Sysbox, and KVM CI entrypoints.
- A common example verifier that creates a separate disposable QEMU guest for
  each selected example and runtime backend.
- A full-development-flow Project example and continuous stateful journey from
  creation through reviewed updates, safe restart rejection, controller
  replacement, setup recovery, and backup/discard/restore. Test-only registry
  and failure hooks are injected into its disposable materialization rather
  than embedded in the copyable example.
- Project-scoped managed CI runners shared by all repositories in the Project,
  with Sysbox-isolated DinD, independent resource limits, and a
  provider-neutral coordinator boundary.

DIM does not currently provide automatic workspace cleanup after PR merge,
one-shot workspace wrappers, or disk quota. Those orchestration policies can
be added on top of the workspace lifecycle without introducing a second
execution model.

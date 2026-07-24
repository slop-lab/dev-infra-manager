# Status

DIM 0.1.0 is a release candidate centered on named, persistent project
workspaces.

Implemented:

- Managed local Gitea repository registration and protected branches.
- Persistent workspace create, run, exec, setup, update, start, stop, show,
  and discard lifecycle.
- Backend selection persisted per workspace: Sysbox, gVisor, rootless Podman,
  and privileged runc.
- CPU, memory, and PID limits at the top-level workspace boundary.
- Nested Docker or Podman storage isolated in a labeled volume.
- Optional `.dim` setup, task entrypoint, teardown, and Compose contract.
- Plugin installation and persisted plugin discovery configuration.
- Review-gated secret-runtime deployment controller.
- TypeScript unit tests and nested-container lifecycle smoke tests.

DIM does not currently provide an independent `job` lifecycle, automatic
workspace cleanup after PR merge, one-shot workspace wrappers, or disk quota.
Those orchestration policies can be added on top of the workspace lifecycle
without introducing a second execution model.

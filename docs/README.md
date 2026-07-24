# dev-infra-manager Documentation

`dev-infra-manager` provides infrastructure for running AI-assisted development jobs in isolated, review-gated environments.

The documentation is split by concern:

- [Overview](overview.md): project goal, scope, and threat model.
- [Architecture](architecture.md): core runtime boundaries and Git/review flow.
- [Monorepo Structure](monorepo.md): workspace layout, dependency direction, and optional hosting provider boundaries.
- [Resource Isolation](resource-isolation.md): resource limits, runtime isolation, and disk quota model.
- [Usage](usage.md): local setup, commands, and operational workflow.
- [Configuration](configuration.md): configuration file reference.
- [Runtime Backends](runtime-backends.md): Sysbox, gVisor, rootless Podman, loopback, and directory backend selection.
- [Runtime Images](runtime-images.md): included agent workspace and secret runtime images.
- [Repository-backed Workspaces](repo-workspaces.md): local Gitea registration, persistent workspaces, reconciliation, and Git environment.
- [Project Workspaces](project-workspaces.md): `.dim` project contract, capability profiles, task dispatch, lifecycle, and scaffold flow.
- [Status](status.md): current progress and known future work.

Implementation-oriented normative specifications live in [../specs/README.md](../specs/README.md).

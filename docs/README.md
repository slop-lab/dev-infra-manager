# dev-infra-manager Documentation

`dev-infra-manager` provides persistent, isolated, review-gated workspaces for AI-assisted development.

The documentation is split by concern:

- [Overview](overview.md): project goal, scope, and threat model.
- [Adopting DIM Safely](adoption.md): mandatory human review, version pinning, and branch policy for consuming projects.
- [Architecture](architecture.md): core runtime boundaries and Git/review flow.
- [Monorepo Structure](monorepo.md): workspace layout, dependency direction, and optional hosting provider boundaries.
- [Resource Isolation](resource-isolation.md): resource limits and runtime isolation.
- [Usage](usage.md): local setup, commands, and operational workflow.
- [Configuration](configuration.md): configuration file reference.
- [Runtime Backends](runtime-backends.md): Sysbox, gVisor, rootless Podman, and runc selection.
- [Runtime Images](runtime-images.md): included agent workspace and secret runtime images.
- [Repository-backed Workspaces](repo-workspaces.md): local Gitea registration, persistent workspaces, reconciliation, and Git environment.
- [Project Workspaces](project-workspaces.md): `.dim` project contract, capability profiles, task dispatch, lifecycle, and scaffold flow.
- [Plugins](plugins.md): versioned provider extension boundary for optional GitHub, GitLab, and other integrations.
- [Releasing](releasing.md): release prerequisites, verification, package order, and post-publish checks.
- [Status](status.md): current progress and known future work.

Implementation-oriented normative specifications live in [../specs/README.md](../specs/README.md).

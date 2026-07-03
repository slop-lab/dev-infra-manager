# dev-infra-manager Documentation

`dev-infra-manager` provides infrastructure for running AI-assisted development jobs in isolated, review-gated environments.

The documentation is split by concern:

- [Overview](overview.md): project goal, scope, and threat model.
- [Architecture](architecture.md): core runtime boundaries and Git/review flow.
- [Resource Isolation](resource-isolation.md): resource limits, runtime isolation, and disk quota model.
- [Usage](usage.md): local setup, commands, and operational workflow.
- [Configuration](configuration.md): configuration file reference.
- [Runtime Backends](runtime-backends.md): Sysbox, gVisor, rootless Podman, loopback, and directory backend selection.
- [Runtime Images](runtime-images.md): included agent workspace and secret runtime images.
- [Status](status.md): current progress and known future work.

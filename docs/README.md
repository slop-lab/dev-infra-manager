# dev-infra-manager Documentation

`dev-infra-manager` provides persistent, isolated, review-gated workspaces for AI-assisted development.

## Glossary

Terms below are used with a specific meaning in DIM's own docs; generic
Docker/Git terms aren't repeated here.

- **Project** — DIM metadata: a name, a managed Git namespace, one required
  root repository, and any number of additional repositories. A Project
  outlives any single workspace and may have several named workspaces
  created against it over time — it's the larger-scoped unit; a workspace
  is scoped to one Project, never the reverse.
- **Root repository** — the one required repository per Project. Its
  optional `.dim` directory defines the workspace's environment and
  lifecycle hooks; DIM clones only this repository into a workspace
  automatically.
- **Workspace** — a named, persistent, isolated top-level container bound
  to exactly one Project. This is where an agent actually runs.
- **Controller** — the trusted host-side actor with privileges a workspace
  never has: it creates and reconciles Projects/workspaces, and builds and
  deploys secret-bearing containers from approved refs. It is not a
  container itself (a common misreading, since its job includes running
  containers) — in practice today it's the `dim` CLI operated with host
  access, not a separate service. See [Trust
  Boundaries](../specs/02-boundaries-and-trust.md#host-and-controller-boundary).
- **Secret-bearing container** — separate from any workspace, built and
  deployed by the controller outside the workspace lifecycle entirely, from
  a human-reviewed ref. A workspace's own environment never receives the
  raw secret material it holds.

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
- [External workspace URLs](external-urls.md): authenticated URL requests, reverse proxy placement, Tailscale, and Cloudflare Tunnel.
- [Repository-backed Workspaces](repo-workspaces.md): local Gitea registration, persistent workspaces, reconciliation, and Git environment.
- [Project Workspaces](project-workspaces.md): `.dim` project contract, capability profiles, task dispatch, lifecycle, and scaffold flow.
- [Example: A Multi-repository Project](../examples/multi-repo-project/README.md): a readable, tested, end-to-end walkthrough — install DIM, register a root plus two additional repositories, create a real workspace container, and use it.
- [Plugins](plugins.md): versioned provider extension boundary for optional GitHub, GitLab, and other integrations.
- [Releasing](releasing.md): release prerequisites, verification, package order, and post-publish checks.
- [Status](status.md): current progress and known future work.

Implementation-oriented normative specifications live in [../specs/README.md](../specs/README.md).

Building or contributing to DIM itself, rather than using it, is
[../CONTRIBUTING.md](../CONTRIBUTING.md).

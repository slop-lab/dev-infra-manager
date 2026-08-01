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
- **Workspace** — a named, persistent DIM resource bound to exactly one
  Project. Its record and top-level container survive stop/start until the
  workspace is explicitly discarded.
- **Workspace container** — the workspace's isolated top-level container. It
  owns the root-repository checkout and the **Project runtime**. Older text
  may call this the “workspace root” or “project-root container”; use
  “workspace container” when the distinction from the root repository
  matters.
- **Project runtime** — the nested Docker or Podman runtime owned by trusted
  Project lifecycle code in the workspace container. It runs trusted Project
  services, including secret-bearing containers. It is distinct from an agent
  container's private nested runtime.
- **Agent container** — the untrusted coding environment associated with a
  workspace. DIM core does not create or configure it: reviewed Project code
  may define it as a service in the workspace's Project runtime, give it a
  private nested runtime, and dispatch tasks through `.dim/entrypoint.sh`. It
  receives neither the host nor Project runtime control socket.
- **Project lifecycle code** — trusted code from the root repository, including
  `.dim` hooks and reviewed operational scripts, that configures the Project
  runtime. This is an authority boundary, not necessarily one long-running
  “controller” process.
- **DIM host controller** — the authenticated, plugin-extensible HTTP service
  managed by host-side DIM (the CLI also exposes `dim controller serve`). Its
  Unix socket and workspace-scoped grant let trusted Project lifecycle code
  request narrow host capabilities. It does not deploy Project containers.
- **Secret-bearing container** — a child of the Project runtime, separate from
  the agent container and its nested runtime. Trusted Project lifecycle code
  builds and deploys it from a human-reviewed ref. It may receive raw secrets;
  the agent container receives neither those secrets nor control of this
  container.

The documentation is split by concern:

- [Overview](overview.md): project goal, scope, and threat model.
- [Adopting DIM Safely](adoption.md): mandatory human review, version pinning, and branch policy for consuming projects.
- [Architecture](architecture.md): core runtime boundaries and Git/review flow.
- [Monorepo Structure](monorepo.md): workspace layout, dependency direction, and optional hosting provider boundaries.
- [Resource Isolation](resource-isolation.md): resource limits and runtime isolation.
- [Usage](usage.md): local setup, commands, and operational workflow.
- [Configuration](configuration.md): configuration file reference.
- [Runtime Backends](runtime-backends.md): Sysbox, gVisor, rootless Podman, and runc selection.
- [Runtime Images](runtime-images.md): workspace-root runtime images and their nested workloads.
- [External workspace URLs](external-urls.md): controller discovery, named ingresses, nested targets, and Caddy/Cloudflare HTTPS.
- [Repository-backed Workspaces](repo-workspaces.md): local Gitea registration, persistent workspaces, reconciliation, and Git environment.
- [Managed CI Runners](ci-runners.md): independent pull-request verification, resource defaults, and runner lifecycle.
- [Project Workspaces](project-workspaces.md): `.dim` project contract, capability profiles, task dispatch, lifecycle, and scaffold flow.
- [Example Project](../examples/project/README.md): copyable multi-repository Project, Project-owned agent, host Git identity, and reviewed secret service.
- [Example: External URLs](../examples/features/external-urls/README.md): named ingress discovery and real root/dev/deep reverse-proxy routing.
- [Advanced example: External URL route policy](../examples/features/external-url-route-policy/README.md): a checked-in Unix-socket policy webhook.
- [Plugins](plugins.md): explicit plugin loading, named extensions, and
  constrained host-input providers.
- [Releasing](releasing.md): release prerequisites, verification, package order, and post-publish checks.
- [Status](status.md): current progress and known future work.

Implementation-oriented normative specifications live in [../specs/README.md](../specs/README.md).

Building or contributing to DIM itself, rather than using it, is
[../CONTRIBUTING.md](../CONTRIBUTING.md).

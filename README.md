# dev-infra-manager

**Persistent workspaces. Clean verification. Reviewed promotion.**

`dev-infra-manager` (DIM) is a self-hosted execution and trust layer for
coding-agent development on Linux.

DIM turns a Linux host into Project-scoped development infrastructure where
coding agents can install tools, run services, and build or run nested
containers without receiving direct control of the host container runtime.
Each Project can combine:

- Workspaces that persist across agent turns and retries and are removed only
  through an explicit discard lifecycle.
- Docker-capable workspaces backed by selectable isolation runtimes, without
  exposing the host container daemon directly to the agent.
- Managed Git and CI as the promotion boundary between mutable workspaces and
  protected Project state.
- A reviewed Project contract that defines a complete multi-repository
  workspace and its lifecycle.
- Separation between agent-controlled code and operations that receive
  secrets.
- Per-workspace CPU, memory, and process limits.

DIM sits below interactive coding agents and autonomous orchestrators. Codex,
Claude Code, or another agent can run in a DIM workspace. An orchestrator such
as OpenAI Symphony can map a task to a persistent DIM workspace while DIM owns
the workspace, repository, verification, and trust boundaries.

DIM does not decide what work an agent should do, replace an issue tracker, or
prescribe an agent workflow. It controls where work runs, what infrastructure
it can reach, and which reviewed path can promote its output.

## The trust path

A typical DIM Project separates mutable development from trusted promotion:

```text
agent workspace
  persistent across turns and retries
  no raw project/runtime secrets
        |
        | commit and push
        v
project-scoped Git branch
        |
        | isolated verification in a separate checkout
        v
CI result and review evidence
        |
        | explicit review gate
        v
protected ref or trusted Project runtime
        |
        | scoped secret-bearing operation
        v
artifact, signing, publishing, or deployment
```

DIM's canonical public source repository is GitHub, while DIM development
normally uses the active Git host managed by a self-development Project. The
current reference backend is Gitea with `act_runner`, but neither is part of
the long-term Project contract. See
[DIM Development Repositories](docs/development-repositories.md).

Workspaces persist. Verification runs separately in disposable job containers.
Secret-bearing Project services must be built and deployed from reviewed refs.

## Typical uses

### Interactive coding-agent workspaces

Keep a workspace across multiple agent sessions, run nested Docker workloads
inside it, and explicitly discard it when the work is finished.

### Orchestrated autonomous implementation

Let an external control plane own task selection, scheduling, retries, and
agent sessions while DIM owns workspace isolation, repository state, CI
verification, and promotion gates. DIM does not yet ship a Symphony-specific
adapter or stable orchestrator API.

### Agent-authored changes with separate CI

Allow an agent to modify arbitrary code in its workspace while repeating
checks in a separate runner checkout and disposable job container that has no
host Docker socket or DIM workspace credentials.

### Reviewed secret-bearing operations

Keep signing, publication, deployment, and other privileged work outside the
agent container. Current Projects implement this with reviewed lifecycle code
and separate services; DIM does not claim that container separation alone is a
strong boundary inside a privileged workspace.

### Multi-repository projects

Use a reviewed root Project contract to provide stable repository aliases,
lifecycle hooks, protected refs, and coordinated workspaces for changes that
span multiple repositories.

## Security and release status

> [!WARNING]
> DIM has no stable release and is part of the host trust boundary. Adoption
> requires human review of the exact DIM revision, the Project contract, and
> every input that can influence a secret-bearing runtime. Pin exact versions
> and immutable source revisions.

Pre-stable `0.x` releases may change CLI, API, configuration, state, backend,
and plugin contracts without compatibility shims or implicit migration.

DIM supports Linux hosts only. macOS and Windows are not supported host
platforms, including through Docker Desktop.

Licensed under the [MIT License](LICENSE). Release history is recorded in the
[changelog](CHANGELOG.md).

Before using DIM in another project, read the mandatory [adoption and trust
requirements](docs/adoption.md). They require full human review of DIM, the
project repository, and every secret-bearing environment, plus immutable
version pinning.

This page covers using DIM. Building or contributing to DIM itself —
running its own test/verification suite, publishing packages, testing host
installers — is [CONTRIBUTING.md](CONTRIBUTING.md).

## Set up a host runtime backend

The container image and host-installer scripts DIM ships aren't published
anywhere except this repository yet, so a one-time clone is needed even if
you'll install the `dim` CLI itself from npm below:

```bash
git clone --no-checkout <this-repository>
cd dev-infra-manager
git checkout --detach <reviewed-tag-or-full-commit>
just build-project-workspace
bash scripts/install-host-ubuntu.bash sysbox
```

Run `just` as your normal user, including when it is managed by mise. The
installer invokes `sudo` only for host changes, and adds the invoking user to
the `docker` group; log out and back in or run `newgrp docker` once after the
first installation.

> [!WARNING]
> Access to the host Docker daemon, including membership in the `docker` group,
> is effectively root-level host access. Use a dedicated DIM host or service
> identity if that trust assumption is not acceptable. Agent containers must
> never receive the host Docker socket.

The installer shows every package and host-level change before doing anything
and proceeds only after you enter `yes`. It is a development convenience, not
production hardening guidance. In particular, review its path-scoped AppArmor
exceptions for Sysbox FUSE mounts and rootless DinD's
`/usr/local/bin/rootlesskit` user namespace before using it outside a
development host.

Choose the backend your workspaces will use:

```bash
bash scripts/install-host-ubuntu.bash sysbox          # default nested-container backend
bash scripts/install-host-ubuntu.bash gvisor          # sandboxed fallback without KVM
bash scripts/install-host-ubuntu.bash rootless-podman # lower-host-privilege workloads
bash scripts/install-host-ubuntu.bash runc            # trusted development/CI only
```

See [docs/runtime-backends.md](docs/runtime-backends.md) for how these
differ, and [CONTRIBUTING.md](CONTRIBUTING.md) for testing an installer in a
disposable KVM guest instead of your own host.

## Install the `dim` CLI

Pin an exact, reviewed version — never `latest`:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.8.0'
dim install-cli
```

The mise-installed facade provisions Node.js 24 on demand when no supported
Node.js is on `PATH`; Node.js does not need to be added to the global mise
configuration. The first `dim` invocation may therefore download Node.js.

or, without mise:

```bash
npx '@slop-lab/dim-installer@0.8.0'
npx '@slop-lab/dim-installer@0.8.0' install-cli
npx '@slop-lab/dim-installer@0.8.0' install-plugin '@example/dim-plugin@1.2.3'
```

`@slop-lab/dim-installer` is a thin facade: it owns only `installer`,
`install-cli`, and `install-plugin`, and proxies every other command to a
separately installed `@slop-lab/dim-cli`. Bare `dim` opens an interactive
installer only until a CLI is configured; after that it behaves like `dim
--help`, and `dim installer` is what reopens the prompt. Installation
choices persist under `${XDG_CONFIG_HOME:-~/.config}/dim/config.json`. See
the [installer README](https://www.npmjs.com/package/@slop-lab/dim-installer)
for the full command reference.

Check the installed backend before creating a workspace:

```bash
dim doctor
```

If the CLI was installed without configuring a host backend, configure one
through the same diagnostic path:

```bash
dim doctor configure-backend
```

DIM uses an explicitly enabled, versioned plugin loader for concrete
integrations. It does not expose a generic Git-provider extension point. See
[docs/plugins.md](docs/plugins.md).

## Create a Project

```bash
dim project create project \
  --url /path/to/project --ref main --apply-repos
dim workspace create project work-1
dim workspace run work-1 codex
dim workspace exec work-1 -- bash
```

The selected ref's `.dim/repos.yml` supplies the stable root and non-root
repository aliases. `--apply-repos` applies the complete reviewed set without
requiring a separate local manifest.

If an interactive prompt is declined, apply the managed root file later
without a local clone using `dim repo apply project --yes`.

The keys below `repositories` are Project-scoped aliases; URLs are passed to
the host Git CLI and are never parsed to invent a name.

This repository implements the same project contract on itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`; after pushing it as the Project
root, `dim workspace run work-1 codex` launches Codex in the persistent DIM workspace,
no separate launcher needed.

For a complete, tested walkthrough that exposes a nested development
container and a container inside it through host-configured external URL
ingresses, see [examples/features/external-urls](examples/features/external-urls/README.md).
For the smallest complete Project with one unprotected repository and no
secrets, see
[examples/projects/single-repository](examples/projects/single-repository/README.md).

See [glossary](docs/README.md#glossary), [docs/repo-workspaces.md](docs/repo-workspaces.md)
for lifecycle, credential, and reconciliation details, and
[docs/project-workspaces.md](docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle. [docs/README.md](docs/README.md)
is the full documentation index.

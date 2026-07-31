# dev-infra-manager

`dev-infra-manager` (DIM) provides persistent, isolated, review-gated
workspaces for AI-assisted development.

DIM supports Linux hosts only. macOS and Windows are not supported host
platforms, including through Docker Desktop.

Licensed under the [MIT License](LICENSE). Release history is recorded in the
[changelog](CHANGELOG.md).

Before using DIM in another project, read the mandatory [adoption and trust
requirements](docs/adoption.md). They require full human review of DIM, the
project repository, and every secret-bearing environment, plus immutable
version pinning.

DIM focuses on the container and infrastructure boundary around agent
workspaces:

- Persistent, explicitly discarded agent workspaces.
- Backend-selectable nested container isolation.
- Secret-bearing runtime separation.
- Project-scoped managed Git repositories and protected branches.
- Root-repository lifecycle hooks for multi-repository projects.
- Workspace-level CPU, memory, and PID limits.

This page covers using DIM. Building or contributing to DIM itself —
running its own test/verification suite, publishing packages, testing host
installers — is [CONTRIBUTING.md](CONTRIBUTING.md).

## Set up a host runtime backend

The container image and host-installer scripts DIM ships aren't published
anywhere except this repository yet, so a one-time clone is needed even if
you'll install the `dim` CLI itself from npm below:

```bash
git clone <this-repository>
cd dev-infra-manager
just build-project-workspace
bash scripts/install-host-ubuntu.bash sysbox
```

Run `just` as your normal user, including when it is managed by mise. The
installer invokes `sudo` only for host changes, and adds the invoking user to
the `docker` group; log out and back in or run `newgrp docker` once after the
first installation.

The installer shows every package and host-level change before doing anything
and proceeds only after you enter `yes`. It is a development convenience, not
production hardening guidance. In particular, review its path-scoped AppArmor
exception for Sysbox FUSE mounts before using it outside a development host.

Choose the backend your workspaces will use:

```bash
bash scripts/install-host-ubuntu.bash sysbox          # production default
bash scripts/install-host-ubuntu.bash gvisor          # no-KVM sandboxed fallback
bash scripts/install-host-ubuntu.bash rootless-podman # lower-privilege Podman workloads
bash scripts/install-host-ubuntu.bash runc            # nested development/CI only
```

See [docs/runtime-backends.md](docs/runtime-backends.md) for how these
differ, and [CONTRIBUTING.md](CONTRIBUTING.md) for testing an installer in a
disposable KVM guest instead of your own host.

## Install the `dim` CLI

Pin an exact, reviewed version — never `latest`:

```bash
mise use -g 'npm:@slop-lab/dim-installer@0.4.0'
dim install-cli
```

or, without mise:

```bash
npx '@slop-lab/dim-installer@0.4.0'
npx '@slop-lab/dim-installer@0.4.0' install-cli
npx '@slop-lab/dim-installer@0.4.0' install-plugin '@example/dim-plugin@1.2.3'
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

DIM retains an explicitly enabled, versioned plugin loader for future
concrete integrations. Version 0.4.0 does not expose a generic Git-provider
extension point. See [docs/plugins.md](docs/plugins.md).

## Create a Project

```bash
dim project create project
dim repo add project root /path/to/project --root --ref main --protect main
dim create project work-1
dim run work-1 codex
dim exec work-1 -- bash
```

For several repositories, create the Project and import the complete set in
one reviewed operation:

```bash
dim project create project --repos repos.yml
```

The keys below `repositories` are Project-scoped aliases; URLs are passed to
the host Git CLI and are never parsed to invent a name.

This repository implements the same project contract on itself through
`.dim/setup.sh` and `.dim/entrypoint.sh`; after pushing it as the Project
root, `dim run work-1 codex` launches Codex in the persistent DIM workspace,
no separate launcher needed.

For a complete, tested walkthrough that exposes a nested development
container and a container inside it through host-configured external URL
ingresses, see [examples/external-urls](examples/external-urls/README.md).

See [glossary](docs/README.md#glossary), [docs/repo-workspaces.md](docs/repo-workspaces.md)
for lifecycle, credential, and reconciliation details, and
[docs/project-workspaces.md](docs/project-workspaces.md) for the
project-facing `.dim` contract and CLI lifecycle. [docs/README.md](docs/README.md)
is the full documentation index.

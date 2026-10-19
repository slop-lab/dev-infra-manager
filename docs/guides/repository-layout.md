# Repository layout

Production packages are grouped by where they run and what they own:

| Directory | Published package | Responsibility |
| --- | --- | --- |
| `packages/host/core` | `@slop-lab/dim-host-core` | Workspace lifecycle, host controller, plugin composition and scoped guest access |
| `packages/host/plugins/<name>` | `@slop-lab/dim-host-plugin-<name>` | Optional host capabilities and their workspace or agent integration |
| `packages/control-plane/core` | `@slop-lab/dim-control-plane-core` | Standalone control-plane plugin runtime |
| `packages/control-plane/plugins/<name>` | `@slop-lab/dim-control-plane-plugin-<name>` | Independent authoritative services and workflow interpretation |
| `packages/control-plane/admin` | `@slop-lab/dim-control-plane-admin` | Explicit service deployment and operator connection tools |
| `packages/contracts/<name>` | `@slop-lab/dim-contracts-<name>` | Shared configuration and wire schemas without service or host implementations |
| `packages/cli` | `@slop-lab/dim-cli` | Command presentation, host selection and transport |
| `packages/installer` | `@slop-lab/dim-installer` | Installation facade and artifact validation |
| `packages/web` | `@slop-lab/dim-web` | Browser review client |

A **host** is the DIM controller host that manages workspaces and may run CI
workers. A control plane owns shared services. These roles can run on the same
machine; they describe authority and installation, not physical topology.
Host plugins own delivery of their workspace and agent helpers through the
shared host integration mechanism. Repositories need no plugin configuration
for capabilities selected by the operator.

The control-plane runtime and its plugins can be installed without the host
core or CLI. CI workers consume neutral CI contracts; they do not install the
Native Git server to understand execution requests. Contracts do not depend on
host, service, deployment or CLI implementations.

`tests/` is the single development test workspace, named `@this-project/tests`.
Its ownership directories mirror production packages. `tests/scenarios/` holds
cross-component scenarios, live integrations and disposable QEMU fixtures.
`scripts/checks/` contains their runners and source gates; `scripts/packages/`
contains shared package build helpers. Ordinary source checks, live container
checks and privileged QEMU checks have explicit separate entrypoints.

`docs/guides/` documents use, `docs/specs/` defines contracts,
`docs/development/` explains contributor tooling, and `docs/history/` archives
previous package-group release notes. Current cross-package release outcomes
belong in the root changelog.

Only publishable artifacts use `@slop-lab/`. Development workspaces and private
image manifests use `@this-project/`. A production source manifest is private
because publishing happens from its generated `dist` directory; this does not
make its published artifact a development package.

Names are conventions, not discovery rules. DIM loads explicitly installed
plugin manifest entries; third-party package names remain unrestricted.
Importing a package must not start a daemon or mutate host state. Credentials
belong in operator runtime configuration, never in shared contracts.

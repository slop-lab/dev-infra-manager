# Repository layout

Production packages are grouped by where they run and what they own:

| Directory | Published package | Responsibility |
| --- | --- | --- |
| `packages/host/core` | `@slop-lab/dim-host-core` | Workspace lifecycle, host controller, plugin composition and scoped guest access |
| `packages/host/plugins/<name>` | `@slop-lab/dim-host-plugin-<name>` | Optional host capabilities and their workspace or agent integration |
| `packages/control-plane/core` | `@slop-lab/dim-control-plane-core` | Standalone control-plane plugin runtime |
| `packages/control-plane/plugins/<name>` | `@slop-lab/dim-control-plane-plugin-<name>` | Independent authoritative services and workflow interpretation |
| `packages/control-plane/deployment` | `@this-project/control-plane-deployment` (private) | Composition artifact for the installer’s fixed service-image profile |
| `packages/control-plane/admin` | `@slop-lab/dim-control-plane-admin` | Explicit service deployment and operator connection tools |
| `packages/task-scheduling` | `@slop-lab/dim-task-scheduling` | Shared durable task queue, lease state transitions and typed handler/client SDK |
| `packages/review-tracing-node` | `@slop-lab/dim-review-tracing-node` | Brokered JS/TS loader and isolated Docker execution, shared by host and control-plane adapters |
| `packages/review-tracing` | `@slop-lab/dim-review-tracing` | Runtime-neutral file-read records, dependency comparison and tracing adapter contracts |
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

Review tracing is optional. The shared tracing package contains no service,
container runner or language loader. The control-plane `review-tracing` plugin
connects immutable Git snapshots to review requirements; runtime plugins such as
`review-tracing-node` own isolated execution and import/file-read mediation.
Additional runtimes implement the same tracing contract without changing review
or ref-policy core. The Node implementation is a neutral package; control-plane
and host plugins register it in their owning runtimes. The scheduled adapter
uses the same task queue, leases and worker loop as CI; it retains immutable Git
reads and dependency evidence in the repository-owning control plane.

The mirrors consumer and cache-server deployment are separate host plugins.
Mirrors owns its included and installed protocol adapters, scoped relay and guest
client configuration; cache-server owns local cache service resources. Their
shared placement input is a URL catalog, with only selected protocols required.

Repository hosting, code review, merge policy, Git-CI and external webhook
transport are separate control-plane plugins. Repository storage owns protected
ref CAS and its recovery journal; review owns human evidence, merge policy owns
authorization, and Git-CI owns workflow planning and execution evidence. Their
shared attachment SDK belongs to the repository plugin. Neutral Git contracts
contain schemas and identities, without importing feature implementations.

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

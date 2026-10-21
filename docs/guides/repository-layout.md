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
| `packages/execution-scheduler` | `@slop-lab/dim-execution-scheduler` | Durable queue and lease implementation; isolated `/client` transport entrypoint |
| `packages/review-tracing-node` | `@slop-lab/dim-review-tracing-node` | Brokered JS/TS loader and isolated Docker execution, shared by host and control-plane adapters |
| `packages/review-tracing` | `@slop-lab/dim-review-tracing` | Runtime-neutral read tracking and dependency comparison; `/plugin-api` for runtime adapters |
| `packages/contracts/<name>` | `@slop-lab/dim-contracts-<name>` | Shared configuration and wire schemas without service or host implementations |
| `packages/cli/core` | `@slop-lab/dim-cli` | Command presentation, host selection and transport |
| `packages/cli/plugins/<name>` | `@slop-lab/dim-cli-plugin-<name>` | Feature commands using client-side operation APIs |
| `packages/clients/<name>` | Feature-specific client packages | Shared service calls and validated operations without running their authoritative service; LLM router, execution and Native Git clients |
| `packages/installer` | `@slop-lab/dim-installer` | Installation facade and artifact validation |
| `packages/web/core` | `@slop-lab/dim-web` | Authenticated console shell, host workspaces, plugin loading and session enforcement |
| `packages/web/plugins/<name>` | `@slop-lab/dim-web-plugin-<name>` | Feature-specific server connection and browser panel |

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

Plugin implementation entrypoints are named explicitly:

| API | Implemented by |
| --- | --- |
| `@slop-lab/dim-host-core/plugin-api` | Host plugins and their contributions |
| `@slop-lab/dim-control-plane-core/plugin-api` | Control-plane plugins |
| `@slop-lab/dim-web/plugin-api` | Web feature panels and validated operation handlers |
| `@slop-lab/dim-contracts-operations` | Shared client operation declarations and access descriptions |
| `@slop-lab/dim-contracts-execution/plugin-api` | Worker task handlers |
| `@slop-lab/dim-review-tracing/plugin-api` | Review detector runtime adapters |
| `@slop-lab/dim-contracts-ci/workflow-plugin-api` | CI workflow compilers |
| `@slop-lab/dim-host-plugin-mirrors/protocol-plugin-api` | Mirror protocol adapters |

Repository attachments, review matchers, merge guards and webhook publishers use
their owning control-plane plugin’s `/plugin-api` entrypoint. Runtime operations
remain separate from the interfaces that plugin authors implement.

Repository, review, merge-policy and webhook contributions similarly use their
owning plugin's `/plugin-api` entrypoint. Schemas crossing process boundaries
belong to `contracts`; service and host implementations expose their composed
configuration from `/config`. Generic execution contracts do not import CI or the
scheduler implementation. CI contracts contain CI events, grants, results and
configuration fragments. The deployed scheduler and host worker compose those
fragments with generic task configuration.

The mirrors consumer and cache-server deployment are separate host plugins.
Mirrors owns its included and installed protocol adapters, scoped relay and guest
client configuration; cache-server owns local cache service resources. Their
shared placement input is a URL catalog, with only selected protocols required.

Repository hosting, external Git synchronization, code review, merge policy,
Git-CI and external webhook transport are separate control-plane plugins.
The `git-sync` attachment owns upstream fetching, merge proposals and publication;
it never owns promotion authority or writes protected refs directly. Repository storage owns protected
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

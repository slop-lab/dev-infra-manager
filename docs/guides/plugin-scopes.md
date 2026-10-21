# Host and control-plane plugins

Plugin exports identify their execution location. Packages that provide both
sides of a shared service also name the host or control-plane role explicitly.
Workspace commands use host plugins; shared services use control-plane plugins.
Installing one does not enable the other location's implementation.

## Host plugins prepare their clients

Install a feature on its owning host once. The host plugin owns any helpers,
configuration and scoped connections needed inside its workspaces. A repository
does not need a `.dim` directory or plugin declaration for this preparation.
Repository plugin requirements are additional dependency checks, not the source
of the host's enabled integrations.

Preparation runs when a workspace becomes ready, including start, recreation
and the host's execution path. Plugins repair their guest assets without
reinstalling unchanged files. Large tool downloads, provider authentication and
service/route selection remain explicit plugin operations. Installing an agent
tools plugin does not implicitly install every supported coding agent; installing
a router adapter does not choose an upstream account or grant a Project scope.

Inside a workspace, discover the host's enabled integrations with:

```bash
dim-workspace plugins
```

The response describes plugin commands, scoped operations and readiness. It
contains no host configuration or credentials. Plugins own their user-facing
clients, such as `dim-expose`; the generic client also supports namespaced
operations through `dim-workspace plugin NAME OPERATION [JSON]`. An operation
receives the authenticated immutable workspace identity from the host, rather
than accepting another workspace selector from its caller.

This connection is a shared proxy for all enabled guest integrations. Host
composition owns its process, current protocol and installed-plugin generation;
plugins do not each implement update detection or install another proxy. The
next host readiness operation refreshes the shared guest client and replaces a
stale connection when installed code or plugin selection changes. Old workspace
images therefore do not need to supply the current plugin protocol themselves.

The shared guest delivery primitive accepts reviewed plugin files relative to
the guest user's home and sends their contents over stdin. It checks file and
directory ownership, rejects unsafe links, preserves unchanged files and uses
atomic replacement. Plugin code retains responsibility for installation
semantics, resource health and the ordering of credential activation. The
primitive does not interpret repository installation scripts or deployment
policies.

The default Sysbox workspace is also the coding agent's container. A plugin may
explicitly target a container inside that workspace's private Docker engine;
the delivery path resolves its container ID before execution. It never scans
and modifies every container, connects to the host Docker socket from a guest,
or assumes a separate coding-agent container exists. Arbitrary application
images need the prerequisites of the selected client; unsupported targets fail
with an installation error. Separate guest packages are useful only when their
dependencies or release lifecycle justify them.

Targeted file delivery does not grant a nested container the workspace's
lifecycle connection. A plugin that connects a nested client owns that client's
restricted credentials and connection semantics; it must not copy host operator
credentials or the workspace lifecycle token as a shortcut.

## Shared service packages

| Package | Location and responsibility |
| --- | --- |
| `@slop-lab/dim-control-plane-core` | Standalone service plugin runtime; loading, capability validation and shutdown |
| `@slop-lab/dim-control-plane-plugin-git-repositories` | Repository storage, scoped Git transport and durable protected-ref CAS |
| `@slop-lab/dim-control-plane-plugin-code-review` | Immutable review evidence and human approvals/revocations |
| `@slop-lab/dim-control-plane-plugin-merge-policy` | Promotion authorization from current review and selected quality evidence |
| `@slop-lab/dim-control-plane-plugin-git-ci` | Candidate planning, execution grants/evidence and CI event delivery |
| `@slop-lab/dim-control-plane-plugin-webhooks` | Independent external subscriptions and durable signed delivery |
| `@slop-lab/dim-control-plane-plugin-execution-scheduler` | Durable execution coordination and worker admission |
| `@slop-lab/dim-control-plane-plugin-ci-workflows` | Repository workflow language compiler consumed by Git-CI |
| `@slop-lab/dim-control-plane-plugin-llm-router` | Upstream accounts and secrets, routing, admission, usage and exchange capture |
| `@slop-lab/dim-host-plugin-llm-router` | Workspace identity checks, scoped router enrollment, local gateway and guest/OpenCode configuration |

Repository hosting does not require review, merge policy, a compiler or CI.
Human review works without Git-CI; protected-ref promotion requires a selected
merge-policy implementation. Trusted repository policy sections must have enabled
owners. The repository-owned `./plugin-api` SDK supplies attachment and serialized
repository ports; the control-plane core only composes generic named extensions.
Feature code and its state remain in the owning plugin.

The workflow compiler does not execute jobs. The execution-scheduler control-plane plugin owns
generic task and CI execution coordination; `@slop-lab/dim-host-plugin-execution-worker` runs configured
container/VM slots on a host. A host may own workspaces and CI workers together.
`@slop-lab/dim-control-plane-admin` composes operator setup and clients; it is
separate from the standalone control-plane runtime and service plugin closure.

## Install on the selected machine

The installer facade can install control-plane plugins on a machine that has
no host core, host plugins or DIM CLI installed:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0'
```

This installs the matching standalone runtime and selected plugins in a separate
control-plane tree. `--local-packages DIRECTORY` selects the reviewed source
bundle's exact dependency closure. The installer prints its executable path.
`DIM_CONTROL_PLANE_PLUGIN_HOME` overrides that tree; otherwise it lives under
`DIM_DATA_HOME/control-plane/runtime/current` (the usual user data directory
supplies `DIM_DATA_HOME` when omitted).

Manage that plugin selection with:

```bash
dim installer control-plane disable-plugin '@slop-lab/dim-control-plane-plugin-git-repositories'
dim installer control-plane enable-plugin '@slop-lab/dim-control-plane-plugin-git-repositories'
dim installer control-plane remove-plugin '@slop-lab/dim-control-plane-plugin-git-repositories'
```

Restart the control-plane process after changing its enabled plugin selection.
Run its private service configuration with `dim-control-plane run FILE`, using
the executable path printed by installation. See the
[runtime configuration](../../packages/control-plane/core/README.md).
The existing `dim installer install control-plane --config FILE` command owns
the separate Docker deployment/activation transaction.

Host plugins use `dim installer install plugin PACKAGE@EXACT_VERSION` on the
host that owns the workspace. Its host plugin manifest is separate from the
control-plane manifest. `.dim/workspace.json` declares required host plugins
only; a repository cannot install or activate control-plane code as a side
effect of workspace creation. Install and configure the required shared services
deliberately before selecting `dim://` sources or remote router connections.

## LLM router connection

The control-plane router owns backend account keys and operator operations.
It grants a host issuer access to explicit project/route pairs. The host adapter
enrolls only its selected workspace identity and keeps the resulting upstream
principal token in private host state. Guests receive a separate gateway token.

The host gateway validates the immutable workspace UUID and running state before
forwarding and while streaming. Discard, stop or same-name replacement fences
the old workspace. Guest headers cannot select another project/account or
replace the host's router credential. The remote router does not read the host's
workspace store, and the host adapter does not need backend account keys or
router database access. Each side can be installed and restarted independently.

## Verification

The source tests cover plugin startup/cleanup and enabled-package selection,
native Git startup without workspace packages, independent packaged installation,
and router-to-host gateway authorization. The artifact profile smoke installs
real control-plane packages into an empty user tree before installing any host
components. The public/private [example](../../examples/projects/native-multiple-repositories/README.md)
uses explicitly selected repository, review, merge, Git-CI and workflow plugins in linked Git/CI verification.

## Shared package caches

The mirrors host plugin is a consumer integration. Its included Docker Hub,
npm, PyPI and APT adapters can be selected independently by endpoint. Enabled
installed host plugins may contribute additional reviewed adapters through
`mirrorAdapterExtension`; catalogs remain URL-only data. Each protocol owns
request restrictions, metadata handling and its self-contained guest client.
The common relay and guest runner own transport and application, rather than
interpreting a configurable policy language. See the
[mirrors adapter SDK](../../packages/host/plugins/mirrors/README.md#installed-protocol-adapters).

The separate cache-server plugin provisions its reviewed local services and
publishes endpoint URLs. External services or NAS placement use the same URL
selection; the consumer does not reconcile or take ownership of those servers.

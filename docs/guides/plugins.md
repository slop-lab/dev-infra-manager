# DIM plugins

Ordinary Git workspaces, local/SSH host selection, shell execution and loopback
forwarding run without plugins or a control plane. Host plugins add workspace and CI-worker capabilities; control-plane plugins
provide shared authority and service capabilities. Workflow syntax belongs to
`@slop-lab/dim-control-plane-plugin-ci-workflows`; the separately selected Git-CI
plugin consumes its compiled plans. Repository hosting and human review require
neither a compiler nor an execution service.

The generic controller plugin host belongs to `@slop-lab/dim-host-core/controller`. It owns
the lifecycle of enabled controller plugins, scoped request dispatch, host
administration transport and neutral host-input provider registration. Feature
plugins own their concrete drivers and provider semantics. It does not own workspace lifecycle or inject a controller
socket, host runtime socket or raw host credential into a workspace.

## Installation and registration

Host plugins may prepare their own in-workspace clients automatically without
repository metadata. [Plugin locations and guest preparation](plugin-scopes.md)
describe the shared delivery and discovery interfaces. `dim-workspace plugins`
lists their commands and readiness inside a workspace. The host plugin remains
the installation unit; a separate npm package for each container is unnecessary.

Install exact reviewed host plugin versions:

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-external-urls@0.10.0'
dim plugins
```

The installer records enabled packages in the host plugin configuration. Merely
being present as a dependency does not register a controller plugin. Discovery
accepts explicit package names, including private registry packages; there is
no naming-prefix convention. Installing host core alone does not enable
plugins or start a controller. Plugin commands start the optional controller
when needed. After changing an already running controller's configuration, use
`dim controller restart`.

A controller plugin exports a `DimPlugin` with the current API version:

```ts
import { DIM_PLUGIN_API_VERSION, type DimPlugin } from "@slop-lab/dim-host-core/controller";

export const plugin: DimPlugin = {
  name: "company.workspace-tools",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerControllerRoute({
      method: "GET",
      path: "/example",
      summary: "Describe the selected workspace",
      async handle(context) {
        return { body: { workspace: context.workspace.name } };
      }
    });
  }
};
```

Registration happens once per controller instance. Method/path pairs and named
extensions are unique. Registration after startup is rejected. A plugin may
return a disposer; shutdown invokes registered disposers in reverse order.

## Workspace routes and host administration

The controller has one workspace-scoped Unix socket and a separate host-admin
Unix socket. Commands such as `dim external-url list --workspace NAME` obtain a
private grant on the host and use the workspace socket. The controller reads
the actual core `WorkspaceStore`, whose records use immutable UUIDs. Tokens
stop authenticating after discard or same-name replacement. Dispatch holds the
workspace lock and checks that the selected UUID remains current.

Workspace route context contains the real UUID and name. `projectId` and
`projectName` exist only when a matching native Git attachment supplies them;
ordinary Git workspaces have no invented Project. Host admin routes can manage
plugin configuration and host inventories, but are not reachable with a scoped
workspace token. There is no agent listener or route-audience matrix.

A plugin resolves targets through the controller helper rather than choosing a
host address. `containers: []` selects a service on workspace loopback;
`containers: ["name"]` selects one container inside that workspace's Docker
engine. The helper verifies core runtime ownership, pins the owned agent's
container ID and IP, and runs the byte relay inside that agent. It supports no
second nested-container level. External URL listeners recheck the current core
UUID on every HTTP request, WebSocket upgrade and new TCP connection, so a
cached IP cannot redirect an old route after workspace replacement. Each new
flow also resolves the currently owned runtime and restores its relay after
container recreation; existing flows retain their selected endpoint.

## Named extensions and host inputs

Plugins can share explicitly registered implementation objects:

```ts
host.registerExtension("company.storage", "reviewed-driver", driver);
const selected = host.extension("company.storage", configuredName);
```

External URLs use this mechanism for DNS and ingress drivers. Extension
registration is local to the controller instance and creates no package-name
compatibility convention.

A host-input provider implements `resolve(request, context)` and returns one
string for keys it explicitly accepts. Context includes the workspace name and
optional native Project metadata. The built-in `builtin.git-author` accepts
only `name` and `email`, read from the host's effective Git configuration. DIM
does not cache provider results or run repository setup hooks to request them.

There are no workspace capability-provider or discard-hook registration APIs.
Core owns workspace execution and isolation. Plugins own their explicit
operations and resource cleanup; external URL delete/revoke closes its flows,
and per-connection identity checks enforce discard without lifecycle callbacks.

## Optional package caches

Base workspaces and CI workers use direct package access by default.
`@slop-lab/dim-host-plugin-cache-server` owns optional host cache deployment,
storage, resource ownership and Docker/npm/PyPI/APT service reconciliation.
`@slop-lab/dim-host-plugin-mirrors` owns workspace/CI connection configuration,
scoped relays and package-manager adapters. Installing or connecting a client
must never deploy servers. Both packages use host core without control-plane services.

Install either package through `dim installer install plugin` at its exact
reviewed version. Deploy a selected local server with `dim cache-server ensure`;
it publishes `DIM_STATE_ROOT/services/package-caches.json`. The fixed catalog is
`{schemaVersion:1,endpoints:{docker,npm,pypi,apt}}`, where each endpoint is a URL.
The client may consume that local catalog or an explicit reviewed catalog saved
with `dim mirrors configure FILE`. Explicit client configuration takes
precedence, supporting a separate host or NAS without a deployment DSL.
`dim mirrors ensure` validates connection configuration and never starts servers.

An enabled client refreshes scoped workspace relays and guest configuration on
workspace readiness once cache URLs are configured. Without a catalog it leaves
direct package access unchanged and advertises the required setup through
`dim-workspace plugins`. Invalid configured input and provider failure stop that selected path rather than
silently changing routing. Docker Hub fallback is blocked for the selected
mirror path. Neither package is required by ordinary workspaces, controller
startup or native Git. Cache storage outlives individual workspaces; workspace
discard does not delete shared host cache state.

## Host runtime capabilities

`@slop-lab/dim-host-core/workspace` exports `WorkspaceHostPlugin`, the
`hostPlugin` descriptor contract. Runtime providers implement `WorkspaceRuntime`;
commands receive the host service and store; `workspaceReady` repairs guest
integrations through `deployGuestIntegration`. Guest metadata and operations
provide authenticated discovery without repository configuration.

A plugin may expose `executionRouting(context)` for CI-worker routing. It returns
`undefined` when unconfigured; installation alone does not select a route. The
host composes enabled providers and rejects multiple configured routes. The
selected `HostExecutionRouting` supplies the network, blocked hostnames, Docker
daemon configuration and optional job files/environment defaults. Workers consume
this port without importing cache implementations. Invalid explicit configuration
fails before execution instead of silently reverting to direct access.

Control-plane plugins use the separate `controlPlanePlugin` contract exported
by `@slop-lab/dim-control-plane-core/plugin-api`. Their runtime validates required
capabilities before startup and closes started services in reverse order.

## Host extension contributions

Enabled host plugins may contribute `hostPlugin.extensions`, an array of
`{kind, name, value}` code contributions. The host rejects duplicate kind/name
pairs before invoking hooks and passes the enabled contributions in each
plugin context. Each extension owner defines and validates its own typed value;
the host core does not interpret protocol names or application configuration.
Repository files cannot enable host code through this registry.

## Workspace source providers

A host plugin may own non-Git URL schemes through `hostPlugin.source`. Its
`create` operation receives the requested repository selection and host runtime
context; `ensure` restores its scoped integration after readiness or recreation.
The host selects providers from the enabled plugin manifest and rejects competing
owners. Ordinary local, SCP-style and standard Git URLs retain the base Git
acquisition path. Installing a dependency without enabling its plugin does not
authorize custom source handling.

`workspaceMetadata` optionally supplies Project identity to the generic host
controller. The controller resolves enabled providers and rejects ambiguous
metadata. Native Project attachments belong to the native Git host plugin; the
CLI and host core do not import that feature by package name.

Host module loading uses `resolveHostPluginModule(home, specifier)` from host
core. Named npm packages, including package subpaths, must have an entry in that
runtime's `node_modules`; resolution cannot borrow an ancestor dependency. The
resolved entry must remain inside the selected package's real directory. Local
pnpm/workspace symlinks remain supported. An operator may also select an explicit
absolute, relative or `file:` module path for development. These are code
selections in the host manifest, never repository-controlled installation paths.

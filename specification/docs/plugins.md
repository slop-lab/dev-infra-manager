# DIM plugins

Ordinary Git workspaces, local/SSH host selection, shell execution and loopback
forwarding run without plugins or a control plane. Optional managed services
compose extensions for their own responsibilities. Workflow syntax belongs to
`@slop-lab/dim-plugin-ci-workflows`; Git authority and CI runtimes consume its
compiled job plans through an explicit compiler interface.

The optional controller plugin host belongs to `@slop-lab/dim-managed`. It owns
external URL drivers, scoped workspace routes, host administration routes and
host-input providers. It does not own workspace lifecycle or inject a controller
socket, host runtime socket or raw host credential into a workspace.

## Installation and registration

Install the optional managed component and exact reviewed plugin versions:

```sh
dim installer install core --with-managed
dim installer install plugin '@slop-lab/dim-plugin-external-urls@0.10.0'
dim plugin list
```

The installer records enabled packages in the host plugin configuration. Merely
being present as a dependency does not register a controller plugin. Discovery
accepts explicit package names, including private registry packages; there is
no naming-prefix convention. Installing managed support alone does not enable
all plugins or start a controller. Plugin commands start the optional controller
when needed. After changing an already running controller's configuration, use
`dim controller restart`.

A controller plugin exports a `DimPlugin` with the current API version:

```ts
import { DIM_PLUGIN_API_VERSION, type DimPlugin } from "@slop-lab/dim-managed";

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

## Optional mirrors

Base workspaces and native root CI use direct image access by default. A host
may explicitly enable `@slop-lab/dim-plugin-host-mirrors`. An enabled provider
selects reviewed cache images and CI mirror routing; provider failure stops
that selected path rather than silently changing routing. The mirror plugin is
not required by ordinary workspaces, controller startup or native Git.
